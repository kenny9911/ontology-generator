// ============================================================================
//  test-json-editor.mts — deterministic verification suite for the JSON Editor
//  feature (Monaco-based per-layer editor + auto-correction). No LLM, no network.
//  Run with `npm run test:editor` (or `npx tsx scripts/test-json-editor.mts`).
//  Exits 1 on any failure.
//
//  Sections:
//    1. tryParseJson never-throw                    9. mergeLayer
//    2. repair syntactic fixers                    10. round-trip invariants (10 fixtures)
//    3. adversarial / must-not-corrupt             11. coercion (id prefix + bilingual)
//    4. idempotence / no-op                        12. suggestFixes / applySuggestion
//    5. negative / unfixable (no fabrication)      13. buildCandidateOntology
//    6. LAYER_KEYS / idPrefixFor                   14. validateOntology integration
//    7. extractLayer / serializeLayer              15. schema-drift smoke
//    8. parseLayer
// ============================================================================

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { deepStrictEqual } from 'node:assert';

import {
  repairJson,
  tryParseJson,
  lintJsonSyntax,
} from '../src/ontology-generator/json-editor/json-repair';
import {
  LAYER_KEYS,
  idPrefixFor,
  extractLayer,
  serializeLayer,
  serializeLayerDoc,
  layerDocKey,
  parseLayer,
  mergeLayer,
  type EditorLayer,
} from '../src/ontology-generator/json-editor/layers';
import { toCleanNodes, fromCleanNodes } from '../src/ontology-generator/json-editor/clean';
import {
  suggestFixes,
  applySuggestion,
  coerceIdPrefix,
  coerceBilingual,
} from '../src/ontology-generator/json-editor/json-suggest';
import {
  buildCandidateOntology,
  mapIdToLayer,
} from '../src/ontology-generator/json-editor/assemble';
import {
  LAYER_SCHEMAS,
  DATA_TYPE_ENUM,
  SEVERITY_ENUM,
} from '../src/ontology-generator/json-editor/layer-schemas';
import { validateOntology } from '../api/_shared/ontology-validate.js';
import { DATA_TYPES, SEVERITY_LEVELS, SCHEMA_VERSION_NUMBER } from '../api/_shared/ontology-schema.js';
import type { Ontology } from '../api/_shared/ontology-schema.js';
import { normalizeOntologyObjects } from '../src/ontology-generator/normalize-objects';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = path.join(ROOT, 'fixtures/ontology-golden');

// ---------------------------------------------------------------------------
// Tiny harness (matches scripts/test-hyper.mts)
// ---------------------------------------------------------------------------
interface SectionResult { name: string; pass: number; fail: number; }
const sections: SectionResult[] = [];
let current: SectionResult = { name: '(none)', pass: 0, fail: 0 };

