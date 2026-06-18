// ============================================================================
//  clean.ts — the editor's clean ⇄ internal seam.
//
//  The JSON editor DISPLAYS the clean sample-shaped JSON (exactly the sample
//  fields + the four receipts confidence/provenance/reviewState/sources, with
//  object id = English key and object name = Chinese), while the stored Ontology
//  keeps its full internal structure (so inference / generators / graph keep
//  working). This module projects internal → clean (`toCleanNodes`, for display)
//  and merges clean edits back onto the original internal nodes
//  (`fromCleanNodes`, for save), preserving every structural field the clean
//  view does not surface.
//
//  Schema imports are TYPE-ONLY (`@/` alias, erased at runtime) so this module is
//  alias-free at runtime and the tsx test can import it directly.
// ============================================================================

import type { ActionType, EventType, ObjectType, Ontology, Process, Rule } from '@/ontology/schema/types';
import type { EditorLayer } from './layers';

// ---------------------------------------------------------------------------
// Small pure helpers (id/name transforms shared with the backend projector).
// ---------------------------------------------------------------------------

function toWords(s: string): string[] {
  return (s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
}
function stripPrefix(id: string): string {
  const i = (id || '').indexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}
/** "objectType:credit-assessment" -> "Credit_Assessment". */
export function specObjectId(id: string): string {
  const w = toWords(stripPrefix(id));
  return w.map((x) => x[0]!.toUpperCase() + x.slice(1)).join('_') || stripPrefix(id);
}
/** "event:order.fulfilled" -> "ORDER_FULFILLED". */
function eventSpecName(name: string): string {
  return stripPrefix(name).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}
function camelName(s: string): string {
  const w = toWords(s);
  return w.length ? w[0]!.toLowerCase() + w.slice(1).map((x) => x[0]!.toUpperCase() + x.slice(1)).join('') : s;
}
const RECEIPT_KEYS = ['confidence', 'provenance', 'reviewState', 'sources'] as const;
function receipts(n: Record<string, unknown>): Record<string, unknown> {
  return {
    confidence: typeof n.confidence === 'number' ? n.confidence : 0,
    provenance: typeof n.provenance === 'string' ? n.provenance : 'extracted',
    reviewState: typeof n.reviewState === 'string' ? n.reviewState : 'pending',
    sources: Array.isArray(n.sources) ? n.sources : [],
  };
}
const pick = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
};

// ===========================================================================
// internal -> clean (for DISPLAY).
// ===========================================================================

function cleanObject(o: ObjectType, specIdByInternal: Map<string, string>): Record<string, unknown> {
  return {
    ...receipts(o as unknown as Record<string, unknown>),
    id: specObjectId(o.id),
    name: o.nameZh?.trim() || o.name,
    description: o.descriptionZh?.trim() || o.description || '',
    type: o.type ?? 'data',
    relationship_description: o.relationship_description ?? '',
    primary_key: o.primary_key ?? '',
    properties: (o.properties ?? []).map((p) => {
      const out: Record<string, unknown> = { name: p.name, type: p.type, description: p.descriptionZh?.trim() || p.description || '' };
      if (p.is_foreign_key && p.references) {
        out.is_foreign_key = true;
        out.references = specIdByInternal.get(p.references) ?? specObjectId(p.references);
      }
      return out;
    }),
  };
}

const RULE_FIELDS = [
  'specificScenarioStage', 'businessLogicRuleName', 'applicableClient', 'applicableDepartment',
  'submissionCriteria', 'standardizedLogicRule', 'relatedEntities', 'businessBackgroundReason',
  'ruleSource', 'executor', 'enforcementLevel', 'failurePolicy',
];
function cleanRule(r: Rule): Record<string, unknown> {
  return { ...receipts(r as unknown as Record<string, unknown>), id: stripPrefix(r.id), ...pick(r as unknown as Record<string, unknown>, RULE_FIELDS) };
}

const ACTION_FIELDS = [
  'submission_criteria', 'object_type', 'category', 'actor', 'trigger', 'target_objects',
  'action_steps', 'system_prompt', 'user_prompt', 'typescript_code', 'tool_use', 'side_effects', 'triggered_event',
];
const cleanIO = (io: Record<string, unknown>): Record<string, unknown> =>
  pick(io, ['name', 'type', 'description', 'source_object', 'required']);
function cleanAction(a: ActionType): Record<string, unknown> {
  const r = a as unknown as Record<string, unknown>;
  return {
    ...receipts(r),
    id: stripPrefix(a.id),
    name: a.name,
    description: a.descriptionZh?.trim() || a.description || '',
    ...pick(r, ACTION_FIELDS),
    inputs: (a.inputs ?? []).map((io) => cleanIO(io as unknown as Record<string, unknown>)),
    outputs: (a.outputs ?? []).map((io) => cleanIO(io as unknown as Record<string, unknown>)),
  };
}

function cleanEvent(e: EventType): Record<string, unknown> {
  return {
    ...receipts(e as unknown as Record<string, unknown>),
    name: eventSpecName(e.name || e.id),
    description: e.descriptionZh?.trim() || e.description || '',
    payload: e.payload ?? { source_action: '', event_data: [], state_mutations: [] },
  };
}

const WF_FIELDS = ['actor', 'trigger', 'actions', 'triggered_event'];
function cleanWorkflow(p: Process): Record<string, unknown> {
  return {
    ...receipts(p as unknown as Record<string, unknown>),
    id: stripPrefix(p.id),
    name: camelName(p.name?.en || '') || stripPrefix(p.id),
    description: p.description || p.name?.zh || '',
    ...pick(p as unknown as Record<string, unknown>, WF_FIELDS),
  };
}

