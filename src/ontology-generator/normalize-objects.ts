// ============================================================================
//  normalize-objects.ts — back-compat: legacy `attributes` → spec `properties`.
// ----------------------------------------------------------------------------
//  Older stored ontologies carry the legacy ObjectType shape (`attributes` with
//  keyRole/enumValues/refObjectTypeId). The migrated UI + JSON editor expect the
//  spec shape (`properties` + type/relationship_description/primary_key).
//  `normalizeOntologyObjects` converts legacy objects and back-fills any missing
//  new fields. It is IDEMPOTENT — a fully-migrated ontology passes through
//  untouched — and is applied at the controller's single ontology-commit
//  chokepoint so every screen sees ONE object shape.
//
//  Runtime is ALIAS-FREE (schema imports are TYPE-ONLY, erased at compile), so
//  the tsx test suite can import this module directly.
// ============================================================================

import type {
  ActionType,
  DataType,
  EventField,
  EventType,
  ObjectProperty,
  ObjectType,
  Ontology,
  Process,
  PropertyType,
  Relationship,
  Rule,
  SourceRef,
  SpecActor,
} from '@/ontology/schema/types';

const SYSTEM_RE =
  /(system|platform|gateway|portal|\bapi\b|\berp\b|\bcrm\b|\brms\b|engine|middleware|database|系统|平台|网关|中台|引擎)/i;

/** Map a legacy internal DataType to the human-facing PropertyType. */
function dataTypeToPropertyType(t: DataType | string | undefined): PropertyType {
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
    case 'enum':
    case 'array':
      return 'List<String>';
    default:
      return 'String';
  }
}

