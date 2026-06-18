// ============================================================================
//  test-hyper.mts — deterministic verification suite for the hyper-automation
//  features (design docs/HYPER_AUTOMATION_DESIGN.md §6.2). No LLM, no network:
//  every check is pure/deterministic. Run with `npm run test:hyper`
//  (or `npx tsx scripts/test-hyper.mts`). Exits 1 on any failure.
//
//  Sections (binding checklist, design §6.2):
//    1. Triples over all 10 golden fixtures
//    2. Router precedence matrix (env > settings > router > default)
//    3. Sentence numbering (EN + CJK, slice-exact offsets, batching)
//    4. Coverage pre-pass determinism (tiers 1-2, zero LLM)
//    5. LLM-settings round-trip on the memory store
//    6. Agent-registry completeness (call-site scan)
//    7. Inference use-case fixture integrity (30 cases, valid hop paths)
// ============================================================================

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import type {
  Ontology,
  ObjectType,
  ParsedSource,
  SentenceCoverage,
  SourceDocument,
  SourceRef,
  Triple,
} from '../api/_shared/ontology-schema.js';
import { SCHEMA_VERSION_NUMBER } from '../api/_shared/ontology-schema.js';
import {
  ontologyToTriples,
  tripleLabelMap,
  tripleStats,
  PREDICATES,
} from '../api/ontology-gen/inference/triples.js';
import {
  resolveAgentLlm,
  listAssignments,
  loadLlmSettings,
  saveLlmSettings,
  makeAgentLlmResolver,
  ctxAgentLlm,
} from '../api/ontology-gen/llm-router.js';
import { AGENT_REGISTRY, isKnownAgent } from '../api/ontology-gen/agents.js';
import { numberSentences, batchSentences } from '../api/ontology-gen/pipeline/hyper/sentences.js';
import {
  runDocumentCoverageEval,
  citationIntervals,
  isUncoverable,
  coverageTarget,
} from '../api/ontology-gen/pipeline/hyper/doc-coverage.js';
import { findingsToGaps } from '../api/ontology-gen/pipeline/hyper/remediate.js';
import { preserve } from '../api/ontology-gen/pipeline/swarm/deepen.js';
import { getStore, resetStore, InMemoryOntologyStore } from '../api/ontology-gen/store.js';
import type { StageContext } from '../api/ontology-gen/pipeline/context.js';
import { renderWebAugment } from '../api/ontology-gen/pipeline/web-augment.js';
import { resolveTavilyKey, tavilyAvailable } from '../api/ontology-gen/tavily.js';
import type { WebAugmentation } from '../api/_shared/ontology-schema.js';
import { stampParts, formatLlm } from '../api/ontology-gen/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Tiny harness
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

/** Set/delete env keys for the duration of `fn`, restoring originals after. */
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Remove every per-agent env override + router/target globals; return a restore fn. */
function scrubAmbientEnv(): () => void {
  const keys = Object.keys(process.env).filter((k) =>
    /^ONTOLOGY_GEN_(MODEL_|PROVIDER_)/.test(k),
  );
  keys.push('ONTOLOGY_GEN_ROUTER', 'ONTOLOGY_GEN_COVERAGE_TARGET');
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of Object.keys(saved)) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const GOLDEN_DIR = path.join(ROOT, 'fixtures', 'ontology-golden');

async function loadGoldenFixtures(): Promise<{ file: string; ontology: Ontology }[]> {
  const files = (await fs.readdir(GOLDEN_DIR)).filter((f) => f.endsWith('.json')).sort();
  const out: { file: string; ontology: Ontology }[] = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(GOLDEN_DIR, file), 'utf8');
    out.push({ file, ontology: JSON.parse(raw) as Ontology });
  }
  return out;
}

/** All real node ids of a fixture (5 layers + relationships). */
function nodeIdSet(o: Ontology): Set<string> {
  const ids = new Set<string>();
  for (const n of o.objects) ids.add(n.id);
  for (const n of o.rules) ids.add(n.id);
  for (const n of o.actions) ids.add(n.id);
  for (const n of o.events) ids.add(n.id);
  for (const n of o.processes) ids.add(n.id);
  for (const n of o.relationships) ids.add(n.id);
  return ids;
}

/** All valid property pseudo-ids '<objectId>.<propName>' of a fixture. */
function attrIdSet(o: Ontology): Set<string> {
  const ids = new Set<string>();
  for (const obj of o.objects) {
    for (const prop of obj.properties ?? []) ids.add(`${obj.id}.${prop.name}`);
  }
  return ids;
}

// ===========================================================================
// 1. Triples over all 10 golden fixtures
// ===========================================================================

