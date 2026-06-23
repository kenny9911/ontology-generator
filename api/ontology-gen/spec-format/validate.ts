// ============================================================================
//  spec-format/validate.ts — contract validators for the spec-format schema.
// ----------------------------------------------------------------------------
//  Two tiers, both pure (return a string[] of human-readable issues, never throw):
//
//    SHAPE validators (validateSpecObjects / Rules / Actions / Events /
//      Workflows) — required keys present + correct primitive types + closed
//      vocabularies. LENIENT about extra keys, so they accept BOTH the
//      hand-authored reference samples (fixtures/spec-samples) AND the
//      deterministic projection output. The test suite runs these over the
//      samples to anchor the contract to real data.
//
//    CROSS-REF validator (validateSpecBundle) — the shape checks PLUS internal
//      referential integrity over a FULL five-layer bundle (FK `references`
//      resolve to an emitted object id, rule `relatedEntities` ids resolve,
//      action/workflow event names resolve, `source_object` / `source_action`
//      resolve). Only meaningful on a full projection, not a single sample file.
//
//  HARD RULES (NodeNext / strict TS): runtime import is the sibling `./types.js`
//  only; `any` is not used.
// ============================================================================

import {
  SPEC_ACTORS,
  SPEC_DATA_CHANGE_ACTIONS,
  SPEC_ENFORCEMENT_LEVELS,
  SPEC_EXECUTORS,
  SPEC_FAILURE_POLICIES,
  SPEC_OBJECT_CLASSES,
  SPEC_SCALAR_TYPES,
  SPEC_WORKFLOW_STEP_TYPES,
} from './types.js';
import type {
  SpecAction,
  SpecBundle,
  SpecEvent,
  SpecObject,
  SpecRule,
  SpecWorkflow,
} from './types.js';

// ---------------------------------------------------------------------------
// Primitive guards.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

const SCALAR_SET = new Set<string>(SPEC_SCALAR_TYPES);
const ACTOR_SET = new Set<string>(SPEC_ACTORS);

/** A valid property/IO type: a scalar, or a nested `List<...>` of one. */
export function isValidSpecType(t: unknown): boolean {
  if (!isStr(t)) return false;
  const s = t.trim();
  if (SCALAR_SET.has(s)) return true;
  const m = /^List<(.+)>$/.exec(s);
  if (m) return isValidSpecType(m[1]!.trim());
  return false;
}

/** Assert a closed-vocabulary string field. */
function inEnum(
  rec: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  where: string,
  issues: string[],
): void {
  const v = rec[key];
  if (!isStr(v) || !allowed.includes(v)) {
    issues.push(`${where}: "${key}" must be one of [${allowed.join(', ')}], got ${JSON.stringify(v)}`);
  }
}

/** Assert a required string field. */
function reqStr(rec: Record<string, unknown>, key: string, where: string, issues: string[]): void {
  if (!isStr(rec[key])) issues.push(`${where}: missing/invalid string "${key}"`);
}

/** Assert a required array field. */
function reqArr(rec: Record<string, unknown>, key: string, where: string, issues: string[]): void {
  if (!isArr(rec[key])) issues.push(`${where}: missing/invalid array "${key}"`);
}

/** Assert an array-of-strings field. */
function reqStrArr(rec: Record<string, unknown>, key: string, where: string, issues: string[]): void {
  const v = rec[key];
  if (!isArr(v) || !v.every(isStr)) issues.push(`${where}: "${key}" must be an array of strings`);
}

// ===========================================================================
// SHAPE validators (per layer). Accept samples AND projection output.
// ===========================================================================

export function validateSpecObjects(objects: unknown): string[] {
  const issues: string[] = [];
  if (!isArr(objects)) return ['objects: not an array'];
  objects.forEach((o, i) => {
    const where = `objects[${i}]`;
    if (!isRecord(o)) {
      issues.push(`${where}: not an object`);
      return;
    }
    reqStr(o, 'id', where, issues);
    reqStr(o, 'name', where, issues);
    reqStr(o, 'description', where, issues);
    inEnum(o, 'type', SPEC_OBJECT_CLASSES, where, issues);
    reqStr(o, 'relationship_description', where, issues);
    reqStr(o, 'primary_key', where, issues);
    reqArr(o, 'properties', where, issues);
    const props = o.properties;
    if (isArr(props)) {
      props.forEach((p, j) => {
        const pw = `${where}.properties[${j}]`;
        if (!isRecord(p)) {
          issues.push(`${pw}: not an object`);
          return;
        }
        reqStr(p, 'name', pw, issues);
        reqStr(p, 'description', pw, issues);
        if (!isValidSpecType(p.type)) issues.push(`${pw}: invalid "type" ${JSON.stringify(p.type)}`);
        if (p.is_foreign_key !== undefined && typeof p.is_foreign_key !== 'boolean') {
          issues.push(`${pw}: "is_foreign_key" must be boolean`);
        }
        if (p.is_foreign_key === true && !(isStr(p.references) && p.references.length > 0)) {
          issues.push(`${pw}: foreign-key property must carry a non-empty "references"`);
        }
      });
    }
  });
  return issues;
}

