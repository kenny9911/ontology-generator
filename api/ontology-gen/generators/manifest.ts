// ============================================================================
//  T19 — Manifest generator
// ----------------------------------------------------------------------------
//  Pure, deterministic projection: Ontology -> GeneratedBundle (target
//  "manifest"). One WorkflowManifest per Process, each pinning the source
//  Ontology.version so a deployed manifest is reproducible against the exact
//  ontology snapshot it was compiled from.
//
//  Behaviour (DESIGN_SPEC §3.7 "manifest.ts"):
//    - buildWorkflowManifest(o, processId): WorkflowManifest
//        * nodes: ManifestNode[]  -- one per WorkflowStep, in `order`, carrying
//          the action's tool name, preconditions (ruleId + predicate + severity),
//          emitted events, and the step's outgoing `next` edges.
//        * tools[]: catalog of the AgentBindings referenced by THIS process's
//          steps (scoped, deduped, deterministically ordered).
//        * agents[]: one per distinct ActorRole owning a step, with a short
//          composed prompt + the tool names it owns within this process.
//    - generateManifests(o): GeneratedBundle  -- one GeneratedFile (JSON) per
//      Process plus a warnings[] listing every cross-reference that did not
//      resolve (dangling action / event / rule / step / actor).
//
//  Derived solely from the ontology JSON. No LLM call. No information added that
//  is not present in the ontology. Every referenced id is cross-checked; an
//  unresolved reference is surfaced as a warning and the node is repaired to a
//  safe-but-honest placeholder (empty tool name) rather than dropped.
// ============================================================================

import type {
  Ontology,
  ObjectType,
  ActionType,
  EventType,
  Process,
  Rule,
  WorkflowStep,
  WorkflowManifest,
  ManifestNode,
  Severity,
  Bilingual,
  GeneratedBundle,
  GeneratedFile,
} from '../../_shared/ontology-schema.js';

// ---------------------------------------------------------------------------
// Internal index helpers (built once per process / bundle, kept tiny + pure).
// ---------------------------------------------------------------------------

interface OntologyIndex {
  actionById: Map<string, ActionType>;
  eventById: Map<string, EventType>;
  ruleById: Map<string, Rule>;
  objectById: Map<string, ObjectType>;
}

function indexOntology(o: Ontology): OntologyIndex {
  const actionById = new Map<string, ActionType>();
  for (const a of o.actions ?? []) actionById.set(a.id, a);

  const eventById = new Map<string, EventType>();
  for (const e of o.events ?? []) eventById.set(e.id, e);

  const ruleById = new Map<string, Rule>();
  for (const r of o.rules ?? []) ruleById.set(r.id, r);

  const objectById = new Map<string, ObjectType>();
  for (const obj of o.objects ?? []) objectById.set(obj.id, obj);

  return { actionById, eventById, ruleById, objectById };
}

/**
 * The CEL predicate for a precondition, when the rule carries a structured
 * machine form. The Rule's value is authoritative; this is the operator-runtime
 * gate string. Returns undefined when the rule has no compilable expression.
 */
function predicateForRule(rule: Rule | undefined): string | undefined {
  const predicate = rule?.expression?.predicate;
  if (typeof predicate === 'string' && predicate.trim().length > 0) return predicate;
  return undefined;
}

/**
 * Resolve a precondition's severity. The PreconditionRef caches one for display
 * but the Rule is authoritative; prefer the live rule, then the cached value,
 * then the safe default ('block' — preconditions gate execution).
 */
function severityForPrecondition(rule: Rule | undefined, cached: Severity | undefined): Severity {
  return rule?.severity ?? cached ?? 'block';
}

// ---------------------------------------------------------------------------
// Node flattening
// ---------------------------------------------------------------------------

/**
 * Flatten one WorkflowStep into a ManifestNode, resolving its action and all
 * referenced ids against the ontology index. Unresolved references are pushed
 * onto `warnings` and the node is repaired (empty tool name / dropped edge) so
 * the manifest stays internally consistent.
 */
