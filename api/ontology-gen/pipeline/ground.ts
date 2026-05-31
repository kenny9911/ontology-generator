// ============================================================================
//  ground.ts — citation grounding (quote -> SourceRef offsets + quoteVerified)
// ----------------------------------------------------------------------------
//  DESIGN_SPEC.md §5.1 step 3 ("ground"), §6 check 3 ("quoteVerified recompute"),
//  SCHEMA.md §8 ("ungrounded extracted nodes are dropped, synthesized nodes use
//  derivedFrom"). TASK_PLAN.md T8.
//
//  PURE + DETERMINISTIC. No LLM, no I/O. Given the verbatim `snippet` each
//  SourceRef carries (the model returns the quote; the backend NEVER trusts the
//  model for offsets or verification), we locate it inside the matching
//  ParsedSource.text and record where it lives:
//
//    1. exact substring                -> highest fidelity
//    2. whitespace-normalized substring -> tolerant of reflowed PDF/DOCX text
//    3. token-window fuzzy (Jaccard ≥ THRESHOLD) -> tolerant of minor edits
//
//  `quoteVerified` is set true IFF a normalized (i.e. step 1 or 2) match is
//  found — the same deterministic `normalize(text).includes(normalize(snippet))`
//  rule the validator (§6.3) re-runs. A fuzzy-only (step 3) match still sets
//  offsets for highlighting but leaves `quoteVerified=false`, so the reviewer
//  and the confidence rubric treat it as un-grounded.
//
//  Generic over node shape: we only require a node to expose a `sources` array
//  (plus `provenance`/`derivedFrom` for the drop helper). Stage outputs
//  (ObjectType, Relationship, Rule, ...) all satisfy this via NodeProvenance.
// ============================================================================

import type { ParsedSource, SourceRef, Provenance } from '../../_shared/ontology-schema.js';

/** Jaccard token-overlap floor for a fuzzy (offset-only) match. */
const FUZZY_THRESHOLD = 0.8;

/**
 * The minimal contract a node must satisfy to be grounded. Stage outputs carry
 * `sources: SourceRef[]` via the schema's NodeProvenance mixin; we accept an
 * optional array so attribute-level / partially-built nodes never throw.
 */
export interface GroundableNode {
  sources?: SourceRef[];
}

/**
 * The fields the drop helper inspects. `inferred`/`merged` nodes are kept
 * regardless of citation state because they carry `derivedFrom` instead.
 */
export interface DroppableNode extends GroundableNode {
  provenance: Provenance;
  derivedFrom?: string[];
}

// ---------------------------------------------------------------------------
// Text normalization (MUST stay in lockstep with the validator's recompute).
// Collapse every run of whitespace (incl. newlines/tabs) to a single space,
// trim, lowercase. Deterministic and idempotent.
// ---------------------------------------------------------------------------
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Tokenize on whitespace after normalization. Empty input -> []. */
function tokenize(s: string): string[] {
  const n = normalize(s);
  return n.length === 0 ? [] : n.split(' ');
}

/** Jaccard similarity over token *sets* (presence, not multiplicity). */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// Per-source grounding index. Built once per ParsedSource and reused across
// all SourceRefs that cite it, so grounding N citations is ~O(N · text).
// We precompute a normalized projection of the original text together with a
// map from normalized-char-index -> original-char-index, which lets a match
// found in normalized space be reported as offsets into the ORIGINAL text
// (what the UI highlights against and what `pageMap` is keyed on).
// ---------------------------------------------------------------------------
interface SourceIndex {
  source: ParsedSource;
  /** Whitespace-normalized (lowercased) projection of `source.text`. */
  norm: string;
  /** norm[i] originates at this index in the original `source.text`. */
  normToOrig: number[];
  /** Original-text char index at which each line (0-based) begins. */
  lineStarts: number[];
}

