// ============================================================================
//  DATABASE INGESTION — LLM semantic enrichment (schema_interpreter agent)
// ----------------------------------------------------------------------------
//  docs/DATABASE_INGESTION_DESIGN.md §2.5.
//
//  The deterministic seed (seed-objects.ts) has correct STRUCTURE but cryptic
//  identifiers (`t_ord_hdr`, `cust_id`). The `schema_interpreter` agent adds
//  SEMANTICS only — humanized bilingual names, descriptions, data/system
//  classification, and per-column bilingual labels — MERGED BY ID. It never
//  creates or drops a table/column: fidelity is owned by the seed, semantics by
//  the LLM.
//
//  The merge (`applyEnrichment`) and parse (`parseEnrichment`) are PURE +
//  deterministic (unit-tested in scripts/test-db.mts). The LLM wrapper
//  (`enrichObjects`) batches with bounded concurrency to respect the 60 s cap and
//  the 300-table M0 ceiling, and DEGRADES GRACEFULLY: with no `ctx.agentLlm`
//  resolver it skips entirely (keeping seed names), and any batch failure is a
//  logged note — never a throw, never a dropped object.
//
//  HARD RULES (NodeNext / strict TS): relative imports carry `.js`; schema types
//  are TYPE-ONLY; LLM work goes through executeLLMWithTracking via ctxAgentLlm.
// ============================================================================

import type { ObjectType } from '../../_shared/ontology-schema.js';
import { executeLLMWithTracking } from '../llm.js';
import type { ChatMessage, ExecuteLLMOptions } from '../llm.js';
import { ctxAgentLlm } from '../llm-router.js';
import type { StageContext } from '../pipeline/context.js';

/** M0 synchronous enrichment ceiling (design §2.5); beyond this we log + cap. */
const ENRICH_CAP = 300;
/** Tables per LLM call. */
const BATCH_SIZE = 30;
/** Concurrent batches (keeps wall-clock under the serverless cap). */
const CONCURRENCY = 4;

/**
 * The per-table semantics the schema_interpreter returns. Everything is
 * OPTIONAL: the merge fills only what the model provides, by id / column name.
 */
export interface ObjectEnrichment {
  id: string;
  name?: string;
  nameZh?: string;
  description?: string;
  descriptionZh?: string;
  type?: 'data' | 'system';
  properties?: { name: string; nameZh?: string; description?: string }[];
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Merge enrichment INTO the seeded objects, by id (and per-column by name).
 * PURE + idempotent. Only semantic fields are touched — id / primary_key /
 * property types / FK refs / sources / confidence / provenance are left intact,
 * and no table or column is ever created or removed. Returns the count applied.
 */
export function applyEnrichment(objects: ObjectType[], enrichments: ObjectEnrichment[]): number {
  const byId = new Map(objects.map((o) => [o.id, o] as const));
  let applied = 0;
  for (const e of enrichments) {
    if (!e || typeof e.id !== 'string') continue;
    const o = byId.get(e.id);
    if (!o) continue; // NEVER create a table the seed didn't produce
    if (nonEmpty(e.name)) o.name = e.name.trim();
    if (nonEmpty(e.nameZh)) o.nameZh = e.nameZh.trim();
    if (nonEmpty(e.description)) o.description = e.description.trim();
    if (nonEmpty(e.descriptionZh)) o.descriptionZh = e.descriptionZh.trim();
    if (e.type === 'data' || e.type === 'system') o.type = e.type;
    if (Array.isArray(e.properties)) {
      const propByName = new Map(o.properties.map((p) => [p.name, p] as const));
      for (const pe of e.properties) {
        if (!pe || typeof pe.name !== 'string') continue;
        const p = propByName.get(pe.name);
        if (!p) continue; // NEVER create a column the seed didn't produce
        if (nonEmpty(pe.nameZh)) p.nameZh = pe.nameZh.trim();
        if (nonEmpty(pe.description) && !p.description) p.description = pe.description.trim();
      }
    }
    applied += 1;
  }
  return applied;
}

/** Defensive JSON parse: strip code fences, slice first `{`..last `}`, read `enrichments`. */
export function parseEnrichment(raw: string): ObjectEnrichment[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return [];
  text = text.slice(first, last + 1);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { enrichments?: unknown }).enrichments)) {
      return (parsed as { enrichments: ObjectEnrichment[] }).enrichments;
    }
    return [];
  } catch {
    return [];
  }
}

