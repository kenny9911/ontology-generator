# Database Ingestion Design — Ontology Generation from a System's Database

This is the architecture document for ingesting a **live system's database** —
schema / table structures, constraints and foreign keys, stored procedures /
functions / triggers / views, and execution logs — and turning it into the same
structured, reviewable **ontology** the document pipeline produces (objects →
rules → actions → events → processes).

Goal: **recover the knowledge that lives behind a running system's database**
and project it onto the canonical ontology, reusing the entire existing
extraction core (grounding, confidence, validation, review UI, generators,
JSON editor, inference) unchanged.

Companion docs:
- [HYPER_AUTOMATION_DESIGN.md](HYPER_AUTOMATION_DESIGN.md) — the deep-mode pipeline this reuses
- [../ONTOLOGY_GENERATION.md](../ONTOLOGY_GENERATION.md) — the classic 5-stage pipeline deep-dive
- [../CLAUDE.md](../CLAUDE.md) — repo conventions (two build worlds, schema mirror, etc.)

> This doc is written in English to match the existing design docs and the
> English codebase terms it references; the product UI stays bilingual.

---

## 0. Design tenets (inherited, non-negotiable)

These carry over verbatim from the document pipeline and the hyper-automation
upgrade. Database ingestion must honor every one:

1. **Two build worlds.** `src/` imports `@/`-style with no extension; `api/`
   imports relative with a mandatory `.js` suffix (NodeNext).
2. **The schema is a hand-maintained mirror.** Every type added below lands in
   BOTH `src/ontology/schema/types.ts` AND `api/_shared/ontology-schema.ts`,
   structurally identical, pure types + literal consts only.
3. **Stages are pure-extract; the orchestrator owns determinism.** New LLM work
   lives in dedicated modules; grounding, confidence, merging, validation stay
   deterministic in the orchestrator.
4. **One sub-step per request.** Long pipelines are client-paced through a
   cursor stash so each backend call stays under the 60 s serverless cap.
5. **Graceful degradation.** No new code path may produce an unhandled 500.
   Connection / parse / LLM / JSON failures degrade to logged notes and empty
   artifacts.
6. **Receipts everywhere.** Every node still carries `sources`, `confidence`,
   `reviewState`. A database node's citation points into a **textual rendering
   of the database** (see §2), so the grounding spine works unchanged.

### 0b. Tenets specific to database ingestion

7. **The database is structured input — do not make the LLM re-discover it.**
   A table *is* an object, a column *is* a property, a foreign key *is* a
   relationship, a `CHECK` *is* a rule. These are facts; we map them
   **deterministically** for fidelity, and use the LLM only for **semantics**
   (humanized bilingual names, descriptions, data-vs-system classification, and
   the genuinely interpretive higher layers).
8. **Textualize-then-cite.** The whole downstream depends on
   `ParsedSource.text` and verbatim grounding ([groundSources](../api/ontology-gen/pipeline/ground.ts),
   [dropUngroundedNodes](../api/ontology-gen/pipeline/ground.ts)). So every
   database artifact is first rendered into a deterministic, human-readable,
   **citable evidence document**; both the deterministic mapper and the LLM
   cite into that same text. This is the linchpin that lets DB nodes survive
   grounding (`quoteVerified = true`).
9. **Raw data never leaves the box.** Only the rendered digest (schema, proc
   source, log *aggregates*) is sent to the LLM provider. Credentials are never
   persisted, logged, or sent to the model. PII in logs/sample data is redacted
   to shapes/aggregates before rendering.

---

## 1. Scope & locked decisions

Captured from the design review:

| Decision | Choice |
|---|---|
| Ingestion path | **Both** upload (exported artifacts) **and** live read-only introspection |
| Database dialects | **PostgreSQL** + **MySQL/MariaDB** first |
| Log shapes (M2) | **Audit tables**, **DB query logs**, **app business logs** (CDC/binlog deferred) |
| **M0 scope** | **Schema layer only** → objects + relationships + constraint rules |

### 1.1 Artifact → layer map (full vision)

| DB artifact | objects | relationships | rules | actions | events | processes | Milestone |
|---|---|---|---|---|---|---|---|
| DDL / table structure / column comments | ✅ table→object, column→property | ✅ **FK→relationship (deterministic)** | ✅ CHECK / UNIQUE / FK constraints | | | | **M0** |
| Views | ✅ derived object | join lineage | | | | | M1 |
| Stored procedures / functions / triggers | | | ✅ IF / validation / computed logic | ✅ proc→action (params=inputs, DML=side_effects) | ✅ trigger→event | | M1 |
| Execution logs (audit / query / app) | | join evidence | | ✅ frequent operations | ✅ state transitions | ✅ **sequence mining (process mining)** | M2 |
| Sample data (optional) | data/system signal | cardinality | enum values | | | | M1+ |

