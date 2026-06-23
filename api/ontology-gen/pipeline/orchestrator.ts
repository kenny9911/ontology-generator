// ============================================================================
//  ONTOLOGY GENERATOR — PIPELINE ORCHESTRATOR
// ----------------------------------------------------------------------------
//  DESIGN_SPEC.md §5.1 (the 5-stage pipeline) + §3.3 (`runStage`); TASK_PLAN T16.
//
//  This module is the conductor: the pure stage functions
//  (`extractObjects`/`extractRules`/`extractActions`/`extractEvents`/
//  `extractProcesses`) own ALL LLM work; the orchestrator owns everything that
//  must be DETERMINISTIC and CONSISTENT across stages:
//
//    1. enforce STAGE_ORDER — reject an out-of-order stage by checking that the
//       prior layers a stage cross-references are already populated in `ctx`;
//    2. dispatch to the matching `extract*` stage;
//    3. GROUND citations (`groundSources`) — locate each verbatim snippet in the
//       parsed text, set offsets + `quoteVerified` deterministically;
//    4. DROP ungrounded EXTRACTED nodes (synthesized/inferred kept via
//       `derivedFrom`);
//    5. recompute CONFIDENCE via the locked rubric (`scoreConfidence`), using
//       cross-ref integrity computed against the post-merge id universe;
//    6. for the EVENTS stage, derive the EXACT Action<->Event inverse so
//       `producedByActionIds`/`consumedByActionIds` can never disagree with the
//       actions' `emitsEvents`/`triggeredByEventIds`;
//    7. merge the cleaned layer back into `ctx`;
//    8. run an OPTIONAL self-critique pass (`buildCritiquePrompt`), capturing the
//       reviewer's summary as a note (it never rewrites the draft here);
//    9. assemble a `StageProgress` (count/startedAt/finishedAt/status) and run
//       `validateOntology` on the partial envelope, returning its issues.
//
//  `buildOntology(ctx)` assembles the final `Ontology` envelope from the
//  accumulated context (id/uuid/name/domain/version 1/schemaVersion/status,
//  the source documents, the 5 layers + relationships + ruleGroups, the
//  aggregate confidence, and `metadata.stats`/`generation`).
//
//  GRACEFUL: every LLM/critique failure degrades to a logged note; the
//  orchestrator never throws on a bad model response. The ONLY hard error is an
//  out-of-order stage (a programming/precondition error), surfaced as a thrown
//  Error the handler envelopes.
//
//  HARD RULES (NodeNext / strict TS): relative project imports carry `.js`;
//  schema types/consts come from the generated backend mirror; the orchestrator
//  NEVER calls the LLM directly except for the optional critique pass.
// ============================================================================

import { randomUUID } from 'crypto';

import {
  STAGE_ORDER,
  SCHEMA_VERSION_NUMBER,
} from '../../_shared/ontology-schema.js';
import type {
  ActionType,
  Confidence,
  EventType,
  ObjectType,
  Ontology,
  Process,
  Relationship,
  Rule,
  RuleGroup,
  Stage,
  StageProgress,
} from '../../_shared/ontology-schema.js';
import { validateOntology } from '../../_shared/ontology-validate.js';
import type { ValidationIssue } from '../../_shared/ontology-validate.js';
import { executeLLMWithTracking } from '../llm.js';
import { ctxAgentLlm } from '../llm-router.js';
import type { ChatMessage, ExecuteLLMOptions } from '../llm.js';

import type { StageContext } from './context.js';
import { buildCritiquePrompt } from './context.js';
import { groundSources, dropUngroundedNodes } from './ground.js';
import {
  scoreConfidence,
  computeOntologyConfidence,
  objectCompleteness,
  relationshipCompleteness,
  ruleCompleteness,
  actionCompleteness,
  eventCompleteness,
  processCompleteness,
} from './confidence.js';

import { extractObjects } from './stages/objects.js';
import { extractRules } from './stages/rules.js';
import { extractActions } from './stages/actions.js';
import { extractEvents } from './stages/events.js';
import { extractProcesses } from './stages/processes.js';

// ===========================================================================
// runStage — the per-stage composition (extract → ground → confidence →
//            derive-inverse → merge → critique → progress + validate).
// ===========================================================================

