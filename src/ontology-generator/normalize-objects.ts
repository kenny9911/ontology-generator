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
  DataType,
  ObjectProperty,
  ObjectType,
  Ontology,
  PropertyType,
  Relationship,
  Rule,
  SourceRef,
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
  if (!needsObjects && !needsRules) return o;

  const rels = o.relationships ?? [];
  const nameById = new Map(objs.map((x) => [x.id, x.name] as const));
  const idSet = new Set(objs.map((x) => x.id));
  const next: Ontology = { ...o };
  if (needsObjects) next.objects = objs.map((obj) => normalizeObject(obj, rels, nameById, idSet));
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
        if (a.actor?.kind) set.add(a.actor.kind);
      }
    }
    next.rules = (o.rules ?? []).map((r) => normalizeRule(r, nameById, ruleActorKinds));
  }
  return next;
}
