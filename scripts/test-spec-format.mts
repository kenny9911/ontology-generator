// ============================================================================
//  test-spec-format.mts — deterministic verification of the spec-format output
//  projection (api/ontology-gen/spec-format/*). No LLM, no network: every check
//  is pure/deterministic. Run with `npm run test:spec`
//  (or `npx tsx scripts/test-spec-format.mts`). Exits 1 on any failure.
//
//  Sections:
//    1. Reference-sample contract self-check (anchors the validators to real
//       hand-authored data in fixtures/spec-samples/).
//    2. Pure helper unit tests (mapDataType / specObjectId / eventSpecName /
//       defaultPrimaryKey).
//    3. Projection over all golden fixtures passes validateSpecBundle (shape +
//       internal cross-references).
//    4. EXACT field-key conformance of every projected node (no extra/missing
//       keys vs the spec contract — the "fields match the sample" guarantee).
//    5. Targeted derivations: primary_key defaulting, FK references, executor /
//       enforcementLevel / failurePolicy, data/system classification.
//    6. Determinism (same ontology -> identical bytes).
// ============================================================================

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import type { ObjectType, Ontology } from '../api/_shared/ontology-schema.js';
import { PROPERTY_TYPES } from '../api/_shared/ontology-schema.js';
import { validateOntology } from '../api/_shared/ontology-validate.js';
import {
  ontologyToSpec,
  ontologyToSpecObjectsFile,
  mapDataType,
  specObjectId,
  eventSpecName,
  defaultPrimaryKey,
} from '../api/ontology-gen/spec-format/project.js';
import {
  validateSpecObjects,
  validateSpecRules,
  validateSpecActions,
  validateSpecEvents,
  validateSpecWorkflows,
  validateSpecBundle,
} from '../api/ontology-gen/spec-format/validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Tiny harness (mirrors scripts/test-hyper.mts).
// ---------------------------------------------------------------------------

interface SectionResult {
  name: string;
  pass: number;
  fail: number;
}
const sections: SectionResult[] = [];
let current: SectionResult = { name: '(none)', pass: 0, fail: 0 };

function section(name: string): void {
  current = { name, pass: 0, fail: 0 };
  sections.push(current);
  console.log(`\n== ${name} ==`);
}

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    current.pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    current.fail += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNoIssues(issues: string[], msg: string): void {
  if (issues.length > 0) {
    throw new Error(`${msg}: ${issues.length} issue(s):\n      - ${issues.slice(0, 8).join('\n      - ')}`);
  }
}

/** Every key on `obj` is in required∪optional, and every required key is present. */
function assertKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  where: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(obj)) {
    assert(allowed.has(k), `${where}: unexpected key "${k}"`);
  }
  for (const r of required) {
    assert(Object.prototype.hasOwnProperty.call(obj, r), `${where}: missing key "${r}"`);
  }
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Fixture loaders.
// ---------------------------------------------------------------------------

const GOLDEN_DIR = path.join(ROOT, 'fixtures', 'ontology-golden');
const SAMPLE_DIR = path.join(ROOT, 'fixtures', 'spec-samples');

async function loadGoldenFixtures(): Promise<{ file: string; ontology: Ontology }[]> {
  const files = (await fs.readdir(GOLDEN_DIR)).filter((f) => f.endsWith('.json')).sort();
  const out: { file: string; ontology: Ontology }[] = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(GOLDEN_DIR, file), 'utf8');
    out.push({ file, ontology: JSON.parse(raw) as Ontology });
  }
  return out;
}