async function sectionTriples(): Promise<void> {
  section('1. Triples over golden fixtures');

  const fixtures = await loadGoldenFixtures();
  await check('exactly 10 golden fixtures present', () => {
    assertEq(fixtures.length, 10, 'golden fixture count');
  });

  for (const { file, ontology } of fixtures) {
    await check(`${file}: triples non-empty, ids resolve, predicates closed, stats + labels consistent`, () => {
      const triples = ontologyToTriples(ontology);
      assert(triples.length > 0, 'ontologyToTriples returned no triples');

      const nodes = nodeIdSet(ontology);
      const attrs = attrIdSet(ontology);
      const resolves = (id: string): boolean => nodes.has(id) || attrs.has(id);
      const relVerbs = new Set(ontology.relationships.map((r) => r.name));
      const predicates = new Set<string>(PREDICATES);

      const problems: string[] = [];
      for (const t of triples) {
        if (!resolves(t.s)) problems.push(`subject does not resolve: (${t.s}, ${t.p}, ${t.o})`);
        if (!t.literal && !resolves(t.o)) {
          problems.push(`object does not resolve: (${t.s}, ${t.p}, ${t.o})`);
        }
        if (!predicates.has(t.p) && !relVerbs.has(t.p)) {
          problems.push(`predicate outside vocabulary: '${t.p}' on (${t.s}, ..., ${t.o})`);
        }
      }

      // tripleStats consistency: totals sum to triples.length and per-predicate
      // counts match a manual recount.
      const stats = tripleStats(triples);
      const sum = Object.values(stats).reduce((a, b) => a + b, 0);
      if (sum !== triples.length) {
        problems.push(`tripleStats totals ${sum} !== triples.length ${triples.length}`);
      }
      const recount: Record<string, number> = {};
      for (const t of triples) recount[t.p] = (recount[t.p] ?? 0) + 1;
      for (const [p, n] of Object.entries(recount)) {
        if (stats[p] !== n) problems.push(`tripleStats['${p}'] = ${stats[p]}, recount = ${n}`);
      }

      // Label map covers every distinct non-literal id used in the triples.
      const labels = tripleLabelMap(ontology);
      const usedIds = new Set<string>();
      for (const t of triples) {
        usedIds.add(t.s);
        if (!t.literal) usedIds.add(t.o);
      }
      for (const id of usedIds) {
        const label = labels[id];
        if (typeof label !== 'string' || !label.trim()) {
          problems.push(`tripleLabelMap missing/empty label for id '${id}'`);
        }
      }

      assert(
        problems.length === 0,
        `${problems.length} problem(s); first 5:\n      ${problems.slice(0, 5).join('\n      ')}`,
      );
    });
  }
}

// ===========================================================================
// 2. Router precedence matrix
// ===========================================================================

const BASE = { baseModel: 'google/gemini-2.5-pro', baseProvider: 'openrouter' } as const;

async function sectionRouter(): Promise<void> {
  section('2. Router precedence matrix');
  const restore = scrubAmbientEnv();
  try {
    await check('env override beats settings (model + provider env vars)', () => {
      withEnv(
        {
          ONTOLOGY_GEN_MODEL_OBJECTS_EXTRACTOR: 'env/model-x',
          ONTOLOGY_GEN_PROVIDER_OBJECTS_EXTRACTOR: 'openai',
        },
        () => {
          const r = resolveAgentLlm('objects_extractor', {
            ...BASE,
            settings: {
              overrides: { objects_extractor: { model: 'settings/model-y', provider: 'deepseek' } },
            },
          });
          assertEq(r.source, 'env', 'source');
          assertEq(r.model, 'env/model-x', 'model');
          assertEq(r.provider, 'openai', 'provider');
          assert(
            r.rationale.includes('ONTOLOGY_GEN_MODEL_OBJECTS_EXTRACTOR'),
            `rationale should name the env var, got: ${r.rationale}`,
          );
        },
      );
    });

    await check('settings override beats router', () => {
      const r = resolveAgentLlm('objects_extractor', {
        ...BASE,
        settings: {
          overrides: { objects_extractor: { model: 'deepseek/deepseek-chat', provider: 'deepseek' } },
        },
      });
      assertEq(r.source, 'settings', 'source');
      assertEq(r.model, 'deepseek/deepseek-chat', 'model');
      assertEq(r.provider, 'deepseek', 'provider');
    });

    await check('model-only settings override keeps the base provider', () => {
      const r = resolveAgentLlm('objects_extractor', {
        baseModel: 'google/gemini-2.5-pro',
        baseProvider: 'deepseek',
        settings: { overrides: { objects_extractor: { model: 'custom/model-z' } } },
      });
      assertEq(r.source, 'settings', 'source');
      assertEq(r.model, 'custom/model-z', 'model');
      assertEq(r.provider, 'deepseek', 'provider (base kept)');
    });

    await check("router beats default: objects_extractor fast-sibling 'google/gemini-2.5-flash'", () => {
      const r = resolveAgentLlm('objects_extractor', { ...BASE, settings: null });
      assertEq(r.source, 'router', 'source');
      assertEq(r.model, 'google/gemini-2.5-flash', 'model');
      assertEq(r.provider, 'openrouter', 'provider');
    });

    await check('router: ba_reviewer (review purpose) stays on gemini-2.5-pro (strong tier)', () => {
      const r = resolveAgentLlm('ba_reviewer', { ...BASE, settings: null });
      assertEq(r.source, 'router', 'source');
      assertEq(r.model, 'google/gemini-2.5-pro', 'model');
    });

    await check('ONTOLOGY_GEN_ROUTER=0 disables routing (source default, base kept)', () => {
      withEnv({ ONTOLOGY_GEN_ROUTER: '0' }, () => {
        const r = resolveAgentLlm('objects_extractor', { ...BASE, settings: null });
        assertEq(r.source, 'default', 'source');
        assertEq(r.model, 'google/gemini-2.5-pro', 'model');
        assertEq(r.provider, 'openrouter', 'provider');
      });
    });

    await check('settings routerEnabled:false disables routing', () => {
      const r = resolveAgentLlm('objects_extractor', {
        ...BASE,
        settings: { overrides: {}, routerEnabled: false },
      });
      assertEq(r.source, 'default', 'source');
      assertEq(r.model, 'google/gemini-2.5-pro', 'model');
      assertEq(r.provider, 'openrouter', 'provider');
    });

    await check("needsWeb pins provider 'openrouter' (off-OpenRouter base)", () => {
      const r = resolveAgentLlm('ba_reviewer', {
        baseModel: 'google/gemini-2.5-pro',
        baseProvider: 'openai',
        settings: null,
        needsWeb: true,
      });
      assertEq(r.source, 'router', 'source');
      assertEq(r.provider, 'openrouter', 'provider pinned for web search');
      assertEq(r.model, 'google/gemini-2.5-pro', 'model (strong tier keeps base)');
    });

    await check('inputChars 400000 triggers the long-context rationale', () => {
      const r = resolveAgentLlm('objects_extractor', {
        ...BASE,
        settings: null,
        inputChars: 400_000,
      });
      assertEq(r.source, 'router', 'source');
      assertEq(r.model, 'google/gemini-2.5-pro', 'model (already gemini, kept)');
      assert(
        r.rationale.includes('long-context'),
        `rationale should mention long-context, got: ${r.rationale}`,
      );
      // Non-gemini base on the OpenRouter path upgrades to the long-context model.
      const r2 = resolveAgentLlm('objects_extractor', {
        baseModel: 'openai/gpt-5',
        baseProvider: 'openrouter',
        settings: null,
        inputChars: 400_000,
      });
      assertEq(r2.model, 'google/gemini-2.5-pro', 'non-gemini base upgraded');
      assert(r2.rationale.includes('long-context'), `rationale: ${r2.rationale}`);
    });

    await check('unknown agent id does not throw (routes as extraction)', () => {
      const r = resolveAgentLlm('totally_unknown_agent', { ...BASE, settings: null });
      assertEq(r.source, 'router', 'source');
      assertEq(r.model, 'google/gemini-2.5-flash', 'model (extraction fast tier)');
      assert(r.rationale.includes('unknown agent'), `rationale: ${r.rationale}`);
    });

    await check('listAssignments returns exactly one row per AGENT_REGISTRY entry', () => {
      const rows = listAssignments(null, BASE.baseModel, BASE.baseProvider);
      assertEq(rows.length, AGENT_REGISTRY.length, 'row count');
      const expected = AGENT_REGISTRY.map((a) => a.id).join(',');
      const actual = rows.map((r) => r.agentId).join(',');
      assertEq(actual, expected, 'agentId order');
      for (const row of rows) {
        assert(!!row.model && !!row.provider, `row ${row.agentId} missing model/provider`);
      }
    });

    await check('makeAgentLlmResolver + ctxAgentLlm honor the resolver / fall back without it', () => {
      const resolver = makeAgentLlmResolver(null, BASE.baseModel, BASE.baseProvider);
      const viaResolver = ctxAgentLlm(
        { model: 'ctx-model', provider: 'ctx-provider', agentLlm: resolver },
        'objects_extractor',
      );
      assertEq(viaResolver.model, 'google/gemini-2.5-flash', 'resolver model');
      assertEq(viaResolver.provider, 'openrouter', 'resolver provider');
      const fallback = ctxAgentLlm({ model: 'ctx-model', provider: 'ctx-provider' }, 'objects_extractor');
      assertEq(fallback.model, 'ctx-model', 'fallback model');
      assertEq(fallback.provider, 'ctx-provider', 'fallback provider');
    });
  } finally {
    restore();
  }
}

