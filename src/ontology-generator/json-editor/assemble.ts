// ============================================================================
//  assemble.ts — reassemble an editable candidate Ontology from per-layer edits.
//
//  The editor edits five layers independently; to run the *semantic* validator
//  (cross-references, action↔event inverse, stage order) we must stitch the
//  edited layers back over the loaded base envelope. These helpers are PURE and
//  non-mutating; they deliberately do NOT bump version/status/confidence — that
//  is saveOntology's job. The unchecked `unknown[] → layer` cast is safe because
//  validateOntology is defensive (designed to chew partially-invalid input).
//
//  Schema imports are TYPE-ONLY (erased at runtime) so the module is alias-free.
// ============================================================================

import type { Ontology } from '@/ontology/schema/types';
import { EDITOR_LAYERS, type EditorLayer } from './layers';

/** Per-layer parse outcome from the editor (mirrors parseLayer's success shape). */
export type LayerParse =
  | { ok: true; value: unknown[] }
  | { ok: false; error: string; offset?: number };

export type EditorLayers = Record<EditorLayer, LayerParse>;

/**
 * Merge successfully-parsed layers over `base`; a layer that failed to parse
 * falls back to its base value (so the candidate is always a complete envelope).
 */
export function assembleCandidate(base: Ontology, edited: EditorLayers): Ontology {
  const next = { ...base } as unknown as Record<EditorLayer, unknown[]> & Ontology;
  for (const layer of EDITOR_LAYERS) {
    const p = edited[layer];
    if (p && p.ok) {
      (next as Record<string, unknown>)[layer] = p.value;
    }
  }
  return next;
}

/**
 * Build a save-ready candidate from a base + already-parsed per-layer node
 * arrays. Untouched layers are carried through from `base`. Pure: does not bump
 * version/status/confidence and does not stamp updatedAt (the controller +
 * saveOntology own those).
 */
export function buildCandidateOntology(
  base: Ontology,
  edits: Partial<Record<EditorLayer, unknown[]>>,
): Ontology {
  const next = { ...base } as Ontology;
  for (const layer of EDITOR_LAYERS) {
    const nodes = edits[layer];
    if (nodes !== undefined) {
      (next as unknown as Record<string, unknown>)[layer] = nodes;
    }
  }
  return next;
}

/** Which ontology field owns nodes with this id prefix. */
export type OwnerLayer = EditorLayer | 'relationships' | 'ruleGroups' | 'unknown';

const PREFIX_OWNERS: { prefix: string; owner: OwnerLayer }[] = [
  { prefix: 'objectType:', owner: 'objects' },
  { prefix: 'ruleGroup:', owner: 'ruleGroups' }, // before 'rule:'
  { prefix: 'rule:', owner: 'rules' },
  { prefix: 'action:', owner: 'actions' },
  { prefix: 'event:', owner: 'events' },
  { prefix: 'process:', owner: 'processes' },
  { prefix: 'rel:', owner: 'relationships' },
];

/** Map a node id to the ontology field that owns it (by locked prefix). */
export function mapIdToLayer(id: string): OwnerLayer {
  if (typeof id !== 'string') return 'unknown';
  for (const { prefix, owner } of PREFIX_OWNERS) {
    if (id.startsWith(prefix)) return owner;
  }
  return 'unknown';
}
