# Packaging the Ontology Generator as a Standalone App

This document records how this repository was extracted from the internal
`csiai` monorepo (`src/pages/ontology-generator/` + `api/ontology-gen/`) into a
standalone, open-source app, and what remains to do.

It serves three goals from **one** codebase:

1. **Standalone** — build & deploy it as an app that runs by itself.
2. **Embeddable** — drop it into the `allmetaOntology` project as a feature.
3. **Open source** — publish it as a public GitHub repository.

---

## 1. Why this extracts cleanly

The feature was built with modularity in mind, so the extraction is mostly a
copy plus one targeted code change.

- **Frontend is ~99% self-contained.** Every file under
  `src/ontology-generator/` imports nothing outside itself except `react` and
  the schema module (`src/ontology/schema/{types,validate}`). There is **zero**
  coupling to an app shell (`Layout`, `AuthContext`, `ProtectedRoute`), no shared
  UI library, no Zustand, no react-router, and **no Tailwind** — all styling is
  the scoped `ontology-generator.css` (every selector under `.ontogen`). The
  entry component takes no props and renders its own root `<div>`, so the
  standalone entry is literally `createRoot(el).render(<OntologyGenerator/>)`.
- **Backend is self-contained by design.** `api/ontology-gen/index.ts` routes
  18 `?action=` operations through a 5-stage LLM pipeline
  (objects → rules → actions → events → processes) with graceful degradation
  already built in: storage auto-falls-back Supabase → file → in-memory; Neo4j
  is env-gated; auth is **off by default**.
- **The one hard coupling** to the monorepo was the LLM caller: every pipeline
  stage imported `executeLLMWithTracking` from the 4k-LOC `api/ai.ts`. That is
  replaced here by a vendored, self-contained `api/ontology-gen/llm.ts`.

---

## 2. Repository structure

```
ontology-generator/
├── index.html                       # SPA host
├── package.json                     # trimmed deps (only what this feature uses)
├── vite.config.ts                   # react plugin + @/ alias + dev proxy
├── vercel.json                      # functions config + includeFiles + SPA rewrite
├── tsconfig.json / tsconfig.api.json / tsconfig.node.json
├── .env.example  .gitignore  README.md  LICENSE  PACKAGING.md
│
├── src/
│   ├── main.tsx                     # renders <OntologyGenerator/>
│   ├── ontology-generator/          # the UI subtree (17 files, copied verbatim)
│   │   └── ontology-generator.css   # full-viewport height (no host navbar)
│   └── ontology/schema/             # canonical schema: types.ts + validate.ts
│
├── api/
│   ├── ontology-gen/                # the backend (copied verbatim) ...
│   │   ├── index.ts                 #   ... except: JWT fallback + RBAC gate removed
│   │   ├── llm.ts                   # NEW — vendored LLM client (replaces ai.ts)
│   │   ├── parse.ts  prompts.ts  store.ts
│   │   ├── pipeline/{orchestrator,context,ground,confidence}.ts
│   │   ├── pipeline/stages/{objects,rules,actions,events,processes}.ts
│   │   ├── generators/{index,agent-code,prompts,manifest}.ts
│   │   └── neo4j/{driver,import}.ts
│   └── _shared/{ontology-schema,ontology-validate,ids}.ts
│
└── fixtures/
    ├── ontology-corpus/             # synthetic sample corpora (the `samples` action)
    └── ontology-golden/             # golden ontologies (optional, e2e reference)
```

### What was deliberately dropped from the monorepo

- The schema **mirror machinery** (`scripts/sync-ontology-schema.cjs`, the
  `*.dev.ts` shim generator `scripts/api-server.cjs`). They existed only because
  of the monorepo's local-dev constraints. This repo uses `vite` + the local API
  shim (or `vercel dev`) and keeps `api/_shared/*` as a plain one-time copy.
