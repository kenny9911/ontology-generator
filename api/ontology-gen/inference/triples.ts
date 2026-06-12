// ============================================================================
//  INFERENCE — deterministic Ontology → Triple projection (design §3.1).
//
//  Pure and deterministic: the ONLY import is the schema mirror — no LLM, no
//  I/O, no randomness. Every predicate except the Relationship verb-names
//  comes from the CLOSED vocabulary in `PREDICATES`; relationship edges use
//  the relationship's own snake_case verb (e.g. 'places', 'contains').
//
//  Object attributes are projected as pseudo-nodes with the stable id
//  '<objectType.id>.<attr.name>' (labelled '<ObjectName>.<attr.name>'), so a
//  graph walk can hop object → attribute → referenced object.
// ============================================================================

import type {
  ActionType,
  EventType,
  ObjectType,
  Ontology,
  Process,
  Relationship,
  Rule,
  Triple,
} from '../../_shared/ontology-schema.js';

/**
 * The closed non-relationship predicate vocabulary. Relationship triples are
 * the single open slot: their predicate is `Relationship.name`.
 */
export const PREDICATES: readonly string[] = [
  // every node
  'kind',
  'label',
  // object attributes
  'has_attribute',
  'has_type',
  'references',
  // relationships (the verb edge itself is open-vocabulary)
  'cardinality',
  // rules
  'applies_to',
  'severity',
  'rule_kind',
  // shared by rules / actions / processes
  'triggered_by',
  // actions
  'consumes',
  'produces',
  'guarded_by',
  'emits',
  'performed_by',
  'calls',
  // events
  'produced_by',
  'consumed_by',
  // processes
  'has_step',
  'precedes',
  'involves',
] as const;

/** A literal-valued triple (object is a value, not a node id). */
function lit(s: string, p: string, o: string): Triple {
  return { s, p, o, literal: true };
}

/** A node-referencing triple (object is another node / pseudo-node id). */
function ref(s: string, p: string, o: string): Triple {
  return { s, p, o };
}

/** Pseudo-node id for one object attribute: '<objectType.id>.<attr.name>'. */
function attrId(obj: ObjectType, attrName: string): string {
  return `${obj.id}.${attrName}`;
}

/** Display label for a rule: title, else the first clause of statement.en. */
function ruleLabel(rule: Rule): string {
  if (rule.title.trim()) return rule.title.trim();
  const first = rule.statement.en.split(/[.;:,]/)[0].trim();
  return first || rule.id;
}

function projectObject(obj: ObjectType, out: Triple[]): void {
  out.push(lit(obj.id, 'kind', 'object'));
  out.push(lit(obj.id, 'label', obj.name));
  for (const attr of obj.attributes) {
    const aId = attrId(obj, attr.name);
    out.push(ref(obj.id, 'has_attribute', aId));
    out.push(lit(aId, 'has_type', attr.type));
    if ((attr.keyRole === 'fk' || attr.type === 'reference') && attr.refObjectTypeId) {
      out.push(ref(aId, 'references', attr.refObjectTypeId));
    }
  }
}

function projectRelationship(rel: Relationship, out: Triple[]): void {
  out.push(lit(rel.id, 'kind', 'relationship'));
  out.push(lit(rel.id, 'label', rel.name));
  out.push(ref(rel.sourceObjectTypeId, rel.name, rel.targetObjectTypeId));
  out.push(lit(rel.id, 'cardinality', rel.cardinality));
}

function projectRule(rule: Rule, out: Triple[]): void {
  out.push(lit(rule.id, 'kind', 'rule'));
  out.push(lit(rule.id, 'label', ruleLabel(rule)));
  for (const objId of rule.appliesToObjectTypeIds) out.push(ref(rule.id, 'applies_to', objId));
  out.push(lit(rule.id, 'severity', rule.severity));
  out.push(lit(rule.id, 'rule_kind', rule.kind));
  if (rule.trigger?.onEventTypeId) out.push(ref(rule.id, 'triggered_by', rule.trigger.onEventTypeId));
}

