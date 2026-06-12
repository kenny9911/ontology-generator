// ============================================================================
//  ONTOLOGY GENERATOR — SHARED PIPELINE CONTRACT (StageContext)
// ============================================================================
//
//  The single object threaded through every extraction stage. Stage functions
//  are PURE EXTRACT: they read what they need from this context (sources/parsed
//  text, prior-layer nodes for cross-refs, the model/provider to call, and a
//  `taken` id set for deterministic minting), perform one LLM call via
//  `executeLLMWithTracking`, parse the JSON, mint ids, set `sources[].snippet`
//  and a RAW confidence — and return only their layer. The ORCHESTRATOR applies
//  grounding, the confidence rubric, event-inverse derivation, and validation
//  AFTERWARDS. Stages must not mutate prior-layer arrays.
//
//  HARD RULES for THIS file (NodeNext / strict TS):
//  - Relative project imports carry a `.js` suffix. Schema types come from the
//    generated backend mirror at `api/_shared/ontology-schema.ts`.
//  - Types + one tiny pure prompt builder only. No runtime side effects.
// ============================================================================

import type {
  ActionType,
  DomainKey,
  EventType,
  ObjectType,
  ParsedSource,
  Process,
  Relationship,
  Rule,
  RuleGroup,
  SourceDocument,
  Stage,
} from '../../_shared/ontology-schema.js';

/**
 * The shared mutable context handed to each pure stage function. A stage reads
 * `sources`/`parsed` (the evidence) and the prior layers it cross-references
 * (e.g. rules reference `objects`), then returns ONLY the layer it produces;
 * the orchestrator merges the result back in before the next stage runs.
 */
export interface StageContext {
  /** The ontology being built. Stable slug id (`ontology:<slug>`). */
  ontologyId: string;
  /** One of the 10 target domains (+ generic). Never forks the prompt text. */
  domain: DomainKey;

  /** The documents/systems being extracted from (citation targets). */
  sources: SourceDocument[];
  /** Normalized plaintext + page map per source — the evidence the model sees. */
  parsed: ParsedSource[];
  /** Mutable set of ids minted so far; passed to `makeId` for determinism. */
  taken: Set<string>;

  /** Stage 1 output / prior layer for cross-refs. */
  objects: ObjectType[];
  /** Top-level edges between objects (co-discovered with objects). */
  relationships: Relationship[];
  /** Stage 2 output. */
  rules: Rule[];
  /** Post-grouping clusters of rules. */
  ruleGroups: RuleGroup[];
  /** Stage 3 output. */
  actions: ActionType[];
  /** Stage 4 output. */
  events: EventType[];
  /** Stage 5 output. */
  processes: Process[];

  /** Model id for the LLM call (default `process.env.LLM_MODEL`). */
  model: string;
  /** LLM provider (default `process.env.LLM_PROVIDER || 'openrouter'`). */
  provider: string;
  /** Caller identity for usage tracking, or null in unauthenticated dev. */
  userInfo: unknown | null;
  /** Appends a line to the run's live log panel. */
  log: (text: string) => void;

  /**
   * OPTIONAL pre-rendered domain-brief seed block (deep-swarm mode only). When
   * present, each extraction stage appends it to its system prompt to raise
   * RECALL against the SME swarm's expectations. Undefined on the fast path, so
   * the single-pass pipeline behaves byte-identically. Built by
   * `pipeline/swarm/business-understanding.ts#renderBriefSeed`.
   */
  briefSeed?: string;

  /** Per-agent LLM resolution (hyper-automation router; see api/ontology-gen/llm-router.ts).
   *  When absent, callers fall back to ctx.model/ctx.provider — behavior is then
   *  byte-identical to the pre-router pipeline. */
  agentLlm?: (agentId: string, opts?: { inputChars?: number; needsWeb?: boolean }) => { provider: string; model: string };
}

/**
 * Build the prompt pair for an OPTIONAL self-critique pass over a stage's
 * freshly-extracted items. The reviewer is asked to return, as JSON, a concrete
 * list of issues (ungrounded/hallucinated items, schema violations, dangling
 * cross-refs, duplicates, miscalibrated confidence) — it does NOT rewrite the
 * draft here; the orchestrator owns any correction. Kept minimal and pure.
 */
export function buildCritiquePrompt(
  stage: Stage,
  items: unknown,
): { system: string; user: string } {
  const system = [
    `You are a meticulous QA reviewer for the ONTOLOGY EXTRACTION stage "${stage}".`,
    'You receive the DRAFT items the extractor produced. Your job is to find concrete,',
    'specific problems — not to praise the draft. Apply this checklist:',
    '1. CITATIONS: each item needs >=1 source whose snippet is a verbatim quote; flag',
    '   paraphrased, missing, or fabricated quotes.',
    '2. SCHEMA: flag extra fields, missing required fields, and enum values outside the',
    '   controlled vocabulary.',
    '3. CROSS-REFS: flag any id that references a node which does not exist.',
    '4. HALLUCINATION: flag anything the evidence does not support.',
    '5. DUPLICATES: flag items with the same meaning that should be merged.',
    '6. CONFIDENCE: flag items whose confidence looks miscalibrated for their evidence.',
    '',
    'OUTPUT ONLY a single JSON object, no prose and no code fences, of the form:',
    '{ "issues": [ { "itemId": string | null, "kind": "citation" | "schema" |',
    '  "cross-ref" | "hallucination" | "duplicate" | "confidence", "detail": string } ],',
    '  "summary": string }',
    'Return { "issues": [], "summary": "no issues found" } if the draft is sound.',
  ].join('\n');

  const user = [
    `STAGE: ${stage}`,
    'DRAFT ITEMS TO REVIEW (JSON):',
    '"""',
    safeStringify(items),
    '"""',
    'List the concrete issues as the JSON object described above.',
  ].join('\n');

  return { system, user };
}

/** Defensive JSON stringify — never throws on circular/unserializable input. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
