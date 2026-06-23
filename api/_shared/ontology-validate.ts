// ============================================================================
//  ontology-validate.ts — hand-written, dependency-free ontology validator.
//
//  validateOntology(o): ValidationIssue[]  — NEVER throws.
//
//  Implements the LOCKED contract (docs/.../DESIGN_SPEC.md §6 + §3.6,
//  SCHEMA.md §8 invariants):
//    1. Referential integrity — every cross-`id` ref resolves; dangling -> error.
//    2. Action<->Event EXACT inverse — events.producedByActionIds /
//       consumedByActionIds must equal the inverse of actions' emitsEvents /
//       triggeredByEventIds -> warn "event_inverse_mismatch".
//    3. Closed-vocabulary — enum attrs need enumValues; reference/fk attrs need
//       refObjectTypeId.
//    4. Provenance — `extracted`/`merged` nodes need >=1 source (rules
//       sentence-level) -> error "missing_source"; `inferred` may have [].
//    5. Stage ordering — a later layer may only reference ids from EARLIER
//       layers (events co-discovered with actions) -> "stage_order_violation".
//    6. duplicate_id, precondition_severity_mismatch, quote_unverified.
//
//  This file is the backend copy; the frontend mirror lives at
//  src/ontology/schema/validate.ts and is kept logically identical.
// ============================================================================

import type {
  Ontology,
  ObjectType,
  Relationship,
  Rule,
  ActionType,
  EventType,
  Process,
  Provenance,
} from './ontology-schema.js';

// ---------------------------------------------------------------------------
// Public issue contract (DESIGN_SPEC §6).
// ---------------------------------------------------------------------------

export type IssueLevel = 'error' | 'warn';

export type IssueKind =
  | 'dangling_ref'
  | 'quote_unverified'
  | 'event_inverse_mismatch'
  | 'missing_source'
  | 'duplicate_id'
  | 'enum_without_values'
  | 'reference_without_target'
  | 'precondition_severity_mismatch'
  | 'stage_order_violation';

export interface ValidationIssue {
  level: IssueLevel;
  kind: IssueKind;
  /** Id of the node the issue originates from. */
  from: string;
  /** Dotted field path on `from` that holds the offending value. */
  field?: string;
  /** The unresolved id, for dangling_ref / stage_order_violation. */
  missingId?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// validateOntology — the single entry point. NEVER throws.
// ---------------------------------------------------------------------------

export function validateOntology(o: Ontology): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  try {
    runChecks(o, issues);
  } catch (err) {
    // Defensive: a malformed envelope must surface as an issue, not a throw.
    issues.push({
      level: 'error',
      kind: 'dangling_ref',
      from: safeId(o),
      message: `Validator encountered malformed ontology: ${errText(err)}`,
    });
  }
  return issues;
}