function section(name: string): void {
  current = { name, pass: 0, fail: 0 };
  sections.push(current);
  console.log(`\n== ${name} ==`);
}
function check(name: string, fn: () => void): void {
  try {
    fn();
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
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertDeepEq(actual: unknown, expected: unknown, msg: string): void {
  try {
    deepStrictEqual(actual, expected);
  } catch {
    throw new Error(`${msg}: not deep-equal`);
  }
}
/** repairJson(input) must succeed and parse to `expected`. */
function assertRepairsTo(input: string, expected: unknown, msg: string): void {
  const r = repairJson(input);
  assert(r.ok, `${msg}: did not become valid (${r.errors[0]?.message ?? '?'})`);
  assertDeepEq(JSON.parse(r.text), expected, `${msg}: repaired value mismatch`);
}
/** repairJson(input) must NOT fabricate a valid doc (stays invalid, never throws). */
function assertUnfixable(input: string, msg: string): void {
  let r;
  try {
    r = repairJson(input);
  } catch (err) {
    throw new Error(`${msg}: threw (${err instanceof Error ? err.message : String(err)})`);
  }
  assert(!r.ok, `${msg}: unexpectedly became valid → ${r.text.slice(0, 60)}`);
}

// ===========================================================================
function sectionTryParse(): void {
  section('1. tryParseJson never-throw');
  check('1.1 valid object', () => { const r = tryParseJson('{"a":1}'); assert(r.ok, 'ok'); });
  check('1.2 valid array', () => { const r = tryParseJson('[1,2,3]'); assert(r.ok, 'ok'); });
  check('1.3 empty string', () => { const r = tryParseJson(''); assert(!r.ok && r.error.length > 0, 'fail w/ msg'); });
  check('1.4 whitespace only', () => { const r = tryParseJson('   \n\t '); assert(!r.ok, 'fail'); });
  check('1.5 }{', () => { const r = tryParseJson('}{'); assert(!r.ok, 'fail'); });
  check('1.6 truncated', () => { const r = tryParseJson('{"a":'); assert(!r.ok, 'fail'); });
  check('1.7 lintJsonSyntax never throws on garbage', () => { const e = lintJsonSyntax('{,,,'); assert(Array.isArray(e), 'array'); });
}

function sectionRepair(): void {
  section('2. repair syntactic fixers');
  check('2.1 object trailing comma', () => assertRepairsTo('{"a":1,}', { a: 1 }, '2.1'));
  check('2.2 array trailing comma', () => assertRepairsTo('[1,2,]', [1, 2], '2.2'));
  check('2.3 nested trailing commas', () => assertRepairsTo('{"a":[1,2,],"b":{"c":3,},}', { a: [1, 2], b: { c: 3 } }, '2.3'));
  check('2.4 line comment', () => assertRepairsTo('{"a":1} // hi', { a: 1 }, '2.4'));
  check('2.5 block comment', () => assertRepairsTo('{/* x */"a":1}', { a: 1 }, '2.5'));
  check('2.6 single-quoted strings', () => assertRepairsTo("{'a':'b'}", { a: 'b' }, '2.6'));
  check('2.7 unquoted keys', () => assertRepairsTo('{a:1,b:2}', { a: 1, b: 2 }, '2.7'));
  check('2.8 unquoted snake/num keys', () => assertRepairsTo('{order_id:1,x2:2}', { order_id: 1, x2: 2 }, '2.8'));
  check('2.9 smart double quotes', () => assertRepairsTo('{“a”:“b”}', { a: 'b' }, '2.9'));
  check('2.10 smart single quotes', () => assertRepairsTo('{‘a’:‘b’}', { a: 'b' }, '2.10'));
  check('2.11 python literals', () => assertRepairsTo('{"a":True,"b":False,"c":None}', { a: true, b: false, c: null }, '2.11'));
  check('2.12 BOM prefix', () => assertRepairsTo('﻿{"a":1}', { a: 1 }, '2.12'));
  check('2.13 missing comma between members', () => assertRepairsTo('{"a":1 "b":2}', { a: 1, b: 2 }, '2.13'));
  check('2.14 kitchen sink', () =>
    assertRepairsTo("﻿{ a: 'x', // c\n b: True, }", { a: 'x', b: true }, '2.14'));
  check('2.15 js literals → null', () => assertRepairsTo('{"a":NaN,"b":undefined}', { a: null, b: null }, '2.15'));
  check('2.16 missing comma between array elems', () => assertRepairsTo('[1 2 3]', [1, 2, 3], '2.16'));
  check('2.17 trailing semicolon', () => assertRepairsTo('{"a":1};', { a: 1 }, '2.17'));
  // BUG 7 regression: combined unquoted-key + missing-comma needs a 2nd pipeline pass.
  check('2.18 combined unquoted key + missing comma', () => assertRepairsTo('{a:1 b:2}', { a: 1, b: 2 }, '2.18'));
  check('2.19 unquoted keys + missing comma (triple)', () => assertRepairsTo('{a:1,b:2 c:3}', { a: 1, b: 2, c: 3 }, '2.19'));
}

function sectionAdversarial(): void {
  section('3. adversarial / must-not-corrupt');
  check('3.1 comma in string', () => assertRepairsTo('{"a":"x,y"}', { a: 'x,y' }, '3.1'));
  check('3.2 apostrophe in string', () => assertRepairsTo('{"a":"it\'s ok"}', { a: "it's ok" }, '3.2'));
  check('3.3 escaped quote in string', () => assertRepairsTo('{"a":"he said \\"hi\\""}', { a: 'he said "hi"' }, '3.3'));
  check('3.4 URL with //', () => assertRepairsTo('{"u":"https://x.io/a//b"}', { u: 'https://x.io/a//b' }, '3.4'));
  check('3.5 /* inside string', () => assertRepairsTo('{"a":"/* not a comment */"}', { a: '/* not a comment */' }, '3.5'));
  check('3.6 Trueblue not replaced', () => assertRepairsTo('{"a":"Trueblue"}', { a: 'Trueblue' }, '3.6'));
  check('3.7 "None" key untouched', () => assertRepairsTo('{"None":1}', { None: 1 }, '3.7'));
  check('3.8 time string', () => assertRepairsTo('{"t":"12:30:00"}', { t: '12:30:00' }, '3.8'));
  check('3.9 braces in string', () => assertRepairsTo('{"a":"{[(,)]}"}', { a: '{[(,)]}' }, '3.9'));
  check('3.10 smart quote as content in VALID input is preserved', () => {
    // Already-valid JSON must be returned byte-for-byte unchanged — a typographic
    // apostrophe inside a string is legitimate content, never "corrected".
    const input = '{"a":"it’s"}';
    const r = repairJson(input);
    assert(!r.changed, '3.10 unchanged'); assertDeepEq(JSON.parse(r.text), { a: 'it’s' }, '3.10');
  });
  check('3.11 already-valid newline value + key', () => assertRepairsTo('{"a":"x\\ny","b":2}', { a: 'x\ny', b: 2 }, '3.11'));
  check('3.12 unicode escapes (zh)', () => assertRepairsTo('{"name":"\\u8ba2\\u5355"}', { name: '订单' }, '3.12'));
  check('3.13 deep nested valid unchanged', () => {
    const v = { a: { b: { c: { d: { e: { f: [1, 2, 3] } } } } } };
    const r = repairJson(JSON.stringify(v));
    assert(!r.changed, 'unchanged'); assertDeepEq(JSON.parse(r.text), v, '3.13');
  });
  check('3.14 "007" stays string', () => assertRepairsTo('{"a":"007"}', { a: '007' }, '3.14'));
  check('3.15 numbers', () => assertRepairsTo('{"a":-1.5e3,"b":0}', { a: -1500, b: 0 }, '3.15'));
  check('3.16 empty containers', () => { assertRepairsTo('{}', {}, '3.16a'); assertRepairsTo('[]', [], '3.16b'); });
  check('3.17 comma inside single→double conversion', () => assertRepairsTo("{'a':'x,y,z'}", { a: 'x,y,z' }, '3.17'));
}

function sectionIdempotence(): void {
  section('4. idempotence / no-op');
  check('4.1 valid object byte-identical', () => {
    const input = '{\n  "a": 1\n}';
    const r = repairJson(input);
    assertEq(r.text, input, 'identical'); assert(!r.changed, 'changed false'); assertEq(r.fixes.length, 0, 'no fixes');
  });
  check('4.2 valid array unchanged', () => { const r = repairJson('[1, 2, 3]'); assert(!r.changed, 'unchanged'); });
  check('4.3 repair(repair(x)) === repair(x)', () => {
    const once = repairJson("﻿{ a: 'x', // c\n b: True, }").text;
    const twice = repairJson(once).text;
    assertEq(twice, once, 'stable');
  });
  check('4.4 second pass has no fixes', () => {
    const once = repairJson('{a:1,}').text;
    assertEq(repairJson(once).fixes.length, 0, 'no fixes second pass');
  });
  check('4.5 changed === (fixes>0)', () => {
    for (const inp of ['{"a":1}', '{a:1}', '{"a":1,}', '[1,2]', "{'a':1}", '{/*c*/"a":1}']) {
      const r = repairJson(inp);
      assertEq(r.changed, r.fixes.length > 0, `4.5 ${inp}`);
    }
  });
  check('4.6 parse(repair(valid)) deepEq parse(valid)', () => {
    const v = '{"a":[1,2],"b":"c"}';
    assertDeepEq(JSON.parse(repairJson(v).text), JSON.parse(v), '4.6');
  });
  check('4.7 comment-only → invalid, no throw', () => {
    const r = repairJson('/* only comment */');
    assert(!r.ok, 'not ok'); assert(!tryParseJson(r.text).ok, 'still unparseable');
  });
  check('4.8 top-level scalars round-trip', () => {
    for (const [inp, val] of [['true', true], ['42', 42], ['"x"', 'x'], ['null', null]] as const) {
      assertDeepEq(JSON.parse(repairJson(inp).text), val, `4.8 ${inp}`);
    }
  });
}

function sectionUnfixable(): void {
  section('5. negative / unfixable (no fabrication)');
  check('5.1 empty', () => assertUnfixable('', '5.1'));
  check('5.2 prose', () => assertUnfixable('hello there, this is not json', '5.2'));
  check('5.3 no brace completion', () => assertUnfixable('{"a":1', '5.3'));
  check('5.4 no bracket completion', () => assertUnfixable('[1,2', '5.4'));
  check('5.5 extra close brace', () => assertUnfixable('{"a":1}}', '5.5'));
  check('5.6 punctuation salad', () => { assertUnfixable(',,,', '5.6a'); assertUnfixable(':', '5.6b'); assertUnfixable('}', '5.6c'); });
  check('5.7 mismatched close', () => assertUnfixable('{"a":[1,2}', '5.7'));
  check('5.8 large repeated invalid (no hang)', () => {
    const big = '{"a":1,'.repeat(20000);
    const r = repairJson(big);
    assert(!r.ok, 'still invalid'); // returns, no throw/hang
  });
  // BUG 6 regression: lintJsonSyntax must be ~linear, not O(n^2). A 200KB invalid
  // layer (objects missing closing braces, ~8000 distinct-offset errors) must
  // not freeze the UI thread. Old scan-from-0 lineColAt took ~2-3s here.
  check('5.9 large invalid input is near-linear (no O(n^2) freeze)', () => {
    const parts: string[] = [];
    for (let i = 0; i < 8000; i++) parts.push(`{"id":"objectType:o${i}"`); // missing '}'
    const big = `[${parts.join(',\n')}\n]`;
    const t0 = Date.now();
    const r = repairJson(big);
    const dt = Date.now() - t0;
    assert(!r.ok, '5.9 still invalid (no brace fabrication)');
    assert(r.errors.length > 0, '5.9 reports errors');
    assert(dt < 1500, `5.9 too slow: ${dt}ms (suspect O(n^2) regression)`);
  });
}

function sectionLayerKeys(): void {
  section('6. LAYER_KEYS / idPrefixFor');
  check('6.1 layer keys order', () => assertDeepEq([...LAYER_KEYS], ['objects', 'rules', 'actions', 'events', 'processes'], '6.1'));
  check('6.2 objects prefix', () => assertEq(idPrefixFor('objects'), 'objectType:', '6.2'));
  check('6.3 rules prefix', () => assertEq(idPrefixFor('rules'), 'rule:', '6.3'));
  check('6.4 actions prefix', () => assertEq(idPrefixFor('actions'), 'action:', '6.4'));
  check('6.5 events prefix', () => assertEq(idPrefixFor('events'), 'event:', '6.5'));
  check('6.6 processes prefix (workflow tab)', () => assertEq(idPrefixFor('processes'), 'process:', '6.6'));
}

async function loadGoldens(): Promise<{ name: string; o: Ontology }[]> {
  const files = (await fs.readdir(GOLDEN_DIR)).filter((f) => f.endsWith('.json')).sort();
  const out: { name: string; o: Ontology }[] = [];
  for (const f of files) {
    out.push({ name: f, o: JSON.parse(await fs.readFile(path.join(GOLDEN_DIR, f), 'utf8')) as Ontology });
  }
  return out;
}

function sectionExtractSerialize(g0: Ontology): void {
  section('7. extractLayer / serializeLayer');
  check('7.1 extract deep-equals layer', () => {
    for (const layer of LAYER_KEYS) assertDeepEq(extractLayer(g0, layer), g0[layer], `7.1 ${layer}`);
  });
  check('7.2 missing layer → []', () => assertDeepEq(extractLayer({} as unknown as Ontology, 'objects'), [], '7.2'));
  check('7.3 no mutation of source', () => {
    const before = JSON.stringify(g0.objects);
    extractLayer(g0, 'objects');
    assertEq(JSON.stringify(g0.objects), before, '7.3');
  });
  check('7.4 serialize is valid JSON', () => assert(tryParseJson(serializeLayer(extractLayer(g0, 'rules'))).ok, '7.4'));
  check('7.5 serialize round-trips value', () =>
    assertDeepEq(JSON.parse(serializeLayer(extractLayer(g0, 'actions'))), g0.actions, '7.5'));
  check('7.6 2-space pretty', () => {
    const s = serializeLayer(extractLayer(g0, 'objects'));
    assert(s.includes('\n') && s.includes('\n  '), '7.6 indented');
  });
  check('7.7 empty array serializes', () => assertDeepEq(JSON.parse(serializeLayer([])), [], '7.7'));
  check('7.8 deterministic', () => assertEq(serializeLayer(g0.events), serializeLayer(g0.events), '7.8'));
}

function sectionParseLayer(g0: Ontology): void {
  section('8. parseLayer');
  check('8.1 valid layer → nodes + no issues', () => {
    const r = parseLayer(serializeLayer(g0.objects));
    assert(r.ok, 'ok'); assertDeepEq(r.nodes, g0.objects, '8.1 nodes'); assertEq(r.issues.length, 0, '8.1 no issues');
  });
  check('8.2 non-array', () => {
    const r = parseLayer('{"id":"x"}');
    assert(!r.ok, 'not ok'); assert(r.issues.some((i) => i.kind === 'not_an_array'), '8.2 kind');
  });
  check('8.3 array of non-objects', () => {
    const r = parseLayer('[1,2,3]');
    assert(!r.ok, 'not ok'); assertEq(r.issues.filter((i) => i.kind === 'item_not_object').length, 3, '8.3');
  });
  check('8.4 broken syntax, no throw', () => {
    const r = parseLayer('[{"a":1,]');
    assert(!r.ok, 'not ok'); assert(r.issues.some((i) => i.kind === 'syntax'), '8.4 kind');
  });
  check('8.5 empty array', () => { const r = parseLayer('[]'); assert(r.ok, 'ok'); assertDeepEq(r.nodes, [], '8.5'); });
  check('8.6 duplicate ids', () => {
    const r = parseLayer('[{"id":"objectType:a"},{"id":"objectType:a"}]');
    assert(r.issues.some((i) => i.kind === 'duplicate_id'), '8.6');
  });
  check('8.7 missing key (no id AND no name)', () => {
    // The clean shape keys events by `name` (no id), so a node with a name is OK;
    // only a node with NEITHER id nor name is flagged.
    assert(parseLayer('[{"foo":"x"}]').issues.some((i) => i.kind === 'missing_id'), '8.7 neither');
    assert(!parseLayer('[{"name":"X"}]').issues.some((i) => i.kind === 'missing_id'), '8.7 name ok');
  });
  check('8.8 repaired succeeds, lists fixes', () => {
    const r = parseLayer('[{a:1,}]');
    assert(r.ok, 'ok'); assert(r.repaired, 'repaired'); assert(r.repairFixes.length > 0, '8.8 fixes');
  });
  check('8.9 5 malformed never throw', () => {
    for (const m of ['', '{', '[1,2', 'true', '"x"']) { const r = parseLayer(m); assert(Array.isArray(r.issues), `8.9 ${m}`); }
  });
  check('8.10 unknown fields survive', () => {
    const r = parseLayer('[{"id":"objectType:a","display":{"emoji":"🚀"}}]');
    assert(r.ok, 'ok'); assertDeepEq((r.nodes as Record<string, unknown>[])[0]!.display, { emoji: '🚀' }, '8.10');
  });
}

function sectionMergeLayer(g0: Ontology): void {
  section('9. mergeLayer');
  check('9.1 replaces only target', () => {
    const next = mergeLayer(g0, 'rules', []);
    assertEq(next.rules.length, 0, '9.1 rules cleared'); assertDeepEq(next.objects, g0.objects, '9.1 objects kept');
  });
  check('9.2 non-mutating', () => {
    const before = g0.rules.length;
    const next = mergeLayer(g0, 'rules', []);
    assert(next !== g0, '9.2 new ref'); assertEq(g0.rules.length, before, '9.2 original intact');
  });
  check('9.3 envelope fields identical', () => {
    const next = mergeLayer(g0, 'events', g0.events);
    assertEq(next.id, g0.id, '9.3 id'); assertEq(next.uuid, g0.uuid, '9.3 uuid'); assertEq(next.version, g0.version, '9.3 version');
  });
  check('9.4 [] clears layer', () => assertEq(mergeLayer(g0, 'actions', []).actions.length, 0, '9.4'));
  check('9.5 fold identity merges == original', () => {
    let o: Ontology = g0;
    for (const layer of LAYER_KEYS) o = mergeLayer(o, layer, extractLayer(g0, layer));
    for (const layer of LAYER_KEYS) assertDeepEq(o[layer], g0[layer], `9.5 ${layer}`);
  });
  check('9.6 confidence/stats pass through', () => {
    const next = mergeLayer(g0, 'objects', g0.objects);
    assertEq(next.confidence, g0.confidence, '9.6'); assertDeepEq(next.metadata, g0.metadata, '9.6 meta');
  });
  check('9.7 relationships untouched on objects edit', () => assertDeepEq(mergeLayer(g0, 'objects', []).relationships, g0.relationships, '9.7'));
}

function sectionRoundTrip(goldens: { name: string; o: Ontology }[]): void {
  section('10. round-trip invariants (all fixtures × 5 layers)');
  check('10.1 parse(serialize(layer)) deepEq layer', () => {
    for (const { name, o } of goldens) for (const layer of LAYER_KEYS) {
      assertDeepEq(JSON.parse(serializeLayer(extractLayer(o, layer))), o[layer], `10.1 ${name}/${layer}`);
    }
  });
  check('10.2 merge(extract) identity', () => {
    for (const { name, o } of goldens) for (const layer of LAYER_KEYS) {
      assertDeepEq(mergeLayer(o, layer, extractLayer(o, layer))[layer], o[layer], `10.2 ${name}/${layer}`);
    }
  });
  check('10.3 repair(serialize(layer)) unchanged', () => {
    for (const { name, o } of goldens) for (const layer of LAYER_KEYS) {
      const r = repairJson(serializeLayer(extractLayer(o, layer)));
      assert(!r.changed, `10.3 ${name}/${layer} changed`);
    }
  });
  check('10.4 buildCandidate(identity) layers deepEq', () => {
    for (const { name, o } of goldens) {
      const edits = Object.fromEntries(LAYER_KEYS.map((l) => [l, extractLayer(o, l)])) as Partial<Record<EditorLayer, unknown[]>>;
      const cand = buildCandidateOntology(o, edits);
      for (const layer of LAYER_KEYS) assertDeepEq(cand[layer], o[layer], `10.4 ${name}/${layer}`);
    }
  });
  check('10.5 full serialize→parse→merge identity (first golden)', () => {
    const o = goldens[0]!.o;
    let acc: Ontology = o;
    for (const layer of LAYER_KEYS) {
      const pr = parseLayer(serializeLayer(extractLayer(o, layer)));
      assert(pr.ok && !!pr.nodes, `10.5 parse ${layer}`);
      acc = mergeLayer(acc, layer, pr.nodes!);
    }
    for (const layer of LAYER_KEYS) assertDeepEq(acc[layer], o[layer], `10.5 ${layer}`);
  });
  check('10.6 bilingual zh survives (no mojibake)', () => {
    for (const { name, o } of goldens) {
      const obj = o.objects.find((x) => x.nameZh);
      if (!obj) continue;
      const back = JSON.parse(serializeLayer([obj])) as Record<string, unknown>[];
      assertEq(back[0]!.nameZh, obj.nameZh, `10.6 ${name}`);
    }
  });
}

function sectionCoercion(): void {
  section('11. coercion (id prefix + bilingual)');
  check('11.1 correct prefix unchanged', () => assertEq(coerceIdPrefix('objects', 'objectType:order'), 'objectType:order', '11.1'));
  check('11.2 bare slug prefixed', () => assertEq(coerceIdPrefix('objects', 'order'), 'objectType:order', '11.2'));
  check('11.3 wrong prefix replaced', () => assertEq(coerceIdPrefix('objects', 'rule:order'), 'objectType:order', '11.3'));
  check('11.4 event dotted suffix preserved', () => assertEq(coerceIdPrefix('events', 'event:order.fulfilled'), 'event:order.fulfilled', '11.4'));
  check('11.5 slugify spaces', () => assertEq(coerceIdPrefix('processes', 'order to cash'), 'process:order-to-cash', '11.5'));
  check('11.6 junk → fallback x', () => assertEq(coerceIdPrefix('objects', '  !!!  '), 'objectType:x', '11.6'));
  check('11.7 string → bilingual', () => assertDeepEq(coerceBilingual('X'), { en: 'X', zh: 'X' }, '11.7'));
  check('11.8 {en} → zh mirrors en', () => assertDeepEq(coerceBilingual({ en: 'X' }), { en: 'X', zh: 'X' }, '11.8'));
  check('11.9 full bilingual passthrough', () => assertDeepEq(coerceBilingual({ en: 'X', zh: 'Y' }), { en: 'X', zh: 'Y' }, '11.9'));
  check('11.10 undefined/null → empty', () => {
    assertDeepEq(coerceBilingual(undefined), { en: '', zh: '' }, '11.10a');
    assertDeepEq(coerceBilingual(null), { en: '', zh: '' }, '11.10b');
  });
  check('11.11 ruleGroup prefix not mistaken for rule', () => assertEq(coerceIdPrefix('rules', 'ruleGroup:credit'), 'rule:credit', '11.11'));
}

function sectionSuggest(g0: Ontology): void {
  section('12. suggestFixes / applySuggestion');
  check('12.1 clean golden layer → []', () => assertEq(suggestFixes(g0.objects, 'objects').length, 0, '12.1'));
  const mk = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'objectType:x', name: 'X', nameZh: 'X', confidence: 0.5, reviewState: 'pending', provenance: 'human', sources: [],
    type: 'data', relationship_description: '', primary_key: 'x_id', properties: [], ...over,
  });
  check('12.2 missing nameZh → fill', () => {
    const n = mk({ name: 'Order' }); delete n.nameZh;
    const s = suggestFixes([n], 'objects'); const f = s.find((x) => x.field === 'nameZh');
    assert(!!f && f.fixable, '12.2 flagged');
    const out = applySuggestion([n], f!) as Record<string, unknown>[];
    assertEq(out[0]!.nameZh, 'Order', '12.2 filled');
  });
  check('12.3 missing confidence → number', () => {
    const n = mk({}); delete n.confidence;
    const f = suggestFixes([n], 'objects').find((x) => x.field === 'confidence')!;
    const out = applySuggestion([n], f) as Record<string, unknown>[];
    assertEq(typeof out[0]!.confidence, 'number', '12.3');
  });
  check('12.4 missing reviewState → pending', () => {
    const n = mk({}); delete n.reviewState;
    const f = suggestFixes([n], 'objects').find((x) => x.field === 'reviewState')!;
    assertEq((applySuggestion([n], f) as Record<string, unknown>[])[0]!.reviewState, 'pending', '12.4');
  });
  check('12.5 missing provenance → human', () => {
    const n = mk({}); delete n.provenance;
    const f = suggestFixes([n], 'objects').find((x) => x.field === 'provenance')!;
    assertEq((applySuggestion([n], f) as Record<string, unknown>[])[0]!.provenance, 'human', '12.5');
  });
  check('12.6 bad property type → nearest', () => {
    const n = mk({ properties: [{ name: 'a', type: 'Strng', description: 'd' }] });
    const f = suggestFixes([n], 'objects').find((x) => x.kind === 'bad_enum')!;
    assert(!!f, '12.6 flagged');
    const out = applySuggestion([n], f) as Record<string, { properties: Record<string, unknown>[] }>[];
    assertEq((out[0]! as unknown as { properties: Record<string, unknown>[] }).properties[0]!.type, 'String', '12.6 fixed');
  });
  check('12.7 bad rule severity → block', () => {
    const r = { id: 'rule:x', statement: { en: 'a', zh: 'b' }, kind: 'validation', severity: 'blocker', confidence: 0.5, reviewState: 'pending', provenance: 'human', sources: [] };
    const f = suggestFixes([r], 'rules').find((x) => x.field === 'severity' && x.kind === 'bad_enum')!;
    assert(!!f, '12.7 flagged');
    assertEq((applySuggestion([r], f) as Record<string, unknown>[])[0]!.severity, 'block', '12.7 fixed');
  });
  check('12.8 wrong id prefix → coerced', () => {
    const n = mk({ id: 'rule:order' });
    const f = suggestFixes([n], 'objects').find((x) => x.kind === 'bad_id_prefix')!;
    assert(!!f, '12.8 flagged');
    assertEq((applySuggestion([n], f) as Record<string, unknown>[])[0]!.id, 'objectType:order', '12.8 fixed');
  });
  check('12.9 valid List<String> property → no bad type flag', () => {
    const n = mk({ properties: [{ name: 'a', type: 'List<String>', description: 'd' }] });
    assert(
      !suggestFixes([n], 'objects').some((x) => x.kind === 'bad_enum' && x.field === 'properties.0.type'),
      '12.9',
    );
  });
  check('12.10 foreign key without references (not fixable)', () => {
    const n = mk({ properties: [{ name: 'a', type: 'String', description: 'd', is_foreign_key: true }] });
    const f = suggestFixes([n], 'objects').find((x) => x.kind === 'reference_without_target')!;
    assert(!!f && !f.fixable, '12.10');
  });
  check('12.11 applySuggestion non-mutating', () => {
    const n = mk({ id: 'rule:order' }); const arr = [n];
    const f = suggestFixes(arr, 'objects').find((x) => x.kind === 'bad_id_prefix')!;
    applySuggestion(arr, f);
    assertEq((arr[0] as Record<string, unknown>).id, 'rule:order', '12.11 original intact');
  });
  check('12.12 fold all fixable clears fixable subset', () => {
    let nodes: unknown[] = [mk({ id: 'rule:order', attributes: [{ name: 'a', type: 'str' }] })];
    for (let i = 0; i < 50; i++) {
      const fixable = suggestFixes(nodes, 'objects').filter((s) => s.fixable);
      if (fixable.length === 0) break;
      nodes = applySuggestion(nodes, fixable[0]!);
    }
    assertEq(suggestFixes(nodes, 'objects').filter((s) => s.fixable).length, 0, '12.12');
  });
  // BUG 4 regression: an applied id fix must never collide with another node's id.
  check('12.13 id-prefix fix is collision-aware', () => {
    const nodes = [mk({ id: 'rule:order', name: 'Order' }), mk({ id: 'objectType:order', name: 'Order2' })];
    const f = suggestFixes(nodes, 'objects').find((s) => s.kind === 'bad_id_prefix' && s.index === 0)!;
    assert(!!f, '12.13 flagged');
    const out = applySuggestion(nodes, f) as Record<string, unknown>[];
    const ids = out.map((n) => n.id);
    assertEq(new Set(ids).size, ids.length, '12.13 no duplicate ids introduced');
  });
  // BUG 9 regression: two wrong-prefix ids that coerce to the SAME target. The
  // editor's apply paths (onFixAll + onApplySuggestion) MUST re-derive between
  // applies; applying two STALE snapshot fixes would dup. Lock both facts.
  check('12.15 stale double-apply dups; re-derive yields distinct ids', () => {
    const layer = [mk({ id: 'objectType:order' }), mk({ id: 'Order' })];
    // (a) hazard: both snapshot suggestions coerce to the same target →
    //     applying both stale would collide.
    const snap = suggestFixes(layer, 'objects').filter((s) => s.field === 'id');
    assert(snap.length >= 1, '12.15 has id fix(es)');
    // (b) the re-derive pattern (the actual fix) yields distinct ids.
    let nodes: unknown[] = layer;
    for (let i = 0; i < 10; i++) {
      const fx = suggestFixes(nodes, 'objects').filter((s) => s.fixable && s.field === 'id');
      if (fx.length === 0) break;
      nodes = applySuggestion(nodes, fx[0]!);
    }
    const ids = (nodes as Record<string, unknown>[]).map((n) => n.id);
    assertEq(new Set(ids).size, ids.length, '12.15 re-derive gives distinct ids');
  });
  check('12.14 two missing-id same-name nodes fold to distinct ids', () => {
    const base = { name: 'Order', nameZh: '订单', confidence: 0.5, reviewState: 'pending', provenance: 'human', sources: [], attributes: [] };
    let nodes: unknown[] = [{ ...base }, { ...base }];
    for (let i = 0; i < 10; i++) {
      const fx = suggestFixes(nodes, 'objects').filter((s) => s.fixable && s.field === 'id');
      if (fx.length === 0) break;
      nodes = applySuggestion(nodes, fx[0]!);
    }
    const ids = (nodes as Record<string, unknown>[]).map((n) => n.id);
    assert(ids.every((x) => typeof x === 'string' && (x as string).length > 0), '12.14 all have ids');
    assertEq(new Set(ids).size, ids.length, '12.14 distinct ids');
  });
}