- Every npm dependency this feature does not import: `@xyflow/react`, `dagre`,
  `framer-motion`, `lucide-react`, `clsx`, `tailwind-merge`, all `@codemirror/*`,
  `xlsx`, `@vercel/blob`, `bcryptjs`, `zustand`, `react-router-dom`, all
  `@radix-ui/*`, `tailwindcss`/`postcss`/`autoprefixer`, and `uuid` (the backend
  uses Node's built-in `crypto.randomUUID`).

---

## 3. The one required code change: `api/ontology-gen/llm.ts`

The monorepo's stages called `executeLLMWithTracking` from `api/ai.ts`, which
transitively pulled in Supabase-backed settings/usage/auth. This repo vendors a
~150-line `llm.ts` that:

- exports the same surface the pipeline imports — `executeLLMWithTracking`,
  `callLLM`, and the types `ChatMessage`, `ExecuteLLMOptions`, `UserInfo`,
  `LLMProvider`;
- supports the same providers (`openrouter` default, plus `openai`, `deepseek`,
  `qwen`, `moonshot`, all OpenAI-compatible);
- resolves API keys directly from env (no Supabase settings table);
- drops token-usage logging (the monorepo logged to Supabase; here it's a no-op).

The 6 import sites were repointed:

| File | Was | Now |
|---|---|---|
| `pipeline/orchestrator.ts` | `../../ai.js` | `../llm.js` |
| `pipeline/stages/objects.ts` | `../../../ai.js` | `../../llm.js` |
| `pipeline/stages/rules.ts` | `../../../ai.js`, `../../../settings.js` | `../../llm.js` |
| `pipeline/stages/actions.ts` | `../../../ai.js` | `../../llm.js` |
| `pipeline/stages/events.ts` | `../../../ai.js` | `../../llm.js` |
| `pipeline/stages/processes.ts` | `../../../ai.js` | `../../llm.js` |

> **Provider note:** `LLM_PROVIDER=google` has no dedicated branch in `callLLM`;
> it falls through to the OpenRouter path, so it still needs `OPENROUTER_API_KEY`.

---

## 4. Severing the rest of the monorepo coupling

| Coupling | Fix applied |
|---|---|
| Hardcoded JWT fallback secret in `index.ts` | Removed — auth fails closed when `JWT_SECRET` unset. |
| RBAC dynamic `import('../permissions.js')` | Removed — it returned `true` without Supabase anyway. |
| Store defaulted to Supabase | Defaults to the on-disk **file store** when Supabase env is unset. |
| Neo4j mirror | Left optional, env-gated; `neo4j-driver` is an optional dependency. |
| Frontend localStorage token key (`csiai_auth_token`) | Renamed to `ontogen_auth_token`; absent token simply omits the header. |
| CSS `height: calc(100vh - 80px)` (host navbar) | Changed to full viewport height. |

---

## 5. Zero-infra default mode

Out of the box, with only an LLM API key:

```bash
cp .env.example .env       # set OPENROUTER_API_KEY
npm install
npm run dev                # SPA (Vite) + local API on :5111
```

With nothing else configured: **file store** under `.data/ontology-gen`,
**anonymous** auth, **Neo4j disabled**, samples read from `fixtures/`. There is
also a **no-key `demo` mode** (the UI fabricates a full ontology client-side with
no backend) for trying the interface with zero configuration.

> ⚠️ The file store writes under `process.cwd()/.data`, which is **read-only on
> Vercel serverless**. On Vercel, add Supabase for persistence (or deploy as a
> persistent Node process / container, e.g. Render / Fly.io / Docker, where the
> file store persists).

**Upgrade paths:** set `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` for durable
storage; `NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD` for the graph mirror;
`ONTOLOGY_GEN_REQUIRE_AUTH=1` + your own `JWT_SECRET` to require auth.

---

## 6. Open-source readiness checklist

- [x] Vendor the LLM client; remove the `api/ai.ts` dependency.
- [x] Remove the hardcoded JWT fallback secret.
- [x] Add an MIT `LICENSE`; set `package.json` `"private": false` + neutral name.
- [x] Rename the `csiai_auth_token` localStorage key.
- [x] `.gitignore` `node_modules`, `dist`, `.data`, `.env`, `public/temp`, `.DS_Store`.
- [x] Confirm sample corpora are synthetic — scans found **no** national IDs,
      phone numbers, bank cards, emails, or credit codes (only placeholder
      persons like 张三/李四 and fictional companies).
- [ ] **Optional:** rename fictional brands in the corpora that coincidentally
      resemble real firms, to avoid any implied association.
- [ ] Choose the final public repo name (this scaffold uses `ontology-generator`).

---

## 7. Deployment

**Standalone Vercel:** push to GitHub, import into Vercel (auto-detects Vite),
set `OPENROUTER_API_KEY`. `vercel.json` sets the functions to 1024 MB / 60 s and
bundles `fixtures/**` via `includeFiles` so the `samples` action works in
production. For persistence on Vercel, also set the Supabase env vars.

**Persistent-process / container:** any Node host where the `.data` directory
persists gives a genuinely zero-infra, durable deployment. Set
`ONTOLOGY_GEN_DATA_DIR` to a mounted volume.

---

## 8. Embedding into allmetaOntology (pending — Phase 3)

`allmetaOntology` is a **pnpm + Turbo monorepo (Next 16 / React 19 / Tailwind 4)**
deployed as Next standalone in Docker, with workspace packages
`@allmeta/llm-gateway`, `@allmeta/neo4j-driver`, and `@allmeta/ontology-core`.
It has **no Vite and no Vercel-serverless layer**, so this app cannot be mounted
as-is. Recommended path:

1. Vendor the UI subtree into a new `apps/ontology-generator/` as a
   `'use client'` component (its scoped CSS coexists with Tailwind 4; no router
   needed). Verify behavior under React 19.
2. Re-express the 18 `?action=` operations as Next App Router `route.ts`
   handlers (`runtime = 'nodejs'`, `dynamic = 'force-dynamic'`).
3. Swap `llm.ts` → `@allmeta/llm-gateway`, Neo4j → `@allmeta/neo4j-driver`, and
   reconcile the schema with `@allmeta/ontology-core` (shapes differ — an adapter
   is likely).
4. Bundle `fixtures/` via Next standalone output file tracing.

---

## 9. Status

- **Phase 0 — frontend standalone (demo mode):** scaffolded.
- **Phase 1 — full standalone live pipeline:** scaffolded (vendored `llm.ts`,
  scrubbed `index.ts`, build config).
- **Phase 2 — OSS publish:** license/readme/scrub in place; final repo name + any
  brand renames pending.
- **Phase 3 — allmetaOntology embed:** not started (see §8).