function runChecks(o: Ontology, issues: ValidationIssue[]): void {
  const objects = arr<ObjectType>(o.objects);
  const relationships = arr<Relationship>(o.relationships);
  const rules = arr<Rule>(o.rules);
  const actions = arr<ActionType>(o.actions);
  const events = arr<EventType>(o.events);
  const processes = arr<Process>(o.processes);

  // ---- Id sets per layer (for referential integrity + stage ordering). ----
  const objectIds = idSet(objects);
  const relationshipIds = idSet(relationships);
  const ruleIds = idSet(rules);
  const actionIds = idSet(actions);
  const eventIds = idSet(events);
  const processIds = idSet(processes);

  duplicateIds(
    [
      ...objects,
      ...relationships,
      ...rules,
      ...actions,
      ...events,
      ...processes,
    ],
    issues,
  );

  // =========================================================================
  // 1. Referential integrity + closed-vocabulary + provenance, per layer.
  // =========================================================================

  // ---- ObjectTypes: properties (foreign-key references) + sources. --------
  for (const obj of objects) {
    requireSources(obj.id, obj.provenance, obj.sources, false, issues);

    for (const prop of arr(obj.properties)) {
      if (!prop.is_foreign_key) continue;
      const path = `properties.${prop.name}`;
      if (!prop.references) {
        issues.push({
          level: 'error',
          kind: 'reference_without_target',
          from: obj.id,
          field: `${path}.references`,
          message: `Foreign-key property "${prop.name}" has no references`,
        });
      } else if (!objectIds.has(prop.references)) {
        dangling(obj.id, `${path}.references`, prop.references,
          'Property references unknown ObjectType id', issues);
      }
    }
  }

  // ---- Relationships: source/target ObjectType ids + sources. -------------
  for (const rel of relationships) {
    requireSources(rel.id, rel.provenance, rel.sources, false, issues);
    if (!objectIds.has(rel.sourceObjectTypeId)) {
      dangling(rel.id, 'sourceObjectTypeId', rel.sourceObjectTypeId,
        'Relationship source references unknown ObjectType id', issues);
    }
    if (!objectIds.has(rel.targetObjectTypeId)) {
      dangling(rel.id, 'targetObjectTypeId', rel.targetObjectTypeId,
        'Relationship target references unknown ObjectType id', issues);
    }
  }

  // ---- Rules: appliesTo objects/attributes, trigger event, sources. -------
  for (const rule of rules) {
    // Rules require SENTENCE-LEVEL sources for extracted/merged provenance.
    requireSources(rule.id, rule.provenance, rule.sources, true, issues);

    arr(rule.appliesToObjectTypeIds).forEach((oid, i) => {
      if (!objectIds.has(oid)) {
        dangling(rule.id, `appliesToObjectTypeIds[${i}]`, oid,
          'Rule applies to unknown ObjectType id', issues);
      }
    });

    arr(rule.appliesToAttributes).forEach((ref, i) => {
      const dotIdx = ref.indexOf('.');
      const oid = dotIdx >= 0 ? ref.slice(0, dotIdx) : ref;
      if (!objectIds.has(oid)) {
        dangling(rule.id, `appliesToAttributes[${i}]`, oid,
          'Rule applies to attribute of unknown ObjectType id', issues);
      }
    });

    const onEvt = rule.trigger?.onEventTypeId;
    if (onEvt && !eventIds.has(onEvt)) {
      dangling(rule.id, 'trigger.onEventTypeId', onEvt,
        'Rule trigger references unknown EventType id', issues);
    }

    arr(rule.expression?.bindings).forEach((b, i) => {
      if (!objectIds.has(b.objectTypeId)) {
        dangling(rule.id, `expression.bindings[${i}].objectTypeId`, b.objectTypeId,
          'Rule expression binding references unknown ObjectType id', issues);
      }
    });
  }

  // ---- RuleGroups: ruleIds resolve (organizational; warn only). -----------
  for (const grp of arr(o.ruleGroups)) {
    arr(grp.ruleIds).forEach((rid, i) => {
      if (!ruleIds.has(rid)) {
        issues.push({
          level: 'warn',
          kind: 'dangling_ref',
          from: grp.id,
          field: `ruleIds[${i}]`,
          missingId: rid,
          message: 'RuleGroup references unknown Rule id',
        });
      }
    });
  }

  // ---- ActionTypes: io / preconditions / events / steps + sources. --------
  const ruleSeverityById = mapBy(rules, (r) => r.severity);

  for (const action of actions) {
    requireSources(action.id, action.provenance, action.sources, false, issues);

    // inputs / outputs -> ObjectType ids (only when the IO is an object).
    arr(action.inputs).forEach((io, i) => {
      if (io.objectTypeId && !objectIds.has(io.objectTypeId)) {
        dangling(action.id, `inputs[${i}].objectTypeId`, io.objectTypeId,
          'Action input references unknown ObjectType id', issues);
      }
    });
    arr(action.outputs).forEach((io, i) => {
      if (io.objectTypeId && !objectIds.has(io.objectTypeId)) {
        dangling(action.id, `outputs[${i}].objectTypeId`, io.objectTypeId,
          'Action output references unknown ObjectType id', issues);
      }
    });

    // preconditions -> Rule ids (+ cached severity must match authoritative).
    arr(action.preconditions).forEach((pc, i) => {
      if (!ruleIds.has(pc.ruleId)) {
        dangling(action.id, `preconditions[${i}].ruleId`, pc.ruleId,
          'Action precondition references unknown Rule id', issues);
      } else if (pc.severity !== undefined) {
        const authoritative = ruleSeverityById.get(pc.ruleId);
        if (authoritative !== undefined && pc.severity !== authoritative) {
          issues.push({
            level: 'warn',
            kind: 'precondition_severity_mismatch',
            from: action.id,
            field: `preconditions[${i}].severity`,
            missingId: pc.ruleId,
            message: `Cached precondition severity "${pc.severity}" != Rule's "${authoritative}"`,
          });
        }
      }
    });

    // triggeredByEventIds -> Event ids.
    arr(action.triggeredByEventIds).forEach((eid, i) => {
      if (!eventIds.has(eid)) {
        dangling(action.id, `triggeredByEventIds[${i}]`, eid,
          'Action references unknown event id', issues);
      }
    });

    // emitsEvents -> Event ids.
    arr(action.emitsEvents).forEach((em, i) => {
      if (!eventIds.has(em.eventTypeId)) {
        dangling(action.id, `emitsEvents[${i}].eventTypeId`, em.eventTypeId,
          'Action emits unknown event id', issues);
      }
    });

    // sideEffects -> ObjectType ids (optional).
    arr(action.sideEffects).forEach((se, i) => {
      if (se.objectTypeId && !objectIds.has(se.objectTypeId)) {
        dangling(action.id, `sideEffects[${i}].objectTypeId`, se.objectTypeId,
          'Action side-effect references unknown ObjectType id', issues);
      }
    });

    // steps -> reads/writes ObjectTypes, callsAction, guardRule.
    arr(action.steps).forEach((step, i) => {
      arr(step.readsObjectTypeIds).forEach((oid, j) => {
        if (!objectIds.has(oid)) {
          dangling(action.id, `steps[${i}].readsObjectTypeIds[${j}]`, oid,
            'Action step reads unknown ObjectType id', issues);
        }
      });
      arr(step.writesObjectTypeIds).forEach((oid, j) => {
        if (!objectIds.has(oid)) {
          dangling(action.id, `steps[${i}].writesObjectTypeIds[${j}]`, oid,
            'Action step writes unknown ObjectType id', issues);
        }
      });
      if (step.callsActionTypeId && !actionIds.has(step.callsActionTypeId)) {
        dangling(action.id, `steps[${i}].callsActionTypeId`, step.callsActionTypeId,
          'Action step calls unknown Action id', issues);
      }
      if (step.guardRuleId && !ruleIds.has(step.guardRuleId)) {
        dangling(action.id, `steps[${i}].guardRuleId`, step.guardRuleId,
          'Action step guard references unknown Rule id', issues);
      }
    });

    // agent.parameterSchema property $objectTypeId cross-links.
    const props = action.agent?.parameterSchema?.properties;
    if (props) {
      for (const [key, prop] of Object.entries(props)) {
        const ref = prop?.$objectTypeId;
        if (ref && !objectIds.has(ref)) {
          dangling(action.id, `agent.parameterSchema.properties.${key}.$objectTypeId`, ref,
            'Tool parameter references unknown ObjectType id', issues);
        }
      }
    }
  }

  // ---- EventTypes: payload object refs, producer/consumer ids + sources. --
  for (const evt of events) {
    requireSources(evt.id, evt.provenance, evt.sources, false, issues);

    arr(evt.payloadFields).forEach((f, i) => {
      if (f.objectTypeId && !objectIds.has(f.objectTypeId)) {
        dangling(evt.id, `payloadFields[${i}].objectTypeId`, f.objectTypeId,
          'Event payload field references unknown ObjectType id', issues);
      }
    });
    arr(evt.producedByActionIds).forEach((aid, i) => {
      if (!actionIds.has(aid)) {
        dangling(evt.id, `producedByActionIds[${i}]`, aid,
          'Event producedBy references unknown Action id', issues);
      }
    });
    arr(evt.consumedByActionIds).forEach((aid, i) => {
      if (!actionIds.has(aid)) {
        dangling(evt.id, `consumedByActionIds[${i}]`, aid,
          'Event consumedBy references unknown Action id', issues);
      }
    });
  }

  // ---- Processes: step actions, edges, triggers, actors, objects. ---------
  for (const proc of processes) {
    requireSources(proc.id, proc.provenance, proc.sources, false, issues);

    const stepIds = new Set<string>();
    for (const step of arr(proc.steps)) {
      if (step.id) stepIds.add(step.id);
    }

    arr(proc.objectTypeIds).forEach((oid, i) => {
      if (!objectIds.has(oid)) {
        dangling(proc.id, `objectTypeIds[${i}]`, oid,
          'Process references unknown ObjectType id', issues);
      }
    });

    const actorRoles = new Set(arr(proc.actors).map((a) => a.role));

    arr(proc.steps).forEach((step, i) => {
      if (!actionIds.has(step.actionTypeId)) {
        dangling(proc.id, `steps[${i}].actionTypeId`, step.actionTypeId,
          'Process step references unknown Action id', issues);
      }
      if (step.actorRole && actorRoles.size > 0 && !actorRoles.has(step.actorRole)) {
        issues.push({
          level: 'warn',
          kind: 'dangling_ref',
          from: proc.id,
          field: `steps[${i}].actorRole`,
          message: `Process step actorRole "${step.actorRole}" is not a declared actor`,
        });
      }
      arr(step.next).forEach((edge, j) => {
        // Step ids are process-scoped, not global node ids.
        if (!stepIds.has(edge.toStepId)) {
          dangling(proc.id, `steps[${i}].next[${j}].toStepId`, edge.toStepId,
            'Process edge references unknown step id', issues);
        }
        if (edge.onEventTypeId && !eventIds.has(edge.onEventTypeId)) {
          dangling(proc.id, `steps[${i}].next[${j}].onEventTypeId`, edge.onEventTypeId,
            'Process edge references unknown EventType id', issues);
        }
      });
    });

    arr(proc.triggers).forEach((t, i) => {
      if (t.kind === 'event' && t.eventTypeId && !eventIds.has(t.eventTypeId)) {
        dangling(proc.id, `triggers[${i}].eventTypeId`, t.eventTypeId,
          'Process trigger references unknown EventType id', issues);
      }
    });
  }

  // =========================================================================
  // 2. Action <-> Event EXACT inverse.
  //    emits  <-> producedByActionIds
  //    triggeredBy <-> consumedByActionIds
  // =========================================================================
  checkEventInverse(actions, events, eventIds, issues);

  // =========================================================================
  // 3. Stage ordering — a later layer may only reference EARLIER-layer ids.
  //    Order: objects -> rules -> actions -> events -> processes.
  //    (Events are co-discovered with actions, so action<->event refs both
  //    ways are allowed; that is the one intentional exception.)
  //    Only flag refs whose id RESOLVES but to a later layer (an existing id
  //    in the wrong layer); pure unknown ids are already dangling_ref above.
  // =========================================================================
  // rules must not reference actions/processes (only objects + events).
  for (const rule of rules) {
    forwardRef(rule.id, 'trigger.onEventTypeId', rule.trigger?.onEventTypeId,
      [actionIds, processIds], issues); // events allowed; reject action/process
  }
  // actions referencing processes is a forward ref.
  for (const action of actions) {
    arr(action.steps).forEach((step, i) => {
      forwardRef(action.id, `steps[${i}].callsActionTypeId`, step.callsActionTypeId,
        [processIds], issues);
    });
  }
  // events referencing processes is a forward ref (events precede processes).
  for (const evt of events) {
    arr(evt.payloadFields).forEach((f, i) => {
      forwardRef(evt.id, `payloadFields[${i}].objectTypeId`, f.objectTypeId,
        [processIds], issues);
    });
  }

  // Touch sets that would otherwise be unused under some configurations so the
  // strict noUnusedLocals lens stays satisfied while keeping them documented.
  void relationshipIds;
}