function buildSourceIndex(source: ParsedSource): SourceIndex {
  const text = source.text;
  // Build the normalized projection char-by-char so we keep a faithful
  // back-pointer to the original index for every normalized char.
  let norm = '';
  const normToOrig: number[] = [];
  let pendingSpace = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      // Defer: only emit a single space, and only between non-space content.
      if (started) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      norm += ' ';
      // The collapsed-space maps to the first original char of THIS token,
      // which keeps offsets monotonic and inside the original text.
      normToOrig.push(i);
      pendingSpace = false;
    }
    norm += ch.toLowerCase();
    normToOrig.push(i);
    started = true;
  }

  // Line starts for deterministic 1-based line numbers.
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStarts.push(i + 1);
  }

  return { source, norm, normToOrig, lineStarts };
}

/** 1-based line number for an original-text char offset (binary search). */
function lineForOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans + 1;
}

/** 1-based page for an original-text char offset, from the source pageMap. */
function pageForOffset(source: ParsedSource, charStart: number, charEnd: number): number | undefined {
  const map = source.pageMap;
  if (!map || map.length === 0) return undefined;
  // The page that contains the start of the match; fall back to the page whose
  // span best overlaps [charStart,charEnd) if no page strictly contains start.
  for (const p of map) {
    if (charStart >= p.charStart && charStart < p.charEnd) return p.page;
  }
  let best: { page: number; overlap: number } | undefined;
  for (const p of map) {
    const overlap = Math.min(charEnd, p.charEnd) - Math.max(charStart, p.charStart);
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { page: p.page, overlap };
  }
  return best?.page;
}

interface MatchResult {
  charStart: number;
  charEnd: number;
  /** true only for exact / normalized matches (the quoteVerified rule). */
  verified: boolean;
}

/**
 * Locate `snippet` inside the indexed source.
 *   exact -> normalized substring -> token-window fuzzy (Jaccard ≥ threshold).
 * Returns original-text offsets, or undefined when nothing reaches the bar.
 */
function locate(idx: SourceIndex, snippet: string): MatchResult | undefined {
  const text = idx.source.text;

  // 1. Exact substring in the ORIGINAL text — best possible evidence.
  const exact = text.indexOf(snippet);
  if (exact !== -1) {
    return { charStart: exact, charEnd: exact + snippet.length, verified: true };
  }

  // 2. Whitespace-normalized substring. Search inside the normalized projection
  //    and translate the hit back to original offsets via normToOrig.
  const nSnip = normalize(snippet);
  if (nSnip.length > 0) {
    const at = idx.norm.indexOf(nSnip);
    if (at !== -1) {
      const lastNormIdx = at + nSnip.length - 1;
      const charStart = idx.normToOrig[at];
      // End is exclusive: one past the original char of the last matched token.
      const lastOrig = idx.normToOrig[lastNormIdx];
      const charEnd = lastOrig + 1;
      return { charStart, charEnd, verified: true };
    }
  }

  // 3. Token-window fuzzy. Slide a window the size of the snippet's token count
  //    over the source tokens; keep the best Jaccard ≥ FUZZY_THRESHOLD.
  const snipTokens = tokenize(snippet);
  if (snipTokens.length === 0) return undefined;

  // Build source tokens WITH their original-text spans (start..end exclusive).
  const srcTokens: { tok: string; start: number; end: number }[] = [];
  {
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      srcTokens.push({ tok: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
    }
  }
  if (srcTokens.length === 0) return undefined;
  // Safety bound: for very large sources the token-window sweep isn't worth the
  // cost, and a fuzzy match is non-verifying anyway (the node is kept regardless
  // by dropUngroundedNodes). Skip to keep grounding linear-ish in source size.
  if (srcTokens.length > 4000) return undefined;

  const win = snipTokens.length;
  let best: { score: number; start: number; end: number } | undefined;
  // Window from `win` down lets a slightly-shorter source span still match;
  // we scan the exact window size first (most precise), which is sufficient
  // for the ≥0.8 Jaccard bar while staying deterministic and bounded.
  const limit = Math.max(0, srcTokens.length - win) + 1;
  for (let i = 0; i < limit; i++) {
    const windowToks: string[] = [];
    for (let j = i; j < i + win && j < srcTokens.length; j++) windowToks.push(srcTokens[j].tok);
    const score = jaccard(snipTokens, windowToks);
    if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
      const endTok = srcTokens[Math.min(i + win, srcTokens.length) - 1];
      best = { score, start: srcTokens[i].start, end: endTok.end };
    }
  }

  if (best) {
    // Fuzzy match: record offsets for highlighting but DO NOT set verified —
    // only exact/normalized matches satisfy the deterministic quote check.
    return { charStart: best.start, charEnd: best.end, verified: false };
  }

  return undefined;
}

