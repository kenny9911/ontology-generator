// ============================================================================
// Document parse + chunk + sentence-numbering helpers (T10).
//
// Pure helpers — no LLM, no I/O beyond decoding the bytes handed to us. Turns a
// raw upload (PDF / DOCX / md / txt / html) into a normalized `ParsedSource`-shaped
// payload (documentId, text, pageMap, contentHash, kind) whose `text` is the
// substrate every downstream citation offset (`SourceRef.charStart/charEnd`) is
// computed against. Also exposes `numberSentences` (the spine of sentence-level
// rule citations) and `chunk` (overlapping windows that NEVER split a sentence).
//
// NodeNext / strict TS: project relative imports use a `.js` suffix; node
// builtins ('crypto') are bare specifiers. Types come from the backend mirror.
// ============================================================================

import { createHash } from 'crypto';
import type { ParsedSource } from '../_shared/ontology-schema.js';

// pdf-parse ships no types; we only use the (dataBuffer, options) -> {text,numpages}
// surface, with a custom `pagerender` to capture per-page text for the page map.
// @ts-ignore — untyped CJS module.
import pdfParse from 'pdf-parse';
// @ts-ignore — mammoth's bundled types are CJS; we only call extractRawText.
import mammoth from 'mammoth';

// ----------------------------------------------------------------------------
// Public shapes
// ----------------------------------------------------------------------------

/** What `parseDocument` consumes. Exactly one of `bytes` / `text` is required. */
export interface ParseInput {
  name: string;
  mime?: string;
  bytes?: Buffer;
  text?: string;
}

/**
 * A `ParsedSource` plus the bits the caller (the `upload` handler) needs to mint
 * a `SourceDocument`: `contentHash`, the resolved `kind`, and `pageCount`.
 * `documentId` is a stand-in slug computed from the filename; the handler is
 * responsible for re-keying it through `makeId('doc', name, taken)` and wiring up
 * `ref`/`parsedRef`. We keep this helper pure (no id collision set) by design.
 */
export interface ParsedDocument extends ParsedSource {
  contentHash: string;
  kind: 'doc' | 'db' | 'app';
  pageCount: number;
}

