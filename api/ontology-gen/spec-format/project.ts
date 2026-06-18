// ============================================================================
//  spec-format/project.ts — deterministic projection: Ontology -> spec format.
// ----------------------------------------------------------------------------
//  `ontologyToSpec(ontology)` projects the canonical internal `Ontology` into
//  the export/presentation schema in `./types.ts` (the shape of the reference
//  samples under `fixtures/spec-samples/`). It is PURE + DETERMINISTIC: no LLM,
//  no I/O, no `Date.now()`/`Math.random()` — the same ontology always yields the
//  same bytes (the `last_updated` header reads `ontology.metadata.updatedAt`).
//
//  Spec fields that have a first-class home on the internal node are passed
//  through (e.g. `Rule.executor`, `ObjectType.objectClass`); the rest are
//  DERIVED deterministically from the rich model:
//    - object `type` (data/system)        <- objectClass, else a name heuristic
//    - object `relationship_description`   <- relationshipNote, else synthesized
//                                             from relationships + FK attributes
//    - object `primary_key`                <- the pk attribute, else `<id>_id`
//    - rule `enforcementLevel`/`failurePolicy` <- the field, else from severity
//    - rule `executor`                     <- the field, else referencing actors
//
//  HARD RULES (NodeNext / strict TS): schema types are imported TYPE-ONLY (so
//  this module has NO runtime dependency on the schema and is alias-free at
//  runtime, importable directly under tsx by the test script); the only runtime
//  import is its sibling `./types.js`. `any` is not used.
// ============================================================================

import type {
  ActionType,
  DataType,
  EventType,
  ObjectProperty,
  ObjectType,
  Ontology,
  Process,
  Relationship,
  Rule,
} from '../../_shared/ontology-schema.js';

import type {
  SpecAction,
  SpecActionIO,
  SpecActionStep,
  SpecActor,
  SpecBundle,
  SpecDataChange,
  SpecEvent,
  SpecEventData,
  SpecMetadata,
  SpecNotification,
  SpecObject,
  SpecObjectProperty,
  SpecObjectsFile,
  SpecActionsFile,
  SpecEventsFile,
  SpecRulesFile,
  SpecWorkflowsFile,
  SpecObjectClass,
  SpecReceipts,
  SpecRule,
  SpecSourceRef,
  SpecStateMutation,
  SpecWorkflow,
  SpecWorkflowStep,
  SpecWorkflowStepType,
} from './types.js';

/** Extract the four receipts kept on every clean node. */
function receipts(n: { confidence?: number; provenance?: string; reviewState?: string; sources?: unknown[] }): SpecReceipts {
  return {
    confidence: typeof n.confidence === 'number' ? n.confidence : 0,
    provenance: n.provenance ?? 'extracted',
    reviewState: n.reviewState ?? 'pending',
    sources: (n.sources ?? []) as SpecSourceRef[],
  };
}

// ===========================================================================
// Pure string helpers (exported subset is unit-tested).
// ===========================================================================

function cap(w: string): string {
  return w ? w[0]!.toUpperCase() + w.slice(1) : w;
}

/** Split a label into alphanumeric words, breaking camel/Pascal boundaries. */
function toWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0);
}

/** "objectType:credit-assessment" -> "Credit_Assessment" (PascalCase_underscore). */
function pascalSnake(s: string): string {
  return toWords(s).map(cap).join('_');
}

/** "Credit_Assessment" -> "credit_assessment". */
function snake(s: string): string {
  return toWords(s).map((w) => w.toLowerCase()).join('_');
}

/** "FulfillOrder" / "fulfill order" / "fulfill_order" -> "fulfillOrder". */
function camel(s: string): string {
  const w = toWords(s);
  if (w.length === 0) return '';
  return w[0]!.toLowerCase() + w.slice(1).map(cap).join('');
}

/** "fill_difficulty" -> "Fill Difficulty". */
function humanize(s: string): string {
  return toWords(s).map(cap).join(' ');
}

/** Drop a known kind-prefix ("objectType:" / "rule:" / ...) from an id. */
function stripPrefix(id: string): string {
  const i = id.indexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}

/** Spec-format object id: PascalCase_underscore key derived from the slug id. */
export function specObjectId(objectTypeId: string): string {
  const bare = stripPrefix(objectTypeId);
  return pascalSnake(bare) || bare;
}

