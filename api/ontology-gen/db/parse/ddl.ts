// ============================================================================
//  DATABASE INGESTION — lenient DDL parser (pg_dump / mysqldump -> DbModel)
// ----------------------------------------------------------------------------
//  docs/DATABASE_INGESTION_DESIGN.md §2.2 (upload happy path).
//
//  PURE + DETERMINISTIC (no DB, no LLM, no I/O). Parses a schema-only dump into
//  the dialect-neutral `DbModel`. It is intentionally LENIENT and best-effort:
//  a statement it cannot parse is skipped (never throws), matching the tenet
//  "connection / parse failures degrade to logged notes".
//
//  Handles both dump shapes:
//    - PostgreSQL (`pg_dump --schema-only`): `CREATE TABLE schema.t (...)` with
//      PK / UNIQUE / FK in separate `ALTER TABLE ... ADD CONSTRAINT` statements,
//      and table/column comments in `COMMENT ON ...` statements.
//    - MySQL (`mysqldump --no-data`): backtick-quoted `CREATE TABLE \`t\` (...)`
//      with PK / UNIQUE KEY / FOREIGN KEY / CHECK inlined in the body, `enum(...)`
//      column types, and the table comment in the trailing `) ... COMMENT='...'`.
//
//  HARD RULES (NodeNext / strict TS): relative imports carry `.js`; the DbModel
//  IR is the only import. No schema-mirror dependency.
// ============================================================================

import type { DbModel, DbTable, DbColumn, DbForeignKey, DbDialect, DbView } from '../types.js';

export interface ParseDdlOptions {
  dialect: DbDialect;
  /** Schema for unqualified table names (MySQL dumps don't qualify). Default 'public'. */
  defaultSchema?: string;
}

// ---------------------------------------------------------------------------
// Low-level scanners — all quote-aware ('...', "...", `...`) and paren-aware.
// ---------------------------------------------------------------------------

/** Strip `-- `, `#`, and `/* … *​/` comments while preserving string/ident quotes. */
function stripComments(sql: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      out += ch;
      if (ch === '\\' && quote !== '`' && i + 1 < sql.length) { out += sql[++i]; continue; }
      if (ch === quote) { if (sql[i + 1] === quote) { out += sql[++i]; continue; } quote = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '#') { while (i < sql.length && sql[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && sql[i + 1] === '*') { i += 2; while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++; i++; out += ' '; continue; }
    out += ch;
  }
  return out;
}

/** Split into statements on top-level `;` (outside quotes + parens). */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote !== '`' && i + 1 < sql.length) { cur += sql[++i]; continue; }
      if (ch === quote) { if (sql[i + 1] === quote) { cur += sql[++i]; continue; } quote = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (ch === ';' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Split `s` on a single-char separator at paren-depth 0, outside quotes. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote !== '`' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === quote) { if (s[i + 1] === quote) { cur += s[++i]; continue; } quote = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Whitespace-tokenize at paren-depth 0, keeping `(...)` groups and quotes attached. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote !== '`' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === quote) { if (s[i + 1] === quote) { cur += s[++i]; continue; } quote = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (/\s/.test(ch) && depth === 0) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Index of the first `(` outside quotes, or -1. */
function firstParen(s: string): number {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === '\\' && quote !== '`') { i++; continue; }
      if (ch === quote) { if (s[i + 1] === quote) { i++; continue; } quote = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') return i;
  }
  return -1;
}

/** Given the index of a `(`, return the text inside its matching `)` and the tail after. */
function extractParenGroup(s: string, openIdx: number): { inside: string; after: string } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === '\\' && quote !== '`') { i++; continue; }
      if (ch === quote) { if (s[i + 1] === quote) { i++; continue; } quote = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return { inside: s.slice(openIdx + 1, i), after: s.slice(i + 1) }; }
  }
  return { inside: s.slice(openIdx + 1), after: '' };
}

