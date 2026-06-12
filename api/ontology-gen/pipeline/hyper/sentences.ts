// ============================================================================
//  HYPER-AUTOMATION — sentence substrate (pure, no LLM).
//
//  Flattens every parsed source into ONE globally-numbered sentence list — the
//  unit of account for the document-coverage eval ("did the ontology represent
//  EVERY sentence?"). Numbering is 1-based and CONTINUOUS across sources so a
//  single `idx` identifies a sentence anywhere in the corpus; each entry keeps
//  exact char offsets into ITS document's parsed text so the deterministic
//  eval pre-pass can span-overlap sentences against grounded citations:
//  `parsed.text.slice(charStart, charEnd) === sentence.text` ALWAYS holds.
//
//  Splitting mirrors the rules stage's private splitter (deliberate, documented
//  duplication — stages/rules.ts is not refactored to keep blast radius zero):
//  sentence-final punctuation incl. CJK (。！？；) and hard line breaks, with
//  one upgrade required by offset tracking: CJK sentence-final punctuation
//  splits even WITHOUT trailing whitespace (Chinese prose has none).
// ============================================================================

import type { ParsedSource, SourceDocument } from '../../../_shared/ontology-schema.js';

/** One source sentence, globally numbered, with exact offsets into its document. */
export interface NumberedSentence {
  /** GLOBAL 1-based index, continuous across all sources. */
  idx: number;
  documentId: string;
  documentName: string;
  text: string;
  /** Offset into that document's normalized parsed text (inclusive). */
  charStart: number;
  /** Offset into that document's normalized parsed text (exclusive). */
  charEnd: number;
}

/** Sentence-final punctuation that ends a sentence even without whitespace (CJK). */
const CJK_FINAL = new Set(['。', '！', '？', '；']);
/** Sentence-final punctuation that ends a sentence only before whitespace (Latin). */
const LATIN_FINAL = new Set(['.', '!', '?', ';']);

function isWs(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * Scan one document's text into trimmed sentence spans. Offsets are computed
 * while scanning (NOT by re-searching the trimmed text, which would mislocate
 * repeated sentences): a raw segment ends after CJK sentence-final punctuation,
 * after Latin sentence-final punctuation followed by whitespace, or at a hard
 * line break; the span is then shrunk past leading/trailing whitespace so the
 * slice is byte-exact for the trimmed sentence.
 */
function sentenceSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];

  const push = (rawStart: number, rawEnd: number): void => {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && isWs(text[start])) start += 1;
    while (end > start && isWs(text[end - 1])) end -= 1;
    if (end > start) spans.push({ start, end });
  };

  let segStart = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n' || ch === '\r') {
      // Hard line break: end the segment, consume the whole break run.
      push(segStart, i);
      while (i < text.length && (text[i] === '\n' || text[i] === '\r')) i += 1;
      segStart = i;
    } else if (CJK_FINAL.has(ch)) {
      // CJK sentence end: split immediately (no whitespace follows in CJK prose).
      push(segStart, i + 1);
      i += 1;
      segStart = i;
    } else if (LATIN_FINAL.has(ch) && isWs(text[i + 1])) {
      // Latin sentence end: only before whitespace ("3.2" stays whole).
      push(segStart, i + 1);
      i += 1;
      segStart = i;
    } else {
      i += 1;
    }
  }
  push(segStart, text.length);
  return spans;
}

/**
 * Flatten every parsed source into the globally-numbered sentence list.
 * Numbering is 1-based and continuous across sources (in `parsed` order);
 * each sentence carries its owning document id/name and exact char offsets
 * such that `parsed.text.slice(charStart, charEnd) === sentence.text`.
 */
export function numberSentences(parsed: ParsedSource[], sources: SourceDocument[]): NumberedSentence[] {
  const docNameById = new Map<string, string>();
  for (const d of sources) docNameById.set(d.id, d.name);

  const out: NumberedSentence[] = [];
  let idx = 1;
  for (const p of parsed) {
    const text = typeof p.text === 'string' ? p.text : '';
    if (!text.trim()) continue;
    const documentId = p.documentId;
    const documentName = docNameById.get(documentId) ?? documentId;
    for (const span of sentenceSpans(text)) {
      out.push({
        idx,
        documentId,
        documentName,
        text: text.slice(span.start, span.end),
        charStart: span.start,
        charEnd: span.end,
      });
      idx += 1;
    }
  }
  return out;
}

/** Chunk the sentence list into batches for the LLM judging tier (default 80). */
export function batchSentences(s: NumberedSentence[], maxPerBatch = 80): NumberedSentence[][] {
  const size = Math.max(1, maxPerBatch);
  const out: NumberedSentence[][] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
