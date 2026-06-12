# Hyper-Automation Design — Ontology Generation

This is the architecture document for the **hyper-automation** upgrade of the
ontology-generation pipeline. Goal: **100% coverage of the user's documents**,
fully automated — from terminology/data-type recognition and extraction,
through eval-agent verification that nothing was missed, to automatic workflow
(process) generation, multi-hop inference over the resulting graph, and a
per-agent LLM routing layer with a settings UI.

Companion docs:
- [HYPER_AUTOMATION_SPEC.md](HYPER_AUTOMATION_SPEC.md) — requirements & current-state review
- [INFERENCE_USE_CASES.md](INFERENCE_USE_CASES.md) — 30 multi-hop query use cases
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — implementation notes & test results
- [../ONTOLOGY_GENERATION.md](../ONTOLOGY_GENERATION.md) — the classic 5-stage pipeline deep-dive

---

## 0. Design tenets (inherited, non-negotiable)

1. **Two build worlds.** `src/` imports `@/`-style with no extension; `api/`
   imports relative with a mandatory `.js` suffix (NodeNext).
2. **The schema is a hand-maintained mirror.** Every type added below lands in
   BOTH `src/ontology/schema/types.ts` AND `api/_shared/ontology-schema.ts`,
   structurally identical. Schema files stay dependency leaves: pure types +
   literal consts only.
3. **Stages are pure-extract; the orchestrator owns determinism.** All new LLM
   work follows the same split: LLM calls live in dedicated modules; grounding,
   confidence, merging, validation stay deterministic.
4. **One sub-step per request.** Every long pipeline is client-paced through a
   cursor stash so each backend call stays under the 60 s serverless cap.
5. **Graceful degradation.** No new code path may produce an unhandled 500.
   LLM/JSON failures degrade to logged notes and empty artifacts.
6. **Receipts everywhere.** New nodes still carry `sources`, `confidence`,
   `reviewState`; the eval layer's whole purpose is to enforce the receipts
   account for the entire document.

---

## 1. The hyper pipeline (mode `'hyper'`)

A third extraction mode alongside `fast` and `swarm`. It is a superset of the
swarm machine and reuses its modules verbatim wherever possible
(`runBusinessUnderstanding`, `runBaReview`, `computeCoverage`, `deepenStage`,
`runLinkSynthesis`, `runQuestions`), adding four new capabilities:

1. **Terminology & data-type recognition** (new, runs first) — a glossary
   sweep that recognizes every business term, entity, attribute, enum set,
   data type, abbreviation, role, system and document kind, with citations.
   Its rendered seed is appended to every later extraction prompt.
2. **Document-coverage eval agent** (new) — sentence-level verification that
   every meaningful sentence of every source document is represented in the
   ontology. Deterministic citation-overlap pre-pass + LLM judging of the
   remainder. Produces `DocumentCoverageEval`.
3. **Remediation** (new) — converts uncovered/partial sentences into targeted
   `CoverageGap`s and re-extracts ONLY those through the proven
   `deepenStage` merge-preserve path. Runs after each eval; no-ops at 100%.
4. **Final eval gate** — a last coverage pass that records `meetsTarget`
   against `ONTOLOGY_GEN_COVERAGE_TARGET` (default `1.0` of coverable
   sentences).

### 1.1 Phase machine

New file `api/ontology-gen/pipeline/hyper/orchestrator.ts`, modeled directly
on `pipeline/swarm/orchestrator.ts` (`advanceSwarm`):

```
HYPER_PHASE_ORDER = [
  'terminology',            //  1  Terminology & data-type scan
  'business_understanding', //  2  SME swarm (reused)
  'iteration_1',            //  3-7 extract objects→rules→actions→events→processes
                            //  8  BA review (reused)
  'coverage_eval_1',        //  9  Document-coverage eval, pass 1
  'remediation_1',          // 10  Remediate structure (objects+rules)
                            // 11  Remediate behavior (actions+events+processes)
  'iteration_2',            // 12-15 deepen objects/rules/actions/events (reused)
                            // 16  link synthesis (reused)
                            // 17  deepen processes (reused)
                            // 18  BA re-review + use-case coverage (reused)
  'coverage_eval_2',        // 19  Document-coverage eval, pass 2
  'remediation_2',          // 20  Remediate all remaining gaps (capped)
  'final_eval',             // 21  Document-coverage eval, final pass → meetsTarget
  'follow_up',              // 22  Follow-up questions (reused, gap-enriched)
]
```