// ---------------------------------------------------------------------------
// Identifier / literal helpers.
// ---------------------------------------------------------------------------

function unquoteIdent(s: string): string {
  let t = s.trim();
  if (t.length >= 2) {
    const a = t[0]!;
    const b = t[t.length - 1]!;
    if (a === '"' && b === '"') return t.slice(1, -1).replace(/""/g, '"');
    if (a === '`' && b === '`') return t.slice(1, -1).replace(/``/g, '`');
    if (a === '[' && b === ']') return t.slice(1, -1);
  }
  return t;
}

/** Unwrap a SQL string literal ('…' or "…"); returns '' when not a string literal. */
function stripStringLiteral(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return t.slice(1, -1).replace(/""/g, '"');
  return '';
}

/** Unwrap a default value if it is quoted; otherwise return it raw. */
function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === "'" && t.endsWith("'")) || (t[0] === '"' && t.endsWith('"')))) return t.slice(1, -1);
  return t;
}

function extractQuotedList(s: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1]!.replace(/''/g, "'"));
  return out;
}

/** Drop redundant outer parens, e.g. `((total_amount >= 0))` -> `total_amount >= 0`. */
function stripRedundantParens(expr: string): string {
  let e = expr.trim();
  while (e.startsWith('(') && e.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < e.length; i++) {
      if (e[i] === '(') depth++;
      else if (e[i] === ')') { depth--; if (depth === 0 && i !== e.length - 1) { wraps = false; break; } }
    }
    if (!wraps) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}

