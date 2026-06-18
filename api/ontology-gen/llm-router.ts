// ============================================================================
//  HYPER-AUTOMATION — smart per-agent LLM router (design §2.2).
//
//  Resolves which provider+model each agent in agents.ts runs on. Resolution
//  precedence, first hit wins:
//    1. env       ONTOLOGY_GEN_MODEL_<AGENT_ID uppercased>
//                 (+ optional ONTOLOGY_GEN_PROVIDER_<AGENT_ID>)
//    2. settings  LlmSettings.overrides[agentId] (the settings page)
//    3. router    purpose → strength tier (fast tier = FAST_SIBLING of the
//                 base model family; strong tier = the base model itself),
//                 with long-context and web-search routing signals
//    4. default   the run's base model/provider
//  settings.defaultModel/defaultProvider, when set, REPLACE the base before
//  the router runs. Settings persist via the universal stash-row pattern
//  (ref 'llm_settings:global') so they work on memory/file/Supabase alike.
//  This module never throws on unknown agent ids — they route as extraction.
// ============================================================================

import type {
  AgentModelAssignment,
  AgentPurpose,
  LlmSettings,
} from '../_shared/ontology-schema.js';
import type { OntologyStore } from './store.js';
import { AGENT_REGISTRY, getAgentDef, isKnownAgent } from './agents.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RouteOpts {
  settings?: LlmSettings | null;
  /** Run-level model (ctx.model). */
  baseModel?: string;
  baseProvider?: string;
  /** Routing signal: very long inputs (> 300k chars upgrade to long-context). */
  inputChars?: number;
  /** Routing signal: must stay on the OpenRouter path (the only web-plugin path). */
  needsWeb?: boolean;
}

export interface ResolvedLlm {
  provider: string;
  model: string;
  source: 'env' | 'settings' | 'router' | 'default';
  /** One human-readable sentence naming the deciding factor. */
  rationale: string;
}

/** The closure attached to StageContext as `ctx.agentLlm` (design §2.3). */
export type AgentLlmResolver = (
  agentId: string,
  opts?: { inputChars?: number; needsWeb?: boolean },
) => { provider: string; model: string };

// ---------------------------------------------------------------------------
// Base defaults (mirrors defaultModel()/defaultProvider() in index.ts)
// ---------------------------------------------------------------------------

function envDefaultModel(): string {
  return (
    process.env.ONTOLOGY_GEN_MODEL || process.env.LLM_MODEL || 'openrouter/google/gemini-2.5-pro'
  );
}

function envDefaultProvider(): string {
  return process.env.LLM_PROVIDER || 'openrouter';
}

// ---------------------------------------------------------------------------
// Family table — fast-tier siblings of common base-model families.
// Matched as substrings of the model id (any 'openrouter/' or vendor prefix
// stripped first). Values are OpenRouter-style 'vendor/model' ids; on a direct
// provider the vendor prefix is dropped when the sibling is used.
// ---------------------------------------------------------------------------

const FAST_SIBLINGS: ReadonlyArray<readonly [family: string, sibling: string]> = [
  ['gemini-2.5-pro', 'google/gemini-2.5-flash'],
  ['gemini-3-pro', 'google/gemini-3-flash'],
  ['gpt-5', 'openai/gpt-5-mini'],
  ['gpt-4.1', 'openai/gpt-4.1-mini'],
  ['claude-opus', 'anthropic/claude-sonnet-4.5'],
  ['claude-sonnet', 'anthropic/claude-haiku-4.5'],
  ['deepseek-r1', 'deepseek/deepseek-chat'],
  ['qwen3-max', 'qwen/qwen3-32b'],
];

const LONG_CONTEXT_THRESHOLD = 300_000;
const LONG_CONTEXT_MODEL = 'google/gemini-2.5-pro';

const FAST_PURPOSES: ReadonlySet<AgentPurpose> = new Set([
  'extraction',
  'enrichment',
  'classification',
]);