22 fixed sub-steps (`HYPER_STEP_COUNT`). `advanceHyper(input: AdvanceInput):
Promise<AdvanceResult>` mirrors `advanceSwarm` exactly (same input/result
shapes, widened with the new artifacts below). Remediation steps are
**no-ops** when the latest eval already `meetsTarget` or has no findings for
their layers — the fixed-array cursor model is preserved while behaving like a
loop-until-covered. Step failures are caught and logged, never thrown
(identical to swarm).

Extraction sub-steps seed prompts with `renderBriefSeed(brief) + "\n\n" +
renderTermSeed(terminology)` via `ctx.briefSeed`.

### 1.2 New module: terminology

`api/ontology-gen/pipeline/hyper/terminology.ts`

```ts
export async function runTerminology(ctx: StageContext): Promise<TerminologyExtraction>;
export function renderTermSeed(t: TerminologyExtraction): string; // prompt seed block
export function matchTerms(t: TerminologyExtraction, o: Ontology): TerminologyExtraction; // sets matchedId (deterministic name/alias match)
```

- Chunks each `ParsedSource` (~24 000 chars, 500-char overlap); one LLM call
  per chunk, max 3 concurrent (`Promise.all` over a window).
- Merges by `lowercase(term.en) + kind`, unioning aliases/sources, keeping
  max confidence-equivalent (first definition wins, longer definition wins on
  tie).
- Every term carries verbatim-snippet `sources` (the orchestrator does NOT
  ground these — terms are metadata, not layer nodes — but snippets must be
  verbatim per prompt contract).
- `dataTypeHint` recognizes the closed `DataType` vocabulary, with explicit
  prompt guidance for money/date/datetime/duration/id/code/enum recognition.
- Agent id: `terminology_extractor`.

### 1.3 New module: sentence substrate

`api/ontology-gen/pipeline/hyper/sentences.ts`

```ts
export interface NumberedSentence {
  idx: number;          // GLOBAL 1-based, continuous across all sources
  documentId: string;
  documentName: string;
  text: string;
  charStart: number;    // offset into that document's normalized text
  charEnd: number;
}
export function numberSentences(parsed: ParsedSource[], sources: SourceDocument[]): NumberedSentence[];
export function batchSentences(s: NumberedSentence[], maxPerBatch?: number): NumberedSentence[][]; // default 80
```

Splitting mirrors the rules stage: sentence-final punctuation incl. CJK
(`。！？；`), hard line breaks; offsets are computed against the parsed text so
the eval pre-pass can do span-overlap against grounded citations.
(Deliberate, documented duplication of the private helper in
`stages/rules.ts` — that file is not refactored to keep blast radius zero.)

### 1.4 New module: document-coverage eval agent

`api/ontology-gen/pipeline/hyper/doc-coverage.ts`

```ts
export interface CoverageEvalInput {
  ctx: StageContext;
  ontology: Ontology;   // current assembled state (buildAndCarry output)
  pass: number;         // 1 | 2 | 3(final)
  target?: number;      // default env ONTOLOGY_GEN_COVERAGE_TARGET ?? 1.0
}
export async function runDocumentCoverageEval(input: CoverageEvalInput): Promise<DocumentCoverageEval>;
```

Three-tier verdict assignment, cheapest first:

1. **Deterministic citation overlap (no LLM).** Build per-document interval
   lists from every node's grounded `SourceRef` (`charStart`/`charEnd` when
   present, else normalized-substring match of `snippet`). A sentence whose
   span overlaps any citation is `covered` with `coveredBy` = those node ids.
   This typically resolves the majority of sentences for free.
2. **Deterministic boilerplate filter.** Sentences with < 3 word tokens, pure
   headings/numbering, or pure punctuation → `uncoverable`.