function wordIn(haystack: string, word: string): boolean {
  if (!word) return false;
  const w = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${w}([^A-Za-z0-9_]|$)`).test(haystack);
}

/** `schema.table` / `"s"."t"` / `\`t\`` / `t` -> {schema, name} (default schema applied). */
function parseQualifiedName(raw: string, defaultSchema: string): { schema: string; name: string } {
  const parts = splitTopLevel(raw.trim(), '.').map(unquoteIdent).filter(Boolean);
  if (parts.length >= 2) return { schema: parts[parts.length - 2]!, name: parts[parts.length - 1]! };
  return { schema: defaultSchema, name: parts[0] ?? raw.trim() };
}

// ---------------------------------------------------------------------------
// Item parsing (a CREATE-body item or an ALTER ADD clause).
// ---------------------------------------------------------------------------

/** The leading classification keyword of a body item ('COLUMN' for a column def). */
function leadingKeyword(item: string): string {
  const t = item.trim();
  if (/^["`[]/.test(t)) return 'COLUMN';
  const m = /^([A-Za-z_]+)/.exec(t);
  return m ? m[1]!.toUpperCase() : '';
}

/** Strip a leading `CONSTRAINT <name>` and return the name + the remainder. */
function stripConstraintPrefix(item: string): { name?: string; rest: string } {
  const m = /^constraint\s+(`(?:[^`]|``)*`|"(?:[^"]|"")*"|\[[^\]]*\]|[A-Za-z0-9_$]+)\s+([\s\S]*)$/i.exec(item.trim());
  if (m) return { name: unquoteIdent(m[1]!), rest: m[2]! };
  return { rest: item.replace(/^constraint\s+/i, '').trim() };
}

function firstParenCols(s: string): string[] {
  const p = firstParen(s);
  if (p < 0) return [];
  return splitTopLevel(extractParenGroup(s, p).inside, ',').map((c) => unquoteIdent(c.trim())).filter(Boolean);
}

function firstParenExpr(s: string): string {
  const p = firstParen(s);
  if (p < 0) return '';
  return stripRedundantParens(extractParenGroup(s, p).inside.trim());
}

function parseForeignKey(item: string, defaultSchema: string, name?: string): DbForeignKey | null {
  const idx = item.toUpperCase().indexOf('FOREIGN KEY');
  if (idx < 0) return null;
  const afterFk = item.slice(idx + 'FOREIGN KEY'.length);
  const cp = firstParen(afterFk);
  if (cp < 0) return null;
  const childGroup = extractParenGroup(afterFk, cp);
  const columns = splitTopLevel(childGroup.inside, ',').map((c) => unquoteIdent(c.trim())).filter(Boolean);
  const refM = /references\s+/i.exec(childGroup.after);
  if (!refM) return null;
  const afterRef = childGroup.after.slice(refM.index + refM[0].length);
  const rp = firstParen(afterRef);
  if (rp < 0) return null;
  const refName = afterRef.slice(0, rp).trim();
  const refGroup = extractParenGroup(afterRef, rp);
  const refColumns = splitTopLevel(refGroup.inside, ',').map((c) => unquoteIdent(c.trim())).filter(Boolean);
  const ref = parseQualifiedName(refName, defaultSchema);
  const fk: DbForeignKey = { columns, refSchema: ref.schema, refTable: ref.name, refColumns };
  if (name) fk.name = name;
  const od = /on\s+delete\s+(cascade|restrict|set\s+null|no\s+action|set\s+default)/i.exec(refGroup.after);
  if (od) fk.onDelete = od[1]!.toUpperCase().replace(/\s+/g, ' ');
  const ou = /on\s+update\s+(cascade|restrict|set\s+null|no\s+action|set\s+default)/i.exec(refGroup.after);
  if (ou) fk.onUpdate = ou[1]!.toUpperCase().replace(/\s+/g, ' ');
  return fk;
}

const TYPE_BOUNDARY = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'COMMENT',
  'AUTO_INCREMENT', 'GENERATED', 'COLLATE', 'CONSTRAINT', 'KEY',
]);

function parseColumn(item: string): DbColumn | null {
  const trimmed = item.trim();
  if (!trimmed) return null;
  const toks = tokenize(trimmed);
  if (toks.length === 0) return null;
  const name = unquoteIdent(toks[0]!);
  if (!name) return null;

  const typeToks: string[] = [];
  for (let i = 1; i < toks.length; i++) {
    const up = toks[i]!.replace(/\(.*$/, '').toUpperCase();
    if (TYPE_BOUNDARY.has(up)) break;
    typeToks.push(toks[i]!);
  }
  const sqlType = typeToks.join(' ').trim() || 'unknown';

  const col: DbColumn = { name, sqlType, nullable: !/\bNOT\s+NULL\b/i.test(trimmed) };

  const dIdx = toks.findIndex((t) => t.toUpperCase() === 'DEFAULT');
  if (dIdx >= 0 && toks[dIdx + 1]) col.default = stripQuotes(toks[dIdx + 1]!);

  const cIdx = toks.findIndex((t) => t.toUpperCase() === 'COMMENT');
  if (cIdx >= 0 && toks[cIdx + 1]) { const cm = stripStringLiteral(toks[cIdx + 1]!); if (cm) col.comment = cm; }

  const low = sqlType.toLowerCase();
  if (low.startsWith('enum') || low.startsWith('set(') || low.startsWith('set ')) {
    const vals = extractQuotedList(sqlType);
    if (vals.length) col.enumValues = vals;
  }
  return col;
}

/** Apply one CREATE-body item or ALTER ADD clause to a table (mutates `t`). */
function applyTableItem(t: DbTable, item: string, defaultSchema: string, allowColumns: boolean): void {
  let work = item.trim();
  if (!work) return;
  let kw = leadingKeyword(work);
  let cname: string | undefined;
  if (kw === 'CONSTRAINT') {
    const sp = stripConstraintPrefix(work);
    cname = sp.name;
    work = sp.rest;
    kw = leadingKeyword(work);
  }
  switch (kw) {
    case 'PRIMARY': {
      const cols = firstParenCols(work);
      if (cols.length) t.primaryKey = cols;
      return;
    }
    case 'UNIQUE': {
      const cols = firstParenCols(work);
      if (cols.length) t.uniques.push(cname ? { name: cname, columns: cols } : { columns: cols });
      return;
    }
    case 'FOREIGN': {
      const fk = parseForeignKey(work, defaultSchema, cname);
      if (fk) t.foreignKeys.push(fk);
      return;
    }
    case 'CHECK': {
      const expr = firstParenExpr(work);
      if (expr) t.checks.push(cname ? { name: cname, expression: expr } : { expression: expr });
      return;
    }
    case 'KEY':
    case 'INDEX':
    case 'FULLTEXT':
    case 'SPATIAL':
    case 'PERIOD':
    case 'EXCLUDE':
      return; // plain index / exotic — not an ontology constraint
    default: {
      if (allowColumns) {
        const col = parseColumn(kw === 'COLUMN' ? work.replace(/^column\s+/i, '') : work);
        if (col) t.columns.push(col);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Statement handlers.
// ---------------------------------------------------------------------------

const CREATE_TABLE_RE = /^create\s+(?:global\s+|local\s+|temporary\s+|temp\s+|unlogged\s+)*table\s+(?:if\s+not\s+exists\s+)?/i;

function parseCreateTable(stmt: string, defaultSchema: string): DbTable | null {
  const m = CREATE_TABLE_RE.exec(stmt);
  if (!m) return null;
  const rest = stmt.slice(m[0].length);
  const open = firstParen(rest);
  if (open < 0) return null;
  const namePart = rest.slice(0, open).trim();
  const { inside, after } = extractParenGroup(rest, open);
  const { schema, name } = parseQualifiedName(namePart, defaultSchema);
  if (!name) return null;

  const t: DbTable = { schema, name, columns: [], primaryKey: [], uniques: [], checks: [], foreignKeys: [] };
  for (const item of splitTopLevel(inside, ',').map((s) => s.trim()).filter(Boolean)) {
    applyTableItem(t, item, defaultSchema, true);
  }
  // MySQL trailing table options: ) ENGINE=... COMMENT='...'
  const cm = /\bcomment\s*=?\s*('(?:[^']|'')*'|"(?:[^"]|"")*")/i.exec(after);
  if (cm) { const v = stripStringLiteral(cm[1]!); if (v) t.comment = v; }
  return t;
}

const tableKey = (schema: string, name: string): string => `${schema}.${name}`;

function applyAlter(stmt: string, tables: Map<string, DbTable>, defaultSchema: string): void {
  const m = /^alter\s+table\s+(?:only\s+)?(\S+)\s+([\s\S]*)$/i.exec(stmt);
  if (!m) return;
  const { schema, name } = parseQualifiedName(m[1]!, defaultSchema);
  const t = tables.get(tableKey(schema, name));
  if (!t) return;
  for (const clause of splitTopLevel(m[2]!, ',').map((s) => s.trim()).filter(Boolean)) {
    const add = /^add\s+(?:column\s+)?([\s\S]*)$/i.exec(clause);
    if (!add) continue; // OWNER TO / ENABLE / etc. — ignore
    applyTableItem(t, add[1]!.trim(), defaultSchema, false);
  }
}

function applyComment(stmt: string, tables: Map<string, DbTable>, defaultSchema: string): void {
  const m = /^comment\s+on\s+(table|column)\s+([\s\S]+?)\s+is\s+([\s\S]+)$/i.exec(stmt);
  if (!m) return;
  const val = stripStringLiteral(m[3]!.trim());
  if (!val) return;
  if (m[1]!.toLowerCase() === 'table') {
    const { schema, name } = parseQualifiedName(m[2]!, defaultSchema);
    const t = tables.get(tableKey(schema, name));
    if (t) t.comment = val;
    return;
  }
  const parts = splitTopLevel(m[2]!.trim(), '.').map(unquoteIdent).filter(Boolean);
  if (parts.length < 2) return;
  const col = parts[parts.length - 1]!;
  const name = parts[parts.length - 2]!;
  const schema = parts.length >= 3 ? parts[parts.length - 3]! : defaultSchema;
  const t = tables.get(tableKey(schema, name));
  if (!t) return;
  const c = t.columns.find((x) => x.name === col);
  if (c) c.comment = val;
}

const CREATE_VIEW_RE = /^create\s+(?:or\s+replace\s+)?(?:algorithm\s*=\s*\w+\s+)?(?:definer\s*=\s*\S+\s+)?(?:sql\s+security\s+\w+\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?/i;

/** Parse `CREATE [OR REPLACE] VIEW name AS <select>` into a DbView (name + definition;
 *  result columns are not derivable from raw DDL, so the view seeds as a column-less object). */
function parseCreateView(stmt: string, defaultSchema: string): DbView | null {
  const m = CREATE_VIEW_RE.exec(stmt);
  if (!m) return null;
  const rest = stmt.slice(m[0].length).trim();
  const am = /^(\S+)\s+as\s+([\s\S]+)$/i.exec(rest);
  if (!am) return null;
  const { schema, name } = parseQualifiedName(am[1]!, defaultSchema);
  if (!name) return null;
  const v: DbView = { schema, name };
  const def = am[2]!.trim();
  if (def) v.definition = def;
  return v;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Parse a schema-only SQL dump into a `DbModel`. Lenient + best-effort: every
 * statement is parsed in isolation and a failure skips just that statement.
 */
export function parseDdl(sql: string, opts: ParseDdlOptions): DbModel {
  const dialect = opts.dialect;
  let currentSchema = opts.defaultSchema || 'public';

  const stmts = splitStatements(stripComments(sql));
  const tables = new Map<string, DbTable>();
  const order: string[] = [];
  const views = new Map<string, DbView>();

  for (const stmt of stmts) {
    try {
      if (/^use\s+/i.test(stmt)) {
        currentSchema = unquoteIdent(stmt.replace(/^use\s+/i, '').trim()) || currentSchema;
      } else if (CREATE_TABLE_RE.test(stmt)) {
        const t = parseCreateTable(stmt, currentSchema);
        if (t) {
          const key = tableKey(t.schema, t.name);
          if (!tables.has(key)) order.push(key);
          tables.set(key, t);
        }
      } else if (CREATE_VIEW_RE.test(stmt)) {
        const v = parseCreateView(stmt, currentSchema);
        if (v) views.set(`${v.schema}.${v.name}`, v);
      } else if (/^alter\s+table\b/i.test(stmt)) {
        applyAlter(stmt, tables, currentSchema);
      } else if (/^comment\s+on\b/i.test(stmt)) {
        applyComment(stmt, tables, currentSchema);
      }
      // everything else (SET / CREATE SEQUENCE / CREATE INDEX / GRANT / …) is ignored
    } catch {
      // degrade per-statement — a single malformed statement never aborts the parse
    }
  }

  // Final pass: resolve which columns each CHECK references + lift `IN (...)` enums.
  for (const t of tables.values()) {
    const colNames = t.columns.map((c) => c.name);
    for (const chk of t.checks) {
      const norm = chk.expression.replace(/[`"]/g, '');
      const cols = colNames.filter((n) => wordIn(norm, n));
      if (cols.length) chk.columns = cols;
      if (cols.length === 1) {
        const inM = /\bin\s*\(([^)]*)\)/i.exec(chk.expression);
        if (inM) {
          const vals = extractQuotedList(inM[1]!);
          const col = t.columns.find((c) => c.name === cols[0]);
          if (col && vals.length && !col.enumValues) col.enumValues = vals;
        }
      }
    }
  }

  const tablesOut = order.map((k) => tables.get(k)!).filter(Boolean);
  const viewsOut = Array.from(views.values());
  return {
    dialect,
    sourceKind: 'upload',
    schemas: Array.from(new Set([...tablesOut.map((t) => t.schema), ...viewsOut.map((v) => v.schema)])),
    tables: tablesOut,
    views: viewsOut,
  };
}