### 1.2 Milestones

- **M0** — Schema → objects + relationships + constraint rules. Both
  ingestion paths (live PG/MySQL via `information_schema`; upload of
  `pg_dump`/`mysqldump` DDL and `information_schema` JSON exports). Deterministic
  seed + `schema_interpreter` enrichment. End-to-end through review → publish.
- **M1** — Stored procedures / functions / triggers / views → rules, actions,
  events. New `sql_logic_extractor` agent over proc source.
- **M2** — Logs (audit tables, query logs, app logs) → events + processes via a
  deterministic **process-mining** pre-pass (directly-follows graph) +
  `log_process_miner` agent over the *aggregates only*.
- **M3** — swarm/hyper adaptation (DB evidence flows into the deep modes),
  incremental re-sync of an existing ontology against a changed schema.

---

## 2. Architecture — "database" is an input source kind, orthogonal to the mode

The extraction **depth** (fast / swarm / hyper) and the **input kind**
(document / database) are orthogonal. A database run can be fast (M0) and later
swarm/hyper (M3). The new work is isolated in one module plus a localized branch
in two stages; everything downstream is reused verbatim.

```
                          api/ontology-gen/db/  (new module)
  ┌─────────────┐   ┌──────────┐   ┌──────────────────────────┐   ┌─────────────────┐
  │ 1. ingest   │ → │ 2.DbModel│ → │ 3. textualize            │ → │ 4. deterministic│
  │ live introspect │ (dialect │   │  evidence ParsedSource   │   │ seed            │
  │ OR upload   │   │ neutral) │   │  + SourceDocument(kind=db)│  │ objects/rels/   │
  └─────────────┘   └──────────┘   └──────────────────────────┘   │ constraint rules│
                          │              ▲ shared render fn ▲       └────────┬────────┘
                          │              └ snippet == rendered line ┘        │
                          └──── stash db_model:<id> ──────────┐              │ provenance=extracted
                                                              ▼              ▼ confidence≈0.95, cited
        run.start(inputKind='database') → runStage('objects'): sees ctx.dbModel
            → seed-objects (deterministic) → schema_interpreter LLM enrich (by id, only adds)
            → existing groundSources / dropUngrounded / scoreConfidence / validate run unchanged
        runStage('rules'): seed-rules (deterministic constraint rules)
        runStage('actions'|'events'|'processes'): no proc/log evidence in M0 → [] (graceful)
            ▼
        existing review / graph / publish / generate / JSON editor / inference — all reused
```

### 2.1 The `DbModel` IR (dialect-neutral intermediate representation)

The pipeline core only ever sees `ParsedSource` + an optional `DbModel`. Both
ingestion paths and both dialects converge on this one backend-only IR (a leaf,
like `spec-format/types.ts`; **not** in the schema mirror — it never enters the
ontology JSON).

```ts
// api/ontology-gen/db/types.ts  (M0 fields; M1/M2 fields added later, all optional)
export interface DbModel {
  dialect: 'postgres' | 'mysql';
  sourceKind: 'live' | 'upload';
  schemas: string[];                 // namespaces introspected
  tables: DbTable[];
  views: DbView[];                   // M1 (empty in M0)
  // routines / triggers (M1), logProfile (M2) — added later, optional
}

export interface DbTable {
  schema: string;
  name: string;                      // raw identifier, e.g. "t_ord_hdr"
  comment?: string;                  // table comment when present
  columns: DbColumn[];
  primaryKey: string[];              // column names
  uniques: DbUnique[];               // multi-column UNIQUE constraints
  checks: DbCheck[];                 // CHECK constraints (verbatim expression)
  foreignKeys: DbForeignKey[];
}

export interface DbColumn {
  name: string;
  sqlType: string;                   // raw, e.g. "varchar(20)", "numeric(12,2)"
  nullable: boolean;
  default?: string;
  comment?: string;
  enumValues?: string[];             // from a CHECK (col IN (...)) or MySQL ENUM
}

export interface DbForeignKey {
  name?: string;
  columns: string[];                 // child columns
  refSchema: string;
  refTable: string;
  refColumns: string[];              // parent columns
  onDelete?: string;
  onUpdate?: string;
}
export interface DbUnique { name?: string; columns: string[]; }
export interface DbCheck  { name?: string; expression: string; columns?: string[]; }
export interface DbView   { schema: string; name: string; comment?: string; definition?: string; }
```

