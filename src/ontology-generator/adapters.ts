// ============================================================================
//  adapters.ts — the DEMO ⇄ CANONICAL seam (DESIGN_SPEC §8.4, frontend.md §2/§5).
//
//  Two pure functions bridge the offline demo fixture (`data.ts`, the `Ont*`
//  VIEW types) and the LOCKED canonical model (`@/ontology/schema/types`):
//
//    datasetToOntology(dataset): Ontology
//        Convert a demo Dataset (the "commerce" fixture) into a schema-valid
//        canonical `Ontology`. Crucially it DERIVES Actions + Events +
//        Processes from the demo processes so DEMO MODE lights up all 9 steps
//        (input→discover→objects→rules→actions→events→processes→graph→publish).
//        The output is shaped to pass `validateOntology` — no dangling refs,
//        and the Action↔Event inverse is kept EXACT.
//
//    ontologyToDataset(o): Dataset
//        Best-effort projection back onto the legacy `Dataset` VIEW, for any
//        screen still rendering the old shape (Graph/Processes during the
//        migration). Lossy by design — only the view-relevant fields.
//
//  This module is a pure, side-effect-free LEAF: it imports only canonical
//  TYPES (`import type`) and the demo VIEW types. No fetch, no React, no
//  mutation of its inputs. Compiles under strict / noUnusedLocals /
//  noUnusedParameters with no `any`.
// ============================================================================

import type {
  Ontology,
  ObjectType,
  ObjectProperty,
  PropertyType,
  Rule,
  ActionType,
  EventType,
  Process,
  Relationship,
  SourceRef,
  SourceDocument,
  DataType,
  ActorRef,
  WorkflowStep,
  EventField,
  ActionIO,
  ActionStep,
  Confidence,
  RuleKind,
  Severity,
  JsonSchema,
  JsonSchemaProp,
} from '@/ontology/schema/types';
import { SCHEMA_VERSION_NUMBER } from '@/ontology/schema/types';

import type {
  Dataset,
  OntObject,
  OntAttr,
  OntRule,
  OntProcess,
  OntSource,
  ProcStep,
  Lang,
} from './data';

// ===========================================================================
//  Slug helpers (self-contained — api/_shared/ids.ts lives in the NodeNext
//  backend build and must not be dragged into the bundler frontend graph).
// ===========================================================================

