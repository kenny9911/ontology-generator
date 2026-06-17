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

function synthRelationshipDesc(
  o: ObjectType,
  rels: Relationship[],
  nameById: Map<string, string>,
  props: ObjectProperty[],
): string {
  const parts: string[] = [];
  for (const r of rels) {
    const verb = (r.name || '').replace(/_/g, ' ');
    if (r.sourceObjectTypeId === o.id && nameById.has(r.targetObjectTypeId)) {
      parts.push(`${o.name} ${verb} ${nameById.get(r.targetObjectTypeId)}.`);
    } else if (r.targetObjectTypeId === o.id && nameById.has(r.sourceObjectTypeId)) {
      parts.push(`${nameById.get(r.sourceObjectTypeId)} ${verb} ${o.name}.`);
    }
  }
  for (const p of props) {
    if (p.is_foreign_key && p.references && nameById.has(p.references)) {
      parts.push(`${o.name}.${p.name} references ${nameById.get(p.references)}.`);
    }
  }
  const uniq = [...new Set(parts)];
  return uniq.length ? uniq.join(' ') : `${o.name} has no documented relationships to other objects.`;
}

function normalizeObject(
  o: ObjectType,
  rels: Relationship[],
  nameById: Map<string, string>,
  idSet: Set<string>,
): ObjectType {
  const hasProps = Array.isArray(o.properties);
  if (hasProps && o.type && o.primary_key && o.relationship_description) return o; // fully migrated

  const legacy = (o as unknown as { attributes?: LegacyAttr[] }).attributes ?? [];
  const properties: ObjectProperty[] =
    hasProps && o.properties.length > 0 ? o.properties : legacy.map((a) => legacyAttrToProperty(a, idSet));
  const pkAttr = legacy.find((a) => a.keyRole === 'pk');
  const primary_key = o.primary_key || (pkAttr ? pkAttr.name : `${idSlug(o.id)}_id`);
  const type = o.type ?? (SYSTEM_RE.test(`${o.id} ${o.name} ${o.nameZh ?? ''}`) ? 'system' : 'data');
  const relationship_description = o.relationship_description || synthRelationshipDesc(o, rels, nameById, properties);

  const rest = { ...(o as unknown as Record<string, unknown>) };
  delete rest.attributes;
  return { ...(rest as unknown as ObjectType), type, relationship_description, primary_key, properties };
}

// ---------------------------------------------------------------------------
// Rules.
// ---------------------------------------------------------------------------

function specObjectId(id: string): string {
  const bare = id.replace(/^objectType:/, '');
  const w = bare.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return w.map((x) => x[0]!.toUpperCase() + x.slice(1)).join('_') || bare;
}
function titleizeKind(kind: string | undefined): string {
  return (kind || 'constraint').split('_').map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
}

function ruleNeedsMigration(r: Rule): boolean {
  return (
    !r.businessLogicRuleName || !r.executor || !r.enforcementLevel || !r.failurePolicy || !Array.isArray(r.relatedEntities)
  );
}

function normalizeRule(r: Rule, nameById: Map<string, string>, ruleActorKinds: Map<string, Set<string>>): Rule {
  if (!ruleNeedsMigration(r)) return r;
  const severity = r.severity ?? 'warn';
  const kinds = ruleActorKinds.get(r.id);
  const relatedEntities =
    Array.isArray(r.relatedEntities) && r.relatedEntities.length > 0
      ? r.relatedEntities
      : (r.appliesToObjectTypeIds ?? [])
          .filter((id) => nameById.has(id))
          .map((id) => `${nameById.get(id)} (${specObjectId(id)})`);
  return {
    ...r,
    specificScenarioStage: r.specificScenarioStage || r.trigger?.description?.trim() || titleizeKind(r.kind),
    businessLogicRuleName: r.businessLogicRuleName || r.title || r.id.replace(/^rule:/, ''),
    applicableClient: r.applicableClient || '通用',
    applicableDepartment: r.applicableDepartment || 'N/A',
    submissionCriteria: r.submissionCriteria || r.trigger?.description?.trim() || r.expression?.predicate?.trim() || '',
    standardizedLogicRule: r.standardizedLogicRule || r.statement?.en?.trim() || r.formal?.trim() || r.statement?.zh?.trim() || '',
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
  return {
    ...(next as unknown as ActionType),
    inputs,
    outputs,
    actorRef,
    submission_criteria: a.submission_criteria ?? '',
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
        description: s.text?.en?.trim() || s.text?.zh?.trim() || '',
        object_type: 'logic',
        submission_criteria: '',
      })),
    system_prompt: a.system_prompt ?? '',
    user_prompt: a.user_prompt ?? '',
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
// Public entry.
// ---------------------------------------------------------------------------

/** Idempotently normalize an ontology's objects + rules to the spec-aligned shape. */
export function normalizeOntologyObjects(o: Ontology): Ontology {
  if (!o) return o;
  const objs = Array.isArray(o.objects) ? o.objects : [];
  const needsObjects = objs.some(
    (x) => !Array.isArray(x.properties) || x.type === undefined || !x.primary_key || !x.relationship_description,
  );
  const needsRules = Array.isArray(o.rules) && o.rules.some(ruleNeedsMigration);
  const needsActions = Array.isArray(o.actions) && o.actions.some(actionNeedsMigration);
  const needsEvents = Array.isArray(o.events) && o.events.some(eventNeedsMigration);
  if (!needsObjects && !needsRules && !needsActions && !needsEvents) return o;

  const rels = o.relationships ?? [];
  const nameById = new Map(objs.map((x) => [x.id, x.name] as const));
  const idSet = new Set(objs.map((x) => x.id));
  const objById = new Map(objs.map((x) => [x.id, x] as const));
  const actionById = new Map((o.actions ?? []).map((a) => [a.id, a] as const));
  const next: Ontology = { ...o };
  if (needsObjects) next.objects = objs.map((obj) => normalizeObject(obj, rels, nameById, idSet));
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
    next.rules = (o.rules ?? []).map((r) => normalizeRule(r, nameById, ruleActorKinds));
  }
  return next;
}
