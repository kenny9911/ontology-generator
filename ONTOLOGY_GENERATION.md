# Ontology Generation — How It Works

This is the authoritative design document for the ontology-generation pipeline in this repository (`api/ontology-gen`). The pipeline ingests uploaded business documents (PDF, DOCX, Markdown/plain text, or HTML) and, through five ordered LLM extraction stages wrapped in a deterministic orchestration layer, produces a single versioned, schema-validated **Ontology**: a bilingual, fully-cited graph of business **objects → rules → actions → events → processes** (plus first-class relationships and rule groups). Every node carries provenance "receipts" — verbatim source citations, a computed confidence score, a review state, and derivation links. A finished ontology is the sole source of truth for the downstream generators, which compile it into deployable TypeScript agent code, LLM agent prompts, and runtime workflow manifests.

Sections 1–15 describe the single-pass **fast** mode (`OntologyRun.mode === 'fast'`) end-to-end. Two deeper, opt-in run modes sit **on top of** this same deterministic core and reuse it verbatim: the multi-agent **swarm** mode ([pipeline/swarm/](api/ontology-gen/pipeline/swarm/)) and the coverage-guaranteed **hyper** mode ([pipeline/hyper/](api/ontology-gen/pipeline/hyper/)), which adds a terminology scan, a sentence-level document-coverage eval agent, automatic gap remediation, per-agent LLM routing, and a multi-hop inference engine. §16 summarizes both; the full requirements and architecture live in [docs/HYPER_AUTOMATION_SPEC.md](docs/HYPER_AUTOMATION_SPEC.md) and [docs/HYPER_AUTOMATION_DESIGN.md](docs/HYPER_AUTOMATION_DESIGN.md).

---

## 1. End-to-end flow

```
                 UPLOAD                              RUN LIFECYCLE (client-paced)
  ┌──────────────────────────────┐     ┌──────────────────────────────────────────────┐
  │ files[] (PDF/DOCX/MD/HTML/txt)│     │  run.start ─► seed run + empty-layer Ontology  │
  └───────────────┬──────────────┘     │       │                                        │
                  ▼                     │       ▼   (loop: ONE stage per call)           │
        ┌──────────────────┐           │  run.step ─► pick first non-complete stage ───┐│
        │  parseDocument()  │  pure     │       │                                       ││
        │  decode+normalize │  no I/O   │       ▼                                       ││
        └────────┬─────────┘            │   runStage(stage, ctx)                        ││
                 ▼                       │   ┌─────────────────────────────────────────┐ ││
        ┌──────────────────┐            │   │ assertStageOrder                         │ ││
        │   ingestOne()     │           │   │ extract*  (1 LLM call, pure)             │ ││
        │ mint id, hash,    │  store    │   │ groundSources (locate verbatim snippets) │ ││
        │ persist Parsed    │◄──────────┤   │ dropUngroundedNodes                      │ ││
        └────────┬─────────┘            │   │ score*Confidence (locked rubric)         │ ││
                 ▼                       │   │ [events only] deriveEventInverse         │ ││
     SourceDocument[] + ParsedSource[]  │   │ merge (replace ctx layer)                │ ││
                 │                       │   │ runCritique (read-only LLM, optional)    │ ││
                 └───────────────────────►  │ validateOntology(buildOntology(ctx))     │ ││
                                         │   └─────────────────────────────────────────┘ ││
                                         │       │ persistRunState (run + partial JSON) ◄┘│
                                         │       ▼                                        │
                                         │  ...repeat until all 5 stages complete...      │
                                         │       │                                        │
                                         │       ▼                                        │
                                         │  status='complete'  ► finished Ontology        │
                                         └───────────────────────┬─────────────────────────┘
                                                                 ▼
                                          generate(ontology, 'all')
                              ┌──────────────┬──────────────┬──────────────┐
                              ▼              ▼              ▼
                        agent-code      prompts        manifest
                         (TS pkg)      (Markdown)    (JSON/process)
```

Numbered walk-through, from input documents to a published ontology:

1. **Upload** — `actionUpload` ([index.ts:499](api/ontology-gen/index.ts#L499)) receives `files[]` (base64-in-JSON for binary, or inline `text`). It throws `HttpError(400,'NO_FILES')` if `files[]` is missing/empty ([index.ts:504](api/ontology-gen/index.ts#L504)), silently `continue`s past any file lacking a string `name` ([index.ts:521](api/ontology-gen/index.ts#L521)), and throws `HttpError(400,'NO_PARSEABLE_FILES')` if zero sources were produced ([index.ts:533](api/ontology-gen/index.ts#L533)). If `body.ontologyId` is a string, it loads that existing ontology and seeds the per-batch `taken` set with `collectTakenIds(existing, existing.sourceDocuments)` ([index.ts:508](api/ontology-gen/index.ts#L508)) so newly-minted document ids cannot collide with the draft — but it never saves the attachment back (the existing ontology is read-only here). Each file passes through `ingestOne` ([index.ts:368](api/ontology-gen/index.ts#L368)).
2. **Parse & normalize** — `parseDocument` ([parse.ts:266](api/ontology-gen/parse.ts#L266)) decodes the bytes/text into whitespace-normalized plaintext, computes a content hash, and (for PDFs) a page map. `ingestOne` mints a deterministic document id, builds a `SourceDocument`, and persists a `ParsedSource` (the normalized text) to the store.
3. **Start a run** — `actionRunStart` ([index.ts:654](api/ontology-gen/index.ts#L654)) seeds an `OntologyRun` (status `pending`, one `StageProgress` per stage) plus an empty-layer draft `Ontology` produced by `buildOntology`, then overrides `buildOntology`'s derived name with the resolved user/sample name. Both are persisted together.
4. **Step through stages** — the client calls `run.step` repeatedly. Each call advances exactly **one** stage (`actionRunStep`, [index.ts:748](api/ontology-gen/index.ts#L748)): it rebuilds a `StageContext` from the persisted partial ontology + parsed text, runs `runStage`, reassembles the ontology, and persists.
5. **Per-stage pipeline** — `runStage` ([orchestrator.ts:109](api/ontology-gen/pipeline/orchestrator.ts#L109)) composes the deterministic sequence: enforce order → extract (one LLM call) → ground citations → drop ungrounded extracted nodes → score confidence → (events only) derive the Action↔Event inverse → merge → optional critique → validate.
6. **Resume / inspect** — `run.get` ([index.ts:823](api/ontology-gen/index.ts#L823)) is a pure read that rehydrates `{ run, ontology }` so a refreshed client never loses progress.
7. **Completion** — when all five `StageProgress` rows are `complete`, the run flips to `status='complete'`. The accumulated `Ontology` is the deliverable.
8. **Compile** — `generate(ontology, target)` ([generators/index.ts:34](api/ontology-gen/generators/index.ts#L34)) projects the finished ontology into agent code, prompts, and manifests.

---

## 2. What an ontology is — the canonical schema

The schema lives in [ontology-schema.ts](api/_shared/ontology-schema.ts), a **pure-types leaf** (no runtime, no relative imports) so both the bundler-resolved frontend (`src/`) and the NodeNext backend (`api/`) can consume it. The backend file is an auto-generated, byte-for-byte mirror of `src/ontology/schema/types.ts`.

### The envelope

`Ontology` is the unit of versioning, validation, publish, and import. Its envelope carries:

| Field | Meaning |
|---|---|
| `id` | stable kind-prefixed slug `ontology:<slug>` (used for all cross-refs) |
| `uuid` | globally-unique storage/Neo4j key, immutable across edits |
| `name`, `nameZh` | bilingual display name |
| `domain` | a `DomainKey` — ~18 domain keys (including 3 `*_native` variants) plus `generic` ([ontology-schema.ts:95](api/_shared/ontology-schema.ts#L95)). The schema's own line-94 comment ("The 10 target domains (+ generic fallback)") understates the actual union, which also includes `outsourced_recruitment`, `expense_control`, `contract_approval`, `inventory_erp`, and `hr_management`. |
| `version` | monotonic integer (bumped on save/publish, never inside `buildOntology`) |
| `schemaVersion` | `typeof SCHEMA_VERSION_NUMBER` (= `1`); kept in lockstep with `SCHEMA_VERSION` (`'1.0.0'`) |
| `status` | `'draft' | 'published'` |
| `confidence` | aggregate weighted mean (computed, never raw LLM) |
| `sourceDocuments` | `SourceDocument[]` — the citation targets |
| five layers + `relationships` + `ruleGroups` | the graph |
| `metadata` | `createdAt/By`, `history`, `stats`, `generation`, `danglingRefs?`, `stageCritiques?` |

### The five layers (+ relationships + ruleGroups)

Every first-class node carries **two identifiers**: a kind-prefixed slug `id` (used for ALL cross-references) and a `uuid` (storage key). The layers, in canonical order:

1. **ObjectType** (`objectType:`) — business entities. PascalCase `name` + required `nameZh`, `attributes: ObjectAttribute[]` (each with a closed `DataType`, `keyRole` of pk/fk/none; `enumValues` present iff `type==='enum'`; `refObjectTypeId` present iff `reference` or `fk`). Edges are first-class:
   - **Relationship** (`rel:`) — a top-level edge with a snake_case verb `name`, `sourceObjectTypeId`/`targetObjectTypeId`, `cardinality`, optional `viaAttribute` (the FK realizing it).
2. **Rule** (`rule:`) — `statement: Bilingual` (both langs required), always-present `formal` string, optional CEL `expression`, `kind` (validation/constraint/derivation/state_transition/authorization/temporal), `severity` (info/warn/block), `appliesToObjectTypeIds`, optional `trigger.onEventTypeId`, post-grouping `groupId?`. Also carries `title`/`titleZh`. Grouped into:
   - **RuleGroup** (`ruleGroup:`) — organizational only; `title: Bilingual`, `ruleIds[]`, optional `rationale`. Never deletes a rule or citation.
3. **ActionType** (`action:`) — the **agentic core**; each maps to a callable agent tool. Typed `inputs`/`outputs: ActionIO[]` (`objectTypeId` XOR scalar `type`), ordered `steps`, `preconditions: PreconditionRef[]`, `triggeredByEventIds`, `emitsEvents: EmitSpec[]`, optional `sideEffects`, `actor: ActorRef`, and `agent: AgentBinding` (`toolName`, JSON-Schema `parameterSchema`, `execution`).
4. **EventType** (`event:` with a **dotted** suffix, e.g. `event:order.fulfilled`) — `payload: EventField[]`, required `nameZh`, and the **derived** `producedByActionIds`/`consumedByActionIds` (the exact inverse of the actions' emits/triggers).
5. **Process** (`process:`) — `name: Bilingual`, `actors`, `objectTypeIds`, `steps: WorkflowStep[]` (each with a **process-scoped** id like `s1`, an `actionTypeId`, an `order`, optional `actorRole`, and `next: ProcessEdge[]`), `triggers`, `orchestration`.

### Per-node "receipts" (provenance spine)

Every extracted node carries the `NodeProvenance` base, inlined (not extended via an erased interface) so each shape is fully explicit:

- `sources: SourceRef[]` — the **spine of trust**. Each `SourceRef` holds `documentId` (must resolve to a `SourceDocument`), denormalized `documentName`, the VERBATIM `snippet`, plus backend-computed `page?`/`line?`/`charStart?`/`charEnd?`, `sentenceRefs?` (for rules), `quoteVerified?`, and per-citation `confidence?`. `quoteVerified?: boolean` ([ontology-schema.ts:188](api/_shared/ontology-schema.ts#L188); docstring at lines 183–187) is set by a **deterministic, whitespace-normalized backend substring check, never the model**.
- `confidence: Confidence` — a bare number in `[0,1]` (no named bands), computed by the rubric.
- `provenance: 'extracted' | 'inferred' | 'merged' | 'human'`.
- `derivedFrom?: string[]` — ids an inferred/merged node was derived from.
- `reviewState: ReviewStatus` — `pending` for all new nodes; gates what publishes.

### Cross-refs, bilingual fields, and STAGE_ORDER

- **Cross-references are always by `id`** (the slug), never `uuid`. `uuid` exists only for storage/Neo4j joins.
- **Bilingual** (`en` + `zh`) is mandatory on key names/statements/labels, produced in one extraction pass.
- **`STAGE_ORDER = ['objects','rules','actions','events','processes']`** ([ontology-schema.ts:58](api/_shared/ontology-schema.ts#L58)) is the canonical extraction order. **Order matters** because a later layer may only reference ids from earlier layers — objects must exist before rules can apply to them, actions before events can be wired to them, etc. The single intentional exception is that Actions and Events are co-discovered and may reference each other both ways (actions emit/are-triggered-by events; events derive their producer/consumer lists from actions).

---

## 3. Stage 0 — Ingestion & parsing

Stage 0 turns a raw upload into a normalized `ParsedSource` (whitespace-normalized plaintext + optional page map) plus a `SourceDocument` metadata record. It splits cleanly into a **pure decoder** ([parse.ts](api/ontology-gen/parse.ts)) and an **orchestration glue** ([index.ts](api/ontology-gen/index.ts)).

### parseDocument — pure, I/O-free decode + normalize

`parseDocument(input)` ([parse.ts:266](api/ontology-gen/parse.ts#L266)) takes `{ name, mime?, bytes?, text? }`. Format is sniffed by `detectFormat(name, mime)` ([parse.ts:119](api/ontology-gen/parse.ts#L119)): it returns the **first matching format in fixed branch order — pdf, docx, html, text** — and within each branch the mime and extension are an equal OR (e.g. line 122: `if (m.includes('pdf') || ext === 'pdf') return 'pdf'`). Extension and mime have equal weight inside a branch; **branch ordering, not mime priority, breaks ties** — so a file named `*.pdf` with an HTML mime resolves to `pdf` because the pdf branch is reached first. One of four branches produces `text`:

1. **Pre-decoded text** (when `input.text` is set and format is neither pdf nor docx): HTML runs `stripTags`, then `normalizeWhitespace`. This is the path sample-corpus Markdown takes.
2. **PDF**: `extractPdf(bytes)` drives `pdf-parse` with a custom per-page render hook, building a `pageMap` whose offsets land at exact, recomputable slices.
3. **DOCX**: `mammoth.extractRawText`, degrading to a lossy UTF-8 decode on any throw; no page map.
4. **Text/HTML-from-bytes** (the `else`): decode to UTF-8, optionally strip tags, normalize.

`normalizeWhitespace` ([parse.ts:88](api/ontology-gen/parse.ts#L88)) is the **offset substrate**: it canonicalizes line endings, strips BOM/zero-width chars, replaces non-breaking spaces (U+00A0) with regular spaces, collapses intra-line whitespace runs to a single space, strips leading (not just trailing) spaces per line, collapses 3+ newlines to one blank line, and trims. Crucially it **preserves newlines** — line structure is the sentence/paragraph signal that `numberSentences` and the chunker depend on, so "whitespace-normalized plaintext" still retains line breaks. It is **idempotent**, so two re-uploads of the same logical content produce byte-identical text and therefore an identical hash.

`parseDocument` then computes a `ParsedDocument`:
- `contentHash = 'sha256:' + sha256(normalized text)` — **hashed over the NORMALIZED text**, so identical content always re-keys to the same id (enabling de-dup).
- `ref = 'parsed_' + contentHash.slice(7,23)` (16 hex chars), `documentId = 'doc:' + slug` — these are filename/hash-derived **placeholders** the caller is expected to re-key. `kind` is hardcoded `'doc'`. Note: the placeholder slug here is produced by `parseDocument`'s **own local `slugify`** ([parse.ts:309](api/ontology-gen/parse.ts#L309)), which **strips the file extension** (`name.replace(/\.[a-z0-9]+$/i, '')`) and slices to 64 chars — a different rule from the shared `slugify` used for the authoritative id.

`parseDocument` is deliberately pure: no LLM, no store, no id-collision set. PDF/DOCX errors are swallowed into degraded best-effort output, never a throw.

### ingestOne — id minting, SourceDocument build, persistence

`ingestOne(store, taken, input)` ([index.ts:368](api/ontology-gen/index.ts#L368)) wraps the pure parser:

1. Calls `parseDocument`.
2. Mints the **authoritative** document id via `makeId('document', input.name, taken)` — keyed on the raw filename using the **shared** `slugify` ([ids.ts:60](api/_shared/ids.ts#L60)), which **preserves dots AND keeps the file extension** (e.g. `doc:order-fulfillment-sop.docx`), deduped against the per-batch `taken` set.
3. Takes `parsedRef` verbatim from the content-hash-derived `pd.ref`. **Note:** `SourceDocument.id` (name-derived, extension-retaining) and `parsedRef` (content-hash-derived) use **different keying schemes**, produced by **two distinct slugify functions** (the shared `ids.ts:60` keeps the extension; the local `parse.ts:309` drops it). The comment "re-key the parsed ref" is misleading; only `ParsedSource.documentId` is re-keyed to the authoritative `docId`.
4. Builds the `SourceDocument` (`sizeBytes` is the raw upload length when bytes were given, else the byte length of the normalized text; `pageCount: 0` → `undefined`).
5. Persists the `ParsedSource` via `store.putParsed`.

`ingestOne` returns `{ source, parsed }` ([index.ts:399](api/ontology-gen/index.ts#L399)). `actionUpload` destructures only `{ source }`, separately collecting `source.parsedRef` into a `parsedRefs[]` array, and responds with `{ sources, parsedRefs }` ([index.ts:537](api/ontology-gen/index.ts#L537)). That `parsedRefs[]` is exactly what `run.start` later consumes as `sourceIds`.

`makeId` ([ids.ts:88](api/_shared/ids.ts#L88)) builds `PREFIXES[kind] + slugify(name)`, returns it if free, else appends `-2`, `-3`, … until unused, mutating the `taken: Set<string>` in place. This determinism is what makes re-runs and Neo4j `MERGE` idempotent.

`actionUpload` persists `ParsedSource` rows but does **not** create or save any Ontology — the `SourceDocument`s and `parsedRefs` live only in the response until a run consumes them. The same parsed store is later (ab)used to stash the in-progress run ontology (see §4).

### actionParse — idempotent re-lookup (not a re-parse)

`actionParse` ([index.ts:545](api/ontology-gen/index.ts#L545)) does **not** re-run `parseDocument` despite its name. It reads `body.parsedRefs` and `body.sourceIds` (both filtered to strings) and, for each, calls `store.getParsed(ref)`/`store.getParsed(sid)`, pushing hits and tolerating every miss. It treats `sourceIds` as parsed refs directly (`store.getParsed(sid)` — there is no source table) and responds `ok(res, { parsed })`. No parsing, hashing, or id-minting occurs.

---

## 4. The run lifecycle

A run is a **client-paced, one-stage-at-a-time** ledger. The `OntologyRun` is the authoritative record of which stages completed; the `Ontology` carries the accumulated node data.

### run.start — seeding

`actionRunStart` ([index.ts:654](api/ontology-gen/index.ts#L654)) seeds from **either** a bundled sample corpus (`sampleId`, ingesting every `.md` under the corpus dir) **or** already-uploaded sources (`sourceIds`, treated as `parsedRefs` directly — there is no source table). Domain is validated against `DOMAIN_KEYS` and falls back to `'generic'`. It then builds an empty-layer draft via `buildOntology` over a `seedCtx` with all five layer arrays empty and `parsed: []` (no parsed text is needed to build the envelope). It then **overrides** `buildOntology`'s derived name: `ontology.name = name.en; ontology.nameZh = name.zh` ([index.ts:733](api/ontology-gen/index.ts#L733)), where `name` comes from `body.name` (a `Bilingual`, defaulting to `'Untitled Ontology'`/`'未命名本体'`, [index.ts:658](api/ontology-gen/index.ts#L658)) or, for a sample run still at the default, from the sample def's label ([index.ts:683](api/ontology-gen/index.ts#L683)). `freshRun(runId, ontologyId)` ([index.ts:596](api/ontology-gen/index.ts#L596)) returns a run with `status:'pending'`, `currentStage:null`, and exactly one `StageProgress` per stage in `STAGE_ORDER`. Both are persisted via `persistRunState`. Response: `{ ok, run, ontology }`.

### The partial-ontology stash

There is **no dedicated column** for the in-progress ontology. `persistRunState` ([index.ts:620](api/ontology-gen/index.ts#L620)) bumps `run.updatedAt = nowIso()` ([index.ts:621](api/ontology-gen/index.ts#L621)), writes the run, then stashes the entire serialized `Ontology` as a `ParsedSource`-shaped row `{ ref: 'run_ontology:<runId>', documentId: run.id, text: JSON.stringify(ontology) }` ([index.ts:625](api/ontology-gen/index.ts#L625)) — its `documentId` is the runId. This needs no schema migration and works identically on in-memory, file, and Supabase stores. `loadRunState` ([index.ts:632](api/ontology-gen/index.ts#L632)) is the inverse and tolerates every miss (no run, no stash, bad JSON → `null`). The `run_ontology:` prefix is disjoint from the content-addressed `parsed_<hash>` refs, so namespaces never collide.

### run.step — advancing exactly one stage

`actionRunStep` ([index.ts:748](api/ontology-gen/index.ts#L748)):

1. If `run.status === 'complete'`, short-circuit (idempotent terminal).
2. Defensive all-complete branch: if `findIndex(s => s.status !== 'complete')` returns `nextIdx < 0` (all stages already complete but the run not yet flagged), set `run.status='complete'`, `run.currentStage=null`, persist, and return **before** rebuilding context or calling `runStage` ([index.ts:766](api/ontology-gen/index.ts#L766)).
3. Otherwise select the next stage as the **first non-complete** stage. Because the predicate is `!== 'complete'`, a stage in `'error'` status is **re-selected and retried** on the next step.
4. Set `run.status='running'`, `run.currentStage=stage`, log `[<stage>] starting`.
5. Rebuild `ctx = contextFromOntology(store, ontology, undefined, …)` (undefined parsedRefs = use all sources).
6. `result = await runStage(stage, ctx)`.
7. Merge: replace the `StageProgress` row at `nextIdx` ([index.ts:787](api/ontology-gen/index.ts#L787)) — on the error path this row carries the `error` string and a partial `count`, and is exactly what makes the next step re-select the same stage — reassemble `rebuilt = carryMetadata(buildOntology(ctx), ontology)`, recompute `metadata.danglingRefs`, and store the critique.
8. Resolve status: on `result.progress.status === 'error'` → `run.status='error'` (but `currentStage` is left pointing at the failed stage); otherwise if no stages remain → `complete` + `currentStage=null`, else stays `running`.
9. `persistRunState`. Response: `{ ok, run, ontology }`.

`metadata.danglingRefs` is populated by `collectDangling` ([index.ts:1087](api/ontology-gen/index.ts#L1087)), which filters to **only** `dangling_ref` issues that have both `field` and `missingId` set, emitting `{from, field, missingId}` triples — not all validation issues.

### Context rebuild & carry-forward

`contextFromOntology` ([index.ts:411](api/ontology-gen/index.ts#L411)) reconstructs a `StageContext`, resolving each source's `parsedRef` via `store.getParsed` (silently dropping misses) and seeding `taken = collectTakenIds(ontology, sources)` with **every existing id** so a stage re-mint can never collide. `carryMetadata` ([index.ts:470](api/ontology-gen/index.ts#L470)) is **mandatory** on every rebuild because `buildOntology` is pure and always mints a fresh `uuid` + `version 1`. Its copies are **guarded**, not unconditional: only `uuid` is copied unconditionally; the rest fall back to the freshly-built value when the prior is missing — `next.name = prev.name || next.name`, `next.nameZh = prev.nameZh ?? next.nameZh`, `next.version = prev.version || next.version`, and `createdAt`/`createdBy`/`history` each via `prev.metadata?.X ?? next.metadata.X` ([index.ts:472](api/ontology-gen/index.ts#L472)). (Confidence/stats/generation are recomputed fresh; only identity + history are carried.)

### run.get and single-stage re-runs

`run.get` ([index.ts:823](api/ontology-gen/index.ts#L823)) is a pure GET that returns `{ run, ontology }` verbatim — the resume primitive.

`stage.<x>` ([actionStage, index.ts:837](api/ontology-gen/index.ts#L837)) is a **run-less** single-stage re-run against an inline `body.ontology` draft. Because `runStage` replaces the layer wholesale, re-invoking it regenerates that one layer idempotently. It returns only that stage's items (`stage.objects` also returns `relationships`; `stage.rules` also returns `ruleGroups`), the stage-scoped validation issues, and the log.

### Status transitions

```
pending ──run.step──► running ──(more stages)──► running
                         │                          │
                         │ (last stage done)        │ (stage fails)
                         ▼                          ▼
                      complete                    error ──run.step──► running (retries same stage)
```

---

## 5. The orchestrator's per-stage pipeline

Every stage passes through the same deterministic composition in `runStage` ([orchestrator.ts:109](api/ontology-gen/pipeline/orchestrator.ts#L109)). `assertStageOrder` runs **first, outside the try/catch** — it is the only thing that can throw out of `runStage`. Everything else degrades to an error-status `StageProgress` (which additionally stamps an `error: errText(err)` field, [orchestrator.ts:153](api/ontology-gen/pipeline/orchestrator.ts#L153); the success-path `StageProgress` omits `error`).

| # | Step | What happens | Code |
|---|------|--------------|------|
| 0 | **assert order** | `assertStageOrder` verifies prior layers are "ready" (positional proxies). Throws `STAGE_OUT_OF_ORDER`. | [orchestrator.ts:183](api/ontology-gen/pipeline/orchestrator.ts#L183) |
| 1 | **extract** | The pure `extract*` stage makes ONE LLM call, returns raw nodes with raw self-confidence and unverified `sources[].snippet`. | stages/*.ts |
| 2 | **ground** | `groundSources(layer, ctx.parsed)` locates each verbatim snippet, mutating `charStart/charEnd/line/page/quoteVerified` in place. | [ground.ts:256](api/ontology-gen/pipeline/ground.ts#L256) |
| 3 | **drop ungrounded** | `dropUngroundedNodes` removes only `extracted` nodes with ZERO citations; inferred/merged/human survive. | [ground.ts:302](api/ontology-gen/pipeline/ground.ts#L302) |
| 4 | **confidence** | `score*Confidence` overwrites each node's raw rating with the locked rubric output. | [confidence.ts:254](api/ontology-gen/pipeline/confidence.ts#L254) |
| 5 | **(events only) derive inverse** | `deriveEventInverse(ctx.actions, keptEvents)` overwrites `producedByActionIds`/`consumedByActionIds` from the actions side, BEFORE scoring. | [orchestrator.ts:355](api/ontology-gen/pipeline/orchestrator.ts#L355) |
| 6 | **merge** | `ctx.<layer> = kept…` — wholesale **replacement** (idempotency). | [orchestrator.ts:263](api/ontology-gen/pipeline/orchestrator.ts#L263) |
| 7 | **critique** | `runCritique` — optional, read-only LLM QA summary; never mutates. | [orchestrator.ts:495](api/ontology-gen/pipeline/orchestrator.ts#L495) |
| 8 | **validate** | `issues = validateOntology(buildOntology(ctx))` — returned on both success and error paths. | [orchestrator.ts:159](api/ontology-gen/pipeline/orchestrator.ts#L159) |

`assertStageOrder` keys off positional proxies via `priorLayerReady` ([orchestrator.ts:212](api/ontology-gen/pipeline/orchestrator.ts#L212)), because non-object layers may legitimately be empty after running: `objects`-ready ⇔ `ctx.objects.length>0`; `rules`-prereq satisfied once objects exist; `actions`-ready ⇔ `ctx.actions.length>0`; `events`-prereq satisfied once actions exist; `processes` always ready. The validator's `stage_order_violation` is the authoritative backstop for true forward references.

The `applyObjects` step is the richest, because it co-produces relationships and **cascade-prunes**: a relationship is dropped if either endpoint object was dropped ([orchestrator.ts:249](api/ontology-gen/pipeline/orchestrator.ts#L249)) — this filter is applied to the output of `dropUngroundedNodes(relationships)`, restricting survivors to relationships whose **both** endpoints survived the object drop ([orchestrator.ts:250](api/ontology-gen/pipeline/orchestrator.ts#L250)). `applyRules` similarly prunes rule-group membership down to surviving rules. Cross-ref integrity sets used for scoring are always built from the **post-merge** prior layers.

### Critique

`runCritique` ([orchestrator.ts:495](api/ontology-gen/pipeline/orchestrator.ts#L495)) reviews the freshly-merged layer via the QA prompt and **cannot itself degrade the stage to an error**: it has its own internal try/catch ([orchestrator.ts:518](api/ontology-gen/pipeline/orchestrator.ts#L518)), so a critique LLM error or unparsable response is swallowed there, returns `undefined`, and the stage still completes with `status:'complete'`, `critique=undefined`. Critique is also skipped entirely (returning `undefined`) when the merged layer is empty ([orchestrator.ts:497](api/ontology-gen/pipeline/orchestrator.ts#L497)). The critique LLM call uses **temperature 0, maxTokens 4000** ([orchestrator.ts:511](api/ontology-gen/pipeline/orchestrator.ts#L511)) — lower than the extraction stages' 0.1 — with `module:'ontology_generator'` and `actionName:'ontology_critique_<stage>'`; it is the orchestrator's only direct LLM call. For the objects stage, `currentLayerItems` returns **both** objects and relationships ([orchestrator.ts:638](api/ontology-gen/pipeline/orchestrator.ts#L638)), so the objects-stage critique reviews relationships too (the `stageCount`, by contrast, is objects-only, [orchestrator.ts:656](api/ontology-gen/pipeline/orchestrator.ts#L656)). When the model omits a non-empty `summary`, it falls back to `"<N> issue(s) flagged"` (if issues present) or `"no issues found"`, and logs `[<stage>] critique: N issue(s) — <summary>` ([orchestrator.ts:526](api/ontology-gen/pipeline/orchestrator.ts#L526)). `parseCritiqueJson` ([orchestrator.ts:542](api/ontology-gen/pipeline/orchestrator.ts#L542)) strips ```` ``` ````/```` ```json ```` fences, slices from the first `{` to the last `}`, `JSON.parse`s, and returns `null` on any failure or non-object result.

So only failures that escape `runCritique`'s internal catch hit the outer catch — in practice extraction/merge/derive errors, not critique.

---

## 6. The five extraction stages

Each `extract*` stage is **pure extract**: it reads sources/parsed + prior layers, makes exactly **one** LLM call via `executeLLMWithTracking`, defensively parses untrusted JSON, mints deterministic ids, stamps `provenance:'extracted'`/`reviewState:'pending'` and a RAW confidence, sets verbatim `sources[].snippet`, and returns ONLY its own layer. Stages never ground offsets, never set `quoteVerified`, never apply the rubric, and never mutate prior-layer arrays — the orchestrator does all of that afterward. All prompt builders live in [prompts.ts](api/ontology-gen/prompts.ts), a zero-import leaf; every extraction system prompt is `role preamble + SHARED_RULES + stage guidance + inlined OUTPUT CONTRACT + SELF_CHECK (+ optional stage-specific extra self-check bullets)`. Only `buildObjectsPrompt` ends exactly at `${SELF_CHECK}`; Rules, Actions, Events, and Processes each append additional per-stage checklist bullets **after** the shared block ([prompts.ts:263](api/ontology-gen/prompts.ts#L263), [prompts.ts:362](api/ontology-gen/prompts.ts#L362), [prompts.ts:429](api/ontology-gen/prompts.ts#L429), [prompts.ts:513](api/ontology-gen/prompts.ts#L513)). The `SHARED_RULES` encode the 8 non-negotiables (JSON-only, extract-not-invent, mandatory verbatim citations, kind-prefixed slug ids, mandatory bilingual, honest confidence, closed vocabularies, silent self-check).

The prompt builders are **config-agnostic** — the prompts.ts header (lines 22–23) states "the caller owns model/maxTokens/temperature," so each stage caller owns its own LLM config (all at temperature 0.1): objects 16000 ([objects.ts:274](api/ontology-gen/pipeline/stages/objects.ts#L274)), rules 28000 ([rules.ts:111](api/ontology-gen/pipeline/stages/rules.ts#L111)), actions `MAX_TOKENS=24000` ([actions.ts:80](api/ontology-gen/pipeline/stages/actions.ts#L80)), events 12000 ([events.ts:236](api/ontology-gen/pipeline/stages/events.ts#L236)), processes 8000 ([processes.ts:113](api/ontology-gen/pipeline/stages/processes.ts#L113)).

### Stage 1 — Objects (+ relationships)

**Context:** reads `ctx.parsed` (loops per chunk), `ctx.sources` (for a `docId→name` map), `ctx.taken`. Reads no prior layer (it is first). **Prompt:** `buildObjectsPrompt` ([prompts.ts:114](api/ontology-gen/prompts.ts#L114)) frames an enterprise data architect, demands `{ objects:[…], relationships:[…] }`, business entities only (a "Refund" is usually an action, not an object), with closed `DataType`/`keyRole`/`cardinality` vocabularies. **LLM:** temp 0.1, maxTokens 16000, one call **per parsed source**, fault-tolerant (a failed chunk logs and `continue`s; chunks whose text is empty/whitespace-only are skipped before any LLM call, [objects.ts:257](api/ontology-gen/pipeline/stages/objects.ts#L257)). **Post-processing** ([objects.ts](api/ontology-gen/pipeline/stages/objects.ts)): defensive `parseObjectsJson`, coercion helpers (unknown DataType→`string`, unknown keyRole→`none`, unknown cardinality→`many_to_many`), `mapSources` (drops citations with no snippet; always sets `documentId` to the chunk's own), `mapAttributes` (enforces enumValues-iff-enum, refObjectTypeId-iff-reference-or-fk). Objects with an empty/whitespace-only `name` are skipped ([objects.ts:293](api/ontology-gen/pipeline/stages/objects.ts#L293)); relationships missing a verb or either resolved endpoint are skipped ([objects.ts:364](api/ontology-gen/pipeline/stages/objects.ts#L364)). `nameZh`/`description` go through the lenient `str()` helper and **can be empty** — Stage 1 does not enforce the schema's required-`nameZh`/bilingual invariant at extraction time; optional fields (`descriptionZh`, `display.emoji/color`, relationship `nameZh`/`viaAttribute`/`description`) are set only when non-empty via `optStr`. **Provenance/cross-ref:** mints `objectType:`/`rel:` ids (relationship id from the slug of `${source}-${verb}-${target}`, [objects.ts:378](api/ontology-gen/pipeline/stages/objects.ts#L378)); de-dupes objects by lowercased name and relationships by `source|verb|target` signature (union sources, keep max confidence). **Critically**, on a cross-chunk object dedup, attributes from a later chunk are adopted **only if** the later chunk supplies a non-empty list AND the existing object currently has zero attributes ([objects.ts:307](api/ontology-gen/pipeline/stages/objects.ts#L307)) — i.e. the **first chunk to provide any attributes wins**, and subsequent chunks' attributes for that object are silently discarded (never merged/unioned). Relationship endpoints resolve **intra-chunk only** via a per-chunk map keyed by **both** the model's emitted object id and the lowercased object name; `resolveEndpoint` ([objects.ts:350](api/ontology-gen/pipeline/stages/objects.ts#L350)) tries the raw string first, then the name lookup — so the model may wire endpoints by id or by name. Unresolved endpoints pass through as raw strings and are pruned later by the orchestrator.

### Stage 2 — Rules (+ rule groups)

**Context:** reads `ctx.objects` (the stage-1 vocabulary, both as an `objectIds` validation set and a slim `{id,name,nameZh}` projection), `ctx.parsed`, `ctx.sources`. **Citation spine:** `numberSentences` ([rules.ts:166](api/ontology-gen/pipeline/stages/rules.ts#L166)) flattens all sources into a **globally 1-based, continuous** sentence list (splitting on sentence-final punctuation incl. CJK `。！？；` and hard breaks); each sentence carries `documentId`/`documentName`, but the projection handed to the prompt is reduced to `{ idx, text }` only ([rules.ts:95](api/ontology-gen/pipeline/stages/rules.ts#L95)). The model therefore cites a single integer `idx` per sentence and is **not told which document each sentence came from**; it still receives one corpus-level `DOCUMENT NAME` header (`buildRulesPrompt` user prefix, [prompts.ts:266](api/ontology-gen/prompts.ts#L266); `docName = primaryDocName(ctx)` = the first source's name, [rules.ts:476](api/ontology-gen/pipeline/stages/rules.ts#L476)). The owning `documentId`/`documentName` are reattached backend-side from the **first cited sentence** (`cited[0]?.documentName`/`documentId`, [rules.ts:345](api/ontology-gen/pipeline/stages/rules.ts#L345)), with `documentName` ultimately falling back to the primary doc name and `documentId` to an empty string `''` — this is the multi-document attribution mechanism. **Prompt:** `buildRulesPrompt` ([prompts.ts:199](api/ontology-gen/prompts.ts#L199)) demands each rule three ways (bilingual `statement`, always-present `formal`, optional CEL `expression`), `appliesToObjectTypeIds` from prior objects only, kind/severity enums. **LLM:** temp 0.1, maxTokens 28000, one call. **Post-processing** ([rules.ts](api/ontology-gen/pipeline/stages/rules.ts)):
- `buildRule` drops rules with no statement in either language (zh-only rules set `en = zh`); unknown `kind`→`constraint`, unknown `severity`→`warn`; `appliesToObjectTypeIds`/`appliesToAttributes`(prefix)/`expression.bindings` validated against `objectIds` (invented ids silently dropped); `coerceSources` reconstructs a snippet by joining cited sentence texts when the model omits the quote, and **skips** any citation that ends with no snippet and no resolvable `sentenceRefs` ([rules.ts:343](api/ontology-gen/pipeline/stages/rules.ts#L343)).
- The rule `id` is minted from the **title**, not the statement: `makeId('rule', title, ctx.taken)` ([rules.ts:261](api/ontology-gen/pipeline/stages/rules.ts#L261)), where `title = str(raw.title) || firstClause(en)` (`firstClause` clips to ~60 chars). `titleZh` is set iff a zh statement exists. The rule `uuid` is **deterministic**: `` `${id}#${ctx.ontologyId}` `` ([rules.ts:262](api/ontology-gen/pipeline/stages/rules.ts#L262)) — unlike the envelope's `randomUUID()`.
- `coerceTrigger` returns `undefined` unless a `description` string is present (the optional `onEventTypeId` alone is not enough); `coerceExpression` returns `undefined` unless a `predicate` is present, and always stamps `dialect:'cel'`.
- Rules are **not** de-duplicated in this stage (unlike Stage-1 objects); collisions are resolved only by `makeId`'s `-2`/`-3` suffixing. Five short-circuits all return `{ rules:[], ruleGroups:[] }`: no source text/sentences ([rules.ts:78](api/ontology-gen/pipeline/stages/rules.ts#L78)), LLM failure ([rules.ts:116](api/ontology-gen/pipeline/stages/rules.ts#L116)), unparseable JSON ([rules.ts:122](api/ontology-gen/pipeline/stages/rules.ts#L122)), no rules returned ([rules.ts:128](api/ontology-gen/pipeline/stages/rules.ts#L128)), no rules surviving normalization ([rules.ts:150](api/ontology-gen/pipeline/stages/rules.ts#L150)).
- **Clustering** ([rules.ts:377](api/ontology-gen/pipeline/stages/rules.ts#L377)) assigns every rule to exactly one `RuleGroup` via a three-tier precedence: explicit model groups → per-rule `groupId` hints → deterministic shared-object fallback (the `addGroup` helper guards against double-assigning a rule across tiers via an `assigned` set; every rule lands in a group; `__ungrouped__`→"General Rules").

### Stage 3 — Actions

**Context:** reads `ctx.objects` (slim `{id,name,nameZh}`), `ctx.rules` (slim `{id,title,statement,severity}` + a severity map), and the concatenated parsed text (all sources joined by `\n\n---\n\n` — a single blob, unlike Stage 1's per-chunk loop). **Prompt:** `buildActionsPrompt` ([prompts.ts:283](api/ontology-gen/prompts.ts#L283)) frames each action as a future callable agent tool. **LLM:** temp 0.1, maxTokens 24000, one call. **Post-processing** ([actions.ts](api/ontology-gen/pipeline/stages/actions.ts)):
- **Name:** `name = asString(r.name) || asString(asRecord(r).id)` ([actions.ts:566](api/ontology-gen/pipeline/stages/actions.ts#L566)) — falls back to the model's `id`; an action with no usable name is skipped.
- `coerceIO` ([actions.ts:191](api/ontology-gen/pipeline/stages/actions.ts#L191)) resolves IO in branch order: (1) a known `objectTypeId` is used; (2) **else if** the model gave a valid scalar `DataType`, that scalar is used (so an unknown `objectTypeId` paired with a valid scalar yields the **scalar**, not `reference`); (3) else an `objectTypeId` that was present but unknown, with no scalar → `type='reference'`; (4) neither present → `type='json'`. Never a dangling ref.
- `coercePreconditions` ([actions.ts:257](api/ontology-gen/pipeline/stages/actions.ts#L257)) keeps only ruleIds present in `ctx.rules`, copies the **authoritative** rule severity (the model value is used only if a valid `SEVERITY_SET` member, else `'block'`), and de-duplicates ruleIds via a `seen` set so each rule appears at most once.
- Steps: `readsObjectTypeIds`/`writesObjectTypeIds` filtered to known objects; a step's `order` defaults to its array index+1 when the model omits a finite numeric order ([actions.ts:227](api/ontology-gen/pipeline/stages/actions.ts#L227)); `callsActionTypeId` only to an action minted **earlier in this pass** (no forward/self refs); `guardRuleId` only to a known rule.
- **Source coercion** ([actions.ts:481](api/ontology-gen/pipeline/stages/actions.ts#L481)): unlike Stage 1's `mapSources`, Stage 3 does **not** force `documentId` — it takes it verbatim from the model via `asString(r.documentId)` (which can be `''`) and only defaults `documentName` to the primary doc name; citations with no snippet are dropped. This asymmetry matters downstream because `groundSources` indexes by `documentId`.
- **Event wiring:** `triggeredByEventIds` and `emitsEvents` mint **dotted `event:` ids now** via `mintEventId` ([actions.ts:278](api/ontology-gen/pipeline/stages/actions.ts#L278)): a raw ref with no dot is prefixed `${ctx.domain}.`, an empty ref becomes `${ctx.domain}.occurred`, then `makeId('event', …)` prepends `event:` and dedupes against `ctx.taken`. The `eventIdCache` is keyed on the **raw** ref string, so `'event:order.fulfilled'` and `'order.fulfilled'` do **not** converge — only byte-identical raw refs do. `EmitSpec.on` is coerced against `{success,failure,always}`, defaulting to `'success'`, and an optional `condition` is preserved.
- **Actor:** `coerceActor` ([actions.ts:347](api/ontology-gen/pipeline/stages/actions.ts#L347)) defaults `role` to `'System'` and `kind` to `'system'` (from `human|agent|system`) when the model output is invalid/missing.
- **Agent binding:** `parameterSchema` is **always derived from the coerced inputs** (`deriveParameterSchema`), never taken from the model, so the tool signature can never drift from the action signature; `toolName` is snake_cased and globally deduped under a `tool:` namespace.

### Stage 4 — Events

A **deterministic reconciliation** stage. **Context:** reads `ctx.actions` for all node/wiring data, plus `ctx.sources[0]?.name` for the prompt `docName` ([events.ts:202](api/ontology-gen/pipeline/stages/events.ts#L202)) and the usual LLM/infra fields (`ctx.model`/`ctx.provider`/`ctx.userInfo`/`ctx.log`). It does **not** read `ctx.parsed`, `ctx.objects`, `ctx.rules`, or `ctx.events`. It defines exactly one `EventType` per unique event id referenced by the actions (union of `emitsEvents[].eventTypeId` and `triggeredByEventIds`), in first-seen order, reusing the action-minted `event:<dotted>` id verbatim. **LLM:** a single **best-effort enrichment** call (`enrichViaLlm`, temp 0.1, maxTokens 12000) whose only job is to fill `nameZh`/`description`/`payload` and supply an optional grounding snippet — it never owns ids, wiring, or provenance. If no action references any event, the LLM call is skipped entirely. **Classification** ([events.ts:147](api/ontology-gen/pipeline/stages/events.ts#L147)): model provenance is honored only as a **negative** hint — `hasSource = Boolean(snippet) && provenance !== 'inferred'` ([events.ts:262](api/ontology-gen/pipeline/stages/events.ts#L262)); a model `'extracted'` label is irrelevant, and only a self-label of `'inferred'` (with a snippet present) can suppress grounding. An `extracted` event gets `clampConfidence(enr?.confidence, SKELETON_CONFIDENCE=0.55, 1)` ([events.ts:172](api/ontology-gen/pipeline/stages/events.ts#L172)); an `inferred` event (with `derivedFrom` = referencing action ids and empty `sources`) gets `clampConfidence(enr?.confidence, 0.55, INFERRED_CONFIDENCE_CAP=0.6)` ([events.ts:173](api/ontology-gen/pipeline/stages/events.ts#L173)) — i.e. when the model omits a numeric confidence the fallback is **0.55** for both branches, and the inferred cap is 0.6. Grounded (`extracted`) events emit a `sources[]` entry whose `documentId` is the **empty string** ([events.ts:163](api/ontology-gen/pipeline/stages/events.ts#L163)), with the snippet/`documentName`/section/page taken verbatim from the model and **never grounded against `ctx.parsed` in this stage** — grounding (offsets/`quoteVerified`/page) is left entirely to the orchestrator's later `groundSources` pass, and the empty `documentId` means that index-by-`documentId` may not match. `name = eventNameFromId(id)` (the dotted suffix after `event:`); `nameZh` falls back to that same dotted name. Payload is model-first (`resolvePayload`, [events.ts:290](api/ontology-gen/pipeline/stages/events.ts#L290)), else inferred from **emitting** actions' outputs only (`inferPayloadFromEmitters`, [events.ts:300](api/ontology-gen/pipeline/stages/events.ts#L300)): object-valued outputs become `type:'reference'` fields carrying `objectTypeId`, scalar outputs keep their `DataType` only if `isDataType` passes, fields de-duped by name (first emitter wins). Node `uuid` is a local `Math.random()`-based `makeUuid()` ([events.ts:361](api/ontology-gen/pipeline/stages/events.ts#L361)) — non-deterministic and not cryptographically random, deliberately avoiding a crypto dependency. `pushUnique` de-dupes action ids within each producer/consumer list and `emitterActions` de-dupes emitting actions by id. The stage builds its own producer/consumer lists, but the orchestrator immediately **overwrites** them via `deriveEventInverse`.

### Stage 5 — Processes

**Context:** reads `ctx.actions` (slim, incl. event wiring + IO), `ctx.events` (slim, incl. the precomputed inverse), `ctx.objects` (slim). Hard-gated: returns `{processes:[]}` if there are no actions. **Prompt:** `buildProcessesPrompt` ([prompts.ts:446](api/ontology-gen/prompts.ts#L446)) asks the model to chain actions along event producer→consumer links into a step-graph. **LLM:** temp 0.1, maxTokens 8000, one call. **Post-processing** ([processes.ts](api/ontology-gen/pipeline/stages/processes.ts)) in `normalizeProcess`:
- Steps whose `actionTypeId` does not resolve to a real prior action are **dropped**; a process with zero surviving steps is discarded.
- Step ids are rewritten to **process-local** sequential slugs (`s1`, `s2`, …); the model's original ids are remap keys only. Each step is stamped `order = typeof src.order === 'number' ? src.order : i+1` ([processes.ts:220](api/ontology-gen/pipeline/stages/processes.ts#L220)) — the model's numeric order wins, else the 1-based index.
- **`actorRole`** ([processes.ts:215](api/ontology-gen/pipeline/stages/processes.ts#L215)): the model's `actorRole` is kept only if it is already one of the process actors; otherwise it falls back to the contributing action's own actor role, again only if that role is in the process actor list. It is set on the step only when truthy.
- Edges gated ([processes.ts:308](api/ontology-gen/pipeline/stages/processes.ts#L308)): `toStepId` remapped to a real local step (dangling/duplicate dropped); `onEventTypeId` kept only if it resolves to a real event (else stripped → unconditional edge); an optional `condition` string and optional Bilingual `label` are copied through.
- `objectTypeIds` = order-preserving dedup of (model-supplied ∩ objectIds) ∪ (objects the chained actions read/write).
- **Triggers** (`normalizeTriggers`, [processes.ts:320](api/ontology-gen/pipeline/stages/processes.ts#L320)): kept only when `kind ∈ {event,manual,schedule}`; for `event` the `eventTypeId` is kept only if it resolves to a real event; for `schedule` the `schedule` is kept only if present; an optional `description` is copied.
- **Orchestration** (`normalizeOrchestration`, [processes.ts:345](api/ontology-gen/pipeline/stages/processes.ts#L345)): never null (defaults `strategy:'sequential'`, `agentOrchestrated:true`); `strategy` validated against `{sequential,event_driven,state_machine}`; `onFailure` kept only if in `{halt,compensate,escalate}`; `agentRoles` kept only for entries with a non-empty `role`.
- **Sources:** built via `asSources(rp.sources)` ([processes.ts:256](api/ontology-gen/pipeline/stages/processes.ts#L256)), which keeps any model-provided `SourceRef` with a non-empty verbatim `snippet` — so a synthesized process **can** carry model-supplied citations, despite the stage header comment that states `sources:[]`.
- Provenance forced to `'inferred'`, `derivedFrom` = deduped resolved step actionTypeIds. `actors` never empty (injects a `System` actor).

---

## 7. Grounding

Grounding ([ground.ts](api/ontology-gen/pipeline/ground.ts)) is a **pure, deterministic, LLM-free** post-extraction pass. `groundSources(nodes, parsed)` ([ground.ts:256](api/ontology-gen/pipeline/ground.ts#L256)) is **generic** over node shape (`groundSources<T extends GroundableNode>`, requiring only an optional `sources?: SourceRef[]`); a node with `sources` undefined is skipped, not an error. It builds a per-source `SourceIndex` **once** per `ParsedSource` (indexed by `documentId`, last-wins on dup) and reuses it across every citation of that document, making grounding ~O(N·text) rather than re-scanning per citation. Each index carries a normalized projection, a `normToOrig` back-pointer map, and a precomputed `lineStarts` array used for deterministic 1-based line numbers via binary search (`lineForOffset`). For each `SourceRef`, `locate(idx, snippet)` ([ground.ts:177](api/ontology-gen/pipeline/ground.ts#L177)) runs a three-tier cascade:

1. **Exact substring** in the original text → `verified: true` (case- and whitespace-sensitive).
2. **Whitespace-normalized substring** (lowercased, collapsed), offsets translated back to original via `normToOrig` → `verified: true`. The end offset is `normToOrig[lastNormIdx] + 1` (an exclusive end into the **original** text), and a collapsed space maps to the first original char of the following token, keeping offsets monotonic and inside the original text.
3. **Token-window Jaccard ≥ 0.8** fuzzy match → sets offsets but `verified: false`. The Jaccard is over token **sets** (presence, multiplicity-insensitive — de-duped via `Set`), scanned only at the exact snippet-token-count window size, keeping the best score ≥ 0.8. Skipped entirely for sources > 4000 tokens (a fuzzy match is non-verifying anyway).

`quoteVerified` is true **IFF** a tier-1 or tier-2 match was found, and the grounder is its **sole** computer (`ref.quoteVerified = hit.verified`, [ground.ts:287](api/ontology-gen/pipeline/ground.ts#L287)). On a hit, `charStart`/`charEnd`/`line` are written (offsets are into the **original** text — note this diverges from the schema docstring that calls them "normalized" offsets), and `page` is written only if a `pageMap` resolves; `pageForOffset` ([ground.ts:149](api/ontology-gen/pipeline/ground.ts#L149)) uses a two-pass fallback: first the page strictly containing the match start, else the page with the greatest span overlap. On a **miss**, only `quoteVerified=false`, `charStart=undefined`, and `charEnd=undefined` are reset ([ground.ts:269](api/ontology-gen/pipeline/ground.ts#L269)); `line` and `page` are **not** cleared — so on a re-ground of a previously-grounded ref that now misses, stale `line`/`page` survive (for a fresh ref they are already undefined).

`dropUngroundedNodes` ([ground.ts:302](api/ontology-gen/pipeline/ground.ts#L302)) is **pure** — it returns a **new filtered array** via `nodes.filter(...)` and does not mutate its input (in contrast to `groundSources`, which mutates in place). It is generic over `DroppableNode` (additionally requiring `provenance` + optional `derivedFrom`) and is intentionally **lenient**: it keeps every node whose `provenance !== 'extracted'` (inferred/merged/human survive via `derivedFrom`/human authorship), and keeps any `extracted` node with **≥1 citation of any kind** — it drops only extracted nodes with **zero** citations. An unverified/fuzzy citation is **flagged** (`quoteVerified=false`, confidence downgraded for human review), never silently removed. The comment is explicit: dropping strictly on `quoteVerified===true` "nuked entire rule/action layers whenever the model paraphrased a quote" — wrong for a human-in-the-loop product. (Relationship cascade-pruning — keeping only relationships whose both endpoints survived — happens at the orchestrator level on the output of this drop pass; see §5.)

---

## 8. Confidence scoring

`scoreConfidence(node, signals, schemaCompleteness)` ([confidence.ts:254](api/ontology-gen/pipeline/confidence.ts#L254)) computes a **locked multiplicative product**, clamped to `[0,1]`:

```
final = clamp01( base × grounding × agreement × integrity × schemaBonus )
```

| Factor | Source | Behavior |
|---|---|---|
| **base** | self-rating (untrusted) | neutral prior 0.6 nudged by weight 0.25 toward the clamped self-rating, band-limited to `[0.45, 0.8]` — in-range ratings only move it over `[0.45, 0.70]`. The model's self-assessment can never be the deciding factor. |
| **grounding** | node's `sources` | fraction with `quoteVerified===true`; `0.7` if source-less (synthesized), `0.4` floor if sources exist but none verified, else `0.4 + 0.6·ratio`. |
| **agreement** | distinct witnesses | the only factor that can exceed 1.0 (capped 1.1): 0.9 (none) / 1.0 or 0.85 (one verified/unverified) / 1.05 (two) / 1.1 (3+). Witnesses keyed by `(documentId, normalized snippet)`. |
| **integrity** | cross-ref resolution | `1.0` if no outbound refs; else `0.5 + 0.5·(resolved/total)`. This is the rubric's component for "do cross-references resolve." |
| **schemaBonus** | completeness ratio | required-field completeness mapped into `[0.7, 1.0]`; can only penalize incompleteness, never reward beyond neutral. |

Every factor has a deliberate **floor** so no single weak signal annihilates the product. Cross-ref integrity is always measured against the same **post-merge id universe** the validator uses, so "resolved" in the rubric and "not dangling" in the validator agree. Note that `scoreObjectConfidence` passes **no** `totalRefs`/`resolvedRefs` ([orchestrator.ts:391](api/ontology-gen/pipeline/orchestrator.ts#L391)), so objects deliberately get a **neutral integrity factor (1.0)** — their attribute fk refs are validated separately. The orchestrator feeds each node's existing `confidence` field in as `rawSelfRating`, and the rubric output overwrites it. Per-kind `*Completeness` helpers feed `schemaBonus`; `eventCompleteness` rewards being wired to ≥1 producer/consumer, which is why `deriveEventInverse` must run **before** event scoring.

**Aggregate ontology confidence:** `computeOntologyConfidence` ([confidence.ts:464](api/ontology-gen/pipeline/confidence.ts#L464)) is a **weighted mean** over every node: `KIND_WEIGHT` favors the agentic spine (action 1.4, process 1.3, object/rule 1.0, event 0.9, relationship 0.6), and `reviewWeight` boosts human-touched nodes (accepted/edited/human 1.25, merged 1.1, pending 1.0) and **excludes** `rejected` (weight 0). An empty/all-rejected ontology returns 0. A node with missing/NaN confidence contributes 0 to the numerator but its weight still counts in the denominator, so unscored nodes drag the mean down.

`Confidence` is a bare number — there are **no named bands** in this rubric. (A separate downstream frontend adapter maps rule confidence to an enforcement mode, ≥0.95→block / ≥0.88→warn, but that is not part of the rubric.)

---

## 9. Stage-order enforcement & the Action↔Event inverse

**Why later layers reference only earlier ids:** the ontology is built bottom-up, so each cross-reference must point at something that already exists. Two enforcement layers cooperate:

1. **Run-time gate (orchestrator):** `assertStageOrder` throws `STAGE_OUT_OF_ORDER` before a stage runs if its prior layers' positional proxies aren't satisfied. This is coarse — it gates which stage may run.
2. **Authoritative backstop (validator):** `validateOntology`'s forward-reference checks flag `stage_order_violation` only for refs that **resolve to a real id in a forbidden later layer** ([ontology-validate.ts:389](api/_shared/ontology-validate.ts#L389)) — a Rule's `trigger.onEventTypeId` pointing at an action/process id, a step's `callsActionTypeId` pointing into processes, an event payload `objectTypeId` resolving into processes. Pure unknown ids are reported as `dangling_ref` instead, so the two checks are mutually exclusive.

**The Action↔Event inverse** is the one bidirectional cross-reference. It is derived **authoritatively from the actions side** by `deriveEventInverse(actions, events)` ([orchestrator.ts:355](api/ontology-gen/pipeline/orchestrator.ts#L355)): it builds `producedBy` (eventId → action ids whose `emitsEvents` include it) and `consumedBy` (eventId → action ids whose `triggeredByEventIds` include it), de-duped and first-seen-ordered, then **overwrites** every event's `producedByActionIds`/`consumedByActionIds`. This runs after Stage 4 defines the events and after the drop pass. Because the validator's `checkEventInverse` ([ontology-validate.ts:433](api/_shared/ontology-validate.ts#L433)) independently rebuilds the same maps from the same actions and compares as **sets** (`sameSet` — equal size, every expected member present, order/duplicate-insensitive), the `event_inverse_mismatch` warning is **structurally unreachable** for orchestrator output. (It is a `warn`, not an error, even if it fired.)

---

## 10. Validation

`validateOntology(o)` ([ontology-validate.ts:68](api/_shared/ontology-validate.ts#L68)) is dependency-free and **never throws** — any internal failure is caught and converted into a single error-level issue keyed to `safeId(o)`, **reported under the `dangling_ref` kind** (not a dedicated kind, [ontology-validate.ts:70](api/_shared/ontology-validate.ts#L70)). It returns `ValidationIssue[]`, each `{ level: 'error'|'warn', kind, from, field?, missingId?, message }`. It normalizes every layer with `arr<T>()` (non-arrays → `[]`, the source of its robustness), builds per-layer id sets, and runs duplicate-id, per-layer referential/vocabulary/provenance, event-inverse, and forward-reference checks. It builds a `relationshipIds` set but **never uses it** for any referential check (explicitly discarded via `void relationshipIds`, [ontology-validate.ts:426](api/_shared/ontology-validate.ts#L426)) — no cross-reference target ever points at a relationship id; relationships are validated only for their own source/target object refs and provenance, i.e. relationship ids are non-referenceable.

The nine `IssueKind`s:

| Kind | Level | Fires when |
|---|---|---|
| `dangling_ref` | error (warn for rule-group members & process actorRole) | a cross-ref resolves to no known id |
| `missing_source` | error / warn | extracted/merged node has 0 sources (error, returns early); rule citation not sentence-level (warn) — the warn is gated on `needsSource` (extracted/merged) AND no `sentenceRefs`, so inferred/human rules never trigger it ([ontology-validate.ts:552](api/_shared/ontology-validate.ts#L552)) |
| `quote_unverified` | warn | `src.quoteVerified === false` (strict) — confidence already downgraded |
| `duplicate_id` | error | two nodes across the five layers + relationships share an id |
| `enum_without_values` | error | attribute `type==='enum'` with no `enumValues` |
| `reference_without_target` | error | ref/fk attribute with no `refObjectTypeId` (short-circuits the dangling check) |
| `precondition_severity_mismatch` | warn | cached precondition severity differs from the rule's authoritative severity — only when the ruleId resolves, `pc.severity !== undefined`, and the rule's severity is defined ([ontology-validate.ts:236](api/_shared/ontology-validate.ts#L236)); an unresolved-rule precondition yields `dangling_ref` instead |
| `event_inverse_mismatch` | warn | event producer/consumer arrays aren't the exact inverse of the actions |
| `stage_order_violation` | error | a ref resolves to a real id in a forbidden later layer |

The validator computes **no** normalize/substring check of its own — it has no access to `ParsedSource` text. It merely **trusts** the `quoteVerified` boolean the grounder already set: `requireSources` ([ontology-validate.ts:519](api/_shared/ontology-validate.ts#L519)) emits a `quote_unverified` warn when `src.quoteVerified === false` ([ontology-validate.ts:543](api/_shared/ontology-validate.ts#L543)). It also enforces the provenance gate: only `extracted`/`merged` require ≥1 source; `inferred`/`human` may legitimately have `[]`. Process validation checks `step.actionTypeId` against the **global** `actionIds` set ([ontology-validate.ts:355](api/_shared/ontology-validate.ts#L355)) — a missing action there yields `dangling_ref` — while `WorkflowStep` ids are validated as **process-scoped** (edge `toStepId` against a per-process step set), not global node ids. The process step `actorRole` dangling warn ([ontology-validate.ts:359](api/_shared/ontology-validate.ts#L359)) fires only when the process declares ≥1 actor (`actorRoles.size > 0`) and is pushed **without** a `missingId` field, unlike other `dangling_ref` issues.

---

## 11. Assembly (buildOntology)

`buildOntology(ctx)` ([orchestrator.ts:567](api/ontology-gen/pipeline/orchestrator.ts#L567)) is **pure and synchronous**, used both for the final result and for per-stage validation of partial state. It assembles the envelope:

- `id: ctx.ontologyId`; `uuid: randomUUID()` (a **fresh uuid every call** — the caller must carry forward the real one via `carryMetadata`); `name: deriveName(ctx)` (first source's name, else title-cased id); `domain`; `version: 1` (always — bumping happens on save/publish); `schemaVersion: SCHEMA_VERSION_NUMBER`; `status: 'draft'`.
- `sourceDocuments` + the five layers + `relationships` + `ruleGroups` straight from `ctx`.
- `confidence` = `computeOntologyConfidence(ontology)` (the weighted mean, §8).
- `metadata`: fresh `createdAt`/`updatedAt`, `stats` (per-layer counts via `computeStats`), and `generation: { model, provider, runId: ontologyId }`.

`runStage` calls `buildOntology` **exactly once** per invocation — on the error-return path ([orchestrator.ts:155](api/ontology-gen/pipeline/orchestrator.ts#L155)) **or** on the success-return path ([orchestrator.ts:168](api/ontology-gen/pipeline/orchestrator.ts#L168)), never both (the two are mutually exclusive returns). Because it mints a fresh uuid and timestamps on every call, the envelope's identity is non-stable across calls — which is exactly why `carryMetadata` is mandatory in the run loop.

---

## 12. LLM access & providers

All model access goes through [llm.ts](api/ontology-gen/llm.ts), a self-contained vendored replacement for the monorepo's central dispatcher, exposing exactly `callLLM`, `executeLLMWithTracking`, and the supporting types. Two stated differences from the original: **API keys come from env vars** (no Supabase settings table), and **token-usage logging is a no-op**.

- **Providers:** `'openrouter' | 'openai' | 'google' | 'deepseek' | 'qwen' | 'moonshot'`. Default is OpenRouter (a falsy provider coerces to it).
- **Routing** ([llm.ts:154](api/ontology-gen/llm.ts#L154)): `openrouter` hits openrouter.ai; `openai`/`deepseek`/`qwen`/`moonshot` hit OpenAI-compatible endpoints (the latter three honor `*_BASE_URL` overrides); `google` and **any unknown provider** fall through to the OpenRouter path. The fallback at [llm.ts:190](api/ontology-gen/llm.ts#L190) re-normalizes the **original** `model` string under the `'openrouter'` provider (`normalizeModelForProvider('openrouter', model)`) rather than reusing the already-computed `effectiveModel`, deliberately recovering the full `vendor/model` form (e.g. `google/gemini-2.5-pro`) that the non-openrouter normalization would have truncated. Each branch requires its API key **before** any HTTP request, throwing a provider-named "API key not configured" error otherwise. (`GOOGLE_API_KEY` is therefore dead config — google routes via OpenRouter and needs `OPENROUTER_API_KEY`. Moonshot accepts `KIMI_API_KEY` as an alias.) The OpenRouter path also sends two extra headers — `HTTP-Referer` (from `process.env.SITE_URL`, default `http://localhost:3598`) and `X-Title` (from the `title` option, default `'Ontology Generator'`) — that the OpenAI-compatible path omits.
- **Model selection:** `normalizeModelForProvider` ([llm.ts:58](api/ontology-gen/llm.ts#L58)) strips a leading `openrouter/` prefix; for OpenRouter it preserves the `vendor/model` form, for direct providers it keeps only the last `/` segment. The default model string is chosen by the entrypoint: `defaultModel()` = `ONTOLOGY_GEN_MODEL || LLM_MODEL || 'openrouter/google/gemini-2.5-pro'` ([index.ts:171](api/ontology-gen/index.ts#L171)) — `ONTOLOGY_GEN_MODEL` exists so extraction can use a **fast** model (each stage is a single synchronous call; slow reasoning models risk request timeouts) without changing the app-wide default.
- **`callLLM`** returns `{ content, usage }`, where `usage` is `{ prompt_tokens, completion_tokens, total_tokens }` parsed from the provider response (or a zeroed `emptyUsage` fallback). Its own parameter defaults are `maxTokens = 500`, `temperature = 0.7` ([llm.ts:84](api/ontology-gen/llm.ts#L84)) — applied only when a caller omits them (the extraction stages always pass explicit values).
- **`executeLLMWithTracking`** ([llm.ts:211](api/ontology-gen/llm.ts#L211)) accepts `module`/`actionName`/`userInfo`/`promptPreview` for signature compatibility but **never reads or forwards them** (no-op tracking), delegates to `callLLM`, discards `usage`, and returns only `result.content` (a raw string). Every caller parses and defends against malformed output itself.
- **Graceful failure:** a non-2xx response throws `LLM API error (<provider>): <status> <body>` — no retry, no fallback inside `callLLM`. The thrown error is caught by each stage's own try/catch and degraded to an empty layer.

---

## 13. Failure handling & determinism

**Deterministic (no LLM, no randomness — same input ⇒ same output):** id minting (`makeId`), whitespace normalization, content hashing, grounding/`locate`, ungrounded-node dropping, the confidence rubric, event-inverse derivation, all cross-ref coercion/validation in the stages, `validateOntology`, `buildOntology` (modulo the throwaway uuid/timestamps), and all three downstream generators. (One deliberate exception: Stage 4 event node `uuid`s use a `Math.random()`-based generator, §6.)

**Model-driven (non-deterministic):** the five extraction LLM calls and the optional critique. These are the only sources of variance; everything around them is pure.

**How failures degrade — never a 500:**
- `parseDocument` swallows corrupt-PDF/bad-DOCX throws into degraded best-effort text.
- Each `extract*` stage wraps its LLM call in try/catch; a transport error or unparsable JSON degrades to an empty layer (objects/processes return `{[]}`, rules return `{rules:[],ruleGroups:[]}`, events return the deterministic skeleton with empty enrichment).
- `runStage` throws **only** on `assertStageOrder`; every other failure (extraction, merge, derive) is caught and returned as a `StageProgress` with `status:'error'` plus an `error` string and the partial's validation issues — never a throw. A **critique** failure does **not** degrade the stage: it is swallowed inside `runCritique`'s own try/catch, leaving `critique=undefined` while the stage completes successfully (§5).
- A stage left in `'error'` is **re-selected and retried** on the next `run.step` (there is no permanent failure state).
- `loadRunState` returns `null` (→ 404) on any missing/corrupt data rather than throwing.
- The store falls back to a file-backed store when Supabase env is absent.
- The top-level handler maps `HttpError` to its code, messages containing `NOT_FOUND` to 404, and everything else to 400 (`HANDLER_ERROR`) — the design explicitly avoids unhandled 500s on missing Supabase/Neo4j env ([index.ts:1248](api/ontology-gen/index.ts#L1248)).

---

## 14. Downstream: generators

A finished, validated `Ontology` is the sole input to `generate(o, target)` ([generators/index.ts:34](api/ontology-gen/generators/index.ts#L34)). All three generators are **pure, deterministic, no-LLM, no-I/O** transforms that return a uniform `GeneratedBundle { target, files, warnings }`; dangling references surface as non-fatal `warnings[]`, never crashes (on the `generate()` path). `generate(o, 'all')` returns the three bundles in fixed order.

| Target | Output | Projection |
|---|---|---|
| **agent-code** ([agent-code.ts](api/ontology-gen/generators/agent-code.ts)) | TypeScript `src/agents/` package (`.js` import specifiers) | `types.ts` (one interface per ObjectType), `runtime.ts` (top-level `export function assertPrecondition` + `export type Severity`), per-action tool stubs + `tools/index.ts` registry, per-process orchestrators. Precondition default severity `info`; dangling edges kept as `MISSING:` comments. |
| **prompts** ([generators/prompts.ts](api/ontology-gen/generators/prompts.ts)) | Markdown `prompts/` (global `system.md` + one per actor role) | role discovery from action/process actors; per-role Mission/Tools/Rules (bilingual + citations)/Events sections. |
| **manifest** ([manifest.ts](api/ontology-gen/generators/manifest.ts)) | JSON `manifests/` (one `WorkflowManifest` per process) | version-pinned (`ontologyVersion` + `manifestVersion:1`), flattened ordered nodes, scoped tool catalog, per-role agents with short prompts. Precondition default severity `block`; dangling edges dropped. |

**agent-code runtime:** `runtime.ts` emits a module-level `export function assertPrecondition(ruleId, severity, satisfied, predicate?): void` ([agent-code.ts:427](api/ontology-gen/generators/agent-code.ts#L427)) and `export type Severity = 'info'|'warn'|'block'` ([agent-code.ts:420](api/ontology-gen/generators/agent-code.ts#L420)) — it is a plain function, not a class/static member. It returns early if `satisfied`, throws on a `block`-severity failure, otherwise `console.warn`s. **Name de-duplication is load-bearing and fully deterministic:** `buildIndex` ([agent-code.ts:144](api/ontology-gen/generators/agent-code.ts#L144)) dedupes ObjectType interface names (PascalCase, numeric suffix on collision), tool names (snake_case from `agent.toolName||name||id`, `_2`/`_3` suffixing with a "Duplicate tool name" warning), and process fn names (`run_<snake>` with `_2` suffixing); the prompts generator independently dedupes role-slug collisions with a warning ([prompts.ts:514](api/ontology-gen/generators/prompts.ts#L514)).

**prompts rules:** `rulesForRole` ([prompts.ts:212](api/ontology-gen/generators/prompts.ts#L212)) emits the **union** of (a) rules referenced as preconditions of the role's owned actions and (b) every rule whose `appliesToObjectTypeIds` intersects the object ids the role's actions touch (`objectIdsForRole` over inputs/outputs/step reads+writes/sideEffects). They are emitted in severity-then-id order (block<warn<info) with `block`→"MUST NOT" / `warn`→"CAUTION" / `info`→"NOTE" markers.

**manifest repair vs. drop:** an unresolved `step.actionTypeId` does **not** drop the node — it emits a warning and produces a `ManifestNode` with `actionToolName=''` ([manifest.ts:108](api/ontology-gen/generators/manifest.ts#L108)). Likewise unresolved precondition ruleIds and unresolved emitted eventTypeIds emit warnings but are kept ([manifest.ts:118](api/ontology-gen/generators/manifest.ts#L118)). Only dangling `next`-edges (a `toStepId` not in this process's step set) are dropped ([manifest.ts:148](api/ontology-gen/generators/manifest.ts#L148)). The manifest carries the process `triggers` and a Bilingual name defaulting to `{en: id, zh: id}` when `process.name` is absent. Note the never-crashes property holds for the `generate()`/`generateManifests()` path (which only iterates existing `o.processes`), but the public single-process helper `buildWorkflowManifest(o, processId)` **throws** `buildWorkflowManifest: process '<id>' not found` for an absent process id ([manifest.ts:211](api/ontology-gen/generators/manifest.ts#L211)); it is simply unreachable from `generate()`.

**Determinism mechanics:** agent-code sorts process steps by `order` and sorts imports; the prompts generator sorts roles, actions, rules, events, and parameter rows by a locale-independent `byString` comparator so re-runs are byte-identical; the manifest sorts steps by `order` and builds the tool catalog scoped to the process, deduped in first-appearance/step order. **Edge warnings** the table doesn't show: agent-code pushes "Ontology has no actions; tool registry is empty." and emits `export {};` in `types.ts` when there are no objects; prompts warns when an ontology declares no actor roles (and per coordination-only role); manifest pushes "no processes to manifest" on an empty ontology.

The three views are complementary projections of the same graph: agent-code is the implementation skeleton, prompts is the LLM-agent instruction layer, manifest is the runtime execution descriptor.

---

## 15. Invariants & glossary

### Hard invariants

1. **`parseDocument` is pure** — no LLM, no store, no id set; all dedup/id minting happens in `ingestOne`.
2. **`contentHash` is over the NORMALIZED text** — identical content always re-keys to the same `parsedRef`; re-puts overwrite idempotently.
3. **Exactly one stage advances per `run.step`** — the pipeline is client-paced, never run end-to-end server-side.
4. **The partial ontology is stashed as a `ParsedSource` row** keyed `run_ontology:<runId>` (`text = JSON`, `documentId = runId`); no dedicated column.
5. **Stages are idempotent** — every `apply*` replaces (never appends to) its `ctx` layer.
6. **Ids are minted once, deterministically**, against a shared `taken` set seeded with every existing id; immutable thereafter (a merge remaps refs, never regenerates).
7. **`buildOntology` is pure/stateless** (fresh uuid + version 1 every call, called exactly once per `runStage`); `carryMetadata` is mandatory to preserve the run's identity (only `uuid` copied unconditionally; the rest fall back to the freshly-built value).
8. **Stages are pure-extract** — one LLM call, set raw confidence + verbatim snippet + `provenance:'extracted'`/`reviewState:'pending'`, never ground/score/validate/mutate prior layers.
9. **`quoteVerified` is backend-computed by the grounder alone** (exact or normalized substring), never trusted from the model; fuzzy matches stay `false`; the validator merely trusts the boolean.
10. **`dropUngroundedNodes` removes only extracted nodes with zero citations** (purely, via a new array); inferred/merged/human and any cited extracted node survive.
11. **Confidence is the locked product** `base × grounding × agreement × integrity × schemaBonus`; the self-rating is only a band-limited nudge (objects get neutral integrity).
12. **Event producer/consumer lists are always the exact inverse of the actions** (re-derived authoritatively post-drop).
13. **Cross-references are by slug `id`**; later layers reference only earlier ids (Action↔Event the sole exception); relationship ids are never referenced by anything.
14. **Bilingual `en`+`zh` is mandatory** on key names/statements (though Stage 1 does not enforce it at extraction time).
15. **`runStage` throws only on out-of-order**; every other failure degrades to an error `StageProgress` (critique failures degrade to `critique=undefined`, not an error) — never a 500.
16. **`validateOntology` never throws.**

### Glossary

- **StageContext** — the single mutable object threaded through every stage: identity (`ontologyId`, `domain`), evidence (`sources`, `parsed`, `taken`), the seven accumulated layer arrays, LLM config (`model` defaulting to `process.env.LLM_MODEL`, `provider` defaulting to `process.env.LLM_PROVIDER || 'openrouter'`, `userInfo` typed `unknown | null`), and `log`. Defined in [context.ts](api/ontology-gen/pipeline/context.ts), which also exports `buildCritiquePrompt`.
- **ParsedSource** — `{ ref, documentId, text, pageMap? }`; the normalized plaintext (line structure preserved) the model actually sees and the substrate for all citation offsets.
- **SourceDocument** — upload metadata: slug `id`, `uuid`, `kind`, `parsedRef`, `contentHash`.
- **SourceRef** — a single verbatim citation; the unit of grounding.
- **Provenance** — how a node entered: `extracted` (from a quote), `inferred` (synthesized, kept via `derivedFrom`), `merged`, `human`.
- **ReviewStatus** — `pending`/`accepted`/`edited`/`merged`/`rejected`; gates publish and weights aggregate confidence.
- **STAGE_ORDER** — `objects → rules → actions → events → processes`.
- **`taken`** — the per-run mutable `Set<string>` that guarantees collision-free, deterministic ids across all stages.
- **OntologyRun** — the per-run progress ledger (one `StageProgress` per stage, each `{ stage, status, count, startedAt?, finishedAt?, error? }`) persisted alongside the partial ontology stash.
- **buildCritiquePrompt** — the QA-reviewer prompt builder in [context.ts](api/ontology-gen/pipeline/context.ts) consumed by `runCritique`; it asks the reviewer to return `{ issues: [{ itemId, kind, detail }], summary }` over a fixed 6-point checklist (citations / schema / cross-refs / hallucination / duplicates / confidence) and explicitly does **not** rewrite the draft. (Note: prompts.ts also defines and exports `buildMergePrompt`, a cross-chunk de-dup builder that is **dead code** — no importer anywhere — even though the prompts.ts header advertises "the cross-chunk merge step"; the orchestrator does deterministic wholesale layer replacement instead.)
- **GeneratedBundle** — `{ target, files, warnings }`; the uniform output of every downstream generator.

---

## 16. Beyond the single-pass pipeline: swarm & hyper modes

Both deeper modes are **client-paced phase machines** layered on the deterministic core — every extraction sub-step still flows through `runStage`/`deepenStage` → ground → drop → score → validate, so all §5–§10 invariants hold unchanged. They share one step driver: `actionModeStep` ([index.ts:1029](api/ontology-gen/index.ts#L1029)) serves **both** `run.swarm.step` and `run.hyper.step` and dispatches on the **persisted** `run.mode`, never the endpoint name, so a client hitting the wrong endpoint cannot corrupt a run. The sub-step cursor persists as another `ParsedSource`-shaped stash keyed `swarm_state:<runId>` (mode-agnostic, reused verbatim for hyper), and the artifacts ride on `ontology.metadata`.

### The two phase machines

- **Swarm** (`run.swarm.start`/`run.swarm.step`) — **15 fixed sub-steps** ([swarm/orchestrator.ts:57](api/ontology-gen/pipeline/swarm/orchestrator.ts#L57), `SWARM_STEP_COUNT` at L75) over the 4 phases of `SWARM_PHASE_ORDER` ([ontology-schema.ts:747](api/_shared/ontology-schema.ts#L747)): a 4-role SME swarm produces a `BusinessBrief` whose rendered seed (`renderBriefSeed`, [business-understanding.ts:180](api/ontology-gen/pipeline/swarm/business-understanding.ts#L180)) prefixes every later extraction prompt via `ctx.briefSeed`; breadth extraction of all five stages; BA review of every use case → `CoverageReport` v1; gap-driven deepening + link synthesis + BA re-review → v2; follow-up questions. **Coverage here is expectation-side only** — recall against what the SMEs *expected*, not against the document text.
- **Hyper** (`run.hyper.start`/`run.hyper.step`) — **22 fixed sub-steps** ([hyper/orchestrator.ts:83](api/ontology-gen/pipeline/hyper/orchestrator.ts#L83), `HYPER_STEP_COUNT` at L108) over the 10 phases of `HYPER_PHASE_ORDER` ([ontology-schema.ts:911](api/_shared/ontology-schema.ts#L911)): `terminology → business_understanding → iteration_1 → coverage_eval_1 → remediation_1 → iteration_2 → coverage_eval_2 → remediation_2 → final_eval → follow_up`. `advanceHyper` ([hyper/orchestrator.ts:218](api/ontology-gen/pipeline/hyper/orchestrator.ts#L218)) mirrors `advanceSwarm` ([swarm/orchestrator.ts:178](api/ontology-gen/pipeline/swarm/orchestrator.ts#L178)) and reuses its modules verbatim (`runBusinessUnderstanding`, `runBaReview`, `deepenStage`, `runLinkSynthesis`, `runQuestions`); step failures are caught and logged, never thrown — identical degradation contract.

### Hyper's four additions

1. **Terminology & data-type scan** ([hyper/terminology.ts](api/ontology-gen/pipeline/hyper/terminology.ts)) — `runTerminology` (L227) chunks each `ParsedSource` (24 000 chars, 500 overlap, L44–45) and extracts every business term/entity/attribute/enum set/data type/role/abbreviation/system/document kind as a `TermEntity` with verbatim-snippet `sources` (terms are **metadata, not layer nodes** — never grounded/dropped). Merged by `lowercase(term.en)+kind`; `matchTerms` (L409) deterministically sets `matchedId` against realized ontology nodes. The rendered `renderTermSeed` (L340) is appended to `ctx.briefSeed` **alongside** the brief seed ([hyper/orchestrator.ts:243](api/ontology-gen/pipeline/hyper/orchestrator.ts#L243)), so every downstream extraction prompt must reconcile against the glossary. Result lands on `metadata.terminology`.
2. **Document-coverage eval** ([hyper/doc-coverage.ts:307](api/ontology-gen/pipeline/hyper/doc-coverage.ts#L307)) — sentence-level verification over the substrate built by `numberSentences` ([hyper/sentences.ts:95](api/ontology-gen/pipeline/hyper/sentences.ts#L95); globally 1-based, CJK-aware, offsets slice-exact against the parsed text — a deliberate, documented duplicate of the private helper in `stages/rules.ts`). Three-tier verdicts, cheapest first: **tier 1** deterministic span-overlap of each sentence against every node's grounded `SourceRef` intervals (no LLM; overlapping ⇒ `covered` with `coveredBy` node ids); **tier 2** deterministic boilerplate filter (headings/numbering/too-short ⇒ `uncoverable`); **tier 3** LLM judging of the remainder in batches of ≤80 sentences against a compact ontology digest — unparseable/missing verdicts default to `uncovered` (**fail-closed**: a judging failure can only increase reported gaps). `coverageRatio = covered / max(1, total − uncoverable)`; the target comes from `ONTOLOGY_GEN_COVERAGE_TARGET` (default 1.0, [doc-coverage.ts:53](api/ontology-gen/pipeline/hyper/doc-coverage.ts#L53)). The `DocumentCoverageEval` report (findings retain **only** `partial|uncovered`) lands on `metadata.documentCoverage`, with earlier passes (findings trimmed) on `documentCoverageHistory`.
3. **Remediation** ([hyper/remediate.ts:71](api/ontology-gen/pipeline/hyper/remediate.ts#L71)) — `findingsToGaps` (L44) converts uncovered/partial findings into `CoverageGap`s whose description embeds the **verbatim uncovered sentence** (`uncovered`→`block`, `partial`→`warn`); a finding maps to a stage via its `expectedKinds` (no kinds ⇒ objects+rules, the safest recall default), capped at 40 gaps/stage/round (L28). It then delegates to the existing `deepenStage` ([swarm/deepen.ts:66](api/ontology-gen/pipeline/swarm/deepen.ts#L66)) snapshot → seeded re-extract → **merge-preserve-by-id** path, so remediated nodes get grounding/confidence/validation exactly like every other node and no prior work is lost. Remediation steps **no-op** when the latest eval already `meetsTarget` or has no findings for their layers — the fixed-array cursor behaves like a loop-until-covered.
4. **Final eval gate** — eval pass 3 records `meetsTarget`; `metadata.hyper` carries `{ passes, coverageTarget, remediationRounds, web }`. Hyper step responses additionally surface `terminology` + `documentCoverage` to the client.

### Per-agent LLM routing

Every LLM call site is now keyed by a stable **agent id** from the 14-entry `AGENT_REGISTRY` ([agents.ts](api/ontology-gen/agents.ts); five stage extractors + `stage_critic` + `title_generator` + four swarm agents + `terminology_extractor`/`coverage_evaluator` + `inference_agent`; deepen/remediation reuse the stage extractors' ids). `StageContext` gained one optional field, `agentLlm` ([context.ts:89](api/ontology-gen/pipeline/context.ts#L89)), attached per request via `makeAgentLlmResolver` ([llm-router.ts:367](api/ontology-gen/llm-router.ts#L367); wired in `contextFromOntology`, [index.ts:473](api/ontology-gen/index.ts#L473)); call sites resolve through `ctxAgentLlm(ctx, '<agent_id>', { inputChars })` ([llm-router.ts:385](api/ontology-gen/llm-router.ts#L385)), which falls back to `ctx.model`/`ctx.provider` when the resolver is absent — absent ⇒ behavior byte-identical to before. `resolveAgentLlm` (L145) applies the precedence **env (`ONTOLOGY_GEN_MODEL_<AGENT_ID>` + optional `ONTOLOGY_GEN_PROVIDER_<AGENT_ID>`) > settings overrides > router > default**; the router (disable via `ONTOLOGY_GEN_ROUTER=0` or `settings.routerEnabled`) maps agent purpose to a strength tier — extraction/enrichment/classification get a `FAST_SIBLINGS` family sibling of the base model (L77), review/reasoning/synthesis/inference keep the base model, oversized inputs upgrade to a long-context family, `needsWeb` pins the OpenRouter path. Settings persist via the universal stash-row pattern (`llm_settings:global`, L297) and surface through `llm.agents` (GET) / `llm.settings` (POST); the frontend settings screen ([LLMSettingsScreen.tsx](src/ontology-generator/LLMSettingsScreen.tsx), gear in TopBar) renders the registry with each assignment's source badge and rationale.

### Multi-hop inference

The `infer` action ([index.ts:1383](api/ontology-gen/index.ts#L1383); `POST { ontologyId | ontology, question, maxHops?, maxIterations? }`) answers multi-hop questions over any stored or inline ontology. `ontologyToTriples` ([inference/triples.ts:160](api/ontology-gen/inference/triples.ts#L160)) is a **pure, deterministic** projector onto a closed `PREDICATES` vocabulary (L29) — `has_attribute`/`has_type`/`references`, relationship verbs + `cardinality`, `applies_to`/`triggered_by`, `consumes`/`produces`/`guarded_by`/`emits`/`performed_by`/`calls`, `produced_by`/`consumed_by`, `has_step`/`precedes`/`involves`. `runInference` ([inference/engine.ts:58](api/ontology-gen/inference/engine.ts#L58)) owns the graph while the LLM owns the reasoning: a seed call picks frontier node ids from a compact node index, then an expand/answer loop (defaults `maxIterations` 4 / `maxHops` 6, L45–46) deterministically gathers adjacent triples and accumulates `{ triples, inference }` hop records into an `InferenceResult` (bilingual answer + explicit chain). Malformed JSON degrades to one retry then a graceful "no answer derivable" result — never a throw. Thirty written use cases (3 per golden-fixture domain, each ≥3 hops, hop paths referencing real node ids) live in [docs/INFERENCE_USE_CASES.md](docs/INFERENCE_USE_CASES.md) + machine-readable [fixtures/inference-use-cases.json](fixtures/inference-use-cases.json).

### Prompt doctrine

All extraction/review/synthesis prompts (in [prompts.ts](api/ontology-gen/prompts.ts) and the swarm/hyper modules) were rewritten **recall-first with frozen JSON contracts** — field names stayed byte-identical to what the §6 parsers expect. The doctrine: a `SWEEP_METHOD` section-by-section sweep discipline ([prompts.ts:122](api/ontology-gen/prompts.ts#L122)), per-stage "COMMONLY MISSED" negative-space checklists, terminology/brief-seed reconciliation (every seeded expectation either maps to an output item or is consciously skipped), a counting self-check in `SELF_CHECK`, and anti-truncation output budgeting. The swarm JSON helper `callJson` ([swarm/llm-json.ts](api/ontology-gen/pipeline/swarm/llm-json.ts)) gained a **single corrective retry** (L63) — an unparseable first reply is replayed once with a bare-JSON demand before degrading.

All new types (`HyperPhase`/`RunPhase`, `TermEntity`/`TerminologyExtraction`, `SentenceCoverage`/`DocumentCoverageEval`, `AgentDef`/`AgentModelAssignment`/`LlmSettings`, `Triple`/`InferenceHop`/`InferenceResult`) live in **both** schema mirrors (§10c/§10d of [ontology-schema.ts](api/_shared/ontology-schema.ts) and `src/ontology/schema/types.ts`) under the same hand-sync discipline as everything else there.