function idSlug(id: string): string {
  return id
    .replace(/^objectType:/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** Loosely-typed legacy attribute (the old stored shape). */
interface LegacyAttr {
  name: string;
  nameZh?: string;
  type?: string;
  keyRole?: string;
  refObjectTypeId?: string;
  description?: string;
  descriptionZh?: string;
  sources?: SourceRef[];
}

function legacyAttrToProperty(a: LegacyAttr, idSet: Set<string>): ObjectProperty {
  const prop: ObjectProperty = {
    name: a.name,
    type: dataTypeToPropertyType(a.type),
    description: a.description ?? '',
  };
  if (a.nameZh) prop.nameZh = a.nameZh;
  if (a.descriptionZh) prop.descriptionZh = a.descriptionZh;
  if ((a.keyRole === 'fk' || a.type === 'reference') && a.refObjectTypeId && idSet.has(a.refObjectTypeId)) {
    prop.is_foreign_key = true;
    prop.references = a.refObjectTypeId;
  }
  if (a.sources) prop.sources = a.sources;
  return prop;
}

const hasCJK = (s: unknown): boolean => typeof s === 'string' && /[一-鿿]/.test(s);
const cjkOr = (s: unknown, fallback: string): string => (hasCJK(s) ? (s as string).trim() : fallback);

/** Chinese relationship prose synthesized from the object's relationships. */
function synthRelationshipDesc(
  o: ObjectType,
  rels: Relationship[],
  nameZhById: Map<string, string>,
): string {
  const self = o.nameZh?.trim() || o.name;
  const parts: string[] = [];
  for (const r of rels) {
    const verb = r.nameZh?.trim() || r.description?.trim() || (r.name || '').replace(/_/g, ' ') || '关联';
    if (r.sourceObjectTypeId === o.id && nameZhById.has(r.targetObjectTypeId)) {
      parts.push(`【${self}】${verb}【${nameZhById.get(r.targetObjectTypeId)}】。`);
    } else if (r.targetObjectTypeId === o.id && nameZhById.has(r.sourceObjectTypeId)) {
      parts.push(`【${nameZhById.get(r.sourceObjectTypeId)}】${verb}【${self}】。`);
    }
  }
  const uniq = [...new Set(parts)];
  return uniq.length ? uniq.join('') : `【${self}】暂无与其他对象的关联关系。`;
}

function normalizeObject(
  o: ObjectType,
  rels: Relationship[],
  nameZhById: Map<string, string>,
  idSet: Set<string>,
): ObjectType {
  const hasProps = Array.isArray(o.properties);
  const description = o.descriptionZh?.trim() || o.description || '';
  const fullyMigrated = hasProps && o.type && o.primary_key && hasCJK(o.relationship_description) && description === o.description;
  if (fullyMigrated) return o;

  const legacy = (o as unknown as { attributes?: LegacyAttr[] }).attributes ?? [];
  let properties: ObjectProperty[] =
    hasProps && o.properties.length > 0 ? o.properties : legacy.map((a) => legacyAttrToProperty(a, idSet));
  properties = properties.map((p) => ({ ...p, description: p.descriptionZh?.trim() || cjkOr(p.description, p.nameZh?.trim() || (p.name || '').replace(/_/g, ' ')) }));
  const pkAttr = legacy.find((a) => a.keyRole === 'pk');
  const primary_key = o.primary_key || (pkAttr ? pkAttr.name : `${idSlug(o.id)}_id`);
  const type = o.type ?? (SYSTEM_RE.test(`${o.id} ${o.name} ${o.nameZh ?? ''}`) ? 'system' : 'data');
  const relationship_description = hasCJK(o.relationship_description) ? o.relationship_description : synthRelationshipDesc(o, rels, nameZhById);

  const rest = { ...(o as unknown as Record<string, unknown>) };
  delete rest.attributes;
  return { ...(rest as unknown as ObjectType), description, type, relationship_description, primary_key, properties };
}

// ---------------------------------------------------------------------------
// Rules.
// ---------------------------------------------------------------------------

function specObjectId(id: string): string {
  const bare = id.replace(/^objectType:/, '');
  const w = bare.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return w.map((x) => x[0]!.toUpperCase() + x.slice(1)).join('_') || bare;
}

function ruleNeedsMigration(r: Rule): boolean {
  return (
    !r.businessLogicRuleName || !r.executor || !r.enforcementLevel || !r.failurePolicy || !Array.isArray(r.relatedEntities)
  );
}

const KIND_ZH: Record<string, string> = {
  validation: '数据校验', constraint: '业务约束', derivation: '指标推导',
  state_transition: '状态流转', authorization: '权限授权', temporal: '时限控制',
};

function normalizeRule(r: Rule, nameZhById: Map<string, string>, ruleActorKinds: Map<string, Set<string>>): Rule {
  if (!ruleNeedsMigration(r)) return r;
  const severity = r.severity ?? 'warn';
  const kinds = ruleActorKinds.get(r.id);
  const relatedEntities =
    Array.isArray(r.relatedEntities) && r.relatedEntities.length > 0
      ? r.relatedEntities
      : (r.appliesToObjectTypeIds ?? [])
          .filter((id) => nameZhById.has(id))
          .map((id) => `${nameZhById.get(id)} (${specObjectId(id)})`);
  return {
    ...r,
    specificScenarioStage: cjkOr(r.specificScenarioStage || r.trigger?.description, KIND_ZH[r.kind] || '业务约束'),
    businessLogicRuleName: r.businessLogicRuleName || r.titleZh || r.title || r.id.replace(/^rule:/, ''),
    applicableClient: r.applicableClient || '通用',
    applicableDepartment: r.applicableDepartment || 'N/A',
    submissionCriteria: cjkOr(r.submissionCriteria || r.trigger?.description, cjkOr(r.expression?.predicate, '')),
    standardizedLogicRule: r.standardizedLogicRule || r.statement?.zh?.trim() || r.statement?.en?.trim() || r.formal?.trim() || '',
    relatedEntities,
    businessBackgroundReason: r.businessBackgroundReason || '',
    ruleSource: r.ruleSource || r.sources?.[0]?.documentName?.trim() || '文档',
    executor: r.executor || (kinds && kinds.has('human') ? 'Human' : 'Agent'),
    enforcementLevel: r.enforcementLevel || (severity === 'block' ? 'mandatory' : 'optional'),
    failurePolicy: r.failurePolicy || (severity === 'block' ? 'block' : 'warn'),
  };
}

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

function eventSpecName(id: string): string {
  return (id || '').replace(/^event:/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}
function specPropType(t: string | undefined): PropertyType {
  // already spec? pass through; else map a legacy DataType.
  if (t === 'String' || t === 'Integer' || t === 'Float' || t === 'Boolean' || t === 'Date' || t === 'Timestamp' || t === 'List<String>') return t;
  return dataTypeToPropertyType(t as DataType);
}
function capActor(kind: string | undefined): SpecActor {
  if (kind === 'human') return 'Human';
  if (kind === 'system') return 'System';
  return 'Agent';
}

function actionNeedsMigration(a: ActionType): boolean {
  return a.object_type !== 'action' || !Array.isArray(a.actor) || !Array.isArray(a.action_steps);
}

function normalizeAction(a: ActionType, objById: Map<string, ObjectType>): ActionType {
  if (!actionNeedsMigration(a)) return a;
  // Legacy stored actions carry `actor` as an ActorRef object; lift it to actorRef.
  const legacyActor = a.actorRef ?? (a as unknown as { actor?: { role?: string; kind?: string } }).actor;
  const actorRef = legacyActor && !Array.isArray(legacyActor) ? legacyActor : { role: '', kind: 'agent' as const };
  const pk = (oid: string): string => objById.get(oid)?.primary_key || `${specObjectId(oid).toLowerCase()}_id`;

  const inputs = (a.inputs ?? []).map((io) => {
    const next = { ...io, type: io.objectTypeId ? 'String' : specPropType(io.type) };
    if (io.objectTypeId && objById.has(io.objectTypeId)) next.source_object = `${specObjectId(io.objectTypeId)}.${pk(io.objectTypeId)}`;
    return next;
  });
  const outputs = (a.outputs ?? []).map((io) => ({ ...io, type: io.objectTypeId ? 'String' : specPropType(io.type) }));

  const targets: string[] = [];
  const addT = (oid: string | undefined): void => { if (oid && objById.has(oid)) targets.push(specObjectId(oid)); };
  for (const io of a.inputs ?? []) addT(io.objectTypeId);
  for (const io of a.outputs ?? []) addT(io.objectTypeId);
  for (const s of a.steps ?? []) { (s.readsObjectTypeIds ?? []).forEach(addT); (s.writesObjectTypeIds ?? []).forEach(addT); }

  const next = { ...a } as unknown as Record<string, unknown>;
  delete next.actor;
  const actorZh = actorRef.kind === 'human' ? '人工操作员' : actorRef.kind === 'system' ? '系统' : '智能体';
  const description = a.descriptionZh?.trim() || a.description || '';
  return {
    ...(next as unknown as ActionType),
    inputs,
    outputs,
    actorRef,
    description,
    submission_criteria:
      a.submission_criteria ??
      (a.triggeredByEventIds ?? []).map((eid, i) => `${i + 1}. 事件 ${eventSpecName(eid)} 已送达`).join('\n'),
    object_type: 'action',
    category: a.category ?? a.nameZh ?? a.name,
    actor: Array.isArray(a.actor) ? a.actor : [capActor(actorRef.kind)],
    trigger: a.trigger ?? Array.from(new Set((a.triggeredByEventIds ?? []).map(eventSpecName))),
    target_objects: a.target_objects ?? Array.from(new Set(targets)),
    action_steps:
      a.action_steps ??
      (a.steps ?? []).map((s) => ({
        order: String(s.order),
        name: `step${s.order}`,
        description: s.text?.zh?.trim() || s.text?.en?.trim() || '',
        object_type: 'logic',
        submission_criteria: '',
      })),
    system_prompt: a.system_prompt ?? `作为负责「${a.name}」动作的自动化${actorZh}，${description} 请从本体读取所需对象，校验所有前置条件，并按顺序执行各步骤。`,
    user_prompt: a.user_prompt ?? `执行「${a.name}」。${description} 产出相应记录并发出相应事件。`,
    tool_use: a.tool_use ?? (a.agent?.integration ? [a.agent.integration] : []),
    side_effects: a.side_effects ?? { data_changes: [], notifications: [] },
    triggered_event: a.triggered_event ?? Array.from(new Set((a.emitsEvents ?? []).map((e) => eventSpecName(e.eventTypeId)))),
  };
}

// ---------------------------------------------------------------------------
// Events.
// ---------------------------------------------------------------------------

function camelName(s: string): string {
  const w = (s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return w.length ? w[0]!.toLowerCase() + w.slice(1).map((x) => x[0]!.toUpperCase() + x.slice(1)).join('') : s;
}

function eventNeedsMigration(e: EventType): boolean {
  return !Array.isArray(e.payloadFields) || Array.isArray((e as unknown as { payload?: unknown }).payload) || !e.payload || typeof e.payload !== 'object';
}

function normalizeEvent(e: EventType, objById: Map<string, ObjectType>, actionById: Map<string, ActionType>): EventType {
  if (!eventNeedsMigration(e)) return e;
  const legacyPayload = (e as unknown as { payload?: unknown }).payload;
  const payloadFields: EventField[] = Array.isArray(e.payloadFields)
    ? e.payloadFields
    : Array.isArray(legacyPayload)
      ? (legacyPayload as EventField[])
      : [];
  const name = /[a-z.]/.test(e.name || '') ? eventSpecName(e.name || e.id) : e.name;

  const sourceId = (e.producedByActionIds ?? []).find((aid: string) => actionById.has(aid));
  const event_data = payloadFields.map((f) => ({
    name: f.name,
    type: specPropType(f.type),
    target_object: f.objectTypeId && objById.has(f.objectTypeId) ? specObjectId(f.objectTypeId) : null,
  }));
  const targets: string[] = [];
  for (const aid of e.producedByActionIds ?? []) {
    const a = actionById.get(aid);
    for (const se of a?.sideEffects ?? []) {
      if ((se.kind === 'db_write' || se.kind === 'state_change' || se.kind === 'payment') && se.objectTypeId && objById.has(se.objectTypeId)) {
        targets.push(specObjectId(se.objectTypeId));
      }
    }
  }
  if (targets.length === 0) for (const f of payloadFields) if (f.objectTypeId && objById.has(f.objectTypeId)) targets.push(specObjectId(f.objectTypeId));

  return {
    ...e,
    name,
    payload: {
      source_action: sourceId ? camelName(actionById.get(sourceId)!.name) : '',
      event_data,
      state_mutations: Array.from(new Set(targets)).map((t) => ({ target_object: t, mutation_type: 'CREATE_OR_MODIFY', impacted_properties: [] })),
    },
    payloadFields,
  };
}

// ---------------------------------------------------------------------------
// Processes (workflows).
// ---------------------------------------------------------------------------

function processNeedsMigration(p: Process): boolean {
  return !Array.isArray(p.actor) || !Array.isArray(p.actions) || !Array.isArray(p.trigger);
}

function normalizeProcess(p: Process, actionById: Map<string, ActionType>): Process {
  if (!processNeedsMigration(p)) return p;
  const wfType = (a: ActionType | undefined): 'manual' | 'tool' | 'logic' => {
    if (!a) return 'logic';
    if (a.actorRef?.kind === 'human') return 'manual';
    const ext = !!a.agent?.integration || (a.sideEffects ?? []).some((se) => se.kind === 'external_call');
    return ext ? 'tool' : 'logic';
  };
  const actors = Array.from(new Set((p.actors ?? []).map((a) => capActor(a.kind))));
  return {
    ...p,
    description: cjkOr(p.description, p.name?.zh?.trim() || p.description || ''),
    actor: Array.isArray(p.actor) ? p.actor : actors.length ? actors : [p.orchestration?.agentOrchestrated ? 'Agent' : 'Human'],
    trigger:
      p.trigger ??
      Array.from(new Set((p.triggers ?? []).flatMap((t) => (t.kind === 'event' && t.eventTypeId ? [eventSpecName(t.eventTypeId)] : t.kind === 'schedule' ? ['SCHEDULED_SYNC'] : [])))),
    actions:
      p.actions ??
      (p.steps ?? []).map((s) => {
        const a = actionById.get(s.actionTypeId);
        const edge = s.next?.[0];
        return {
          order: String(s.order),
          name: a ? camelName(a.name) : s.actionTypeId.replace(/^action:/, ''),
          description: a?.descriptionZh?.trim() || a?.description?.trim() || '',
          type: wfType(a),
          condition: edge?.condition?.trim() || edge?.label?.en?.trim() || '',
        };
      }),
    triggered_event:
      p.triggered_event ??
      Array.from(new Set((p.steps ?? []).flatMap((s) => {
        const a = actionById.get(s.actionTypeId);
        return a ? (a.emitsEvents ?? []).map((e) => eventSpecName(e.eventTypeId)) : [];
      }))),
  };
}

// ---------------------------------------------------------------------------
// Public entry.
// ---------------------------------------------------------------------------

/** Idempotently normalize an ontology's objects + rules to the spec-aligned shape. */
export function normalizeOntologyObjects(o: Ontology): Ontology {
  if (!o) return o;
  const objs = Array.isArray(o.objects) ? o.objects : [];
  const needsObjects = objs.some(
    (x) =>
      !Array.isArray(x.properties) ||
      x.type === undefined ||
      !x.primary_key ||
      !hasCJK(x.relationship_description) ||
      (!!x.descriptionZh?.trim() && x.description !== x.descriptionZh.trim()),
  );
  const needsRules = Array.isArray(o.rules) && o.rules.some(ruleNeedsMigration);
  const needsActions = Array.isArray(o.actions) && o.actions.some(actionNeedsMigration);
  const needsEvents = Array.isArray(o.events) && o.events.some(eventNeedsMigration);
  const needsProcesses = Array.isArray(o.processes) && o.processes.some(processNeedsMigration);
  if (!needsObjects && !needsRules && !needsActions && !needsEvents && !needsProcesses) return o;

  const rels = o.relationships ?? [];
  const nameZhById = new Map(objs.map((x) => [x.id, x.nameZh?.trim() || x.name] as const));
  const idSet = new Set(objs.map((x) => x.id));
  const objById = new Map(objs.map((x) => [x.id, x] as const));
  const actionById = new Map((o.actions ?? []).map((a) => [a.id, a] as const));
  const next: Ontology = { ...o };
  if (needsObjects) next.objects = objs.map((obj) => normalizeObject(obj, rels, nameZhById, idSet));
  if (needsActions) next.actions = (o.actions ?? []).map((a) => normalizeAction(a, objById));
  if (needsEvents) next.events = (o.events ?? []).map((e) => normalizeEvent(e, objById, actionById));
  if (needsRules) {
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
    next.rules = (o.rules ?? []).map((r) => normalizeRule(r, nameZhById, ruleActorKinds));
  }
  if (needsProcesses) next.processes = (o.processes ?? []).map((p) => normalizeProcess(p, actionById));
  return next;
}