async function loadSample(name: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(SAMPLE_DIR, name), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Field-key contracts (the canonical spec shape).
// ---------------------------------------------------------------------------

const OBJECT_KEYS = ['id', 'name', 'description', 'type', 'relationship_description', 'primary_key', 'properties'];
const PROPERTY_REQ = ['name', 'type', 'description'];
const PROPERTY_OPT = ['is_foreign_key', 'references'];
const RULE_KEYS = [
  'id', 'specificScenarioStage', 'businessLogicRuleName', 'applicableClient', 'applicableDepartment',
  'submissionCriteria', 'standardizedLogicRule', 'relatedEntities', 'businessBackgroundReason',
  'ruleSource', 'executor', 'enforcementLevel', 'failurePolicy',
];
const ACTION_KEYS = [
  'id', 'name', 'description', 'submission_criteria', 'object_type', 'category', 'actor', 'trigger',
  'target_objects', 'inputs', 'outputs', 'action_steps', 'system_prompt', 'user_prompt', 'tool_use',
  'side_effects', 'triggered_event',
];
const INPUT_REQ = ['name', 'type', 'description', 'required'];
const INPUT_OPT = ['source_object'];
const OUTPUT_REQ = ['name', 'type', 'description'];
const STEP_REQ = ['order', 'name', 'description', 'object_type', 'submission_criteria'];
const STEP_OPT = ['rules'];
const EVENT_KEYS = ['name', 'description', 'payload'];
const PAYLOAD_KEYS = ['source_action', 'event_data', 'state_mutations'];
const EVENT_DATA_KEYS = ['name', 'type', 'target_object'];
const STATE_MUT_KEYS = ['target_object', 'mutation_type', 'impacted_properties'];
const WORKFLOW_KEYS = ['id', 'name', 'description', 'actor', 'trigger', 'actions', 'triggered_event'];
const WF_STEP_KEYS = ['order', 'name', 'description', 'type', 'condition'];

// ===========================================================================
// Run.
// ===========================================================================

async function main(): Promise<void> {
  const fixtures = await loadGoldenFixtures();
  assert(fixtures.length > 0, 'no golden fixtures found');

  // -------------------------------------------------------------------------
  section('1. Reference-sample contract self-check (fixtures/spec-samples)');

  await check('objects_sample conforms to the object shape validator', async () => {
    const data = await loadSample('objects_sample.json');
    assertNoIssues(validateSpecObjects(data.objects), 'objects_sample');
  });
  await check('rules_sample conforms to the rule shape validator', async () => {
    const data = await loadSample('rules_sample.json');
    assertNoIssues(validateSpecRules(data.rules), 'rules_sample');
  });
  await check('actions_sample conforms to the action shape validator', async () => {
    const data = await loadSample('actions_sample.json');
    assertNoIssues(validateSpecActions(data.actions), 'actions_sample');
  });
  await check('events_sample conforms to the event shape validator', async () => {
    const data = await loadSample('events_sample.json');
    assertNoIssues(validateSpecEvents(data.events), 'events_sample');
  });
  await check('workflow_sample conforms to the workflow shape validator', async () => {
    const data = await loadSample('workflow_sample.json');
    assertNoIssues(validateSpecWorkflows(data.workflows), 'workflow_sample');
  });

  // -------------------------------------------------------------------------
  section('2. Pure helper unit tests');

  await check('mapDataType maps the full closed DataType vocabulary', () => {
    assertEq(mapDataType('string'), 'String', 'string');
    assertEq(mapDataType('integer'), 'Integer', 'integer');
    assertEq(mapDataType('decimal'), 'Float', 'decimal');
    assertEq(mapDataType('money'), 'Float', 'money');
    assertEq(mapDataType('boolean'), 'Boolean', 'boolean');
    assertEq(mapDataType('date'), 'Date', 'date');
    assertEq(mapDataType('datetime'), 'Timestamp', 'datetime');
    assertEq(mapDataType('uuid'), 'String', 'uuid');
    assertEq(mapDataType('enum'), 'String', 'enum');
    assertEq(mapDataType('reference'), 'String', 'reference');
    assertEq(mapDataType('json'), 'String', 'json');
    assertEq(mapDataType('array'), 'List<String>', 'array');
    assertEq(mapDataType(undefined), 'String', 'undefined');
  });

  await check('specObjectId strips prefix and PascalCase_underscores', () => {
    assertEq(specObjectId('objectType:credit-assessment'), 'Credit_Assessment', 'kebab');
    assertEq(specObjectId('objectType:order'), 'Order', 'simple');
    assertEq(specObjectId('objectType:job.requisition.spec'), 'Job_Requisition_Spec', 'dotted');
  });

  await check('eventSpecName uppercases to UPPER_SNAKE', () => {
    assertEq(eventSpecName('event:order.fulfilled'), 'ORDER_FULFILLED', 'prefixed');
    assertEq(eventSpecName('order.fulfilled'), 'ORDER_FULFILLED', 'bare');
    assertEq(eventSpecName('customer.signup.submitted'), 'CUSTOMER_SIGNUP_SUBMITTED', 'multi');
  });

  await check('defaultPrimaryKey prefers the object primary_key, else <id>_id', () => {
    const withPk = { primary_key: 'order_no' } as unknown as ObjectType;
    assertEq(defaultPrimaryKey(withPk, 'Order'), 'order_no', 'explicit primary_key');
    const noPk = { properties: [{ name: 'x', type: 'String', description: '' }] } as unknown as ObjectType;
    assertEq(defaultPrimaryKey(noPk, 'Job_Requisition_Specification'), 'job_requisition_specification_id', 'default');
  });

  // -------------------------------------------------------------------------
  section('3. Projection passes validateSpecBundle on every golden fixture');

  for (const { file, ontology } of fixtures) {
    await check(`${file}: projects to a valid spec bundle`, () => {
      const bundle = ontologyToSpec(ontology);
      assertEq(bundle.objects.length, ontology.objects.length, 'object count preserved');
      assertEq(bundle.rules.length, ontology.rules.length, 'rule count preserved');
      assertEq(bundle.actions.length, ontology.actions.length, 'action count preserved');
      assertEq(bundle.events.length, ontology.events.length, 'event count preserved');
      assertEq(bundle.workflows.length, ontology.processes.length, 'workflow count preserved');
      assertNoIssues(validateSpecBundle(bundle), `${file} bundle`);
    });
  }

  // -------------------------------------------------------------------------
  section('4. EXACT field-key conformance of every projected node');

  for (const { file, ontology } of fixtures) {
    await check(`${file}: every node carries exactly the spec keys`, () => {
      const b = ontologyToSpec(ontology);

      b.objects.forEach((o, i) => {
        assertKeys(o as unknown as Record<string, unknown>, OBJECT_KEYS, [], `${file} objects[${i}]`);
        o.properties.forEach((p, j) =>
          assertKeys(p as unknown as Record<string, unknown>, PROPERTY_REQ, PROPERTY_OPT, `${file} objects[${i}].properties[${j}]`),
        );
      });

      b.rules.forEach((r, i) =>
        assertKeys(r as unknown as Record<string, unknown>, RULE_KEYS, [], `${file} rules[${i}]`),
      );

      b.actions.forEach((a, i) => {
        assertKeys(a as unknown as Record<string, unknown>, ACTION_KEYS, [], `${file} actions[${i}]`);
        a.inputs.forEach((io, j) =>
          assertKeys(io as unknown as Record<string, unknown>, INPUT_REQ, INPUT_OPT, `${file} actions[${i}].inputs[${j}]`),
        );
        a.outputs.forEach((io, j) =>
          assertKeys(io as unknown as Record<string, unknown>, OUTPUT_REQ, [], `${file} actions[${i}].outputs[${j}]`),
        );
        a.action_steps.forEach((s, j) =>
          assertKeys(s as unknown as Record<string, unknown>, STEP_REQ, STEP_OPT, `${file} actions[${i}].action_steps[${j}]`),
        );
      });

      b.events.forEach((e, i) => {
        assertKeys(e as unknown as Record<string, unknown>, EVENT_KEYS, [], `${file} events[${i}]`);
        assertKeys(e.payload as unknown as Record<string, unknown>, PAYLOAD_KEYS, [], `${file} events[${i}].payload`);
        e.payload.event_data.forEach((d, j) =>
          assertKeys(d as unknown as Record<string, unknown>, EVENT_DATA_KEYS, [], `${file} events[${i}].payload.event_data[${j}]`),
        );
        e.payload.state_mutations.forEach((m, j) =>
          assertKeys(m as unknown as Record<string, unknown>, STATE_MUT_KEYS, [], `${file} events[${i}].payload.state_mutations[${j}]`),
        );
      });

      b.workflows.forEach((w, i) => {
        assertKeys(w as unknown as Record<string, unknown>, WORKFLOW_KEYS, [], `${file} workflows[${i}]`);
        w.actions.forEach((s, j) =>
          assertKeys(s as unknown as Record<string, unknown>, WF_STEP_KEYS, [], `${file} workflows[${i}].actions[${j}]`),
        );
      });
    });
  }

  // -------------------------------------------------------------------------
  section('5. Targeted derivations + value constraints');

  await check('object type is always data|system; properties typed in spec vocab', () => {
    for (const { ontology } of fixtures) {
      for (const o of ontologyToSpec(ontology).objects) {
        assert(o.type === 'data' || o.type === 'system', `bad object type ${o.type}`);
        assert(o.primary_key.length > 0, 'empty primary_key');
        assert(o.relationship_description.length > 0, 'empty relationship_description');
      }
    }
  });

  await check('primary_key defaults to <snake(id)>_id when no pk attribute', () => {
    // Synthetic ontology: one object with no pk attribute.
    const o: Ontology = {
      ...baseOntology(),
      objects: [
        {
          id: 'objectType:purchase-order',
          uuid: 'u1',
          name: 'PurchaseOrder',
          nameZh: '采购订单',
          description: 'A PO.',
          type: 'data',
          relationship_description: '',
          // primary_key intentionally omitted -> projection must default it.
          properties: [{ name: 'amount', type: 'Float', description: 'Amount.' }],
          sources: [{ documentId: 'd', documentName: 'd', snippet: 's' }],
          confidence: 1,
          provenance: 'extracted',
          reviewState: 'accepted',
        } as unknown as ObjectType,
      ],
    };
    const spec = ontologyToSpec(o);
    assertEq(spec.objects[0]!.id, 'Purchase_Order', 'spec id');
    assertEq(spec.objects[0]!.primary_key, 'purchase_order_id', 'defaulted pk');
  });

  await check('FK references resolve only to present objects; else plain property', () => {
    const o: Ontology = {
      ...baseOntology(),
      objects: [
        {
          id: 'objectType:order', uuid: 'u1', name: 'Order', nameZh: '订单', description: 'o',
          type: 'data', relationship_description: '', primary_key: 'order_id',
          properties: [
            { name: 'order_id', type: 'String', description: 'PK.' },
            { name: 'customer_id', type: 'String', description: 'FK.', is_foreign_key: true, references: 'objectType:customer' },
            { name: 'ghost_id', type: 'String', description: 'Dangling FK.', is_foreign_key: true, references: 'objectType:ghost' },
          ],
          sources: [{ documentId: 'd', documentName: 'd', snippet: 's' }],
          confidence: 1, provenance: 'extracted', reviewState: 'accepted',
        },
        {
          id: 'objectType:customer', uuid: 'u2', name: 'Customer', nameZh: '客户', description: 'c',
          type: 'data', relationship_description: '', primary_key: 'customer_id',
          properties: [{ name: 'customer_id', type: 'String', description: 'PK.' }],
          sources: [{ documentId: 'd', documentName: 'd', snippet: 's' }],
          confidence: 1, provenance: 'extracted', reviewState: 'accepted',
        },
      ],
    };
    const order = ontologyToSpec(o).objects.find((x) => x.id === 'Order')!;
    const fk = order.properties.find((p) => p.name === 'customer_id')!;
    assertEq(fk.is_foreign_key, true, 'resolved fk flagged');
    assertEq(fk.references, 'Customer', 'resolved fk references');
    const ghost = order.properties.find((p) => p.name === 'ghost_id')!;
    assertEq(ghost.is_foreign_key, undefined, 'dangling fk not flagged');
    assertEq(ghost.references, undefined, 'dangling fk has no references');
    assertNoIssues(validateSpecBundle(ontologyToSpec(o)), 'fk bundle');
  });

  await check('rule enforcement/failure derive from severity; executor passthrough', () => {
    const o: Ontology = {
      ...baseOntology(),
      objects: [{
        id: 'objectType:order', uuid: 'u1', name: 'Order', nameZh: '订单', description: 'o',
        type: 'data', relationship_description: '', primary_key: 'order_id',
        properties: [{ name: 'order_id', type: 'String', description: 'PK.' }],
        sources: [{ documentId: 'd', documentName: 'd', snippet: 's' }], confidence: 1, provenance: 'extracted', reviewState: 'accepted',
      }],
      rules: [
        {
          id: 'rule:hard', uuid: 'r1', title: 'Hard rule', statement: { en: 'must', zh: '必须' }, formal: 'x',
          kind: 'constraint', severity: 'block', appliesToObjectTypeIds: ['objectType:order'],
          sources: [{ documentId: 'd', documentName: 'SOP.md', snippet: 's', sentenceRefs: [1] }],
          confidence: 1, provenance: 'extracted', reviewState: 'accepted',
        },
        {
          id: 'rule:soft', uuid: 'r2', title: 'Soft rule', statement: { en: 'should', zh: '应当' }, formal: 'y',
          kind: 'validation', severity: 'warn', executor: 'Human', appliesToObjectTypeIds: ['objectType:order'],
          sources: [{ documentId: 'd', documentName: 'SOP.md', snippet: 's', sentenceRefs: [2] }],
          confidence: 1, provenance: 'extracted', reviewState: 'accepted',
        },
      ],
    };
    const rules = ontologyToSpec(o).rules;
    const hard = rules.find((r) => r.id === 'hard')!;
    assertEq(hard.enforcementLevel, 'mandatory', 'block -> mandatory');
    assertEq(hard.failurePolicy, 'block', 'block -> block');
    assertEq(hard.executor, 'Agent', 'default executor');
    assertEq(hard.relatedEntities[0], 'Order (Order)', 'relatedEntities');
    assertEq(hard.ruleSource, 'SOP.md', 'ruleSource from citation');
    const soft = rules.find((r) => r.id === 'soft')!;
    assertEq(soft.enforcementLevel, 'optional', 'warn -> optional');
    assertEq(soft.failurePolicy, 'warn', 'warn -> warn');
    assertEq(soft.executor, 'Human', 'executor passthrough');
  });

  await check('system object classified by heuristic when type absent', () => {
    const o: Ontology = {
      ...baseOntology(),
      objects: [
        {
          // `type` intentionally omitted -> projection must apply the heuristic.
          id: 'objectType:raas-system', uuid: 'u1', name: 'RAAS_System', nameZh: 'RAAS系统', description: 's',
          relationship_description: '', primary_key: 'raas_system_id', properties: [],
          sources: [{ documentId: 'd', documentName: 'd', snippet: 's' }],
          confidence: 1, provenance: 'extracted', reviewState: 'accepted',
        } as unknown as ObjectType,
        {
          id: 'objectType:candidate', uuid: 'u2', name: 'Candidate', nameZh: '候选人', description: 'c',
          type: 'data', relationship_description: '', primary_key: 'candidate_id', properties: [],
          sources: [{ documentId: 'd', documentName: 'd', snippet: 's' }],
          confidence: 1, provenance: 'extracted', reviewState: 'accepted',
        },
      ],
    };
    const spec = ontologyToSpec(o).objects;
    assertEq(spec.find((x) => x.id === 'Raas_System')!.type, 'system', 'system heuristic');
    assertEq(spec.find((x) => x.id === 'Candidate')!.type, 'data', 'data passthrough');
  });

  // -------------------------------------------------------------------------
  section('6. Determinism + file wrapper');

  await check('projection is byte-stable across runs', () => {
    for (const { ontology } of fixtures) {
      const a = JSON.stringify(ontologyToSpec(ontology));
      const b = JSON.stringify(ontologyToSpec(ontology));
      assertEq(a, b, 'stable bytes');
    }
  });

  await check('objects file wrapper carries a metadata header', () => {
    const f = ontologyToSpecObjectsFile(fixtures[0]!.ontology);
    assert(isRec(f.metadata), 'metadata present');
    assert(typeof f.metadata.project_name === 'string', 'project_name');
    assert(Array.isArray(f.objects), 'objects array');
  });

  // -------------------------------------------------------------------------
  section('7. CANONICAL object schema conformance (the migrated internal model)');

  const PROP_TYPE_SET = new Set<string>(PROPERTY_TYPES);
  const isValidPropType = (t: unknown): boolean =>
    typeof t === 'string' && (PROP_TYPE_SET.has(t) || /^List<.+>$/.test(t));

  for (const { file, ontology } of fixtures) {
    await check(`${file}: every canonical object uses the spec field shape`, () => {
      const objectIds = new Set(ontology.objects.map((o) => o.id));
      for (const o of ontology.objects) {
        // object-level required fields
        assert(o.type === 'data' || o.type === 'system', `${o.id}: type must be data|system, got ${JSON.stringify(o.type)}`);
        assert(typeof o.relationship_description === 'string' && o.relationship_description.length > 0, `${o.id}: relationship_description must be a non-empty string`);
        assert(typeof o.primary_key === 'string' && o.primary_key.length > 0, `${o.id}: primary_key must be a non-empty string`);
        assert(Array.isArray(o.properties), `${o.id}: properties must be an array`);
        // legacy fields must be GONE
        assert(!('attributes' in o), `${o.id}: legacy "attributes" must be removed`);
        for (const p of o.properties) {
          assert(typeof p.name === 'string' && p.name.length > 0, `${o.id}.${p.name}: property name`);
          assert(isValidSpecishType(p.type), `${o.id}.${p.name}: type "${p.type}" not in the closed property vocabulary`);
          assert(typeof p.description === 'string', `${o.id}.${p.name}: description must be a string`);
          assert(!('keyRole' in p), `${o.id}.${p.name}: legacy "keyRole" must be removed`);
          assert(!('enumValues' in p), `${o.id}.${p.name}: legacy "enumValues" must be removed`);
          assert(!('refObjectTypeId' in p), `${o.id}.${p.name}: legacy "refObjectTypeId" must be removed`);
          if (p.is_foreign_key) {
            assert(typeof p.references === 'string' && objectIds.has(p.references), `${o.id}.${p.name}: fk references must resolve to an object id`);
          }
        }
      }
      function isValidSpecishType(t: unknown): boolean {
        return isValidPropType(t);
      }
    });
  }

  await check('no canonical property type is a legacy/lowercase DataType', () => {
    for (const { ontology } of fixtures) {
      for (const o of ontology.objects) {
        for (const p of o.properties) {
          assert(p.type !== 'enum' && p.type !== 'string' && p.type !== 'uuid', `${o.id}.${p.name}: legacy type ${p.type}`);
        }
      }
    }
  });

  await check('migrated fixtures still pass the canonical validateOntology', () => {
    for (const { file, ontology } of fixtures) {
      const errors = validateOntology(ontology).filter((i) => i.level === 'error');
      assert(errors.length === 0, `${file}: ${errors.length} validator error(s): ${errors.slice(0, 3).map((e) => `${e.kind}@${e.from}`).join(', ')}`);
    }
  });

  for (const { file, ontology } of fixtures) {
    await check(`${file}: every canonical rule carries the spec fields`, () => {
      const objectIds = new Set(ontology.objects.map((o) => o.id));
      for (const r of ontology.rules) {
        for (const k of [
          'specificScenarioStage', 'businessLogicRuleName', 'applicableClient', 'applicableDepartment',
          'submissionCriteria', 'standardizedLogicRule', 'businessBackgroundReason', 'ruleSource',
        ]) {
          assert(typeof (r as unknown as Record<string, unknown>)[k] === 'string', `${r.id}: rule field "${k}" must be a string`);
        }
        assert(Array.isArray(r.relatedEntities), `${r.id}: relatedEntities must be an array`);
        assert(r.executor === 'Human' || r.executor === 'Agent', `${r.id}: executor must be Human|Agent, got ${JSON.stringify(r.executor)}`);
        assert(r.enforcementLevel === 'mandatory' || r.enforcementLevel === 'optional', `${r.id}: enforcementLevel invalid`);
        assert(r.failurePolicy === 'warn' || r.failurePolicy === 'block', `${r.id}: failurePolicy invalid`);
        // relatedEntities ids resolve to a real object
        for (const entry of r.relatedEntities) {
          const m = /\(([^()]+)\)\s*$/.exec(entry);
          if (m) {
            const specId = m[1]!;
            const internal = `objectType:${specId.replace(/_/g, '-').toLowerCase()}`;
            assert(objectIds.has(internal) || [...objectIds].some((id) => specObjectId(id) === specId), `${r.id}: relatedEntities "${specId}" does not resolve`);
          }
        }
      }
    });
  }

  const ACTORS = new Set(['Human', 'Agent', 'System']);
  for (const { file, ontology } of fixtures) {
    await check(`${file}: every canonical action carries the spec fields`, () => {
      const objSpecIds = new Set(ontology.objects.map((o) => specObjectId(o.id)));
      const eventSpecNames = new Set(ontology.events.map((e) => eventSpecName(e.name || e.id)));
      for (const a of ontology.actions) {
        for (const k of ['submission_criteria', 'category', 'system_prompt', 'user_prompt']) {
          assert(typeof (a as unknown as Record<string, unknown>)[k] === 'string', `${a.id}: action field "${k}" must be a string`);
        }
        assert(a.object_type === 'action', `${a.id}: object_type must be "action"`);
        assert(Array.isArray(a.actor) && a.actor.every((x) => ACTORS.has(x)), `${a.id}: actor must be [Human|Agent|System]`);
        for (const k of ['trigger', 'target_objects', 'tool_use', 'triggered_event']) {
          const v = (a as unknown as Record<string, unknown>)[k];
          assert(Array.isArray(v) && v.every((x) => typeof x === 'string'), `${a.id}: "${k}" must be string[]`);
        }
        assert(Array.isArray(a.action_steps), `${a.id}: action_steps must be an array`);
        assert(a.side_effects && Array.isArray(a.side_effects.data_changes) && Array.isArray(a.side_effects.notifications), `${a.id}: side_effects shape`);
        assert(!!a.actorRef && typeof a.actorRef.kind === 'string', `${a.id}: actorRef (retained) must be present`);
        // cross-refs resolve
        for (const oid of a.target_objects) assert(objSpecIds.has(oid), `${a.id}: target_objects "${oid}" does not resolve`);
        for (const ev of a.trigger) assert(eventSpecNames.has(ev), `${a.id}: trigger "${ev}" does not resolve`);
        for (const ev of a.triggered_event) assert(eventSpecNames.has(ev), `${a.id}: triggered_event "${ev}" does not resolve`);
        // inputs are spec-typed
        for (const io of a.inputs) {
          assert(typeof io.type === 'string' && io.type.length > 0, `${a.id}.${io.name}: input type`);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Summary.
  // -------------------------------------------------------------------------
  let pass = 0;
  let fail = 0;
  for (const s of sections) {
    pass += s.pass;
    fail += s.fail;
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`spec-format tests: ${pass} passed, ${fail} failed across ${sections.length} sections`);
  for (const s of sections) {
    if (s.fail > 0) console.log(`  ✗ ${s.name}: ${s.fail} failed`);
  }
  if (fail > 0) process.exit(1);
}

/** A minimal valid Ontology envelope for synthetic test cases. */
function baseOntology(): Ontology {
  return {
    id: 'ontology:test',
    uuid: 'uuid-test',
    name: 'Test Ontology',
    domain: 'generic',
    version: 1,
    schemaVersion: 1,
    status: 'draft',
    sourceDocuments: [],
    objects: [],
    rules: [],
    actions: [],
    events: [],
    processes: [],
    relationships: [],
    confidence: 1,
    metadata: { createdAt: '2026-06-17T00:00:00.000Z', updatedAt: '2026-06-17T00:00:00.000Z' },
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
