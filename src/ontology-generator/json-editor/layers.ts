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

/** The array key each layer is wrapped under in the editor doc (matches the
 *  reference sample files; the "Workflow" tab == processes => "workflows"). */
const LAYER_DOC_KEY: Record<EditorLayer, string> = {
  objects: 'objects',
  rules: 'rules',
  actions: 'actions',
  events: 'events',
  processes: 'workflows',
};

export function layerDocKey(layer: EditorLayer): string {
  return LAYER_DOC_KEY[layer];
}

/** The nodes of one layer (never mutates `o`). Missing layer → []. */
export function extractLayer(o: Ontology, layer: EditorLayer): unknown[] {
  const arr = (o as unknown as Record<EditorLayer, unknown>)[layer];
  return Array.isArray(arr) ? (arr as unknown[]) : [];
}

/** Pretty-print a layer's node array as 2-space JSON (bare array). */
export function serializeLayer(arr: unknown[]): string {
  return JSON.stringify(arr, null, 2);
}

/** The per-layer metadata header (mirrors the reference sample files). */
export interface LayerMetadata {
  project_name: string;
  document_type: string;
  version: string;
  last_updated: string;
  description: string;
}

const LAYER_DOC_DESC: Record<EditorLayer, string> = {
  objects: 'Data objects (entities) — properties + relationships.',
  rules: 'Business rules governing decisions.',
  actions: 'Action definitions — inputs, steps, side effects.',
  events: 'Event definitions — payloads and state mutations.',
  processes: 'Workflow definitions — ordered action steps.',
};

/** Build the metadata header for a layer doc from the ontology envelope. */
export function layerMetadata(o: Ontology, layer: EditorLayer): LayerMetadata {
  const meta = (o as unknown as { metadata?: { updatedAt?: string; createdAt?: string } }).metadata;
  const updated = meta?.updatedAt || meta?.createdAt || '';
  return {
    project_name: o.name || String(o.id ?? '').replace(/^ontology:/, ''),
    document_type: '本体定义 (Ontology Schema)',
    version: String((o as unknown as { version?: number }).version ?? 1),
    last_updated: updated ? updated.slice(0, 10) : '',
    description: LAYER_DOC_DESC[layer],
  };
}

/** Pretty-print a layer as the metadata-wrapped editor doc:
 *  `{ "metadata": {...}, "<layer>": [ ...nodes ] }`. */
export function serializeLayerDoc(layer: EditorLayer, arr: unknown[], o: Ontology): string {
  return JSON.stringify({ metadata: layerMetadata(o, layer), [LAYER_DOC_KEY[layer]]: arr }, null, 2);
}

/** Unwrap a parsed editor doc to its node array. Accepts a bare array OR a
 *  `{ metadata?, <key>: [...] }` wrapper (the first array-valued, non-metadata
 *  property wins). Returns null when no node array is present. */
function unwrapDoc(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k !== 'metadata' && Array.isArray(v)) return v;
    }
  }
  return null;
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
  const unwrapped = unwrapDoc(value);
  if (!unwrapped) {
    return {
      ok: false,
      issues: [{ kind: 'not_an_array', message: 'Each layer must be a JSON array of nodes (optionally wrapped in { metadata, <layer>: [...] }).' }],
      repaired: repaired.changed,
      repairFixes,
    };
  }

  const nodes = unwrapped;
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