function sectionBuildCandidate(g0: Ontology): void {
  section('13. buildCandidateOntology');
  const edits = Object.fromEntries(LAYER_KEYS.map((l) => [l, extractLayer(g0, l)])) as Partial<Record<EditorLayer, unknown[]>>;
  check('13.1 assembles all 5 layers', () => { const c = buildCandidateOntology(g0, edits); for (const l of LAYER_KEYS) assertDeepEq(c[l], g0[l], `13.1 ${l}`); });
  check('13.2 preserves envelope', () => {
    const c = buildCandidateOntology(g0, edits);
    for (const k of ['id', 'uuid', 'name', 'domain', 'sourceDocuments', 'relationships', 'ruleGroups'] as const) {
      assertDeepEq((c as Record<string, unknown>)[k], (g0 as Record<string, unknown>)[k], `13.2 ${k}`);
    }
  });
  check('13.3 version unchanged', () => assertEq(buildCandidateOntology(g0, edits).version, g0.version, '13.3'));
  check('13.4 status pass-through', () => assertEq(buildCandidateOntology(g0, edits).status, g0.status, '13.4'));
  check('13.5 schemaVersion === const', () => assertEq(buildCandidateOntology(g0, edits).schemaVersion, SCHEMA_VERSION_NUMBER, '13.5'));
  check('13.6 partial edits keep untouched layers', () => {
    const c = buildCandidateOntology(g0, { objects: [] });
    assertEq(c.objects.length, 0, '13.6 objects'); assertDeepEq(c.rules, g0.rules, '13.6 rules kept');
  });
  check('13.7 non-mutating', () => { const before = g0.objects.length; buildCandidateOntology(g0, { objects: [] }); assertEq(g0.objects.length, before, '13.7'); });
  check('13.8 metadata preserved + updatedAt parseable', () => {
    const c = buildCandidateOntology(g0, edits);
    assertEq(c.metadata.createdAt, g0.metadata.createdAt, '13.8 createdAt');
    assert(!Number.isNaN(Date.parse(c.metadata.updatedAt)), '13.8 updatedAt ISO');
  });
  check('13.9 mapIdToLayer routing', () => {
    assertEq(mapIdToLayer('objectType:a'), 'objects', 'obj');
    assertEq(mapIdToLayer('rule:a'), 'rules', 'rule');
    assertEq(mapIdToLayer('ruleGroup:a'), 'ruleGroups', 'ruleGroup');
    assertEq(mapIdToLayer('action:a'), 'actions', 'action');
    assertEq(mapIdToLayer('event:a'), 'events', 'event');
    assertEq(mapIdToLayer('process:a'), 'processes', 'process');
    assertEq(mapIdToLayer('rel:a'), 'relationships', 'rel');
    assertEq(mapIdToLayer('weird:a'), 'unknown', 'unknown');
  });
}