// ===========================================================================
// 3. Sentence numbering
// ===========================================================================

const EN_TEXT =
  'Orders are confirmed by the sales team. The refund window is described in section 3.2 of the policy. ' +
  'Refunds over 100 USD require approval.\n\nShipping follows confirmation. Carriers must scan every parcel.';

const ZH_TEXT =
  '订单必须在二十四小时内完成确认。客户可在七日内申请全额退款；退款金额超过一千元时需要主管审批！最后一行没有标点';

function syntheticParsedPair(): { parsed: ParsedSource[]; sources: SourceDocument[] } {
  const sources: SourceDocument[] = [
    { id: 'doc:en', uuid: 'uuid-en', name: 'EN Policy.md', kind: 'doc' },
    { id: 'doc:zh', uuid: 'uuid-zh', name: '中文政策.md', kind: 'doc' },
  ];
  const parsed: ParsedSource[] = [
    { ref: 'parsed:en', documentId: 'doc:en', text: EN_TEXT },
    { ref: 'parsed:zh', documentId: 'doc:zh', text: ZH_TEXT },
  ];
  return { parsed, sources };
}

async function sectionSentences(): Promise<void> {
  section('3. Sentence numbering');

  const { parsed, sources } = syntheticParsedPair();
  const sentences = numberSentences(parsed, sources);

  await check('EN (5) + ZH (4) sentences, decimal "3.2" not split', () => {
    const en = sentences.filter((s) => s.documentId === 'doc:en');
    const zh = sentences.filter((s) => s.documentId === 'doc:zh');
    assertEq(en.length, 5, 'EN sentence count');
    assertEq(zh.length, 4, 'ZH sentence count');
    assertEq(
      en[1]!.text,
      'The refund window is described in section 3.2 of the policy.',
      'sentence containing the decimal',
    );
  });

  await check('CJK 。；！ split without trailing whitespace', () => {
    const zh = sentences.filter((s) => s.documentId === 'doc:zh');
    assertEq(zh[0]!.text, '订单必须在二十四小时内完成确认。', 'first ZH sentence');
    assertEq(zh[1]!.text, '客户可在七日内申请全额退款；', 'second ZH sentence');
    assertEq(zh[2]!.text, '退款金额超过一千元时需要主管审批！', 'third ZH sentence');
    assertEq(zh[3]!.text, '最后一行没有标点', 'trailing ZH fragment');
    for (const s of zh) {
      assertEq(s.text, s.text.trim(), `ZH sentence ${s.idx} has surrounding whitespace`);
    }
  });

  await check('global idx is continuous and 1-based across sources', () => {
    assertEq(sentences.length, 9, 'total sentence count');
    sentences.forEach((s, i) => assertEq(s.idx, i + 1, `idx at position ${i}`));
    // ZH numbering continues after EN (document order preserved).
    assertEq(sentences[5]!.documentId, 'doc:zh', 'sentence 6 belongs to the ZH doc');
  });

  await check('every sentence is slice-exact against its parsed text', () => {
    const textByDoc = new Map(parsed.map((p) => [p.documentId, p.text]));
    for (const s of sentences) {
      const text = textByDoc.get(s.documentId)!;
      assertEq(
        text.slice(s.charStart, s.charEnd),
        s.text,
        `slice mismatch for sentence ${s.idx}`,
      );
    }
  });

  await check('batchSentences partitions completely, no overlap, order preserved', () => {
    const batches = batchSentences(sentences, 4);
    assertEq(batches.length, 3, 'batch count for size 4 over 9');
    assertEq(batches[0]!.length, 4, 'batch 1 size');
    assertEq(batches[1]!.length, 4, 'batch 2 size');
    assertEq(batches[2]!.length, 1, 'batch 3 size');
    const flat = batches.flat();
    assertEq(flat.length, sentences.length, 'flattened length');
    flat.forEach((s, i) => assertEq(s.idx, sentences[i]!.idx, `order at position ${i}`));
    const idxSeen = new Set(flat.map((s) => s.idx));
    assertEq(idxSeen.size, sentences.length, 'no duplicate idx across batches');
  });
}

