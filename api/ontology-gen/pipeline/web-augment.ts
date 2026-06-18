// ============================================================================
//  WEB-SEARCH AUGMENTATION (opt-in, all modes) — "联网搜索".
//
//  When a run requests web search, this module gathers SAME-INDUSTRY reference
//  material to supplement thin uploaded documents, so extraction does not miss
//  entities/attributes that are standard in the domain but absent from the
//  user's files. It runs ONCE per run (cached on `metadata.webAugmentation`):
//
//    1. PLAN  — an LLM reads a corpus excerpt and names the industry + business
//               scenario, then proposes 1-3 focused search queries (in the
//               document language) tuned to surface dense, on-topic references.
//    2. SEARCH — each query goes to Tavily (advanced depth, raw content).
//    3. DISTILL — an LLM filters the results to the SAME industry/scenario and
//               compresses them into an information-dense supplement, dropping
//               anything off-topic (other industries, marketing, news, filler).
//
//  The rendered block (`renderWebAugment`) is injected into every stage's system
//  prompt; objects/properties introduced SOLELY from it are tagged
//  `provenance: 'web_search'` by the objects stage. Everything degrades to a
//  no-op (empty supplement) on any failure — web search is never a hard dep.
//
//  HARD RULES (NodeNext / strict TS): relative project imports carry `.js`; the
//  LLM call resolves its model via ctxAgentLlm('web_search_planner').
// ============================================================================

import type { LlmSettings, WebAugmentation } from '../../_shared/ontology-schema.js';
import { executeLLMWithTracking } from '../llm.js';
import type { ExecuteLLMOptions } from '../llm.js';
import { ctxAgentLlm } from '../llm-router.js';
import { resolveTavilyKey, tavilySearch } from '../tavily.js';
import type { TavilyResult } from '../tavily.js';
import type { StageContext } from './context.js';

const CORPUS_CAP = 12_000; // chars of corpus the planner reads
const RESULT_CONTENT_CAP = 1_400; // chars per result fed to the distiller
const SUPPLEMENT_CAP = 4_000; // chars of distilled supplement kept on metadata
const MAX_QUERIES = 3;
const MAX_RESULTS_PER_QUERY = 5;

interface PlanShape {
  industry: string;
  scenario: string;
  language: string;
  queries: string[];
}