/** A numbered sentence with its char span into the normalized text. */
export interface NumberedSentence {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkOptions {
  /** Soft target size of each chunk, in characters. Default 6000. */
  targetChars?: number;
  /** Approximate overlap between consecutive chunks, in characters. Default 600. */
  overlapChars?: number;
}

/** A chunk of text aligned to whole sentences, carrying its sentence index range. */
export interface TextChunk {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
  /** Inclusive sentence index range covered by this chunk. */
  sentenceStart: number;
  sentenceEnd: number;
  /** The sentence indices in this chunk (sentenceStart..sentenceEnd inclusive). */
  sentenceIndices: number[];
}

// ----------------------------------------------------------------------------
// Whitespace normalization
// ----------------------------------------------------------------------------

/**
 * Collapse intra-line whitespace runs to a single space while PRESERVING line
 * breaks (newlines are the sentence/paragraph signal the chunker relies on).
 * Also normalizes CRLF/CR -> LF, strips zero-width chars, trims trailing spaces
 * per line, and collapses 3+ blank lines to a single blank line. Idempotent.
 */
export function normalizeWhitespace(raw: string): string {
  let s = raw.replace(/\r\n?/g, '\n');
  // Strip BOM and zero-width / non-breaking oddities that wreck offset math.
  s = s.replace(/﻿/g, '').replace(/[​-‍⁠]/g, '');
  s = s.replace(/ /g, ' ');
  // Per line: collapse runs of spaces/tabs, trim trailing space.
  s = s
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').replace(/ +$/g, '').replace(/^ +/g, ''))
    .join('\n');
  // Collapse 3+ consecutive newlines to exactly two (one blank line).
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ----------------------------------------------------------------------------
// Format-specific extraction
// ----------------------------------------------------------------------------

function extFromName(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/**
 * Best-effort classification of a source by mime then extension, defaulting to
 * a plaintext passthrough. PDFs and DOCX are the only formats that need a real
 * decoder; everything else is treated as text/markup.
 */
type Format = 'pdf' | 'docx' | 'html' | 'text';

function detectFormat(name: string, mime?: string): Format {
  const m = (mime || '').toLowerCase();
  const ext = extFromName(name);
  if (m.includes('pdf') || ext === 'pdf') return 'pdf';
  if (
    m.includes('officedocument.wordprocessingml') ||
    m.includes('msword') ||
    ext === 'docx' ||
    ext === 'doc'
  ) {
    return 'docx';
  }
  if (m.includes('html') || ext === 'html' || ext === 'htm') return 'html';
  return 'text';
}

/** Strip HTML/XML tags, decode the few common entities, drop script/style bodies. */
export function stripTags(html: string): string {
  let s = html;
  // Remove script/style blocks entirely (content is not document prose).
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Treat block-level closers as line breaks so structure survives normalization.
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|ul|ol)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Drop all remaining tags and HTML comments.
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');
  // Decode a minimal entity set.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
  // Numeric entities.
  s = s.replace(/&#(\d+);/g, (_m, d: string) => {
    const code = Number(d);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
  return s;
}

/** pdf-parse page-render hook: capture each page's raw text in order. */
function makePageCapture(pages: string[]): (pageData: PdfPageData) => Promise<string> {
  return async (pageData: PdfPageData): Promise<string> => {
    const content = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    let lastY: number | undefined;
    let text = '';
    for (const item of content.items) {
      const y = item.transform[5];
      if (lastY === y || lastY === undefined) text += item.str;
      else text += '\n' + item.str;
      lastY = y;
    }
    pages.push(text);
    return text;
  };
}

interface PdfTextItem {
  str: string;
  transform: number[];
}
interface PdfTextContent {
  items: PdfTextItem[];
}
interface PdfPageData {
  getTextContent(opts: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }): Promise<PdfTextContent>;
}

/**
 * Extract a PDF into normalized text + a `pageMap` aligned to that text. We drive
 * pdf-parse's `pagerender` to collect per-page text, then normalize EACH page
 * independently and re-join with a blank-line separator so the page boundaries
 * land at exact, recomputable char offsets in the final text.
 */
async function extractPdf(
  bytes: Buffer
): Promise<{ text: string; pageMap: ParsedSource['pageMap']; pageCount: number }> {
  const pages: string[] = [];
  let pageCount = 0;
  try {
    const result = (await pdfParse(bytes, {
      pagerender: makePageCapture(pages),
    })) as { numpages?: number };
    pageCount = typeof result.numpages === 'number' ? result.numpages : pages.length;
  } catch {
    // Corrupt/locked PDF: degrade to whatever pages we captured (possibly none).
    pageCount = pages.length;
  }

  const SEP = '\n\n';
  const pageMap: NonNullable<ParsedSource['pageMap']> = [];
  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < pages.length; i++) {
    const norm = normalizeWhitespace(pages[i]);
    if (norm.length === 0) continue;
    if (parts.length > 0) cursor += SEP.length;
    const charStart = cursor;
    const charEnd = charStart + norm.length;
    pageMap.push({ page: i + 1, charStart, charEnd });
    parts.push(norm);
    cursor = charEnd;
  }

  return {
    text: parts.join(SEP),
    pageMap: pageMap.length > 0 ? pageMap : undefined,
    pageCount: pageCount || pageMap.length,
  };
}

/** Extract DOCX raw text via mammoth. */
async function extractDocx(bytes: Buffer): Promise<string> {
  try {
    const result = (await mammoth.extractRawText({ buffer: bytes })) as { value?: string };
    return result.value || '';
  } catch {
    // Old .doc or malformed: degrade to a lossy plaintext decode.
    return bytes.toString('utf8');
  }
}

// ----------------------------------------------------------------------------
// parseDocument
// ----------------------------------------------------------------------------

/**
 * Parse one source into a normalized `ParsedSource`-shaped payload.
 *
 * - PDF   -> pdf-parse, per-page normalize + `pageMap`.
 * - DOCX  -> mammoth raw text.
 * - md/txt/html -> passthrough (HTML has its tags stripped first).
 *
 * The returned `text` is fully whitespace-normalized; `contentHash` is the
 * SHA-256 of that normalized text (so a re-upload of the same content re-keys to
 * a stable id and de-dupes). `documentId`/`ref` here are filename-derived
 * placeholders the caller re-keys through `makeId` + the parsed-store.
 */
export async function parseDocument(input: ParseInput): Promise<ParsedDocument> {
  const { name, mime } = input;
  const format = detectFormat(name, mime);

  let text = '';
  let pageMap: ParsedSource['pageMap'];
  let pageCount = 0;

  if (input.text !== undefined && format !== 'pdf' && format !== 'docx') {
    // Pre-decoded text (e.g. sample fixtures, db/app sources): just normalize.
    text = format === 'html' ? normalizeWhitespace(stripTags(input.text)) : normalizeWhitespace(input.text);
  } else if (format === 'pdf') {
    const bytes = input.bytes ?? Buffer.from(input.text ?? '', 'utf8');
    const out = await extractPdf(bytes);
    text = out.text;
    pageMap = out.pageMap;
    pageCount = out.pageCount;
  } else if (format === 'docx') {
    const bytes = input.bytes ?? Buffer.from(input.text ?? '', 'utf8');
    const raw = await extractDocx(bytes);
    text = normalizeWhitespace(raw);
  } else {
    // text / html from bytes.
    const raw = input.bytes ? input.bytes.toString('utf8') : input.text ?? '';
    text = format === 'html' ? normalizeWhitespace(stripTags(raw)) : normalizeWhitespace(raw);
  }

  const contentHash = 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
  const slug = slugify(name) || 'document';

  return {
    ref: 'parsed_' + contentHash.slice(7, 23),
    documentId: 'doc:' + slug,
    text,
    pageMap,
    contentHash,
    kind: 'doc',
    pageCount,
  };
}

/** Lowercase, kebab-case slug from a filename (extension dropped). Local helper
 *  for the placeholder ids only — authoritative ids come from `makeId`. */
function slugify(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  return base
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// ----------------------------------------------------------------------------
// Sentence numbering
// ----------------------------------------------------------------------------

/**
 * Split normalized text into numbered sentences with exact char spans. Splitting
 * is conservative: we break on sentence-final punctuation (`. ! ? 。 ！ ？`)
 * followed by whitespace, on blank lines (paragraph breaks), and we DO NOT break
 * after common abbreviations or decimal numbers. Every returned span is a verbatim
 * slice of `text` (`text.slice(charStart, charEnd) === sentence.text` modulo the
 * trimmed leading whitespace), so rule citations can point at a sentence index and
 * the backend can recover its exact offsets.
 */
export function numberSentences(text: string): NumberedSentence[] {
  const sentences: NumberedSentence[] = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  let index = 0;

  const pushSpan = (from: number, to: number): void => {
    // Trim leading/trailing whitespace inside the span but keep offsets exact.
    let a = from;
    let b = to;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b <= a) return;
    sentences.push({ index: index++, text: text.slice(a, b), charStart: a, charEnd: b });
  };

  while (i < n) {
    const ch = text[i];

    // Paragraph break: a blank line forces a sentence boundary.
    if (ch === '\n' && i + 1 < n && text[i + 1] === '\n') {
      pushSpan(start, i);
      // Skip the run of newlines.
      i += 1;
      while (i < n && text[i] === '\n') i++;
      start = i;
      continue;
    }

    const isTerminator =
      ch === '.' || ch === '!' || ch === '?' || ch === '。' || ch === '！' || ch === '？';

    if (isTerminator) {
      // CJK terminators are unambiguous boundaries.
      const cjk = ch === '。' || ch === '！' || ch === '？';
      // For ASCII '.', avoid splitting decimals (3.14) and abbreviations (Inc.).
      if (!cjk && ch === '.' && isMidTokenDot(text, i)) {
        i++;
        continue;
      }
      // Consume a run of terminators / closing quotes / brackets.
      let j = i + 1;
      while (j < n && /[.!?。！？”’"')\]]/.test(text[j])) j++;
      // Boundary requires end-of-text or following whitespace.
      if (j >= n || /\s/.test(text[j])) {
        pushSpan(start, j);
        i = j;
        while (i < n && /\s/.test(text[i]) && text[i] !== '\n') i++;
        start = i;
        continue;
      }
    }
    i++;
  }
  // Trailing remainder.
  if (start < n) pushSpan(start, n);
  return sentences;
}

const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'inc',
  'ltd',
  'co',
  'corp',
  'no',
  'fig',
  'eg',
  'ie',
  'al',
  'dept',
  'approx',
  'min',
  'max',
  'sec',
]);

/**
 * Is the `.` at position `i` part of a token rather than a sentence end?
 * True for decimals (digit on both sides), single-letter initials (`A.`), and a
 * known abbreviation immediately preceding it.
 */
function isMidTokenDot(text: string, i: number): boolean {
  const prev = text[i - 1];
  const next = text[i + 1];
  // Decimal: 3.14
  if (prev !== undefined && next !== undefined && /\d/.test(prev) && /\d/.test(next)) return true;
  // Preceding word token.
  let k = i - 1;
  while (k >= 0 && /[A-Za-z]/.test(text[k])) k--;
  const word = text.slice(k + 1, i).toLowerCase();
  if (word.length === 1) return true; // initial like "A."
  if (ABBREVIATIONS.has(word)) return true;
  return false;
}

// ----------------------------------------------------------------------------
// Chunking (never splits mid-sentence)
// ----------------------------------------------------------------------------

/**
 * Split text into overlapping chunks built from WHOLE sentences. A chunk grows by
 * appending sentences until it reaches `targetChars`; the next chunk back-tracks
 * by whole sentences to cover ~`overlapChars` of the prior chunk's tail (so a
 * fact spanning a boundary is still seen intact). Each chunk records its char
 * span and its inclusive sentence index range; boundaries always fall ON sentence
 * edges. A single oversized sentence becomes its own chunk rather than being cut.
 */
export function chunk(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const targetChars = Math.max(500, opts.targetChars ?? 6000);
  const overlapChars = Math.max(0, Math.min(opts.overlapChars ?? 600, targetChars - 1));

  const sentences = numberSentences(text);
  if (sentences.length === 0) return [];

  const chunks: TextChunk[] = [];
  let cursor = 0; // index into `sentences` where the current chunk starts
  let chunkIndex = 0;

  while (cursor < sentences.length) {
    let end = cursor; // exclusive upper bound (sentence index)
    let size = 0;
    // Always include at least one sentence (handles oversized single sentences).
    while (end < sentences.length) {
      const sLen = sentences[end].charEnd - sentences[end].charStart;
      if (end > cursor && size + sLen > targetChars) break;
      size += sLen;
      end++;
    }

    const first = sentences[cursor];
    const last = sentences[end - 1];
    const sentenceIndices: number[] = [];
    for (let s = cursor; s < end; s++) sentenceIndices.push(sentences[s].index);

    chunks.push({
      index: chunkIndex++,
      text: text.slice(first.charStart, last.charEnd),
      charStart: first.charStart,
      charEnd: last.charEnd,
      sentenceStart: first.index,
      sentenceEnd: last.index,
      sentenceIndices,
    });

    if (end >= sentences.length) break;

    // Back-track for overlap: walk back from `end` accumulating tail length.
    let back = end;
    let tail = 0;
    while (back > cursor + 1) {
      const sLen = sentences[back - 1].charEnd - sentences[back - 1].charStart;
      if (tail + sLen > overlapChars) break;
      tail += sLen;
      back--;
    }
    // Guarantee forward progress (avoid an infinite loop when overlap is large).
    cursor = back > cursor ? back : cursor + 1;
  }

  return chunks;
}