export interface RunStageResult {
  /** The same context, with this stage's cleaned layer merged in. */
  ctx: StageContext;
  /** Per-stage progress record (count/startedAt/finishedAt/status). */
  progress: StageProgress;
  /** The critique pass's one-paragraph summary, when it ran. */
  critique?: string;
  /** Referential-integrity issues from validating the partial envelope. */
  issues: ValidationIssue[];
}

/**
 * Run exactly ONE pipeline stage end-to-end. Idempotent per stage: re-running a
 * stage replaces its layer in `ctx`. Throws ONLY when invoked out of order (a
 * precondition violation); all LLM/parse failures degrade gracefully.
 */
export async function runStage(stage: Stage, ctx: StageContext): Promise<RunStageResult> {
  assertStageOrder(stage, ctx);

  const startedAt = nowIso();
  let critique: string | undefined;

  try {
    switch (stage) {
      case 'objects':
        await applyObjects(ctx);
        break;
      case 'rules':
        await applyRules(ctx);
        break;
      case 'actions':
        await applyActions(ctx);
        break;
      case 'events':
        await applyEvents(ctx);
        break;
      case 'processes':
        await applyProcesses(ctx);
        break;
      default:
        // Exhaustive over STAGE_ORDER; defensive for forward-compat.
        throw new Error(`UNKNOWN_STAGE:${String(stage)}`);
    }

    // Optional self-critique over the freshly-merged layer. Never fatal.
    critique = await runCritique(stage, ctx);
  } catch (err) {
    // Extraction itself degrades inside the stage; this catch covers anything
    // the merge/derive/critique composition might throw on malformed data so a
    // single stage failure surfaces as an error PROGRESS record, not a 500.
    const finishedAt = nowIso();
    ctx.log(`[${stage}] stage failed: ${errText(err)}`);
    return {
      ctx,
      progress: {
        stage,
        status: 'error',
        count: stageCount(stage, ctx),
        startedAt,
        finishedAt,
        error: errText(err),
      },
      issues: validateOntology(buildOntology(ctx)),
    };
  }

  const finishedAt = nowIso();
  const progress: StageProgress = {
    stage,
    status: 'complete',
    count: stageCount(stage, ctx),
    startedAt,
    finishedAt,
  };

  const issues = validateOntology(buildOntology(ctx));
  return { ctx, progress, critique, issues };
}

// ---------------------------------------------------------------------------
// Stage-order enforcement.
//
// A later stage may only run once the EARLIER layers it cross-references are
// populated. We key off the canonical STAGE_ORDER position rather than trusting
// the caller: stage N requires every layer with a lower index to be non-empty.
// (Objects has no prerequisite; if a domain genuinely yields zero of an earlier
// layer the caller should still have RUN it — emptiness after a run is fine, but
// a never-run prior layer is the out-of-order case we reject.)
// ---------------------------------------------------------------------------

function assertStageOrder(stage: Stage, ctx: StageContext): void {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0) throw new Error(`UNKNOWN_STAGE:${String(stage)}`);

  // The set of prior-stage layers that must have been produced before `stage`.
  // We treat a prior layer as "produced" if its array exists (it may be empty
  // only when its own stage ran and found nothing — but the strict invariant
  // the validator also enforces is that cross-refs resolve, so we require the
  // immediate prerequisite layer used for cross-references to be present).
  for (let i = 0; i < idx; i++) {
    const prior = STAGE_ORDER[i]!;
    if (!priorLayerReady(prior, ctx)) {
      throw new Error(
        `STAGE_OUT_OF_ORDER:${stage} requires prior stage "${prior}" to have run first`,
      );
    }
  }
}

/**
 * Whether the prior stage's layer has been run. Objects is the only true
 * cross-ref prerequisite (rules/actions/processes all reference objects); the
 * remaining prerequisites are positional. We consider a layer "ready" when its
 * stage has had a chance to populate it: objects must be non-empty (nothing can
 * be built without a vocabulary), while later layers may legitimately be empty
 * after their stage runs. To distinguish "ran but empty" from "never ran" we
 * require the immediately-preceding layer to be non-empty OR allow empties past
 * objects — the validator's stage_order_violation is the authoritative backstop.
 */