export function validateSpecRules(rules: unknown): string[] {
  const issues: string[] = [];
  if (!isArr(rules)) return ['rules: not an array'];
  rules.forEach((r, i) => {
    const where = `rules[${i}]`;
    if (!isRecord(r)) {
      issues.push(`${where}: not an object`);
      return;
    }
    for (const k of [
      'id',
      'specificScenarioStage',
      'businessLogicRuleName',
      'applicableClient',
      'applicableDepartment',
      'submissionCriteria',
      'standardizedLogicRule',
      'businessBackgroundReason',
      'ruleSource',
    ]) {
      reqStr(r, k, where, issues);
    }
    reqArr(r, 'relatedEntities', where, issues);
    inEnum(r, 'executor', SPEC_EXECUTORS, where, issues);
    inEnum(r, 'enforcementLevel', SPEC_ENFORCEMENT_LEVELS, where, issues);
    inEnum(r, 'failurePolicy', SPEC_FAILURE_POLICIES, where, issues);
  });
  return issues;
}

function validateActionIO(io: unknown, where: string, issues: string[], requireRequired: boolean): void {
  if (!isRecord(io)) {
    issues.push(`${where}: not an object`);
    return;
  }
  reqStr(io, 'name', where, issues);
  reqStr(io, 'description', where, issues);
  if (!isValidSpecType(io.type)) issues.push(`${where}: invalid "type" ${JSON.stringify(io.type)}`);
  if (io.source_object !== undefined && !isStr(io.source_object)) {
    issues.push(`${where}: "source_object" must be a string`);
  }
  if (requireRequired && io.required !== undefined && typeof io.required !== 'boolean') {
    issues.push(`${where}: "required" must be boolean`);
  }
}

export function validateSpecActions(actions: unknown): string[] {
  const issues: string[] = [];
  if (!isArr(actions)) return ['actions: not an array'];
  actions.forEach((a, i) => {
    const where = `actions[${i}]`;
    if (!isRecord(a)) {
      issues.push(`${where}: not an object`);
      return;
    }
    reqStr(a, 'id', where, issues);
    reqStr(a, 'name', where, issues);
    reqStr(a, 'description', where, issues);
    reqStr(a, 'submission_criteria', where, issues);
    if (a.object_type !== 'action') issues.push(`${where}: "object_type" must be "action"`);
    reqStr(a, 'category', where, issues);
    reqStr(a, 'system_prompt', where, issues);
    reqStr(a, 'user_prompt', where, issues);
    reqStrArr(a, 'trigger', where, issues);
    reqStrArr(a, 'target_objects', where, issues);
    reqStrArr(a, 'tool_use', where, issues);
    reqStrArr(a, 'triggered_event', where, issues);

    // actor: array of SpecActor.
    if (!isArr(a.actor) || !a.actor.every((x) => isStr(x) && ACTOR_SET.has(x))) {
      issues.push(`${where}: "actor" must be an array of [${SPEC_ACTORS.join(', ')}]`);
    }

    if (isArr(a.inputs)) a.inputs.forEach((io, j) => validateActionIO(io, `${where}.inputs[${j}]`, issues, true));
    else issues.push(`${where}: missing/invalid array "inputs"`);
    if (isArr(a.outputs)) a.outputs.forEach((io, j) => validateActionIO(io, `${where}.outputs[${j}]`, issues, false));
    else issues.push(`${where}: missing/invalid array "outputs"`);

    if (isArr(a.action_steps)) {
      a.action_steps.forEach((s, j) => {
        const sw = `${where}.action_steps[${j}]`;
        if (!isRecord(s)) {
          issues.push(`${sw}: not an object`);
          return;
        }
        reqStr(s, 'order', sw, issues);
        reqStr(s, 'name', sw, issues);
        reqStr(s, 'description', sw, issues);
        reqStr(s, 'object_type', sw, issues);
        if (s.rules !== undefined && !isArr(s.rules)) issues.push(`${sw}: "rules" must be an array`);
      });
    } else {
      issues.push(`${where}: missing/invalid array "action_steps"`);
    }

    // side_effects: { data_changes: [...], notifications?: [...] }
    const se = a.side_effects;
    if (!isRecord(se)) {
      issues.push(`${where}: missing/invalid "side_effects"`);
    } else {
      if (isArr(se.data_changes)) {
        se.data_changes.forEach((dc, j) => {
          const dw = `${where}.side_effects.data_changes[${j}]`;
          if (!isRecord(dc)) {
            issues.push(`${dw}: not an object`);
            return;
          }
          reqStr(dc, 'object_type', dw, issues);
          inEnum(dc, 'action', SPEC_DATA_CHANGE_ACTIONS, dw, issues);
          reqArr(dc, 'property_impacted', dw, issues);
          reqStr(dc, 'description', dw, issues);
        });
      } else {
        issues.push(`${where}.side_effects: missing/invalid array "data_changes"`);
      }
      if (se.notifications !== undefined && !isArr(se.notifications)) {
        issues.push(`${where}.side_effects: "notifications" must be an array`);
      }
    }
  });
  return issues;
}

