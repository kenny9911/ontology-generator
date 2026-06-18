// =============================================================================
// Self-contained LLM client for the Ontology Generator.
//
// This is a vendored, trimmed replacement for the monorepo's central
// `api/ai.ts` dispatcher. It exposes exactly the surface the pipeline imports —
// `executeLLMWithTracking`, `callLLM`, and the types `ChatMessage`,
// `ExecuteLLMOptions`, `UserInfo`, `LLMProvider`.
//
// Differences from the monorepo original:
//   - API keys are read directly from environment variables (no Supabase
//     settings table).
//   - Token-usage logging goes to the local file logger (logger.ts) — the
//     monorepo logged to Supabase. Each call records task name + tokens + timing.
//
// Providers: `openrouter` (default) plus the OpenAI-compatible `openai`,
// `deepseek`, `qwen`, `moonshot`. Note: `google` has no dedicated branch and
// falls through to the OpenRouter path (so it needs OPENROUTER_API_KEY).
// =============================================================================

import { logLlm } from './logger.js';

export type LLMProvider =
  | 'openrouter'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'qwen'
  | 'moonshot';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

/** Caller identity — kept for signature compatibility; only used for logging. */
export interface UserInfo {
  userId: string;
  userName: string;
  userEmail: string;
}

// -----------------------------------------------------------------------------
// API key resolution (env-only).
// -----------------------------------------------------------------------------

const API_KEY_ENV_VARS: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'QWEN_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
};

function getApiKey(provider: string): string {
  const envVar = API_KEY_ENV_VARS[provider];
  const value = envVar ? process.env[envVar] : undefined;
  return value && value.trim() ? value : '';
}

function normalizeModelForProvider(provider: LLMProvider, model: string): string {
  const cleaned = (model || '').replace(/^openrouter\//, '').trim();
  if (!cleaned) return cleaned;
  if (provider === 'openrouter') return cleaned;
  // UI values often use OpenRouter-style prefixes like "google/gemini-...".
  // For direct-provider APIs keep only the actual model-name segment.
  if (cleaned.includes('/')) return cleaned.split('/').pop() || cleaned;
  return cleaned;
}

// -----------------------------------------------------------------------------
// Low-level chat-completion call.
// -----------------------------------------------------------------------------

export async function callLLM(options: {
  provider: LLMProvider;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  title?: string;
  /**
   * When true AND the call resolves to the OpenRouter path, enable live web
   * search via OpenRouter's `web` plugin. Ignored on direct-provider paths
   * (the caller degrades to parametric knowledge — see swarm/web-search.ts).
   */
  web?: boolean;
}): Promise<{
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}> {
  const { provider, model, messages, maxTokens = 500, temperature = 0.7, signal, title, web = false } = options;

  const effectiveProvider: LLMProvider = (provider || 'openrouter') as LLMProvider;
  const effectiveModel = normalizeModelForProvider(effectiveProvider, model);

  const emptyUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  // OpenAI-compatible endpoints (OpenAI / DeepSeek / Qwen / Moonshot).
  const callOpenAICompatible = async (url: string, apiKey: string) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: effectiveModel, messages, max_tokens: maxTokens, temperature }),
      signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error (${effectiveProvider}): ${response.status} ${errorText}`);
    }
    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || emptyUsage;
    return {
      content,
      usage: {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
      },
    };
  };

  // OpenRouter (also the fallback for unknown/`google` providers).
  const callOpenRouter = async (apiKey: string, modelOverride?: string, useWeb = false) => {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.SITE_URL || 'http://localhost:3598',
        'X-Title': title || 'Ontology Generator',
      },
      body: JSON.stringify({
        model: modelOverride ?? effectiveModel,
        messages,
        max_tokens: maxTokens,
        temperature,
        // OpenRouter web plugin: augments any model with live search results.
        ...(useWeb ? { plugins: [{ id: 'web' }] } : {}),
      }),
      signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error (openrouter): ${response.status} ${errorText}`);
    }
    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || emptyUsage;
    return {
      content,
      usage: {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
      },
    };
  };

  if (effectiveProvider === 'openrouter') {
    const apiKey = getApiKey('openrouter');
    if (!apiKey) throw new Error('OpenRouter API key not configured (set OPENROUTER_API_KEY)');
    return await callOpenRouter(apiKey, undefined, web);
  }

  if (effectiveProvider === 'openai') {
    const apiKey = getApiKey('openai');
    if (!apiKey) throw new Error('OpenAI API key not configured (set OPENAI_API_KEY)');
    return await callOpenAICompatible('https://api.openai.com/v1/chat/completions', apiKey);
  }

  if (effectiveProvider === 'deepseek') {
    const apiKey = getApiKey('deepseek');
    if (!apiKey) throw new Error('DeepSeek API key not configured (set DEEPSEEK_API_KEY)');
    const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
    return await callOpenAICompatible(`${base}/chat/completions`, apiKey);
  }

  if (effectiveProvider === 'qwen') {
    const apiKey = getApiKey('qwen');
    if (!apiKey) throw new Error('Qwen API key not configured (set QWEN_API_KEY)');
    const base = (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
    return await callOpenAICompatible(`${base}/chat/completions`, apiKey);
  }

  if (effectiveProvider === 'moonshot') {
    const apiKey = getApiKey('moonshot') || process.env.KIMI_API_KEY || '';
    if (!apiKey) throw new Error('Moonshot API key not configured (set MOONSHOT_API_KEY)');
    const base = (process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/$/, '');
    return await callOpenAICompatible(`${base}/chat/completions`, apiKey);
  }

  // Fallback (covers `google` and any unknown provider): route via OpenRouter.
  const fallbackKey = getApiKey('openrouter');
  if (!fallbackKey) throw new Error('OpenRouter API key not configured (set OPENROUTER_API_KEY)');
  return await callOpenRouter(fallbackKey, normalizeModelForProvider('openrouter', model), web);
}

