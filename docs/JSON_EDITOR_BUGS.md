# JSON Editor — bug-hunt log

Two rounds of adversarial multi-agent review (each finding independently
verified by a separate skeptic agent) ran against the JSON Editor feature after
the initial green build. **9 distinct real bugs** were found and fixed; each has
a regression guard where it is unit-testable. After the fixes:
`npm run test:editor` = **145/145**, `npm run build` ✓, `npm run typecheck:api` ✓,
`npm run test:hyper` = 50/50 (no regression), plus a browser smoke (Monaco
renders offline with zero worker errors; the historical-ontology picker loads a
saved ontology's layers; tier-2 semantic validation populates the panel).

## Round 1 — 8 bugs

| # | Sev | Bug | Fix | Regression test |
|---|-----|-----|-----|-----------------|
| 1 | High | Failed server save was reported as "Saved" and cleared all dirty flags (silent data loss) — `ctrl.save()` swallowed errors and returned `void`. | `save()` now returns `Promise<boolean>`; `onSave` gates the baseline-reset / dirty-clear / "Saved" flash on `ok===true`, else flashes `saveFailed` and keeps edits. | (React handler) — covered by the new `save()` boolean contract |
| 2 | Med | Tabs spuriously re-marked "Unsaved" after a successful save (stale baseline: `setValue` fired the sync change-listener before `baseline` was updated). | Set `ts.baseline = text` **before** `model.setValue(text)` in the same-id refresh branch + explicit `setDirtyLayer(layer,false)`. | (React effect) |
| 3 | Med | Picker "discard & reload" was a no-op for dirty tabs when re-selecting the currently-open ontology (same id → "refresh non-dirty" branch skipped dirty tabs). | `onPick` sets `loadedIdRef.current = null` before `loadSaved`, forcing the full `buildModels` rebuild (which resets dirty). | (React handler) |
| 4 | Low | One-click id-prefix / missing-id fix could introduce a duplicate id (`coerceIdPrefix` was collision-blind, unlike `makeId`). | `suggestFixes` mints id-fix values through a collision-aware `uniqueId()` (`-2`/`-3` suffix) against the layer's existing ids. | `test:editor` 12.13, 12.14 |
| 5 | Low | Editor stayed editable during the Save await; mid-save keystrokes were absorbed into the new baseline and lost dirty tracking. | A `useEffect` sets Monaco `readOnly` while `busy`. (Also subsumed by fix #1's success-gating.) | (React) |
| 6 | Med | `lintJsonSyntax` was O(n²) (scan-from-0 per error) — froze the UI thread on large invalid JSON. | Precompute newline offsets once; resolve each error's line/column via binary search (O(n)). | `test:editor` 5.9 (time-bounded) |
| 7 | Low | A doc with both an unquoted key **and** a missing comma stayed unrepaired (single-pass pipeline; `unquoted_key` ran before the comma that would expose the next key). | `repairJson` now iterates the pipeline to a fixpoint (cap 5 rounds, break on no-change/parse) — preserving never-throw + no-fabrication. | `test:editor` 2.18, 2.19 |
| 8 | Low | `@monaco-editor/react`'s auto-created model was orphaned on every editor mount (slow leak). | `onMount` disposes the wrapper's auto-model after swapping in our named model (guarded against disposing our own). | (lifecycle) |

## Round 2 — 1 bug (and confirmed round-1 fixes introduced no regressions)

| # | Sev | Bug | Fix | Regression test |
|---|-----|-----|-----|-----------------|
| 9 | Low | Rapidly applying two **stale** id-fix suggestions from one panel snapshot (within the 220ms recompute debounce) could create a duplicate id — `onApplySuggestion` applied the stale `item.suggestion` (whereas `onFixAll` re-derives). Bounded: the next recompute's semantic validator surfaces it and blocks Save. | `onApplySuggestion` re-derives `suggestFixes` against the current model and applies the matching fresh suggestion (whose `uniqueId` sees prior applies) — matching `onFixAll`. | `test:editor` 12.15 |

## Notes

- The repair engine's **safety contract is unchanged** by the fixpoint loop:
  already-valid JSON is still returned byte-for-byte unchanged, the engine never
  throws, and it never fabricates (truncated/unbalanced input still ends
  `ok:false`) — locked by `test:editor` §3 (adversarial), §4 (idempotence), §5
  (unfixable, incl. the time-bounded large-input guard).
- Round 2 also re-verified fixes #1–#8 against the code and found no regressions;
  several of its agents were rate-limited mid-run, so the round-2 net is "fixes
  hold + 1 new edge case," consistent with the find-rate tailing off.