function slugify(name: string): string {
  const slug = (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug.length > 0 ? slug : 'x';
}

const PREFIX = {
  object: 'objectType:',
  rel: 'rel:',
  rule: 'rule:',
  action: 'action:',
  event: 'event:',
  process: 'process:',
} as const;

function objectId(name: string): string {
  return PREFIX.object + slugify(name);
}

/** Deterministic synthetic uuid — demo only (no real persistence). */
function demoUuid(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return `demo-${hex}-${slugify(seed).slice(0, 12)}`;
}

// ===========================================================================
//  Demo attribute type-string → canonical DataType (+ enumValues / refTarget).
// ===========================================================================

interface ParsedAttrType {
  type: DataType;
  enumValues?: string[];
  refTargetName?: string;
}

const SCALAR_TYPE_MAP: Record<string, DataType> = {
  uuid: 'uuid',
  string: 'string',
  text: 'string',
  integer: 'integer',
  int: 'integer',
  decimal: 'decimal',
  number: 'decimal',
  money: 'money',
  currency: 'money',
  boolean: 'boolean',
  bool: 'boolean',
  date: 'date',
  datetime: 'datetime',
  timestamp: 'datetime',
  json: 'json',
  array: 'array',
};

/**
 * Parse a demo attr `type` string into the closed canonical vocabulary.
 *   "Enum<Open|Paid|Void>"  -> { type: 'enum', enumValues: ['Open','Paid','Void'] }
 *   "Reference<Category>"    -> { type: 'reference', refTargetName: 'Category' }
 *   "Address"                -> { type: 'reference', refTargetName: 'Address' }  (known object)
 *   "Money" / "UUID" / ...   -> scalar map
 *   anything unknown         -> 'string' (safe default)
 */
function parseAttrType(raw: string, knownObjectNames: Set<string>): ParsedAttrType {
  const s = (raw ?? '').trim();

  const enumMatch = /^enum\s*<\s*(.+?)\s*>$/i.exec(s);
  if (enumMatch) {
    const values = enumMatch[1]
      .split('|')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return { type: 'enum', enumValues: values.length > 0 ? values : ['value'] };
  }

  const refMatch = /^reference\s*<\s*(.+?)\s*>$/i.exec(s);
  if (refMatch) {
    return { type: 'reference', refTargetName: refMatch[1].trim() };
  }

  const lower = s.toLowerCase();
  const scalar = SCALAR_TYPE_MAP[lower];
  if (scalar) return { type: scalar };

  // A bare type name that happens to match a known ObjectType (e.g. "Address")
  // is treated as a reference to that object.
  if (knownObjectNames.has(s)) {
    return { type: 'reference', refTargetName: s };
  }

  return { type: 'string' };
}

// ===========================================================================
//  Synthetic provenance — demo nodes are "inferred" but still carry a
//  plausible citation so every screen renders receipts. `inferred` provenance
//  means the validator does NOT require sources, so this is always shape-safe.
// ===========================================================================

function synthSource(doc: OntSource | undefined, snippet: string): SourceRef {
  const name = doc?.name ?? 'demo://commerce';
  return {
    documentId: 'doc:' + slugify(name),
    documentName: name,
    snippet,
    page: doc?.pages && doc.pages > 0 ? 1 : undefined,
    quoteVerified: true,
    confidence: 0.9,
  };
}

function ruleSource(r: OntRule): SourceRef {
  return {
    documentId: 'doc:' + slugify(r.source.name),
    documentName: r.source.name,
    snippet: r.source.excerpt,
    page: r.source.page > 0 ? r.source.page : undefined,
    section: undefined,
    sentenceRefs: [0],
    quoteVerified: true,
    confidence: r.confidence,
  };
}

// ===========================================================================
//  data.ts (demo VIEW) → canonical Ontology
// ===========================================================================

export function datasetToOntology(dataset: Dataset): Ontology {
  const nowIso = new Date(0).toISOString(); // stable for demo determinism

  const knownObjectNames = new Set(dataset.objects.map((o) => o.name));

  // ---- Source documents ----------------------------------------------------
  const sourceDocuments: SourceDocument[] = dataset.sources.map((s) => ({
    id: 'doc:' + slugify(s.name),
    uuid: demoUuid('doc:' + s.name),
    name: s.name,
    kind: s.kind,
    pageCount: s.pages > 0 ? s.pages : undefined,
  }));

  // ---- 1. ObjectTypes ------------------------------------------------------
  const objects: ObjectType[] = dataset.objects.map((o) =>
    toObjectType(o, dataset.sources[0], knownObjectNames),
  );
  const objectIdByName = new Map<string, string>();
  for (const o of dataset.objects) objectIdByName.set(o.name, objectId(o.name));

  // ---- Relationships (derived from demo `relations` verb strings) ----------
  const relationships = buildRelationships(dataset.objects, objectIdByName, dataset.sources[0]);

  // Attach cached outbound relationship ids back onto each object.
  for (const obj of objects) {
    obj.relationshipIds = relationships
      .filter((r) => r.sourceObjectTypeId === obj.id)
      .map((r) => r.id);
  }

  // ---- 2. Rules ------------------------------------------------------------
  const rules: Rule[] = dataset.rules.map((r) => toRule(r, objectIdByName));

  // ---- 3/4. Actions + Events (co-derived; inverse kept EXACT) --------------
  const { actions, events } = buildActionsAndEvents(
    dataset.processes,
    objectIdByName,
    dataset.sources[0],
  );
  const actionIdByStepKey = indexActionsByStepKey(dataset.processes);

  // ---- 5. Processes (each step → an action) --------------------------------
  const processes: Process[] = dataset.processes.map((p) =>
    toProcess(p, actionIdByStepKey, dataset.sources[0]),
  );

  // ---- Aggregate confidence ------------------------------------------------
  const allConfidences: Confidence[] = [
    ...objects.map((n) => n.confidence),
    ...rules.map((n) => n.confidence),
    ...actions.map((n) => n.confidence),
    ...events.map((n) => n.confidence),
    ...processes.map((n) => n.confidence),
  ];
  const confidence =
    allConfidences.length > 0
      ? allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length
      : 0;

  const ontology: Ontology = {
    id: 'ontology:demo-' + slugify(dataset.id),
    uuid: demoUuid('ontology:' + dataset.id),
    name: dataset.label.en,
    nameZh: dataset.label.zh,
    domain: 'generic',
    version: 1,
    schemaVersion: SCHEMA_VERSION_NUMBER,
    status: 'draft',
    sourceDocuments,
    objects,
    rules,
    actions,
    events,
    processes,
    relationships,
    confidence,
    metadata: {
      createdAt: nowIso,
      updatedAt: nowIso,
      generation: {
        model: 'demo',
        provider: 'demo',
        runId: 'demo-run',
      },
      stats: {
        objects: objects.length,
        rules: rules.length,
        actions: actions.length,
        events: events.length,
        processes: processes.length,
        relationships: relationships.length,
      },
    },
  };

  return ontology;
}

// --- ObjectType ------------------------------------------------------------

function toObjectType(
  o: OntObject,
  primarySource: OntSource | undefined,
  knownObjectNames: Set<string>,
): ObjectType {
  const id = objectId(o.name);
  const properties = o.attrs.map((a) => toProperty(a, knownObjectNames));
  const pkAttr = o.attrs.find((a) => a.role === 'pk');
  const primary_key = pkAttr ? pkAttr.name : `${id.replace(PREFIX.object, '').replace(/-/g, '_')}_id`;
  return {
    id,
    uuid: demoUuid(id),
    name: o.name,
    nameZh: o.zh,
    description: `${o.name} — discovered across ${o.sources} source references.`,
    type: 'data',
    relationship_description:
      o.relations.length > 0
        ? o.relations.map((r) => `${o.name} ${r}`).join('; ')
        : `${o.name} has no documented relationships to other objects.`,
    primary_key,
    properties,
    sources: [synthSource(primarySource, `${o.name} entity referenced across the corpus.`)],
    confidence: o.confidence,
    provenance: 'inferred',
    reviewState: 'accepted',
    display: { emoji: o.emoji, color: o.color },
  };
}

/** Map the internal DataType the demo parser yields to the spec PropertyType. */
function dataTypeToPropertyType(t: DataType): PropertyType {
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

function toProperty(a: OntAttr, knownObjectNames: Set<string>): ObjectProperty {
  const parsed = parseAttrType(a.type, knownObjectNames);

  // Resolve a foreign-key target from the parsed reference, else from the
  // attribute-name convention (e.g. `customer_id` -> Customer).
  let references: string | undefined;
  if (parsed.refTargetName) {
    references = objectId(parsed.refTargetName);
  } else if (a.role === 'fk') {
    references = inferRefFromAttrName(a.name, knownObjectNames);
  }

  const prop: ObjectProperty = {
    name: a.name,
    type: dataTypeToPropertyType(parsed.type),
    description: parsed.enumValues && parsed.enumValues.length > 0
      ? `One of: ${parsed.enumValues.join(', ')}.`
      : `${a.name}.`,
  };
  if (references) {
    prop.is_foreign_key = true;
    prop.references = references;
  }
  return prop;
}

/** `customer_id` -> objectType:customer when "Customer" is a known object. */
function inferRefFromAttrName(attrName: string, knownObjectNames: Set<string>): string | undefined {
  const base = attrName.replace(/_id$/i, '').replace(/_/g, '');
  for (const name of knownObjectNames) {
    if (name.toLowerCase() === base.toLowerCase()) return objectId(name);
  }
  // Fall back to the first known object so the fk never dangles in the demo.
  const first = knownObjectNames.values().next();
  return first.done ? undefined : objectId(first.value);
}

// --- Relationship ----------------------------------------------------------

function buildRelationships(
  objects: OntObject[],
  objectIdByName: Map<string, string>,
  primarySource: OntSource | undefined,
): Relationship[] {
  const out: Relationship[] = [];
  const taken = new Set<string>();

  for (const o of objects) {
    const sourceId = objectIdByName.get(o.name);
    if (!sourceId) continue;

    for (const relStr of o.relations) {
      const parsed = parseRelationString(relStr);
      if (!parsed) continue;

      // A single demo relation string can reference multiple targets
      // ("used-by → Customer, Shipment"). Emit one edge per RESOLVABLE target.
      for (const targetName of parsed.targets) {
        const targetId = objectIdByName.get(targetName);
        if (!targetId) continue; // skip refs to objects not in the demo set

        let baseId = `${PREFIX.rel}${slugify(o.name)}-${slugify(parsed.verb)}-${slugify(targetName)}`;
        let id = baseId;
        let n = 2;
        while (taken.has(id)) {
          id = `${baseId}-${n++}`;
        }
        taken.add(id);

        out.push({
          id,
          uuid: demoUuid(id),
          name: slugify(parsed.verb).replace(/-/g, '_'),
          label: {
            en: `${parsed.verb} → ${targetName}`,
            zh: `${parsed.verb} → ${targetName}`,
          },
          sourceObjectTypeId: sourceId,
          targetObjectTypeId: targetId,
          cardinality: 'one_to_many',
          sources: [
            synthSource(primarySource, `${o.name} ${parsed.verb} ${targetName}.`),
          ],
          confidence: 0.85,
          provenance: 'inferred',
          reviewState: 'accepted',
        });
      }
    }
  }

  return out;
}

interface ParsedRelation {
  verb: string;
  targets: string[];
}

/**
 * Parse a demo relation string of the form `"<verb> → <Target>[, <Target2>]"`.
 * Targets carry parenthetical qualifiers in some entries
 * ("linked → Account (Salesforce)") which are stripped to the bare name.
 */
function parseRelationString(raw: string): ParsedRelation | null {
  const s = (raw ?? '').trim();
  // Split on the unicode arrow used in the fixture (→), fall back to "->".
  const arrowIdx = s.indexOf('→') >= 0 ? s.indexOf('→') : s.indexOf('->');
  if (arrowIdx < 0) return null;

  const verb = s.slice(0, arrowIdx).trim();
  const targetPart = s.slice(arrowIdx + (s.includes('→') ? 1 : 2)).trim();
  if (!verb || !targetPart) return null;

  const targets = targetPart
    .split(',')
    .map((t) => t.replace(/\(.*?\)/g, '').trim()) // drop "(Salesforce)" qualifiers
    .filter((t) => t.length > 0);

  return targets.length > 0 ? { verb, targets } : null;
}

// --- Rule ------------------------------------------------------------------

function toRule(r: OntRule, objectIdByName: Map<string, string>): Rule {
  const appliesTo = r.objects
    .map((name) => objectIdByName.get(name))
    .filter((id): id is string => Boolean(id));
  const severity = inferSeverity(r.confidence);
  const title = r.plain.en.slice(0, 48);
  const relatedEntities: string[] = [];
  for (const name of r.objects) {
    const id = objectIdByName.get(name);
    if (id) relatedEntities.push(`${name} (${pascalCase(id.replace(PREFIX.object, ''))})`);
  }

  return {
    id: `${PREFIX.rule}${slugify(r.id)}-${slugify(r.plain.en.slice(0, 24))}`,
    uuid: demoUuid('rule:' + r.id),
    specificScenarioStage: '',
    businessLogicRuleName: title,
    applicableClient: '通用',
    applicableDepartment: 'N/A',
    submissionCriteria: '',
    standardizedLogicRule: r.plain.en,
    relatedEntities,
    businessBackgroundReason: '',
    ruleSource: r.source?.name ?? '文档',
    executor: 'Agent',
    enforcementLevel: severity === 'block' ? 'mandatory' : 'optional',
    failurePolicy: severity === 'block' ? 'block' : 'warn',
    title,
    titleZh: r.plain.zh.slice(0, 24),
    statement: { en: r.plain.en, zh: r.plain.zh },
    formal: r.formal,
    kind: inferRuleKind(r.formal),
    severity,
    appliesToObjectTypeIds: appliesTo,
    sources: [ruleSource(r)],
    confidence: r.confidence,
    provenance: 'inferred',
    reviewState: 'accepted',
  };
}

function inferRuleKind(formal: string): RuleKind {
  const f = formal.toLowerCase();
  if (f.includes(':=')) return 'state_transition';
  if (f.includes('block') || f.includes('∃')) return 'authorization';
  if (f.includes('≤') || f.includes('30d') || f.includes('60d') || f.includes('today')) {
    return 'temporal';
  }
  if (f.includes('=') && f.includes('σ')) return 'derivation';
  return 'validation';
}

function inferSeverity(confidence: number): Severity {
  if (confidence >= 0.95) return 'block';
  if (confidence >= 0.88) return 'warn';
  return 'info';
}

// --- Actions + Events (co-derived) -----------------------------------------

/** A stable per-step key so processes can reference the action they spawned. */
function stepKey(proc: OntProcess, step: ProcStep, index: number): string {
  return `${proc.id}.${index}.${slugify(step.en.slice(0, 32))}`;
}

function indexActionsByStepKey(processes: OntProcess[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of processes) {
    p.steps.forEach((s, i) => {
      m.set(stepKey(p, s, i), actionIdForStep(p, s, i));
    });
  }
  return m;
}

function actionIdForStep(proc: OntProcess, step: ProcStep, index: number): string {
  return `${PREFIX.action}${slugify(proc.id)}-${index}-${slugify(step.en.slice(0, 24))}`;
}

function eventIdForStep(proc: OntProcess, step: ProcStep, index: number): string {
  return `${PREFIX.event}${slugify(proc.id)}.${index}.${slugify(step.obj)}.done`;
}

function buildActionsAndEvents(
  processes: OntProcess[],
  objectIdByName: Map<string, string>,
  primarySource: OntSource | undefined,
): { actions: ActionType[]; events: EventType[] } {
  const actions: ActionType[] = [];
  const events: EventType[] = [];

  // produced/consumed inverses, built as we go and applied to events at the end.
  const producedBy = new Map<string, string[]>(); // eventId -> [actionId]
  const consumedBy = new Map<string, string[]>(); // eventId -> [actionId]
  const eventDrafts = new Map<string, { proc: OntProcess; step: ProcStep; index: number }>();

  for (const proc of processes) {
    proc.steps.forEach((step, i) => {
      const actId = actionIdForStep(proc, step, i);
      const objId = objectIdByName.get(step.obj);
      const emitId = eventIdForStep(proc, step, i);

      // The action is triggered by the PREVIOUS step's event (if any) and emits
      // its own completion event — this gives an exact, walkable chain.
      const prevEmitId =
        i > 0 ? eventIdForStep(proc, proc.steps[i - 1], i - 1) : undefined;

      const inputs: ActionIO[] = objId
        ? [{ name: paramName(step.obj), objectTypeId: objId, required: true, cardinality: 'one' }]
        : [];
      const outputs: ActionIO[] = objId
        ? [{ name: paramName(step.obj), objectTypeId: objId, required: true, cardinality: 'one' }]
        : [];

      const steps: ActionStep[] = [
        {
          order: 1,
          text: { en: step.en, zh: step.zh },
          readsObjectTypeIds: objId ? [objId] : undefined,
          writesObjectTypeIds: objId ? [objId] : undefined,
        },
      ];

      const actorRole = primaryActor(proc);

      const evtSpec = (eid: string): string =>
        eid.replace(/^event:/, '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
      const targetSpec = objId ? pascalCase(objId.replace(PREFIX.object, '')) : undefined;

      actions.push({
        id: actId,
        uuid: demoUuid(actId),
        name: camelCaseName(step.en.slice(0, 40)),
        nameZh: step.zh,
        description: step.en,
        descriptionZh: step.zh,
        submission_criteria: '',
        object_type: 'action',
        category: step.zh || step.en.slice(0, 24),
        actor: ['Agent'],
        trigger: prevEmitId ? [evtSpec(prevEmitId)] : [],
        target_objects: targetSpec ? [targetSpec] : [],
        action_steps: [
          { order: '1', name: camelCaseName(step.en.slice(0, 24)), description: step.en, object_type: 'logic', submission_criteria: '' },
        ],
        system_prompt: `Perform "${step.en}".`,
        user_prompt: `Perform "${step.en}" and emit the resulting event.`,
        tool_use: [],
        side_effects: { data_changes: [], notifications: [] },
        triggered_event: [evtSpec(emitId)],
        inputs,
        outputs,
        steps,
        preconditions: [],
        triggeredByEventIds: prevEmitId ? [prevEmitId] : [],
        emitsEvents: [{ eventTypeId: emitId, on: 'success' }],
        actorRef: { role: actorRole, kind: 'system' },
        agent: buildAgentBinding(actId, step, objId),
        sources: [synthSource(primarySource, `Process step: ${step.en}`)],
        confidence: 0.86,
        provenance: 'inferred',
        reviewState: 'accepted',
      });

      // Record inverse wiring for the emitted event.
      pushTo(producedBy, emitId, actId);
      eventDrafts.set(emitId, { proc, step, index: i });

      // The NEXT step (if any) consumes this event — record it now so the
      // event's consumedByActionIds is exact.
      if (i + 1 < proc.steps.length) {
        const nextActId = actionIdForStep(proc, proc.steps[i + 1], i + 1);
        pushTo(consumedBy, emitId, nextActId);
      }
    });
  }

  // Materialize one EventType per drafted event id with EXACT inverse arrays.
  for (const [evtId, draft] of eventDrafts) {
    const objId = objectIdByName.get(draft.step.obj);
    const payloadFields: EventField[] = objId
      ? [{ name: paramName(draft.step.obj), type: 'reference', objectTypeId: objId, required: true }]
      : [];
    const targetSpec = objId ? pascalCase(objId.replace(PREFIX.object, '')) : undefined;
    const evtSpec = evtId.replace(/^event:/, '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();

    events.push({
      id: evtId,
      uuid: demoUuid(evtId),
      name: evtSpec,
      nameZh: `${draft.step.obj}·完成`,
      description: `${draft.step.en} — completed.`,
      payload: {
        source_action: camelCaseName(draft.step.en.slice(0, 40)),
        event_data: payloadFields.map((f) => ({
          name: f.name,
          type: dataTypeToPropertyType(f.type),
          target_object: f.objectTypeId ? pascalCase(f.objectTypeId.replace(PREFIX.object, '')) : null,
        })),
        state_mutations: targetSpec
          ? [{ target_object: targetSpec, mutation_type: 'CREATE_OR_MODIFY', impacted_properties: [] }]
          : [],
      },
      payloadFields,
      producedByActionIds: producedBy.get(evtId) ?? [],
      consumedByActionIds: consumedBy.get(evtId) ?? [],
      sources: [synthSource(primarySource, `Emitted after: ${draft.step.en}`)],
      confidence: 0.84,
      provenance: 'inferred',
      reviewState: 'accepted',
    });
  }

  return { actions, events };
}

function buildAgentBinding(
  actId: string,
  step: ProcStep,
  objId: string | undefined,
): ActionType['agent'] {
  const toolName = snakeCase(step.en.slice(0, 40));
  const props: Record<string, JsonSchemaProp> = {};
  if (objId) {
    const prop: JsonSchemaProp = {
      type: 'object',
      description: `The ${step.obj} this action operates on.`,
      $objectTypeId: objId,
    };
    props[paramName(step.obj)] = prop;
  }
  const parameterSchema: JsonSchema = {
    type: 'object',
    properties: props,
    required: objId ? [paramName(step.obj)] : [],
  };
  return {
    toolName: toolName.length > 0 ? toolName : `action_${slugify(actId).slice(-6)}`,
    parameterSchema,
    toolDescription: step.en,
    execution: 'function',
  };
}

// --- Process ---------------------------------------------------------------

function toProcess(
  p: OntProcess,
  actionIdByStepKey: Map<string, string>,
  primarySource: OntSource | undefined,
): Process {
  const actors: ActorRef[] = p.actors.map((role) => ({ role, kind: 'human' as const }));
  const actorRole = actors.length > 0 ? actors[0].role : undefined;

  const objectTypeIds = p.objects
    .map((name) => objectId(name))
    .filter((id, idx, all) => all.indexOf(id) === idx);

  const steps: WorkflowStep[] = p.steps.map((s, i) => {
    const actionTypeId = actionIdByStepKey.get(stepKey(p, s, i)) ?? actionIdForStep(p, s, i);
    const stepId = `s${i + 1}`;
    const nextStepId = i + 1 < p.steps.length ? `s${i + 2}` : null;
    return {
      id: stepId,
      actionTypeId,
      order: i + 1,
      actorRole,
      next: nextStepId ? [{ toStepId: nextStepId }] : [],
    };
  });

  return {
    id: `${PREFIX.process}${slugify(p.id)}-${slugify(p.name.en)}`,
    uuid: demoUuid('process:' + p.id),
    name: { en: p.name.en, zh: p.name.zh },
    description: p.name.en,
    actor: ['Agent'],
    trigger: [],
    actions: steps.map((s, i) => ({
      order: String(s.order),
      name: camelCaseName(p.steps[i]?.en ?? `step ${i + 1}`),
      description: p.steps[i]?.en ?? '',
      type: 'logic' as const,
      condition: '',
    })),
    triggered_event: [],
    actors,
    objectTypeIds,
    steps,
    triggers: [{ kind: 'manual', description: `Start ${p.name.en}` }],
    orchestration: { strategy: 'sequential', agentOrchestrated: true },
    sources: [synthSource(primarySource, `Process: ${p.name.en}`)],
    confidence: 0.85,
    provenance: 'inferred',
    reviewState: 'accepted',
  };
}

// --- naming helpers --------------------------------------------------------

function primaryActor(proc: OntProcess): string {
  return proc.actors.length > 0 ? proc.actors[0] : 'System';
}

function paramName(objectName: string): string {
  return snakeCase(objectName) || 'item';
}

function pascalCase(s: string): string {
  const parts = (s ?? '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const joined = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return joined.length > 0 ? joined : 'Action';
}

/** camelCase function-style name (the spec-format action/workflow naming). */
function camelCaseName(s: string): string {
  const p = pascalCase(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function snakeCase(s: string): string {
  return (s ?? '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join('_')
    .toLowerCase();
}

function pushTo(m: Map<string, string[]>, key: string, value: string): void {
  const list = m.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else {
    m.set(key, [value]);
  }
}

// ===========================================================================
//  canonical Ontology → data.ts (demo VIEW) — best-effort, lossy projection.
// ===========================================================================

export function ontologyToDataset(o: Ontology, lang: Lang = 'en'): Dataset {
  const objectNameById = new Map<string, string>();
  for (const obj of o.objects) objectNameById.set(obj.id, obj.name);

  // Group relationships by source object so we can rebuild the `relations`
  // verb strings the legacy VIEW expects.
  const relsBySource = new Map<string, string[]>();
  for (const rel of o.relationships) {
    const targetName = objectNameById.get(rel.targetObjectTypeId) ?? rel.targetObjectTypeId;
    const verb = rel.label?.[lang] ?? `${rel.name} → ${targetName}`;
    const list = relsBySource.get(rel.sourceObjectTypeId) ?? [];
    list.push(verb);
    relsBySource.set(rel.sourceObjectTypeId, list);
  }

  const sources: OntSource[] = o.sourceDocuments.map((d) => ({
    kind: d.kind,
    name: d.name,
    size: d.sizeBytes ? `${Math.round(d.sizeBytes / 1024)} KB` : '—',
    pages: d.pageCount ?? 0,
  }));

  const objects: OntObject[] = o.objects.map((obj) => ({
    id: obj.id.replace(PREFIX.object, ''),
    name: obj.name,
    zh: obj.nameZh,
    emoji: obj.display?.emoji ?? '◻',
    color: obj.display?.color ?? 'accent',
    confidence: obj.confidence,
    sources: obj.sources.length,
    attrs: obj.properties.map((p) => propertyToView(p, obj.primary_key)),
    relations: relsBySource.get(obj.id) ?? [],
  }));

  const rules: OntRule[] = o.rules.map((r) => {
    const src = r.sources[0];
    return {
      id: r.id.replace(PREFIX.rule, ''),
      confidence: r.confidence,
      plain: { en: r.statement.en, zh: r.statement.zh },
      formal: r.formal,
      source: {
        name: src?.documentName ?? '—',
        excerpt: src?.snippet ?? '',
        page: src?.page ?? 0,
      },
      objects: r.appliesToObjectTypeIds
        .map((id) => objectNameById.get(id))
        .filter((n): n is string => Boolean(n)),
    };
  });

  const processes: OntProcess[] = o.processes.map((p) => {
    const actionById = new Map<string, ActionType>();
    for (const a of o.actions) actionById.set(a.id, a);
    const steps: ProcStep[] = p.steps
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => {
        const action = actionById.get(s.actionTypeId);
        const writeId = action?.steps[0]?.writesObjectTypeIds?.[0];
        const objName = writeId ? objectNameById.get(writeId) : undefined;
        return {
          en: action?.description ?? '',
          zh: action?.descriptionZh ?? action?.nameZh ?? '',
          obj: objName ?? (p.objectTypeIds[0] ? objectNameById.get(p.objectTypeIds[0]) ?? '' : ''),
        };
      });
    return {
      id: p.id.replace(PREFIX.process, ''),
      name: { en: p.name.en, zh: p.name.zh },
      actors: p.actors.map((a) => a.role),
      objects: p.objectTypeIds
        .map((id) => objectNameById.get(id))
        .filter((n): n is string => Boolean(n)),
      steps,
    };
  });

  return {
    id: o.id.replace('ontology:', ''),
    label: { en: o.name, zh: o.nameZh ?? o.name },
    sublabel: { en: o.domain, zh: o.domain },
    sources,
    objects,
    rules,
    processes,
  };
}

function propertyToView(p: ObjectProperty, primaryKey: string): OntAttr {
  return {
    name: p.name,
    type: viewTypeString(p),
    role: p.name === primaryKey ? 'pk' : p.is_foreign_key ? 'fk' : undefined,
    req: p.name === primaryKey,
  };
}

function viewTypeString(p: ObjectProperty): string {
  if (p.is_foreign_key && p.references) {
    return `Reference<${pascalCase(p.references.replace(PREFIX.object, ''))}>`;
  }
  return p.type;
}