/** Strip any 'openrouter/' and vendor prefixes, keep the bare model name. */
function bareModel(model: string): string {
  const cleaned = (model || '').replace(/^openrouter\//, '').trim();
  const last = cleaned.includes('/') ? cleaned.split('/').pop() || cleaned : cleaned;
  return last.toLowerCase();
}

/** llm.ts routes 'google' through OpenRouter, so both count as the OR path. */
function isOpenRouterPath(provider: string): boolean {
  const p = (provider || 'openrouter').toLowerCase();
  return p === 'openrouter' || p === 'google';
}

interface SiblingHit {
  family: string;
  /** Sibling model id, vendor-prefix-stripped for direct providers. */
  model: string;
  /** Family matched but the sibling lives on another vendor than `provider`. */
  wrongVendor: boolean;
}

function findFastSibling(baseModel: string, provider: string): SiblingHit | null {
  const bare = bareModel(baseModel);
  for (const [family, sibling] of FAST_SIBLINGS) {
    if (!bare.includes(family)) continue;
    if (isOpenRouterPath(provider)) return { family, model: sibling, wrongVendor: false };
    const slash = sibling.indexOf('/');
    const vendor = sibling.slice(0, slash);
    if (vendor === (provider || '').toLowerCase()) {
      return { family, model: sibling.slice(slash + 1), wrongVendor: false };
    }
    return { family, model: sibling, wrongVendor: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function envKeyFor(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

function trimmed(v: string | undefined): string {
  return (v || '').trim();
}

export function resolveAgentLlm(agentId: string, opts: RouteOpts = {}): ResolvedLlm {
  const settings = opts.settings ?? null;

  // Effective base: settings-level defaults REPLACE the run base when set.
  const settingsModel = trimmed(settings?.defaultModel);
  const settingsProvider = trimmed(settings?.defaultProvider);
  const baseModel = settingsModel || trimmed(opts.baseModel) || envDefaultModel();
  const baseProvider = settingsProvider || trimmed(opts.baseProvider) || envDefaultProvider();

  // 1. env override — ONTOLOGY_GEN_MODEL_<AGENT_ID> wins over everything.
  const envKey = envKeyFor(agentId);
  const envModel = trimmed(process.env[`ONTOLOGY_GEN_MODEL_${envKey}`]);
  const envProvider = trimmed(process.env[`ONTOLOGY_GEN_PROVIDER_${envKey}`]);
  if (envModel) {
    return {
      provider: envProvider || baseProvider,
      model: envModel,
      source: 'env',
      rationale: `Environment variable ONTOLOGY_GEN_MODEL_${envKey} pins this agent's model${
        envProvider ? ` (provider from ONTOLOGY_GEN_PROVIDER_${envKey})` : ''
      }.`,
    };
  }

  // 2. settings override — the per-agent row on the settings page.
  const override = settings?.overrides?.[agentId];
  const ovModel = trimmed(override?.model);
  const ovProvider = trimmed(override?.provider);
  if (ovModel || ovProvider) {
    return {
      provider: ovProvider || baseProvider,
      model: ovModel || baseModel,
      source: 'settings',
      rationale: `Per-agent settings override assigns ${
        ovModel ? `model ${ovModel}` : 'no model (base model kept)'
      }${ovProvider ? ` on provider ${ovProvider}` : ' on the base provider'}.`,
    };
  }

  // 3. smart router — unless disabled in settings or via ONTOLOGY_GEN_ROUTER=0.
  const routerEnabled =
    settings?.routerEnabled !== false && process.env.ONTOLOGY_GEN_ROUTER !== '0';
  if (routerEnabled) {
    return route(agentId, baseModel, baseProvider, opts);
  }

  // 4. default — the (possibly settings-supplied) base, used directly.
  const fromSettings = Boolean(settingsModel || settingsProvider);
  return {
    provider: baseProvider,
    model: baseModel,
    source: fromSettings ? 'settings' : 'default',
    rationale: fromSettings
      ? `Router is off; the run-level default ${
          settingsModel ? `model ${baseModel}` : `provider ${baseProvider}`
        } from settings is used directly.`
      : 'Router is off and no override applies; the run base model and provider are used.',
  };
}

function route(
  agentId: string,
  baseModel: string,
  baseProvider: string,
  opts: RouteOpts,
): ResolvedLlm {
  const def = getAgentDef(agentId);
  const purpose: AgentPurpose = def?.purpose ?? 'extraction';
  const unknownNote = def ? '' : ` (unknown agent id '${agentId}' treated as extraction)`;

  // Web-search signal: pin the provider to the only web-plugin path.
  const needsWeb = opts.needsWeb === true;
  const provider = needsWeb ? 'openrouter' : baseProvider;
  const webNote = needsWeb ? '; provider pinned to openrouter for web search' : '';

  // Long-context signal beats tier choice.
  const inputChars = opts.inputChars ?? 0;
  if (inputChars > LONG_CONTEXT_THRESHOLD) {
    if (isOpenRouterPath(provider)) {
      const alreadyGemini = bareModel(baseModel).includes('gemini');
      const model = alreadyGemini ? baseModel : LONG_CONTEXT_MODEL;
      return {
        provider,
        model,
        source: 'router',
        rationale: `Router upgraded to long-context ${model} because the input (${inputChars} chars) exceeds ${LONG_CONTEXT_THRESHOLD}${webNote}${unknownNote}.`,
      };
    }
    return {
      provider,
      model: baseModel,
      source: 'router',
      rationale: `Router kept the base model on direct provider ${provider} despite a long input (${inputChars} chars; no long-context switch off the OpenRouter path)${webNote}${unknownNote}.`,
    };
  }

  // Tier choice from the agent's purpose.
  if (FAST_PURPOSES.has(purpose)) {
    const hit = findFastSibling(baseModel, provider);
    if (hit && !hit.wrongVendor) {
      return {
        provider,
        model: hit.model,
        source: 'router',
        rationale: `Router fast tier: '${purpose}' work runs on ${hit.model}, the fast sibling of the ${hit.family} base family${webNote}${unknownNote}.`,
      };
    }
    return {
      provider,
      model: baseModel,
      source: 'router',
      rationale: `Router fast tier: ${
        hit
          ? `the ${hit.family} fast sibling belongs to another provider than ${provider}`
          : `no fast sibling is known for base model ${baseModel}`
      }, so the base model is used${webNote}${unknownNote}.`,
    };
  }

  return {
    provider,
    model: baseModel,
    source: 'router',
    rationale: `Router strong tier: '${purpose}' work stays on the base model ${baseModel}${webNote}${unknownNote}.`,
  };
}

// ---------------------------------------------------------------------------
// Assignment table (the settings page payload)
// ---------------------------------------------------------------------------

export function listAssignments(
  settings: LlmSettings | null,
  baseModel?: string,
  baseProvider?: string,
): AgentModelAssignment[] {
  return AGENT_REGISTRY.map((agent) => {
    const r = resolveAgentLlm(agent.id, { settings, baseModel, baseProvider });
    return {
      agentId: agent.id,
      provider: r.provider,
      model: r.model,
      source: r.source,
      rationale: r.rationale,
    };
  });
}

// ---------------------------------------------------------------------------
// Persistence — universal stash-row pattern (works on memory/file/Supabase)
// ---------------------------------------------------------------------------

const LLM_SETTINGS_REF = 'llm_settings:global';
const LLM_SETTINGS_DOC_ID = 'llm_settings';

function cleanStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t || undefined;
}

/** Coerce arbitrary JSON into a well-formed LlmSettings (lossy, never throws). */
function sanitizeSettings(raw: unknown): LlmSettings {
  const r: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const overrides: LlmSettings['overrides'] = {};
  const rawOverrides = r.overrides;
  if (rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)) {
    for (const [agentId, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
      if (!isKnownAgent(agentId)) continue; // drop overrides for unknown agents
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const o = value as Record<string, unknown>;
      const model = cleanStr(o.model);
      const provider = cleanStr(o.provider);
      if (!model && !provider) continue; // nothing usable left
      const entry: { provider?: string; model?: string } = {};
      if (provider) entry.provider = provider;
      if (model) entry.model = model;
      overrides[agentId] = entry;
    }
  }

  const out: LlmSettings = { overrides };
  const defaultProvider = cleanStr(r.defaultProvider);
  if (defaultProvider) out.defaultProvider = defaultProvider;
  const defaultModel = cleanStr(r.defaultModel);
  if (defaultModel) out.defaultModel = defaultModel;
  if (typeof r.routerEnabled === 'boolean') out.routerEnabled = r.routerEnabled;
  const tavilyApiKey = cleanStr(r.tavilyApiKey);
  if (tavilyApiKey) out.tavilyApiKey = tavilyApiKey;
  const updatedAt = cleanStr(r.updatedAt);
  if (updatedAt) out.updatedAt = updatedAt;
  return out;
}

export async function loadLlmSettings(store: OntologyStore): Promise<LlmSettings | null> {
  try {
    const row = await store.getParsed(LLM_SETTINGS_REF);
    if (!row || !row.text) return null;
    const parsed: unknown = JSON.parse(row.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return sanitizeSettings(parsed);
  } catch {
    return null; // missing row / bad JSON / store hiccup all degrade to null
  }
}

export async function saveLlmSettings(store: OntologyStore, s: LlmSettings): Promise<LlmSettings> {
  const cleaned = sanitizeSettings(s);
  cleaned.updatedAt = new Date().toISOString();
  await store.putParsed({
    ref: LLM_SETTINGS_REF,
    documentId: LLM_SETTINGS_DOC_ID,
    text: JSON.stringify(cleaned),
  });
  return cleaned;
}

// ---------------------------------------------------------------------------
// Pipeline wiring helpers (design §2.3)
// ---------------------------------------------------------------------------

/** Build the per-request resolver closure attached to StageContext.agentLlm. */
export function makeAgentLlmResolver(
  settings: LlmSettings | null,
  baseModel: string,
  baseProvider: string,
): AgentLlmResolver {
  return (agentId, opts) => {
    const r = resolveAgentLlm(agentId, {
      settings,
      baseModel,
      baseProvider,
      inputChars: opts?.inputChars,
      needsWeb: opts?.needsWeb,
    });
    return { provider: r.provider, model: r.model };
  };
}

/** Call-site helper: per-agent LLM when the resolver is attached, else ctx's. */
export function ctxAgentLlm(
  ctx: { model: string; provider: string; agentLlm?: AgentLlmResolver },
  agentId: string,
  opts?: { inputChars?: number; needsWeb?: boolean },
): { provider: string; model: string } {
  return ctx.agentLlm?.(agentId, opts) ?? { provider: ctx.provider, model: ctx.model };
}
