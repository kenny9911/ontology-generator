// ============================================================================
//  ONTOLOGY GENERATOR — STAGE 5: PROCESSES (pure extract)
// ============================================================================
//
//  Synthesizes 3-5 end-to-end workflow Processes by chaining the prior-layer
//  ActionTypes (ctx.actions) along their Event producer->consumer links
//  (ctx.events), denormalizing the ObjectTypes they touch (ctx.objects).
//
//  PURE EXTRACT contract (per StageContext): this stage does exactly ONE LLM
//  call via `executeLLMWithTracking`, parses the JSON defensively, mints
//  deterministic ids, normalizes the step-graph (process-local step ids, edges
//  pointing at real steps, actionTypeId/onEventTypeId resolving to prior
//  layers), and stamps a RAW confidence. It returns ONLY `{ processes }`.
//  The ORCHESTRATOR applies grounding, the confidence rubric, and validation
//  afterwards; this stage MUST NOT mutate ctx.actions/events/objects.
//
//  Processes are SYNTHESIZED, not mined verbatim, so each carries
//  provenance:'inferred', derivedFrom:[contributing action ids], sources:[]
//  and reviewState:'pending'.
//
//  HARD RULES (NodeNext / strict TS): relative project imports carry `.js`;
//  schema types come from the generated backend mirror; graceful degradation —
//  any failure (no LLM, bad JSON, empty actions) yields `{ processes: [] }`
//  rather than throwing.
// ============================================================================

import type {
  ActionType,
  ActorRef,
  Bilingual,
  OrchestrationSpec,
  Process,
  ProcessEdge,
  ProcessTrigger,
  SourceRef,
  SpecActor,
  WorkflowStep,
} from '../../../_shared/ontology-schema.js';
import { eventSpecName } from '../../spec-format/project.js';
import { makeId } from '../../../_shared/ids.js';
import { buildProcessesPrompt } from '../../prompts.js';
import { executeLLMWithTracking, type ChatMessage } from '../../llm.js';
import { ctxAgentLlm } from '../../llm-router.js';
import type { StageContext } from '../context.js';

/** Strategy values allowed by OrchestrationSpec.strategy. */
const STRATEGIES: ReadonlyArray<OrchestrationSpec['strategy']> = [
  'sequential',
  'event_driven',
  'state_machine',
];
/** onFailure values allowed by OrchestrationSpec.onFailure. */
const ON_FAILURE: ReadonlyArray<NonNullable<OrchestrationSpec['onFailure']>> = [
  'halt',
  'compensate',
  'escalate',
];
/** Trigger kinds allowed by ProcessTrigger.kind. */
const TRIGGER_KINDS: ReadonlyArray<ProcessTrigger['kind']> = ['event', 'manual', 'schedule'];
/** Actor kinds allowed by ActorRef.kind. */
const ACTOR_KINDS: ReadonlyArray<ActorRef['kind']> = ['human', 'agent', 'system'];

/**
 * Stage 5 entry point. Reads ctx.actions/events/objects, asks the model to
 * synthesize 3-5 workflow step-graphs, then deterministically mints ids and
 * normalizes the graph against the prior layers. Returns only the processes.
 */
