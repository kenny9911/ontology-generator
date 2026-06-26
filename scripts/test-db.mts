// ============================================================================
//  test-db.mts — deterministic verification suite for DATABASE INGESTION (M0).
//  docs/DATABASE_INGESTION_DESIGN.md §5. No DB, no LLM, no network: every check
//  is pure/deterministic over fixture `DbModel`s. Run with `npm run test:db`
//  (or `npx tsx scripts/test-db.mts`). Exits 1 on any failure.
//
//  Sections:
//    1. sqlTypeToPropertyType — SQL family -> closed PropertyType vocabulary
//    2. seed-objects — tables/columns/FKs -> objects + relationships (pg fixture)
//    3. seed-rules   — CHECK / multi-col UNIQUE -> constraint rules (pg fixture)
//    4. mysql fixture — enum + tinyint(1) type mapping, FK endpoints
//    5. textualize round-trip — every column / FK / check / unique appears
//    6. GROUNDING SURVIVAL — the linchpin: every seeded citation is verbatim,
//       groundSources sets quoteVerified, dropUngroundedNodes keeps everything
//    7. validateOntology — a seeded ontology has zero error-level issues
// ============================================================================

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import type {
  Ontology,
  ObjectType,
  ParsedSource,
  Relationship,
  Rule,
  SourceDocument,
} from '../api/_shared/ontology-schema.js';
import { SCHEMA_VERSION_NUMBER } from '../api/_shared/ontology-schema.js';
import { validateOntology } from '../api/_shared/ontology-validate.js';
import { groundSources, dropUngroundedNodes } from '../api/ontology-gen/pipeline/ground.js';
import type { StageContext } from '../api/ontology-gen/pipeline/context.js';
import { extractObjects } from '../api/ontology-gen/pipeline/stages/objects.js';
import { extractRules } from '../api/ontology-gen/pipeline/stages/rules.js';
import { extractActions } from '../api/ontology-gen/pipeline/stages/actions.js';
import { extractEvents } from '../api/ontology-gen/pipeline/stages/events.js';
import { parseDdl } from '../api/ontology-gen/db/parse/ddl.js';
import { parseInfoSchemaJson } from '../api/ontology-gen/db/parse/info-schema-json.js';

import type { DbModel } from '../api/ontology-gen/db/types.js';
import { seedObjects, sqlTypeToPropertyType, tableObjectId } from '../api/ontology-gen/db/seed-objects.js';
import { seedRules } from '../api/ontology-gen/db/seed-rules.js';
import {
  SCHEMA_DOC_ID,
  buildSchemaEvidence,
  textualizeSchema,
  tableHeaderSnippet,
  columnLine,
  foreignKeyLine,
  checkLine,
  uniqueLine,
} from '../api/ontology-gen/db/textualize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = path.join(ROOT, 'fixtures', 'db-samples');

// ---------------------------------------------------------------------------
// Tiny harness (mirrors scripts/test-hyper.mts).
// ---------------------------------------------------------------------------

interface SectionResult { name: string; pass: number; fail: number; }
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

async function loadModel(file: string): Promise<DbModel> {
  return JSON.parse(await fs.readFile(path.join(SAMPLES, file), 'utf8')) as DbModel;
}

// ---------------------------------------------------------------------------
// Section 1 — SQL type mapping
// ---------------------------------------------------------------------------