/** Defensive JSON extraction: strip fences, slice first `{` .. last `}`. */
function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw) return {};
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return {};
  try {
    const parsed = JSON.parse(text.slice(first, last + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = str(x);
    if (s) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function corpusExcerpt(ctx: StageContext): string {
  const parts: string[] = [];
  let total = 0;
  for (const p of ctx.parsed) {
    const t = typeof p.text === 'string' ? p.text.trim() : '';
    if (!t) continue;
    parts.push(t);
    total += t.length;
    if (total >= CORPUS_CAP) break;
  }
  return parts.join('\n\n').slice(0, CORPUS_CAP);
}

async function callPlanner(
  ctx: StageContext,
  system: string,
  user: string,
  actionName: string,
  maxTokens: number,
): Promise<string> {
  const llm = ctxAgentLlm(ctx, 'web_search_planner');
  const opts: ExecuteLLMOptions = {
    model: llm.model,
    provider: llm.provider as ExecuteLLMOptions['provider'],
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    maxTokens,
    module: 'ontology_generator',
    actionName,
    userInfo: ctx.userInfo as ExecuteLLMOptions['userInfo'],
  };
  return executeLLMWithTracking(opts);
}

/** STEP 1 — identify industry/scenario and propose focused queries. */
async function plan(ctx: StageContext): Promise<PlanShape> {
  const system = [
    'You plan LIVE WEB SEARCHES that SUPPLEMENT a business document set used to build a data ontology.',
    'From the document excerpt, identify:',
    '- the INDUSTRY / domain, SPECIFIC (e.g. "third-party recruitment process outsourcing", not just "HR");',
    '- the BUSINESS SCENARIO — the core process the documents describe;',
    '- 1 to 3 focused SEARCH QUERIES that will surface DENSE, AUTHORITATIVE reference material about the',
    '  SAME industry and scenario: standard data models, entity/field checklists, canonical status lifecycles,',
    '  regulatory or structural references. Make each query specific enough that results stay ON-INDUSTRY.',
    '  Write the queries in the PRIMARY LANGUAGE of the documents.',
    'Return ONLY a JSON object: { "industry": string, "scenario": string, "language": string, "queries": string[] }.',
  ].join('\n');
  const user = `DOCUMENT EXCERPT:\n"""\n${corpusExcerpt(ctx)}\n"""\n\nReturn ONLY the JSON object.`;

  let raw = '';
  try {
    raw = await callPlanner(ctx, system, user, 'ontology_web_search_plan', 1200);
  } catch (err) {
    ctx.log(`[web-search] planning failed: ${String(err)}`);
    return { industry: '', scenario: '', language: '', queries: [] };
  }
  const o = parseJsonObject(raw);
  return {
    industry: str(o.industry),
    scenario: str(o.scenario),
    language: str(o.language),
    queries: strArray(o.queries, MAX_QUERIES),
  };
}

/** STEP 3 — filter results to the same industry and compress to a dense block. */
async function distill(
  ctx: StageContext,
  p: PlanShape,
  results: TavilyResult[],
): Promise<{ text: string; sources: { title: string; url: string }[] }> {
  const resultsBlock = results
    .map((r, i) => {
      const body = (r.content || r.rawContent || '').replace(/\s+/g, ' ').trim().slice(0, RESULT_CONTENT_CAP);
      return `[#${i + 1}] ${r.title}\nURL: ${r.url}\n${body}`;
    })
    .join('\n\n');

  const system = [
    'You DISTILL web-search results into a DENSE supplement for ontology extraction.',
    'The supplement is appended to the source documents to catch entities/attributes the documents omitted.',
    'RULES:',
    `- KEEP ONLY material about the SAME industry ("${p.industry}") and scenario ("${p.scenario}").`,
    '  DROP anything off-topic: other industries, vendor marketing, news, generic SEO filler.',
    '- Output a STRUCTURED, information-dense list (NO prose padding): the standard OBJECTS/ENTITIES, their typical',
    '  ATTRIBUTES/FIELDS (concrete field names), STATUS lifecycles (exact values), PARTIES/ROLES, and',
    '  REFERENCE/LOOKUP data that systems in this industry model.',
    `- Write in ${p.language || 'the document language'}.`,
    '- If NOTHING is genuinely on-topic, return an empty "text".',
    'Return ONLY JSON: { "text": string, "sources": [{ "title": string, "url": string }] }.',
    'List in "sources" ONLY the results you actually used.',
  ].join('\n');
  const user = `INDUSTRY: ${p.industry}\nSCENARIO: ${p.scenario}\n\nWEB RESULTS:\n"""\n${resultsBlock}\n"""\n\nReturn ONLY the JSON object.`;

  let raw = '';
  try {
    raw = await callPlanner(ctx, system, user, 'ontology_web_search_distill', 6000);
  } catch (err) {
    ctx.log(`[web-search] distillation failed: ${String(err)}`);
    return { text: '', sources: [] };
  }
  const o = parseJsonObject(raw);
  const text = str(o.text).slice(0, SUPPLEMENT_CAP);
  const sources: { title: string; url: string }[] = [];
  if (Array.isArray(o.sources)) {
    for (const s of o.sources) {
      if (!s || typeof s !== 'object') continue;
      const sr = s as Record<string, unknown>;
      const url = str(sr.url);
      if (!url) continue;
      sources.push({ title: str(sr.title) || url, url });
    }
  }
  // Fall back to the raw result urls if the distiller named none.
  if (sources.length === 0 && text) {
    for (const r of results.slice(0, 5)) sources.push({ title: r.title, url: r.url });
  }
  return { text, sources };
}

/**
 * Run the full plan → search → distill flow ONCE. Always returns a
 * WebAugmentation (possibly with empty `text`) so the caller can cache it on
 * metadata and never retry; an empty `text` renders to no prompt injection.
 * Assumes a Tavily key is configured (caller checks `tavilyAvailable`).
 */
export async function runWebAugment(ctx: StageContext, settings: LlmSettings | null): Promise<WebAugmentation> {
  const at = new Date().toISOString();
  const apiKey = resolveTavilyKey(settings);
  const empty: WebAugmentation = { industry: '', scenario: '', queries: [], text: '', sources: [], at };
  if (!apiKey) return empty;

  ctx.log('[web-search] planning industry/scenario queries');
  const p = await plan(ctx);
  if (p.queries.length === 0) {
    ctx.log('[web-search] no queries planned — skipping augmentation');
    return { ...empty, industry: p.industry, scenario: p.scenario };
  }
  ctx.log(`[web-search] industry="${p.industry}" · ${p.queries.length} queries`);

  const seen = new Set<string>();
  const results: TavilyResult[] = [];
  for (const q of p.queries) {
    const hits = await tavilySearch(apiKey, q, { maxResults: MAX_RESULTS_PER_QUERY, includeRaw: true });
    for (const h of hits) {
      if (seen.has(h.url)) continue;
      seen.add(h.url);
      results.push(h);
    }
  }
  ctx.log(`[web-search] ${results.length} unique results across ${p.queries.length} queries`);
  if (results.length === 0) return { ...empty, industry: p.industry, scenario: p.scenario, queries: p.queries };

  const { text, sources } = await distill(ctx, p, results);
  ctx.log(`[web-search] distilled supplement: ${text.length} chars, ${sources.length} sources`);
  return { industry: p.industry, scenario: p.scenario, queries: p.queries, text, sources, at };
}

/**
 * Render the cached augmentation as the prompt block appended to stage system
 * prompts. Returns undefined when there is no usable supplement (so stages
 * behave byte-identically to a no-web run).
 */
export function renderWebAugment(aug: WebAugmentation | undefined): string | undefined {
  if (!aug || !aug.text.trim()) return undefined;
  const sources = aug.sources.slice(0, 8).map((s) => `- ${s.title} (${s.url})`).join('\n');
  return [
    `WEB-SEARCH SUPPLEMENT — industry: ${aug.industry || 'n/a'}; scenario: ${aug.scenario || 'n/a'}`,
    'The block below is EXTERNAL reference material gathered via LIVE WEB SEARCH to supplement the uploaded',
    'documents. It is NOT from the uploaded documents — treat it as background knowledge about this',
    "industry's standard practice. Use it to RECALL entities/attributes the documents may have omitted.",
    'CRITICAL: anything you introduce SOLELY because of this block (absent from the uploaded documents)',
    'MUST be tagged provenance:"web_search". Never cite this block as a document source.',
    '"""',
    aug.text.trim(),
    '"""',
    sources ? `Sources:\n${sources}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
