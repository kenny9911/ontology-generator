/**
 * ============================================================================
 *  ONTOLOGY GENERATOR — STAGE 4: EVENT TYPES (reconcile + exact inverse)
 * ============================================================================
 *
 *  `extractEvents(ctx)` is a PURE EXTRACT stage (DESIGN_SPEC §3.2 "events",
 *  SCHEMA.md §4 EventType). It defines exactly one `EventType` for every event
 *  id the ACTIONS reference — the union of every action's `triggeredByEventIds`
 *  and `emitsEvents[].eventTypeId` — and wires each event's producer/consumer
 *  lists as the EXACT INVERSE of the actions:
 *    - `producedByActionIds`  = actions whose `emitsEvents` include this event.
 *    - `consumedByActionIds`  = actions whose `triggeredByEventIds` include it.
 *  This wiring is DETERMINISTIC here (the orchestrator re-derives + validates
 *  the inverse afterward — they must never disagree).
 *
 *  The ONE optional LLM call (`buildEventsPrompt`) only ENRICHES sparse fields:
 *  `nameZh`, `description`/`descriptionZh`, and `payload` (EventField[]). The
 *  model never owns the inverse wiring, ids, or review/provenance bookkeeping.
 *  An event the model grounds with a verbatim source is `provenance:'extracted'`;
 *  any event not directly grounded falls back to `provenance:'inferred'` with
 *  `derivedFrom` = the referencing action ids, empty `sources`, and a capped
 *  confidence. Object-typed payload fields are inferred from the emitting
 *  action's outputs when the model leaves them out.
 *
 *  HARD RULES (strict NodeNext TS):
 *  - Relative project imports carry a `.js` suffix; schema types come from the
 *    generated backend mirror at `api/_shared/ontology-schema.ts`.
 *  - ALL LLM calls go through `executeLLMWithTracking`. Parse the model's JSON
 *    DEFENSIVELY (strip fences, slice first/last brace). Never throw on bad LLM
 *    output — degrade to the deterministic skeleton.
 *  - Stages do not mutate prior-layer arrays (read `ctx.actions` only).
 * ============================================================================
 */

import { executeLLMWithTracking, type ExecuteLLMOptions } from '../../llm.js';
import { buildEventsPrompt } from '../../prompts.js';
import { ctxAgentLlm } from '../../llm-router.js';
import type { StageContext } from '../context.js';
import type {
  ActionType,
  Confidence,
  DataType,
  EventField,
  EventType,
  SpecEventPayload,
} from '../../../_shared/ontology-schema.js';
import { DATA_TYPES } from '../../../_shared/ontology-schema.js';
import { specObjectId, eventSpecName, mapDataType } from '../../spec-format/project.js';

/** Inferred events never score above this (DESIGN_SPEC §3.2 / Stage-4 prompt). */
const INFERRED_CONFIDENCE_CAP = 0.6;
/** Confidence floor for the deterministic skeleton when the model adds nothing. */
const SKELETON_CONFIDENCE = 0.55;

/** Defensive accumulator for the model's per-event enrichment, by event id. */
interface EventEnrichment {
  nameZh?: string;
  description?: string;
  descriptionZh?: string;
  payload?: EventField[];
  /** A single verbatim source snippet, if the model grounded this event. */
  hasSource: boolean;
  snippet?: string;
  documentName?: string;
  section?: string;
  page?: number;
  confidence?: number;
}

/**
 * Stage 4 entry point. Reconciles + defines every event referenced by the
 * actions, wires the exact inverse, and (best-effort) enriches payloads via ONE
 * LLM call. Returns only the `events` layer; the orchestrator merges it back.
 */