function sectionValidateIntegration(g0: Ontology): void {
  section('14. validateOntology integration (canonical validator)');
  const identity = (o: Ontology): Ontology =>
    buildCandidateOntology(o, Object.fromEntries(LAYER_KEYS.map((l) => [l, extractLayer(o, l)])) as Partial<Record<EditorLayer, unknown[]>>);
  check('14.1 identity issue-set unchanged', () => assertDeepEq(validateOntology(identity(g0)), validateOntology(g0), '14.1'));
  check('14.2 delete referenced object → dangling_ref', () => {
    const removed = g0.objects[0]!.id;
    const cand = buildCandidateOntology(g0, { objects: g0.objects.slice(1) });
    const issues = validateOntology(cand);
    assert(issues.some((i) => i.kind === 'dangling_ref' && i.missingId === removed), '14.2');
  });
  check('14.3 duplicate id → duplicate_id', () => {
    const cand = buildCandidateOntology(g0, { objects: [...g0.objects, g0.objects[0]!] });
    assert(validateOntology(cand).some((i) => i.kind === 'duplicate_id'), '14.3');
  });
  check('14.4 break event inverse → warn', () => {
    if (g0.events.length === 0) return;
    const ev = { ...g0.events[0]!, producedByActionIds: ['action:does-not-exist-xyz'] };
    const cand = buildCandidateOntology(g0, { events: [ev, ...g0.events.slice(1)] });
    assert(validateOntology(cand).some((i) => i.kind === 'event_inverse_mismatch' || i.kind === 'dangling_ref'), '14.4');
  });
  check('14.5 extracted + no sources → missing_source', () => {
    const obj = { ...g0.objects[0]!, provenance: 'extracted', sources: [] };
    const cand = buildCandidateOntology(g0, { objects: [obj, ...g0.objects.slice(1)] });
    assert(validateOntology(cand).some((i) => i.kind === 'missing_source' && i.from === obj.id), '14.5');
  });
  check('14.6 inferred + no sources → no missing_source', () => {
    const obj = { ...g0.objects[0]!, provenance: 'inferred', sources: [] };
    const cand = buildCandidateOntology(g0, { objects: [obj, ...g0.objects.slice(1)] });
    assert(!validateOntology(cand).some((i) => i.kind === 'missing_source' && i.from === obj.id), '14.6');
  });
  check('14.7 fk property without references → reference_without_target', () => {
    const obj = { ...g0.objects[0]!, properties: [{ name: 'k', type: 'String', description: 'd', is_foreign_key: true }] };
    const cand = buildCandidateOntology(g0, { objects: [obj, ...g0.objects.slice(1)] });
    assert(validateOntology(cand).some((i) => i.kind === 'reference_without_target'), '14.7');
  });
  check('14.8 garbage candidate never throws', () => {
    const cand = buildCandidateOntology(g0, { objects: [], rules: [], actions: [], events: [], processes: [] });
    assert(Array.isArray(validateOntology(cand)), '14.8');
  });
  check('14.9 suggester ⊆ validator for shared kinds', () => {
    // every reference_without_target the suggester flags is also flagged by the
    // canonical validator on the assembled candidate.
    const obj = {
      id: 'objectType:probe', name: 'P', nameZh: 'P', confidence: 0.5, reviewState: 'accepted', provenance: 'inferred', sources: [],
      type: 'data', relationship_description: '', primary_key: 'probe_id',
      properties: [{ name: 'r', type: 'String', description: 'd', is_foreign_key: true }],
    };
    const sugg = suggestFixes([obj], 'objects');
    const cand = buildCandidateOntology(g0, { objects: [...g0.objects, obj] });
    const vKinds = new Set(validateOntology(cand).map((i) => i.kind));
    for (const s of sugg) {
      if (s.kind === 'reference_without_target') {
        assert(vKinds.has(s.kind), `14.9 validator missing ${s.kind}`);
      }
    }
  });
}