// ===========================================================================
// 4. Coverage pre-pass determinism
// ===========================================================================

const D1_TEXT = 'Overview\nOrders must be paid within 30 days.';
const D1_SENTENCE = 'Orders must be paid within 30 days.';
const D2_TEXT = 'Invoices are issued after delivery confirmation.';
/** Same sentence with mangled case + extra whitespace — exercises normalization. */
const D2_SNIPPET = 'INVOICES   are issued AFTER   delivery confirmation.';

function coverageObject(id: string, name: string, nameZh: string, refs: SourceRef[]): ObjectType {
  return {
    id,
    uuid: `uuid-${id}`,
    name,
    nameZh,
    description: '',
    attributes: [],
    sources: refs,
    confidence: 0.9,
    provenance: 'extracted',
    reviewState: 'accepted',
  };
}

function coverageFixture(): { ontology: Ontology; ctx: StageContext; logs: string[] } {
  const sources: SourceDocument[] = [
    { id: 'doc:d1', uuid: 'uuid-d1', name: 'D1.md', kind: 'doc' },
    { id: 'doc:d2', uuid: 'uuid-d2', name: 'D2.md', kind: 'doc' },
  ];
  const parsed: ParsedSource[] = [
    { ref: 'parsed:d1', documentId: 'doc:d1', text: D1_TEXT },
    { ref: 'parsed:d2', documentId: 'doc:d2', text: D2_TEXT },
  ];

  const node1 = coverageObject('objectType:order', 'Order', '订单', [
    {
      documentId: 'doc:d1',
      documentName: 'D1.md',
      snippet: D1_SENTENCE,
      charStart: D1_TEXT.indexOf(D1_SENTENCE),
      charEnd: D1_TEXT.indexOf(D1_SENTENCE) + D1_SENTENCE.length,
      quoteVerified: true,
    },
  ]);
  const node2 = coverageObject('objectType:invoice', 'Invoice', '发票', [
    // Snippet-only ref (no offsets) — tier 1 must locate it via normalization.
    { documentId: 'doc:d2', documentName: 'D2.md', snippet: D2_SNIPPET },
  ]);

  const now = new Date().toISOString();
  const ontology: Ontology = {
    id: 'ontology:coverage-test',
    uuid: 'uuid-ontology-coverage-test',
    name: 'Coverage Test',
    domain: 'generic',
    version: 1,
    schemaVersion: SCHEMA_VERSION_NUMBER,
    status: 'draft',
    sourceDocuments: sources,
    objects: [node1, node2],
    rules: [],
    actions: [],
    events: [],
    processes: [],
    relationships: [],
    confidence: 0.9,
    metadata: { createdAt: now, updatedAt: now },
  };

  const logs: string[] = [];
  const ctx: StageContext = {
    ontologyId: ontology.id,
    domain: 'generic',
    sources,
    parsed,
    taken: new Set<string>(),
    objects: ontology.objects,
    relationships: [],
    rules: [],
    ruleGroups: [],
    actions: [],
    events: [],
    processes: [],
    model: 'must-not-be-called',
    provider: 'must-not-be-called',
    userInfo: null,
    log: (text) => logs.push(text),
    // Proof of zero LLM usage: resolving an agent LLM at all is a failure.
    agentLlm: () => {
      throw new Error('agentLlm invoked — tiers 1-2 were expected to resolve every sentence');
    },
  };
  return { ontology, ctx, logs };
}

