# Ontology Generator

Turn business documents into a structured, reviewable **ontology** — objects,
rules, actions, events, and processes — using a multi-stage LLM pipeline. Upload
your own PDFs / DOCX / text, or start from a bundled sample corpus, then review
and refine each layer and explore the result as an interactive graph.

- **Bilingual UI** (English / 中文) with a responsive top bar that collapses
  gracefully from wide screens down to narrow windows
- **5-stage extraction pipeline:** objects → rules → actions → events → processes
- **Three extraction modes:** fast (one LLM call per stage), swarm (multi-agent
  SME pipeline), and **hyper** (swarm + terminology scan + sentence-level
  coverage verification + automatic gap remediation)
- **Grounded extraction** with per-item source snippets and confidence
- **Human-in-the-loop review** — accept / reject / edit / merge each node,
  **Accept all** of a layer at once, or **re-run** any single stage; every
  decision is persisted as a new append-only version
- **Interactive graph** (force / radial / hierarchical / clustered layouts)
- **Publish** to a versioned store, optionally mirrored to **Neo4j**
- **Code/prompt/manifest generators** from the published ontology
- **Zero-infra default:** runs with just an LLM API key (on-disk file store, no
  auth, no database)

> This project was extracted from an internal monorepo into a standalone,
> open-source app. See [PACKAGING.md](./PACKAGING.md) for the extraction record
> and architecture notes.

---

## Quickstart (60 seconds)

```bash
git clone <this-repo> ontology-generator
cd ontology-generator
npm install

cp .env.example .env          # set OPENROUTER_API_KEY=<your key>
npm run dev                   # SPA on http://localhost:3598, API on :5111
```

Open http://localhost:3598. Pick a **sample corpus** or upload your own
documents, then watch the pipeline extract each layer.

### Try it with no API key

The UI ships a **demo mode** that fabricates a complete ontology entirely in the
browser — no backend, no LLM key — so you can explore the interface before
configuring anything. Choose "Demo" on the input screen.

---

## Review & refine

Extraction produces a **draft** — the deliverable is the ontology you've reviewed.
Each layer (objects, rules, actions, events, processes) opens in its own screen
where every node shows its verbatim source citations and confidence. From there you
can:

- **Accept / Reject / Edit / Merge** individual nodes — each decision is saved
  immediately.
- **Accept all** still-unreviewed nodes of a layer in one click (a single saved
  version, not one per node).
- **Re-run this stage** to regenerate just that layer against the current draft,
  without rerunning the whole pipeline.

Every change is persisted as a new **append-only version**, so history is never
lost, and a node's review state gates what finally publishes.

---

## Hyper automation

Beyond the default **fast** mode (one LLM call per stage) and the multi-agent
**swarm** mode, the input screen offers a third card: **hyper** mode, which
aims at covering **100% of your documents** automatically. A hyper run drives
22 client-paced sub-steps over 10 phases:

1. **Terminology & data-type scan** — every business term, entity, attribute,
   enum set, data type, role, abbreviation, and document kind is extracted
   first (with verbatim citations) and seeded into every later prompt.
2. **Multi-agent extraction** — the swarm machine (SME brief → breadth pass →
   BA review → gap-driven deepening → link synthesis), reused verbatim.
3. **Sentence-level coverage eval** — an eval agent classifies *every sentence
   of every source document* as covered / partial / uncovered / uncoverable,
   with the covering node ids as receipts. A deterministic citation-overlap
   pre-pass resolves most sentences for free; LLM judging of the remainder
   fails closed (a judging failure can only increase reported gaps).
4. **Automatic gap remediation** — uncovered sentences become targeted
   re-extraction gaps that merge back without losing prior work.
5. **Final coverage gate** — a last eval pass records whether the run meets
   the configurable coverage target, surfaced on the review screen.
6. **Follow-up questions** — whatever the documents could not answer is
   emitted as explicit, citable questions.

**LLM settings & smart router.** The gear icon in the top bar opens a settings
screen listing every AI agent in the system (14, registry-driven) with the
provider + model it will use and *why* (env / settings / router / default).
You can override any agent, change the global default, or disable the router.
Absent any configuration, a smart router picks model strength per agent
purpose — extraction-tier agents get a fast sibling of your base model (e.g.
`gemini-2.5-pro → gemini-2.5-flash`), reasoning/review/synthesis agents keep
the strong base model. Per-agent env vars beat everything.

**Multi-hop inference.** Any ontology can be queried through the `infer` API
action: a deterministic projector converts the graph into subject–predicate–
object triples, and an inference agent walks them in an expand/answer loop,
returning a bilingual answer plus an explicit hop-by-hop reasoning chain.
Thirty ready-made multi-hop use cases (3 per sample domain, each ≥3 hops) live
in [docs/INFERENCE_USE_CASES.md](./docs/INFERENCE_USE_CASES.md).

**JSON editor.** The braces icon (`{ }`) in the top bar opens a VS Code-style
JSON editor (Monaco, bundled offline) with a tab per ontology layer — Data
Objects, Rules, Actions, Events, Workflow. Pick any saved ontology, edit its
layers as JSON with live syntax + schema validation, one-click **Auto-fix** for
broken JSON, and inline suggestions; cross-tab semantics are checked with the
same `validateOntology` the pipeline uses, and Save persists a new version.
See [docs/JSON_EDITOR.md](./docs/JSON_EDITOR.md).