export async function extractProcesses(
  ctx: StageContext,
): Promise<{ processes: Process[] }> {
  // Nothing to chain without actions — synthesize nothing.
  if (!Array.isArray(ctx.actions) || ctx.actions.length === 0) {
    ctx.log('processes: no actions to chain; skipping');
    return { processes: [] };
  }

  const docName = pickDocName(ctx);

  // Slim projections for the prompt (ids + names + wiring the model needs).
  const objectsForPrompt = ctx.objects.map((o) => ({ id: o.id, name: o.name, nameZh: o.nameZh }));
  const actionsForPrompt = ctx.actions.map((a) => ({
    id: a.id,
    name: a.name,
    nameZh: a.nameZh,
    actor: a.actor,
    triggeredByEventIds: a.triggeredByEventIds,
    emitsEvents: a.emitsEvents,
    inputs: a.inputs,
    outputs: a.outputs,
  }));
  const eventsForPrompt = ctx.events.map((e) => ({
    id: e.id,
    name: e.name,
    producedByActionIds: e.producedByActionIds,
    consumedByActionIds: e.consumedByActionIds,
  }));

  const { system, user } = buildProcessesPrompt({
    actions: actionsForPrompt,
    events: eventsForPrompt,
    objects: objectsForPrompt,
    docName,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: ctx.briefSeed ? `${system}\n\n${ctx.briefSeed}` : system },
    { role: 'user', content: user },
  ];

  let raw: string;
  try {
    const llm = ctxAgentLlm(ctx, 'processes_extractor', {
      inputChars: messages.reduce((n, m) => n + m.content.length, 0),
    });
    raw = await executeLLMWithTracking({
      model: llm.model,
      provider: llm.provider as Parameters<typeof executeLLMWithTracking>[0]['provider'],
      messages,
      temperature: 0.1,
      maxTokens: 8000,
      module: 'ontology_generator',
      actionName: 'extract_processes',
      userInfo: (ctx.userInfo as Parameters<typeof executeLLMWithTracking>[0]['userInfo']) ?? null,
    });
  } catch (err) {
    ctx.log(`processes: LLM call failed (${errText(err)}); skipping`);
    return { processes: [] };
  }

  const parsed = parseJsonObject(raw);
  if (!parsed) {
    ctx.log('processes: could not parse model JSON; skipping');
    return { processes: [] };
  }

  const rawProcesses = Array.isArray(parsed.processes) ? parsed.processes : [];
  if (rawProcesses.length === 0) {
    ctx.log('processes: model returned no processes');
    return { processes: [] };
  }

  // Resolvable id/role sets from the prior layers.
  const actionIds = new Set(ctx.actions.map((a) => a.id));
  const eventIds = new Set(ctx.events.map((e) => e.id));
  const objectIds = new Set(ctx.objects.map((o) => o.id));
  // Default actor role per action (for actorRole fallback / inference).
  const actionActorRole = new Map(ctx.actions.map((a) => [a.id, a.actorRef?.role]));

  const processes: Process[] = [];
  for (const rp of rawProcesses) {
    const proc = normalizeProcess(rp, ctx, {
      actionIds,
      eventIds,
      objectIds,
      actionActorRole,
    });
    if (proc) processes.push(proc);
  }

  ctx.log(`processes: synthesized ${processes.length} process(es)`);
  return { processes };
}

// ---------------------------------------------------------------------------
//  Normalization
// ---------------------------------------------------------------------------

interface Resolve {
  actionIds: Set<string>;
  eventIds: Set<string>;
  objectIds: Set<string>;
  actionActorRole: Map<string, string | undefined>;
}

/**
 * Turn one raw model process into a schema-valid Process, or null when it has
 * no usable steps. Mints a deterministic id, builds the actor list, the step
 * graph (with process-local ids and edges that point at real steps and resolve
 * onEventTypeId/actionTypeId against the prior layers), triggers, and
 * orchestration. Stamps provenance:'inferred' + derivedFrom + reviewState.
 */
