# Hyper-Automation Spec — Ontology Generation

Requirements specification for the hyper-automation upgrade. The companion
[HYPER_AUTOMATION_DESIGN.md](HYPER_AUTOMATION_DESIGN.md) holds the
architecture; [IMPLEMENTATION.md](IMPLEMENTATION.md) holds implementation
notes and test results.

## 1. Mission

Cover **100% of the user's documents** automatically. The user should never
have to hand-build an ontology: data-type recognition, terminology and entity
extraction, object/rule/action/event/process extraction, validation,
coverage verification, and workflow generation all run as orchestrated AI
agent workflows. Anything the system could not capture surfaces as an explicit,
quantified gap — never silently.

## 2. Current state (pre-upgrade review)

What exists today (see [../ONTOLOGY_GENERATION.md](../ONTOLOGY_GENERATION.md)
for the full deep-dive):

| Capability | Status before this upgrade |
|---|---|
| 5-stage extraction (objects→rules→actions→events→processes) | ✅ `fast` mode: one LLM call per stage, deterministic ground/drop/score/validate wrapper |
| Multi-agent deep extraction | ✅ `swarm` mode: SME brief → breadth pass → BA review → gap-driven deepening → link synthesis → follow-up questions |
| Coverage measurement | ⚠️ Only **expectation-side**: `computeCoverage` measures recall against what the SME swarm *expected* (`BusinessBrief.expectedEntities`), NOT against the document text itself. A document fact the SMEs never anticipated is invisible to it. |
| Terminology / data-type recognition | ❌ No dedicated pass. Data types are only assigned opportunistically during object extraction; glossary terms produced by the SME brief are domain-generic, not document-derived. |
| Document-level eval ("is every sentence represented?") | ❌ Does not exist. |
| Remediation loop (extract → verify → fill gaps → re-verify) | ⚠️ One gap-driven deepen pass exists (swarm iteration 2) but is driven by SME expectations, not document coverage; no convergence target. |
| Prompts | ⚠️ Solid contracts and citation discipline, but extraction prompts lack recall-forcing structure (section-sweep discipline, negative-space checklists, counting self-checks). |
| Multi-hop inference over the ontology | ❌ Does not exist (graph is rendered, not queried). |
| Per-agent LLM selection | ❌ One model for every call (`ONTOLOGY_GEN_MODEL || LLM_MODEL` resolved once per request). No registry, no router, no settings UI. |

## 3. Requirements

### R1 — Hyper extraction mode (100% document coverage)
- R1.1 A third run mode `hyper` orchestrating: terminology scan → SME brief →
  breadth extraction → BA review → **document-coverage eval** → remediation →
  depth pass → re-eval → final remediation → **final eval gate** → follow-up
  questions.
- R1.2 The terminology scan recognizes every business term, entity, attribute,
  enum value set, **data type** (incl. money/date/duration/id/code), role,
  abbreviation, system, and document kind — bilingual, with verbatim citations.
- R1.3 Terminology and brief seeds are injected into every downstream
  extraction prompt to force recall against them.
- R1.4 Client-paced sub-steps, each under the 60 s serverless budget; resumable
  after refresh; failures degrade gracefully (logged, never a 500).
- R1.5 Processes (workflows) are generated automatically from the extracted
  actions/events — no manual workflow assembly (already true; preserved).

### R2 — Robust prompts at every step
- R2.1 Every extraction/review/synthesis prompt rewritten to the prompt
  doctrine (design §4): recall-first sweep, negative-space checklists,
  terminology reconciliation, counting self-check.
- R2.2 JSON output contracts are FROZEN — field names byte-identical to what
  the existing parsers expect.

### R3 — Eval agent: verify 100% information coverage
- R3.1 A document-coverage eval agent classifies **every sentence of every
  source document** as covered / partial / uncovered / uncoverable, with the
  covering node ids as receipts.
- R3.2 Deterministic citation-overlap pre-pass (no LLM cost for sentences
  already cited by grounded nodes); LLM judges only the remainder;
  judging failures fail CLOSED (count as uncovered).
- R3.3 `coverageRatio = covered / (total − uncoverable)`; target configurable
  (`ONTOLOGY_GEN_COVERAGE_TARGET`, default 1.0); final pass records
  `meetsTarget` and the run surfaces it in the UI.
- R3.4 Uncovered/partial findings drive automated remediation rounds that
  re-extract ONLY the missing facts and merge without losing prior work.
  Remaining gaps surface as findings + follow-up questions.

### R4 — Multi-hop inference (30 use cases)
- R4.1 A deterministic projector converts any ontology into subject–predicate–
  object **triples** over a closed predicate vocabulary.
- R4.2 An inference engine sends frontier triples to an LLM agent in an
  expand/answer loop, producing an answer plus an explicit ≥1-hop chain of
  `{triples, inference}` records; questions of ≥3 hops are the design target.
- R4.3 Thirty written use cases (3 per golden-fixture domain), each requiring
  ≥3 hops, with hop paths referencing real node ids so they are testable.
- R4.4 Exposed as an `infer` API action.

### R5 — LLM settings page
- R5.1 A settings screen lists EVERY AI agent in the system (registry-driven):
  label, purpose, pipeline group, and the LLM (provider + model) it will use,
  with the source of that choice (env / settings / router / default).
- R5.2 Per-agent override, global default override, and router on/off are
  editable and persist across sessions (any store backend, no migration).

### R6 — Smart LLM router
- R6.1 Per-agent model resolution with precedence env > settings > router >
  default.
- R6.2 The router maps agent purpose → strength tier (extraction/enrichment/
  classification = fast tier; reasoning/review/synthesis/inference = strong
  tier), derives fast-tier siblings from the configured base model family,
  upgrades to long-context models for oversized inputs, and pins the
  OpenRouter path when web search is required.
- R6.3 Absent any configuration, behavior is identical to today (base model
  everywhere) — zero breaking change.

### R7 — Documentation & verification
- R7.1 Spec (this doc), design, implementation notes, and inference use cases
  are committed under `docs/`; `ONTOLOGY_GENERATION.md`, `README.md`,
  `CLAUDE.md`, `.env.example` updated.
- R7.2 Verification: both typecheck worlds pass; a deterministic test script
  (`scripts/test-hyper.mts`) covers triples/router/sentences/coverage-prepass/
  settings/registry/use-case integrity; live smoke exercises settings,
  terminology, coverage-eval, and inference against a golden fixture.
- R7.3 An architect review pass (schema-mirror sync, import-suffix rule,
  prompt-contract consistency, error-path audit) gates completion.

## 4. Non-goals (this iteration)

- Interactive follow-up-question answering feeding back into extraction
  (questions remain read-only output).
- An inference UI panel (API + tests only; UI is a follow-up).
- Streaming/SSE progress (the client-paced step model is retained).
- True token-level (sub-sentence) coverage accounting.
- Refactoring the existing `fast`/`swarm` modes beyond prompt rewrites and
  router wiring — their behavior contracts are preserved.
