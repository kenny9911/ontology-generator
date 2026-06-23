// ============================================================================
//  HYPER-AUTOMATION — document-coverage eval agent.
//
//  Sentence-level verification that EVERY meaningful sentence of every source
//  document is represented in the ontology. Three-tier verdict assignment,
//  cheapest first:
//
//    Tier 1 (deterministic, no LLM): span-overlap every numbered sentence
//            against every node's grounded citations (charStart/charEnd when
//            present, else a normalized-substring locate of the snippet).
//            Overlap ≥ 1 char ⇒ 'covered'.
//    Tier 2 (deterministic): boilerplate filter — too-short sentences, pure
//            numbering/headings, pure punctuation ⇒ 'uncoverable'.
//    Tier 3 (LLM): the remainder is judged in batches of ≤ 80 sentences
//            (≤ 3 concurrent, temp 0) against a compact ontology digest.
//            FAIL-CLOSED: a missing/unparseable verdict ⇒ 'uncovered' — a
//            judging failure can only INCREASE reported gaps, never hide one.
//
//  Output is the DocumentCoverageEval envelope: counts over all four statuses,
//  coverageRatio = covered / max(1, total − uncoverable), and `findings`
//  retaining ONLY partial|uncovered entries. Agent id: `coverage_evaluator`.
// ============================================================================

import type {
  DocumentCoverageEval,
  EntityKind,
  Ontology,
  ParsedSource,
  SentenceCoverage,
  SentenceCoverageStatus,
  SourceRef,
} from '../../../_shared/ontology-schema.js';
import { callJson } from '../swarm/llm-json.js';
import type { StageContext } from '../context.js';
import { numberSentences, batchSentences } from './sentences.js';
import type { NumberedSentence } from './sentences.js';

const MAX_CONCURRENT = 3;
const MAX_COVERED_BY = 8;

export interface CoverageEvalInput {
  ctx: StageContext;
  /** Current assembled state (buildAndCarry output). */
  ontology: Ontology;
  /** 1 | 2 | 3 (final). */
  pass: number;
  /** Default: env ONTOLOGY_GEN_COVERAGE_TARGET ?? 1.0, clamped to [0,1]. */
  target?: number;
}

/** Resolve the coverage target: explicit > env ONTOLOGY_GEN_COVERAGE_TARGET > 1.0. */
export function coverageTarget(explicit?: number): number {
  const raw = explicit ?? Number(process.env.ONTOLOGY_GEN_COVERAGE_TARGET ?? '1');
  if (!Number.isFinite(raw)) return 1;
  return Math.min(1, Math.max(0, raw));
}

// ---------------------------------------------------------------------------
//  Tier 1 — deterministic citation-interval overlap (exported for self-tests).
// ---------------------------------------------------------------------------

/** One grounded citation projected onto its document's parsed text. */
export interface CitationInterval {
  start: number;
  end: number;
  nodeId: string;
}

/** Normalized text + map[i] = original offset of normalized char i. */
interface NormIndex {
  norm: string;
  map: number[];
}

/** Lowercase + collapse whitespace runs to one space, keeping an offset map back. */
function buildNormIndex(text: string): NormIndex {
  let norm = '';
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      let j = i;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      if (norm.length > 0 && j < text.length) {
        norm += ' ';
        map.push(i);
      }
      i = j;
    } else {
      for (const c of ch.toLowerCase()) {
        norm += c;
        map.push(i);
      }
      i += 1;
    }
  }
  return { norm, map };
}

