# Hyper-Automation — Implementation Notes & Test Results

Companion to [HYPER_AUTOMATION_SPEC.md](HYPER_AUTOMATION_SPEC.md) (requirements)
and [HYPER_AUTOMATION_DESIGN.md](HYPER_AUTOMATION_DESIGN.md) (architecture).
This document records what was actually built, how it was verified, and what
the architect-review + test passes found and fixed.

## 1. Implementation inventory

### Backend — new modules

| Module | Role |
|---|---|
| `api/ontology-gen/agents.ts` | Literal-const registry of all 14 LLM agents (id, purpose, group, bilingual label/description) |
| `api/ontology-gen/llm-router.ts` | Smart per-agent model resolution: env `ONTOLOGY_GEN_MODEL_<AGENT_ID>` > settings overrides > purpose-tier router (fast-sibling family table, long-context upgrade, web pinning) > base default; settings persisted as stash row `llm_settings:global` |
| `api/ontology-gen/pipeline/hyper/sentences.ts` | Sentence substrate: global continuously-numbered, offset-exact sentences (EN + CJK) + batching |
| `api/ontology-gen/pipeline/hyper/terminology.ts` | Terminology & data-type recognition agent (chunked, ≤3 concurrent, merged glossary with citations); `renderTermSeed` injects it into every extraction prompt; `matchTerms` deterministically links terms to realized ontology nodes |
| `api/ontology-gen/pipeline/hyper/doc-coverage.ts` | Document-coverage eval agent: tier 1 deterministic citation-overlap (zero LLM cost), tier 2 boilerplate filter, tier 3 batched LLM judging — **fail-closed** (no verdict ⇒ uncovered) |
| `api/ontology-gen/pipeline/hyper/remediate.ts` | Uncovered/partial findings → `CoverageGap`s (verbatim sentence embedded) → `deepenStage` merge-preserve re-extraction; guards on meetsTarget/no-brief/no-findings; 40-gap cap per stage/round |
| `api/ontology-gen/pipeline/hyper/orchestrator.ts` | The hyper phase machine: fixed sub-step array over the 10 `HYPER_PHASE_ORDER` phases (terminology → SME → extract ×5 → BA → eval 1 → remediate ×5 → deepen ×4 → links → deepen processes → BA 2 → eval 2 → remediate ×5 → final eval gate → questions). One stage per remediation sub-step (60 s budget). Mirrors `advanceSwarm` semantics exactly (error-swallowing, cursor+1, metadata accumulation) |
| `api/ontology-gen/inference/triples.ts` | Pure `Ontology → Triple[]` projection over a closed 21-predicate vocabulary + label map + stats |
| `api/ontology-gen/inference/engine.ts` | Multi-hop inference agent loop: seed-entity selection → deterministic frontier-triple expansion → LLM expand/answer decisions → `InferenceResult` with explicit hop chain; never throws |

### Backend — edits

- `index.ts`: five new actions — `run.hyper.start`, `run.hyper.step` (shared
  `actionModeStep` driver dispatching on persisted `run.mode`, with
  wrong-mode 400 guards both ways), `llm.agents` (GET), `llm.settings` (POST),
  `infer` (POST). `ctx.agentLlm` (a `makeAgentLlmResolver` closure over
  settings loaded once per request) attached at every StageContext build site;
  title upgrade routed through `title_generator`.
- Router sweep: every LLM call site now resolves via `ctxAgentLlm(ctx, '<agent_id>')` —
  the 5 stage extractors, the orchestrator critique (`stage_critic`), the swarm
  orchestrator (`sme_swarm` web-guarded, `ba_reviewer` ×2, `question_generator`),
  link synthesis (`link_synthesizer`). Hyper/inference modules resolve internally.
- `pipeline/context.ts`: optional `agentLlm` field (absent ⇒ pre-router behavior,
  byte-identical).
- Schema mirrors (`src/ontology/schema/types.ts` + `api/_shared/ontology-schema.ts`):
  sections 10c/10d — hyper phases, terminology, coverage-eval, agent-registry/
  settings, and inference types; `OntologyMetadata` artifacts; byte-identical
  after header strip. `ids.ts`: `term:` prefix.
- **Prompt doctrine rewrite** (`prompts.ts` + swarm seed renderers): the
  precision-first rule ("Returning FEWER, correct items is the goal") replaced
  with completeness-and-fidelity; new `SWEEP_METHOD` (segment → enumerate →
  filter → reconcile-seed → completeness pass); per-stage negative-space
  checklists; counting self-checks; anti-truncation output budget; BA reviewer
  flipped from "conservative" to exhaustive-but-evidenced. **All JSON output
  contracts verified byte-identical** to what the parsers expect.
  `callJson` gained a one-retry JSON repair.