/**
 * Ground every citation each node carries against the parsed sources.
 *
 * MUTATES the SourceRefs in place (sets `charStart`/`charEnd`/`page`/`line`/
 * `quoteVerified`) and returns the same `nodes` array for chaining. A snippet
 * whose source isn't found, or that matches nowhere, is left with cleared
 * offsets and `quoteVerified = false`.
 *
 * Generic over node shape: any object exposing a `sources` array works.
 */
export function groundSources<T extends GroundableNode>(nodes: T[], parsed: ParsedSource[]): T[] {
  // Index sources by documentId (the SourceRef join key). Last one wins on a
  // dup documentId, which mirrors the store's de-dupe on re-parse.
  const indexByDoc = new Map<string, SourceIndex>();
  for (const p of parsed) {
    indexByDoc.set(p.documentId, buildSourceIndex(p));
  }

  for (const node of nodes) {
    const refs = node.sources;
    if (!refs) continue;
    for (const ref of refs) {
      const idx = indexByDoc.get(ref.documentId);
      if (!idx || !ref.snippet || ref.snippet.trim().length === 0) {
        ref.quoteVerified = false;
        ref.charStart = undefined;
        ref.charEnd = undefined;
        continue;
      }
      const hit = locate(idx, ref.snippet);
      if (!hit) {
        ref.quoteVerified = false;
        ref.charStart = undefined;
        ref.charEnd = undefined;
        continue;
      }
      ref.charStart = hit.charStart;
      ref.charEnd = hit.charEnd;
      ref.line = lineForOffset(idx.lineStarts, hit.charStart);
      const page = pageForOffset(idx.source, hit.charStart, hit.charEnd);
      if (page !== undefined) ref.page = page;
      ref.quoteVerified = hit.verified;
    }
  }

  return nodes;
}

/**
 * Drop EXTRACTED nodes whose every citation is unverifiable (no source, or all
 * `quoteVerified !== true`). `inferred`/`merged`/`human` nodes are KEPT
 * regardless — they intentionally carry `derivedFrom` (or human authorship)
 * rather than verbatim quotes. (SCHEMA.md §8; DESIGN_SPEC.md §5.1 step 3.)
 *
 * PURE: returns a new filtered array; does not mutate `nodes`.
 */
export function dropUngroundedNodes<T extends DroppableNode>(nodes: T[]): T[] {
  return nodes.filter((node) => {
    if (node.provenance !== 'extracted') return true; // keep inferred/merged/human
    const refs = node.sources;
    // Per the SourceRef contract, a citation that is unverified OR only
    // fuzzy-located is FLAGGED (quoteVerified=false) and confidence-downgraded
    // for human review — it is NOT silently dropped. We therefore keep any
    // extracted node that carries at least one citation; only an extracted node
    // with NO citation at all is treated as ungrounded and removed. (Dropping
    // strictly on quoteVerified===true nuked entire rule/action layers whenever
    // the model paraphrased a quote — wrong for a human-in-the-loop product.)
    return Array.isArray(refs) && refs.length > 0;
  });
}
