// ============================================================================
//  HYPER-AUTOMATION — terminology & data-type recognition (hyper phase 1).
//
//  An exhaustive glossary sweep over every parsed source: every business term,
//  entity, attribute, metric, role, status-enum set, document kind, system and
//  abbreviation — bilingual, with a closed-vocabulary kind, an optional
//  DataType hint, and a VERBATIM snippet citation. Terms are METADATA, not
//  layer nodes: the orchestrator never grounds them, but snippets must be
//  verbatim per the prompt contract.
//
//  The rendered seed block (`renderTermSeed`) is appended to every later
//  extraction prompt so each recognized term becomes a recall expectation.
//  `matchTerms` is the deterministic reconciliation: which ontology node
//  realized each term (sets `matchedId`, never mutates its input).
//
//  Chunked at ~24k chars with 500-char overlap, one tracked LLM call per
//  chunk, ≤ 3 concurrent; merged across chunks by lowercase(term.en)+kind.
//  Agent id: `terminology_extractor`. LLM/JSON failures degrade to logged
//  notes — a lost chunk loses terms, never the run.
// ============================================================================

import { DATA_TYPES } from '../../../_shared/ontology-schema.js';
import type {
  DataType,
  Ontology,
  ParsedSource,
  SourceDocument,
  SourceRef,
  TermEntity,
  TermKind,
  TerminologyExtraction,
} from '../../../_shared/ontology-schema.js';
import { makeId } from '../../../_shared/ids.js';
import { executeLLMWithTracking } from '../../llm.js';
import type { ExecuteLLMOptions } from '../../llm.js';
import { extractJson } from '../swarm/llm-json.js';
import type { StageContext } from '../context.js';

// ---------------------------------------------------------------------------
//  Chunking — ~24k chars per LLM call, 500-char overlap so terms straddling a
//  boundary are seen whole by at least one chunk.
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 24_000;
const CHUNK_OVERLAP = 500;
const MAX_CONCURRENT = 3;
/** renderTermSeed budget — keeps the seed block from crowding the stage prompt. */
const SEED_BUDGET = 6_000;

interface Chunk {
  documentId: string;
  documentName: string;
  text: string;
}