### Frontend

- `LLMSettingsScreen.tsx` (new): registry-driven agent table grouped by
  pipeline, resolved provider/model with source badge + rationale, per-agent
  overrides, global defaults, router toggle; persists via `llm.settings`.
  Reachable any time via the TopBar gear (`StepId 'settings'`, outside the
  wizard order).
- Hyper mode: third mode card on `InputScreen`; `useOntologyRun` gains
  `'hyper'` mode, `startHyper`, `terminology`, `documentCoverage` (in-flight
  guard on `step()`); `SwarmDiscover` reused for the hyper phase stepper
  (halts on error, manual Retry); `CoverageScreen` document-coverage card
  (ratio bar, target badge, findings table); hyper-first reopen for saved
  ontologies carrying `metadata.hyper`/`documentCoverage`; bilingual i18n
  throughout.

### Content & docs

- `docs/INFERENCE_USE_CASES.md` + `fixtures/inference-use-cases.json` — 30
  bilingual use cases (3 × 10 golden domains, six archetypes, hop counts 3–7);
  every hop path machine-verified against real fixture node ids (162 node
  checks, 132 predicate checks, 132 edge-walk checks — all pass).
- `README.md` (hyper feature section + env table), `ONTOLOGY_GENERATION.md`
  §16, `CLAUDE.md`, `.env.example` updated.

## 2. Verification results

### Deterministic suite — `npm run test:hyper` → **50/50 pass**

| Section | Checks |
|---|---|
| Triples over all 10 golden fixtures | 11 |
| Router precedence matrix | 12 |
| Sentence numbering (EN + CJK, slice-exact offsets) | 5 |
| Coverage pre-pass determinism (zero-LLM proof via throwing stub) | 5 |
| Merge-preserve dedup (deepen/remediation regression) | 4 |
| LLM-settings round-trip on the memory store | 4 |
| Agent-registry completeness (static call-site scan) | 4 |
| Use-case fixture integrity | 5 |

`npm run typecheck:api` and `npm run build` both clean.

### Handler smoke (memory store, no LLM)

`llm.agents` → 14 agents + 14 assignments with rationales; `llm.settings`
round-trip (unknown agent dropped, override → source `settings`); `infer`
error envelopes (`NO_QUESTION`, 404); `run.hyper.start` → `mode: 'hyper'`,
10 pending phases; `run.swarm.start` regression intact; GET/POST method gates
correct.

### Live inference smoke (real LLM)

Retail use case "An invoice on a customer's account goes overdue — which
automated chain places new orders on hold, and which object records the
freeze?" → correct answer in **6.1 s**, tracing invoice → overdue rule →
credit-screening action → credit hold event → CreditHold object freezing the
Order, with the consumed triples cited (8 of 618 in the graph) — matching the
use case's documented hop path.

### End-to-end hyper run (real LLM, retail corpus, 3 documents)

Run on the local dev API (memory store). Observed:

- Terminology scan: **105 terms** in 25 s.
- Iteration 1: 10 objects / 20 relationships / 20 rules / 16 actions /
  24 events / 3 processes.
- **Coverage eval pass 1: 59.2%** of coverable sentences (409 total, 159
  uncoverable, 49 uncovered + 53 partial findings).
- **Remediation visibly closed gaps**: objects 10→20, rules 20→74, actions
  16→32, processes 3→6, relationships 20→35 (then →56 after link synthesis).
- Mid-run the local server dropped connections for ~4 minutes; the
  client-paced cursor design recovered exactly as designed — failed HTTP
  attempts never advanced the cursor and the run resumed losslessly.
- **Final gate: coverage 59.2% (pass 1) → 95.9% (pass 3)** — 256 of 267
  coverable sentences covered; the remaining 10 uncovered + 1 partial were
  honestly reported (`meetsTarget: false` against the 1.0 target) as 11
  findings plus 8 targeted follow-up questions. Three eval passes recorded
  (history: 1, 2 + final 3). Final layers: 20 objects / 79 rules / 33 actions /
  48 events / 7 processes / 75 relationships.
- **Caveat — this run executed on a pre-review-fix server snapshot** and its
  node counts are inflated by the then-unfixed duplicate-id merge bug. A
  post-run audit of its final ontology found exactly the predicted signature:
  10/10 object names duplicated, 19 duplicate rule titles, 16 duplicate
  action names, 47 `-N`-suffixed ids (events clean — they are keyed
  deterministically, as the review predicted).

### Fixed-code validation run (same corpus, through remediation round 1)

A second fresh run on the post-review-fix build, driven through eval pass 1 +
the per-stage remediation steps:

- **Duplicate audit: clean** — 0 duplicated object/rule/action keys, 0
  `-N`-suffixed ids after remediation; the remediate-objects step re-extracted
  against 40 gaps, the canonical-key merge dropped every reproduction
  (objects 10→10) while keeping 20 genuinely-new relationships. The
  duplication bug is gone (also covered by deterministic regression checks,
  suite section 4b).
- The new code paths all logged correctly: per-stage remediation sub-steps,
  the 40-gap cap ("82 dropped"), and the no-findings skip guards.
- This run also surfaced a transient provider failure — the rules extraction
  call was terminated mid-stream by the provider (`rules: LLM call failed
  (terminated)`); the pipeline degraded gracefully (logged, empty layer,
  coverage eval honestly measured the gap at 41.9%). In response,
  `executeLLMWithTracking` gained ONE retry with a 2 s backoff on transient
  transport failures (config errors — bad key/model — still rethrow
  immediately), since a lost call silently empties a whole extraction stage.

## 3. Architect review — 6 reviewers + adversarial verification

15 raw findings → 21 verification agents → **11 confirmed (8 unique), 4
refuted**. All 8 unique defects fixed and re-verified (typecheck + build +
46/46 tests green afterwards):

1. **CRITICAL — deepen/remediation duplicate ids** (`swarm/deepen.ts`): the
   "REPRODUCE with the same id" contract was unhonorable (parsers re-mint
   against `ctx.taken`, producing `-2` ids), so every deepen pass duplicated
   the layer. Fixed: the merge now keys on a canonical content key
   (normalized name/title; relationship signature; event id), snapshot copy
   wins, only genuinely new items survive. Fixes a pre-existing swarm bug too.
2. **MAJOR — SME web pin** (`hyper/orchestrator.ts`): `needsWeb: true`
   unconditionally pinned the OpenRouter path, silently gutting the business
   brief on direct-provider deployments. Fixed: guarded by
   `webSearchAvailable(ctx.provider)` (mirrors swarm).
3. **MAJOR — CJK fail-open hole** (`doc-coverage.ts`): any sentence with 1–5
   CJK chars was 'uncoverable' regardless of Latin content, hiding real gaps
   and inflating the ratio. Fixed: substance judged jointly over CJK chars +
   Latin tokens.
4. **MAJOR — remediation vs 60 s budget** (`hyper/orchestrator.ts`): a single
   sub-step could run up to 5 sequential full-stage re-extractions. Fixed:
   one stage per remediation sub-step (machine grew from 22 to 29 sub-steps;
   no-findings steps no-op instantly).
5. **MAJOR — SME brief dangling refs** (`business-understanding.ts`):
   personas/expectedEntities were re-minted but useCase `personaIds`/
   `expectedEntityIds` kept the model's raw ids — nullifying per-use-case
   coverage. Fixed: raw-id and name remaps recorded during merge; references
   rewritten after the merge; unresolved dropped.
6. **MAJOR — runaway auto-step on error** (`SwarmDiscover.tsx`): a failed step
   set `ctrl.error` without flipping `run.status`, so the auto-loop retried
   forever. Fixed: loop halts on error; manual Retry button added.
7. **MINOR — cross-mode stepping** (`index.ts`): fast runs could be stepped
   via the phase-machine endpoint and vice versa. Fixed: `WRONG_RUN_MODE`
   400 guards in both `actionRunStep` and `actionModeStep`.
8. **MINOR — StrictMode double-step / settings navigation**
   (`useOntologyRun.ts`, `OntologyGenerator.tsx`): added a synchronous
   in-flight ref guard to `step()`; the post-setup navigation now keys on the
   `hasRun` false→true transition so loading a session from the settings
   screen navigates correctly without yanking users browsing settings mid-run.

Refuted (4): claims about phase-range off-by-ones, an eval fail-open that was
actually fail-closed, a schema-mirror drift that was comment-only, and a
supposed unhandled throw already covered by the outer envelope catch.

## 4. Known limitations

- **100% is a target with receipts, not a guarantee**: the final eval gate
  records `meetsTarget`; anything below target remains visible as findings +
  follow-up questions rather than silently passing.
- The inference engine may compress an obvious chain into fewer hop records
  than the graph distance (the chain is still spelled out in the hop's
  inference text and cited triples).
- `executeLLMWithTracking`'s usage tracking remains a no-op (vendored as-is).
- The critique pass's structured issues are still summary-only (pre-existing).
- E2E wall-clock: a full hyper run on a 3-document corpus ≈ 25–40 min with a
  flash-tier model — stage calls (not sub-step orchestration) dominate.