### 2.2 Ingestion — both paths, converging on `DbModel`

```
api/ontology-gen/db/
  connection.ts                      # read-only pooled connect; credential hygiene
  introspect/information-schema.ts   # LIVE: PG + MySQL via information_schema (shared)
  parse/ddl.ts                       # UPLOAD: lenient pg_dump / mysqldump CREATE TABLE parser
  parse/info-schema-json.ts          # UPLOAD: parse an information_schema JSON/CSV export
```

- **Live (PG + MySQL share one path).** Both expose ISO `information_schema`
  (`tables`, `columns`, `table_constraints`, `key_column_usage`,
  `constraint_column_usage`, `check_constraints`). A single introspector queries
  these with two small dialect branches (PG: `pg_catalog` for comments + richer
  CHECK text; MySQL: `information_schema.COLUMNS.COLUMN_TYPE` carries `enum(...)`
  inline, plus `TABLE_COMMENT`/`COLUMN_COMMENT`). Drivers (`pg`, `mysql2`) are
  **lazy-imported** so upload-only deployments don't need them (same pattern as
  the env-gated Neo4j driver).
- **Upload.** Two accepted formats: (a) **the happy path** — a
  `pg_dump --schema-only` / `mysqldump --no-data` **DDL** file (the UI's primary
  guidance), parsed by a lenient tokenizer that recognizes `CREATE TABLE` /
  column defs / `PRIMARY KEY` / `FOREIGN KEY` / `CHECK` / `UNIQUE` (best-effort,
  degrades per-statement); (b) the fallback — an **`information_schema` JSON
  export** (a documented shape we publish), which needs no SQL parsing and
  covers exotic DDL or users who cannot run the CLI.

Both paths normalize into the same `DbModel`. The introspector/parser is the
**only** dialect-aware code; nothing downstream branches on dialect.

### 2.3 Textualization — the citable evidence document (the linchpin)

`db/textualize.ts` renders the `DbModel` into one `ParsedSource` per concern
(M0: a single "Schema Reference" document; M1 adds "Stored Procedures", M2 adds
"Observed Operations"). The render is deterministic and line-oriented; the
**same render helper** is exported and reused by the seed builders so a seeded
node's `snippet` is byte-identical to a line in the evidence text.

Example rendered evidence (what the LLM sees and what citations point at):

```
Table: orders  -- 订单主表 (order header)
Columns:
  order_id       BIGINT        PRIMARY KEY                              -- 订单ID
  customer_id    BIGINT        NOT NULL  REFERENCES customers(customer_id)
  status         VARCHAR(20)   CHECK (status IN ('pending','paid','shipped','cancelled'))
  total_amount   NUMERIC(12,2) NOT NULL  CHECK (total_amount >= 0)
Constraints:
  UNIQUE (customer_id, order_no)
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT
```

A seeded `orders` object cites `"Table: orders"`; the FK relationship cites
`"FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE RESTRICT"`;
the status rule cites `"CHECK (status IN ('pending','paid','shipped','cancelled'))"`.
All are verbatim substrings → [groundSources](../api/ontology-gen/pipeline/ground.ts)
sets `quoteVerified = true` and the nodes survive
[dropUngroundedNodes](../api/ontology-gen/pipeline/ground.ts).

### 2.4 Deterministic seed — `seed-objects.ts` + `seed-rules.ts`

Pure, no LLM, no I/O. Mapping rules:

| DB element | Produces | Notes |
|---|---|---|
| table / view | `ObjectType` | `id = makeId('object', '<schema>.<table>')` (fully-qualified — collision-safe across schemas, stable for M3 re-sync); `primary_key` = the PK column (or `<slug>_id` default per [objects.ts](../api/ontology-gen/pipeline/stages/objects.ts)); `provenance='extracted'`; raw confidence ≈ 0.95 (a fact) |
| column | `ObjectProperty` | `type = toPropertyType(sqlType)` (already handles integer/decimal/timestamp/enum/…); `description` = column comment; `enumValues` → reuse later |
| foreign key | top-level `Relationship` **and** child property `is_foreign_key`/`references` | child→parent; `cardinality = many_to_one` (or `one_to_one` if the FK columns are unique); `viaAttribute` = FK column |
| `CHECK` | `Rule` `kind='constraint'\|'validation'`, `severity='block'` | `statement` from the check expression; `appliesToObjectTypeIds=[table]`, `appliesToAttributes=[col]`; `CHECK (col IN (...))` also fills the property `enumValues` |
| multi-column `UNIQUE` | `Rule` `kind='constraint'` | a real business invariant — first-class |
| `NOT NULL` / PK / single-column UNIQUE | **structural on the property** (no rule) | avoids a rule explosion of trivial constraints |

