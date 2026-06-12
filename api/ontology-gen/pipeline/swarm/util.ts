// ============================================================================
//  DEEP-SWARM — shared coercion + id helpers (pure; no LLM, no project cycles).
// ============================================================================

import type { Bilingual, SourceRef } from '../../../_shared/ontology-schema.js';

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Coerce to a Bilingual; tolerates a plain string or a partial {en,zh} object. */
export function bil(v: unknown, fallback = ''): Bilingual {
  if (typeof v === 'string') return { en: v, zh: v || fallback };
  const r = asRecord(v);
  const en = str(r.en) || str(r.zh) || fallback;
  const zh = str(r.zh) || str(r.en) || fallback;
  return { en, zh };
}

/** Optional Bilingual — undefined when neither language is present. */
export function bilOpt(v: unknown): Bilingual | undefined {
  if (v === undefined || v === null) return undefined;
  const b = bil(v);
  return b.en || b.zh ? b : undefined;
}

const SLUG_RE = /[^a-z0-9.-]+/g;
export function slug(s: string): string {
  const out = (s || '')
    .toLowerCase()
    .replace(SLUG_RE, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  return out || 'x';
}

/**
 * Mint a unique, prefixed, swarm-internal id (e.g. `gap:`, `q:`, `persona:`,
 * `uc:`, `exp:`). Strips a leading `<prefix>:` from `hint` so a model-supplied
 * id round-trips cleanly. Records the result in `taken`.
 */
export function localId(prefix: string, hint: string, taken: Set<string>): string {
  let h = (hint || '').trim();
  if (h.startsWith(`${prefix}:`)) h = h.slice(prefix.length + 1);
  const base = `${prefix}:${slug(h)}`;
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  const id = `${base}-${n}`;
  taken.add(id);
  return id;
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Coerce a raw `sources` value to SourceRef[], keeping only entries with a snippet. */
export function parseSourceRefs(v: unknown, docName: string): SourceRef[] {
  const out: SourceRef[] = [];
  for (const raw of asArray(v)) {
    const r = asRecord(raw);
    const snippet = str(r.snippet);
    if (!snippet) continue;
    out.push({
      documentId: str(r.documentId),
      documentName: str(r.documentName) || docName,
      snippet,
      section: str(r.section) || undefined,
    });
  }
  return out;
}
