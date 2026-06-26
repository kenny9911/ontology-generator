// ============================================================================
//  DATABASE INGESTION — textualization (the citable evidence document)
// ----------------------------------------------------------------------------
//  docs/DATABASE_INGESTION_DESIGN.md §2.3 (THE LINCHPIN).
//
//  The entire downstream pipeline depends on `ParsedSource.text` and verbatim
//  citation grounding (groundSources / dropUngroundedNodes in
//  ../pipeline/ground.ts). A database has no "source prose", so we render the
//  `DbModel` into a deterministic, human-readable, line-oriented EVIDENCE
//  document and let BOTH the deterministic seed AND (later) the LLM cite into
//  that same text.
//
//  CRITICAL CONTRACT: the per-element line renderers below are the SINGLE source
//  of each citation's `snippet`. The seed builders (seed-objects.ts /
//  seed-rules.ts) import these same functions, so a seeded node's `snippet` is
//  byte-identical to a line in the evidence text — guaranteeing it is a verbatim
//  substring and therefore `quoteVerified = true` (the node survives grounding).
//  scripts/test-db.mts §"grounding survival" guards this property directly.
//
//  PURE + DETERMINISTIC: no LLM, no I/O, no Date.now()/Math.random(). Schema
//  types are imported TYPE-ONLY so this module runs alias-free under tsx.
//
//  HARD RULES (NodeNext / strict TS): relative project imports carry a `.js`
//  suffix; this module imports only the DbModel IR (same dir) + the ParsedSource
//  type (mirror).
// ============================================================================

import type { ParsedSource } from '../../_shared/ontology-schema.js';
import type { DbModel, DbTable, DbColumn, DbForeignKey, DbUnique, DbCheck, DbView, DbRoutine, DbTrigger } from './types.js';

// ---------------------------------------------------------------------------
// Evidence document identity. The seed cites into THIS document id, so it MUST
// match the ParsedSource.documentId that `buildSchemaEvidence` mints — that is
// the join key groundSources uses to locate the source text.
// ---------------------------------------------------------------------------

/** The schema evidence document id (M0's single "Database Schema" source). */
export const SCHEMA_DOC_ID = 'doc:db-schema';
/** Human display name for the schema evidence document. */
export const SCHEMA_DOC_NAME = 'Database Schema';

// ---------------------------------------------------------------------------
// Per-element line renderers — the citation snippets (the contract above).
// ---------------------------------------------------------------------------

/** Qualified table reference, e.g. "public.orders". */
export function tableRef(t: { schema: string; name: string }): string {
  return `${t.schema}.${t.name}`;
}

/**
 * The table header SNIPPET an ObjectType cites. Colon-terminated so a table name
 * can never be a prefix of another table's snippet (e.g. `orders` vs
 * `orders_archive`) regardless of render order — keeps grounding offsets exact.
 */
export function tableHeaderSnippet(t: DbTable): string {
  return `Table ${tableRef(t)}:`;
}

/** The full rendered table header LINE (snippet + optional comment tail). */
export function tableHeaderLine(t: DbTable): string {
  const head = tableHeaderSnippet(t);
  return t.comment ? `${head}  -- ${t.comment}` : head;
}

/** A column definition line: name, raw SQL type, nullability, key/default, comment. */
export function columnLine(t: DbTable, c: DbColumn): string {
  const parts = [c.name, c.sqlType.trim()];
  if (!c.nullable) parts.push('NOT NULL');
  if (t.primaryKey.includes(c.name)) parts.push('PRIMARY KEY');
  if (c.default !== undefined && c.default !== '') parts.push(`DEFAULT ${c.default}`);
  let line = parts.join(' ');
  if (c.comment) line += `  -- ${c.comment}`;
  return line;
}

/** A FOREIGN KEY constraint line (the snippet a Relationship cites). */
export function foreignKeyLine(fk: DbForeignKey): string {
  let line = `FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${fk.refSchema}.${fk.refTable}(${fk.refColumns.join(', ')})`;
  if (fk.onDelete) line += ` ON DELETE ${fk.onDelete}`;
  if (fk.onUpdate) line += ` ON UPDATE ${fk.onUpdate}`;
  return line;
}

/** A UNIQUE constraint line (the snippet a multi-column-unique Rule cites). */
export function uniqueLine(u: DbUnique): string {
  return `UNIQUE (${u.columns.join(', ')})`;
}

/** A CHECK constraint line (the snippet a constraint Rule cites — verbatim expression). */
export function checkLine(c: DbCheck): string {
  return `CHECK (${c.expression})`;
}

// ---------------------------------------------------------------------------
// Block + document rendering — composed from the line renderers above so the
// evidence text necessarily CONTAINS every citation snippet verbatim.
// ---------------------------------------------------------------------------

/** The view header SNIPPET a derived ObjectType cites (colon-terminated, like tables). */
export function viewHeaderSnippet(v: DbView): string {
  return `View ${v.schema}.${v.name}:`;
}