3. **LLM judging of the remainder.** Batches of ≤ 80 sentences, ≤ 3 concurrent
   calls, temp 0, maxTokens 8000. The system prompt carries a compact
   **ontology digest** (every node: id, kind, name(s); objects also attribute
   names; rules also title; capped fields). Verdicts come back as strict JSON:
   `{ verdicts: [{ idx, status, coveredBy?, expectedKinds?, missing? }] }`,
   parsed via `extractJson`. Unparseable/missing verdicts default to
   `uncovered` (fail-closed: a judging failure can only INCREASE reported
   gaps, never hide one).

Output retains only `partial`/`uncovered` entries in `findings` (envelope
stays light); counts cover all four statuses.
`coverageRatio = covered / max(1, total - uncoverable)`.
Agent id: `coverage_evaluator`.

### 1.5 New module: remediation

`api/ontology-gen/pipeline/hyper/remediate.ts`

```ts
export function findingsToGaps(findings: SentenceCoverage[], layer: EntityKind, round: number): CoverageGap[];
export async function runRemediation(
  ctx: StageContext,
  brief: BusinessBrief | undefined,
  evalReport: DocumentCoverageEval | undefined,
  stages: Stage[],
  round: number,
): Promise<number>; // nodes added
```

- Returns 0 immediately (logged) when there is no eval report, it already
  `meetsTarget`, there is no brief, or no findings map to the given stages.
- A finding maps to a stage when its `expectedKinds` includes the stage's
  `EntityKind` (uncovered findings with NO expectedKinds map to `objects` and
  `rules` — the safest recall default).
- Gap description embeds the **verbatim uncovered sentence**:
  `Source sentence ${idx} is not represented: "${text}" — missing: ${missing}`.
  Severity: `uncovered` → `block`, `partial` → `warn`.
- Caps at 40 gaps per stage per round (logs the number dropped).
- Delegates to `deepenStage(ctx, stage, brief, gaps)` — the existing
  snapshot → seeded re-extract → merge-preserve-by-id path — so remediated
  nodes get grounding, confidence, and validation exactly like every other
  node, and no prior work is ever lost.

### 1.6 Schema additions (BOTH mirrors, §10c/§10d)

```ts
// --- run surface -----------------------------------------------------------
// OntologyRun.mode      → 'fast' | 'swarm' | 'hyper'
// OntologyRun.currentPhase → RunPhase | null
// SwarmPhaseProgress.phase → RunPhase
export const HYPER_PHASE_ORDER = [
  'terminology', 'business_understanding', 'iteration_1', 'coverage_eval_1',
  'remediation_1', 'iteration_2', 'coverage_eval_2', 'remediation_2',
  'final_eval', 'follow_up',
] as const;
export type HyperPhase = (typeof HYPER_PHASE_ORDER)[number];
export type RunPhase = SwarmPhase | HyperPhase;

// --- terminology -----------------------------------------------------------
export type TermKind =
  | 'entity' | 'attribute' | 'metric' | 'role' | 'status' | 'document'
  | 'system' | 'abbreviation' | 'event' | 'process' | 'other';
export interface TermEntity {
  id: string;                 // 'term:<slug>' via makeId kind 'term'
  term: Bilingual;
  definition: Bilingual;
  kind: TermKind;
  dataTypeHint?: DataType;
  enumValuesHint?: string[];
  aliases?: string[];
  sources: SourceRef[];
  matchedId?: string;         // ontology node that realized this term
}
export interface TerminologyExtraction {
  terms: TermEntity[];
  stats?: Record<string, number>;
}

// --- document coverage eval --------------------------------------------------
export type SentenceCoverageStatus = 'covered' | 'partial' | 'uncovered' | 'uncoverable';
export interface SentenceCoverage {
  idx: number;
  documentId: string;
  text: string;
  status: SentenceCoverageStatus;
  coveredBy?: string[];
  expectedKinds?: EntityKind[];
  missing?: string;
}
export interface DocumentCoverageEval {
  pass: number;
  totalSentences: number;
  covered: number;
  partial: number;
  uncovered: number;
  uncoverable: number;
  coverageRatio: number;       // covered / max(1, total - uncoverable)
  target: number;
  meetsTarget: boolean;
  findings: SentenceCoverage[]; // ONLY partial|uncovered retained
  evaluatedAt: string;          // ISO-8601
}

// --- LLM agent registry / settings (frontend-visible) -----------------------
export const AGENT_PURPOSES = [
  'extraction', 'enrichment', 'review', 'reasoning', 'synthesis',
  'inference', 'classification',
] as const;
export type AgentPurpose = (typeof AGENT_PURPOSES)[number];
export interface AgentDef {
  id: string;
  label: Bilingual;
  description?: Bilingual;
  purpose: AgentPurpose;
  group: 'fast' | 'swarm' | 'hyper' | 'inference' | 'shared';
}
export interface AgentModelAssignment {
  agentId: string;
  provider: string;
  model: string;
  source: 'env' | 'settings' | 'router' | 'default';
  rationale?: string;
}
export interface LlmSettings {
  overrides: Record<string, { provider?: string; model?: string }>;
  defaultProvider?: string;
  defaultModel?: string;
  routerEnabled?: boolean;     // default true
  updatedAt?: string;
}

// --- inference ---------------------------------------------------------------
export interface Triple {
  s: string;                   // subject node id
  p: string;                   // predicate
  o: string;                   // object node id, or literal when literal=true
  literal?: boolean;
}
export interface InferenceHop {
  step: number;
  triples: Triple[];
  inference: string;           // conclusion drawn at this hop
}
export interface InferenceResult {
  question: string;
  answer: Bilingual;
  hops: InferenceHop[];
  pathNodeIds: string[];
  tripleCount: number;
  usedTripleCount: number;
  iterations: number;
  durationMs?: number;
}
```