function normalizeProcess(
  rp: Record<string, unknown>,
  ctx: StageContext,
  resolve: Resolve,
): Process | null {
  const name = asBilingual(rp.name);
  // Mint a stable, deduped process id from the English name (fallback generic).
  const id = makeId('process', name.en || 'process', ctx.taken);
  const uuid = newUuid();

  // --- actors ---------------------------------------------------------------
  const actors = normalizeActors(rp.actors);

  // --- steps ----------------------------------------------------------------
  const rawSteps = Array.isArray(rp.steps) ? (rp.steps as Record<string, unknown>[]) : [];
  // First pass: keep only steps whose actionTypeId resolves to a real action,
  // assigning a process-local id and remembering the original->local mapping.
  const localIdByRaw = new Map<string, string>();
  const kept: { src: Record<string, unknown>; localId: string; actionTypeId: string }[] = [];
  let counter = 0;
  for (const s of rawSteps) {
    const actionTypeId = String(s.actionTypeId ?? '');
    if (!resolve.actionIds.has(actionTypeId)) continue; // drop ungrounded steps
    counter += 1;
    const localId = `s${counter}`;
    const origId = typeof s.id === 'string' && s.id.length > 0 ? s.id : localId;
    localIdByRaw.set(origId, localId);
    // Also map the local id to itself so already-local edge refs resolve.
    localIdByRaw.set(localId, localId);
    kept.push({ src: s, localId, actionTypeId });
  }
  if (kept.length === 0) return null; // no real steps => not a usable process

  const validLocalIds = new Set(kept.map((k) => k.localId));
  const actorRoles = new Set(actors.map((a) => a.role));

  const steps: WorkflowStep[] = kept.map((k, i) => {
    const next = normalizeEdges(k.src.next, localIdByRaw, validLocalIds, resolve.eventIds);
    // actorRole must be one of the process actors; else fall back to the
    // action's own actor role (added to the actor list below if missing).
    let actorRole = typeof k.src.actorRole === 'string' ? k.src.actorRole : undefined;
    if (!actorRole || !actorRoles.has(actorRole)) {
      const inferred = resolve.actionActorRole.get(k.actionTypeId);
      actorRole = inferred && actorRoles.has(inferred) ? inferred : actorRole;
    }
    const order = typeof k.src.order === 'number' ? k.src.order : i + 1;
    const step: WorkflowStep = {
      id: k.localId,
      actionTypeId: k.actionTypeId,
      order,
      next,
    };
    if (actorRole) step.actorRole = actorRole;
    return step;
  });

  // --- objectTypeIds (denormalized; resolve to real objects, dedup) ---------
  const objectTypeIds = uniq(
    asStringArray(rp.objectTypeIds)
      .filter((oid) => resolve.objectIds.has(oid))
      .concat(inferObjectIds(steps, ctx, resolve.objectIds)),
  );

  // --- triggers -------------------------------------------------------------
  const triggers = normalizeTriggers(rp.triggers, resolve.eventIds);

  // --- orchestration --------------------------------------------------------
  const orchestration = normalizeOrchestration(rp.orchestration);

  // --- provenance: synthesized => inferred, derivedFrom the contributing actions
  const derivedFrom = uniq(steps.map((s) => s.actionTypeId));

  const proc = {
    id,
    uuid,
    name,
    actors,
    objectTypeIds,
    steps,
    triggers,
    orchestration,
    sources: asSources(rp.sources),
    confidence: clampConfidence(rp.confidence, 0.6),
    provenance: 'inferred' as const,
    derivedFrom,
    reviewState: 'pending' as const,
  } as Process;
  const description = optString(rp.description);
  if (description) proc.description = description;
  attachWorkflowSpecFields(proc, ctx);
  return proc;
}