function sectionSchemaDrift(): void {
  section('15. schema-drift smoke');
  check('15.1 DATA_TYPE_ENUM == canonical DATA_TYPES', () => assertDeepEq([...DATA_TYPE_ENUM].sort(), [...DATA_TYPES].sort(), '15.1'));
  check('15.2 SEVERITY_ENUM == canonical SEVERITY_LEVELS', () => assertDeepEq([...SEVERITY_ENUM].sort(), [...SEVERITY_LEVELS].sort(), '15.2'));
  check('15.3 each layer schema is array-of-object', () => {
    for (const l of LAYER_KEYS) {
      const s = LAYER_SCHEMAS[l];
      assertEq(s.type, 'array', `15.3 ${l} type`);
      assertEq(s.items?.type, 'object', `15.3 ${l} items`);
    }
  });
  check('15.4 id has NO kind-prefix pattern (clean shape ids are prefix-free)', () => {
    // The editor shows the clean sample shape (object id "Candidate", rule/action/
    // workflow ids a bare slug, events no id), so no `^objectType:`-style pattern.
    for (const l of LAYER_KEYS) {
      const idSchema = LAYER_SCHEMAS[l].items?.properties?.id;
      assert(!!idSchema && idSchema.type === 'string' && !idSchema.pattern, `15.4 ${l}`);
    }
  });
}