`OntologyMetadata` additions:

```ts
terminology?: TerminologyExtraction;
documentCoverage?: DocumentCoverageEval;            // latest pass
documentCoverageHistory?: DocumentCoverageEval[];   // earlier passes, findings trimmed to []
hyper?: { passes: number; coverageTarget: number; remediationRounds: number; web: boolean };
```

`PREFIXES` in `api/_shared/ids.ts` gains `term: 'term:'` (and ONLY that —
ids.ts is also a leaf shared by both worlds; mirror if a frontend copy exists).

### 1.7 Handler surface (index.ts)

| action | method | behavior |
|---|---|---|
| `run.hyper.start` | POST | identical to `run.swarm.start` but `run.mode='hyper'`, `run.phases = seedHyperPhases()` |
| `run.hyper.step` | POST | identical to `run.swarm.step` but drives `advanceHyper`; same `swarm_state:<runId>` cursor stash, same title-upgrade-on-completion |
| `llm.agents` | GET (add to `READ_ACTIONS`) | `{ ok, agents: AgentDef[], assignments: AgentModelAssignment[], settings: LlmSettings }` |
| `llm.settings` | POST | body `LlmSettings` (validated, unknown agent ids dropped) → persisted; responds with saved settings + recomputed assignments |
| `infer` | POST | body `{ ontologyId?, version?, ontology?, question, maxHops?, maxIterations? }` → `{ ok, result: InferenceResult }` |

All five follow the envelope/`HttpError` conventions. `run.swarm.step`'s
existing stash helpers (`swarmStateRef`, save/load) are reused unchanged for
hyper runs (the cursor is mode-agnostic, keyed by runId).

---

## 2. LLM routing layer

### 2.1 Agent registry — `api/ontology-gen/agents.ts`

A literal-const registry of every LLM-calling agent in the system:

| id | purpose | group |
|---|---|---|
| `objects_extractor` | extraction | fast |
| `rules_extractor` | extraction | fast |
| `actions_extractor` | extraction | fast |
| `events_enricher` | enrichment | fast |
| `processes_extractor` | extraction | fast |
| `stage_critic` | review | fast |
| `title_generator` | classification | shared |
| `sme_swarm` | reasoning | swarm |
| `ba_reviewer` | review | swarm |
| `link_synthesizer` | synthesis | swarm |
| `question_generator` | synthesis | swarm |
| `terminology_extractor` | extraction | hyper |
| `coverage_evaluator` | review | hyper |
| `inference_agent` | inference | inference |

(Deepen/remediation reuse the five stage extractors, so they route through
those agent ids automatically.)

```ts
export const AGENT_REGISTRY: AgentDef[];
export function getAgentDef(id: string): AgentDef | undefined;
```

### 2.2 Smart router — `api/ontology-gen/llm-router.ts`

