# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone app that turns business documents (PDF/DOCX/Markdown/text) into a
structured, reviewable **ontology** — objects → rules → actions → events →
processes — via a multi-stage LLM pipeline. A Vite React SPA talks to a single
action-routed serverless handler. It runs zero-infra with just an LLM API key
(on-disk file store, anonymous auth, Neo4j off). See [README.md](README.md) for
the product tour, [ONTOLOGY_GENERATION.md](ONTOLOGY_GENERATION.md) for the
authoritative line-level deep-dive of the classic 5-stage pipeline (its §16
summarizes the deeper swarm/hyper modes), the hyper-automation spec/design
under [docs/](docs/) ([HYPER_AUTOMATION_SPEC.md](docs/HYPER_AUTOMATION_SPEC.md),
[HYPER_AUTOMATION_DESIGN.md](docs/HYPER_AUTOMATION_DESIGN.md),
[INFERENCE_USE_CASES.md](docs/INFERENCE_USE_CASES.md)), and
[PACKAGING.md](PACKAGING.md) for the extraction history (this repo was lifted
out of an internal `csiai` monorepo).

## Commands

```bash
npm install
npm run dev          # concurrently: SPA (Vite) on :3598 + local API on :5111
npm run dev:web      # Vite SPA only
npm run dev:api      # local API server only (tsx watch scripts/dev-api.mts)
npm run build        # tsc -b (typechecks src/) && vite build → dist/
npm run preview      # serve the production build
npm run typecheck:api  # typecheck api/ (NOT covered by `npm run build`)
npm run test:hyper     # deterministic hyper-automation tests (tsx scripts/test-hyper.mts, no LLM)
npm run test:editor    # deterministic JSON-editor tests (tsx scripts/test-json-editor.mts, no LLM)
npm run test:spec      # deterministic spec-format projection tests (tsx scripts/test-spec-format.mts, no LLM)
```

There is **no test framework and no lint script** in this repo. Verification is:
`npm run typecheck:api` for the backend + `npm run build` for the frontend
(the `build` step typechecks `src/` but **not** `api/`) + `npm run test:hyper`
(`scripts/test-hyper.mts`) — a deterministic, no-LLM test script covering the
hyper-automation surfaces (triples / router precedence / sentence numbering /
coverage pre-pass / settings round-trip / agent-registry completeness /
inference-use-case fixture integrity) — + `npm run test:editor`
(`scripts/test-json-editor.mts`) — a deterministic, no-LLM suite (139 checks)
covering the JSON Editor's pure logic (auto-repair / string-aware adversarial
cases / parseLayer / extract-serialize-merge round-trips / id+bilingual coercion
/ schema suggestions / candidate assembly / validateOntology integration /
layer-schema drift) — + `npm run test:spec` (`scripts/test-spec-format.mts`) — a
deterministic, no-LLM suite (36 checks) covering the **spec-format output
projection** (`api/ontology-gen/spec-format/`): it anchors the contract
validators to the hand-authored reference samples in `fixtures/spec-samples/`,
then asserts the projection of every golden ontology passes
`validateSpecBundle`, carries EXACTLY the spec field keys per node, and derives
`primary_key` / FK `references` / rule `executor`/`enforcementLevel`/
`failurePolicy` / data-vs-system class correctly. `fixtures/ontology-golden/`
holds reference ontologies consumed by all three scripts. When you finish a
backend change, run `npm run typecheck:api`, `npm run test:hyper`, and
`npm run test:spec`; for a frontend change, run `npm run build` (and
`npm run test:editor` when touching `src/ontology-generator/json-editor/`).

## Two TypeScript build worlds — the import-suffix rule

`src/` and `api/` compile under different module-resolution regimes, and the
distinction is load-bearing:

- **`src/` (frontend)** — `tsconfig.json`, `moduleResolution: bundler`, Vite-resolved.
  Import with the `@/` alias (`@/* → ./src/*`) and **no file extension**:
  `import { Ontology } from '@/ontology/schema/types'`.
- **`api/` (backend)** — `tsconfig.api.json`, `module/moduleResolution: NodeNext`.
  Every relative project import **MUST carry a `.js` suffix** even though the
  source is `.ts`: `import { STAGE_ORDER } from '../_shared/ontology-schema.js'`.
  Omitting `.js` (or adding it on the frontend) is a build error.

`tsconfig.node.json` covers only `vite.config.ts`.

## CRITICAL: the schema is a hand-maintained mirror