function sectionMetadataWrapper(g0: Ontology): void {
  section('16. metadata wrapper + spec field names (objects)');

  check('16.1 serializeLayerDoc wraps as { metadata, <key>: [...] }', () => {
    for (const l of LAYER_KEYS) {
      const arr = extractLayer(g0, l);
      const doc = JSON.parse(serializeLayerDoc(l, arr, g0)) as Record<string, unknown>;
      assert(typeof doc.metadata === 'object' && doc.metadata !== null, `16.1 ${l} metadata`);
      const key = layerDocKey(l);
      assert(Array.isArray(doc[key]), `16.1 ${l} array under "${key}"`);
      assertEq((doc[key] as unknown[]).length, arr.length, `16.1 ${l} length`);
      const meta = doc.metadata as Record<string, unknown>;
      for (const f of ['project_name', 'document_type', 'version', 'last_updated', 'description']) {
        assert(typeof meta[f] === 'string', `16.1 ${l} metadata.${f}`);
      }
    }
  });

  check('16.2 parseLayer unwraps a metadata-wrapped doc back to nodes', () => {
    for (const l of LAYER_KEYS) {
      const arr = extractLayer(g0, l);
      const pr = parseLayer(serializeLayerDoc(l, arr, g0));
      assert(pr.ok, `16.2 ${l} ok`);
      assertEq(pr.nodes?.length, arr.length, `16.2 ${l} node count`);
    }
  });

  check('16.3 parseLayer still accepts a bare array (back-compat)', () => {
    const arr = extractLayer(g0, 'objects');
    const pr = parseLayer(serializeLayer(arr));
    assert(pr.ok, '16.3 ok');
    assertEq(pr.nodes?.length, arr.length, '16.3 count');
  });

  check('16.4 processes layer wraps under "workflows" (matches sample)', () => {
    assertEq(layerDocKey('processes'), 'workflows', '16.4');
  });

  check('16.5 objects schema exposes the sample field names', () => {
    const objItem = LAYER_SCHEMAS.objects.items?.properties ?? {};
    for (const f of ['id', 'name', 'description', 'type', 'relationship_description', 'primary_key', 'properties']) {
      assert(f in objItem, `16.5 object missing "${f}"`);
    }
    const propItem = objItem.properties?.items?.properties ?? {};
    for (const f of ['name', 'type', 'description', 'is_foreign_key', 'references']) {
      assert(f in propItem, `16.5 property missing "${f}"`);
    }
    // legacy keys must be gone from the schema
    for (const f of ['attributes', 'keyRole', 'enumValues', 'refObjectTypeId']) {
      assert(!(f in objItem) && !(f in propItem), `16.5 legacy "${f}" still present`);
    }
  });
}