export async function extractEvents(ctx: StageContext): Promise<{ events: EventType[] }> {
  const actions = ctx.actions;

  // ---------------------------------------------------------------------
  // 1. Collect every referenced event id + compute the EXACT inverse maps.
  //    `orderedIds` preserves first-seen order for stable, diffable output.
  // ---------------------------------------------------------------------
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  const producedBy = new Map<string, string[]>(); // eventId -> action ids that EMIT it
  const consumedBy = new Map<string, string[]>(); // eventId -> action ids TRIGGERED by it
  /** Emitting actions per event — used to infer object-typed payload fields. */
  const emitterActions = new Map<string, ActionType[]>();

  const note = (id: string): void => {
    if (!id) return;
    if (!seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
      producedBy.set(id, []);
      consumedBy.set(id, []);
      emitterActions.set(id, []);
    }
  };
  const pushUnique = (map: Map<string, string[]>, id: string, actionId: string): void => {
    const list = map.get(id);
    if (list && !list.includes(actionId)) list.push(actionId);
  };

  for (const action of actions) {
    for (const emit of action.emitsEvents ?? []) {
      const id = emit?.eventTypeId;
      if (!id) continue;
      note(id);
      pushUnique(producedBy, id, action.id);
      const emitters = emitterActions.get(id);
      if (emitters && !emitters.some((a) => a.id === action.id)) emitters.push(action);
    }
    for (const id of action.triggeredByEventIds ?? []) {
      if (!id) continue;
      note(id);
      pushUnique(consumedBy, id, action.id);
    }
  }

  if (orderedIds.length === 0) {
    ctx.log('Stage 4 (events): no event ids referenced by actions — nothing to define.');
    return { events: [] };
  }

  ctx.log(
    `Stage 4 (events): reconciling ${orderedIds.length} event id(s) referenced by ${actions.length} action(s).`,
  );

  // ---------------------------------------------------------------------
  // 2. ONE best-effort LLM call to enrich sparse payloads / bilingual fields.
  //    Never fatal: any failure degrades to the deterministic skeleton.
  // ---------------------------------------------------------------------
  const enrichment = await enrichViaLlm(ctx);

  // ---------------------------------------------------------------------
  // 3. Build one EventType per unique id. Inverse wiring is authoritative;
  //    the model only contributes payload/description/nameZh.
  // ---------------------------------------------------------------------
  const actionById = new Map(actions.map((a) => [a.id, a]));
  const events: EventType[] = orderedIds.map((id) => {
    const producers = producedBy.get(id) ?? [];
    const consumers = consumedBy.get(id) ?? [];
    const emitters = emitterActions.get(id) ?? [];
    const enr = enrichment.get(id);

    const name = eventSpecName(id);
    const payloadFields = resolvePayload(enr?.payload, emitters);
    const payload = buildSpecPayload(payloadFields, producers, emitters, actionById);

    // An event is GROUNDED only if the model returned a verbatim snippet for it;
    // otherwise it is a synthesized/inferred node (derived from its referencers).
    const grounded = enr?.hasSource === true && typeof enr.snippet === 'string' && enr.snippet.length > 0;
    const derivedFrom = uniqueIds([...producers, ...consumers]);

    const event: EventType = {
      id,
      uuid: makeUuid(),
      name,
      nameZh: enr?.nameZh && enr.nameZh.trim().length > 0 ? enr.nameZh : name,
      description: enr?.description,
      descriptionZh: enr?.descriptionZh,
      payload,
      payloadFields,
      producedByActionIds: producers,
      consumedByActionIds: consumers,
      sources: grounded
        ? [
            {
              documentId: '',
              documentName: enr?.documentName ?? '',
              snippet: enr?.snippet ?? '',
              ...(enr?.section ? { section: enr.section } : {}),
              ...(typeof enr?.page === 'number' ? { page: enr.page } : {}),
            },
          ]
        : [],
      confidence: grounded
        ? clampConfidence(enr?.confidence, SKELETON_CONFIDENCE, 1)
        : clampConfidence(enr?.confidence, SKELETON_CONFIDENCE, INFERRED_CONFIDENCE_CAP),
      provenance: grounded ? 'extracted' : 'inferred',
      reviewState: 'pending',
      ...(grounded ? {} : { derivedFrom }),
    };

    return event;
  });

  const inferredCount = events.filter((e) => e.provenance === 'inferred').length;
  ctx.log(
    `Stage 4 (events): defined ${events.length} event(s) (${events.length - inferredCount} grounded, ${inferredCount} inferred).`,
  );

  return { events };
}

// ===========================================================================
// LLM enrichment (best-effort, single call) + defensive parsing.
// ===========================================================================

/**
 * Run the single Stage-4 LLM call over the action set and fold the response into
 * a per-event-id enrichment map. Returns an EMPTY map on any failure (missing
 * model, transport error, unparseable JSON) — the caller still emits the full
 * deterministic skeleton, so events never go missing.
 */