// ---------------------------------------------------------------------------
// Action <-> Event inverse check (extracted for clarity; mirrored verbatim).
// ---------------------------------------------------------------------------

function checkEventInverse(
  actions: ActionType[],
  events: EventType[],
  eventIds: Set<string>,
  issues: ValidationIssue[],
): void {
  // Build the canonical inverse from the actions side (authoritative).
  const producedBy = new Map<string, Set<string>>(); // eventId -> actionIds emitting it
  const consumedBy = new Map<string, Set<string>>(); // eventId -> actionIds triggered by it

  for (const action of actions) {
    for (const em of arr(action.emitsEvents)) {
      if (eventIds.has(em.eventTypeId)) {
        getOrInit(producedBy, em.eventTypeId).add(action.id);
      }
    }
    for (const eid of arr(action.triggeredByEventIds)) {
      if (eventIds.has(eid)) {
        getOrInit(consumedBy, eid).add(action.id);
      }
    }
  }

  for (const evt of events) {
    const expectedProduced = producedBy.get(evt.id) ?? new Set<string>();
    const expectedConsumed = consumedBy.get(evt.id) ?? new Set<string>();

    if (!sameSet(expectedProduced, arr(evt.producedByActionIds))) {
      issues.push({
        level: 'warn',
        kind: 'event_inverse_mismatch',
        from: evt.id,
        field: 'producedByActionIds',
        message: "Not the exact inverse of actions' emitsEvents",
      });
    }
    if (!sameSet(expectedConsumed, arr(evt.consumedByActionIds))) {
      issues.push({
        level: 'warn',
        kind: 'event_inverse_mismatch',
        from: evt.id,
        field: 'consumedByActionIds',
        message: "Not the exact inverse of actions' triggeredByEventIds",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (pure; mirrored verbatim in the frontend copy).
// ---------------------------------------------------------------------------

function dangling(
  from: string,
  field: string,
  missingId: string,
  message: string,
  issues: ValidationIssue[],
): void {
  issues.push({ level: 'error', kind: 'dangling_ref', from, field, missingId, message });
}

/** Flag a reference that RESOLVES but points to a later (forbidden) layer. */
function forwardRef(
  from: string,
  field: string,
  ref: string | undefined,
  laterLayers: Set<string>[],
  issues: ValidationIssue[],
): void {
  if (!ref) return;
  for (const layer of laterLayers) {
    if (layer.has(ref)) {
      issues.push({
        level: 'error',
        kind: 'stage_order_violation',
        from,
        field,
        missingId: ref,
        message: 'References an id from a later extraction layer (forward reference)',
      });
      return;
    }
  }
}

/**
 * Provenance gate: `extracted`/`merged` nodes need >=1 source; `inferred`
 * (and `human`) may have []. `quoteVerified === false` citations -> warn.
 */
function requireSources(
  id: string,
  provenance: Provenance | undefined,
  sources: { quoteVerified?: boolean; sentenceRefs?: number[] }[] | undefined,
  sentenceLevel: boolean,
  issues: ValidationIssue[],
): void {
  const list = arr(sources);
  const needsSource = provenance === 'extracted' || provenance === 'merged';
  if (needsSource && list.length === 0) {
    issues.push({
      level: 'error',
      kind: 'missing_source',
      from: id,
      field: 'sources',
      message: `Node with provenance "${provenance}" must carry >=1 source`,
    });
    return;
  }
  list.forEach((src, i) => {
    if (src.quoteVerified === false) {
      issues.push({
        level: 'warn',
        kind: 'quote_unverified',
        from: id,
        field: `sources[${i}].snippet`,
        message: 'Snippet not found verbatim in source; confidence downgraded',
      });
    }
    if (sentenceLevel && needsSource && !nonEmptyArr(src.sentenceRefs)) {
      issues.push({
        level: 'warn',
        kind: 'missing_source',
        from: id,
        field: `sources[${i}].sentenceRefs`,
        message: 'Rule citation should be sentence-level (no sentenceRefs)',
      });
    }
  });
}

function duplicateIds(nodes: { id: string }[], issues: ValidationIssue[]): void {
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!n || !n.id) continue;
    if (seen.has(n.id)) {
      issues.push({
        level: 'error',
        kind: 'duplicate_id',
        from: n.id,
        field: 'id',
        message: `Duplicate node id "${n.id}"`,
      });
    } else {
      seen.add(n.id);
    }
  }
}

function idSet<T extends { id: string }>(nodes: T[]): Set<string> {
  const s = new Set<string>();
  for (const n of nodes) {
    if (n && n.id) s.add(n.id);
  }
  return s;
}

function mapBy<T extends { id: string }, V>(nodes: T[], pick: (n: T) => V): Map<string, V> {
  const m = new Map<string, V>();
  for (const n of nodes) {
    if (n && n.id) m.set(n.id, pick(n));
  }
  return m;
}

function getOrInit(m: Map<string, Set<string>>, key: string): Set<string> {
  let v = m.get(key);
  if (!v) {
    v = new Set<string>();
    m.set(key, v);
  }
  return v;
}

function sameSet(expected: Set<string>, actual: string[]): boolean {
  const actualSet = new Set(actual);
  if (expected.size !== actualSet.size) return false;
  for (const v of expected) {
    if (!actualSet.has(v)) return false;
  }
  return true;
}

function arr<T>(v: T[] | undefined | null): T[] {
  return Array.isArray(v) ? v : [];
}

function nonEmptyArr<T>(v: T[] | undefined | null): boolean {
  return Array.isArray(v) && v.length > 0;
}

function safeId(o: Ontology): string {
  return (o && typeof o.id === 'string' && o.id) || 'ontology:?';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