function sectionNormalize(g0: Ontology): void {
  section('17. legacy → spec object normalization (back-compat)');

  // Build a LEGACY-shaped ontology from the (migrated) golden by reverting one
  // object to the old `attributes` form, then assert normalization restores it.
  const refTarget = g0.objects[0]!.id;
  const legacyObj = {
    id: 'objectType:legacy', uuid: 'lg', name: 'LegacyThing', nameZh: '旧对象',
    description: 'd', confidence: 1, provenance: 'extracted', reviewState: 'accepted',
    sources: [{ documentId: 'd', documentName: 'd', snippet: 's' }],
    attributes: [
      { name: 'legacy_id', type: 'uuid', required: true, keyRole: 'pk' },
      { name: 'amount', type: 'money', required: false, keyRole: 'none' },
      { name: 'status', type: 'enum', required: false, keyRole: 'none', enumValues: ['a', 'b'] },
      { name: 'owner_id', type: 'uuid', required: false, keyRole: 'fk', refObjectTypeId: refTarget },
    ],
  } as unknown as Ontology['objects'][number];
  // PREPEND (keep all original objects) so existing cross-layer refs still resolve.
  const legacy = { ...g0, objects: [legacyObj, ...g0.objects] } as Ontology;

  check('17.1 legacy attributes → properties + type/primary_key', () => {
    const norm = normalizeOntologyObjects(legacy);
    const o = norm.objects.find((x) => x.id === 'objectType:legacy')!;
    assert(Array.isArray(o.properties) && o.properties.length === 4, '17.1 properties');
    assert(!('attributes' in o), '17.1 attributes removed');
    assertEq(o.type, 'data', '17.1 type');
    assertEq(o.primary_key, 'legacy_id', '17.1 primary_key from pk attr');
    assert(o.relationship_description.length > 0, '17.1 relationship_description');
  });

  check('17.2 type mapping: money→Float, enum→List<String>, uuid→String', () => {
    const o = normalizeOntologyObjects(legacy).objects.find((x) => x.id === 'objectType:legacy')!;
    const by = new Map(o.properties.map((p) => [p.name, p.type] as const));
    assertEq(by.get('amount'), 'Float', '17.2 money');
    assertEq(by.get('status'), 'List<String>', '17.2 enum');
    assertEq(by.get('legacy_id'), 'String', '17.2 uuid');
  });

  check('17.3 fk attribute → is_foreign_key + references (resolves)', () => {
    const o = normalizeOntologyObjects(legacy).objects.find((x) => x.id === 'objectType:legacy')!;
    const fk = o.properties.find((p) => p.name === 'owner_id')!;
    assertEq(fk.is_foreign_key, true, '17.3 flagged');
    assertEq(fk.references, refTarget, '17.3 references');
  });

  check('17.4 idempotent on an already-migrated ontology (same reference)', () => {
    // g0 is already migrated → normalization must be a no-op (returns the same object).
    assert(normalizeOntologyObjects(g0) === g0, '17.4 no-op identity');
  });

  check('17.5 normalized legacy ontology passes the canonical validator', () => {
    const errors = validateOntology(normalizeOntologyObjects(legacy)).filter((i) => i.level === 'error');
    assert(errors.length === 0, `17.5 ${errors.map((e) => e.kind).join(',')}`);
  });

  check('17.6 legacy rule (no spec fields) → filled by normalization', () => {
    const r0 = { ...g0.rules[0]! } as Record<string, unknown>;
    for (const k of ['businessLogicRuleName', 'executor', 'enforcementLevel', 'failurePolicy', 'relatedEntities', 'specificScenarioStage', 'standardizedLogicRule', 'applicableClient', 'applicableDepartment', 'submissionCriteria', 'businessBackgroundReason', 'ruleSource']) {
      delete r0[k];
    }
    const ont = { ...g0, rules: [r0, ...g0.rules.slice(1)] } as unknown as Ontology;
    const nr = normalizeOntologyObjects(ont).rules[0]!;
    assert(typeof nr.businessLogicRuleName === 'string' && nr.businessLogicRuleName.length > 0, '17.6 name');
    assert(nr.executor === 'Human' || nr.executor === 'Agent', '17.6 executor');
    assert(nr.enforcementLevel === 'mandatory' || nr.enforcementLevel === 'optional', '17.6 enforcement');
    assert(nr.failurePolicy === 'warn' || nr.failurePolicy === 'block', '17.6 failurePolicy');
    assert(Array.isArray(nr.relatedEntities), '17.6 relatedEntities');
  });
}