The full requirements and architecture live in
[docs/HYPER_AUTOMATION_SPEC.md](./docs/HYPER_AUTOMATION_SPEC.md) and
[docs/HYPER_AUTOMATION_DESIGN.md](./docs/HYPER_AUTOMATION_DESIGN.md).

---

## How it works

```
            ┌──────────────┐      ┌─────────────────────────────────────────┐
 Browser    │  Vite SPA    │  →   │  /api/ontology-gen?action=…             │
 (React)    │  .ontogen UI │      │  single serverless handler (index.ts)   │
            └──────────────┘      └───────────────┬─────────────────────────┘
                                                  │
                          ┌───────────────────────┼───────────────────────┐
                          ▼                       ▼                       ▼
                    parse (pdf/docx)      5-stage LLM pipeline      store (file/
                                          objects→rules→actions     supabase/memory)
                                          →events→processes              │
                                                  │                       ▼
                                                  └──────────────►  Neo4j (optional)
```

- **Frontend** — `src/ontology-generator/` (a self-contained React subtree) +
  `src/ontology/schema/` (the canonical type system). All API calls go through
  the single client in `src/ontology-generator/api.ts`.
- **Backend** — `api/ontology-gen/index.ts` routes ~25 `?action=` operations
  (`upload`, `parse`, `samples`, `run.start` / `run.step` / `run.get`,
  `run.swarm.start` / `run.swarm.step`, `run.hyper.start` / `run.hyper.step`,
  `stage.<objects|rules|actions|events|processes>`, `llm.agents`,
  `llm.settings`, `infer`, `list`, `get`, `save`, `publish`, `delete`,
  `validate`, `generate`, `import-graph`, `graph-status`) through the
  pipeline. The LLM client is the self-contained `api/ontology-gen/llm.ts`,
  fronted by a per-agent router (`api/ontology-gen/llm-router.ts`).
- **Samples** — synthetic corpora in `fixtures/ontology-corpus/`.

---

## Configuration

The only required variable is an LLM API key. Everything else is optional; see
[.env.example](./.env.example) for the full list.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OPENROUTER_API_KEY` | ✅ | — | Default LLM provider key |
| `ONTOLOGY_GEN_MODEL` / `LLM_MODEL` | | provider default | Model id |
| `LLM_PROVIDER` | | `openrouter` | `openrouter` \| `openai` \| `deepseek` \| `qwen` \| `moonshot` |
| `ONTOLOGY_GEN_STORE` | | `file` (when no Supabase) | `file` \| `memory` |
| `ONTOLOGY_GEN_DATA_DIR` | | `<cwd>/.data/ontology-gen` | File-store directory |
| `ONTOLOGY_GEN_REQUIRE_AUTH` | | off | `1` requires a valid Bearer JWT |
| `JWT_SECRET` | only if auth on | — | JWT signing secret (no fallback) |
| `ONTOLOGY_GEN_COVERAGE_TARGET` | | `1.0` | Document-coverage eval target (0..1, hyper mode) |
| `ONTOLOGY_GEN_ROUTER` | | on | `0` disables the smart per-agent LLM router |
| `ONTOLOGY_GEN_MODEL_<AGENT_ID>` | | — | Per-agent model pin (e.g. `ONTOLOGY_GEN_MODEL_RULES_EXTRACTOR`) |
| `ONTOLOGY_GEN_PROVIDER_<AGENT_ID>` | | — | Per-agent provider pin (pairs with the model pin) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | | — | Durable store (optional upgrade) |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | | — | Graph mirror (optional) |

> **Provider note:** `LLM_PROVIDER=google` has no dedicated branch and routes via
> OpenRouter, so it still uses `OPENROUTER_API_KEY`.

---

## Deployment

### Vercel (one project: SPA + serverless functions)

1. Push to GitHub and import into Vercel (auto-detects the Vite framework).
2. Set `OPENROUTER_API_KEY` (and any optional vars).
3. `vercel.json` already configures the functions (1024 MB / 60 s) and bundles
   `fixtures/**` so the `samples` action works in production.

> ⚠️ **Persistence on Vercel:** the file store needs a writable filesystem, which
> serverless functions do **not** provide. For durable storage on Vercel, set
> `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`. For a genuinely zero-infra *and*
> durable deployment, run it as a persistent Node process / container (Render,
> Fly.io, Docker) where `.data` persists; point `ONTOLOGY_GEN_DATA_DIR` at a
> mounted volume.

---

## Project layout

```
src/ontology-generator/   the React UI (screens, controller hook, client API, CSS)
src/ontology/schema/      canonical ontology types + validators
api/ontology-gen/         the serverless handler, pipeline, generators, neo4j, llm.ts
api/_shared/              schema/validator/id helpers used by the backend
fixtures/ontology-corpus/ synthetic sample corpora (the `samples` action)
scripts/dev-api.mts       local dev API server (Vercel-handler adapter)
```

---

## License

[MIT](./LICENSE) © 2026 Kenny Chien.

Sample corpora are synthetic (fictional companies and placeholder persons) and
contain no real personal data.