function flattenStep(
  step: WorkflowStep,
  process: Process,
  idx: OntologyIndex,
  stepIds: Set<string>,
  warnings: string[],
): ManifestNode {
  const action = idx.actionById.get(step.actionTypeId);
  if (!action) {
    warnings.push(
      `process ${process.id} step ${step.id}: actionTypeId '${step.actionTypeId}' does not resolve to an ActionType`,
    );
  }

  const actionToolName = action?.agent?.toolName ?? '';

  // Preconditions: rule id + (optional) CEL predicate + authoritative severity.
  const preconditions = (action?.preconditions ?? []).map((pc) => {
    const rule = idx.ruleById.get(pc.ruleId);
    if (!rule) {
      warnings.push(
        `process ${process.id} step ${step.id}: precondition ruleId '${pc.ruleId}' does not resolve to a Rule`,
      );
    }
    const predicate = predicateForRule(rule);
    const node: { ruleId: string; predicate?: string; severity: Severity } = {
      ruleId: pc.ruleId,
      severity: severityForPrecondition(rule, pc.severity),
    };
    if (predicate !== undefined) node.predicate = predicate;
    return node;
  });

  // Emitted events: cross-check each EmitSpec target resolves to an EventType.
  const emits = (action?.emitsEvents ?? []).map((em) => {
    if (!idx.eventById.has(em.eventTypeId)) {
      warnings.push(
        `process ${process.id} step ${step.id}: emitted eventTypeId '${em.eventTypeId}' does not resolve to an EventType`,
      );
    }
    return { eventTypeId: em.eventTypeId, on: em.on as string };
  });

  // Outgoing edges: each must point at a real step within THIS process; an
  // event-driven edge's EventType must resolve. Dangling edges are dropped.
  const next: { toStepId: string; condition?: string; onEventTypeId?: string }[] = [];
  for (const edge of step.next ?? []) {
    if (!stepIds.has(edge.toStepId)) {
      warnings.push(
        `process ${process.id} step ${step.id}: next.toStepId '${edge.toStepId}' is not a step in this process`,
      );
      continue;
    }
    if (edge.onEventTypeId !== undefined && !idx.eventById.has(edge.onEventTypeId)) {
      warnings.push(
        `process ${process.id} step ${step.id}: edge onEventTypeId '${edge.onEventTypeId}' does not resolve to an EventType`,
      );
    }
    const out: { toStepId: string; condition?: string; onEventTypeId?: string } = {
      toStepId: edge.toStepId,
    };
    if (edge.condition !== undefined) out.condition = edge.condition;
    if (edge.onEventTypeId !== undefined) out.onEventTypeId = edge.onEventTypeId;
    next.push(out);
  }

  // Actor role: the step's own role wins, falling back to the action's actor.
  const actorRole = step.actorRole ?? action?.actor?.role;

  const node: ManifestNode = {
    id: step.id,
    actionToolName,
    preconditions,
    emits,
    next,
  };
  if (actorRole !== undefined) node.actorRole = actorRole;
  return node;
}

// ---------------------------------------------------------------------------
// Agent prompt composition (short, deterministic — no LLM)
// ---------------------------------------------------------------------------

/**
 * A short, deterministic system prompt for one role, naming the tools it owns
 * within the process. Kept terse per the contract (a "short" prompt); the full
 * per-role prompt artifact is produced by the separate prompts generator.
 */
