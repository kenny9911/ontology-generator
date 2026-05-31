// ============================================================================
//  stages/actions.ts — STAGE 3 (PURE EXTRACT): Action Types (the agentic core)
// ----------------------------------------------------------------------------
//  DESIGN_SPEC.md §5.1 (pipeline) stage 3, SCHEMA.md §5 (ActionType). TASK_PLAN
//  T13. One LLM call via `executeLLMWithTracking` over the prior OBJECTS + RULES
//  and the source text, then coerce the model's JSON into strict `ActionType`s:
//
//    - mint a deterministic `action:` id (+ random uuid) per action,
//    - typed inputs/outputs (ActionIO: objectTypeId XOR scalar `type`),
//    - ordered ActionStep[] (bilingual text; `guardRuleId` only when the rule
//      exists in ctx.rules),
//    - PreconditionRef[] (ruleId restricted to ctx.rules; severity cached),
//    - `triggeredByEventIds` + `emitsEvents` (EmitSpec) — event ids are DOTTED
//      "event:<domain>.<past_tense>" MINTED NOW via makeId; the events stage /
//      orchestrator reconciles them,
//    - sideEffects, actor (ActorRef kind human|agent|system), permissions,
//    - agent: AgentBinding { snake_case toolName, parameterSchema derived from
//      inputs, toolDescription, execution }.
//
//  This stage does NOT ground citations, apply the confidence rubric, derive
//  event inverses, or validate cross-refs — the ORCHESTRATOR does that AFTER.
//  We only set `sources[].snippet` (verbatim quote, as returned by the model),
//  a RAW `confidence`, provenance "extracted", reviewState "pending". Prior-layer
//  arrays (ctx.objects / ctx.rules) are read-only here.
//
//  HARD RULES (NodeNext / strict TS): relative project imports carry `.js`;
//  schema types/consts come from the generated backend mirror; all LLM calls go
//  through api/ai.ts.
// ============================================================================

import { randomUUID } from 'node:crypto';

import { executeLLMWithTracking } from '../../llm.js';
import { makeId } from '../../../_shared/ids.js';
import { buildActionsPrompt } from '../../prompts.js';
import type { StageContext } from '../context.js';
import {
  DATA_TYPES,
  SEVERITY_LEVELS,
} from '../../../_shared/ontology-schema.js';
import type {
  ActionIO,
  ActionStep,
  ActionType,
  ActorRef,
  AgentBinding,
  Bilingual,
  DataType,
  EmitSpec,
  JsonSchema,
  JsonSchemaProp,
  ObjectType,
  PreconditionRef,
  Rule,
  Severity,
  SideEffect,
  SourceRef,
} from '../../../_shared/ontology-schema.js';

// ---------------------------------------------------------------------------
// Local constants / small lookups
// ---------------------------------------------------------------------------

const DATA_TYPE_SET = new Set<string>(DATA_TYPES);
const SEVERITY_SET = new Set<string>(SEVERITY_LEVELS);
const EMIT_ON = new Set(['success', 'failure', 'always']);
const SIDE_EFFECT_KINDS = new Set([
  'db_write',
  'external_call',
  'notification',
  'state_change',
  'payment',
  'other',
]);
const ACTOR_KINDS = new Set(['human', 'agent', 'system']);
const EXECUTION_KINDS = new Set(['function', 'llm_tool', 'human_task']);

/** Extraction temperature (per prompts.ts contract: stage extraction = 0.1). */
const EXTRACT_TEMPERATURE = 0.1;
const MAX_TOKENS = 24000;

// ---------------------------------------------------------------------------
// Defensive helpers (the model is untrusted; never throw on shape drift).
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asOptString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asBool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}

/** Coerce to a finite confidence in [0,1]; default 0.7 when absent/garbage. */
function asConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0.7;
  return Math.min(1, Math.max(0, n));
}

/** Bilingual coercion; pulls a fallback EN from a sibling string field. */
function asBilingual(v: unknown, fallbackEn = ''): Bilingual {
  const r = asRecord(v);
  return { en: asString(r.en) || fallbackEn, zh: asString(r.zh) };
}