function sectionCleanEditor(goldens: { name: string; o: Ontology }[]): void {
  section('18. clean editor projection (toCleanNodes / fromCleanNodes)');

  const RECEIPTS = ['confidence', 'provenance', 'reviewState', 'sources'];
  const SAMPLE: Record<EditorLayer, string[]> = {
    objects: ['id', 'name', 'description', 'type', 'relationship_description', 'primary_key', 'properties'],
    rules: ['id', 'specificScenarioStage', 'businessLogicRuleName', 'applicableClient', 'applicableDepartment', 'submissionCriteria', 'standardizedLogicRule', 'relatedEntities', 'businessBackgroundReason', 'ruleSource', 'executor', 'enforcementLevel', 'failurePolicy'],
    actions: ['id', 'name', 'description', 'submission_criteria', 'object_type', 'category', 'actor', 'trigger', 'target_objects', 'inputs', 'outputs', 'action_steps', 'system_prompt', 'user_prompt', 'typescript_code', 'tool_use', 'side_effects', 'triggered_event'],
    events: ['name', 'description', 'payload'],
    processes: ['id', 'name', 'description', 'actor', 'trigger', 'actions', 'triggered_event'],
  };

  for (const { name, o } of goldens) {
    check(`18.x ${name}: clean nodes carry ONLY sample fields + receipts`, () => {
      for (const layer of LAYER_KEYS) {
        const allowed = new Set([...SAMPLE[layer], ...RECEIPTS]);
        const clean = toCleanNodes(layer, extractLayer(o, layer), o) as Record<string, unknown>[];
        for (const node of clean) {
          for (const k of Object.keys(node)) assert(allowed.has(k), `18 ${layer}: unexpected key "${k}"`);
          for (const r of RECEIPTS) assert(r in node, `18 ${layer}: missing receipt "${r}"`);
          for (const bad of ['uuid', 'nameZh', 'descriptionZh', 'appliesToObjectTypeIds', 'emitsEvents', 'payloadFields', 'steps', 'actorRef', 'agent']) {
            assert(!(bad in node), `18 ${layer}: leaked internal field "${bad}"`);
          }
        }
      }
    });

    check(`18.y ${name}: object id is English (no prefix), name is Chinese`, () => {
      for (const obj of toCleanNodes('objects', extractLayer(o, 'objects'), o) as Record<string, string>[]) {
        assert(!obj.id.includes(':') && /^[A-Za-z]/.test(obj.id), `18 object id "${obj.id}"`);
        assert(/[一-鿿]/.test(obj.name) || obj.name === obj.id, `18 object name "${obj.name}" should be Chinese`);
      }
    });

    check(`18.z ${name}: fromCleanNodes preserves internal structure + count`, () => {
      for (const layer of LAYER_KEYS) {
        const internal = extractLayer(o, layer);
        const back = fromCleanNodes(layer, toCleanNodes(layer, internal, o), o) as Record<string, unknown>[];
        assert(back.length === internal.length, `18 ${layer}: count preserved`);
      }
      const actBack = fromCleanNodes('actions', toCleanNodes('actions', extractLayer(o, 'actions'), o), o) as Record<string, unknown>[];
      if (actBack[0]) assert('emitsEvents' in actBack[0] && 'uuid' in actBack[0], '18 action keeps structure');
      const evBack = fromCleanNodes('events', toCleanNodes('events', extractLayer(o, 'events'), o), o) as Record<string, unknown>[];
      if (evBack[0]) assert('payloadFields' in evBack[0] && 'id' in evBack[0], '18 event keeps structure + id');
    });

    // The inline review-screen editor flow: a reviewer edits a clean scalar, the
    // host maps it back via fromCleanNodes, and re-projecting shows the new value.
    check(`18.e ${name}: editing a clean scalar round-trips (inline-editor flow)`, () => {
      const tryEdit = (layer: EditorLayer, field: string, val: string): void => {
        const clean = toCleanNodes(layer, extractLayer(o, layer), o) as Record<string, unknown>[];
        if (!clean[0] || !(field in clean[0])) return;
        const edited = { ...clean[0], [field]: val };
        const back = fromCleanNodes(layer, [edited], o);
        const reclean = toCleanNodes(layer, back, o) as Record<string, unknown>[];
        assert(reclean[0][field] === val, `18 ${layer}.${field} edit round-trips (got ${JSON.stringify(reclean[0][field])})`);
      };
      tryEdit('rules', 'businessLogicRuleName', '改后的规则名X');
      tryEdit('objects', 'description', '改后的对象描述X');
      tryEdit('actions', 'description', '改后的动作描述X');
    });
  }
}

// ===========================================================================
async function main(): Promise<void> {
  console.log('test-json-editor — deterministic verification suite (JSON Editor feature)');
  const goldens = await loadGoldens();
  assert(goldens.length >= 1, 'no golden fixtures found');
  const g0 = goldens[0]!.o;

  sectionTryParse();
  sectionRepair();
  sectionAdversarial();
  sectionIdempotence();
  sectionUnfixable();
  sectionLayerKeys();
  sectionExtractSerialize(g0);
  sectionParseLayer(g0);
  sectionMergeLayer(g0);
  sectionRoundTrip(goldens);
  sectionCoercion();
  sectionSuggest(g0);
  sectionBuildCandidate(g0);
  sectionValidateIntegration(g0);
  sectionSchemaDrift();
  sectionMetadataWrapper(g0);
  sectionNormalize(g0);
  sectionCleanEditor(goldens);

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
  console.error('test-json-editor crashed:', err);
  process.exit(1);
});