function normalizeSnippet(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Every node's citations, flattened (object attribute citations count for their object). */
function allNodeRefs(o: Ontology): { nodeId: string; refs: SourceRef[] }[] {
  const out: { nodeId: string; refs: SourceRef[] }[] = [];
  for (const n of o.objects) {
    const refs = [...n.sources];
    for (const p of n.properties ?? []) if (p.sources) refs.push(...p.sources);
    out.push({ nodeId: n.id, refs });
  }
  for (const n of o.rules) out.push({ nodeId: n.id, refs: n.sources });
  for (const n of o.actions) out.push({ nodeId: n.id, refs: n.sources });
  for (const n of o.events) out.push({ nodeId: n.id, refs: n.sources });
  for (const n of o.processes) out.push({ nodeId: n.id, refs: n.sources });
  for (const n of o.relationships) out.push({ nodeId: n.id, refs: n.sources });
  return out;
}

/**
 * Build per-document citation-interval lists from every node's SourceRefs
 * (all 5 layers + relationships). charStart/charEnd are used when present;
 * otherwise the snippet is located via a normalized (lowercased, whitespace-
 * collapsed) substring search of the parsed text. Pure and deterministic.
 */
export function citationIntervals(ontology: Ontology, parsed: ParsedSource[]): Map<string, CitationInterval[]> {
  const normByDoc = new Map<string, NormIndex>();
  const textByDoc = new Map<string, string>();
  for (const p of parsed) textByDoc.set(p.documentId, typeof p.text === 'string' ? p.text : '');

  const indexFor = (documentId: string): NormIndex | null => {
    const cached = normByDoc.get(documentId);
    if (cached) return cached;
    const text = textByDoc.get(documentId);
    if (text === undefined) return null;
    const built = buildNormIndex(text);
    normByDoc.set(documentId, built);
    return built;
  };

  const intervals = new Map<string, CitationInterval[]>();
  const push = (documentId: string, interval: CitationInterval): void => {
    const list = intervals.get(documentId);
    if (list) list.push(interval);
    else intervals.set(documentId, [interval]);
  };

  for (const { nodeId, refs } of allNodeRefs(ontology)) {
    for (const ref of refs) {
      if (!ref.documentId) continue;
      if (typeof ref.charStart === 'number' && typeof ref.charEnd === 'number' && ref.charEnd > ref.charStart) {
        push(ref.documentId, { start: ref.charStart, end: ref.charEnd, nodeId });
        continue;
      }
      const snippet = normalizeSnippet(ref.snippet ?? '');
      if (!snippet) continue;
      const index = indexFor(ref.documentId);
      if (!index) continue;
      const at = index.norm.indexOf(snippet);
      if (at < 0) continue;
      const start = index.map[at]!;
      const end = index.map[at + snippet.length - 1]! + 1;
      if (end > start) push(ref.documentId, { start, end, nodeId });
    }
  }
  return intervals;
}

// ---------------------------------------------------------------------------
//  Tier 2 — deterministic boilerplate filter.
// ---------------------------------------------------------------------------

/** Pure numbering / heading scaffolding (chapter markers, list numerals, rules). */
const HEADING_RE = /^[\d\s.、第章节()()\-—]+$/;
/** No letter or digit at all ⇒ pure punctuation. */
const PUNCT_RE = /^[^\p{L}\p{N}]+$/u;
const CJK_RE = /[一-鿿]/g;

/** True when a sentence carries no extractable business content (boilerplate). */
export function isUncoverable(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (HEADING_RE.test(t)) return true;
  if (PUNCT_RE.test(t)) return true;
  // Substance is judged JOINTLY over CJK chars and Latin-ish word tokens, so a
  // content-heavy English sentence with one embedded Chinese term can never be
  // written off as a "short CJK fragment" (that would be a fail-OPEN hole: the
  // sentence would skip LLM judging, vanish from findings, and shrink the
  // coverage denominator). Only genuinely tiny mixed/CJK fragments qualify.
  const cjkChars = (t.match(CJK_RE) ?? []).length;
  const latinTokens = t.replace(CJK_RE, ' ').split(/\s+/).filter(Boolean).length;
  if (cjkChars >= 6 || latinTokens >= 3) return false;
  return cjkChars + latinTokens < 4;
}

// ---------------------------------------------------------------------------
//  Tier 3 — LLM judging of the remainder.
// ---------------------------------------------------------------------------

const STATUS_SET = new Set<string>(['covered', 'partial', 'uncovered', 'uncoverable']);
const EXPECTED_KIND_SET = new Set<string>(['object', 'rule', 'action', 'event', 'process']);

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Compact one-line-per-node digest of the ontology the judge holds sentences against. */
function ontologyDigest(o: Ontology): string {
  const lines: string[] = [];
  for (const n of o.objects) {
    const attrs = (n.properties ?? []).slice(0, 30).map((p) => p.name).join(',');
    lines.push(truncate(`${n.id} | object | ${n.name} / ${n.nameZh} | attrs: ${attrs}`, 240));
  }
  for (const n of o.relationships) {
    lines.push(truncate(`${n.id} | relationship | ${n.name} | ${n.sourceObjectTypeId} -> ${n.targetObjectTypeId}`, 240));
  }
  for (const n of o.rules) {
    lines.push(truncate(`${n.id} | rule | ${n.title} | ${n.statement?.en ?? ''}`, 240));
  }
  for (const n of o.actions) {
    lines.push(truncate(`${n.id} | action | ${n.name} | ${n.description ?? ''}`, 240));
  }
  for (const n of o.events) {
    lines.push(truncate(`${n.id} | event | ${n.name} | ${n.description ?? ''}`, 240));
  }
  for (const n of o.processes) {
    lines.push(truncate(`${n.id} | process | ${n.name?.en ?? ''} | steps: ${n.steps.length}`, 240));
  }
  return lines.join('\n');
}

function buildJudgePrompt(digest: string, batch: NumberedSentence[]): { system: string; user: string } {
  const system = [
    'You are a forensic completeness auditor for an enterprise ontology. The ontology below was extracted',
    'from source documents; your job is to decide, sentence by sentence, whether the BUSINESS INFORMATION',
    'each numbered source sentence carries is represented in the ontology. You audit information content,',
    'not wording: a sentence is represented when its facts (an entity, an attribute, a constraint, an',
    'action, an event, a process step) exist in the ontology, regardless of phrasing.',
    '',
    'VERDICTS (closed vocabulary, exactly one per sentence):',
    '- "covered": every piece of business information in the sentence is represented — name the node ids in "coveredBy".',
    '- "partial": some of it is represented — name the node ids in "coveredBy" AND state what is missing in "missing".',
    '- "uncovered": none of it is represented — state in "expectedKinds" which layer kinds the missing',
    '  information belongs to (closed vocabulary: object | rule | action | event | process) and describe it in "missing".',
    '- "uncoverable": the sentence carries no extractable business content (boilerplate, headings, meta, filler).',
    '',
    'FAIL-CLOSED RULE: when unsure between "covered" and "partial", choose "partial". When unsure between',
    '"partial" and "uncovered", choose "uncovered". Understating coverage is recoverable; overstating it hides a gap forever.',
    '',
    'Audit EVERY numbered sentence you are given — one verdict per idx, no idx skipped, no idx invented.',
    '',
    'OUTPUT CONTRACT (frozen — output ONLY this JSON object, no prose, no code fences):',
    '{ "verdicts": [ { "idx": 12, "status": "partial", "coveredBy": ["objectType:order"],',
    '  "expectedKinds": ["rule"], "missing": "the 48h refund window constraint" } ] }',
    '"coveredBy", "expectedKinds" and "missing" are optional per the verdict; "idx" and "status" are mandatory.',
    '',
    'ONTOLOGY DIGEST (id | kind | name | extras):',
    digest || '(the ontology is empty — every content-bearing sentence is "uncovered")',
  ].join('\n');

  const user = [
    'SENTENCES TO AUDIT (idx | document | text):',
    ...batch.map((s) => `${s.idx} | ${s.documentName} | ${s.text}`),
    '',
    'Return one verdict per idx as the JSON object described in the contract.',
  ].join('\n');

  return { system, user };
}

interface Verdict {
  status: SentenceCoverageStatus;
  coveredBy?: string[];
  expectedKinds?: EntityKind[];
  missing?: string;
}

function coerceVerdicts(payload: unknown, known: Set<number>): Map<number, Verdict> {
  const out = new Map<number, Verdict>();
  if (payload === null || typeof payload !== 'object') return out;
  const verdicts = (payload as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(verdicts)) return out;

  for (const v of verdicts) {
    if (v === null || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    const idx = typeof r.idx === 'number' ? r.idx : Number(r.idx);
    if (!Number.isInteger(idx) || !known.has(idx)) continue; // unknown idx ignored
    const statusRaw = typeof r.status === 'string' ? r.status : '';
    if (!STATUS_SET.has(statusRaw)) continue; // fail-closed: no usable verdict
    const verdict: Verdict = { status: statusRaw as SentenceCoverageStatus };

    if (Array.isArray(r.coveredBy)) {
      const ids = r.coveredBy.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, MAX_COVERED_BY);
      if (ids.length > 0) verdict.coveredBy = ids;
    }
    if (Array.isArray(r.expectedKinds)) {
      const kinds = r.expectedKinds.filter((x): x is EntityKind => typeof x === 'string' && EXPECTED_KIND_SET.has(x));
      if (kinds.length > 0) verdict.expectedKinds = [...new Set(kinds)];
    }
    if (typeof r.missing === 'string' && r.missing.trim()) verdict.missing = r.missing.trim();
    out.set(idx, verdict);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  runDocumentCoverageEval — assemble the three tiers into one report.
// ---------------------------------------------------------------------------

/** Run one document-coverage eval pass over the current ontology state. */
export async function runDocumentCoverageEval(input: CoverageEvalInput): Promise<DocumentCoverageEval> {
  const { ctx, ontology, pass } = input;
  const sentences = numberSentences(ctx.parsed, ctx.sources);
  const verdictByIdx = new Map<number, Verdict>();

  // --- Tier 1: deterministic citation overlap --------------------------------
  const intervals = citationIntervals(ontology, ctx.parsed);
  for (const s of sentences) {
    const docIntervals = intervals.get(s.documentId);
    if (!docIntervals || docIntervals.length === 0) continue;
    const coveredBy: string[] = [];
    for (const iv of docIntervals) {
      if (iv.start < s.charEnd && iv.end > s.charStart && !coveredBy.includes(iv.nodeId)) {
        coveredBy.push(iv.nodeId);
        if (coveredBy.length >= MAX_COVERED_BY) break;
      }
    }
    if (coveredBy.length > 0) verdictByIdx.set(s.idx, { status: 'covered', coveredBy });
  }
  const tier1Covered = verdictByIdx.size;

  // --- Tier 2: deterministic boilerplate filter -------------------------------
  let tier2Uncoverable = 0;
  for (const s of sentences) {
    if (verdictByIdx.has(s.idx)) continue;
    if (isUncoverable(s.text)) {
      verdictByIdx.set(s.idx, { status: 'uncoverable' });
      tier2Uncoverable += 1;
    }
  }

  // --- Tier 3: LLM judging of the remainder -----------------------------------
  const remaining = sentences.filter((s) => !verdictByIdx.has(s.idx));
  const batches = batchSentences(remaining, 80);
  ctx.log(
    `[hyper] coverage eval pass ${pass}: ${sentences.length} sentence(s) — tier1 covered ${tier1Covered}, ` +
      `tier2 uncoverable ${tier2Uncoverable}, tier3 judging ${remaining.length} in ${batches.length} batch(es)`,
  );

  if (remaining.length > 0) {
    const digest = ontologyDigest(ontology);
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
      const window = batches.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(
        window.map(async (batch) => {
          const { system, user } = buildJudgePrompt(digest, batch);
          const llm = ctx.agentLlm?.('coverage_evaluator', { inputChars: system.length + user.length })
            ?? { model: ctx.model, provider: ctx.provider };
          const json = await callJson({
            system,
            user,
            model: llm.model,
            provider: llm.provider,
            userInfo: ctx.userInfo,
            actionName: 'ontology_coverage_eval',
            maxTokens: 8000,
            temperature: 0,
          });
          return coerceVerdicts(json, new Set(batch.map((s) => s.idx)));
        }),
      );
      for (const map of results) {
        for (const [idx, verdict] of map) if (!verdictByIdx.has(idx)) verdictByIdx.set(idx, verdict);
      }
    }
  }

  // Fail-closed: any sentence still without a verdict is uncovered.
  let noVerdict = 0;
  for (const s of remaining) {
    if (!verdictByIdx.has(s.idx)) {
      verdictByIdx.set(s.idx, { status: 'uncovered', missing: '(no verdict returned)' });
      noVerdict += 1;
    }
  }
  if (noVerdict > 0) ctx.log(`[hyper] coverage eval pass ${pass}: ${noVerdict} sentence(s) had no verdict — marked uncovered (fail-closed)`);

  // --- Assemble the report -----------------------------------------------------
  const counts: Record<SentenceCoverageStatus, number> = { covered: 0, partial: 0, uncovered: 0, uncoverable: 0 };
  const findings: SentenceCoverage[] = [];
  for (const s of sentences) {
    const v = verdictByIdx.get(s.idx)!;
    counts[v.status] += 1;
    if (v.status !== 'partial' && v.status !== 'uncovered') continue;
    const finding: SentenceCoverage = { idx: s.idx, documentId: s.documentId, text: s.text, status: v.status };
    if (v.coveredBy) finding.coveredBy = v.coveredBy;
    if (v.expectedKinds) finding.expectedKinds = v.expectedKinds;
    if (v.missing) finding.missing = v.missing;
    findings.push(finding);
  }

  const total = sentences.length;
  const ratio = Math.round((counts.covered / Math.max(1, total - counts.uncoverable)) * 10_000) / 10_000;
  const target = coverageTarget(input.target);

  const report: DocumentCoverageEval = {
    pass,
    totalSentences: total,
    covered: counts.covered,
    partial: counts.partial,
    uncovered: counts.uncovered,
    uncoverable: counts.uncoverable,
    coverageRatio: ratio,
    target,
    meetsTarget: ratio >= target,
    findings,
    evaluatedAt: new Date().toISOString(),
  };

  ctx.log(
    `[hyper] coverage eval pass ${pass}: covered ${counts.covered}, partial ${counts.partial}, ` +
      `uncovered ${counts.uncovered}, uncoverable ${counts.uncoverable} — ratio ${ratio} (target ${target}, ` +
      `${report.meetsTarget ? 'MET' : 'NOT met'})`,
  );
  return report;
}
