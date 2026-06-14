// ============================================================================
//  diagnostics.ts — one unified diagnostics model for the editor's issue panel.
//
//  Folds the two validation tiers into a single sorted list:
//    • Tier 1 (per-tab): Monaco JSON language-service markers — syntax + the
//      registered per-layer JSON-Schema (missing fields, bad enums, bad id
//      prefix). `markersToDiagnostics`.
//    • Tier 2 (cross-tab): our canonical `validateOntology` over the reassembled
//      candidate — dangling refs, action↔event inverse, stage order, missing
//      sources. `issueToDiagnostic`.
//  `summarize` produces the panel summary + the save gate (`saveable`).
//
//  Monaco + schema imports are TYPE-ONLY; this module is screen-only (not in the
//  tsx unit suite), but stays runtime-light regardless.
// ============================================================================

import type { ValidationIssue, IssueKind } from '@/ontology/schema/validate';
import type * as monaco from 'monaco-editor';
import { EDITOR_LAYERS, type EditorLayer } from './layers';
import { mapIdToLayer, type OwnerLayer } from './assemble';

export type DiagSource = 'syntax' | 'schema' | 'semantic';

export interface Diagnostic {
  /** Stable identity for React keys + dedupe. */
  key: string;
  source: DiagSource;
  severity: 'error' | 'warn';
  layer: EditorLayer;
  nodeId: string;
  field?: string;
  kind: IssueKind | 'json_syntax' | 'json_schema';
  message: string;
  missingId?: string;
  /** Editor range (Tier 1 markers carry one; Tier 2 is located lazily). */
  range?: monaco.IRange;
  /** For cross-tab issues — the tab the missing/forward ref lives in. */
  relatedLayer?: EditorLayer;
}

export interface DiagnosticsSummary {
  errors: number;
  warnings: number;
  byLayer: Record<EditorLayer, { errors: number; warnings: number }>;
  /** All layers parse AND zero error-level diagnostics. */
  saveable: boolean;
  /** Sorted errors-first, then by layer order. */
  diagnostics: Diagnostic[];
}

const MONACO_ERROR = 8; // monaco.MarkerSeverity.Error

/** Map an id-owner to the editor tab that hosts it (rel→objects, ruleGroup→rules). */
function ownerToTab(owner: OwnerLayer): EditorLayer {
  switch (owner) {
    case 'relationships':
      return 'objects';
    case 'ruleGroups':
      return 'rules';
    case 'unknown':
      return 'objects';
    default:
      return owner;
  }
}

/** A Monaco JSON marker message that looks like a pure syntax error. */
function looksLikeSyntax(message: string): boolean {
  return /expected|unexpected|end of file|trailing comma|comments are not|colon expected|comma expected|value expected|property expected|close brace|close bracket/i.test(
    message,
  );
}

/** Convert one tab's Monaco markers into diagnostics. */
export function markersToDiagnostics(
  layer: EditorLayer,
  markers: monaco.editor.IMarkerData[],
): Diagnostic[] {
  return markers.map((mk, i) => {
    const severity: 'error' | 'warn' = mk.severity >= MONACO_ERROR ? 'error' : 'warn';
    const message = mk.message ?? 'JSON problem';
    const source: DiagSource = looksLikeSyntax(message) ? 'syntax' : 'schema';
    return {
      key: `${source}:${layer}:${mk.startLineNumber}:${mk.startColumn}:${i}`,
      source,
      severity,
      layer,
      nodeId: '',
      kind: source === 'syntax' ? 'json_syntax' : 'json_schema',
      message,
      range: {
        startLineNumber: mk.startLineNumber,
        startColumn: mk.startColumn,
        endLineNumber: mk.endLineNumber,
        endColumn: mk.endColumn,
      },
    };
  });
}

/** Convert one canonical ValidationIssue into a (cross-tab-aware) diagnostic. */
export function issueToDiagnostic(issue: ValidationIssue): Diagnostic {
  const layer = ownerToTab(mapIdToLayer(issue.from));
  const relatedLayer = issue.missingId ? ownerToTab(mapIdToLayer(issue.missingId)) : undefined;
  return {
    key: `semantic:${issue.from}:${issue.field ?? ''}:${issue.kind}:${issue.missingId ?? ''}`,
    source: 'semantic',
    severity: issue.level === 'error' ? 'error' : 'warn',
    layer,
    nodeId: issue.from,
    field: issue.field,
    kind: issue.kind,
    message: issue.message,
    missingId: issue.missingId,
    relatedLayer: relatedLayer && relatedLayer !== layer ? relatedLayer : undefined,
  };
}

const LAYER_ORDER: Record<EditorLayer, number> = EDITOR_LAYERS.reduce(
  (acc, l, i) => {
    acc[l] = i;
    return acc;
  },
  {} as Record<EditorLayer, number>,
);

/** Build the panel summary + save gate from a flat diagnostics list. */
export function summarize(diags: Diagnostic[], allParsed: boolean): DiagnosticsSummary {
  const byLayer = EDITOR_LAYERS.reduce(
    (acc, l) => {
      acc[l] = { errors: 0, warnings: 0 };
      return acc;
    },
    {} as Record<EditorLayer, { errors: number; warnings: number }>,
  );
  let errors = 0;
  let warnings = 0;
  for (const d of diags) {
    if (d.severity === 'error') {
      errors++;
      byLayer[d.layer].errors++;
    } else {
      warnings++;
      byLayer[d.layer].warnings++;
    }
  }
  const sorted = [...diags].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer];
  });
  // Save gate: every tab must parse AND the canonical (semantic) validator must
  // report no errors. Schema-shape hints (source 'schema') are advisory — they
  // surface with one-click fixes but never block a save.
  const semanticErrors = diags.some((d) => d.severity === 'error' && d.source === 'semantic');
  return {
    errors,
    warnings,
    byLayer,
    saveable: allParsed && !semanticErrors,
    diagnostics: sorted,
  };
}

/** Best-effort: locate a node (by `"id": "<nodeId>"`) in a model → an IRange. */
export function locateInModel(
  model: monaco.editor.ITextModel,
  nodeId: string,
  field?: string,
): monaco.IRange {
  const matches = model.findMatches(
    `"id"`,
    true, // searchOnlyEditableRange=false → whole doc; arg is `searchOnlyEditableRange`
    false,
    true,
    null,
    false,
  );
  // Prefer the line that mentions the exact nodeId.
  const idMatches = model.findMatches(JSON.stringify(nodeId), true, false, true, null, false);
  const target = idMatches[0] ?? matches[0];
  if (!target) {
    return { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  }
  const line = target.range.startLineNumber;
  // If a field is given, try to find it near/after the node id.
  if (field) {
    const fieldKey = field.split('.').pop() ?? field;
    const fieldMatches = model.findMatches(`"${fieldKey}"`, true, false, true, null, false);
    const after = fieldMatches.find((m) => m.range.startLineNumber >= line);
    if (after) return after.range;
  }
  return target.range;
}