function priorLayerReady(prior: Stage, ctx: StageContext): boolean {
  switch (prior) {
    case 'objects':
      // No ontology layer can be built without at least one object type.
      return ctx.objects.length > 0;
    case 'rules':
      // Rules are a cross-ref source for actions' preconditions but may be empty.
      // Treat as ready once objects exist (its stage had its turn).
      return ctx.objects.length > 0;
    case 'actions':
      // Events/processes chain actions; actions must exist before them.
      return ctx.actions.length > 0;
    case 'events':
      // Processes reference events on edges; events may be empty (ready once
      // actions ran, since events are derived from actions).
      return ctx.actions.length > 0;
    case 'processes':
      return true;
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Per-stage application: extract → ground → drop → confidence → merge.
// ---------------------------------------------------------------------------

async function applyObjects(ctx: StageContext): Promise<void> {
  const { objects, relationships } = await extractObjects(ctx);

  // 3. ground citations against the parsed text (mutates SourceRefs in place).
  groundSources(objects, ctx.parsed);
  groundSources(relationships, ctx.parsed);

  // 4. drop ungrounded EXTRACTED nodes (inferred/merged kept via derivedFrom).
  const keptObjects = dropUngroundedNodes(objects);
  // A relationship whose endpoint object was dropped is itself dangling; prune.
  const objectIds = new Set(keptObjects.map((o) => o.id));
  const keptRels = dropUngroundedNodes(relationships).filter(
    (r) => objectIds.has(r.sourceObjectTypeId) && objectIds.has(r.targetObjectTypeId),
  );

  // 5. recompute confidence via the locked rubric.
  for (const obj of keptObjects) {
    obj.confidence = scoreObjectConfidence(obj);
  }
  for (const rel of keptRels) {
    rel.confidence = scoreRelationshipConfidence(rel, objectIds);
  }

  // 7. merge (replace this layer — stages are idempotent).
  ctx.objects = keptObjects;
  ctx.relationships = keptRels;
}

async function applyRules(ctx: StageContext): Promise<void> {
  const { rules, ruleGroups } = await extractRules(ctx);

  groundSources(rules, ctx.parsed);
  const keptRules = dropUngroundedNodes(rules);

  const objectIds = new Set(ctx.objects.map((o) => o.id));
  for (const rule of keptRules) {
    rule.confidence = scoreRuleConfidence(rule, objectIds);
  }

  // Prune group membership to surviving rules; drop now-empty groups.
  const ruleIds = new Set(keptRules.map((r) => r.id));
  const keptGroups: RuleGroup[] = [];
  for (const g of ruleGroups) {
    const members = g.ruleIds.filter((rid) => ruleIds.has(rid));
    if (members.length > 0) keptGroups.push({ ...g, ruleIds: members });
  }

  ctx.rules = keptRules;
  ctx.ruleGroups = keptGroups;
}

async function applyActions(ctx: StageContext): Promise<void> {
  const { actions } = await extractActions(ctx);

  groundSources(actions, ctx.parsed);
  const keptActions = dropUngroundedNodes(actions);

  const objectIds = new Set(ctx.objects.map((o) => o.id));
  const ruleIds = new Set(ctx.rules.map((r) => r.id));
  for (const action of keptActions) {
    action.confidence = scoreActionConfidence(action, objectIds, ruleIds);
  }

  ctx.actions = keptActions;
}

async function applyEvents(ctx: StageContext): Promise<void> {
  const { events } = await extractEvents(ctx);

  groundSources(events, ctx.parsed);
  // Events are SYNTHESIZED: the stage marks directly-grounded events as
  // `extracted` and the rest as `inferred`. dropUngroundedNodes keeps inferred.
  const keptEvents = dropUngroundedNodes(events);

  // 6. DERIVE the exact Action<->Event inverse — authoritative wiring. This
  //    overrides whatever the stage produced so the validator's inverse check
  //    can never fire.
  deriveEventInverse(ctx.actions, keptEvents);

  // Confidence after the inverse is wired (eventCompleteness rewards wiring).
  const objectIds = new Set(ctx.objects.map((o) => o.id));
  const actionIds = new Set(ctx.actions.map((a) => a.id));
  for (const evt of keptEvents) {
    evt.confidence = scoreEventConfidence(evt, objectIds, actionIds);
  }

  ctx.events = keptEvents;
}

async function applyProcesses(ctx: StageContext): Promise<void> {
  const { processes } = await extractProcesses(ctx);

  groundSources(processes, ctx.parsed);
  // Processes are synthesized (provenance 'inferred'); kept via derivedFrom.
  const keptProcesses = dropUngroundedNodes(processes);

  const objectIds = new Set(ctx.objects.map((o) => o.id));
  const actionIds = new Set(ctx.actions.map((a) => a.id));
  const eventIds = new Set(ctx.events.map((e) => e.id));
  for (const proc of keptProcesses) {
    proc.confidence = scoreProcessConfidence(proc, objectIds, actionIds, eventIds);
  }

  ctx.processes = keptProcesses;
}

// ---------------------------------------------------------------------------
// Action <-> Event EXACT inverse derivation.
//
//   producedByActionIds[e] = { a.id | a.emitsEvents includes e }
//   consumedByActionIds[e] = { a.id | a.triggeredByEventIds includes e }
//
// Mirrors `ontology-validate.checkEventInverse` (the authoritative spec). Sets
// the lists on each event in stable, de-duplicated, first-seen action order.
// ---------------------------------------------------------------------------

function deriveEventInverse(actions: ActionType[], events: EventType[]): void {
  const producedBy = new Map<string, string[]>();
  const consumedBy = new Map<string, string[]>();

  const push = (map: Map<string, string[]>, eventId: string, actionId: string): void => {
    let list = map.get(eventId);
    if (!list) {
      list = [];
      map.set(eventId, list);
    }
    if (!list.includes(actionId)) list.push(actionId);
  };

  for (const action of actions) {
    for (const emit of action.emitsEvents ?? []) {
      if (emit?.eventTypeId) push(producedBy, emit.eventTypeId, action.id);
    }
    for (const eid of action.triggeredByEventIds ?? []) {
      if (eid) push(consumedBy, eid, action.id);
    }
  }

  for (const evt of events) {
    evt.producedByActionIds = producedBy.get(evt.id) ?? [];
    evt.consumedByActionIds = consumedBy.get(evt.id) ?? [];
  }
}

// ---------------------------------------------------------------------------
// Confidence scoring per kind — wires the rubric's cross-ref integrity from the
// node's resolvable references against the relevant id universe.
// ---------------------------------------------------------------------------

function scoreObjectConfidence(o: ObjectType): Confidence {
  // Objects have no outbound layer refs at this stage beyond attribute fk refs,
  // which are validated separately; integrity is neutral here.
  return scoreConfidence(
    o,
    { rawSelfRating: o.confidence },
    objectCompleteness(o),
  );
}

function scoreRelationshipConfidence(r: Relationship, objectIds: Set<string>): Confidence {
  const refs = [r.sourceObjectTypeId, r.targetObjectTypeId];
  const total = refs.length;
  const resolved = refs.filter((id) => objectIds.has(id)).length;
  return scoreConfidence(
    r,
    { rawSelfRating: r.confidence, totalRefs: total, resolvedRefs: resolved },
    relationshipCompleteness(r),
  );
}

function scoreRuleConfidence(r: Rule, objectIds: Set<string>): Confidence {
  const refs = [...(r.appliesToObjectTypeIds ?? [])];
  const total = refs.length;
  const resolved = refs.filter((id) => objectIds.has(id)).length;
  return scoreConfidence(
    r,
    { rawSelfRating: r.confidence, totalRefs: total, resolvedRefs: resolved },
    ruleCompleteness(r),
  );
}

function scoreActionConfidence(
  a: ActionType,
  objectIds: Set<string>,
  ruleIds: Set<string>,
): Confidence {
  const refs: { id: string; ok: boolean }[] = [];
  for (const io of a.inputs ?? []) {
    if (io.objectTypeId) refs.push({ id: io.objectTypeId, ok: objectIds.has(io.objectTypeId) });
  }
  for (const io of a.outputs ?? []) {
    if (io.objectTypeId) refs.push({ id: io.objectTypeId, ok: objectIds.has(io.objectTypeId) });
  }
  for (const pc of a.preconditions ?? []) {
    refs.push({ id: pc.ruleId, ok: ruleIds.has(pc.ruleId) });
  }
  const total = refs.length;
  const resolved = refs.filter((r) => r.ok).length;
  return scoreConfidence(
    a,
    { rawSelfRating: a.confidence, totalRefs: total, resolvedRefs: resolved },
    actionCompleteness(a),
  );
}

function scoreEventConfidence(
  e: EventType,
  objectIds: Set<string>,
  actionIds: Set<string>,
): Confidence {
  const refs: { id: string; ok: boolean }[] = [];
  for (const f of e.payloadFields ?? []) {
    if (f.objectTypeId) refs.push({ id: f.objectTypeId, ok: objectIds.has(f.objectTypeId) });
  }
  for (const aid of e.producedByActionIds ?? []) refs.push({ id: aid, ok: actionIds.has(aid) });
  for (const aid of e.consumedByActionIds ?? []) refs.push({ id: aid, ok: actionIds.has(aid) });
  const total = refs.length;
  const resolved = refs.filter((r) => r.ok).length;
  return scoreConfidence(
    e,
    { rawSelfRating: e.confidence, totalRefs: total, resolvedRefs: resolved },
    eventCompleteness(e),
  );
}

function scoreProcessConfidence(
  p: Process,
  objectIds: Set<string>,
  actionIds: Set<string>,
  eventIds: Set<string>,
): Confidence {
  const refs: { id: string; ok: boolean }[] = [];
  for (const oid of p.objectTypeIds ?? []) refs.push({ id: oid, ok: objectIds.has(oid) });
  for (const step of p.steps ?? []) {
    refs.push({ id: step.actionTypeId, ok: actionIds.has(step.actionTypeId) });
    for (const edge of step.next ?? []) {
      if (edge.onEventTypeId) refs.push({ id: edge.onEventTypeId, ok: eventIds.has(edge.onEventTypeId) });
    }
  }
  const total = refs.length;
  const resolved = refs.filter((r) => r.ok).length;
  return scoreConfidence(
    p,
    { rawSelfRating: p.confidence, totalRefs: total, resolvedRefs: resolved },
    processCompleteness(p),
  );
}

// ---------------------------------------------------------------------------
// OPTIONAL critique pass — the orchestrator's ONLY direct LLM call.
//
// Runs the generic extract→critique prompt over the freshly-merged layer and
// captures the reviewer's `summary`. It NEVER mutates the draft (correction is
// out of scope for v1); a failure or unparsable response degrades to undefined.
// ---------------------------------------------------------------------------

async function runCritique(stage: Stage, ctx: StageContext): Promise<string | undefined> {
  const items = currentLayerItems(stage, ctx);
  if (items.length === 0) return undefined;

  const { system, user } = buildCritiquePrompt(stage, items);

  let raw: string;
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    const llm = ctxAgentLlm(ctx, 'stage_critic');
    const opts: ExecuteLLMOptions = {
      model: llm.model,
      provider: llm.provider as ExecuteLLMOptions['provider'],
      messages,
      temperature: 0,
      maxTokens: 4000,
      module: 'ontology_generator',
      actionName: `ontology_critique_${stage}`,
      userInfo: (ctx.userInfo as ExecuteLLMOptions['userInfo']) ?? null,
    };
    raw = await executeLLMWithTracking(opts);
  } catch (err) {
    ctx.log(`[${stage}] critique skipped: ${errText(err)}`);
    return undefined;
  }

  const parsed = parseCritiqueJson(raw);
  if (!parsed) return undefined;

  const issueCount = Array.isArray(parsed.issues) ? parsed.issues.length : 0;
  const summary = typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
    ? parsed.summary.trim()
    : issueCount > 0
      ? `${issueCount} issue(s) flagged`
      : 'no issues found';
  ctx.log(`[${stage}] critique: ${issueCount} issue(s) — ${summary}`);
  return summary;
}

interface CritiquePayload {
  issues?: unknown[];
  summary?: unknown;
}

/** Defensive JSON parse for the critique response (strip fences, first/last brace). */
function parseCritiqueJson(raw: string): CritiquePayload | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return null;
  text = text.slice(first, last + 1);
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as CritiquePayload) : null;
  } catch {
    return null;
  }
}