async function sectionCoverage(): Promise<void> {
  section('4. Coverage pre-pass determinism');
  const restore = scrubAmbientEnv();
  try {
    const { ontology, ctx, logs } = coverageFixture();

    await check('citationIntervals: offset ref + normalized snippet ref both ground (coveredBy nodes)', () => {
      const intervals = citationIntervals(ontology, ctx.parsed);
      const d1 = intervals.get('doc:d1') ?? [];
      const d2 = intervals.get('doc:d2') ?? [];
      assertEq(d1.length, 1, 'doc:d1 interval count');
      assertEq(d1[0]!.nodeId, 'objectType:order', 'doc:d1 interval node');
      assertEq(d1[0]!.start, D1_TEXT.indexOf(D1_SENTENCE), 'doc:d1 interval start');
      assertEq(d1[0]!.end, D1_TEXT.indexOf(D1_SENTENCE) + D1_SENTENCE.length, 'doc:d1 interval end');
      assertEq(d2.length, 1, 'doc:d2 interval count (mangled snippet located via normalization)');
      assertEq(d2[0]!.nodeId, 'objectType:invoice', 'doc:d2 interval node');
      assertEq(d2[0]!.start, 0, 'doc:d2 interval starts at the sentence');
      assert(d2[0]!.end > d2[0]!.start, 'doc:d2 interval non-empty');
    });

    await check('runDocumentCoverageEval: cited covered, heading uncoverable, ratio 1, zero LLM', async () => {
      const report = await runDocumentCoverageEval({ ctx, ontology, pass: 1, target: 1 });
      assertEq(report.pass, 1, 'pass');
      assertEq(report.totalSentences, 3, 'totalSentences');
      assertEq(report.covered, 2, 'covered (both cited sentences)');
      assertEq(report.uncoverable, 1, 'uncoverable (the heading line)');
      assertEq(report.partial, 0, 'partial');
      assertEq(report.uncovered, 0, 'uncovered');
      assertEq(report.coverageRatio, 1, 'coverageRatio');
      assertEq(report.target, 1, 'target');
      assertEq(report.meetsTarget, true, 'meetsTarget');
      assertEq(report.findings.length, 0, 'findings retain only partial|uncovered');
      assert(!Number.isNaN(Date.parse(report.evaluatedAt)), 'evaluatedAt is ISO');
      assert(
        logs.some((l) => l.includes('tier3 judging 0')),
        `expected a log line confirming 0 sentences reached tier 3; got: ${logs.join(' | ')}`,
      );
    });

    await check('coverageTarget: default 1, explicit wins, env honored, clamped to [0,1]', () => {
      assertEq(coverageTarget(), 1, 'default (no env)');
      assertEq(coverageTarget(0.9), 0.9, 'explicit');
      assertEq(coverageTarget(5), 1, 'clamped high');
      assertEq(coverageTarget(-2), 0, 'clamped low');
      withEnv({ ONTOLOGY_GEN_COVERAGE_TARGET: '0.85' }, () => {
        assertEq(coverageTarget(), 0.85, 'env target');
        assertEq(coverageTarget(0.5), 0.5, 'explicit beats env');
      });
      withEnv({ ONTOLOGY_GEN_COVERAGE_TARGET: 'garbage' }, () => {
        assertEq(coverageTarget(), 1, 'non-numeric env falls back to 1');
      });
    });

    await check('isUncoverable: headings/punct/short fragments yes, content sentences no', () => {
      assertEq(isUncoverable(''), true, 'empty');
      assertEq(isUncoverable('Overview'), true, 'single-word heading');
      assertEq(isUncoverable('3.1.2'), true, 'pure numbering');
      assertEq(isUncoverable('!!!'), true, 'pure punctuation');
      assertEq(isUncoverable('Two words'), true, '< 3 word tokens');
      assertEq(isUncoverable('短句。'), true, 'short CJK fragment');
      assertEq(isUncoverable('Orders must be paid within thirty days'), false, 'EN content');
      assertEq(isUncoverable('订单必须在二十四小时内完成确认'), false, 'CJK content');
    });

    await check('findingsToGaps: id format, severity mapping, verbatim sentence embedded', () => {
      const findings: SentenceCoverage[] = [
        { idx: 7, documentId: 'doc:d1', text: 'Uncovered sentence here.', status: 'uncovered' },
        {
          idx: 9,
          documentId: 'doc:d1',
          text: 'Partially covered sentence.',
          status: 'partial',
          missing: 'the approval threshold',
        },
      ];
      const gaps = findingsToGaps(findings, 'rule', 1);
      assertEq(gaps.length, 2, 'gap count');
      assertEq(gaps[0]!.id, 'gap:cov-r1-7', 'gap id (uncovered)');
      assertEq(gaps[0]!.severity, 'block', 'uncovered → block');
      assertEq(gaps[0]!.layer, 'rule', 'layer');
      assert(
        gaps[0]!.description.en.includes('"Uncovered sentence here."'),
        `verbatim sentence missing from description.en: ${gaps[0]!.description.en}`,
      );
      assert(gaps[0]!.description.zh.includes('Uncovered sentence here.'), 'verbatim sentence in zh');
      assertEq(gaps[1]!.id, 'gap:cov-r1-9', 'gap id (partial)');
      assertEq(gaps[1]!.severity, 'warn', 'partial → warn');
      assert(
        gaps[1]!.description.en.includes('missing: the approval threshold'),
        `missing detail absent from description.en: ${gaps[1]!.description.en}`,
      );
    });
  } finally {
    restore();
  }
}

// ===========================================================================
// 4b. Deepen/remediation merge-preserve dedup (regression for the
//     reproduce-under-a-'-2'-id duplication bug found by the architect review)
// ===========================================================================