/** Project a layer's internal nodes to the clean sample-shaped nodes. */
export function toCleanNodes(layer: EditorLayer, internal: unknown[], ontology: Ontology): unknown[] {
  const specIdByInternal = new Map((ontology.objects ?? []).map((o) => [o.id, specObjectId(o.id)] as const));
  switch (layer) {
    case 'objects':
      return (internal as ObjectType[]).map((o) => cleanObject(o, specIdByInternal));
    case 'rules':
      return (internal as Rule[]).map(cleanRule);
    case 'actions':
      return (internal as ActionType[]).map(cleanAction);
    case 'events':
      return (internal as EventType[]).map(cleanEvent);
    case 'processes':
      return (internal as Process[]).map(cleanWorkflow);
    default:
      return internal;
  }
}

// ===========================================================================
// clean -> internal (for SAVE) — merge clean edits onto the original node.
// ===========================================================================

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function mergeObject(orig: ObjectType, c: Record<string, unknown>, internalBySpecId: Map<string, string>): ObjectType {
  const properties = Array.isArray(c.properties)
    ? (c.properties as Record<string, unknown>[]).map((cp) => {
        const origProp = (orig.properties ?? []).find((p) => p.name === cp.name);
        const refSpec = str(cp.references);
        const next = {
          ...(origProp ?? {}),
          name: str(cp.name) ?? origProp?.name ?? '',
          type: (str(cp.type) ?? origProp?.type ?? 'String') as ObjectType['properties'][number]['type'],
          description: str(cp.description) ?? origProp?.description ?? '',
        } as ObjectType['properties'][number];
        if (cp.is_foreign_key === true && refSpec) {
          next.is_foreign_key = true;
          next.references = internalBySpecId.get(refSpec) ?? refSpec;
        } else {
          delete (next as unknown as Record<string, unknown>).is_foreign_key;
          delete (next as unknown as Record<string, unknown>).references;
        }
        return next;
      })
    : orig.properties;
  const name = str(c.name);
  return {
    ...orig,
    ...receipts(c) as Partial<ObjectType>,
    nameZh: name ?? orig.nameZh,
    description: str(c.description) ?? orig.description,
    descriptionZh: str(c.description) ?? orig.descriptionZh,
    type: (c.type as ObjectType['type']) ?? orig.type,
    relationship_description: str(c.relationship_description) ?? orig.relationship_description,
    primary_key: str(c.primary_key) ?? orig.primary_key,
    properties,
  };
}

const applyFields = (orig: Record<string, unknown>, c: Record<string, unknown>, fields: string[]): Record<string, unknown> => {
  const out = { ...orig, ...receipts(c) };
  for (const f of fields) if (c[f] !== undefined) out[f] = c[f];
  return out;
};

/** Merge edited clean nodes back onto the original internal layer (preserves
 *  every structural field the clean view does not carry). Matches by clean id. */
export function fromCleanNodes(layer: EditorLayer, clean: unknown[], ontology: Ontology): unknown[] {
  const cleanArr = clean.filter((n): n is Record<string, unknown> => typeof n === 'object' && n !== null);
  const internal = ((ontology as unknown as Record<string, unknown>)[layer] as unknown[]) ?? [];

  if (layer === 'objects') {
    const internalBySpecId = new Map((ontology.objects ?? []).map((o) => [specObjectId(o.id), o.id] as const));
    const origById = new Map((internal as ObjectType[]).map((o) => [specObjectId(o.id), o] as const));
    return cleanArr.map((c) => {
      const orig = origById.get(str(c.id) ?? '');
      return orig ? mergeObject(orig, c, internalBySpecId) : c;
    });
  }
  if (layer === 'events') {
    const origByName = new Map((internal as EventType[]).map((e) => [eventSpecName(e.name || e.id), e] as const));
    return cleanArr.map((c) => {
      const orig = origByName.get(str(c.name) ?? '');
      return orig ? { ...orig, ...receipts(c), description: str(c.description) ?? orig.description, descriptionZh: str(c.description) ?? orig.descriptionZh, payload: c.payload ?? orig.payload } : c;
    });
  }
  // rules / actions / processes: match by stripped id, apply the clean fields.
  const fields = layer === 'rules' ? RULE_FIELDS : layer === 'actions' ? [...ACTION_FIELDS, 'inputs', 'outputs', 'name', 'description'] : [...WF_FIELDS];
  const origById = new Map((internal as { id: string }[]).map((n) => [stripPrefix(n.id), n] as const));
  return cleanArr.map((c) => {
    const orig = origById.get(str(c.id) ?? '');
    if (!orig) return c;
    const merged = applyFields(orig as unknown as Record<string, unknown>, c, fields);
    // actions: don't clobber the structural objectTypeId on IO; re-merge by name.
    if (layer === 'actions') {
      const o = orig as unknown as ActionType;
      const mergeIO = (cleanList: unknown, origList: ActionType['inputs']): unknown =>
        Array.isArray(cleanList)
          ? (cleanList as Record<string, unknown>[]).map((ci) => {
              const oi = (origList ?? []).find((x) => x.name === ci.name);
              return { ...(oi ?? {}), ...ci };
            })
          : origList;
      merged.inputs = mergeIO(c.inputs, o.inputs);
      merged.outputs = mergeIO(c.outputs, o.outputs);
      // the clean `description` is Chinese-first (reads descriptionZh) — write the
      // edit to descriptionZh too so it survives the round-trip (cf. mergeObject).
      merged.descriptionZh = str(c.description) ?? o.descriptionZh;
    }
    if (layer === 'processes') merged.description = str(c.description) ?? (orig as unknown as Process).description;
    return merged;
  });
}

export { RECEIPT_KEYS };
