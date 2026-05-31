# Ontology Generator

Turn business documents into a structured, reviewable **ontology** — objects,
rules, actions, events, and processes — using a multi-stage LLM pipeline. Upload
your own PDFs / DOCX / text, or start from a bundled sample corpus, then review
and refine each layer and explore the result as an interactive graph.

- **Bilingual UI** (English / 中文)
- **5-stage extraction pipeline:** objects → rules → actions → events → processes
- **Grounded extraction** with per-item source snippets and confidence
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
npm run dev                   # SPA on http://localhost:5273, API on :5111
```

Open http://localhost:5273. Pick a **sample corpus** or upload your own
documents, then watch the pipeline extract each layer.

### Try it with no API key

The UI ships a **demo mode** that fabricates a complete ontology entirely in the
browser — no backend, no LLM key — so you can explore the interface before
configuring anything. Choose "Demo" on the input screen.

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
- **Backend** — `api/ontology-gen/index.ts` routes ~18 `?action=` operations
  (`upload`, `parse`, `samples`, `run.start` / `run.step` / `run.get`,
  `stage.<objects|rules|actions|events|processes>`, `list`, `get`, `save`,
  `publish`, `delete`, `validate`, `generate`, `import-graph`, `graph-status`)
  through the pipeline. The LLM client is the self-contained
  `api/ontology-gen/llm.ts`.
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