/** A view result-column line (views have no PK/constraints — just name + type). */
export function viewColumnLine(c: DbColumn): string {
  return c.comment ? `${c.name} ${c.sqlType.trim()}  -- ${c.comment}` : `${c.name} ${c.sqlType.trim()}`;
}

/** Render one view as an indented block (header + result columns, when known). */
export function renderView(v: DbView): string {
  const head = v.comment ? `${viewHeaderSnippet(v)}  -- ${v.comment}` : viewHeaderSnippet(v);
  const lines = [head];
  if (v.columns && v.columns.length > 0) {
    lines.push('  Columns:');
    for (const c of v.columns) lines.push(`    ${viewColumnLine(c)}`);
  }
  return lines.join('\n');
}

/** A routine signature line: the SNIPPET a proc-derived ActionType cites (colon-terminated). */
export function routineHeaderSnippet(r: DbRoutine): string {
  const params = r.params
    .map((p) => `${p.mode && p.mode !== 'IN' ? `${p.mode} ` : ''}${p.name} ${p.sqlType}`)
    .join(', ');
  return `${r.kind === 'function' ? 'Function' : 'Procedure'} ${r.schema}.${r.name}(${params}):`;
}

/** Render one routine as an indented block (signature + return + body source). */
export function renderRoutine(r: DbRoutine): string {
  const lines = [r.comment ? `${routineHeaderSnippet(r)}  -- ${r.comment}` : routineHeaderSnippet(r)];
  if (r.returns) lines.push(`  Returns: ${r.returns}`);
  if (r.definition && r.definition.trim()) {
    lines.push('  Body:');
    for (const ln of r.definition.split('\n')) lines.push(`    ${ln}`);
  }
  return lines.join('\n');
}

/** A trigger signature line: the SNIPPET a trigger-derived EventType cites (colon-terminated). */
export function triggerHeaderSnippet(t: DbTrigger): string {
  return `Trigger ${t.name} ${t.timing} ${t.events.join(' OR ')} ON ${t.schema}.${t.table}:`;
}

/** Render one trigger as an indented block (signature + body). */
export function renderTrigger(t: DbTrigger): string {
  const lines = [t.comment ? `${triggerHeaderSnippet(t)}  -- ${t.comment}` : triggerHeaderSnippet(t)];
  if (t.definition && t.definition.trim()) {
    lines.push('  Body:');
    for (const ln of t.definition.split('\n')) lines.push(`    ${ln}`);
  }
  return lines.join('\n');
}

/** Render one table as an indented block (header + columns + constraints). */
export function renderTable(t: DbTable): string {
  const lines: string[] = [tableHeaderLine(t)];

  lines.push('  Columns:');
  for (const c of t.columns) lines.push(`    ${columnLine(t, c)}`);

  const constraintLines: string[] = [];
  for (const chk of t.checks) constraintLines.push(`    ${checkLine(chk)}`);
  for (const u of t.uniques) constraintLines.push(`    ${uniqueLine(u)}`);
  for (const fk of t.foreignKeys) constraintLines.push(`    ${foreignKeyLine(fk)}`);
  if (constraintLines.length > 0) {
    lines.push('  Constraints:');
    lines.push(...constraintLines);
  }

  return lines.join('\n');
}

/**
 * Render the whole schema into the evidence text. A leading title gives the
 * document a stable head; tables are separated by a blank line so each block is
 * a self-contained, readable unit (and `numberSentences`/chunking treat blank
 * lines as paragraph breaks).
 */
export function textualizeSchema(model: DbModel): string {
  const routines = model.routines ?? [];
  const triggers = model.triggers ?? [];
  const header = [
    `Database Schema (${model.dialect})`,
    `Schemas: ${model.schemas.join(', ') || '(default)'}`,
    `Tables: ${model.tables.length}` +
      (model.views.length > 0 ? `, Views: ${model.views.length}` : '') +
      (routines.length > 0 ? `, Routines: ${routines.length}` : '') +
      (triggers.length > 0 ? `, Triggers: ${triggers.length}` : ''),
  ].join('\n');

  const blocks = model.tables.map(renderTable);
  const viewBlocks = model.views.map(renderView);
  const routineBlocks = routines.map(renderRoutine);
  const triggerBlocks = triggers.map(renderTrigger);
  return [header, ...blocks, ...viewBlocks, ...routineBlocks, ...triggerBlocks].join('\n\n');
}

/**
 * Build the persisted `ParsedSource` for the schema evidence document. Its
 * `documentId` is `SCHEMA_DOC_ID` — the exact join key the seed cites and that
 * groundSources indexes by. The handler (index.ts) mints the matching
 * `SourceDocument` (kind:'db') alongside this; here we stay pure and only
 * produce the parsed text.
 */
export function buildSchemaEvidence(model: DbModel): ParsedSource {
  const text = textualizeSchema(model);
  return {
    ref: 'parsed_db_schema',
    documentId: SCHEMA_DOC_ID,
    text,
  };
}