async function sectionTypeMap(): Promise<void> {
  section('SQL type -> PropertyType');
  const cases: [string, string][] = [
    ['bigint', 'Integer'], ['int', 'Integer'], ['integer', 'Integer'], ['smallint', 'Integer'],
    ['serial', 'Integer'], ['tinyint', 'Integer'], ['bit', 'Integer'],
    ['numeric(12,2)', 'Float'], ['decimal', 'Float'], ['double precision', 'Float'],
    ['real', 'Float'], ['money', 'Float'], ['float8', 'Float'],
    ['boolean', 'Boolean'], ['bool', 'Boolean'], ['tinyint(1)', 'Boolean'],
    ['date', 'Date'],
    ['timestamptz', 'Timestamp'], ['timestamp without time zone', 'Timestamp'], ['datetime', 'Timestamp'],
    ['varchar(255)', 'String'], ['text', 'String'], ['uuid', 'String'], ['jsonb', 'String'], ['inet', 'String'],
    ["enum('a','b')", 'List<String>'], ['set', 'List<String>'], ['text[]', 'List<String>'], ['integer[]', 'List<String>'],
    ['int unsigned', 'Integer'], ['bigint unsigned', 'Integer'],
    ['character varying(255)', 'String'], ['double precision', 'Float'],
    ['timestamp with time zone', 'Timestamp'],
    ['', 'String'], ['weird_unknown_type', 'String'],
  ];
  for (const [input, expected] of cases) {
    await check(`${input || '(empty)'} -> ${expected}`, () => {
      assertEq(sqlTypeToPropertyType(input), expected, `mapping ${input}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Section 2 — seed-objects (postgres)
// ---------------------------------------------------------------------------

async function sectionSeedObjects(): Promise<void> {
  section('seed-objects (postgres-retail)');
  const model = await loadModel('postgres-retail.json');
  const taken = new Set<string>();
  const { objects, relationships } = seedObjects(model, taken);

  await check('one object per table, one relationship per (in-model) FK', () => {
    assertEq(objects.length, 4, 'object count');
    const fkCount = model.tables.reduce((n, t) => n + t.foreignKeys.length, 0);
    assertEq(relationships.length, fkCount, 'relationship count');
    assertEq(relationships.length, 3, 'relationship count (anchor)');
  });

  await check('object ids are fully-qualified, dot-free, and registered in taken', () => {
    const id = tableObjectId('public', 'orders');
    assertEq(id, 'objectType:public-orders', 'orders object id');
    assert(!id.includes('.'), 'object id carries no dot (disjoint from id.attr form)');
    assert(objects.some((o) => o.id === id), 'orders object present');
    assert(taken.has(id), 'id registered in taken');
  });

  await check('orders object: type, primary_key, property types', () => {
    const orders = objects.find((o) => o.id === 'objectType:public-orders')!;
    assertEq(orders.type, 'data', 'orders is data');
    assertEq(orders.primary_key, 'order_id', 'primary_key from PK');
    assertEq(orders.properties.length, 5, 'orders property count');
    const status = orders.properties.find((p) => p.name === 'status')!;
    assertEq(status.type, 'String', 'status is String (enum scalar -> rule, not List)');
    const total = orders.properties.find((p) => p.name === 'total_amount')!;
    assertEq(total.type, 'Float', 'numeric -> Float');
  });

  await check('FK wires property reference + relationship endpoints + cardinality', () => {
    const orders = objects.find((o) => o.id === 'objectType:public-orders')!;
    const custCol = orders.properties.find((p) => p.name === 'customer_id')!;
    assertEq(custCol.is_foreign_key, true, 'customer_id is FK');
    assertEq(custCol.references, 'objectType:public-customers', 'FK references parent object id');
    const rel = relationships.find(
      (r) => r.sourceObjectTypeId === 'objectType:public-orders' && r.targetObjectTypeId === 'objectType:public-customers',
    )!;
    assert(!!rel, 'orders->customers relationship exists');
    assertEq(rel.cardinality, 'many_to_one', 'FK to non-unique parent ref is many_to_one');
    assertEq(rel.viaAttribute, 'customer_id', 'viaAttribute is the FK column');
  });

  await check('every seeded node carries exactly one verbatim citation', () => {
    for (const o of objects) assert(o.sources.length === 1 && !!o.sources[0]!.snippet, `object ${o.id} cited`);
    for (const r of relationships) assert(r.sources.length === 1 && !!r.sources[0]!.snippet, `rel ${r.id} cited`);
  });
}

// ---------------------------------------------------------------------------
// Section 3 — seed-rules (postgres)
// ---------------------------------------------------------------------------

async function sectionSeedRules(): Promise<void> {
  section('seed-rules (postgres-retail)');
  const model = await loadModel('postgres-retail.json');
  const taken = new Set<string>();
  const { objects } = seedObjects(model, taken);
  const rules = seedRules(model, objects, taken, 'ontology:test');

  await check('one rule per CHECK + one per multi-col UNIQUE', () => {
    const checks = model.tables.reduce((n, t) => n + t.checks.length, 0);
    const multiUniques = model.tables.reduce((n, t) => n + t.uniques.filter((u) => u.columns.length >= 2).length, 0);
    assertEq(checks, 5, 'check count (anchor)');
    assertEq(multiUniques, 2, 'multi-col unique count (anchor)');
    assertEq(rules.length, checks + multiUniques, 'rule count');
  });

  await check('single-column UNIQUE does NOT become a rule', () => {
    // customers.email + products.sku are single-col uniques -> structural only.
    const uniqueRuleCols = rules.filter((r) => r.kind === 'constraint').map((r) => r.formal);
    assert(!uniqueRuleCols.includes('UNIQUE (email)'), 'no rule for single-col email unique');
    assert(!uniqueRuleCols.includes('UNIQUE (sku)'), 'no rule for single-col sku unique');
  });

  await check('check rule: attaches to table, severity block, bilingual, appliesToAttributes', () => {
    const statusRule = rules.find((r) => r.formal === "status IN ('pending','paid','shipped','cancelled')")!;
    assert(!!statusRule, 'orders.status check rule exists');
    assertEq(statusRule.kind, 'validation', 'CHECK -> validation');
    assertEq(statusRule.severity, 'block', 'constraint is blocking');
    assertEq(statusRule.enforcementLevel, 'mandatory', 'mandatory');
    assertEq(statusRule.appliesToObjectTypeIds[0], 'objectType:public-orders', 'attached to orders');
    assert(statusRule.appliesToAttributes?.includes('objectType:public-orders.status') ?? false, 'appliesToAttributes set');
    assert(statusRule.statement.en.length > 0 && statusRule.statement.zh.length > 0, 'bilingual statement');
    assertEq(statusRule.provenance, 'extracted', 'extracted');
  });

  await check('unique rule present with formal UNIQUE(...)', () => {
    const uq = rules.find((r) => r.formal === 'UNIQUE (customer_id, order_no)')!;
    assert(!!uq, 'orders multi-col unique rule exists');
    assertEq(uq.kind, 'constraint', 'UNIQUE -> constraint');
    assertEq(uq.appliesToObjectTypeIds[0], 'objectType:public-orders', 'attached to orders');
  });

  await check('all rule ids unique + every required spec field non-empty', () => {
    const ids = new Set(rules.map((r) => r.id));
    assertEq(ids.size, rules.length, 'rule ids unique');
    for (const r of rules) {
      assert(r.businessLogicRuleName.length > 0, `${r.id} businessLogicRuleName`);
      assert(r.standardizedLogicRule.length > 0, `${r.id} standardizedLogicRule`);
      assert(r.relatedEntities.length > 0, `${r.id} relatedEntities`);
      assert(r.ruleSource.length > 0, `${r.id} ruleSource`);
    }
  });
}

// ---------------------------------------------------------------------------
// Section 4 — mysql fixture (enum + tinyint(1), FK endpoints)
// ---------------------------------------------------------------------------

async function sectionMysql(): Promise<void> {
  section('seed (mysql-blog): enum + boolean + FK endpoints');
  const model = await loadModel('mysql-blog.json');
  const taken = new Set<string>();
  const { objects, relationships } = seedObjects(model, taken);
  const rules = seedRules(model, objects, taken, 'ontology:test-mysql');

  await check('3 objects, 3 relationships', () => {
    assertEq(objects.length, 3, 'object count');
    assertEq(relationships.length, 3, 'relationship count');
  });

  await check('enum -> List<String>, tinyint(1) -> Boolean', () => {
    const users = objects.find((o) => o.id === tableObjectId('blog', 'users'))!;
    assertEq(users.properties.find((p) => p.name === 'role')!.type, 'List<String>', 'role enum -> List<String>');
    assertEq(users.properties.find((p) => p.name === 'is_active')!.type, 'Boolean', 'tinyint(1) -> Boolean');
    assertEq(users.properties.find((p) => p.name === 'view_count' )?.type, undefined, 'no view_count on users');
    const posts = objects.find((o) => o.id === tableObjectId('blog', 'posts'))!;
    assertEq(posts.properties.find((p) => p.name === 'status')!.type, 'List<String>', 'status enum -> List<String>');
    assertEq(posts.properties.find((p) => p.name === 'view_count')!.type, 'Integer', 'int -> Integer');
  });

  await check('FK to users(id) resolves to the users object id', () => {
    const posts = objects.find((o) => o.id === tableObjectId('blog', 'posts'))!;
    const authorCol = posts.properties.find((p) => p.name === 'author_id')!;
    assertEq(authorCol.references, tableObjectId('blog', 'users'), 'author_id -> users');
  });

  await check('only the multi-col unique becomes a rule (1 rule, no checks)', () => {
    assertEq(rules.length, 1, 'one rule (posts author_id+title)');
    assertEq(rules[0]!.formal, 'UNIQUE (author_id, title)', 'the multi-col unique');
  });
}

// ---------------------------------------------------------------------------
// Section 5 — textualize round-trip
// ---------------------------------------------------------------------------

async function sectionTextualize(): Promise<void> {
  section('textualize round-trip (every element appears verbatim)');
  for (const file of ['postgres-retail.json', 'mysql-blog.json']) {
    const model = await loadModel(file);
    const text = textualizeSchema(model);
    await check(`${file}: every table / column / FK / check / unique is in the evidence text`, () => {
      for (const t of model.tables) {
        assert(text.includes(tableHeaderSnippet(t)), `header ${t.name}`);
        for (const c of t.columns) assert(text.includes(columnLine(t, c)), `column ${t.name}.${c.name}`);
        for (const fk of t.foreignKeys) assert(text.includes(foreignKeyLine(fk)), `fk on ${t.name}`);
        for (const chk of t.checks) assert(text.includes(checkLine(chk)), `check on ${t.name}`);
        for (const u of t.uniques) assert(text.includes(uniqueLine(u)), `unique on ${t.name}`);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Section 6 — GROUNDING SURVIVAL (the linchpin)
// ---------------------------------------------------------------------------

async function sectionGrounding(): Promise<void> {
  section('grounding survival (THE LINCHPIN)');
  for (const file of ['postgres-retail.json', 'mysql-blog.json']) {
    const model = await loadModel(file);
    const taken = new Set<string>();
    const { objects, relationships } = seedObjects(model, taken);
    const rules = seedRules(model, objects, taken, 'ontology:test');
    const evidence: ParsedSource = buildSchemaEvidence(model);

    // The real grounding code, run against the real evidence text.
    groundSources(objects, [evidence]);
    groundSources(relationships, [evidence]);
    groundSources(rules, [evidence]);

    await check(`${file}: every citation is verbatim-located (quoteVerified) and indexed to the db doc`, () => {
      const all = [...objects, ...relationships, ...rules];
      for (const node of all) {
        for (const s of node.sources) {
          assertEq(s.documentId, SCHEMA_DOC_ID, `citation points at the db evidence doc (${node.id})`);
          assertEq(s.quoteVerified, true, `quoteVerified for ${node.id} :: "${s.snippet}"`);
          assert(typeof s.charStart === 'number' && typeof s.charEnd === 'number', `offsets set for ${node.id}`);
        }
      }
    });

    await check(`${file}: dropUngroundedNodes keeps EVERY seeded node`, () => {
      assertEq(dropUngroundedNodes(objects).length, objects.length, 'no object dropped');
      assertEq(dropUngroundedNodes(relationships).length, relationships.length, 'no relationship dropped');
      assertEq(dropUngroundedNodes(rules).length, rules.length, 'no rule dropped');
    });
  }
}

// ---------------------------------------------------------------------------
// Section 7 — validateOntology integration
// ---------------------------------------------------------------------------

function assembleOntology(objects: ObjectType[], relationships: Relationship[], rules: Rule[]): Ontology {
  const sourceDoc: SourceDocument = {
    id: SCHEMA_DOC_ID,
    uuid: randomUUID(),
    name: 'Database Schema',
    kind: 'db',
    parsedRef: 'parsed_db_schema',
  };
  return {
    id: 'ontology:db-test',
    uuid: randomUUID(),
    name: 'DB Test',
    domain: 'generic',
    version: 1,
    schemaVersion: SCHEMA_VERSION_NUMBER,
    status: 'draft',
    sourceDocuments: [sourceDoc],
    objects,
    rules,
    actions: [],
    events: [],
    processes: [],
    relationships,
    ruleGroups: [],
    confidence: 0.9,
    metadata: { createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  };
}

async function sectionValidate(): Promise<void> {
  section('validateOntology — seeded ontology has zero error-level issues');
  for (const file of ['postgres-retail.json', 'mysql-blog.json']) {
    const model = await loadModel(file);
    const taken = new Set<string>();
    const { objects, relationships } = seedObjects(model, taken);
    const rules = seedRules(model, objects, taken, 'ontology:db-test');
    const evidence = buildSchemaEvidence(model);
    groundSources(objects, [evidence]);
    groundSources(relationships, [evidence]);
    groundSources(rules, [evidence]);

    const ontology = assembleOntology(objects, relationships, rules);
    const issues = validateOntology(ontology);
    const errors = issues.filter((i) => i.level === 'error');

    await check(`${file}: no error-level validation issues`, () => {
      assertEq(errors.length, 0, `errors: ${errors.map((e) => `${e.kind}@${e.from}`).join(', ')}`);
    });
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Section 8 — stage branch dispatch (ctx.dbModel) — no LLM (no agentLlm resolver)
// ---------------------------------------------------------------------------

function dbContext(model: DbModel): StageContext {
  return {
    ontologyId: 'ontology:db-test',
    domain: 'generic',
    sources: [{ id: SCHEMA_DOC_ID, uuid: 'u-db', name: 'Database Schema', kind: 'db', parsedRef: 'parsed_db_schema' }],
    parsed: [buildSchemaEvidence(model)],
    taken: new Set<string>(),
    objects: [],
    relationships: [],
    rules: [],
    ruleGroups: [],
    actions: [],
    events: [],
    processes: [],
    model: 'test-model',
    provider: 'test',
    userInfo: null,
    log: () => {},
    dbModel: model,
    // agentLlm intentionally omitted -> enrichObjects is a no-op (LLM-free test).
  };
}

async function sectionStageBranch(): Promise<void> {
  section('stage branch dispatch (ctx.dbModel, no LLM)');
  const model = await loadModel('postgres-retail.json');

  await check('extractObjects routes to the deterministic seed; enrich skipped', async () => {
    const ctx = dbContext(model);
    const { objects, relationships } = await extractObjects(ctx);
    assertEq(objects.length, 4, 'objects via stage branch');
    assertEq(relationships.length, 3, 'relationships via stage branch');
    const orders = objects.find((o) => o.id === 'objectType:public-orders')!;
    assertEq(orders.nameZh, 'orders', 'enrich skipped without resolver -> seed placeholder kept');
  });

  await check('extractRules routes to the deterministic constraint-rule seed', async () => {
    const ctx = dbContext(model);
    ctx.objects = seedObjects(model, ctx.taken).objects; // orchestrator populates ctx.objects first
    const { rules, ruleGroups } = await extractRules(ctx);
    assertEq(rules.length, 7, 'constraint rules via stage branch');
    assertEq(ruleGroups.length, 0, 'no rule groups');
  });
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Section 9 — DDL parse (pg_dump / mysqldump) -> DbModel -> seed -> ground
// ---------------------------------------------------------------------------

async function loadText(file: string): Promise<string> {
  return fs.readFile(path.join(SAMPLES, file), 'utf8');
}

function assertGrounded(objects: ObjectType[], relationships: Relationship[], rules: Rule[], model: DbModel): void {
  const evidence = buildSchemaEvidence(model);
  groundSources(objects, [evidence]);
  groundSources(relationships, [evidence]);
  groundSources(rules, [evidence]);
  for (const n of [...objects, ...relationships, ...rules]) {
    for (const s of n.sources) assertEq(s.quoteVerified, true, `grounded ${n.id} :: "${s.snippet}"`);
  }
}

async function sectionDdl(): Promise<void> {
  section('DDL parse (pg_dump / mysqldump)');

  const pg = parseDdl(await loadText('postgres-retail.sql'), { dialect: 'postgres' });
  await check('pg: 4 tables in public, in declared order', () => {
    assertEq(pg.tables.length, 4, 'tables');
    assertEq(pg.schemas.join(','), 'public', 'schemas');
    assertEq(pg.tables.map((t) => t.name).join(','), 'customers,products,orders,order_items', 'order');
  });

  await check('pg: orders — PK (from ALTER), types, FK, checks, unique, comment', () => {
    const o = pg.tables.find((t) => t.name === 'orders')!;
    assertEq(o.comment, 'Customer order headers', 'table comment');
    assertEq(o.primaryKey.join(','), 'order_id', 'PK lifted from ALTER TABLE');
    assertEq(o.columns.length, 5, 'columns');
    assertEq(sqlTypeToPropertyType(o.columns.find((c) => c.name === 'total_amount')!.sqlType), 'Float', 'numeric->Float');
    assertEq(sqlTypeToPropertyType(o.columns.find((c) => c.name === 'status')!.sqlType), 'String', 'character varying->String');
    assertEq(o.checks.length, 2, 'two checks');
    assertEq(o.columns.find((c) => c.name === 'status')!.enumValues?.join(','), 'pending,paid,shipped,cancelled', 'enum lifted from CHECK IN');
    assertEq(o.uniques.length, 1, 'one (multi-col) unique');
    assertEq(o.uniques[0]!.columns.join(','), 'customer_id,order_no', 'unique cols');
    const fk = o.foreignKeys[0]!;
    assertEq(fk.refTable, 'customers', 'FK ref table');
    assertEq(fk.refColumns.join(','), 'customer_id', 'FK ref col');
    assertEq(fk.onDelete, 'RESTRICT', 'on delete');
  });

  await check('pg: column comment via COMMENT ON COLUMN', () => {
    const c = pg.tables.find((t) => t.name === 'customers')!;
    assertEq(c.columns.find((x) => x.name === 'customer_id')!.comment, 'Surrogate key', 'col comment');
  });

  await check('pg: CREATE VIEW parsed into model.views', () => {
    assertEq(pg.views.length, 1, 'one view');
    assertEq(pg.views[0]!.name, 'active_orders', 'view name');
    assertEq(pg.views[0]!.schema, 'public', 'view schema');
    assert(!!pg.views[0]!.definition && /select/i.test(pg.views[0]!.definition), 'view definition captured');
  });

  await check('pg: parse -> seed -> ground survives end to end on real DDL (incl. view)', () => {
    const taken = new Set<string>();
    const { objects, relationships } = seedObjects(pg, taken);
    const rules = seedRules(pg, objects, taken, 'ontology:pg');
    assertEq(objects.length, 5, 'objects (4 tables + 1 view)');
    assertEq(relationships.length, 3, 'relationships');
    assertEq(rules.length, 7, 'rules (5 checks + 2 multi-uniques)');
    const view = objects.find((o) => o.id === tableObjectId('public', 'active_orders'))!;
    assert(!!view, 'view -> object');
    assertEq(view.relationship_description, 'active_orders is a database view.', 'view rel desc');
    assertGrounded(objects, relationships, rules, pg);
  });

  const my = parseDdl(await loadText('mysql-blog.sql'), { dialect: 'mysql' });
  await check('mysql: 3 tables in `blog` (schema from USE)', () => {
    assertEq(my.tables.length, 3, 'tables');
    assertEq(my.schemas.join(','), 'blog', 'schema from USE');
  });

  await check('mysql: enum + tinyint(1) + inline PK/UNIQUE/FK, plain KEY skipped', () => {
    const users = my.tables.find((t) => t.name === 'users')!;
    assertEq(users.comment, 'Blog accounts', 'table comment');
    assertEq(users.primaryKey.join(','), 'id', 'inline PK');
    const role = users.columns.find((c) => c.name === 'role')!;
    assertEq(sqlTypeToPropertyType(role.sqlType), 'List<String>', 'enum->List<String>');
    assertEq(role.enumValues?.join(','), 'admin,author,reader', 'enum values parsed');
    assertEq(sqlTypeToPropertyType(users.columns.find((c) => c.name === 'is_active')!.sqlType), 'Boolean', 'tinyint(1)->Boolean');
    assertEq(users.uniques.length, 1, 'one unique (email)');
    const posts = my.tables.find((t) => t.name === 'posts')!;
    assertEq(posts.uniques.filter((u) => u.columns.length >= 2).length, 1, 'posts multi-col unique');
    assertEq(posts.foreignKeys[0]!.refTable, 'users', 'posts FK -> users');
    assertEq(posts.foreignKeys[0]!.refColumns.join(','), 'id', 'FK ref col');
    const comments = my.tables.find((t) => t.name === 'comments')!;
    assertEq(comments.foreignKeys.length, 2, 'comments 2 FKs (plain KEY index skipped)');
  });

  await check('mysql: parse -> seed -> ground survives', () => {
    const taken = new Set<string>();
    const { objects, relationships } = seedObjects(my, taken);
    const rules = seedRules(my, objects, taken, 'ontology:my');
    assertEq(objects.length, 3, 'objects');
    assertEq(relationships.length, 3, 'relationships');
    assertGrounded(objects, relationships, rules, my);
  });
}

// ---------------------------------------------------------------------------
// Section 10 — information_schema JSON parse (fallback)
// ---------------------------------------------------------------------------

async function sectionInfoSchema(): Promise<void> {
  section('information_schema JSON parse (fallback)');
  const exp = {
    dialect: 'postgres',
    columns: [
      { table_schema: 'public', table_name: 'team', column_name: 'team_id', data_type: 'bigint', is_nullable: 'NO', ordinal_position: 1 },
      { table_schema: 'public', table_name: 'team', column_name: 'name', data_type: 'varchar(80)', is_nullable: 'NO', ordinal_position: 2 },
      { table_schema: 'public', table_name: 'player', column_name: 'player_id', data_type: 'bigint', is_nullable: 'NO', ordinal_position: 1 },
      { table_schema: 'public', table_name: 'player', column_name: 'team_id', data_type: 'bigint', is_nullable: 'YES', ordinal_position: 2, column_comment: 'owning team' },
    ],
    primaryKeys: [
      { table_schema: 'public', table_name: 'team', column_name: 'team_id' },
      { table_schema: 'public', table_name: 'player', column_name: 'player_id' },
    ],
    foreignKeys: [
      { table_schema: 'public', table_name: 'player', column_name: 'team_id', ref_schema: 'public', ref_table: 'team', ref_column: 'team_id', constraint_name: 'fk_player_team', on_delete: 'CASCADE' },
    ],
    uniques: [{ table_schema: 'public', table_name: 'team', constraint_name: 'uq_team_name', column_name: 'name' }],
    checks: [],
    tableComments: [{ table_schema: 'public', table_name: 'team', comment: 'A team' }],
  };

  await check('grouped export -> tables with PK / FK / unique / comments', () => {
    const model = parseInfoSchemaJson(exp, { dialect: 'postgres' });
    assertEq(model.tables.length, 2, 'tables');
    const team = model.tables.find((t) => t.name === 'team')!;
    assertEq(team.comment, 'A team', 'table comment');
    assertEq(team.primaryKey.join(','), 'team_id', 'pk');
    assertEq(team.uniques.length, 1, 'unique');
    const player = model.tables.find((t) => t.name === 'player')!;
    assertEq(player.foreignKeys[0]!.refTable, 'team', 'fk ref table');
    assertEq(player.foreignKeys[0]!.onDelete, 'CASCADE', 'on delete');
    assertEq(player.columns.find((c) => c.name === 'team_id')!.comment, 'owning team', 'col comment');
  });

  await check('bare column array -> columns-only model (no relationships)', () => {
    const m2 = parseInfoSchemaJson(exp.columns, { dialect: 'postgres' });
    assertEq(m2.tables.length, 2, 'tables');
    assertEq(m2.tables.flatMap((t) => t.foreignKeys).length, 0, 'no FKs in columns-only export');
  });

  await check('parse -> seed -> ground survives', () => {
    const model = parseInfoSchemaJson(exp, { dialect: 'postgres' });
    const taken = new Set<string>();
    const { objects, relationships } = seedObjects(model, taken);
    const rules = seedRules(model, objects, taken, 'ontology:is');
    assertEq(objects.length, 2, 'objects');
    assertEq(relationships.length, 1, 'relationship');
    assertGrounded(objects, relationships, rules, model);
  });
}

// ---------------------------------------------------------------------------
// Section 11 — live-introspection -> parser contract (the row shapes the live
// introspector emits; the SQL itself needs a real DB, but this seam is testable)
// ---------------------------------------------------------------------------

async function sectionIntrospectionContract(): Promise<void> {
  section('introspection -> parser contract (live row shapes)');

  // EXACT shapes introspect/information-schema.ts emits for PostgreSQL:
  // boolean is_nullable, format_type data_type, CASE-mapped on_delete.
  const pgRows = {
    dialect: 'postgres',
    columns: [
      { table_schema: 'public', table_name: 'customers', column_name: 'customer_id', data_type: 'bigint', is_nullable: false, ordinal_position: 1 },
      { table_schema: 'public', table_name: 'orders', column_name: 'order_id', data_type: 'bigint', is_nullable: false, ordinal_position: 1 },
      { table_schema: 'public', table_name: 'orders', column_name: 'status', data_type: 'character varying(20)', is_nullable: false, ordinal_position: 2 },
      { table_schema: 'public', table_name: 'orders', column_name: 'total_amount', data_type: 'numeric(12,2)', is_nullable: false, ordinal_position: 3 },
      { table_schema: 'public', table_name: 'orders', column_name: 'customer_id', data_type: 'bigint', is_nullable: true, ordinal_position: 4 },
    ],
    primaryKeys: [
      { table_schema: 'public', table_name: 'customers', column_name: 'customer_id', ordinal_position: 1 },
      { table_schema: 'public', table_name: 'orders', column_name: 'order_id', ordinal_position: 1 },
    ],
    foreignKeys: [
      { table_schema: 'public', table_name: 'orders', column_name: 'customer_id', ref_schema: 'public', ref_table: 'customers', ref_column: 'customer_id', constraint_name: 'fk_oc', on_delete: 'CASCADE', ordinal_position: 1 },
    ],
    uniques: [],
    checks: [{ table_schema: 'public', table_name: 'orders', constraint_name: 'ck_status', check_clause: "status IN ('pending','paid')" }],
    tableComments: [{ table_schema: 'public', table_name: 'orders', comment: 'Orders' }],
  };

  await check('PG live rows (boolean nullability, format_type, on_delete CASE) -> DbModel -> ground', () => {
    const m = parseInfoSchemaJson(pgRows, { dialect: 'postgres' });
    const orders = m.tables.find((t) => t.name === 'orders')!;
    assertEq(orders.comment, 'Orders', 'table comment');
    assertEq(orders.primaryKey.join(','), 'order_id', 'pk');
    assertEq(orders.columns.find((c) => c.name === 'order_id')!.nullable, false, 'boolean is_nullable=false');
    assertEq(orders.columns.find((c) => c.name === 'customer_id')!.nullable, true, 'boolean is_nullable=true');
    assertEq(sqlTypeToPropertyType(orders.columns.find((c) => c.name === 'status')!.sqlType), 'String', 'character varying -> String');
    assertEq(sqlTypeToPropertyType(orders.columns.find((c) => c.name === 'total_amount')!.sqlType), 'Float', 'numeric -> Float');
    assertEq(orders.foreignKeys[0]!.refTable, 'customers', 'fk ref table');
    assertEq(orders.foreignKeys[0]!.onDelete, 'CASCADE', 'on delete');
    assertEq(orders.checks.length, 1, 'check present');
    // End to end: parse -> seed -> ground survives.
    const taken = new Set<string>();
    const { objects, relationships } = seedObjects(m, taken);
    const rules = seedRules(m, objects, taken, 'ontology:pglive');
    assertEq(objects.length, 2, 'objects');
    assertEq(relationships.length, 1, 'relationship');
    assertGrounded(objects, relationships, rules, m);
  });

  // MySQL live shape: column_type carries enum + length; column_key='PRI' flags PK.
  const myRows = {
    dialect: 'mysql',
    columns: [
      { table_schema: 'blog', table_name: 'users', column_name: 'id', data_type: 'bigint', column_type: 'bigint', is_nullable: 'NO', ordinal_position: 1, column_key: 'PRI' },
      { table_schema: 'blog', table_name: 'users', column_name: 'role', data_type: 'enum', column_type: "enum('admin','reader')", is_nullable: 'NO', ordinal_position: 2 },
      { table_schema: 'blog', table_name: 'users', column_name: 'active', data_type: 'tinyint', column_type: 'tinyint(1)', is_nullable: 'NO', ordinal_position: 3 },
    ],
    foreignKeys: [],
    uniques: [],
    checks: [],
  };

  await check('MySQL live rows (column_type enum/tinyint(1), column_key PRI) -> DbModel', () => {
    const m = parseInfoSchemaJson(myRows, { dialect: 'mysql' });
    const users = m.tables.find((t) => t.name === 'users')!;
    assertEq(users.primaryKey.join(','), 'id', 'pk from column_key=PRI');
    const role = users.columns.find((c) => c.name === 'role')!;
    assertEq(sqlTypeToPropertyType(role.sqlType), 'List<String>', 'enum column_type -> List<String>');
    assertEq(role.enumValues?.join(','), 'admin,reader', 'enum values from column_type');
    assertEq(sqlTypeToPropertyType(users.columns.find((c) => c.name === 'active')!.sqlType), 'Boolean', 'tinyint(1) -> Boolean');
  });
}

// ---------------------------------------------------------------------------
// Section 12 — views -> derived objects (M1: a view is a queryable concept)
// ---------------------------------------------------------------------------

async function sectionViews(): Promise<void> {
  section('views -> derived objects');
  const model: DbModel = {
    dialect: 'postgres',
    sourceKind: 'live',
    schemas: ['public'],
    tables: [
      { schema: 'public', name: 'orders', comment: '', columns: [{ name: 'order_id', sqlType: 'bigint', nullable: false }], primaryKey: ['order_id'], uniques: [], checks: [], foreignKeys: [] },
    ],
    views: [
      {
        schema: 'public', name: 'active_orders', comment: 'Non-cancelled orders', definition: 'SELECT ...',
        columns: [
          { name: 'order_id', sqlType: 'bigint', nullable: false },
          { name: 'status', sqlType: 'varchar(20)', nullable: true },
          { name: 'total_amount', sqlType: 'numeric(12,2)', nullable: false },
        ],
      },
    ],
  };

  await check('view (with columns) -> ObjectType: properties, description, rel-desc', () => {
    const taken = new Set<string>();
    const { objects } = seedObjects(model, taken);
    assertEq(objects.length, 2, '1 table + 1 view');
    const view = objects.find((o) => o.id === tableObjectId('public', 'active_orders'))!;
    assert(!!view, 'view object exists');
    assertEq(view.type, 'data', 'view is a data object');
    assertEq(view.properties.length, 3, 'view columns -> properties');
    assertEq(view.properties.find((p) => p.name === 'total_amount')!.type, 'Float', 'numeric -> Float');
    assertEq(view.description, 'Non-cancelled orders', 'view comment -> description');
    assertEq(view.relationship_description, 'active_orders is a database view.', 'view rel desc kept');
  });

  await check('textualize renders the view header + columns; seeded view grounds', () => {
    const text = textualizeSchema(model);
    assert(text.includes('View public.active_orders:'), 'view header in evidence');
    assert(text.includes('Non-cancelled orders'), 'view comment in evidence');
    const taken = new Set<string>();
    const { objects } = seedObjects(model, taken);
    groundSources(objects, [buildSchemaEvidence(model)]);
    for (const o of objects) for (const s of o.sources) assertEq(s.quoteVerified, true, `grounded ${o.id}`);
    assertEq(dropUngroundedNodes(objects).length, objects.length, 'no object dropped');
  });
}

// ---------------------------------------------------------------------------
// Section 13 — stored routines -> actions (M1, deterministic, no LLM)
// ---------------------------------------------------------------------------

async function sectionRoutines(): Promise<void> {
  section('routines -> actions (M1)');
  const model: DbModel = {
    dialect: 'postgres',
    sourceKind: 'live',
    schemas: ['public'],
    tables: [
      {
        schema: 'public', name: 'orders', comment: '',
        columns: [
          { name: 'order_id', sqlType: 'bigint', nullable: false },
          { name: 'customer_id', sqlType: 'bigint', nullable: false },
          { name: 'status', sqlType: 'varchar(20)', nullable: false },
        ],
        primaryKey: ['order_id'], uniques: [], checks: [], foreignKeys: [],
      },
    ],
    views: [],
    routines: [
      {
        schema: 'public', name: 'create_order', kind: 'procedure', language: 'plpgsql',
        params: [
          { name: 'p_customer_id', mode: 'IN', sqlType: 'bigint' },
          { name: 'p_status', mode: 'IN', sqlType: 'varchar(20)' },
        ],
        definition: 'CREATE PROCEDURE public.create_order(p_customer_id bigint, p_status varchar) AS $$ BEGIN INSERT INTO public.orders(customer_id, status) VALUES (p_customer_id, p_status); END; $$',
        comment: 'Create a new order',
      },
    ],
  };

  await check('extractActions(routines) -> action: inputs, function tool, DML side-effects', async () => {
    const ctx = dbContext(model);
    ctx.objects = seedObjects(model, ctx.taken).objects;
    const { actions } = await extractActions(ctx);
    assertEq(actions.length, 1, 'one action');
    const a = actions[0]!;
    assertEq(a.name, 'createOrder', 'camelCase action name');
    assertEq(a.inputs.length, 2, 'two inputs from IN params');
    assertEq(a.inputs.find((i) => i.name === 'p_customer_id')!.type, 'Integer', 'bigint -> Integer');
    assertEq(a.agent.execution, 'function', 'execution = function');
    assertEq(a.agent.integration, 'public.create_order', 'integration = schema.name');
    assertEq(a.object_type, 'action', 'attachActionSpecFields filled spec fields');
    assert(a.actor.includes('System'), 'actor System');
    const dc = a.side_effects.data_changes ?? [];
    assert(dc.some((d) => /order/i.test(d.object_type) && d.action === 'CREATE'), 'INSERT INTO orders -> CREATE data_change');
  });

  await check('routine header in evidence; proc-derived action grounds (quoteVerified)', async () => {
    const text = textualizeSchema(model);
    assert(text.includes('Procedure public.create_order('), 'routine signature in evidence');
    const ctx = dbContext(model);
    ctx.objects = seedObjects(model, ctx.taken).objects;
    const { actions } = await extractActions(ctx);
    groundSources(actions, ctx.parsed);
    for (const a of actions) for (const s of a.sources) assertEq(s.quoteVerified, true, `action grounded ${a.id}`);
  });
}

// ---------------------------------------------------------------------------
// Section 14 — triggers -> events (M1, deterministic, no LLM)
// ---------------------------------------------------------------------------

async function sectionTriggers(): Promise<void> {
  section('triggers -> events (M1)');
  const model: DbModel = {
    dialect: 'postgres',
    sourceKind: 'live',
    schemas: ['public'],
    tables: [
      { schema: 'public', name: 'orders', comment: '', columns: [{ name: 'order_id', sqlType: 'bigint', nullable: false }], primaryKey: ['order_id'], uniques: [], checks: [], foreignKeys: [] },
    ],
    views: [],
    triggers: [
      { schema: 'public', table: 'orders', name: 'trg_orders_audit', timing: 'AFTER', events: ['INSERT', 'UPDATE'], definition: 'CREATE TRIGGER trg_orders_audit AFTER INSERT OR UPDATE ON public.orders FOR EACH ROW ...', comment: 'Audit orders' },
    ],
  };

  await check('extractEvents(triggers) -> one event per (table, op): names, payload, grounding', async () => {
    const ctx = dbContext(model);
    ctx.objects = seedObjects(model, ctx.taken).objects;
    const { events } = await extractEvents(ctx);
    assertEq(events.length, 2, 'INSERT + UPDATE -> 2 events');
    assertEq(events.map((e) => e.name).sort().join(','), 'ORDERS_INSERTED,ORDERS_UPDATED', 'event names');
    const ins = events.find((e) => e.name === 'ORDERS_INSERTED')!;
    assertEq(ins.provenance, 'extracted', 'extracted');
    assertEq(ins.payload.state_mutations[0]!.mutation_type, 'INSERT', 'state mutation = INSERT');
    assert(/Public_Orders/.test(ins.payload.state_mutations[0]!.target_object), 'mutation targets the orders object');
    groundSources(events, ctx.parsed);
    for (const e of events) for (const s of e.sources) assertEq(s.quoteVerified, true, `event grounded ${e.id}`);
  });

  await check('textualize renders the trigger signature', () => {
    const text = textualizeSchema(model);
    assert(text.includes('Trigger trg_orders_audit AFTER INSERT OR UPDATE ON public.orders:'), 'trigger header in evidence');
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('test-db — deterministic verification suite for database ingestion (M0)');

  await sectionTypeMap();
  await sectionSeedObjects();
  await sectionSeedRules();
  await sectionMysql();
  await sectionTextualize();
  await sectionGrounding();
  await sectionValidate();
  await sectionStageBranch();
  await sectionDdl();
  await sectionInfoSchema();
  await sectionIntrospectionContract();
  await sectionViews();
  await sectionRoutines();
  await sectionTriggers();

  console.log('\n== Summary ==');
  let pass = 0;
  let fail = 0;
  for (const s of sections) {
    pass += s.pass;
    fail += s.fail;
    console.log(`  ${s.fail === 0 ? '✓' : '✗'} ${s.name}: ${s.pass} passed, ${s.fail} failed`);
  }
  console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('test-db crashed:', err);
  process.exit(1);
});
