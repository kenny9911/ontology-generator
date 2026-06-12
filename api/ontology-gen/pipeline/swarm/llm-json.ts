// ============================================================================
//  DEEP-SWARM — one LLM call that returns parsed JSON (or null), with defensive
//  fence-stripping. Every swarm agent funnels through here.
// ============================================================================

import { executeLLMWithTracking } from '../../llm.js';
import type { ChatMessage, ExecuteLLMOptions } from '../../llm.js';

/** Strip code fences and slice to the outermost JSON object/array, then parse. */
export function extractJson(raw: string): unknown | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const firstObj = text.indexOf('{');
  const lastObj = text.lastIndexOf('}');
  const firstArr = text.indexOf('[');
  const lastArr = text.lastIndexOf(']');

  let slice: string | null = null;
  const hasObj = firstObj !== -1 && lastObj > firstObj;
  const hasArr = firstArr !== -1 && lastArr > firstArr;
  if (hasObj && (!hasArr || firstObj <= firstArr)) slice = text.slice(firstObj, lastObj + 1);
  else if (hasArr) slice = text.slice(firstArr, lastArr + 1);
  if (slice === null) return null;

  try {
    return JSON.parse(slice) as unknown;
  } catch {
    return null;
  }
}

export interface SwarmCallOptions {
  system: string;
  user: string;
  model: string;
  provider: string;
  userInfo: unknown | null;
  actionName: string;
  maxTokens?: number;
  temperature?: number;
  /** Enable the OpenRouter web plugin for this call (SME swarm). */
  web?: boolean;
}

/** One tracked LLM round-trip for the given message list. */
async function callOnce(opts: SwarmCallOptions, messages: ChatMessage[], actionName: string): Promise<string> {
  return executeLLMWithTracking({
    model: opts.model,
    provider: opts.provider as ExecuteLLMOptions['provider'],
    messages,
    temperature: opts.temperature ?? 0.2,
    maxTokens: opts.maxTokens ?? 8000,
    module: 'ontology_generator',
    actionName,
    userInfo: opts.userInfo as ExecuteLLMOptions['userInfo'],
    web: opts.web,
  });
}

/**
 * Make one tracked LLM call and return parsed JSON, or null on any failure.
 * If the first reply is not parseable JSON, issue ONE corrective retry
 * (original exchange + the bad reply + a "JSON only" instruction) before
 * giving up and returning null.
 */
export async function callJson(opts: SwarmCallOptions): Promise<unknown | null> {
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];
  let raw: string;
  try {
    raw = await callOnce(opts, messages, opts.actionName);
  } catch {
    return null;
  }
  const parsed = extractJson(raw);
  if (parsed !== null && typeof parsed === 'object') return parsed;

  // Single corrective retry: replay the exchange and demand bare JSON.
  const retryMessages: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: raw },
    {
      role: 'user',
      content:
        'Your previous reply was not parseable as JSON. Output ONLY the JSON object now — no prose, no code fences.',
    },
  ];
  let retryRaw: string;
  try {
    retryRaw = await callOnce(opts, retryMessages, `${opts.actionName}_json_retry`);
  } catch {
    return null;
  }
  const retried = extractJson(retryRaw);
  return retried !== null && typeof retried === 'object' ? retried : null;
}