function chunkSources(parsed: ParsedSource[], sources: SourceDocument[]): Chunk[] {
  const nameById = new Map<string, string>();
  for (const d of sources) nameById.set(d.id, d.name);

  const chunks: Chunk[] = [];
  for (const p of parsed) {
    const text = typeof p.text === 'string' ? p.text : '';
    if (!text.trim()) continue;
    const documentName = nameById.get(p.documentId) ?? p.documentId;
    let start = 0;
    while (start < text.length) {
      const end = Math.min(text.length, start + CHUNK_SIZE);
      chunks.push({ documentId: p.documentId, documentName, text: text.slice(start, end) });
      if (end >= text.length) break;
      start = end - CHUNK_OVERLAP;
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
//  Prompt — authored per the prompt doctrine (docs/HYPER_AUTOMATION_DESIGN.md §4):
//  frozen JSON contract, recall-first sweep, negative-space checks, citation
//  discipline, counting self-check.
// ---------------------------------------------------------------------------

const TERM_KINDS = new Set<string>([
  'entity', 'attribute', 'metric', 'role', 'status', 'document',
  'system', 'abbreviation', 'event', 'process', 'other',
]);
const DATA_TYPE_SET = new Set<string>(DATA_TYPES as readonly string[]);

function buildTerminologyPrompt(chunk: Chunk): { system: string; user: string } {
  const system = [
    'You are an expert business-terminology and data-architecture analyst. Your single deliverable is the',
    'DEFINITIVE, EXHAUSTIVE glossary of the document chunk you are given — the foundation a downstream',
    'ontology-extraction pipeline will be held accountable against, sentence by sentence.',
    '',
    'MISSION — EXHAUSTIVE RECALL. Capture EVERY term of business significance: every business entity,',
    'attribute/field, metric/KPI, role/actor, status value set, document kind, system/application,',
    'abbreviation, business event, and business process the chunk names. When in doubt, INCLUDE the term.',
    '',
    'SWEEP DISCIPLINE: read the chunk section by section. For each section, ENUMERATE every candidate term',
    'BEFORE filtering anything out. After the full sweep, run an explicit completeness pass: re-scan each',
    'section; if a section contributed zero terms, justify that to yourself silently before moving on.',
    '',
    'COMMONLY MISSED — check each of these explicitly before finishing:',
    '- monetary amounts and their currencies; thresholds and limits buried in prose',
    '- durations, deadlines and SLA windows; calendar dates vs precise timestamps',
    '- identifiers, codes and reference numbers (order numbers, claim ids, SKUs)',
    '- enumerations spelled out in prose ("status may be pending, approved, or rejected")',
    '- abbreviations defined once and used everywhere; bilingual synonyms of the same term',
    '- lookup/reference data, parties/counterparties, documents-as-entities, line items',
    '',
    'TERM KIND (closed vocabulary — exactly one per term):',
    'entity | attribute | metric | role | status | document | system | abbreviation | event | process | other',
    '',
    `DATA TYPE HINT (closed vocabulary, only when inferable): ${DATA_TYPES.join(' | ')}`,
    'Guidance: money amounts -> "money" (or "decimal" for unitless numerics); calendar dates -> "date";',
    'precise timestamps -> "datetime"; durations -> "integer" or "decimal" with the unit stated in the',
    'definition; identifiers/codes -> "uuid" only when explicitly a UUID, otherwise "string"; enumerations',
    'spelled out in prose -> "enum" WITH "enumValuesHint" listing the values in document order; references',
    'to another entity -> "reference". Omit the field entirely when no data type is inferable.',
    '',
    'BILINGUAL OUTPUT IS MANDATORY: every term and every definition carries BOTH "en" and "zh". Translate',
    'faithfully when the document uses only one language.',
    '',
    'CITATION DISCIPLINE: "snippet" is a VERBATIM quote from the chunk — copied character for character,',
    'never paraphrased, never trimmed mid-word. Pick the sentence/clause that best evidences the term.',
    '',
    'OUTPUT CONTRACT (frozen — output ONLY this JSON object, no prose, no code fences):',
    '{ "terms": [ {',
    '  "term": { "en": "...", "zh": "..." },',
    '  "definition": { "en": "...", "zh": "..." },',
    '  "kind": "entity",',
    '  "dataTypeHint": "money",',
    '  "enumValuesHint": ["..."],',
    '  "aliases": ["..."],',
    '  "snippet": "verbatim quote from the chunk"',
    '} ] }',
    '"dataTypeHint", "enumValuesHint" and "aliases" are optional; omit them when not applicable.',
    '',
    'SELF_CHECK (perform silently before answering):',
    '1. State how many sections the chunk has and how many terms each section yielded; any section with',
    '   zero terms needs a reason.',
    '2. Verify every snippet is a verbatim quote, every term and definition is bilingual, and every',
    '   "kind"/"dataTypeHint" value is inside its closed vocabulary.',
    '3. Re-check the COMMONLY MISSED list one more time.',
  ].join('\n');

  const user = [
    `DOCUMENT: ${chunk.documentName}`,
    'CHUNK TEXT:',
    '"""',
    chunk.text,
    '"""',
    'Produce the exhaustive glossary for this chunk as the JSON object described in the contract.',
  ].join('\n');

  return { system, user };
}

// ---------------------------------------------------------------------------
//  Defensive coercion of the model's untrusted JSON.
// ---------------------------------------------------------------------------

interface RawTerm {
  term: { en: string; zh: string };
  definition: { en: string; zh: string };
  kind: TermKind;
  dataTypeHint?: DataType;
  enumValuesHint?: string[];
  aliases?: string[];
  snippet: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function coerceTerms(payload: unknown): RawTerm[] {
  if (payload === null || typeof payload !== 'object') return [];
  const terms = (payload as { terms?: unknown }).terms;
  if (!Array.isArray(terms)) return [];

  const out: RawTerm[] = [];
  for (const t of terms) {
    if (t === null || typeof t === 'undefined' || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const term = (r.term ?? {}) as Record<string, unknown>;
    const def = (r.definition ?? {}) as Record<string, unknown>;
    const en = str(term.en);
    const zh = str(term.zh);
    if (!en || !zh) continue; // bilingual term is the contract — skip otherwise

    const kindRaw = str(r.kind);
    const kind = (TERM_KINDS.has(kindRaw) ? kindRaw : 'other') as TermKind;
    const dataTypeRaw = str(r.dataTypeHint);
    const dataTypeHint = DATA_TYPE_SET.has(dataTypeRaw) ? (dataTypeRaw as DataType) : undefined;
    const enumValuesHint = strList(r.enumValuesHint);
    const aliases = strList(r.aliases);

    const raw: RawTerm = {
      term: { en, zh },
      definition: { en: str(def.en), zh: str(def.zh) },
      kind,
      snippet: str(r.snippet),
    };
    if (dataTypeHint) raw.dataTypeHint = dataTypeHint;
    if (enumValuesHint.length > 0) raw.enumValuesHint = enumValuesHint;
    if (aliases.length > 0) raw.aliases = aliases;
    out.push(raw);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  runTerminology — chunked sweep, cross-chunk merge, id minting.
// ---------------------------------------------------------------------------

/** Run the terminology sweep over every parsed source and return the merged glossary. */
export async function runTerminology(ctx: StageContext): Promise<TerminologyExtraction> {
  const chunks = chunkSources(ctx.parsed, ctx.sources);
  ctx.log(`[hyper] terminology: sweeping ${chunks.length} chunk(s) across ${ctx.parsed.length} source(s)`);

  // ≤ MAX_CONCURRENT in flight: sliding window over Promise.all batches.
  const perChunk: { chunk: Chunk; terms: RawTerm[] }[] = [];
  for (let i = 0; i < chunks.length; i += MAX_CONCURRENT) {
    const window = chunks.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.all(
      window.map(async (chunk) => {
        const llm = ctx.agentLlm?.('terminology_extractor', { inputChars: chunk.text.length })
          ?? { model: ctx.model, provider: ctx.provider };
        const { system, user } = buildTerminologyPrompt(chunk);
        try {
          const raw = await executeLLMWithTracking({
            model: llm.model,
            provider: llm.provider as ExecuteLLMOptions['provider'],
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0.1,
            maxTokens: 16000,
            module: 'ontology_generator',
            actionName: 'ontology_terminology',
            userInfo: ctx.userInfo as ExecuteLLMOptions['userInfo'],
          });
          return { chunk, terms: coerceTerms(extractJson(raw)) };
        } catch (err) {
          ctx.log(`[hyper] terminology chunk of "${chunk.documentName}" failed: ${err instanceof Error ? err.message : String(err)}`);
          return { chunk, terms: [] };
        }
      }),
    );
    perChunk.push(...results);
  }

  // Merge across chunks by lowercase(term.en) + kind.
  const byKey = new Map<string, TermEntity>();
  for (const { chunk, terms } of perChunk) {
    for (const raw of terms) {
      const key = `${raw.term.en.toLowerCase()}::${raw.kind}`;
      const source: SourceRef | null = raw.snippet
        ? { documentId: chunk.documentId, documentName: chunk.documentName, snippet: raw.snippet }
        : null;

      const existing = byKey.get(key);
      if (!existing) {
        const entity: TermEntity = {
          id: makeId('term', raw.term.en, ctx.taken),
          term: raw.term,
          definition: raw.definition,
          kind: raw.kind,
          sources: source ? [source] : [],
        };
        if (raw.dataTypeHint) entity.dataTypeHint = raw.dataTypeHint;
        if (raw.enumValuesHint) entity.enumValuesHint = raw.enumValuesHint;
        if (raw.aliases) entity.aliases = raw.aliases;
        byKey.set(key, entity);
        continue;
      }

      // First non-empty definition wins; union aliases/enum hints/sources.
      if (!existing.definition.en && raw.definition.en) existing.definition.en = raw.definition.en;
      if (!existing.definition.zh && raw.definition.zh) existing.definition.zh = raw.definition.zh;
      if (!existing.dataTypeHint && raw.dataTypeHint) existing.dataTypeHint = raw.dataTypeHint;
      if (raw.enumValuesHint) {
        const union = [...(existing.enumValuesHint ?? [])];
        for (const v of raw.enumValuesHint) if (!union.includes(v)) union.push(v);
        existing.enumValuesHint = union;
      }
      if (raw.aliases) {
        const union = [...(existing.aliases ?? [])];
        for (const a of raw.aliases) if (!union.includes(a)) union.push(a);
        existing.aliases = union;
      }
      if (source && !existing.sources.some((s) => s.documentId === source.documentId && s.snippet === source.snippet)) {
        existing.sources.push(source);
      }
    }
  }

  const result: TerminologyExtraction = { terms: [...byKey.values()], stats: computeStats([...byKey.values()]) };
  ctx.log(`[hyper] terminology: ${result.terms.length} merged term(s) recognized`);
  return result;
}

function computeStats(terms: TermEntity[]): Record<string, number> {
  const stats: Record<string, number> = {
    terms: terms.length,
    matched: terms.filter((t) => Boolean(t.matchedId)).length,
  };
  for (const t of terms) {
    const key = `kind_${t.kind}`;
    stats[key] = (stats[key] ?? 0) + 1;
  }
  return stats;
}

// ---------------------------------------------------------------------------
//  renderTermSeed — the compact prompt seed appended to later extraction stages.
// ---------------------------------------------------------------------------

function termLine(t: TermEntity): string {
  const extras: string[] = [];
  if (t.dataTypeHint) extras.push(t.dataTypeHint);
  if (t.enumValuesHint && t.enumValuesHint.length > 0) extras.push(`enum: ${t.enumValuesHint.join('|')}`);
  const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
  const def = t.definition.en ? ` — ${t.definition.en}` : '';
  return `- [${t.kind}] ${t.term.en} / ${t.term.zh}${def}${suffix}`;
}

/** Render the glossary as a seed block (≤ ~6k chars; truncated with a count note). */
export function renderTermSeed(t: TerminologyExtraction): string {
  const header = [
    'DOCUMENT TERMINOLOGY (extracted, cited) — reconcile your extraction against EVERY term:',
    'a term must map to an output item (object/attribute/rule/action/event/process) or be',
    'consciously skipped as out of scope.',
  ].join('\n');

  const lines: string[] = [];
  let used = header.length;
  let rendered = 0;
  for (const term of t.terms) {
    const line = termLine(term);
    if (used + line.length + 1 > SEED_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
    rendered += 1;
  }
  const dropped = t.terms.length - rendered;
  if (dropped > 0) {
    lines.push(`… (+${dropped} more recognized terms — the FULL glossary applies; treat every recognized term as an expectation)`);
  }
  return [header, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
//  matchTerms — deterministic name/alias reconciliation against the ontology.
// ---------------------------------------------------------------------------

/** Lowercase + strip everything but latin alphanumerics and CJK, so naming
 *  conventions ("FulfillOrder" vs "Fulfill Order") compare equal. */
function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '');
}

/** Containment requires ≥ 3 chars on the shorter side (equals always counts) so
 *  tiny terms like "ID" cannot swallow-match half the ontology. */
function namesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length < b.length ? a : b;
  if (shorter.length < 3) return false;
  return a.includes(b) || b.includes(a);
}

interface Candidate {
  id: string;
  key: string;
}

function candidatesOf(o: Ontology): Candidate[] {
  const out: Candidate[] = [];
  for (const n of o.objects) {
    out.push({ id: n.id, key: norm(n.name) });
    for (const p of n.properties ?? []) out.push({ id: n.id, key: norm(p.name) });
  }
  for (const n of o.rules) out.push({ id: n.id, key: norm(n.title) });
  for (const n of o.actions) out.push({ id: n.id, key: norm(n.name) });
  for (const n of o.events) out.push({ id: n.id, key: norm(n.name) });
  for (const n of o.processes) out.push({ id: n.id, key: norm(n.name?.en ?? '') });
  return out.filter((c) => c.key.length > 0);
}

/**
 * Deterministically reconcile each term against the ontology: a term matches a
 * node when its normalized en-name or any alias equals / contains-or-is-
 * contained-by a node name (objects: name + attribute names; rules: title;
 * actions/events: name; processes: name.en). Sets `matchedId` to the FIRST
 * match. Returns a NEW TerminologyExtraction — the input is never mutated.
 */
export function matchTerms(t: TerminologyExtraction, o: Ontology): TerminologyExtraction {
  const candidates = candidatesOf(o);

  const terms: TermEntity[] = t.terms.map((term) => {
    const keys = [norm(term.term.en), ...(term.aliases ?? []).map(norm)].filter((k) => k.length > 0);
    let matchedId: string | undefined;
    outer: for (const key of keys) {
      for (const c of candidates) {
        if (namesMatch(key, c.key)) {
          matchedId = c.id;
          break outer;
        }
      }
    }
    const next: TermEntity = { ...term, sources: [...term.sources] };
    if (matchedId) next.matchedId = matchedId;
    else delete next.matchedId;
    return next;
  });

  return { terms, stats: computeStats(terms) };
}