`src/ontology/schema/{types,validate}.ts` is the canonical schema. The backend
copies in `api/_shared/{ontology-schema,ontology-validate}.ts` are **manual,
one-time copies** kept in sync by hand. **When you change one, change the other.**

The file headers reference `npm run sync:schema` and a drift-guard — **that
script does not exist in this repo**. The sync machinery was deliberately
dropped during extraction (PACKAGING.md §2), so those comments are stale. The
two files must stay structurally identical; the frontend version uses `@/`-style
imports and the backend version uses `.js`-suffixed NodeNext imports, but the
types/consts (e.g. `STAGE_ORDER`, `SCHEMA_VERSION`) must match exactly.

Comments throughout the backend also cite `DESIGN_SPEC.md` and `TASK_PLAN` — those
docs are **not present** here (more monorepo residue). Don't go looking for them.

## Architecture

### One handler, ~25 actions

The entire backend is a single Vercel default-export handler at
[api/ontology-gen/index.ts](api/ontology-gen/index.ts). It dispatches on a
`?action=` query param (no per-route files):

`upload`, `parse`, `samples`, `run.start`, `run.step`, `run.get`,
`run.swarm.start`, `run.swarm.step`, `run.hyper.start`, `run.hyper.step`,
`stage.<objects|rules|actions|events|processes>`, `llm.agents`, `llm.settings`,
`infer`, `list`, `get`, `save`, `publish`, `delete`, `validate`, `generate`,
`import-graph`, `graph-status`.

`run.swarm.step` and `run.hyper.step` share one driver (`actionModeStep`) that
dispatches on the **persisted** `run.mode`, never the endpoint name.

- Reads are `GET` (`READ_ACTIONS`); writes are `POST`/`DELETE`.
- Every response is an envelope: `{ ok: true, ... }` or `{ ok: false, error, code? }`.
  The handler **never returns an unhandled 500** — missing Supabase/Neo4j env
  degrades gracefully; thrown errors become a 400/404 envelope via `HttpError`.
- The frontend reaches it through **one** client, [src/ontology-generator/api.ts](src/ontology-generator/api.ts)
  (`BASE = '/api/ontology-gen'`). An optional JWT in `localStorage['ontogen_auth_token']`
  is sent as a Bearer header; absent token ⇒ anonymous guest. Auth is **off by
  default**; set `ONTOLOGY_GEN_REQUIRE_AUTH=1` to require a valid token.

### Dev vs production serving

In dev, [scripts/dev-api.mts](scripts/dev-api.mts) is a thin Node `http` server
that imports the same Vercel handler and shims `req`/`res`; the Vite dev server
proxies `/api → http://localhost:5111` (see [vite.config.ts](vite.config.ts)).
In production on Vercel, `api/**/*.ts` are served as serverless functions
(1024 MB / 60 s, `includeFiles: fixtures/**`), so no proxy is needed
([vercel.json](vercel.json)).

### The 5-stage pipeline

Fixed order in `STAGE_ORDER`: **objects → rules → actions → events → processes**.
A later layer may only reference ids from earlier layers (events are co-discovered
with actions). Separation of concerns:

- **Stage functions** ([api/ontology-gen/pipeline/stages/*.ts](api/ontology-gen/pipeline/stages/))
  own **all** LLM work, via `executeLLMWithTracking` from the vendored
  [api/ontology-gen/llm.ts](api/ontology-gen/llm.ts) (OpenAI-compatible: openrouter
  default, plus openai/deepseek/qwen/moonshot; `google` routes via OpenRouter).
  Each call site resolves its model per-agent via `ctxAgentLlm(ctx, '<agent_id>')`
  (see "LLM routing" below). Prompts in [prompts.ts](api/ontology-gen/prompts.ts)
  follow the recall-first doctrine (sweep discipline, negative-space checklists,
  counting self-checks) — **the JSON OUTPUT CONTRACT field names are frozen**;
  the stage parsers depend on them byte-for-byte.
- **The orchestrator** ([api/ontology-gen/pipeline/orchestrator.ts](api/ontology-gen/pipeline/orchestrator.ts))
  owns everything **deterministic**, per stage: enforce stage order → dispatch to
  the `extract*` fn → **ground** citations against parsed text (locate verbatim
  snippets, set offsets + `quoteVerified`) → **drop ungrounded `extracted` nodes**
  (synthesized/`inferred` kept via `derivedFrom`) → recompute **confidence** via
  the locked rubric → for events, derive the **exact Action↔Event inverse** → merge
  the cleaned layer back into `ctx` → optional non-mutating **self-critique** →
  build `StageProgress` + run `validateOntology`. The orchestrator's only direct
  LLM call is the critique. Every LLM/parse failure degrades to a logged note; the
  **only** hard throw is an out-of-order stage.
- `buildOntology(ctx)` assembles the `Ontology` envelope (layers + relationships +
  ruleGroups + aggregate confidence + stats + generation provenance). It is pure
  and is also used to validate partial state between stages.

### Run lifecycle and the state stash

A live run advances **one stage per request**: `run.start` (seed an `OntologyRun`
+ draft ontology) → `run.step` (run the next pending stage, persist, repeat until
`status === 'complete'`) → `run.get` (resume after refresh). To persist the
in-progress ontology without a dedicated column that works across all stores, the
partial ontology is stashed as a `ParsedSource`-shaped row keyed
`run_ontology:<runId>` (its `text` is the JSON). `stage.<x>` re-runs a single
stage idempotently against an inline draft.

### The deep-swarm pipeline (opt-in second mode)

[api/ontology-gen/pipeline/swarm/](api/ontology-gen/pipeline/swarm/) is an
alternative, multi-agent extraction mode sitting **on top of** the deterministic
core (it calls `runStage`/`buildOntology` verbatim). A swarm run
(`OntologyRun.mode === 'swarm'`) is client-paced like a fast run, but
`run.swarm.step` advances one of **15 fine-grained sub-steps** (each kept under
the 60 s serverless cap), grouped into the 4 phases of `SWARM_PHASE_ORDER`:

1. **business_understanding** — 4-role SME swarm → a `BusinessBrief` that seeds
   all later prompts ([business-understanding.ts](api/ontology-gen/pipeline/swarm/business-understanding.ts)).
2. **iteration_1** (breadth) — brief-seeded extraction of all five stages →
   BA review of every use case → coverage report v1.
3. **iteration_2** (depth) — deepen objects/rules/actions/events → link
   synthesis → deepen processes → BA re-review → coverage v2.
4. **follow_up** — generate `FollowUpQuestion[]` (read-only in v1).

The sub-step cursor persists as another `ParsedSource`-shaped stash keyed
`swarm_state:<runId>`; the artifacts (`businessBrief`, `coverageReport`,
`followUpQuestions`) ride on `ontology.metadata`. Live web search is only
available via OpenRouter's `web` plugin (provider `openrouter`/`google` +
`OPENROUTER_API_KEY`); other providers degrade to parametric knowledge
([web-search.ts](api/ontology-gen/pipeline/swarm/web-search.ts)). The swarm
types (`SwarmPhase`, `BusinessBrief`, `CoverageReport`, …) live in both schema
mirror copies — keep them in sync like everything else there.

### The hyper pipeline (third mode — 100% document coverage)

[api/ontology-gen/pipeline/hyper/](api/ontology-gen/pipeline/hyper/) is a
superset of the swarm machine (it reuses the swarm modules verbatim). A hyper
run (`OntologyRun.mode === 'hyper'`, started via `run.hyper.start`) advances
**22 sub-steps** over the 10 phases of `HYPER_PHASE_ORDER` (schema §10c):
`terminology → business_understanding → iteration_1 → coverage_eval_1 →
remediation_1 → iteration_2 → coverage_eval_2 → remediation_2 → final_eval →
follow_up`, using the same `swarm_state:<runId>` cursor stash. The four
additions over swarm:

- **Terminology scan** ([terminology.ts](api/ontology-gen/pipeline/hyper/terminology.ts))
  — extracts `TermEntity`s (terms/data types/enums/roles/abbreviations, cited,
  bilingual) onto `metadata.terminology`; `renderTermSeed` is injected into
  every later extraction prompt alongside the brief seed (`ctx.briefSeed`).
- **Document-coverage eval** ([doc-coverage.ts](api/ontology-gen/pipeline/hyper/doc-coverage.ts))
  — classifies **every sentence** ([sentences.ts](api/ontology-gen/pipeline/hyper/sentences.ts))
  as covered/partial/uncovered/uncoverable via three tiers: deterministic
  citation-overlap pre-pass (no LLM) → deterministic boilerplate filter → LLM
  batches that **fail closed** (unparsed verdicts count as uncovered).
  `coverageRatio = covered / max(1, total − uncoverable)`; target via
  `ONTOLOGY_GEN_COVERAGE_TARGET` (default 1.0). Result on
  `metadata.documentCoverage` (+ `documentCoverageHistory`).
- **Remediation** ([remediate.ts](api/ontology-gen/pipeline/hyper/remediate.ts))
  — uncovered findings → `CoverageGap`s (≤40/stage/round) → the existing
  `deepenStage` merge-preserve path; no-ops when the eval already
  `meetsTarget`.
- **Final eval gate** — pass 3 records `meetsTarget`; `metadata.hyper` carries
  `{ passes, coverageTarget, remediationRounds, web }`.

[hyper/orchestrator.ts](api/ontology-gen/pipeline/hyper/orchestrator.ts)
(`advanceHyper`) mirrors `advanceSwarm`: step failures are logged, never
thrown; hyper step responses additionally carry `terminology` +
`documentCoverage`.

### LLM routing — registry, router, settings

[api/ontology-gen/agents.ts](api/ontology-gen/agents.ts) is the literal-const
registry of all **14 LLM-calling agents** (5 stage extractors, `stage_critic`,
`title_generator`, 4 swarm agents, `terminology_extractor`,
`coverage_evaluator`, `inference_agent`; deepen/remediation reuse the stage
extractors' ids). [api/ontology-gen/llm-router.ts](api/ontology-gen/llm-router.ts)
resolves each agent's model with precedence **env
(`ONTOLOGY_GEN_MODEL_<AGENT_ID>` / `ONTOLOGY_GEN_PROVIDER_<AGENT_ID>`) >
settings > router > default**. The router maps agent purpose → strength tier
(extraction/enrichment/classification get a fast-sibling of the base model
family, e.g. `gemini-2.5-pro → gemini-2.5-flash`; review/reasoning/synthesis/
inference keep the base model); `ONTOLOGY_GEN_ROUTER=0` is the kill switch.
Settings persist as the stash row `llm_settings:global` (works on every store
backend) and surface via `llm.agents` (GET, in `READ_ACTIONS`) /
`llm.settings` (POST).

**RULE: every new LLM call site must resolve its model via
`ctxAgentLlm(ctx, '<agent_id>')` with an id registered in `AGENT_REGISTRY`**
(the test script asserts registry completeness). `ctx.agentLlm` is attached in
[index.ts](api/ontology-gen/index.ts) via `makeAgentLlmResolver`; when absent,
`ctxAgentLlm` falls back to `ctx.model`/`ctx.provider`, so behavior without
configuration is unchanged.

### Inference engine

[api/ontology-gen/inference/triples.ts](api/ontology-gen/inference/triples.ts)
deterministically projects any ontology into subject–predicate–object triples
over a **closed predicate vocabulary**;
[engine.ts](api/ontology-gen/inference/engine.ts) (`runInference`) runs a
seed → expand/answer LLM loop (defaults: 4 iterations, 6 hops) returning an
`InferenceResult` (bilingual answer + explicit `{triples, inference}` hop
chain) — malformed JSON degrades to one retry then a graceful no-answer
result. Exposed as `infer` (POST `{ ontologyId | ontology, question,
maxHops?, maxIterations? }`). 30 multi-hop use cases (each ≥3 hops, real node
ids) live in [docs/INFERENCE_USE_CASES.md](docs/INFERENCE_USE_CASES.md) +
[fixtures/inference-use-cases.json](fixtures/inference-use-cases.json).

### Storage — graceful fallback

`getStore()` ([api/ontology-gen/store.ts](api/ontology-gen/store.ts)) picks the
backend by env: **Supabase** (if `SUPABASE_URL`+`SUPABASE_SERVICE_KEY`) →
**file** (default; append-only versioned JSON under `.data/ontology-gen`, one file
per version) → **in-memory** (`ONTOLOGY_GEN_STORE=memory`). The file store needs a
writable FS, so it does **not** work on Vercel serverless — use Supabase there, or
a persistent Node host. Neo4j is optional/env-gated and mirrored **best-effort on
publish** (a Neo4j failure never fails publish).

### Frontend — one controller hook

The container threads a single controller, [useOntologyRun](src/ontology-generator/useOntologyRun.ts),
as the `ctrl` prop to every screen (Input/Discover/Brief/Objects/Rules/Actions/
Events/Processes/Coverage/Questions/Graph/Publish/Editor/Settings). Screens are locked
to the `{ t, lang, ctrl }` prop contract — they carry no navigation callbacks; a
screen requests a step change by dispatching an `ontogen:goto` CustomEvent. The
controller exposes the fixed `OntologyRunController` interface and runs in four
modes sharing one surface:

- **`demo`** — fully offline; `datasetToOntology(DATASETS.commerce)` fabricates a
  complete ontology client-side. `step`/`save`/`reRunStage` are no-ops; `publish`
  flips status locally and `generate` is stubbed. No backend, no key.
- **`live`** — talks to the API: upload/sample → `run.start`, `step` → `run.step`
  (auto-saves on completion), review edits mutate the in-memory ontology, then
  `save`/`publish`; publish also fetches the generated bundles via `generate`.
- **`swarm`** — same surface, but `start` hits `run.swarm.start` and `step` hits
  `run.swarm.step`. [SwarmDiscover](src/ontology-generator/SwarmDiscover.tsx)
  (rendered by DiscoverScreen for swarm AND hyper modes) auto-advances sub-steps
  until the run completes. The Brief/Coverage/Questions screens render the swarm
  artifacts from `ontology.metadata`.
- **`hyper`** — third mode card on InputScreen; `startHyper` hits
  `run.hyper.start`, `step` routes to `run.hyper.step`. The controller
  additionally exposes `terminology` and `documentCoverage`;
  [CoverageScreen](src/ontology-generator/CoverageScreen.tsx) renders a
  document-coverage card (ratio bar, counts, findings, pass history) when
  `metadata.documentCoverage` exists.

Reopen-mode detection on load is **hyper-first**: a saved ontology carrying
`metadata.hyper` or `metadata.documentCoverage` reopens in hyper mode; else a
`businessBrief` reopens in swarm mode; else live.

[LLMSettingsScreen](src/ontology-generator/LLMSettingsScreen.tsx) (StepId
`'settings'`) is reachable **only** via the TopBar gear — it is deliberately in
no wizard step order and `canVisit` always allows it. It renders the agent
table from `llm.agents` (resolved model + source badge per agent) and saves
via `llm.settings`; it works in demo mode too (no LLM key needed).

[JsonEditorScreen](src/ontology-generator/JsonEditorScreen.tsx) (StepId
`'editor'`) is the **JSON Editor** — a VS Code-style Monaco editor reachable
**only** via the TopBar braces button (like settings: in no wizard order,
`canVisit` always true, and reachable with or without a run via its own
historical-ontology picker). Five tabs (Data Objects / Rules / Actions / Events /
**Workflow** == `processes`) each edit one ontology layer's JSON in a single
Monaco instance backed by five persistent models. Each tab's buffer is the
**metadata-wrapped doc** `{ metadata, <layer>: [ …nodes ] }` (processes wraps under
`"workflows"`, matching the reference samples) — `serializeLayerDoc` builds it and
`parseLayer` unwraps it (a bare array still parses, for back-compat). Validation is two-tier: Monaco's
JSON language service gives inline syntax + per-layer JSON-Schema squiggles, and
our own `validateOntology` runs over a reassembled candidate for cross-tab
semantics — both feed one diagnostics panel with click-to-locate and one-click
fixes. "Auto-fix" runs the deterministic `repairJson`; Save reassembles the layers
via `ctrl.applyLayers` + `ctrl.save` (append-only version bump; demo keeps edits
in memory). All editor logic lives under
[src/ontology-generator/json-editor/](src/ontology-generator/json-editor/): the
pure modules (`json-repair`, `layers`, `json-suggest`, `assemble`) are **alias-free
at runtime** (schema imports are type-only) so `scripts/test-json-editor.mts` can
import them directly under tsx; `monaco-setup.ts` bundles Monaco's workers offline
via Vite `?worker` (no CDN). The screen is **lazy-loaded** (`React.lazy`) so
Monaco ships as its own chunk, off the main bundle. **Two hand-maintained mirrors
of `types.ts` live here** (same convention as the schema mirror above):
`layer-schemas.ts` (the Monaco JSON-Schema enums) and `json-suggest.ts` (the
closed-vocab `as const` arrays) — keep their `DataType`/`Severity`/`KeyRole`/
`Provenance`/`ReviewStatus`/`RuleKind` copies in sync with `types.ts`;
`test-json-editor.mts` §15 drift-guards the DataType/Severity copies.

All UI styling is the scoped [ontology-generator.css](src/ontology-generator/ontology-generator.css)
(every selector under `.ontogen`); there is no Tailwind, router, or component
library. UI strings are bilingual (en/zh) via [i18n.ts](src/ontology-generator/i18n.ts).

## Schema conventions (honor on both copies)

- **ObjectType is spec-shaped.** An object carries `type` ('data' | 'system'),
  `relationship_description` (prose; the key input for inter-object edges),
  `primary_key` (default `<id>_id`), and `properties: ObjectProperty[]` —
  `{ name, type, description, is_foreign_key?, references? }` where `type` is the
  human-facing `PROPERTY_TYPES` vocabulary (`String`/`Integer`/`Float`/`Boolean`/
  `Date`/`Timestamp`/`List<String>`; `enum`/`array` → `List<String>`). There is
  **no** `attributes`/`keyRole`/`enumValues`/`refObjectTypeId` anymore; `references`
  holds the target ObjectType **id** (ids keep the `objectType:` prefix, so
  cross-layer refs are unchanged). The other four layers still use the internal
  shape and reach the sample format only through the spec-format projection below.
- Cross-references between nodes are **always by `id`** — a stable, kind-prefixed
  slug minted by `makeId` ([api/_shared/ids.ts](api/_shared/ids.ts)). `uuid` is for
  storage/Neo4j joins only.
- Every extracted node carries `sources: SourceRef[]`, `confidence`, and a
  `reviewState` — the product's "receipts"; never drop them.
- `Bilingual` (en/zh) is mandatory on names/statements/labels.
- The schema files are dependency-graph **leaves**: pure types + literal consts,
  **no runtime logic and no relative project imports**, so both build worlds can
  consume them.
- Strict TS everywhere (`strict`, `noUnusedLocals`, `noUnusedParameters`); `any`
  is not used.

## Generators

From a published (or inline) ontology, `generate` produces deployable artifacts —
`agent-code` | `prompts` | `manifest` | `spec` | `all` — in
[api/ontology-gen/generators/](api/ontology-gen/generators/).

### Spec-format output projection (`spec` target)

[api/ontology-gen/spec-format/](api/ontology-gen/spec-format/) is the
EXPORT/PRESENTATION schema — the shape the product publishes per layer, mirroring
the hand-authored reference samples in `fixtures/spec-samples/` (objects / rules /
actions / events / workflow). It is **deliberately distinct** from the canonical
internal schema: it drops the internal "receipts" (`sources`/`confidence`/
`reviewState`/`uuid`) and uses business-friendly field names + a human-facing type
vocabulary (`String`/`Integer`/`Float`/`Boolean`/`Date`/`Timestamp`/`List<…>`).

- `types.ts` — the spec-format interfaces + closed-vocab consts (a leaf, like the
  canonical schema; pure types only).
- `project.ts` — `ontologyToSpec(ontology)`, a **pure + deterministic** projection
  (no LLM/IO, no `Date.now()`/`Math.random()`). Spec fields with a first-class
  internal home pass through (`Rule.executor`, `ObjectType.objectClass`); the rest
  are DERIVED — object `type` (data/system via a name heuristic), object
  `relationship_description` (synthesized from `relationships` + FK attributes),
  `primary_key` (the pk attr, else `<snake(id)>_id`), rule `enforcementLevel`/
  `failurePolicy` (from `severity`), rule `executor` (from referencing actors).
- `validate.ts` — two-tier contract validators (per-layer SHAPE + full-bundle
  CROSS-REF), used by `scripts/test-spec-format.mts` and surfaced as generator
  warnings.
- The `spec` target serializes five per-layer JSON files via
  [generators/spec-format.ts](api/ontology-gen/generators/spec-format.ts); it's
  also one of the Publish-screen artifact tabs.

To populate the spec-only semantic fields on LIVE runs, the canonical schema
carries a few OPTIONAL extracted fields the projection prefers over its
fallbacks: `ObjectType.objectClass` + `ObjectType.relationshipNote`, and
`Rule.executor` / `enforcementLevel` / `failurePolicy` (parsed in
[stages/objects.ts](api/ontology-gen/pipeline/stages/objects.ts) /
[stages/rules.ts](api/ontology-gen/pipeline/stages/rules.ts), requested
additively in [prompts.ts](api/ontology-gen/prompts.ts)). These are optional in
both schema mirrors, so validation, the JSON editor, and existing tests are
unaffected.

## Sample corpora

The `samples`/`run.start` actions read Markdown from `fixtures/ontology-corpus/<dir>/`.
The `SAMPLES` table in [index.ts](api/ontology-gen/index.ts) maps each `DomainKey`
to a directory; doc reading is **filename-agnostic** (every `.md` in the dir,
sorted), so English- and Chinese-named corpora of any length all work. Adding a
sample = add a directory of `.md` files + a `SAMPLES` entry (and a `DomainKey` if
it's one of the gated keys in `DOMAIN_KEYS`).