Citations are minted by the shared render helper (§2.3), so every seeded node is
grounded. Relationship endpoints reference the canonical seeded object ids
directly (no fuzzy resolution needed — we know them exactly).

### 2.5 LLM enrichment — `enrich.ts` (`schema_interpreter` agent)

The deterministic seed has correct structure but cryptic names. The
`schema_interpreter` agent (purpose `enrichment`) takes the rendered schema (or
a compact table list) and returns, **per table id**, the semantics only:
`{ id, name, nameZh, description, descriptionZh, type: 'data'|'system',
properties: [{ name, nameZh, description }] }`. The merge is **by id**: it
**only fills** bilingual names / descriptions / classification / humanized
property labels. It never creates or drops a table — fidelity is guaranteed by
the deterministic seed. Batched (~20–40 tables per call) to stay within token
limits; the deterministic citation is untouched (enrichment doesn't need its
own citation).

> Size ceiling (M0): up to **300 tables** enriched synchronously within the
> single `objects` stage call. The ~20–40-table batches run with **bounded
> concurrency (~4–5)** to keep wall-clock under the 60 s serverless cap. Beyond
> 300 tables, M0 logs + caps; M3 moves the overflow onto the swarm-style cursor
> (one batch per request).

### 2.6 Pipeline integration — one optional field, two localized branches

- `StageContext.dbModel?: DbModel` ([context.ts](../api/ontology-gen/pipeline/context.ts)) —
  absent on document runs, so the existing pipeline is byte-identical.
- [stages/objects.ts](../api/ontology-gen/pipeline/stages/objects.ts) — when
  `ctx.dbModel` is present, `extractObjects` calls `seed-objects` then `enrich`
  instead of the LLM discovery path, and returns objects + relationships as
  usual. The orchestrator's `applyObjects` (ground / drop / score / merge) is
  unchanged.
- [stages/rules.ts](../api/ontology-gen/pipeline/stages/rules.ts) — when
  `ctx.dbModel` is present, `extractRules` returns the deterministic constraint
  rules from `seed-rules`.
- `actions` / `events` / `processes` stages: no proc/log evidence in an M0
  `DbModel` → they return `[]` gracefully. The run still reaches `complete`.

`contextFromOntology` ([index.ts](../api/ontology-gen/index.ts)) loads the
stashed `DbModel` into `ctx.dbModel`, mirroring how it already loads parsed
sources and the swarm state.

---

## 3. Schema, registry, API, and frontend changes (M0)

### 3.1 Schema mirror additions (both `types.ts` copies, structurally identical)

```ts
// OntologyMetadata — additive, optional (rides on metadata like terminology/swarm/hyper)
databaseProfile?: DatabaseProfile;

export interface DatabaseProfile {
  dialect: 'postgres' | 'mysql';
  sourceKind: 'live' | 'upload';
  schemas: string[];
  counts: { tables: number; views: number; foreignKeys: number; constraints: number };
  connectedAt: string;               // ISO-8601; NO credentials, ever
}

// OntologyRun — additive, optional; absent === document run
inputKind?: 'document' | 'database';
```

`DbModel` and friends live in `api/ontology-gen/db/types.ts` (backend-only IR,
not mirrored). `StageContext.dbModel?` is a pipeline-contract field, also not
mirrored.

### 3.2 Agent registry ([agents.ts](../api/ontology-gen/agents.ts))

Add **only** `schema_interpreter` in M0 (it is the only DB agent actually called;
`test-hyper`'s registry-completeness check must stay green, so unused agents are
not added pre-emptively):

```ts
{ id: 'schema_interpreter', label: { en: 'Schema interpreter', zh: '库表语义增强' },
  description: { en: 'Adds bilingual names, descriptions and data/system classification to database-derived objects, without inventing or dropping tables.',
                 zh: '为从数据库结构生成的对象补全中英文名称、描述与数据/系统分类，且不新增或删除表。' },
  purpose: 'enrichment', group: 'shared' }
```