async function enrichViaLlm(ctx: StageContext): Promise<Map<string, EventEnrichment>> {
  const out = new Map<string, EventEnrichment>();
  const docName = ctx.sources[0]?.name ?? 'the document';

  // Project the actions down to the fields the prompt needs (ids + wiring +
  // outputs the model can infer payload from). Keeps the prompt focused.
  const actionView = ctx.actions.map((a) => ({
    id: a.id,
    name: a.name,
    triggeredByEventIds: a.triggeredByEventIds ?? [],
    emitsEvents: (a.emitsEvents ?? []).map((e) => ({
      eventTypeId: e.eventTypeId,
      on: e.on,
      ...(e.condition ? { condition: e.condition } : {}),
    })),
    outputs: (a.outputs ?? []).map((io) => ({
      name: io.name,
      ...(io.objectTypeId ? { objectTypeId: io.objectTypeId } : {}),
      ...(io.type ? { type: io.type } : {}),
      required: io.required,
    })),
  }));

  const { system, user } = buildEventsPrompt({ actions: actionView, docName });

  let raw: string;
  try {
    const llm = ctxAgentLlm(ctx, 'events_enricher');
    raw = await executeLLMWithTracking({
      model: llm.model,
      // StageContext.provider is a plain string; narrow to the option's union.
      provider: llm.provider as ExecuteLLMOptions['provider'],
      messages: [
        { role: 'system', content: ctx.briefSeed ? `${system}\n\n${ctx.briefSeed}` : system },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      maxTokens: 12000,
      module: 'ontology_generator',
      actionName: 'ontology_extract_events',
      userInfo: (ctx.userInfo ?? null) as ExecuteLLMOptions['userInfo'],
    });
  } catch (err) {
    ctx.log(`Stage 4 (events): payload enrichment LLM call failed — using deterministic skeleton. ${errMsg(err)}`);
    return out;
  }

  const parsed = parseJsonObject(raw);
  if (!parsed) {
    ctx.log('Stage 4 (events): could not parse LLM payload enrichment — using deterministic skeleton.');
    return out;
  }

  const items = Array.isArray(parsed.events) ? parsed.events : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id : undefined;
    if (!id) continue;

    const firstSource = Array.isArray(item.sources) && isRecord(item.sources[0]) ? item.sources[0] : undefined;
    const snippet = firstSource && typeof firstSource.snippet === 'string' ? firstSource.snippet.trim() : undefined;
    const provenance = typeof item.provenance === 'string' ? item.provenance : undefined;
    // Honor the model only as a HINT; "grounded" still requires a real snippet.
    const hasSource = Boolean(snippet) && provenance !== 'inferred';

    out.set(id, {
      nameZh: optString(item.nameZh),
      description: optString(item.description),
      descriptionZh: optString(item.descriptionZh),
      payload: parsePayload(item.payload),
      hasSource,
      snippet: hasSource ? snippet : undefined,
      documentName: firstSource && typeof firstSource.documentName === 'string' ? firstSource.documentName : undefined,
      section: firstSource && typeof firstSource.section === 'string' ? firstSource.section : undefined,
      page: firstSource && typeof firstSource.page === 'number' ? firstSource.page : undefined,
      confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
    });
  }

  return out;
}

// ===========================================================================
// Payload resolution.
// ===========================================================================

/**
 * Choose the payload for an event: prefer the model's well-formed fields; else
 * synthesize object-typed fields from the emitting action's domain-object
 * outputs (DESIGN_SPEC: "infer object-typed fields from the emitting action").
 */
function resolvePayload(fromModel: EventField[] | undefined, emitters: ActionType[]): EventField[] {
  if (fromModel && fromModel.length > 0) return fromModel;
  return inferPayloadFromEmitters(emitters);
}

/**
 * Derive payload fields from the outputs of the actions that emit the event.
 * Object-valued outputs become `reference` fields carrying their `objectTypeId`;
 * scalar outputs keep their `DataType`. De-duplicated by field name.
 */
function inferPayloadFromEmitters(emitters: ActionType[]): EventField[] {
  const byName = new Map<string, EventField>();
  for (const action of emitters) {
    for (const io of action.outputs ?? []) {
      if (!io?.name) continue;
      const fieldName = io.name;
      if (byName.has(fieldName)) continue;
      if (io.objectTypeId) {
        byName.set(fieldName, {
          name: fieldName,
          type: 'reference',
          objectTypeId: io.objectTypeId,
          required: io.required === true,
        });
      } else if (io.type && isDataType(io.type)) {
        byName.set(fieldName, {
          name: fieldName,
          type: io.type,
          required: io.required === true,
        });
      }
    }
  }
  return Array.from(byName.values());
}