function projectAction(action: ActionType, out: Triple[]): void {
  out.push(lit(action.id, 'kind', 'action'));
  out.push(lit(action.id, 'label', action.name));
  for (const io of action.inputs) {
    if (io.objectTypeId) out.push(ref(action.id, 'consumes', io.objectTypeId));
  }
  for (const io of action.outputs) {
    if (io.objectTypeId) out.push(ref(action.id, 'produces', io.objectTypeId));
  }
  for (const pre of action.preconditions) out.push(ref(action.id, 'guarded_by', pre.ruleId));
  for (const emit of action.emitsEvents) out.push(ref(action.id, 'emits', emit.eventTypeId));
  for (const evId of action.triggeredByEventIds) out.push(ref(action.id, 'triggered_by', evId));
  if (action.actor.role.trim()) out.push(lit(action.id, 'performed_by', action.actor.role));
  for (const step of action.steps) {
    if (step.callsActionTypeId) out.push(ref(action.id, 'calls', step.callsActionTypeId));
  }
}

function projectEvent(event: EventType, out: Triple[]): void {
  out.push(lit(event.id, 'kind', 'event'));
  out.push(lit(event.id, 'label', event.name));
  for (const actionId of event.producedByActionIds) out.push(ref(event.id, 'produced_by', actionId));
  for (const actionId of event.consumedByActionIds) out.push(ref(event.id, 'consumed_by', actionId));
}

function projectProcess(proc: Process, out: Triple[]): void {
  out.push(lit(proc.id, 'kind', 'process'));
  out.push(lit(proc.id, 'label', proc.name.en));
  for (const step of proc.steps) out.push(ref(proc.id, 'has_step', step.actionTypeId));
  // precedes — resolve process-local step ids; skip dangling edges.
  const stepById = new Map(proc.steps.map((s) => [s.id, s]));
  for (const step of proc.steps) {
    for (const edge of step.next) {
      const to = stepById.get(edge.toStepId);
      if (to) out.push(ref(step.actionTypeId, 'precedes', to.actionTypeId));
    }
  }
  for (const trig of proc.triggers) {
    if (trig.eventTypeId) out.push(ref(proc.id, 'triggered_by', trig.eventTypeId));
  }
  for (const objId of proc.objectTypeIds) out.push(ref(proc.id, 'involves', objId));
}

/**
 * Project the full ontology into a flat triple list per the §3.1 table.
 * Identical (s, p, o) triples are de-duplicated (e.g. a process visiting the
 * same action in two steps yields one `has_step`).
 */
export function ontologyToTriples(o: Ontology): Triple[] {
  const raw: Triple[] = [];
  for (const obj of o.objects) projectObject(obj, raw);
  for (const rel of o.relationships) projectRelationship(rel, raw);
  for (const rule of o.rules) projectRule(rule, raw);
  for (const action of o.actions) projectAction(action, raw);
  for (const event of o.events) projectEvent(event, raw);
  for (const proc of o.processes) projectProcess(proc, raw);

  const seen = new Set<string>();
  const out: Triple[] = [];
  for (const t of raw) {
    const key = `${t.s}\u0001${t.p}\u0001${t.o}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * id → display label for every node AND attribute pseudo-id. Used by the
 * engine to render readable triple lines for the reasoning agent.
 */
export function tripleLabelMap(o: Ontology): Record<string, string> {
  const map: Record<string, string> = {};
  for (const obj of o.objects) {
    map[obj.id] = obj.name;
    for (const attr of obj.attributes) map[attrId(obj, attr.name)] = `${obj.name}.${attr.name}`;
  }
  for (const rel of o.relationships) map[rel.id] = rel.name;
  for (const rule of o.rules) map[rule.id] = ruleLabel(rule);
  for (const action of o.actions) map[action.id] = action.name;
  for (const event of o.events) map[event.id] = event.name;
  for (const proc of o.processes) map[proc.id] = proc.name.en;
  return map;
}

/** Count triples by predicate — diagnostics for logs / the smoke test. */
export function tripleStats(triples: Triple[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const t of triples) stats[t.p] = (stats[t.p] ?? 0) + 1;
  return stats;
}