async function sectionPreserve(): Promise<void> {
  section('4b. Merge-preserve dedup (deepen/remediation)');

  interface N { id: string; name: string }
  const keyOf = (n: N): string => n.name.toLowerCase().replace(/\s+/g, ' ').trim();
  const snapshot: N[] = [
    { id: 'objectType:order', name: 'Order' },
    { id: 'objectType:customer', name: 'Customer' },
  ];
  // What a deepen pass actually produces: reproductions re-minted under -2 ids
  // (the original ids are in ctx.taken) plus one genuinely new item.
  const current: N[] = [
    { id: 'objectType:order-2', name: 'Order' },
    { id: 'objectType:customer-2', name: 'customer ' }, // case/space variant
    { id: 'objectType:credit-hold', name: 'CreditHold' },
  ];
  const merged = preserve(current, snapshot, keyOf);

  await check('reproductions under -2 ids are dropped; snapshot copies win', () => {
    assert(merged.length === 3, `expected 3 items, got ${merged.length}`);
    assert(merged.some((n) => n.id === 'objectType:order'), 'original Order id missing');
    assert(merged.some((n) => n.id === 'objectType:customer'), 'original Customer id missing');
    assert(!merged.some((n) => n.id.endsWith('-2')), '-2 reproduction survived the merge');
  });
  await check('genuinely new items survive the merge', () => {
    assert(merged.some((n) => n.id === 'objectType:credit-hold'), 'new item dropped');
  });
  await check('no duplicated canonical keys after the merge', () => {
    const keys = merged.map(keyOf);
    assert(new Set(keys).size === keys.length, `duplicate keys: ${keys.join(', ')}`);
  });
  await check('empty content keys fall back to the id (no false collisions)', () => {
    const out = preserve(
      [{ id: 'rule:a', name: '' }, { id: 'rule:b', name: '' }],
      [{ id: 'rule:c', name: '' }],
      keyOf,
    );
    assert(out.length === 3, `expected 3 distinct unnamed items, got ${out.length}`);
  });
}

// ===========================================================================
// 5. Settings round-trip on the memory store
// ===========================================================================

async function sectionSettings(): Promise<void> {
  section('5. LLM-settings round-trip (memory store)');

  const savedStoreEnv = process.env.ONTOLOGY_GEN_STORE;
  process.env.ONTOLOGY_GEN_STORE = 'memory';
  resetStore();
  try {
    const store = getStore();

    await check('ONTOLOGY_GEN_STORE=memory selects the in-memory store', () => {
      assert(store instanceof InMemoryOntologyStore, 'expected InMemoryOntologyStore');
      assert(store.constructor === InMemoryOntologyStore, 'expected the pure memory store, not a subclass');
    });

    await check('loadLlmSettings on a fresh store → null', async () => {
      const loaded = await loadLlmSettings(store);
      assertEq(loaded, null, 'fresh-store settings');
    });

    await check('save → load: unknown agent dropped, empty model scrubbed, valid kept, updatedAt stamped', async () => {
      const saved = await saveLlmSettings(store, {
        overrides: {
          not_a_real_agent: { model: 'x/y' },
          objects_extractor: { model: '' },
          ba_reviewer: { model: 'anthropic/claude-sonnet-4.5', provider: 'openrouter' },
        },
        defaultModel: '',
        routerEnabled: false,
      });
      assert(!!saved.updatedAt && !Number.isNaN(Date.parse(saved.updatedAt)), 'updatedAt stamped (ISO)');

      const loaded = await loadLlmSettings(store);
      assert(loaded !== null, 'settings should load back');
      const keys = Object.keys(loaded.overrides).sort().join(',');
      assertEq(keys, 'ba_reviewer', 'only the valid override survives');
      assertEq(loaded.overrides.ba_reviewer!.model, 'anthropic/claude-sonnet-4.5', 'valid model kept');
      assertEq(loaded.overrides.ba_reviewer!.provider, 'openrouter', 'valid provider kept');
      assertEq(loaded.defaultModel, undefined, 'empty defaultModel scrubbed');
      assertEq(loaded.routerEnabled, false, 'routerEnabled round-trips');
      assertEq(loaded.updatedAt, saved.updatedAt, 'updatedAt round-trips');
    });

    await check('resolveAgentLlm consumes the persisted settings (settings source)', async () => {
      const loaded = await loadLlmSettings(store);
      const r = resolveAgentLlm('ba_reviewer', { ...BASE, settings: loaded });
      assertEq(r.source, 'settings', 'source');
      assertEq(r.model, 'anthropic/claude-sonnet-4.5', 'model from persisted override');
    });
  } finally {
    if (savedStoreEnv === undefined) delete process.env.ONTOLOGY_GEN_STORE;
    else process.env.ONTOLOGY_GEN_STORE = savedStoreEnv;
    resetStore();
  }
}