/** camelCase function-style name (matches the spec action naming). */
function camelName(s: string): string {
  const w = (s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (w.length === 0) return s;
  return w[0]!.toLowerCase() + w.slice(1).map((x) => x[0]!.toUpperCase() + x.slice(1)).join('');
}

/** Build the spec-format event payload from the structural payload fields. */
function buildSpecPayload(
  payloadFields: EventField[],
  producers: string[],
  emitters: ActionType[],
  actionById: Map<string, ActionType>,
): SpecEventPayload {
  const sourceId = producers.find((aid) => actionById.has(aid));
  const source_action = sourceId ? camelName(actionById.get(sourceId)!.name) : '';

  const event_data = payloadFields.map((f) => ({
    name: f.name,
    type: mapDataType(f.type),
    target_object: f.objectTypeId ? specObjectId(f.objectTypeId) : null,
  }));

  const targets: string[] = [];
  for (const a of emitters) {
    for (const se of a.sideEffects ?? []) {
      if ((se.kind === 'db_write' || se.kind === 'state_change' || se.kind === 'payment') && se.objectTypeId) {
        targets.push(specObjectId(se.objectTypeId));
      }
    }
  }
  if (targets.length === 0) {
    for (const f of payloadFields) if (f.objectTypeId) targets.push(specObjectId(f.objectTypeId));
  }
  const state_mutations = Array.from(new Set(targets)).map((t) => ({
    target_object: t,
    mutation_type: 'CREATE_OR_MODIFY',
    impacted_properties: [] as string[],
  }));

  return { source_action, event_data, state_mutations };
}

/** Parse + sanitize a model-provided payload array into valid EventField[]. */
function parsePayload(raw: unknown): EventField[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const fields: EventField[] = [];
  for (const f of raw) {
    if (!isRecord(f)) continue;
    const name = typeof f.name === 'string' ? f.name : undefined;
    if (!name) continue;
    const objectTypeId = typeof f.objectTypeId === 'string' ? f.objectTypeId : undefined;
    const type: DataType = isDataType(f.type) ? (f.type as DataType) : objectTypeId ? 'reference' : 'string';
    fields.push({
      name,
      type,
      ...(objectTypeId ? { objectTypeId } : {}),
      required: f.required === true,
      ...(typeof f.description === 'string' ? { description: f.description } : {}),
    });
  }
  return fields.length > 0 ? fields : undefined;
}

// ===========================================================================
// Small pure helpers.
// ===========================================================================

/**
 * The event `id` is reused VERBATIM from the action refs (it is already a
 * minted `event:<dotted.name>` slug), so this stage does not call `makeId`.
 * `uuid` is the per-node opaque key; ids stay deterministic + diffable.
 */
function makeUuid(): string {
  // Lightweight RFC-4122-ish v4; the schema only needs a unique opaque string,
  // and we avoid a hard dependency on `crypto` for serverless cold-start speed.
  const hex = (n: number): string => Math.floor(n).toString(16).padStart(2, '0');
  const bytes = Array.from({ length: 16 }, () => hex(Math.random() * 256));
  bytes[6] = ((parseInt(bytes[6], 16) & 0x0f) | 0x40).toString(16).padStart(2, '0');
  bytes[8] = ((parseInt(bytes[8], 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return (
    bytes.slice(0, 4).join('') +
    '-' +
    bytes.slice(4, 6).join('') +
    '-' +
    bytes.slice(6, 8).join('') +
    '-' +
    bytes.slice(8, 10).join('') +
    '-' +
    bytes.slice(10, 16).join('')
  );
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

function clampConfidence(value: number | undefined, fallback: Confidence, max: number): Confidence {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(max, v));
}

function isDataType(value: unknown): value is DataType {
  return typeof value === 'string' && (DATA_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Defensively parse the model's reply into a JSON object: strip ```code fences```
 * then slice the first `{` .. last `}`. Returns null on any failure.
 */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  // Strip a leading ```json / ``` fence and a trailing ``` fence if present.
  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    const parsed: unknown = JSON.parse(slice);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