`sql_logic_extractor` (M1) and `log_process_miner` (M2) are added with their
milestones. Every DB LLM call resolves its model via `ctxAgentLlm(ctx, '<id>')`,
per the routing rule.

### 3.3 API actions ([index.ts](../api/ontology-gen/index.ts))

New actions (writes are POST; the run lifecycle is **unchanged** and reused):

- `db.introspect` — body `{ dialect, connection: { host, port, database, user,
  password, ssl? }, options: { schemas?, includeComments? } }`. Connects
  read-only, builds `DbModel`, textualizes, persists evidence `ParsedSource`(s)
  + `SourceDocument`(s) `kind:'db'`, stashes `db_model:<id>`. Returns
  `{ sources, parsedRefs, preview, databaseProfile }`. **Credentials are used
  for the single connection and discarded — never persisted or logged.**
- `db.upload` — body `{ dialect, format: 'ddl' | 'information_schema_json',
  files: [...] }`. Same outputs via the parse path.
- `db.preview` — returns the textualized evidence so the user can audit exactly
  what will be sent to the LLM before running (can also be folded into the
  introspect/upload response).
- `run.start` (+ later `run.swarm.start` / `run.hyper.start`) — accepts the
  returned `parsedRefs` like any upload, plus `inputKind: 'database'`. Stashes
  the `DbModel` under the run. `run.step` then drives the (DB-branched) stages.

The store gains no new backend; `DbModel` is stashed as a `ParsedSource`-shaped
row (`text = JSON`) keyed `db_model:<id>`, exactly like `run_ontology:` /
`swarm_state:` — works on file / Supabase / memory alike.

### 3.4 Frontend

- A 4th input card on InputScreen: **Database**, with three sub-modes —
  connect (form), upload (DDL / JSON), paste (DDL). After ingest, a **preview**
  pane shows the evidence document(s) for audit before "Generate".
- `api.ts` gains `dbIntrospect` / `dbUpload` / `dbPreview`; the controller
  ([useOntologyRun](../src/ontology-generator/useOntologyRun.ts)) gains a
  `startFromDatabase` that calls the new action then drives `run.step` exactly
  like a live run.
- Reopen detection ([useOntologyRun](../src/ontology-generator/useOntologyRun.ts)):
  a saved ontology carrying `metadata.databaseProfile` reopens in database mode;
  the existing hyper-first / swarm / live ordering is otherwise unchanged.
- Everything else — Objects/Rules review screens, Graph, Publish, JSON editor,
  Settings, inference — is **reused unchanged**. DB-sourced ontologies are
  ordinary ontologies.

---

## 4. Security baseline (lands in M0)

- **Read-only, least privilege.** Guidance + docs steer users to a read-only
  role scoped to the catalog (and, in M2, selected logs).
- **Credential hygiene.** Credentials live only for the duration of a single
  introspection request: never persisted, never written to any log line, never
  included in any LLM payload. `databaseProfile` records *that* a connection
  happened, not *how*.
- **Egress boundary.** Only the rendered digest leaves the process to the LLM
  provider; the raw database stays local. `db.preview` makes the digest
  auditable before any model call.
- **PII.** M0 (schema) carries no row data. From M1/M2, sample values and log
  payloads are reduced to shapes / aggregates and column-level redaction before
  rendering; raw rows are never rendered or sent.

---

## 5. Verification (sustains the existing discipline)

- `npm run typecheck:api` — backend types (the DB module + mirror additions).
- `npm run test:hyper` — agent-registry completeness stays green (only
  `schema_interpreter` added in M0).
- `npm run build` — frontend typecheck + bundle (the new input card + mirror).
- **New** `npm run test:db` (`scripts/test-db.mts`, no DB, no LLM) — over fixture
  `DbModel`s, asserts:
  1. `seed-objects` / `seed-rules` produce the expected objects / relationships /
     constraint rules with correct ids, FK endpoints, types, enum extraction;
  2. `textualize` round-trips (every `DbColumn`/FK/check appears);
  3. **grounding survival** — every seeded citation `snippet` is verbatim-locatable
     in the textualized evidence (`normalize(text).includes(normalize(snippet))`),
     i.e. nothing the seed produces would be dropped by `dropUngroundedNodes`.
  This last check directly guards the linchpin property of §2.3.

A new fixture `DbModel` (a small Postgres + a small MySQL schema) anchors the
suite, mirroring `fixtures/ontology-golden/` usage by the other test scripts.

