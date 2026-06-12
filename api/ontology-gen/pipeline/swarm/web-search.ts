// ============================================================================
//  DEEP-SWARM — web-search availability.
//
//  Live web search is delivered through OpenRouter's `web` plugin (see llm.ts),
//  so it needs an OpenRouter key and only works on the OpenRouter path (incl.
//  the `google` fallback). Any other provider degrades to parametric knowledge.
// ============================================================================

export function webSearchAvailable(provider: string): boolean {
  const p = (provider || 'openrouter').toLowerCase();
  const usesOpenRouter = p === 'openrouter' || p === 'google';
  return usesOpenRouter && Boolean((process.env.OPENROUTER_API_KEY || '').trim());
}
