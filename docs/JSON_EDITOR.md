# JSON Editor

A VS Code-style JSON editor for viewing and editing a saved ontology's five
layers directly as JSON, with live validation and deterministic auto-correction.

It is reachable any time from the **TopBar braces button** (`{ }`, next to the
settings gear). It carries its own historical-ontology picker, so it works with
or without an active run.

## What it does

- **Five tabs**, one per ontology layer:
  **Data Objects · Rules · Actions · Events · Workflow**
  ("Workflow" is the `processes` layer.)
- Each tab edits that layer's JSON **array of nodes** in a **Monaco** editor —
  the actual VS Code engine, bundled to run **fully offline** (no CDN).
- **Pick from historical ontologies** (the `list`/`get` actions) and edit them.
- **Live validation** in two tiers (see below), surfaced inline (squiggles) and
  in a side **Issues & suggestions** panel with click-to-locate.
- **Auto error correction**: a one-click **Auto-fix** repairs broken JSON
  deterministically; **Fix all** also applies every auto-fixable schema
  suggestion on the active tab; per-issue **Apply** resolves one suggestion.
- **Save** reassembles the five layers into the ontology and persists it
  (append-only version bump). In demo mode edits stay in memory.

## Architecture

All logic lives under [`src/ontology-generator/json-editor/`](../src/ontology-generator/json-editor/),
with the screen at [`JsonEditorScreen.tsx`](../src/ontology-generator/JsonEditorScreen.tsx).

| Module | Responsibility |
|---|---|
| `json-repair.ts` | Pure, string-aware `repairJson(text)` + `lintJsonSyntax` + `tryParseJson`. The auto-correction engine. **Zero schema imports.** |
| `layers.ts` | `extractLayer` / `serializeLayer` / `parseLayer` / `mergeLayer` + `EDITOR_LAYERS` / `idPrefixFor`. The seam onto the five layers. |
| `json-suggest.ts` | Schema-level `suggestFixes` / `applySuggestion` + `coerceIdPrefix` / `coerceBilingual`. The one-click "shape" fixes Monaco can't apply. |
| `assemble.ts` | `buildCandidateOntology` / `assembleCandidate` / `mapIdToLayer`. Stitch edited layers back over the base for cross-tab validation + save. |
| `layer-schemas.ts` | Pragmatic per-layer JSON Schemas registered with Monaco for inline squiggles. |
| `monaco-setup.ts` | Offline Monaco wiring (Vite `?worker` workers, `loader.config`), `ontogen-dark` theme, schema registration. |
| `diagnostics.ts` | Maps Monaco markers + `ValidationIssue`s into one `Diagnostic` model + `summarize` (the save gate) + `locateInModel`. |

The screen uses **one Monaco instance with five persistent `ITextModel`s** (one
per layer, each at an `inmemory://ontogen/<layer>.json` URI so the per-layer
JSON Schema binds via `fileMatch`). Switching tabs swaps the active model;
each model keeps its own content, undo history, and inline squiggles. The screen
is **lazy-loaded** (`React.lazy`) so the ~Monaco engine ships as its own chunk,
off the main app bundle (≈234 kB main vs a ≈155 kB editor chunk + workers loaded
on first open).

### Validation tiers

1. **Inline (Monaco JSON language service)** — syntax errors + the registered
   per-layer JSON Schema (required fields, enums, id-prefix patterns). Live
   squiggles in the editor.
2. **Semantic (canonical)** — when every tab parses, the edited layers are
   reassembled into a candidate ontology and run through the project's
   `validateOntology` (referential integrity, action↔event inverse, stage
   ordering, missing sources, duplicate ids). These are the cross-tab issues.

Both tiers feed the one **Issues & suggestions** panel (sorted errors-first,
click to jump to the node). The **save gate** is: every tab parses **and** the
semantic validator reports no errors. Schema-shape hints are advisory (they show
with a one-click fix) and never block a save.

## Auto-repair (`repairJson`)

Deterministic, **never throws**, **string-aware** (commas / braces / `//` /
`True` inside a string literal are never touched), and **minimal** (transforms
run in a fixed order; the moment the text parses we stop). Already-valid JSON is
returned **byte-for-byte unchanged**. It deliberately performs **no
fabrication** — unbalanced braces or truncated input stay invalid (the red
squiggle guides the human); there is no bracket-balancing or sequence-wrapping.

Transforms (in order): strip BOM · strip block comments · strip line comments ·
normalize smart quotes · single → double quotes · quote unquoted keys · Python
literals (`True`/`False`/`None`) · non-JSON literals (`NaN`/`Infinity`/
`undefined` → `null`) · strip stray semicolons · remove trailing commas ·
insert missing commas (conservative, value-token-aware).

## Tests

`npm run test:editor` ([`scripts/test-json-editor.mts`](../scripts/test-json-editor.mts))
— a deterministic, no-LLM suite of **139 checks** across 15 sections: parse-guard
never-throw, repair fixers, **adversarial must-not-corrupt** cases (commas/quotes/
URLs/`/*`/Python-words/smart-quotes/braces inside strings; already-valid round
trips), idempotence, negative/unfixable (no fabrication), layer keys & prefixes,
extract/serialize, `parseLayer`, `mergeLayer`, round-trip invariants over all 10
golden fixtures × 5 layers, id+bilingual coercion, `suggestFixes`/`applySuggestion`,
candidate assembly, `validateOntology` integration, and a schema-drift smoke test.

## Maintenance notes

- `layer-schemas.ts` and `json-suggest.ts` each carry a **hand-maintained mirror**
  of the closed vocabularies in [`src/ontology/schema/types.ts`](../src/ontology/schema/types.ts)
  (`DataType`/`Severity`/`KeyRole`/`Provenance`/`ReviewStatus`/`RuleKind`). Keep
  them in sync; `test-json-editor.mts` §15 drift-guards the DataType/Severity
  copies against the canonical consts.
- `coerceIdPrefix`'s slugify is **byte-identical** to
  [`api/_shared/ids.ts`](../api/_shared/ids.ts) `slugify`. Change them together.
- The pure modules keep their `@/`-alias schema imports **type-only** so the tsx
  test can import them with no alias resolution.