export function validateSpecEvents(events: unknown): string[] {
  const issues: string[] = [];
  if (!isArr(events)) return ['events: not an array'];
  events.forEach((e, i) => {
    const where = `events[${i}]`;
    if (!isRecord(e)) {
      issues.push(`${where}: not an object`);
      return;
    }
    reqStr(e, 'name', where, issues);
    reqStr(e, 'description', where, issues);
    const payload = e.payload;
    if (!isRecord(payload)) {
      issues.push(`${where}: missing/invalid "payload"`);
      return;
    }
    reqStr(payload, 'source_action', `${where}.payload`, issues);
    if (isArr(payload.event_data)) {
      payload.event_data.forEach((d, j) => {
        const dw = `${where}.payload.event_data[${j}]`;
        if (!isRecord(d)) {
          issues.push(`${dw}: not an object`);
          return;
        }
        reqStr(d, 'name', dw, issues);
        if (!isValidSpecType(d.type)) issues.push(`${dw}: invalid "type" ${JSON.stringify(d.type)}`);
        if (!(d.target_object === null || isStr(d.target_object))) {
          issues.push(`${dw}: "target_object" must be a string or null`);
        }
      });
    } else {
      issues.push(`${where}.payload: missing/invalid array "event_data"`);
    }
    if (isArr(payload.state_mutations)) {
      payload.state_mutations.forEach((m, j) => {
        const mw = `${where}.payload.state_mutations[${j}]`;
        if (!isRecord(m)) {
          issues.push(`${mw}: not an object`);
          return;
        }
        reqStr(m, 'target_object', mw, issues);
        reqStr(m, 'mutation_type', mw, issues);
        reqArr(m, 'impacted_properties', mw, issues);
      });
    } else {
      issues.push(`${where}.payload: missing/invalid array "state_mutations"`);
    }
  });
  return issues;
}

export function validateSpecWorkflows(workflows: unknown): string[] {
  const issues: string[] = [];
  if (!isArr(workflows)) return ['workflows: not an array'];
  workflows.forEach((w, i) => {
    const where = `workflows[${i}]`;
    if (!isRecord(w)) {
      issues.push(`${where}: not an object`);
      return;
    }
    reqStr(w, 'id', where, issues);
    reqStr(w, 'name', where, issues);
    reqStr(w, 'description', where, issues);
    reqStrArr(w, 'trigger', where, issues);
    reqStrArr(w, 'triggered_event', where, issues);
    if (!isArr(w.actor) || !w.actor.every((x) => isStr(x) && ACTOR_SET.has(x))) {
      issues.push(`${where}: "actor" must be an array of [${SPEC_ACTORS.join(', ')}]`);
    }
    if (isArr(w.actions)) {
      w.actions.forEach((s, j) => {
        const sw = `${where}.actions[${j}]`;
        if (!isRecord(s)) {
          issues.push(`${sw}: not an object`);
          return;
        }
        reqStr(s, 'order', sw, issues);
        reqStr(s, 'name', sw, issues);
        reqStr(s, 'description', sw, issues);
        reqStr(s, 'condition', sw, issues);
        inEnum(s, 'type', SPEC_WORKFLOW_STEP_TYPES, sw, issues);
      });
    } else {
      issues.push(`${where}: missing/invalid array "actions"`);
    }
  });
  return issues;
}

// ===========================================================================
// CROSS-REF validator over a FULL bundle (projection output only).
// ===========================================================================