/** Strip code fences and isolate the outermost JSON object the model returned. */
function parseModelJson(raw: string): Record<string, unknown> {
  let text = (raw ?? '').trim();
  // Remove a leading ```json / ``` fence and any trailing fence.
  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return {};
  const slice = text.slice(first, last + 1);
  try {
    const parsed = JSON.parse(slice);
    return asRecord(parsed);
  } catch {
    return {};
  }
}

/** Slim object view for the prompt (id + name only — keeps token budget low). */
function slimObjects(objects: ObjectType[]): { id: string; name: string; nameZh: string }[] {
  return objects.map((o) => ({ id: o.id, name: o.name, nameZh: o.nameZh }));
}

/** Slim rule view for the prompt (id + title + statement + severity). */
function slimRules(
  rules: Rule[],
): { id: string; title: string; statement: Bilingual; severity: Severity }[] {
  return rules.map((r) => ({
    id: r.id,
    title: r.title,
    statement: r.statement,
    severity: r.severity,
  }));
}

/** Concatenate the parsed evidence into a single chunk for the prompt. */
function buildChunkText(ctx: StageContext): string {
  if (ctx.parsed.length === 0) return '';
  return ctx.parsed
    .map((p) => p.text)
    .filter((t) => typeof t === 'string' && t.length > 0)
    .join('\n\n---\n\n');
}

/** Primary document name for citation denormalization (first source). */
function primaryDocName(ctx: StageContext): string {
  return ctx.sources[0]?.name ?? 'the document';
}

// ---------------------------------------------------------------------------
// Field coercers — turn untrusted model fragments into strict schema shapes.
// ---------------------------------------------------------------------------

/** A scalar DataType, or undefined if not in the closed vocabulary. */
function coerceDataType(v: unknown): DataType | undefined {
  const s = asString(v);
  return DATA_TYPE_SET.has(s) ? (s as DataType) : undefined;
}

/**
 * ActionIO: `objectTypeId` (must resolve to a known object) XOR a scalar `type`.
 * objectTypeId wins when both are present; an unknown objectTypeId falls back to
 * the scalar type, or `json` if none — never emits a dangling object ref.
 */
function coerceIO(v: unknown, objectIds: Set<string>): ActionIO | null {
  const r = asRecord(v);
  const name = asString(r.name);
  if (!name) return null;

  const io: ActionIO = { name, required: asBool(r.required, false) };

  const objId = asString(r.objectTypeId);
  const scalar = coerceDataType(r.type);
  if (objId && objectIds.has(objId)) {
    io.objectTypeId = objId;
  } else if (scalar) {
    io.type = scalar;
  } else if (objId) {
    // referenced an object we don't have: degrade to a reference scalar so the
    // signature stays typed without a dangling cross-ref.
    io.type = 'reference';
  } else {
    io.type = 'json';
  }

  const card = asString(r.cardinality);
  if (card === 'one' || card === 'many') io.cardinality = card;
  if (typeof r.isArray === 'boolean') io.isArray = r.isArray;
  const desc = asOptString(r.description);
  if (desc) io.description = desc;
  return io;
}

/** Keep only object ids that exist; drop dangling refs from a step list. */
function coerceObjIdList(v: unknown, objectIds: Set<string>): string[] | undefined {
  const list = asArray(v)
    .map(asString)
    .filter((id) => id.length > 0 && objectIds.has(id));
  return list.length > 0 ? list : undefined;
}

function coerceStep(
  v: unknown,
  fallbackOrder: number,
  objectIds: Set<string>,
  ruleIds: Set<string>,
  actionIdsSoFar: Set<string>,
): ActionStep {
  const r = asRecord(v);
  const orderNum = typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : fallbackOrder;
  const step: ActionStep = {
    order: orderNum,
    text: asBilingual(r.text, asString(r.text)),
  };

  const reads = coerceObjIdList(r.readsObjectTypeIds, objectIds);
  if (reads) step.readsObjectTypeIds = reads;
  const writes = coerceObjIdList(r.writesObjectTypeIds, objectIds);
  if (writes) step.writesObjectTypeIds = writes;

  // callsActionTypeId is only kept if it points at an action minted in THIS pass
  // (composition); forward/unknown refs are dropped to avoid dangling cross-refs.
  const calls = asString(r.callsActionTypeId);
  if (calls && actionIdsSoFar.has(calls)) step.callsActionTypeId = calls;

  // guardRuleId is kept only when it gates a known rule.
  const guard = asString(r.guardRuleId);
  if (guard && ruleIds.has(guard)) step.guardRuleId = guard;

  return step;
}