```ts
export interface RouteOpts {
  settings?: LlmSettings | null;
  baseModel?: string;      // run-level model (ctx.model)
  baseProvider?: string;
  inputChars?: number;     // routing signal: very long inputs
  needsWeb?: boolean;      // routing signal: must stay on the OpenRouter path
}
export interface ResolvedLlm {
  provider: string; model: string;
  source: 'env' | 'settings' | 'router' | 'default';
  rationale: string;
}
export function resolveAgentLlm(agentId: string, opts?: RouteOpts): ResolvedLlm;
export function listAssignments(settings: LlmSettings | null, baseModel?: string, baseProvider?: string): AgentModelAssignment[];
export async function loadLlmSettings(store: OntologyStore): Promise<LlmSettings | null>;
export async function saveLlmSettings(store: OntologyStore, s: LlmSettings): Promise<LlmSettings>;
export function ctxAgentLlm(
  ctx: { model: string; provider: string; agentLlm?: AgentLlmResolver },
  agentId: string,
  opts?: { inputChars?: number; needsWeb?: boolean },
): { provider: string; model: string };
```

**Resolution precedence** (first hit wins):

1. **env** — `ONTOLOGY_GEN_MODEL_<AGENT_ID uppercased>` (e.g.
   `ONTOLOGY_GEN_MODEL_RULES_EXTRACTOR=openai/gpt-5`). Optional matching
   `ONTOLOGY_GEN_PROVIDER_<AGENT_ID>`.
2. **settings** — `settings.overrides[agentId]` (the settings page).
3. **router** — when `settings.routerEnabled !== false`: map the agent's
   `purpose` to a **strength tier** and derive the model from the run's base
   model via a family table:
   - `extraction`/`enrichment`/`classification` → **fast tier** —
     `FAST_SIBLING[baseFamily]` (e.g. `gemini-2.5-pro → gemini-2.5-flash`,
     `gpt-5 → gpt-5-mini`, `claude-*-opus → claude-*-sonnet`); falls back to
     the base model when no sibling is known.
   - `review`/`reasoning`/`synthesis`/`inference` → **strong tier** — the base
     model itself.
   - `inputChars > 300_000` → force a long-context family (prefer the gemini
     sibling when on the OpenRouter path), rationale notes the upgrade.
   - `needsWeb` → pin provider to `openrouter` (the only web-plugin path).
4. **default** — base model/provider (`ONTOLOGY_GEN_MODEL || LLM_MODEL ||
   'openrouter/google/gemini-2.5-pro'`, `LLM_PROVIDER || 'openrouter'`).

Settings persist via the universal stash-row pattern:
`store.putParsed({ ref: 'llm_settings:global', documentId: 'llm_settings', text: JSON.stringify(settings) })` —
works identically on memory/file/Supabase, no migration.

### 2.3 Pipeline wiring

`StageContext` gains one optional field (backward compatible — absent ⇒
behavior is byte-identical to today):

```ts
/** Per-agent LLM resolution (hyper-automation router). When absent, callers
 *  fall back to ctx.model/ctx.provider via ctxAgentLlm(). */
agentLlm?: (agentId: string, opts?: { inputChars?: number; needsWeb?: boolean })
  => { provider: string; model: string };
```

`contextFromOntology` (and the run-start seeding paths) load settings once per
request and attach a resolver closure. Every `executeLLMWithTracking` call
site switches from `model: ctx.model, provider: ctx.provider` to:

```ts
const llm = ctxAgentLlm(ctx, 'objects_extractor', { inputChars: text.length });
// ... model: llm.model, provider: llm.provider as LLMProvider
```

Call sites to sweep: the five stage files, `orchestrator.ts` (critique →
`stage_critic`), `index.ts` (title upgrade → `title_generator`), every swarm
module, every hyper module, the inference engine.

---

## 3. Inference engine

### 3.1 Triples — `api/ontology-gen/inference/triples.ts` (pure, deterministic)

```ts
export function ontologyToTriples(o: Ontology): Triple[];
export function tripleLabelMap(o: Ontology): Record<string, string>; // id → display label
export function tripleStats(triples: Triple[]): Record<string, number>;
```

Projection rules (predicates are a closed, documented vocabulary):