/** Extract the id inside the trailing parentheses of "Name (Id)". */
function relatedEntityId(entry: string): string | null {
  const m = /\(([^()]+)\)\s*$/.exec(entry.trim());
  return m ? m[1]!.trim() : null;
}

export function validateSpecBundle(bundle: SpecBundle): string[] {
  const issues: string[] = [
    ...validateSpecObjects(bundle.objects),
    ...validateSpecRules(bundle.rules),
    ...validateSpecActions(bundle.actions),
    ...validateSpecEvents(bundle.events),
    ...validateSpecWorkflows(bundle.workflows),
  ];

  const objectIds = new Set((bundle.objects ?? []).map((o) => o.id));
  const eventNames = new Set((bundle.events ?? []).map((e) => e.name));
  const actionNames = new Set((bundle.actions ?? []).map((a) => a.name));

  // Object FK references resolve.
  bundle.objects.forEach((o, i) => {
    o.properties.forEach((p, j) => {
      if (p.references && !objectIds.has(p.references)) {
        issues.push(`objects[${i}].properties[${j}]: references unknown object "${p.references}"`);
      }
    });
  });

  // Rule relatedEntities ids resolve.
  bundle.rules.forEach((r, i) => {
    r.relatedEntities.forEach((entry, j) => {
      const id = relatedEntityId(entry);
      if (id && !objectIds.has(id)) {
        issues.push(`rules[${i}].relatedEntities[${j}]: unknown object id "${id}"`);
      }
    });
  });

  // Action references resolve.
  bundle.actions.forEach((a, i) => {
    a.trigger.forEach((ev, j) => {
      if (!eventNames.has(ev)) issues.push(`actions[${i}].trigger[${j}]: unknown event "${ev}"`);
    });
    a.triggered_event.forEach((ev, j) => {
      if (!eventNames.has(ev)) issues.push(`actions[${i}].triggered_event[${j}]: unknown event "${ev}"`);
    });
    a.target_objects.forEach((oid, j) => {
      if (!objectIds.has(oid)) issues.push(`actions[${i}].target_objects[${j}]: unknown object "${oid}"`);
    });
    a.inputs.forEach((io, j) => {
      if (io.source_object) {
        const obj = io.source_object.split('.')[0]!;
        if (!objectIds.has(obj)) {
          issues.push(`actions[${i}].inputs[${j}].source_object: unknown object "${obj}"`);
        }
      }
    });
    a.side_effects.data_changes.forEach((dc, j) => {
      if (!objectIds.has(dc.object_type)) {
        issues.push(`actions[${i}].side_effects.data_changes[${j}]: unknown object "${dc.object_type}"`);
      }
    });
  });

  // Event references resolve.
  bundle.events.forEach((e, i) => {
    if (e.payload.source_action && !actionNames.has(e.payload.source_action)) {
      issues.push(`events[${i}].payload.source_action: unknown action "${e.payload.source_action}"`);
    }
    e.payload.event_data.forEach((d, j) => {
      if (d.target_object && !objectIds.has(d.target_object)) {
        issues.push(`events[${i}].payload.event_data[${j}].target_object: unknown object "${d.target_object}"`);
      }
    });
    e.payload.state_mutations.forEach((m, j) => {
      if (!objectIds.has(m.target_object)) {
        issues.push(`events[${i}].payload.state_mutations[${j}]: unknown object "${m.target_object}"`);
      }
    });
  });

  // Workflow references resolve (trigger may include the synthetic SCHEDULED_SYNC).
  bundle.workflows.forEach((w, i) => {
    w.trigger.forEach((ev, j) => {
      if (ev !== 'SCHEDULED_SYNC' && !eventNames.has(ev)) {
        issues.push(`workflows[${i}].trigger[${j}]: unknown event "${ev}"`);
      }
    });
    w.triggered_event.forEach((ev, j) => {
      if (!eventNames.has(ev)) issues.push(`workflows[${i}].triggered_event[${j}]: unknown event "${ev}"`);
    });
  });

  return issues;
}

// Re-exported for callers that want the per-layer set in one object.
export const SPEC_LAYER_VALIDATORS = {
  objects: validateSpecObjects,
  rules: validateSpecRules,
  actions: validateSpecActions,
  events: validateSpecEvents,
  workflows: validateSpecWorkflows,
} as const;

// Type-only re-exports so consumers can import the projected shapes alongside
// their validators without reaching into ./types.js.
export type { SpecObject, SpecRule, SpecAction, SpecEvent, SpecWorkflow, SpecBundle };
