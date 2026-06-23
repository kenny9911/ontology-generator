// ============================================================================
//  json-suggest.ts — schema-level detection + one-click fixes for the editor.
//
//  Where json-repair fixes *syntax*, this module fixes *shape*: missing required
//  fields, wrong id prefixes, invalid enum values, and bilingual gaps — the
//  things a human typing JSON gets wrong that still parse. `suggestFixes` reports
//  them; `applySuggestion` resolves one, non-mutatingly.
//
//  CLOSED VOCABULARIES below are a hand-maintained mirror of
//  src/ontology/schema/types.ts (RuleKind/Provenance/ReviewStatus/KeyRole/
//  Cardinality are type-only there, so they MUST be re-declared here). Section 15
//  of scripts/test-json-editor.mts drift-guards the DataType/Severity copies.
//  Schema imports are TYPE-ONLY (erased at runtime) so this module stays
//  alias-free for the tsx test.
// ============================================================================

import type { Stage } from '@/ontology/schema/types';
import { idPrefixFor } from './layers';

export type LayerKind = Stage;

// --- closed vocabs (mirror of types.ts) ------------------------------------
const DATA_TYPES = [
  'string', 'integer', 'decimal', 'money', 'boolean', 'date', 'datetime',
  'uuid', 'enum', 'reference', 'json', 'array',
] as const;
const SEVERITY_LEVELS = ['info', 'warn', 'block'] as const;
const KEY_ROLES = ['pk', 'fk', 'none'] as const;
/** Human-facing object property types (mirror of types.ts PROPERTY_TYPES). */
const PROPERTY_TYPES = [
  'String', 'Integer', 'Float', 'Boolean', 'Date', 'Timestamp', 'List<String>',
] as const;
const PROVENANCE = ['extracted', 'inferred', 'web_search', 'merged', 'human'] as const;
const REVIEW_STATUS = ['pending', 'accepted', 'edited', 'merged', 'rejected'] as const;
const RULE_KINDS = [
  'validation', 'constraint', 'derivation', 'state_transition', 'authorization', 'temporal',
] as const;

/** Exposed for the schema-drift test (Section 15). */
export const VOCABS = { DATA_TYPES, SEVERITY_LEVELS, KEY_ROLES, PROPERTY_TYPES, PROVENANCE, REVIEW_STATUS, RULE_KINDS } as const;

// ---------------------------------------------------------------------------
// id slugify — BYTE-IDENTICAL to api/_shared/ids.ts slugify()
// ---------------------------------------------------------------------------

const KNOWN_PREFIXES = [
  'objectType:', 'rel:', 'ruleGroup:', 'rule:', 'action:', 'event:',
  'process:', 'doc:', 'ontology:', 'inst:', 'term:',
];