| source | triples |
|---|---|
| every node | `(id, 'kind', <entityKind>, literal)`, `(id, 'label', name, literal)` |
| ObjectType attribute | `(obj, 'has_attribute', obj.attrName?)` → modeled as `(obj.id, 'has_attribute', '<obj.id>.<attr.name>')` + `('<obj.id>.<attr.name>', 'has_type', dataType, literal)` + fk/reference: `('<obj.id>.<attr.name>', 'references', refObjectTypeId)` |
| Relationship | `(sourceObjectTypeId, rel.name, targetObjectTypeId)` + `(rel.id, 'cardinality', c, literal)` |
| Rule | `(rule.id, 'applies_to', objId)` per id; `(rule.id, 'severity'\|'rule_kind', v, literal)`; `(rule.id, 'triggered_by', eventId)` when present |
| ActionType | `(action.id, 'consumes', objId)` per object input; `(action.id, 'produces', objId)` per object output; `(action.id, 'guarded_by', ruleId)`; `(action.id, 'emits', eventId)`; `(action.id, 'triggered_by', eventId)`; `(action.id, 'performed_by', actorRole, literal)`; `(action.id, 'calls', actionId)` per step call |
| EventType | `(event.id, 'produced_by', actionId)`, `(event.id, 'consumed_by', actionId)` |
| Process | `(proc.id, 'has_step', actionTypeId)` per step; `(fromActionId, 'precedes', toActionId)` per process edge; `(proc.id, 'triggered_by', eventTypeId)` per event trigger; `(proc.id, 'involves', objId)` |

### 3.2 Engine — `api/ontology-gen/inference/engine.ts`

```ts
export interface InferenceInput {
  ontology: Ontology;
  question: string;
  model: string; provider: string;
  userInfo: UserInfo | null;
  log?: (s: string) => void;
  maxIterations?: number;   // default 4 (LLM calls ≤ 1 + maxIterations)
  maxHops?: number;         // default 6
}
export async function runInference(input: InferenceInput): Promise<InferenceResult>;
```

Agent loop (the engine owns the graph; the LLM owns the reasoning):

1. Build triples + adjacency index + label map.
2. **Seed call** — the LLM receives the question + a compact node index
   (id/kind/label, capped at 400 nodes) and returns seed node ids (JSON).
3. **Expansion loop** (≤ `maxIterations`): the engine deterministically
   gathers all triples adjacent to the frontier (deduped vs already-sent,
   capped ~150/iteration); the LLM receives question + hop notes so far + the
   new triples and returns
   `{ action: 'expand'|'answer', hop?: { tripleIdxs: number[], inference: string },
     expandToIds?: string[], answer?: { en, zh }, pathNodeIds?: string[] }`.
4. On `answer` (or iteration exhaustion → best-effort answer call) the engine
   assembles `InferenceResult`; hops are the accumulated per-iteration
   `{ triples, inference }` records. Malformed JSON at any step degrades to
   one retry then a graceful "no answer derivable" result — never a throw.

The 30 use cases live in [INFERENCE_USE_CASES.md](INFERENCE_USE_CASES.md) and
machine-readable `fixtures/inference-use-cases.json`
(`{ id, domain, fixture, question: Bilingual, minHops: 3, hopPath: string[],
expectedAnswerNotes }`), 3 per golden-fixture domain × 10 domains, each
requiring ≥ 3 hops; the hop paths reference REAL node ids from
`fixtures/ontology-golden/*.json` so tests can verify them deterministically.

---

## 4. Prompt doctrine (every prompt, every step)

All prompts (rewritten in `prompts.ts`, the swarm modules, and authored fresh
in the hyper modules) follow one doctrine:

1. **JSON contracts are frozen.** Every OUTPUT CONTRACT field name stays
   byte-identical — the stage parsers/coercers depend on them. A rewrite
   changes instructions, never the contract.