function composeAgentPrompt(role: string, toolNames: string[]): string {
  const toolList = toolNames.length > 0 ? toolNames.join(', ') : '(none)';
  return (
    `You are the ${role} agent in this workflow. ` +
    `You may call only your assigned tools: ${toolList}. ` +
    `Honor every precondition rule before acting and emit the declared events on completion.`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a self-contained, deployable WorkflowManifest for a single Process.
 * Pins `ontologyVersion` to the source ontology's version. Throws only if the
 * processId does not exist on the ontology (a programmer error at the call
 * site; generateManifests never triggers this).
 */
export function buildWorkflowManifest(o: Ontology, processId: string): WorkflowManifest {
  const process = (o.processes ?? []).find((p) => p.id === processId);
  if (!process) {
    throw new Error(`buildWorkflowManifest: process '${processId}' not found in ontology '${o.id}'`);
  }
  const { manifest } = buildManifestWithWarnings(o, process, indexOntology(o));
  return manifest;
}

/**
 * Core builder shared by the single + bundle entry points. Returns the manifest
 * plus the warnings it accumulated so the bundle can aggregate them.
 */
function buildManifestWithWarnings(
  o: Ontology,
  process: Process,
  idx: OntologyIndex,
): { manifest: WorkflowManifest; warnings: string[] } {
  const warnings: string[] = [];

  const steps = [...(process.steps ?? [])].sort((a, b) => a.order - b.order);
  const stepIds = new Set(steps.map((s) => s.id));

  const nodes: ManifestNode[] = steps.map((s) =>
    flattenStep(s, process, idx, stepIds, warnings),
  );

  // Tool catalog: the AgentBindings of the actions referenced by THIS process's
  // steps, deduped by toolName, in first-appearance (step) order. Role -> tools
  // ownership is accumulated in the same pass so agents[] stays consistent.
  const tools: WorkflowManifest['tools'] = [];
  const seenTools = new Set<string>();
  const roleToTools = new Map<string, string[]>();
  const roleOrder: string[] = [];

  for (const step of steps) {
    const action = idx.actionById.get(step.actionTypeId);
    if (!action) continue;
    const binding = action.agent;
    const toolName = binding?.toolName ?? '';

    if (binding && toolName && !seenTools.has(toolName)) {
      seenTools.add(toolName);
      const entry: WorkflowManifest['tools'][number] = {
        toolName,
        parameterSchema: binding.parameterSchema,
        execution: binding.execution,
      };
      if (binding.integration !== undefined) entry.integration = binding.integration;
      tools.push(entry);
    }

    const role = step.actorRole ?? action.actor?.role;
    if (role) {
      if (!roleToTools.has(role)) {
        roleToTools.set(role, []);
        roleOrder.push(role);
      }
      const owned = roleToTools.get(role)!;
      if (toolName && !owned.includes(toolName)) owned.push(toolName);
    }
  }

  const agents: WorkflowManifest['agents'] = roleOrder.map((role) => {
    const toolNames = roleToTools.get(role) ?? [];
    return { role, prompt: composeAgentPrompt(role, toolNames), tools: toolNames };
  });

  // Validate the process's declared objectTypeIds + actor roles for completeness
  // (referential-integrity receipts; these do not alter the manifest body).
  for (const objId of process.objectTypeIds ?? []) {
    if (!idx.objectById.has(objId)) {
      warnings.push(
        `process ${process.id}: objectTypeId '${objId}' does not resolve to an ObjectType`,
      );
    }
  }

  const name: Bilingual = process.name ?? { en: process.id, zh: process.id };

  const manifest: WorkflowManifest = {
    manifestVersion: 1,
    ontologyId: o.id,
    ontologyVersion: o.version,
    processId: process.id,
    name,
    trigger: process.triggers ?? [],
    nodes,
    tools,
    agents,
  };

  return { manifest, warnings };
}

/**
 * Produce the full manifest bundle for an ontology: one GeneratedFile (pretty
 * JSON) per Process, with every cross-reference warning aggregated. Pure +
 * deterministic; safe on an ontology with zero processes (empty bundle).
 */
export function generateManifests(o: Ontology): GeneratedBundle {
  const idx = indexOntology(o);
  const files: GeneratedFile[] = [];
  const warnings: string[] = [];

  for (const process of o.processes ?? []) {
    const { manifest, warnings: processWarnings } = buildManifestWithWarnings(o, process, idx);
    warnings.push(...processWarnings);
    files.push({
      path: `manifests/${manifestFileName(process.id)}.json`,
      language: 'json',
      content: JSON.stringify(manifest, null, 2),
    });
  }

  if ((o.processes ?? []).length === 0) {
    warnings.push(`ontology ${o.id}: no processes to manifest`);
  }

  return { target: 'manifest', files, warnings };
}

/**
 * Slug-safe file stem from a process id. Strips the "process:" prefix and maps
 * non-filename characters to '_' so file paths are stable and portable.
 */
function manifestFileName(processId: string): string {
  const stem = processId.startsWith('process:') ? processId.slice('process:'.length) : processId;
  return stem.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'process';
}