function slugify(name: string): string {
  const slug = (name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  return slug.length > 0 ? slug : 'x';
}

function stripKnownPrefix(id: string): string {
  for (const p of KNOWN_PREFIXES) {
    if (id.startsWith(p)) return id.slice(p.length);
  }
  return id;
}

/** Coerce any id to the layer's locked prefix + slugified body. */
export function coerceIdPrefix(layer: LayerKind, id: string): string {
  const body = slugify(stripKnownPrefix(typeof id === 'string' ? id : ''));
  return idPrefixFor(layer) + body;
}

/** Coerce any value to a Bilingual {en,zh} (zh falls back to en). Never throws. */
export function coerceBilingual(v: unknown): { en: string; zh: string } {
  if (typeof v === 'string') return { en: v, zh: v };
  if (isPlainObject(v)) {
    const en = typeof v.en === 'string' ? v.en : typeof v.zh === 'string' ? v.zh : '';
    const zh = typeof v.zh === 'string' ? v.zh : en;
    return { en, zh };
  }
  return { en: '', zh: '' };
}

// ---------------------------------------------------------------------------
// Suggestion model
// ---------------------------------------------------------------------------

export type SchemaSuggestionKind =
  | 'missing_field'
  | 'bad_id_prefix'
  | 'bad_enum'
  | 'missing_bilingual_zh'
  | 'enum_without_values'
  | 'reference_without_target'
  | 'item_not_object';

export interface SchemaSuggestion {
  kind: SchemaSuggestionKind;
  level: 'error' | 'warn';
  /** Node index in the layer; -1 = layer-wide. */
  index: number;
  nodeId: string;
  /** Dotted field path on the node, e.g. "nameZh" or "attributes.0.type". */
  field: string;
  message: string;
  /** True ⇒ applySuggestion resolves it. */
  fixable: boolean;
  /** Internal: the immutable patch applied when fixable (path is node-relative). */
  patch?: { path: (string | number)[]; value: unknown };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}

/** Nearest vocab entry to `value` (prefix match first, then edit distance). */
function nearestEnum(value: string, vocab: readonly string[]): string {
  const v = value.toLowerCase();
  const prefix = vocab.find((x) => x.startsWith(v) || v.startsWith(x));
  if (prefix) return prefix;
  let best = vocab[0]!;
  let bestD = Infinity;
  for (const x of vocab) {
    const d = levenshtein(v, x);
    if (d < bestD) {
      bestD = d;
      best = x;
    }
  }
  return best;
}

function nameOf(node: Record<string, unknown>): string {
  if (typeof node.name === 'string') return node.name;
  if (isPlainObject(node.name) && typeof node.name.en === 'string') return node.name.en;
  return '';
}

// ---------------------------------------------------------------------------
// suggestFixes
// ---------------------------------------------------------------------------

/** Report schema-level issues + one-click fixes for one layer's nodes. */
export function suggestFixes(layer: unknown[], kind: LayerKind): SchemaSuggestion[] {
  const out: SchemaSuggestion[] = [];
  if (!Array.isArray(layer)) return out;

  // Collision-aware id minting (mirrors api/_shared/ids.ts makeId dedupe): an
  // applied id fix must never collide with another node's id in this layer.
  const existingIds = new Set<string>();
  for (const n of layer) {
    if (isPlainObject(n) && typeof n.id === 'string') existingIds.add(n.id);
  }
  const uniqueId = (want: string): string => {
    if (!existingIds.has(want)) return want;
    let k = 2;
    while (existingIds.has(`${want}-${k}`)) k++;
    return `${want}-${k}`;
  };

  layer.forEach((node, index) => {
    if (!isPlainObject(node)) {
      out.push({
        kind: 'item_not_object',
        level: 'error',
        index,
        nodeId: `#${index}`,
        field: '',
        message: `Item ${index} is not an object.`,
        fixable: false,
      });
      return;
    }
    const nodeId = typeof node.id === 'string' ? node.id : `#${index}`;

    // ---- id ----
    if (typeof node.id !== 'string' || node.id.length === 0) {
      out.push({
        kind: 'missing_field',
        level: 'error',
        index,
        nodeId,
        field: 'id',
        message: 'Node has no "id".',
        fixable: true,
        patch: { path: ['id'], value: uniqueId(coerceIdPrefix(kind, nameOf(node))) },
      });
    } else {
      const want = coerceIdPrefix(kind, node.id);
      if (want !== node.id) {
        const value = uniqueId(want);
        out.push({
          kind: 'bad_id_prefix',
          level: 'warn',
          index,
          nodeId,
          field: 'id',
          message: `Id should be "${value}" for the ${kind} layer.`,
          fixable: true,
          patch: { path: ['id'], value },
        });
      }
    }

    // ---- shared scalars ----
    if (typeof node.confidence !== 'number') {
      out.push(missing(index, nodeId, 'confidence', 0.5));
    }
    if (typeof node.reviewState !== 'string') {
      out.push(missing(index, nodeId, 'reviewState', 'pending'));
    } else if (!REVIEW_STATUS.includes(node.reviewState as (typeof REVIEW_STATUS)[number])) {
      out.push(badEnum(index, nodeId, 'reviewState', node.reviewState, REVIEW_STATUS));
    }
    if (typeof node.provenance !== 'string') {
      out.push(missing(index, nodeId, 'provenance', 'human'));
    } else if (!PROVENANCE.includes(node.provenance as (typeof PROVENANCE)[number])) {
      out.push(badEnum(index, nodeId, 'provenance', node.provenance, PROVENANCE));
    }
    if (!Array.isArray(node.sources)) {
      out.push(missing(index, nodeId, 'sources', []));
    }

    // ---- layer-specific ----
    if (kind === 'objects' || kind === 'events') {
      if (typeof node.nameZh !== 'string') {
        out.push({
          kind: 'missing_field',
          level: 'warn',
          index,
          nodeId,
          field: 'nameZh',
          message: 'Missing Chinese name "nameZh".',
          fixable: true,
          patch: { path: ['nameZh'], value: coerceBilingual(nameOf(node)).zh },
        });
      }
    }

    if (kind === 'objects' && Array.isArray(node.properties)) {
      node.properties.forEach((prop, ai) => {
        if (!isPlainObject(prop)) return;
        const pType = prop.type;
        const validType =
          typeof pType === 'string' &&
          (PROPERTY_TYPES.includes(pType as (typeof PROPERTY_TYPES)[number]) || /^List<.+>$/.test(pType));
        if (typeof pType === 'string' && !validType) {
          out.push(badEnumAttr(index, nodeId, ai, 'type', pType, PROPERTY_TYPES));
        }
        // A foreign-key property must carry a `references` id.
        if (prop.is_foreign_key === true && !prop.references) {
          out.push({
            kind: 'reference_without_target',
            level: 'error',
            index,
            nodeId,
            field: `properties.${ai}.references`,
            message: `Foreign-key property "${String(prop.name)}" has no references.`,
            fixable: false,
          });
        }
      });
    }

    if (kind === 'rules') {
      if (typeof node.severity !== 'string') {
        out.push(missing(index, nodeId, 'severity', 'warn'));
      } else if (!SEVERITY_LEVELS.includes(node.severity as (typeof SEVERITY_LEVELS)[number])) {
        out.push(badEnum(index, nodeId, 'severity', node.severity, SEVERITY_LEVELS));
      }
      if (typeof node.kind === 'string' && !RULE_KINDS.includes(node.kind as (typeof RULE_KINDS)[number])) {
        out.push(badEnum(index, nodeId, 'kind', node.kind, RULE_KINDS));
      }
    }
  });

  return out;
}

function missing(index: number, nodeId: string, field: string, value: unknown): SchemaSuggestion {
  return {
    kind: 'missing_field',
    level: 'warn',
    index,
    nodeId,
    field,
    message: `Missing "${field}".`,
    fixable: true,
    patch: { path: [field], value },
  };
}

function badEnum(
  index: number,
  nodeId: string,
  field: string,
  value: string,
  vocab: readonly string[],
): SchemaSuggestion {
  const nearest = nearestEnum(value, vocab);
  return {
    kind: 'bad_enum',
    level: 'error',
    index,
    nodeId,
    field,
    message: `"${value}" is not a valid ${field}; did you mean "${nearest}"?`,
    fixable: true,
    patch: { path: [field], value: nearest },
  };
}

function badEnumAttr(
  index: number,
  nodeId: string,
  ai: number,
  field: string,
  value: string,
  vocab: readonly string[],
): SchemaSuggestion {
  const nearest = nearestEnum(value, vocab);
  return {
    kind: 'bad_enum',
    level: 'error',
    index,
    nodeId,
    field: `properties.${ai}.${field}`,
    message: `Property ${field} "${value}" is invalid; did you mean "${nearest}"?`,
    fixable: true,
    patch: { path: ['properties', ai, field], value: nearest },
  };
}

// ---------------------------------------------------------------------------
// applySuggestion — non-mutating immutable patch
// ---------------------------------------------------------------------------

function setPath(target: unknown, path: (string | number)[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (typeof head === 'number') {
    const arr = Array.isArray(target) ? target.slice() : [];
    arr[head] = setPath(arr[head], rest, value);
    return arr;
  }
  const obj = isPlainObject(target) ? { ...target } : {};
  obj[head] = setPath(obj[head], rest, value);
  return obj;
}

/** Resolve one suggestion. Returns a NEW array (original untouched). */
export function applySuggestion(nodes: unknown[], s: SchemaSuggestion): unknown[] {
  if (!s.fixable || !s.patch) return nodes;
  if (!Array.isArray(nodes) || s.index < 0 || s.index >= nodes.length) return nodes;
  const next = nodes.slice();
  next[s.index] = setPath(next[s.index], s.patch.path, s.patch.value);
  return next;
}