/** Compact rendering of one batch for the prompt (id + raw name + columns + comment). */
function renderBatch(objects: ObjectType[]): string {
  return objects
    .map((o) => {
      const cols = o.properties.map((p) => `${p.name} (${p.type})`).join(', ');
      const comment = o.description ? `\n  comment: ${o.description}` : '';
      return `- id: ${o.id}\n  table: ${o.name}\n  columns: ${cols}${comment}`;
    })
    .join('\n');
}

/** Build the schema_interpreter prompt for one batch. */
function buildEnrichPrompt(objects: ObjectType[]): { system: string; user: string } {
  const system = [
    'You interpret a relational database schema. For each table you receive its raw',
    'identifier name and columns, you return BUSINESS SEMANTICS only. You MUST NOT',
    'invent or drop any table or column — return each table by the exact `id` given,',
    'and reference columns only by their exact `name`.',
    'For each table return: a humanized English `name` (PascalCase singular, e.g. "OrderHeader"),',
    'a Chinese `nameZh`, a one-line `description` + `descriptionZh`, a `type`',
    '("data" for a business entity, "system" for a config/technical/lookup table),',
    'and `properties` = humanized bilingual labels per column ({name, nameZh, description}).',
    'OUTPUT STRICT JSON ONLY, no prose, no code fences:',
    '{ "enrichments": [ { "id": "...", "name": "...", "nameZh": "...", "description": "...",',
    '  "descriptionZh": "...", "type": "data"|"system",',
    '  "properties": [ { "name": "...", "nameZh": "...", "description": "..." } ] } ] }',
  ].join('\n');
  const user = ['Tables to interpret:', '"""', renderBatch(objects), '"""'].join('\n');
  return { system, user };
}

/** Split `items` into fixed-size chunks. */
function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run `worker` over `items` with at most `limit` concurrent invocations. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const next = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]!);
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(next());
  await Promise.all(runners);
}

/**
 * Enrich the seeded objects in place via the schema_interpreter agent. No-op
 * (and a logged note) when there is no LLM resolver attached — keeping the seed
 * names — so tests and unconfigured contexts stay LLM-free. Batched + bounded;
 * every batch failure degrades to a note, never a throw.
 */
export async function enrichObjects(ctx: StageContext, objects: ObjectType[]): Promise<void> {
  if (objects.length === 0) return;
  if (!ctx.agentLlm) {
    ctx.log('[objects] schema_interpreter skipped (no LLM resolver) — keeping seed names');
    return;
  }

  const target = objects.length > ENRICH_CAP ? objects.slice(0, ENRICH_CAP) : objects;
  if (objects.length > ENRICH_CAP) {
    ctx.log(`[objects] schema_interpreter: enriching first ${ENRICH_CAP} of ${objects.length} tables (M0 ceiling)`);
  }

  const batches = chunkArray(target, BATCH_SIZE);
  await runPool(batches, CONCURRENCY, async (batch) => {
    try {
      const { system, user } = buildEnrichPrompt(batch);
      const llm = ctxAgentLlm(ctx, 'schema_interpreter', { inputChars: user.length });
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      const opts: ExecuteLLMOptions = {
        model: llm.model,
        provider: llm.provider as ExecuteLLMOptions['provider'],
        messages,
        temperature: 0.1,
        maxTokens: 8000,
        module: 'ontology_generator',
        actionName: 'ontology_db_enrich',
        userInfo: ctx.userInfo as ExecuteLLMOptions['userInfo'],
      };
      const raw = await executeLLMWithTracking(opts);
      const n = applyEnrichment(batch, parseEnrichment(raw));
      ctx.log(`[objects] schema_interpreter enriched ${n}/${batch.length} tables`);
    } catch (err) {
      ctx.log(`[objects] schema_interpreter batch failed (kept seed names): ${String(err)}`);
    }
  });
}