// ===========================================================================
// 6. Agent-registry completeness
// ===========================================================================

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listTsFiles(full)));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const CALL_SITE_PATTERNS: readonly RegExp[] = [
  /ctxAgentLlm\(\s*\w+\s*,\s*'([a-z_]+)'/g,
  /agentLlm\?\.\(\s*'([a-z_]+)'/g,
  /resolveAgentLlm\('([a-z_]+)'/g,
];

async function sectionRegistry(): Promise<void> {
  section('6. Agent-registry completeness');

  const files = await listTsFiles(path.join(ROOT, 'api', 'ontology-gen'));
  const captured = new Map<string, string[]>(); // agentId -> files using it
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    for (const pattern of CALL_SITE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) {
        const id = m[1]!;
        const list = captured.get(id) ?? [];
        list.push(path.relative(ROOT, file));
        captured.set(id, list);
      }
    }
  }

  await check('call-site scan found agent ids (regexes are not vacuous)', () => {
    assert(captured.size > 0, 'no agent-id call sites captured at all');
  });

  await check('every call-site agent id exists in AGENT_REGISTRY', () => {
    const unknown = [...captured.keys()].filter((id) => !isKnownAgent(id));
    assert(
      unknown.length === 0,
      `unknown agent id(s) at call sites: ${unknown
        .map((id) => `'${id}' (${captured.get(id)!.join(', ')})`)
        .join('; ')}`,
    );
  });

  await check('AGENT_REGISTRY has exactly 15 entries with unique ids', () => {
    assertEq(AGENT_REGISTRY.length, 15, 'registry size');
    const ids = new Set(AGENT_REGISTRY.map((a) => a.id));
    assertEq(ids.size, 15, 'unique ids');
  });

  await check('every registry entry has non-empty bilingual labels (en + zh)', () => {
    for (const a of AGENT_REGISTRY) {
      assert(!!a.label.en.trim(), `agent '${a.id}' has an empty label.en`);
      assert(!!a.label.zh.trim(), `agent '${a.id}' has an empty label.zh`);
    }
  });
}

// ===========================================================================
// 7. Use-case fixture integrity
// ===========================================================================

interface InferenceUseCase {
  id: string;
  domain: string;
  fixture: string;
  archetype: string;
  question: { en: string; zh: string };
  minHops: number;
  hopPath: string[];
  expectedAnswerNotes: string;
}

async function sectionUseCases(): Promise<void> {
  section('7. Inference use-case fixture integrity');

  const raw = await fs.readFile(path.join(ROOT, 'fixtures', 'inference-use-cases.json'), 'utf8');
  const cases = JSON.parse(raw) as InferenceUseCase[];

  await check('parses to exactly 30 cases — 3 per domain over 10 distinct domains', () => {
    assert(Array.isArray(cases), 'use-cases JSON is not an array');
    assertEq(cases.length, 30, 'case count');
    const perDomain = new Map<string, number>();
    for (const c of cases) perDomain.set(c.domain, (perDomain.get(c.domain) ?? 0) + 1);
    assertEq(perDomain.size, 10, 'distinct domain count');
    for (const [domain, n] of perDomain) assertEq(n, 3, `cases for domain '${domain}'`);
  });

  await check('every referenced fixture path exists', async () => {
    const missing: string[] = [];
    for (const fixture of new Set(cases.map((c) => c.fixture))) {
      try {
        await fs.access(path.join(ROOT, fixture));
      } catch {
        missing.push(fixture);
      }
    }
    assert(missing.length === 0, `missing fixture file(s): ${missing.join(', ')}`);
  });

  await check('minHops >= 3 and equals the number of predicates (odd positions) in hopPath', () => {
    const problems: string[] = [];
    for (const c of cases) {
      const hops = c.hopPath.filter((_, i) => i % 2 === 1).length;
      if (c.minHops < 3) problems.push(`${c.id}: minHops ${c.minHops} < 3`);
      if (c.minHops !== hops) problems.push(`${c.id}: minHops ${c.minHops} !== ${hops} hop predicates`);
      if (c.hopPath.length !== 2 * hops + 1) {
        problems.push(`${c.id}: hopPath length ${c.hopPath.length} is not node-terminated`);
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('every hopPath node resolves and every predicate is in-vocabulary for its fixture', async () => {
    const fixtureCache = new Map<string, Ontology>();
    const loadFixture = async (rel: string): Promise<Ontology> => {
      const cached = fixtureCache.get(rel);
      if (cached) return cached;
      const text = await fs.readFile(path.join(ROOT, rel), 'utf8');
      const o = JSON.parse(text) as Ontology;
      fixtureCache.set(rel, o);
      return o;
    };

    const problems: string[] = [];
    for (const c of cases) {
      const o = await loadFixture(c.fixture);
      const nodes = nodeIdSet(o);
      const attrs = attrIdSet(o);
      const verbs = new Set(o.relationships.map((r) => r.name));
      const predicates = new Set<string>(PREDICATES);
      c.hopPath.forEach((el, i) => {
        if (i % 2 === 0) {
          if (!nodes.has(el) && !attrs.has(el)) problems.push(`${c.id}: hop node '${el}' does not resolve`);
        } else if (!predicates.has(el) && !verbs.has(el)) {
          problems.push(`${c.id}: hop predicate '${el}' outside vocabulary`);
        }
      });
    }
    assert(
      problems.length === 0,
      `${problems.length} problem(s); first 5: ${problems.slice(0, 5).join('; ')}`,
    );
  });

  await check('hop paths are walkable against the fixture triples (predicate appears on the path nodes)', async () => {
    // Stronger than vocabulary membership: each (node, predicate) pair at hop i
    // must exist as a triple whose subject or object is that node.
    const problems: string[] = [];
    for (const c of cases) {
      const text = await fs.readFile(path.join(ROOT, c.fixture), 'utf8');
      const o = JSON.parse(text) as Ontology;
      const triples = ontologyToTriples(o);
      const byNode = new Map<string, Triple[]>();
      const add = (id: string, t: Triple): void => {
        const list = byNode.get(id);
        if (list) list.push(t);
        else byNode.set(id, [t]);
      };
      for (const t of triples) {
        add(t.s, t);
        if (!t.literal) add(t.o, t);
      }
      for (let i = 1; i < c.hopPath.length; i += 2) {
        const from = c.hopPath[i - 1]!;
        const pred = c.hopPath[i]!;
        const to = c.hopPath[i + 1]!;
        const candidates = byNode.get(from) ?? [];
        const ok = candidates.some(
          (t) =>
            t.p === pred &&
            !t.literal &&
            ((t.s === from && t.o === to) || (t.o === from && t.s === to)),
        );
        if (!ok) problems.push(`${c.id}: no triple (${from}) -[${pred}]- (${to})`);
      }
    }
    assert(
      problems.length === 0,
      `${problems.length} unwalkable hop(s); first 5: ${problems.slice(0, 5).join('; ')}`,
    );
  });
}

// ===========================================================================
// Runner
// ===========================================================================

async function sectionWebAugment(): Promise<void> {
  section('8. Web-search augmentation (Tavily) — pure render + key resolution');

  await check('renderWebAugment(undefined) is undefined (no-web behavior)', () => {
    assertEq(renderWebAugment(undefined), undefined, 'undefined input');
  });

  await check('renderWebAugment with blank text is undefined', () => {
    const aug: WebAugmentation = { industry: 'x', scenario: 'y', queries: ['q'], text: '   ', sources: [], at: '2026-01-01' };
    assertEq(renderWebAugment(aug), undefined, 'blank text renders nothing');
  });

  await check('renderWebAugment block carries header, industry, web_search reminder, sources', () => {
    const aug: WebAugmentation = {
      industry: 'recruitment',
      scenario: 'candidate onboarding',
      queries: ['recruitment data model'],
      text: '- Candidate: id, status\n- Requisition: id',
      sources: [{ title: 'HR Data Models', url: 'https://example.com/hr' }],
      at: '2026-01-01',
    };
    const block = renderWebAugment(aug);
    assert(typeof block === 'string', 'returns a string');
    const s = block as string;
    assert(s.includes('WEB-SEARCH SUPPLEMENT'), 'has the header');
    assert(s.includes('recruitment'), 'names the industry');
    assert(s.includes('CANDIDATE to ADD'), 'frames entries as candidates to add');
    assert(s.includes('"provenance": "web_search"'), 'shows a concrete web_search example');
    assert(s.includes('NEVER "inferred"'), 'routes block items to web_search, not inferred');
    assert(s.includes('https://example.com/hr'), 'lists the source url');
    assert(s.includes('- Candidate: id, status'), 'embeds the supplement text');
  });

  await check('resolveTavilyKey: env TAVILY_API_KEY wins over settings', () => {
    withEnv({ TAVILY_API_KEY: 'tvly-env' }, () => {
      assertEq(resolveTavilyKey({ overrides: {}, tavilyApiKey: 'tvly-settings' }), 'tvly-env', 'env precedence');
    });
  });

  await check('resolveTavilyKey / tavilyAvailable: settings fallback + absence', () => {
    withEnv({ TAVILY_API_KEY: undefined }, () => {
      assertEq(resolveTavilyKey({ overrides: {}, tavilyApiKey: 'tvly-settings' }), 'tvly-settings', 'settings fallback');
      assertEq(tavilyAvailable({ overrides: {}, tavilyApiKey: 'tvly-settings' }), true, 'available via settings');
      assertEq(tavilyAvailable({ overrides: {} }), false, 'unavailable with no key');
      assertEq(tavilyAvailable(null), false, 'unavailable with null settings');
    });
  });
}

async function sectionLogger(): Promise<void> {
  section('9. File logger — local-tz stamp + LLM line formatting');

  await check('stampParts: local date + YYYY-MM-DD HH:mm:ss.SSS ±HHMM stamp', () => {
    const { date, stamp } = stampParts(new Date(2026, 5, 18, 9, 5, 3, 7));
    assert(/^\d{4}-\d{2}-\d{2}$/.test(date), `date format: ${date}`);
    assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{4}$/.test(stamp), `stamp format: ${stamp}`);
    assert(stamp.startsWith(date + ' '), 'stamp embeds the file date');
  });

  await check('formatLlm: ok line carries task, model, token usage, duration', () => {
    const line = formatLlm({
      actionName: 'ontology_extract_objects', module: 'ontology_generator',
      provider: 'openrouter', model: 'google/gemini-2.5-flash',
      promptTokens: 5234, completionTokens: 1203, totalTokens: 6437, durationMs: 5800, ok: true,
    });
    assert(line.includes('task=ontology_extract_objects'), 'has task name');
    assert(line.includes('model=google/gemini-2.5-flash'), 'has model');
    assert(line.includes('tokens(prompt=5234, completion=1203, total=6437)'), 'has token usage');
    assert(line.includes('5800ms'), 'has duration');
    assert(line.trim().endsWith('ok'), 'ends ok');
  });

  await check('formatLlm: error line carries ERROR, collapses newlines, keeps note', () => {
    const line = formatLlm({ actionName: 't', provider: 'openai', model: 'gpt-5', ok: false, error: 'boom\nstack', note: 'will retry' });
    assert(line.includes('ERROR: boom stack'), 'error message inlined');
    assert(line.includes('[will retry]'), 'note present');
    assert(!line.includes('\n'), 'single line');
  });
}

async function main(): Promise<void> {
  console.log('test-hyper — deterministic verification suite (design §6.2)');

  await sectionTriples();
  await sectionRouter();
  await sectionSentences();
  await sectionCoverage();
  await sectionPreserve();
  await sectionSettings();
  await sectionRegistry();
  await sectionUseCases();
  await sectionWebAugment();
  await sectionLogger();

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
  console.error('test-hyper crashed:', err);
  process.exit(1);
});