/** camelCase function-style name (matches the spec workflow naming). */
function camelName(s: string): string {
  const w = (s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return w.length ? w[0]!.toLowerCase() + w.slice(1).map((x) => x[0]!.toUpperCase() + x.slice(1)).join('') : s;
}
function capActorKind(kind: string | undefined): SpecActor {
  if (kind === 'human') return 'Human';
  if (kind === 'system') return 'System';
  return 'Agent';
}
function workflowStepType(a: ActionType | undefined): 'manual' | 'tool' | 'logic' {
  if (!a) return 'logic';
  if (a.actorRef?.kind === 'human') return 'manual';
  const external = !!a.agent?.integration || (a.sideEffects ?? []).some((se) => se.kind === 'external_call');
  return external ? 'tool' : 'logic';
}

/** Derive + assign the spec-format workflow fields on a process (mutates). */
function attachWorkflowSpecFields(p: Process, ctx: StageContext): void {
  const actionById = new Map(ctx.actions.map((a) => [a.id, a]));
  const uniqStr = (arr: string[]): string[] => Array.from(new Set(arr));

  const actors = uniqStr((p.actors ?? []).map((a) => capActorKind(a.kind)));
  p.actor = actors.length > 0 ? (actors as SpecActor[]) : [p.orchestration?.agentOrchestrated ? 'Agent' : 'Human'];
  p.trigger = uniqStr(
    (p.triggers ?? []).flatMap((t): string[] => {
      if (t.kind === 'event' && t.eventTypeId) return [eventSpecName(t.eventTypeId)];
      if (t.kind === 'schedule') return ['SCHEDULED_SYNC'];
      return [];
    }),
  );
  // Workflow description is Chinese-first: prefer Chinese prose, else the zh name.
  const hasCJK = (s: string | undefined): boolean => typeof s === 'string' && /[一-鿿]/.test(s);
  p.description = hasCJK(p.description) ? p.description : p.name?.zh?.trim() || p.description;
  p.actions = (p.steps ?? []).map((s) => {
    const a = actionById.get(s.actionTypeId);
    const edge = s.next?.[0];
    return {
      order: String(s.order),
      name: a ? camelName(a.name) : s.actionTypeId.replace(/^action:/, ''),
      description: a?.descriptionZh?.trim() || a?.description?.trim() || '',
      type: workflowStepType(a),
      condition: edge?.condition?.trim() || edge?.label?.en?.trim() || '',
    };
  });
  p.triggered_event = uniqStr(
    (p.steps ?? []).flatMap((s) => {
      const a = actionById.get(s.actionTypeId);
      return a ? (a.emitsEvents ?? []).map((e) => eventSpecName(e.eventTypeId)) : [];
    }),
  );
}

/** Build the actor list; fall back to a single System agent if none given. */
function normalizeActors(value: unknown): ActorRef[] {
  const arr = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  const out: ActorRef[] = [];
  const seen = new Set<string>();
  for (const a of arr) {
    const role = optString(a.role);
    if (!role || seen.has(role)) continue;
    seen.add(role);
    const kind = ACTOR_KINDS.includes(a.kind as ActorRef['kind'])
      ? (a.kind as ActorRef['kind'])
      : 'system';
    const actor: ActorRef = { role, kind };
    const roleZh = optString(a.roleZh);
    if (roleZh) actor.roleZh = roleZh;
    out.push(actor);
  }
  if (out.length === 0) out.push({ role: 'System', kind: 'system' });
  return out;
}

/**
 * Normalize a step's outgoing edges: remap target ids to process-local ids,
 * drop edges to unknown steps, and keep onEventTypeId only when it resolves to
 * a real event. Returns [] for a terminal step.
 */
function normalizeEdges(
  value: unknown,
  localIdByRaw: Map<string, string>,
  validLocalIds: Set<string>,
  eventIds: Set<string>,
): ProcessEdge[] {
  const arr = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  const out: ProcessEdge[] = [];
  const seen = new Set<string>();
  for (const e of arr) {
    const rawTo = String(e.toStepId ?? '');
    const toStepId = localIdByRaw.get(rawTo);
    if (!toStepId || !validLocalIds.has(toStepId) || seen.has(toStepId)) continue;
    seen.add(toStepId);
    const edge: ProcessEdge = { toStepId };
    const condition = optString(e.condition);
    if (condition) edge.condition = condition;
    const onEventTypeId = optString(e.onEventTypeId);
    if (onEventTypeId && eventIds.has(onEventTypeId)) edge.onEventTypeId = onEventTypeId;
    const label = optBilingual(e.label);
    if (label) edge.label = label;
    out.push(edge);
  }
  return out;
}

/** Normalize triggers; keep only well-formed, vocabulary-valid entries. */
function normalizeTriggers(value: unknown, eventIds: Set<string>): ProcessTrigger[] {
  const arr = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  const out: ProcessTrigger[] = [];
  for (const t of arr) {
    const kind = TRIGGER_KINDS.includes(t.kind as ProcessTrigger['kind'])
      ? (t.kind as ProcessTrigger['kind'])
      : undefined;
    if (!kind) continue;
    const trigger: ProcessTrigger = { kind };
    if (kind === 'event') {
      const eventTypeId = optString(t.eventTypeId);
      if (eventTypeId && eventIds.has(eventTypeId)) trigger.eventTypeId = eventTypeId;
    }
    if (kind === 'schedule') {
      const schedule = optString(t.schedule);
      if (schedule) trigger.schedule = schedule;
    }
    const description = optString(t.description);
    if (description) trigger.description = description;
    out.push(trigger);
  }
  return out;
}

/** Normalize orchestration; default to a sane agent-driven sequential spec. */
function normalizeOrchestration(value: unknown): OrchestrationSpec {
  const o = (value ?? {}) as Record<string, unknown>;
  const strategy = STRATEGIES.includes(o.strategy as OrchestrationSpec['strategy'])
    ? (o.strategy as OrchestrationSpec['strategy'])
    : 'sequential';
  const spec: OrchestrationSpec = {
    strategy,
    agentOrchestrated: typeof o.agentOrchestrated === 'boolean' ? o.agentOrchestrated : true,
  };
  const onFailure = ON_FAILURE.includes(o.onFailure as NonNullable<OrchestrationSpec['onFailure']>)
    ? (o.onFailure as NonNullable<OrchestrationSpec['onFailure']>)
    : undefined;
  if (onFailure) spec.onFailure = onFailure;
  if (Array.isArray(o.agentRoles)) {
    const roles = (o.agentRoles as Record<string, unknown>[])
      .map((r) => ({ role: optString(r.role) ?? '', promptProfile: optString(r.promptProfile) ?? '' }))
      .filter((r) => r.role.length > 0);
    if (roles.length > 0) spec.agentRoles = roles;
  }
  return spec;
}

/** Derive object ids from the actions a process touches when none were given. */
function inferObjectIds(steps: WorkflowStep[], ctx: StageContext, objectIds: Set<string>): string[] {
  const actionById = new Map(ctx.actions.map((a) => [a.id, a]));
  const out: string[] = [];
  for (const s of steps) {
    const action = actionById.get(s.actionTypeId);
    if (!action) continue;
    for (const io of [...action.inputs, ...action.outputs]) {
      const oid = io.objectTypeId;
      if (oid && objectIds.has(oid)) out.push(oid);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Small pure helpers
// ---------------------------------------------------------------------------

/** Coerce a value into a required Bilingual; tolerate string or partial obj. */
function asBilingual(value: unknown): Bilingual {
  if (typeof value === 'string') return { en: value, zh: '' };
  const o = (value ?? {}) as Record<string, unknown>;
  return { en: optString(o.en) ?? '', zh: optString(o.zh) ?? '' };
}

/** Coerce into an OPTIONAL Bilingual; returns undefined when empty. */
function optBilingual(value: unknown): Bilingual | undefined {
  if (value === undefined || value === null) return undefined;
  const b = asBilingual(value);
  return b.en || b.zh ? b : undefined;
}

/** Keep only well-formed SourceRefs (verbatim snippet + a document name). */
function asSources(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) return [];
  const out: SourceRef[] = [];
  for (const s of value as Record<string, unknown>[]) {
    const snippet = optString(s.snippet);
    if (!snippet) continue;
    const ref: SourceRef = {
      documentId: optString(s.documentId) ?? '',
      documentName: optString(s.documentName) ?? '',
      snippet,
    };
    const section = optString(s.section);
    if (section) ref.section = section;
    out.push(ref);
  }
  return out;
}

/** Clamp a model confidence into [0,1]; fall back to a default when missing. */
function clampConfidence(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Trimmed string or undefined for empty/non-string input. */
function optString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/** Coerce an unknown into a string[] of non-empty trimmed strings. */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => optString(v)).filter((v): v is string => Boolean(v));
}

/** Order-preserving de-duplication. */
function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/** Choose a corpus-level document name for the prompt header. */
function pickDocName(ctx: StageContext): string {
  const first = ctx.sources.find((s) => Boolean(s.name));
  return first?.name ?? 'the document';
}

/** Short error text without leaking stacks. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** UUID via Web Crypto when available; deterministic-ish fallback otherwise. */
function newUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `uuid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Defensive JSON-object parse: strips ``` fences and slices to the first '{'
 * .. last '}' before parsing. Returns null on any failure.
 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  let s = text.trim();
  // Strip a leading/trailing code fence (``` or ```json).
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = s.slice(first, last + 1);
  try {
    const obj = JSON.parse(candidate);
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
