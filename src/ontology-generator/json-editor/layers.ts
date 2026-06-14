// ============================================================================
//  layers.ts — the editor's seam onto the five ontology layers.
//
//  Pure read/serialize/parse/write helpers the JsonEditorScreen uses to turn an
//  Ontology layer into editable JSON text and back. The five editor tabs map
//  1:1 onto the canonical Stage layers (the "Workflow" tab == `processes`).
//
//  Schema imports here are TYPE-ONLY (`@/` alias, erased at runtime), so the
//  module's runtime is alias-free and the tsx test can import it directly.
// ============================================================================

import type { Ontology, Stage } from '@/ontology/schema/types';
import { repairJson, tryParseJson, type RepairKind } from './json-repair';

/** The five editable layers, in canonical extraction order. */
export type EditorLayer = Stage; // 'objects'|'rules'|'actions'|'events'|'processes'

export const EDITOR_LAYERS: readonly EditorLayer[] = [
  'objects',
  'rules',
  'actions',
  'events',
  'processes',
] as const;

/** Alias used by the test catalog. */
export const LAYER_KEYS = EDITOR_LAYERS;

/** The locked id prefix for each layer's nodes (see api/_shared/ids.ts). */
const ID_PREFIX: Record<EditorLayer, string> = {
  objects: 'objectType:',
  rules: 'rule:',
  actions: 'action:',
  events: 'event:',
  processes: 'process:',
};

export function idPrefixFor(layer: EditorLayer): string {
  return ID_PREFIX[layer];
}

/** The nodes of one layer (never mutates `o`). Missing layer → []. */
export function extractLayer(o: Ontology, layer: EditorLayer): unknown[] {
  const arr = (o as unknown as Record<EditorLayer, unknown>)[layer];
  return Array.isArray(arr) ? (arr as unknown[]) : [];
}

/** Pretty-print a layer's node array as 2-space JSON. */
export function serializeLayer(arr: unknown[]): string {
  return JSON.stringify(arr, null, 2);
}

// ---------------------------------------------------------------------------
// parseLayer — text → nodes + structural issues. Lenient (auto-repairs first).
// ---------------------------------------------------------------------------

export type LayerIssueKind = 'syntax' | 'not_an_array' | 'item_not_object' | 'duplicate_id' | 'missing_id';

export interface LayerIssue {
  kind: LayerIssueKind;
  /** Node index within the layer (omitted for layer-wide issues like syntax). */
  index?: number;
  message: string;
}

export interface ParseLayerResult {
  /** True when the text parsed into an array of objects (usable nodes). */
  ok: boolean;
  /** The parsed node array (present iff the text parsed into an array). */
  nodes?: unknown[];
  /** Structural issues. `syntax`/`not_an_array`/`item_not_object` ⇒ ok:false;
   *  `duplicate_id`/`missing_id` are non-blocking (surfaced, but ok stays true). */
  issues: LayerIssue[];
  /** True when repairJson changed the text to make it parse. */
  repaired: boolean;
  /** The repair fix kinds applied, when repaired. */
  repairFixes: RepairKind[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse one layer's JSON text into nodes, auto-repairing common mistakes first.
 * Never throws. `ok` is true only when the text yields an array whose every
 * element is an object; id problems are reported as non-blocking issues.
 */
export function parseLayer(text: string): ParseLayerResult {
  const repaired = repairJson(text);
  const repairFixes = repaired.fixes.map((f) => f.kind);

  if (!repaired.ok) {
    return {
      ok: false,
      issues: [{ kind: 'syntax', message: repaired.errors[0]?.message ?? 'Invalid JSON' }],
      repaired: false,
      repairFixes,
    };
  }

  const parsed = tryParseJson(repaired.text);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: [{ kind: 'syntax', message: parsed.error }],
      repaired: false,
      repairFixes,
    };
  }

  const value = parsed.value;
  if (!Array.isArray(value)) {
    return {
      ok: false,
      issues: [{ kind: 'not_an_array', message: 'Each layer must be a JSON array of nodes.' }],
      repaired: repaired.changed,
      repairFixes,
    };
  }

  const nodes = value as unknown[];
  const issues: LayerIssue[] = [];
  const seenIds = new Set<string>();
  let allObjects = true;

  nodes.forEach((node, index) => {
    if (!isPlainObject(node)) {
      allObjects = false;
      issues.push({ kind: 'item_not_object', index, message: `Item ${index} is not an object.` });
      return;
    }
    const id = node.id;
    if (typeof id !== 'string' || id.length === 0) {
      issues.push({ kind: 'missing_id', index, message: `Item ${index} has no "id".` });
      return;
    }
    if (seenIds.has(id)) {
      issues.push({ kind: 'duplicate_id', index, message: `Duplicate id "${id}".` });
    } else {
      seenIds.add(id);
    }
  });

  return {
    ok: allObjects,
    nodes,
    issues,
    repaired: repaired.changed,
    repairFixes,
  };
}

/** Non-mutating: returns a NEW Ontology with `layer` replaced by `nodes`. */
export function mergeLayer(o: Ontology, layer: EditorLayer, nodes: unknown[]): Ontology {
  return { ...o, [layer]: nodes } as Ontology;
}