/** Precondition refs restricted to rules that actually exist in ctx.rules. */
function coercePreconditions(
  v: unknown,
  ruleSeverity: Map<string, Severity>,
): PreconditionRef[] {
  const out: PreconditionRef[] = [];
  const seen = new Set<string>();
  for (const item of asArray(v)) {
    const r = asRecord(item);
    const ruleId = asString(r.ruleId);
    if (!ruleId || !ruleSeverity.has(ruleId) || seen.has(ruleId)) continue;
    seen.add(ruleId);
    const pre: PreconditionRef = { ruleId };
    const sev = asString(r.severity);
    // Cache the rule's authoritative severity; fall back to the model's value
    // only if it is a valid enum member.
    pre.severity = ruleSeverity.get(ruleId) ?? (SEVERITY_SET.has(sev) ? (sev as Severity) : 'block');
    out.push(pre);
  }
  return out;
}

/**
 * Mint a DOTTED event id from the model's best-effort reference. Reuses an
 * already-minted id if this exact (raw) reference was seen before in this pass,
 * so an action that emits "event:order.fulfilled" and another that is triggered
 * by the same string converge on ONE id. The events stage reconciles further.
 */
function mintEventId(rawRef: string, ctx: StageContext, eventIdCache: Map<string, string>): string {
  const cached = eventIdCache.get(rawRef);
  if (cached) return cached;
  // Derive the dotted name: strip a leading "event:" prefix; default a domain.
  let dotted = rawRef.replace(/^event:/i, '').trim();
  if (!dotted) dotted = `${ctx.domain}.occurred`;
  if (!dotted.includes('.')) dotted = `${ctx.domain}.${dotted}`;
  // makeId('event', ...) prepends "event:" and preserves dots in the slug.
  const id = makeId('event', dotted, ctx.taken);
  eventIdCache.set(rawRef, id);
  return id;
}