2. **Recall-first sweep discipline.** Each extractor is instructed to sweep
   the document section by section, enumerate candidates BEFORE filtering,
   and run an explicit completeness pass ("re-scan each section; if a section
   contributed nothing, justify it to yourself silently").
3. **Negative-space checks.** Each prompt lists what is COMMONLY MISSED for
   its layer (e.g. objects: lookup/reference data, parties, documents-as-
   entities, line items; rules: thresholds buried in prose, temporal/SLA
   constraints, authorization matrices; actions: implicit human steps;
   datatypes: money+currency, durations, enum sets spelled out in prose).
4. **Terminology alignment.** When a term/brief seed block is present, the
   model must reconcile against it: every seeded expectation either maps to
   an output item or is consciously skipped.
5. **Citation discipline unchanged.** Verbatim snippets, honest confidence,
   closed vocabularies, mandatory bilingual output.
6. **Counting self-check.** The SELF_CHECK block gains a count step: "state
   (silently) how many sections the document has and how many items each
   section yielded; any section with zero items needs a reason."

---

## 5. Frontend

### 5.1 LLM settings page — `src/ontology-generator/LLMSettingsScreen.tsx`

- New `StepId` `'settings'`, reachable ALWAYS (gear button in `TopBar`
  dispatches `ontogen:goto`/direct `setStep`; NOT part of `stepOrderFor`'s
  wizard stepper).
- Renders the agent table from `GET llm.agents`: group → agent label,
  purpose chip, resolved provider+model, source badge (env/settings/router/
  default) with rationale tooltip; per-agent model+provider override inputs;
  global default model/provider; router on/off toggle. Save → `POST
  llm.settings`, re-renders recomputed assignments.
- Works in demo mode too (the action requires no LLM key).

### 5.2 Hyper mode UX

- `InputScreen`: third mode card (`modeHyper`/`modeHyperHint` i18n keys);
  `extractMode === 'hyper'` calls `ctrl.startHyper({ files | sample })`.
- `useOntologyRun`: `mode` union gains `'hyper'`; `startHyper` mirrors
  `startSwarm` (hits `run.hyper.start`); `step()` routes to `run.hyper.step`
  when `mode === 'hyper'`; auto-save-on-completion identical to swarm. A
  loaded ontology whose metadata carries `documentCoverage` or
  `metadata.hyper` reopens in hyper mode.
- `SwarmDiscover` is reused as-is (it renders `run.phases` generically; the
  backend supplies hyper phase labels). `DiscoverScreen` routes to it for
  `mode === 'swarm' || mode === 'hyper'`.
- `CoverageScreen` gains a "Document coverage" section when
  `metadata.documentCoverage` exists: ratio bar, covered/partial/uncovered/
  uncoverable counts, findings table (sentence text + missing + expected
  kinds), pass history.
- All new strings bilingual in `i18n.ts`.

### 5.3 Files touched (frontend integration checklist)

`api.ts` (client fns: `startHyperRun`, `stepHyperRun`, `getLlmAgents`,
`saveLlmSettings`, `infer`), `useOntologyRun.ts`, `OntologyGenerator.tsx`
(render + canVisit for `settings`), `TopBar.tsx` (gear), `InputScreen.tsx`,
`DiscoverScreen.tsx`, `CoverageScreen.tsx`, `i18n.ts`,
`ontology-generator.css` (settings table + coverage bar classes),
`src/ontology/schema/types.ts` (mirror).

---

## 6. Verification plan

No test runner exists; verification is layered:

1. `npm run typecheck:api` + `npm run build` (both worlds compile).
2. **`scripts/test-hyper.mts`** (tsx; deterministic, no LLM): triples
   generation over all 10 golden fixtures (non-empty, every non-literal
   s/o resolves to a real node id, predicate vocabulary closed); router
   precedence matrix (env > settings > router > default; fast-sibling
   derivation; router-off behavior); sentence numbering (EN+CJK, offsets
   slice-exact); coverage pre-pass determinism (synthetic citations →
   covered); settings round-trip on the memory store; agent-registry
   completeness (every `ctxAgentLlm` call site id exists in the registry);
   use-case fixture integrity (30 cases, valid fixtures, hop paths reference
   real node ids, minHops ≥ 3).
3. **Live smoke** (keys exist in `.env`): boot `dev-api`, exercise
   `llm.agents`/`llm.settings` round-trip, one terminology chunk, one
   coverage-eval batch, one inference run against a golden fixture.
4. **Architect review pass** (multi-agent): schema-mirror structural diff,
   import-suffix compliance, contract consistency (prompt field names vs
   parsers), error-path audit (no new throw can escape a handler), frontend
   contract compliance.