/** Spec-format event name: "event:order.fulfilled" -> "ORDER_FULFILLED". */
export function eventSpecName(name: string): string {
  return stripPrefix(name)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/** Map a closed internal DataType to the human-facing spec type vocabulary. */
export function mapDataType(t: DataType | string | undefined): string {
  switch (t) {
    case 'integer':
      return 'Integer';
    case 'decimal':
    case 'money':
      return 'Float';
    case 'boolean':
      return 'Boolean';
    case 'date':
      return 'Date';
    case 'datetime':
      return 'Timestamp';
    case 'array':
      return 'List<String>';
    case 'string':
    case 'uuid':
    case 'enum':
    case 'reference':
    case 'json':
    default:
      return 'String';
  }
}

const SYSTEM_RE =
  /(system|platform|gateway|portal|\bapi\b|\berp\b|\bcrm\b|\brms\b|engine|middleware|database|系统|平台|网关|中台|引擎)/i;

/** Heuristic data/system classification when `objectClass` is absent. */
function heuristicObjectClass(o: ObjectType): SpecObjectClass {
  const hay = `${o.id} ${o.name} ${o.nameZh ?? ''}`;
  return SYSTEM_RE.test(hay) ? 'system' : 'data';
}

function capActorKind(kind: string): SpecActor {
  if (kind === 'human') return 'Human';
  if (kind === 'system') return 'System';
  return 'Agent';
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

// ===========================================================================
// Projection context — id -> projected-form lookups, built once per ontology.
// ===========================================================================

interface SpecCtx {
  ontology: Ontology;
  objById: Map<string, ObjectType>;
  /** objectType id -> spec object id (PascalCase_underscore). */
  objSpecId: Map<string, string>;
  /** objectType id -> spec object name (display). */
  objName: Map<string, string>;
  /** objectType id -> Chinese object name (for Chinese-first descriptive output). */
  objNameZh: Map<string, string>;
  /** objectType id -> primary key column name. */
  objPk: Map<string, string>;
  actionById: Map<string, ActionType>;
  /** action id -> camelCase action name. */
  actionName: Map<string, string>;
  /** event id -> spec event name (UPPER_SNAKE). */
  eventName: Map<string, string>;
  ruleById: Map<string, Rule>;
  /** rule id -> the actor kinds of actions that gate on it (for executor). */
  ruleActorKinds: Map<string, Set<string>>;
}

function defaultPrimaryKey(o: ObjectType, specId: string): string {
  return (o.primary_key && o.primary_key.trim()) || `${snake(specId)}_id`;
}

function buildCtx(o: Ontology): SpecCtx {
  const objById = new Map<string, ObjectType>();
  const objSpecId = new Map<string, string>();
  const objName = new Map<string, string>();
  const objNameZh = new Map<string, string>();
  const objPk = new Map<string, string>();
  for (const obj of o.objects ?? []) {
    const specId = specObjectId(obj.id);
    objById.set(obj.id, obj);
    objSpecId.set(obj.id, specId);
    objName.set(obj.id, obj.name || specId);
    objNameZh.set(obj.id, obj.nameZh?.trim() || obj.name || specId);
    objPk.set(obj.id, defaultPrimaryKey(obj, specId));
  }

  const actionById = new Map<string, ActionType>();
  const actionName = new Map<string, string>();
  for (const a of o.actions ?? []) {
    actionById.set(a.id, a);
    actionName.set(a.id, camel(a.name) || stripPrefix(a.id));
  }

  const eventName = new Map<string, string>();
  for (const e of o.events ?? []) eventName.set(e.id, eventSpecName(e.name || e.id));

  const ruleById = new Map<string, Rule>();
  for (const r of o.rules ?? []) ruleById.set(r.id, r);

  const ruleActorKinds = new Map<string, Set<string>>();
  for (const a of o.actions ?? []) {
    for (const pc of a.preconditions ?? []) {
      if (!pc?.ruleId) continue;
      let set = ruleActorKinds.get(pc.ruleId);
      if (!set) {
        set = new Set<string>();
        ruleActorKinds.set(pc.ruleId, set);
      }
      if (a.actorRef?.kind) set.add(a.actorRef.kind);
    }
  }

  return {
    ontology: o,
    objById,
    objSpecId,
    objName,
    objNameZh,
    objPk,
    actionById,
    actionName,
    eventName,
    ruleById,
    ruleActorKinds,
  };
}

// ===========================================================================
// Objects.
// ===========================================================================

function projectProperty(prop: ObjectProperty, ctx: SpecCtx): SpecObjectProperty {
  const out: SpecObjectProperty = {
    name: prop.name,
    type: prop.type,
    description: prop.descriptionZh?.trim() || cjkOr(prop.description, prop.nameZh?.trim() || humanize(prop.name)),
  };
  // A foreign key is only marked when its target object is actually present, so
  // `references` always resolves to an emitted spec object id.
  if (prop.is_foreign_key && prop.references && ctx.objSpecId.has(prop.references)) {
    out.is_foreign_key = true;
    out.references = ctx.objSpecId.get(prop.references)!;
  }
  return out;
}

/** Chinese relationship prose synthesized from relationships + FK properties. */
function synthesizeRelationshipDescription(o: ObjectType, ctx: SpecCtx): string {
  const rels: Relationship[] = ctx.ontology.relationships ?? [];
  const self = o.nameZh?.trim() || o.name;
  const refById = new Map<string, string>();
  for (const [id] of ctx.objSpecId) refById.set(ctx.objSpecId.get(id)!, id);
  const parts: string[] = [];

  for (const rel of rels) {
    const verb = rel.nameZh?.trim() || rel.description?.trim() || humanize(rel.name) || '关联';
    if (rel.sourceObjectTypeId === o.id && ctx.objNameZh.has(rel.targetObjectTypeId)) {
      parts.push(`【${self}】${verb}【${ctx.objNameZh.get(rel.targetObjectTypeId)}】。`);
    } else if (rel.targetObjectTypeId === o.id && ctx.objNameZh.has(rel.sourceObjectTypeId)) {
      parts.push(`【${ctx.objNameZh.get(rel.sourceObjectTypeId)}】${verb}【${self}】。`);
    }
  }

  for (const p of o.properties ?? []) {
    if (p.is_foreign_key && p.references) {
      const targetId = refById.get(p.references);
      const targetZh = targetId ? ctx.objNameZh.get(targetId) : undefined;
      if (targetZh) parts.push(`【${self}】通过 ${p.name} 引用【${targetZh}】。`);
    }
  }

  const deduped = uniq(parts);
  return deduped.length === 0 ? `【${self}】暂无与其他对象的关联关系。` : deduped.join('');
}

function projectObject(o: ObjectType, ctx: SpecCtx): SpecObject {
  const specId = ctx.objSpecId.get(o.id) ?? specObjectId(o.id);
  const relDesc = o.relationship_description?.trim();
  return {
    ...receipts(o),
    id: specId,
    name: o.nameZh?.trim() || o.name || specId,
    description: o.descriptionZh?.trim() || o.description?.trim() || '',
    type: o.type ?? heuristicObjectClass(o),
    relationship_description: hasCJK(relDesc) ? relDesc! : synthesizeRelationshipDescription(o, ctx),
    primary_key: o.primary_key?.trim() || ctx.objPk.get(o.id) || defaultPrimaryKey(o, specId),
    properties: (o.properties ?? []).map((p) => projectProperty(p, ctx)),
  };
}

// ===========================================================================
// Rules.
// ===========================================================================

function deriveExecutor(r: Rule, ctx: SpecCtx): SpecExecutorInternal {
  if (r.executor) return r.executor;
  const kinds = ctx.ruleActorKinds.get(r.id);
  if (kinds && kinds.has('human')) return 'Human';
  // Default: rules are agent-enforced unless evidence says a human carries them out.
  return 'Agent';
}
type SpecExecutorInternal = 'Human' | 'Agent';

const nonEmpty = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;
const hasCJK = (s: unknown): boolean => typeof s === 'string' && /[一-鿿]/.test(s);
/** Keep a single-language string only if it is Chinese; else use the zh fallback. */
const cjkOr = (s: unknown, fallback: string): string => (hasCJK(s) ? (s as string).trim() : fallback);

/** Chinese label for a rule kind (used when no Chinese scenario text exists). */
const KIND_ZH: Record<string, string> = {
  validation: '数据校验',
  constraint: '业务约束',
  derivation: '指标推导',
  state_transition: '状态流转',
  authorization: '权限授权',
  temporal: '时限控制',
};

function projectRule(r: Rule, ctx: SpecCtx): SpecRule {
  // Prefer the canonical spec fields (now first-class + Chinese on Rule); fall
  // back to deriving Chinese-first from the structural fields for older nodes.
  const enforcementLevel =
    r.enforcementLevel ?? (r.severity === 'block' ? 'mandatory' : 'optional');
  const failurePolicy = r.failurePolicy ?? (r.severity === 'block' ? 'block' : 'warn');

  const standardizedLogicRule = nonEmpty(r.standardizedLogicRule)
    ? r.standardizedLogicRule
    : r.statement?.zh?.trim() || r.statement?.en?.trim() || r.formal?.trim() || '';

  const relatedEntities =
    (r.relatedEntities?.length ?? 0) > 0
      ? r.relatedEntities
      : (r.appliesToObjectTypeIds ?? [])
          .filter((id) => ctx.objSpecId.has(id))
          .map((id) => `${ctx.objNameZh.get(id)} (${ctx.objSpecId.get(id)})`);

  const groupRationale = r.groupId
    ? (ctx.ontology.ruleGroups ?? []).find((g) => g.id === r.groupId)?.rationale
    : undefined;

  return {
    ...receipts(r),
    id: stripPrefix(r.id),
    specificScenarioStage: nonEmpty(r.specificScenarioStage)
      ? r.specificScenarioStage
      : cjkOr(r.trigger?.description, KIND_ZH[r.kind] || '业务约束'),
    businessLogicRuleName: nonEmpty(r.businessLogicRuleName)
      ? r.businessLogicRuleName
      : r.titleZh?.trim() || r.title?.trim() || stripPrefix(r.id),
    applicableClient: nonEmpty(r.applicableClient) ? r.applicableClient : '通用',
    applicableDepartment: nonEmpty(r.applicableDepartment) ? r.applicableDepartment : 'N/A',
    submissionCriteria: nonEmpty(r.submissionCriteria)
      ? r.submissionCriteria
      : cjkOr(r.trigger?.description, cjkOr(r.expression?.predicate, '')),
    standardizedLogicRule,
    relatedEntities,
    businessBackgroundReason: nonEmpty(r.businessBackgroundReason)
      ? r.businessBackgroundReason
      : groupRationale?.trim() || '',
    ruleSource: nonEmpty(r.ruleSource) ? r.ruleSource : r.sources?.[0]?.documentName?.trim() || '文档',
    executor: r.executor ?? deriveExecutor(r, ctx),
    enforcementLevel,
    failurePolicy,
  };
}

// ===========================================================================
// Actions.
// ===========================================================================

function actorLabel(kind: string | undefined): string {
  if (kind === 'human') return 'human operator';
  if (kind === 'system') return 'system';
  return 'agent';
}

function collectTargetObjects(a: ActionType, ctx: SpecCtx): string[] {
  const ids: string[] = [];
  const add = (oid: string | undefined): void => {
    if (oid && ctx.objSpecId.has(oid)) ids.push(ctx.objSpecId.get(oid)!);
  };
  for (const io of a.inputs ?? []) add(io.objectTypeId);
  for (const io of a.outputs ?? []) add(io.objectTypeId);
  for (const step of a.steps ?? []) {
    for (const oid of step.readsObjectTypeIds ?? []) add(oid);
    for (const oid of step.writesObjectTypeIds ?? []) add(oid);
  }
  for (const se of a.sideEffects ?? []) add(se.objectTypeId);
  return uniq(ids);
}

function projectInput(io: ActionType['inputs'][number], ctx: SpecCtx): SpecActionIO {
  const out: SpecActionIO = {
    name: io.name,
    type: io.objectTypeId ? 'String' : io.type || 'String',
    description: io.description?.trim() || `${humanize(io.name)}.`,
    required: io.required === true,
  };
  if (io.objectTypeId && ctx.objSpecId.has(io.objectTypeId)) {
    out.source_object = `${ctx.objSpecId.get(io.objectTypeId)}.${ctx.objPk.get(io.objectTypeId)}`;
  }
  return out;
}

function projectOutput(io: ActionType['outputs'][number]): SpecActionIO {
  return {
    name: io.name,
    type: io.objectTypeId ? 'String' : io.type || 'String',
    description: io.description?.trim() || `${humanize(io.name)}.`,
  };
}

function stepName(step: ActionType['steps'][number]): string {
  const text = step.text?.en || step.text?.zh || '';
  const name = camel(toWords(text).slice(0, 6).join(' '));
  return name || `step${step.order}`;
}

function projectActionStep(step: ActionType['steps'][number], ctx: SpecCtx): SpecActionStep {
  const out: SpecActionStep = {
    order: String(step.order),
    name: stepName(step),
    description: step.text?.en?.trim() || step.text?.zh?.trim() || '',
    object_type: 'logic',
    submission_criteria: '',
  };
  if (step.guardRuleId && ctx.ruleById.has(step.guardRuleId)) {
    const rule = ctx.ruleById.get(step.guardRuleId)!;
    out.submission_criteria = rule.trigger?.description?.trim() || '';
    out.rules = [
      {
        id: stripPrefix(rule.id),
        name: rule.title || stripPrefix(rule.id),
        submission_criteria: rule.trigger?.description?.trim() || '',
        description: rule.statement?.en?.trim() || rule.formal?.trim() || '',
      },
    ];
  }
  return out;
}

function synthSubmissionCriteria(a: ActionType, ctx: SpecCtx): string {
  const lines: string[] = [];
  let n = 1;
  for (const eid of a.triggeredByEventIds ?? []) {
    if (ctx.eventName.has(eid)) lines.push(`${n++}. Event ${ctx.eventName.get(eid)} has been received`);
  }
  for (const pc of a.preconditions ?? []) {
    const rule = ctx.ruleById.get(pc.ruleId);
    if (rule) lines.push(`${n++}. Rule "${rule.title || stripPrefix(rule.id)}" is satisfied`);
  }
  return lines.join('\n');
}

function projectSideEffects(a: ActionType, ctx: SpecCtx): SpecAction['side_effects'] {
  const dataChanges: SpecDataChange[] = [];
  const notifications: SpecNotification[] = [];
  for (const se of a.sideEffects ?? []) {
    if (se.kind === 'notification') {
      notifications.push({
        recipient: a.actorRef?.role || 'User',
        channel: 'InApp',
        condition: '',
        message: se.description?.trim() || '',
        triggered_event: '',
      });
    } else if (
      (se.kind === 'db_write' || se.kind === 'state_change' || se.kind === 'payment') &&
      se.objectTypeId &&
      ctx.objSpecId.has(se.objectTypeId)
    ) {
      dataChanges.push({
        object_type: ctx.objSpecId.get(se.objectTypeId)!,
        action: se.kind === 'db_write' ? 'CREATE' : 'MODIFY',
        property_impacted: [],
        description: se.description?.trim() || '',
      });
    }
  }
  return { data_changes: dataChanges, notifications };
}

function collectToolUse(a: ActionType): string[] {
  const tools: string[] = [];
  if (a.agent?.integration) tools.push(a.agent.integration);
  for (const se of a.sideEffects ?? []) {
    if (se.kind === 'external_call' && se.description) tools.push(se.description.trim());
  }
  return uniq(tools);
}

/** Prefer the canonical (Chinese) spec field; fall back to deriving for old nodes. */
function projectAction(a: ActionType, ctx: SpecCtx): SpecAction {
  const inputs = (a.inputs ?? []).map((io) => projectInput(io, ctx));
  const outputs = (a.outputs ?? []).map((io) => projectOutput(io));
  const inputNames = inputs.map((i) => i.name).join(', ') || 'the provided inputs';
  const outputNames = outputs.map((o) => o.name).join(', ') || 'the resulting records';
  const has = (v: unknown[] | undefined): boolean => Array.isArray(v) && v.length > 0;

  return {
    ...receipts(a),
    id: stripPrefix(a.id),
    name: ctx.actionName.get(a.id) ?? camel(a.name),
    description: a.description?.trim() || '',
    submission_criteria: nonEmpty(a.submission_criteria) ? a.submission_criteria : synthSubmissionCriteria(a, ctx),
    object_type: 'action',
    category: nonEmpty(a.category) ? a.category : a.nameZh?.trim() || humanize(a.name),
    actor: has(a.actor) ? a.actor : a.actorRef?.kind ? [capActorKind(a.actorRef.kind)] : ['Agent'],
    trigger: has(a.trigger)
      ? a.trigger
      : (a.triggeredByEventIds ?? []).filter((eid) => ctx.eventName.has(eid)).map((eid) => ctx.eventName.get(eid)!),
    target_objects: has(a.target_objects) ? a.target_objects : collectTargetObjects(a, ctx),
    inputs,
    outputs,
    action_steps: has(a.action_steps) ? a.action_steps : (a.steps ?? []).map((s) => projectActionStep(s, ctx)),
    system_prompt: nonEmpty(a.system_prompt)
      ? a.system_prompt
      : `You are an automated ${actorLabel(a.actorRef?.kind)} responsible for the "${a.name}" action. ` +
        `${a.description?.trim() ?? ''} Read the required objects, honor every precondition, and perform the steps in order.`,
    user_prompt: nonEmpty(a.user_prompt)
      ? a.user_prompt
      : `Execute "${a.name}" using ${inputNames}. ${a.description?.trim() ?? ''} Produce ${outputNames} and emit the appropriate events.`,
    typescript_code: a.typescript_code ?? '',
    tool_use: a.tool_use ?? collectToolUse(a),
    side_effects: a.side_effects ?? projectSideEffects(a, ctx),
    triggered_event: has(a.triggered_event)
      ? a.triggered_event
      : uniq((a.emitsEvents ?? []).map((em) => em.eventTypeId).filter((eid) => ctx.eventName.has(eid)).map((eid) => ctx.eventName.get(eid)!)),
  };
}

// ===========================================================================
// Events.
// ===========================================================================

function deriveStateMutations(e: EventType, ctx: SpecCtx): SpecStateMutation[] {
  const targets: string[] = [];
  for (const aid of e.producedByActionIds ?? []) {
    const a = ctx.actionById.get(aid);
    if (!a) continue;
    for (const se of a.sideEffects ?? []) {
      if (
        (se.kind === 'db_write' || se.kind === 'state_change' || se.kind === 'payment') &&
        se.objectTypeId &&
        ctx.objSpecId.has(se.objectTypeId)
      ) {
        targets.push(ctx.objSpecId.get(se.objectTypeId)!);
      }
    }
  }
  if (targets.length === 0) {
    for (const f of e.payloadFields ?? []) {
      if (f.objectTypeId && ctx.objSpecId.has(f.objectTypeId)) targets.push(ctx.objSpecId.get(f.objectTypeId)!);
    }
  }
  return uniq(targets).map((t) => ({
    target_object: t,
    mutation_type: 'CREATE_OR_MODIFY',
    impacted_properties: [],
  }));
}

function projectEvent(e: EventType, ctx: SpecCtx): SpecEvent {
  const eventData: SpecEventData[] = (e.payloadFields ?? []).map((f) => ({
    name: f.name,
    type: mapDataType(f.type),
    target_object: f.objectTypeId && ctx.objSpecId.has(f.objectTypeId) ? ctx.objSpecId.get(f.objectTypeId)! : null,
  }));

  const sourceActionId = (e.producedByActionIds ?? []).find((aid) => ctx.actionName.has(aid));

  return {
    ...receipts(e),
    name: ctx.eventName.get(e.id) ?? eventSpecName(e.name || e.id),
    description: nonEmpty(e.descriptionZh) ? e.descriptionZh : e.description?.trim() || '',
    payload: {
      source_action: sourceActionId ? ctx.actionName.get(sourceActionId)! : '',
      event_data: eventData,
      state_mutations: deriveStateMutations(e, ctx),
    },
  };
}

// ===========================================================================
// Workflows (from internal Processes).
// ===========================================================================

function workflowStepType(a: ActionType | undefined): SpecWorkflowStepType {
  if (!a) return 'logic';
  if (a.actorRef?.kind === 'human') return 'manual';
  const external =
    !!a.agent?.integration || (a.sideEffects ?? []).some((se) => se.kind === 'external_call');
  if (external) return 'tool';
  return 'logic';
}

function projectWorkflow(p: Process, ctx: SpecCtx): SpecWorkflow {
  const actors = uniq((p.actors ?? []).map((a) => capActorKind(a.kind)));
  const actor: SpecActor[] =
    actors.length > 0 ? actors : [p.orchestration?.agentOrchestrated ? 'Agent' : 'Human'];

  const trigger = uniq(
    (p.triggers ?? []).flatMap((t): string[] => {
      if (t.kind === 'event' && t.eventTypeId && ctx.eventName.has(t.eventTypeId)) {
        return [ctx.eventName.get(t.eventTypeId)!];
      }
      if (t.kind === 'schedule') return ['SCHEDULED_SYNC'];
      return [];
    }),
  );

  const steps: SpecWorkflowStep[] = (p.steps ?? []).map((step) => {
    const a = ctx.actionById.get(step.actionTypeId);
    const edge = step.next?.[0];
    return {
      order: String(step.order),
      name: a ? ctx.actionName.get(a.id)! : stripPrefix(step.actionTypeId),
      description: a ? cjkOr(a.descriptionZh, a.description?.trim() || '') : '',
      type: workflowStepType(a),
      condition: edge?.condition?.trim() || edge?.label?.en?.trim() || '',
    };
  });

  const triggeredEvent = uniq(
    (p.steps ?? []).flatMap((step) => {
      const a = ctx.actionById.get(step.actionTypeId);
      if (!a) return [] as string[];
      return (a.emitsEvents ?? [])
        .map((em) => em.eventTypeId)
        .filter((eid) => ctx.eventName.has(eid))
        .map((eid) => ctx.eventName.get(eid)!);
    }),
  );

  return {
    ...receipts(p),
    id: stripPrefix(p.id),
    name: camel(p.name?.en || '') || stripPrefix(p.id),
    description: cjkOr(p.description, p.name?.zh?.trim() || p.name?.en?.trim() || ''),
    actor: actor.length > 0 ? actor : ['Agent'],
    trigger,
    actions: steps,
    triggered_event: triggeredEvent,
  };
}

// ===========================================================================
// Public API.
// ===========================================================================

/** Project an internal Ontology into the five spec-format layers. Pure. */
export function ontologyToSpec(o: Ontology): SpecBundle {
  const ctx = buildCtx(o);
  return {
    objects: (o.objects ?? []).map((obj) => projectObject(obj, ctx)),
    rules: (o.rules ?? []).map((r) => projectRule(r, ctx)),
    actions: (o.actions ?? []).map((a) => projectAction(a, ctx)),
    events: (o.events ?? []).map((e) => projectEvent(e, ctx)),
    workflows: (o.processes ?? []).map((p) => projectWorkflow(p, ctx)),
  };
}

/** The per-file metadata header (deterministic — reads ontology.metadata only). */
export function specMetadata(o: Ontology, documentType: string, description: string): SpecMetadata {
  const updated = o.metadata?.updatedAt || o.metadata?.createdAt || '';
  return {
    project_name: o.name || stripPrefix(o.id),
    document_type: documentType,
    version: String(o.version ?? 1),
    last_updated: updated ? updated.slice(0, 10) : '',
    description,
  };
}

export function ontologyToSpecObjectsFile(o: Ontology): SpecObjectsFile {
  return {
    metadata: specMetadata(o, '本体定义 (Ontology Schema)', 'Data objects (entities) and their properties + relationships.'),
    objects: ontologyToSpec(o).objects,
  };
}
export function ontologyToSpecRulesFile(o: Ontology): SpecRulesFile {
  return {
    metadata: specMetadata(o, '规则对象', 'Business rules governing decisions, with executor / enforcement / failure policy.'),
    rules: ontologyToSpec(o).rules,
  };
}
export function ontologyToSpecActionsFile(o: Ontology): SpecActionsFile {
  return {
    metadata: specMetadata(o, '本体定义 (Ontology Schema)', 'Action definitions — inputs, steps, side effects, and emitted events.'),
    actions: ontologyToSpec(o).actions,
  };
}
export function ontologyToSpecEventsFile(o: Ontology): SpecEventsFile {
  return {
    metadata: specMetadata(o, '本体定义 (Ontology Schema)', 'Event definitions — payloads and state mutations.'),
    events: ontologyToSpec(o).events,
  };
}
export function ontologyToSpecWorkflowsFile(o: Ontology): SpecWorkflowsFile {
  return {
    metadata: specMetadata(o, '本体定义 (Ontology Schema)', 'Workflow definitions — ordered action steps with triggers.'),
    workflows: ontologyToSpec(o).workflows,
  };
}

export { defaultPrimaryKey };
