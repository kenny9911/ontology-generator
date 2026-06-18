// ============================================================================
//  Tavily web-search client + API-key resolution.
//
//  Tavily (https://tavily.com) is a search API tuned for LLM grounding: it
//  returns dense, de-duplicated page content (not just links). We use it for the
//  opt-in "联网搜索 / web search" augmentation — gathering same-industry reference
//  material to supplement thin uploaded documents.
//
//  Key resolution mirrors the LLM-router precedence: env wins over the saved
//  global settings (the settings page stores `tavilyApiKey` in llm_settings).
//  Every call degrades gracefully — a missing key or any HTTP error yields [].
//
//  HARD RULES (NodeNext / strict TS): relative project imports carry `.js`.
// ============================================================================

import type { LlmSettings } from '../_shared/ontology-schema.js';

/** One Tavily search hit (narrowed from the untrusted API JSON). */
export interface TavilyResult {
  title: string;
  url: string;
  /** Tavily's distilled snippet for the page. */
  content: string;
  /** Full page text when `include_raw_content` was requested. */
  rawContent?: string;
  /** Relevance score in [0,1] when present. */
  score?: number;
}

/** Resolve the Tavily API key: env `TAVILY_API_KEY` wins, else saved settings. */
export function resolveTavilyKey(settings: LlmSettings | null): string {
  const env = (process.env.TAVILY_API_KEY || '').trim();
  if (env) return env;
  return (settings?.tavilyApiKey || '').trim();
}

/** True iff a Tavily key is configured (env or settings). */
export function tavilyAvailable(settings: LlmSettings | null): boolean {
  return resolveTavilyKey(settings).length > 0;
}

/**
 * Run ONE Tavily search. Returns [] on any failure (no key, network/HTTP error,
 * malformed body) so the caller never has to try/catch — web augmentation is a
 * best-effort supplement, never a hard dependency.
 */
export async function tavilySearch(
  apiKey: string,
  query: string,
  opts?: { maxResults?: number; includeRaw?: boolean; signal?: AbortSignal },
): Promise<TavilyResult[]> {
  if (!apiKey || !query.trim()) return [];
  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Bearer header (current API) + api_key in body (older API) for compat.
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: query.slice(0, 380), // Tavily caps query length
        search_depth: 'advanced', // denser, higher-quality page content
        max_results: opts?.maxResults ?? 5,
        include_raw_content: opts?.includeRaw ?? true,
        include_answer: false,
      }),
      signal: opts?.signal,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { results?: unknown };
    const arr = Array.isArray(data.results) ? data.results : [];
    const out: TavilyResult[] = [];
    for (const r of arr) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const url = typeof o.url === 'string' ? o.url : '';
      if (!url) continue;
      out.push({
        title: typeof o.title === 'string' ? o.title : url,
        url,
        content: typeof o.content === 'string' ? o.content : '',
        rawContent: typeof o.raw_content === 'string' ? o.raw_content : undefined,
        score: typeof o.score === 'number' ? o.score : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}