function coerceTriggeredBy(
  v: unknown,
  ctx: StageContext,
  eventIdCache: Map<string, string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of asArray(v)) {
    const raw = asString(item);
    if (!raw) continue;
    const id = mintEventId(raw, ctx, eventIdCache);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function coerceEmits(
  v: unknown,
  ctx: StageContext,
  eventIdCache: Map<string, string>,
): EmitSpec[] {
  const out: EmitSpec[] = [];
  for (const item of asArray(v)) {
    const r = asRecord(item);
    const raw = asString(r.eventTypeId);
    if (!raw) continue;
    const eventTypeId = mintEventId(raw, ctx, eventIdCache);
    const onRaw = asString(r.on);
    const on = EMIT_ON.has(onRaw) ? (onRaw as EmitSpec['on']) : 'success';
    const spec: EmitSpec = { eventTypeId, on };
    const condition = asOptString(r.condition);
    if (condition) spec.condition = condition;
    out.push(spec);
  }
  return out;
}

function coerceSideEffects(v: unknown, objectIds: Set<string>): SideEffect[] | undefined {
  const out: SideEffect[] = [];
  for (const item of asArray(v)) {
    const r = asRecord(item);
    const kindRaw = asString(r.kind);
    const kind = (SIDE_EFFECT_KINDS.has(kindRaw) ? kindRaw : 'other') as SideEffect['kind'];
    const description = asString(r.description);
    if (!description) continue;
    const se: SideEffect = { kind, description };
    const objId = asString(r.objectTypeId);
    if (objId && objectIds.has(objId)) se.objectTypeId = objId;
    out.push(se);
  }
  return out.length > 0 ? out : undefined;
}

function coerceActor(v: unknown): ActorRef {
  const r = asRecord(v);
  const kindRaw = asString(r.kind);
  const actor: ActorRef = {
    role: asString(r.role) || 'System',
    kind: (ACTOR_KINDS.has(kindRaw) ? kindRaw : 'system') as ActorRef['kind'],
  };
  const roleZh = asOptString(r.roleZh);
  if (roleZh) actor.roleZh = roleZh;
  return actor;
}

function coercePermissions(v: unknown): string[] | undefined {
  const out = asArray(v)
    .map(asString)
    .filter((p) => p.length > 0);
  return out.length > 0 ? out : undefined;
}

/** Snake_case a tool name from the model or fall back to the action name. */
function toSnakeCase(s: string): string {
  return s
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** Map a DataType to the JSON-Schema primitive type for tool parameter schemas. */
function dataTypeToJsonType(t: DataType): JsonSchemaProp['type'] {
  switch (t) {
    case 'integer':
      return 'integer';
    case 'decimal':
    case 'money':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'json':
    case 'reference':
      return 'object';
    default:
      // string | date | datetime | uuid | enum
      return 'string';
  }
}

/**
 * Derive the agent tool `parameterSchema` (JsonSchema) from the action inputs.
 * Object inputs become `{ type:'object', $objectTypeId }`; scalars map by type;
 * array IO wraps the prop in `{ type:'array', items }`. Required inputs populate
 * the schema's `required` list. This mirrors the inputs deterministically so the
 * codegen stage and the manifest projection agree.
 */
function deriveParameterSchema(inputs: ActionIO[]): JsonSchema {
  const properties: Record<string, JsonSchemaProp> = {};
  const required: string[] = [];

  for (const io of inputs) {
    let prop: JsonSchemaProp;
    if (io.objectTypeId) {
      prop = { type: 'object', $objectTypeId: io.objectTypeId };
    } else {
      const base: JsonSchemaProp = { type: dataTypeToJsonType(io.type ?? 'json') };
      prop = base;
    }
    if (io.description) prop.description = io.description;

    // Arrays: wrap the element shape in an array prop.
    if (io.isArray || io.cardinality === 'many') {
      const items: JsonSchemaProp = io.objectTypeId
        ? { type: 'object', $objectTypeId: io.objectTypeId }
        : { type: dataTypeToJsonType(io.type ?? 'json') };
      prop = { type: 'array', items };
      if (io.description) prop.description = io.description;
    }

    properties[io.name] = prop;
    if (io.required) required.push(io.name);
  }

  const schema: JsonSchema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function coerceAgent(
  v: unknown,
  fallbackToolBase: string,
  inputs: ActionIO[],
  description: string,
  taken: Set<string>,
): AgentBinding {
  const r = asRecord(v);

  // toolName: snake_case, deterministic, deduped within this pass.
  let toolName = toSnakeCase(asString(r.toolName) || fallbackToolBase);
  if (!toolName) toolName = 'action_tool';
  const toolKey = `tool:${toolName}`;
  if (taken.has(toolKey)) {
    let n = 2;
    while (taken.has(`tool:${toolName}_${n}`)) n += 1;
    toolName = `${toolName}_${n}`;
  }
  taken.add(`tool:${toolName}`);

  const execRaw = asString(r.execution);
  const execution = (EXECUTION_KINDS.has(execRaw) ? execRaw : 'function') as AgentBinding['execution'];

  const binding: AgentBinding = {
    toolName,
    // ALWAYS derive the parameter schema from the (already-coerced) inputs so it
    // can never disagree with the action signature, regardless of model output.
    parameterSchema: deriveParameterSchema(inputs),
    toolDescription: asString(r.toolDescription) || description || toolName,
    execution,
  };

  const promptHints = asArray(r.promptHints)
    .map(asString)
    .filter((h) => h.length > 0);
  if (promptHints.length > 0) binding.promptHints = promptHints;

  const integration = asOptString(r.integration);
  if (integration) binding.integration = integration;

  return binding;
}

/** Coerce the model's `sources` into SourceRef[]; snippet only (no offsets). */
function coerceSources(v: unknown, docName: string): SourceRef[] {
  const out: SourceRef[] = [];
  for (const item of asArray(v)) {
    const r = asRecord(item);
    const snippet = asString(r.snippet);
    if (!snippet) continue; // a citation without a verbatim quote is useless here
    const ref: SourceRef = {
      documentId: asString(r.documentId),
      documentName: asString(r.documentName) || docName,
      snippet,
    };
    const section = asOptString(r.section);
    if (section) ref.section = section;
    out.push(ref);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage entrypoint
// ---------------------------------------------------------------------------

/**
 * PURE EXTRACT — Stage 3. Reads ctx.objects + ctx.rules + parsed evidence, makes
 * ONE LLM call through `executeLLMWithTracking`, and returns strict ActionTypes
 * with minted ids, derived agent bindings, and DOTTED (best-effort) event ids.
 * Grounding, the confidence rubric, event-inverse derivation, and validation are
 * applied LATER by the orchestrator.
 */
export async function extractActions(ctx: StageContext): Promise<{ actions: ActionType[] }> {
  const chunkText = buildChunkText(ctx);
  if (!chunkText.trim()) {
    ctx.log('[actions] no parsed text to extract from; skipping.');
    return { actions: [] };
  }

  const docName = primaryDocName(ctx);
  const { system, user } = buildActionsPrompt({
    priorObjects: slimObjects(ctx.objects),
    priorRules: slimRules(ctx.rules),
    chunkText,
    docName,
  });

  let raw: string;
  try {
    raw = await executeLLMWithTracking({
      model: ctx.model,
      provider: ctx.provider as never,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      maxTokens: MAX_TOKENS,
      temperature: EXTRACT_TEMPERATURE,
      module: 'ontology_generator',
      actionName: 'ontology_extract_actions',
      userInfo: (ctx.userInfo ?? undefined) as never,
    });
  } catch (err) {
    ctx.log(`[actions] LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
    return { actions: [] };
  }

  const parsed = parseModelJson(raw);
  const rawActions = asArray(parsed.actions);
  if (rawActions.length === 0) {
    ctx.log('[actions] model returned no actions.');
    return { actions: [] };
  }

  // Lookups for cross-ref validation (read-only over prior layers).
  const objectIds = new Set(ctx.objects.map((o) => o.id));
  const ruleSeverity = new Map<string, Severity>(ctx.rules.map((r) => [r.id, r.severity]));
  const ruleIds = new Set(ruleSeverity.keys());

  // Caches shared across all actions in this pass so the same raw event ref maps
  // to one minted dotted id, and tool names dedupe globally via ctx.taken.
  const eventIdCache = new Map<string, string>();
  const actionIdsSoFar = new Set<string>();

  const actions: ActionType[] = [];

  for (const item of rawActions) {
    const r = asRecord(item);
    const name = asString(r.name) || asString(asRecord(r).id);
    if (!name) continue; // unusable

    const id = makeId('action', name, ctx.taken);

    const inputs = asArray(r.inputs)
      .map((io) => coerceIO(io, objectIds))
      .filter((io): io is ActionIO => io !== null);
    const outputs = asArray(r.outputs)
      .map((io) => coerceIO(io, objectIds))
      .filter((io): io is ActionIO => io !== null);

    const steps = asArray(r.steps).map((s, i) =>
      coerceStep(s, i + 1, objectIds, ruleIds, actionIdsSoFar),
    );

    const description = asString(r.description);

    const action: ActionType = {
      id,
      uuid: randomUUID(),
      name,
      description,
      inputs,
      outputs,
      steps,
      preconditions: coercePreconditions(r.preconditions, ruleSeverity),
      triggeredByEventIds: coerceTriggeredBy(r.triggeredByEventIds, ctx, eventIdCache),
      emitsEvents: coerceEmits(r.emitsEvents, ctx, eventIdCache),
      actor: coerceActor(r.actor),
      agent: coerceAgent(r.agent, name, inputs, description, ctx.taken),
      sources: coerceSources(r.sources, docName),
      confidence: asConfidence(r.confidence),
      provenance: 'extracted',
      reviewState: 'pending',
    };

    const nameZh = asOptString(r.nameZh);
    if (nameZh) action.nameZh = nameZh;
    const descriptionZh = asOptString(r.descriptionZh);
    if (descriptionZh) action.descriptionZh = descriptionZh;

    const sideEffects = coerceSideEffects(r.sideEffects, objectIds);
    if (sideEffects) action.sideEffects = sideEffects;
    const permissions = coercePermissions(r.permissions);
    if (permissions) action.permissions = permissions;

    actionIdsSoFar.add(id);
    actions.push(action);
  }

  ctx.log(`[actions] extracted ${actions.length} action type(s).`);
  return { actions };
}