// -----------------------------------------------------------------------------
// Tracked execution — same signature as the monorepo, tracking is a no-op here.
// -----------------------------------------------------------------------------

export interface ExecuteLLMOptions {
  provider?: LLMProvider;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  title?: string;
  module: string;
  actionName: string;
  userInfo?: UserInfo | null;
  promptPreview?: string;
  /** Enable live web search (OpenRouter web plugin) for this call. */
  web?: boolean;
}

/** Non-retryable failures: configuration problems a retry can never fix. */
function isConfigError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /api key|unauthorized|401|403|invalid model/i.test(msg);
}

export async function executeLLMWithTracking(options: ExecuteLLMOptions): Promise<string> {
  const { provider = 'openrouter', model, messages, maxTokens, temperature, signal, title, web } = options;
  const { actionName, module } = options;
  const started = Date.now();
  try {
    const result = await callLLM({ provider, model, messages, maxTokens, temperature, signal, title, web });
    logLlm({
      actionName, module, provider, model,
      promptTokens: result.usage.prompt_tokens,
      completionTokens: result.usage.completion_tokens,
      totalTokens: result.usage.total_tokens,
      durationMs: Date.now() - started,
      ok: true,
    });
    return result.content;
  } catch (err) {
    // ONE retry on transient transport/provider failures (streams 'terminated'
    // mid-flight, resets, 5xx). A lost extraction call silently empties a whole
    // pipeline stage, so a single retry is cheap insurance; config errors
    // (bad key/model) rethrow immediately.
    const errMsg = err instanceof Error ? err.message : String(err);
    if (isConfigError(err) || options.signal?.aborted) {
      logLlm({ actionName, module, provider, model, durationMs: Date.now() - started, ok: false, error: errMsg });
      throw err;
    }
    logLlm({ actionName, module, provider, model, durationMs: Date.now() - started, ok: false, error: errMsg, note: 'will retry' });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const retryStarted = Date.now();
    const result = await callLLM({ provider, model, messages, maxTokens, temperature, signal, title, web });
    logLlm({
      actionName, module, provider, model,
      promptTokens: result.usage.prompt_tokens,
      completionTokens: result.usage.completion_tokens,
      totalTokens: result.usage.total_tokens,
      durationMs: Date.now() - retryStarted,
      ok: true,
      note: 'retry',
    });
    return result.content;
  }
}