// ===========================================================================
// buildOntology — assemble the envelope from the accumulated context.
// ===========================================================================

/**
 * Assemble the complete `Ontology` envelope from the orchestrated context. Used
 * both for the final result and for per-stage validation of the partial state.
 * Pure + synchronous: it computes `confidence` (weighted mean) and
 * `metadata.stats`, and stamps `generation` provenance from the run's model.
 */
/**
 * buildOntology + carry forward the run's stable identity (uuid/name/nameZh/
 * version/status) and the run-level metadata that must persist across the
 * client-paced swarm/hyper steps: createdAt/createdBy/history AND the web-search
 * supplement (`webAugmentation`, computed once then reused every step). SHARED by
 * the swarm AND hyper orchestrators so the carried-field list can never drift
 * between them.
 */
export function buildAndCarry(ctx: StageContext, prev: Ontology): Ontology {
  const next = buildOntology(ctx);
  next.uuid = prev.uuid;
  next.name = prev.name || next.name;
  next.nameZh = prev.nameZh ?? next.nameZh;
  next.version = prev.version || next.version;
  next.status = prev.status;
  next.metadata = {
    ...next.metadata,
    createdAt: prev.metadata?.createdAt ?? next.metadata.createdAt,
    createdBy: prev.metadata?.createdBy ?? next.metadata.createdBy,
    history: prev.metadata?.history ?? next.metadata.history,
    webAugmentation: prev.metadata?.webAugmentation ?? next.metadata.webAugmentation,
  };
  return next;
}