---

## 6. File tree (M0)

```
api/ontology-gen/db/
  types.ts                          # DbModel IR (backend leaf)
  connection.ts                     # read-only connect + credential hygiene (lazy pg/mysql2)
  introspect/information-schema.ts  # live PG+MySQL introspection (shared)
  parse/ddl.ts                      # lenient pg_dump/mysqldump DDL parser
  parse/info-schema-json.ts         # information_schema JSON export parser
  textualize.ts                     # DbModel → evidence ParsedSource (+ shared line render)
  seed-objects.ts                   # DbModel → ObjectType[] + Relationship[] (cited)
  seed-rules.ts                     # DbModel → constraint Rule[] (cited)
  enrich.ts                         # schema_interpreter LLM enrichment (by id, additive)
scripts/test-db.mts                 # deterministic test (no DB, no LLM)
fixtures/db-samples/                # fixture DbModels (pg + mysql)

# edits
api/ontology-gen/index.ts                       # db.introspect / db.upload / db.preview; db_model stash; inputKind
api/ontology-gen/pipeline/context.ts            # StageContext.dbModel?
api/ontology-gen/pipeline/stages/objects.ts     # ctx.dbModel branch → seed + enrich
api/ontology-gen/pipeline/stages/rules.ts       # ctx.dbModel branch → seed constraint rules
api/ontology-gen/agents.ts                      # + schema_interpreter
src/ontology/schema/types.ts                    # + DatabaseProfile, inputKind (mirror)
api/_shared/ontology-schema.ts                  # + DatabaseProfile, inputKind (mirror)
src/ontology-generator/InputScreen.tsx          # Database input card
src/ontology-generator/api.ts                   # dbIntrospect / dbUpload / dbPreview
src/ontology-generator/useOntologyRun.ts        # startFromDatabase + reopen detection
```

---

## 7. M1 / M2 / M3 — designed-for extension points (not built in M0)

- **M1 — procedures / triggers / views.** `DbModel` gains `routines` /
  `triggers` / `views[].definition`. `textualize.ts` emits a "Stored Procedures"
  evidence doc. A new `sql_logic_extractor` agent reads proc source and emits:
  rules (IF / validation / computed logic), actions (proc → action, params →
  `inputs`, DML → `side_effects` + `target_objects`, `AgentBinding` with
  `execution:'function'`, `integration = proc name`), and events (trigger →
  event). The `actions`/`events` stages gain a `ctx.dbModel` branch like §2.6.
- **M2 — logs.** A deterministic **process-mining** pre-pass parses audit-table
  rows / query logs / app logs into `(actor, operation, object, trace, ts)`
  tuples, builds a directly-follows graph, and emits **aggregates only**
  (operation-frequency, state-transition pairs, frequent sequences). Only the
  aggregates are textualized into an "Observed Operations" doc; raw rows/PII are
  never rendered. `log_process_miner` (synthesis) names/structures the
  processes; the `processes`/`events` stages gain the `ctx.dbModel.logProfile`
  branch.
- **M3 — deep modes + re-sync.** DB evidence flows into swarm/hyper (they
  already consume `ctx.parsed`); enrichment moves onto the swarm cursor for huge
  schemas; an incremental re-sync diffs a new `DbModel` against an existing
  ontology and proposes additive changes for review.

---

## 8. Resolved decisions (M0)

Settled in the 2026-06-26 design review:

1. **Upload happy path = DDL.** The UI primarily guides users to a
   `pg_dump --schema-only` / `mysqldump --no-data` DDL upload. The
   `information_schema` JSON export stays as a robust fallback for exotic DDL or
   users who cannot run the CLI.
2. **Large-schema ceiling = 300 tables.** M0 enriches up to 300 tables
   synchronously, running the ~20–40-table batches with bounded concurrency
   (~4–5) to stay under the 60 s cap. Beyond 300 tables: log + cap, and defer
   the overflow to the M3 swarm-style cursor.
3. **Object id = fully-qualified `schema.table`.**
   `makeId('object', '<schema>.<table>')` — collision-safe when two schemas
   share a table name, and a stable key for M3 incremental re-sync.
   Single-schema databases just carry a `public_`-style prefix.
4. **`information_schema` JSON export shape — defined during M0.** We publish the
   exact query + JSON row shape that `parse/info-schema-json.ts` consumes;
   finalized as an implementation detail, no further decision needed.
```