export function buildOntology(ctx: StageContext): Ontology {
  const name = deriveName(ctx);

  const ontology: Ontology = {
    id: ctx.ontologyId,
    uuid: randomUUID(),
    name,
    domain: ctx.domain,
    version: 1,
    schemaVersion: SCHEMA_VERSION_NUMBER,
    status: 'draft',
    sourceDocuments: ctx.sources,
    objects: ctx.objects,
    rules: ctx.rules,
    actions: ctx.actions,
    events: ctx.events,
    processes: ctx.processes,
    relationships: ctx.relationships,
    ruleGroups: ctx.ruleGroups,
    confidence: 0,
    metadata: {
      createdAt: nowIso(),
      updatedAt: nowIso(),
      stats: computeStats(ctx),
      generation: {
        model: ctx.model,
        provider: ctx.provider,
        runId: ctx.ontologyId,
      },
    },
  };

  ontology.confidence = computeOntologyConfidence(ontology);
  return ontology;
}

/** Human-readable ontology name from the first source doc, falling back to id. */
function deriveName(ctx: StageContext): string {
  const first = ctx.sources[0]?.name;
  if (first && first.trim().length > 0) return first.trim();
  const bare = ctx.ontologyId.replace(/^ontology:/, '').replace(/[.-]+/g, ' ').trim();
  return bare.length > 0 ? titleCase(bare) : ctx.ontologyId;
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Per-layer node counts surfaced in the UI + summary. */
function computeStats(ctx: StageContext): Record<string, number> {
  return {
    objects: ctx.objects.length,
    relationships: ctx.relationships.length,
    rules: ctx.rules.length,
    ruleGroups: ctx.ruleGroups.length,
    actions: ctx.actions.length,
    events: ctx.events.length,
    processes: ctx.processes.length,
  };
}

// ===========================================================================
// Small helpers.
// ===========================================================================

/** The freshly-produced node list for a stage (for count + critique). */
function currentLayerItems(stage: Stage, ctx: StageContext): unknown[] {
  switch (stage) {
    case 'objects':
      return [...ctx.objects, ...ctx.relationships];
    case 'rules':
      return [...ctx.rules];
    case 'actions':
      return [...ctx.actions];
    case 'events':
      return [...ctx.events];
    case 'processes':
      return [...ctx.processes];
    default:
      return [];
  }
}

/** The headline count for a stage's StageProgress. */
function stageCount(stage: Stage, ctx: StageContext): number {
  switch (stage) {
    case 'objects':
      return ctx.objects.length;
    case 'rules':
      return ctx.rules.length;
    case 'actions':
      return ctx.actions.length;
    case 'events':
      return ctx.events.length;
    case 'processes':
      return ctx.processes.length;
    default:
      return 0;
  }
}

const nowIso = (): string => new Date().toISOString();

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
