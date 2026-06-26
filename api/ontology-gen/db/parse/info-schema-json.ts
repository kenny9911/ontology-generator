// ============================================================================
//  DATABASE INGESTION — information_schema JSON parser (upload fallback)
// ----------------------------------------------------------------------------
//  docs/DATABASE_INGESTION_DESIGN.md §2.2 (the robust fallback to DDL parsing).
//
//  PURE + DETERMINISTIC. Parses an `information_schema` export into a `DbModel`,
//  for users who cannot run pg_dump/mysqldump but can run a query and save JSON.
//
//  DOCUMENTED EXPORT SHAPE (all key lookups are case-insensitive, so the raw
//  catalog casing — lower in PG, sometimes UPPER in MySQL — both work):
//
//    {
//      "dialect": "postgres" | "mysql",
//      "columns":     [ { table_schema, table_name, column_name, data_type,
//                         is_nullable, column_default?, column_comment?,
//                         ordinal_position?, column_type?, enum_values? } ],
//      "primaryKeys": [ { table_schema, table_name, column_name, ordinal_position? } ],
//      "foreignKeys": [ { table_schema, table_name, column_name, ordinal_position?,
//                         ref_schema, ref_table, ref_column, constraint_name?,
//                         on_delete?, on_update? } ],
//      "uniques":     [ { table_schema, table_name, constraint_name, column_name, ordinal_position? } ],
//      "checks":      [ { table_schema, table_name, check_clause, constraint_name?, column_name? } ],
//      "tableComments": [ { table_schema, table_name, comment } ]
//    }
//
//  A bare ARRAY of column rows is also accepted (columns-only minimal export):
//  it yields the objects layer with no relationships/constraint rules.
//
//  HARD RULES (NodeNext / strict TS): relative imports carry `.js`; only the
//  DbModel IR is imported.
// ============================================================================

import type { DbModel, DbTable, DbColumn, DbForeignKey, DbDialect } from '../types.js';

export interface ParseInfoSchemaOptions {
  dialect: DbDialect;
  defaultSchema?: string;
}

type Row = Record<string, unknown>;

/** Lowercase every key of a row so lookups are case-insensitive across dialects. */
function lc(row: unknown): Row {
  if (!row || typeof row !== 'object') return {};
  const out: Row = {};
  for (const [k, v] of Object.entries(row as Row)) out[k.toLowerCase()] = v;
  return out;
}

/** First present non-empty string value across candidate keys. */
function str(row: Row, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function num(row: Row, ...keys: string[]): number {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return Number.MAX_SAFE_INTEGER; // unknown ordinal sorts last
}

function isNullable(row: Row): boolean {
  const v = row['is_nullable'];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toUpperCase() !== 'NO';
  return true;
}

function enumValues(row: Row): string[] | undefined {
  const direct = row['enum_values'];
  if (Array.isArray(direct)) {
    const vals = direct.filter((x): x is string => typeof x === 'string');
    if (vals.length) return vals;
  }
  // MySQL column_type carries enum('a','b') / set('a','b') inline.
  const ct = str(row, 'column_type');
  if (ct && /^(enum|set)\s*\(/i.test(ct)) {
    const out: string[] = [];
    const re = /'((?:[^']|'')*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ct)) !== null) out.push(m[1]!.replace(/''/g, "'"));
    if (out.length) return out;
  }
  return undefined;
}

const key = (schema: string, name: string): string => `${schema}.${name}`;

/** Parse an information_schema export (grouped object or bare column array) into a DbModel. */
export function parseInfoSchemaJson(input: unknown, opts: ParseInfoSchemaOptions): DbModel {
  const defaultSchema = opts.defaultSchema || 'public';
  const root: Record<string, unknown> = Array.isArray(input)
    ? { columns: input }
    : (input && typeof input === 'object' ? (input as Record<string, unknown>) : {});

  const arr = (v: unknown): Row[] => (Array.isArray(v) ? v.map(lc) : []);
  const columnRows = arr(root.columns);
  const pkRows = arr(root.primarykeys ?? (root as Row)['primaryKeys']);
  const fkRows = arr(root.foreignkeys ?? (root as Row)['foreignKeys']);
  const uqRows = arr(root.uniques);
  const ckRows = arr(root.checks);
  const tcRows = arr(root.tablecomments ?? (root as Row)['tableComments']);

  const tables = new Map<string, DbTable>();
  const order: string[] = [];
  const ensure = (schema: string, name: string): DbTable => {
    const k = key(schema, name);
    let t = tables.get(k);
    if (!t) {
      t = { schema, name, columns: [], primaryKey: [], uniques: [], checks: [], foreignKeys: [] };
      tables.set(k, t);
      order.push(k);
    }
    return t;
  };

  // Columns (sorted by ordinal within each table).
  const colsByTable = new Map<string, { ord: number; col: DbColumn }[]>();
  for (const r of columnRows) {
    const schema = str(r, 'table_schema', 'schema') ?? defaultSchema;
    const name = str(r, 'table_name', 'table');
    const colName = str(r, 'column_name', 'name');
    if (!name || !colName) continue;
    const col: DbColumn = {
      name: colName,
      // Prefer column_type (MySQL: carries length + enum, e.g. "tinyint(1)",
      // "enum('a','b')"); PG has no column_type, so its rich format_type
      // `data_type` is used instead.
      sqlType: str(r, 'column_type', 'data_type', 'type') ?? 'unknown',
      nullable: isNullable(r),
    };
    const def = str(r, 'column_default', 'default');
    if (def) col.default = def;
    const comment = str(r, 'column_comment', 'comment');
    if (comment) col.comment = comment;
    const ev = enumValues(r);
    if (ev) col.enumValues = ev;
    const k = key(schema, name);
    ensure(schema, name);
    const list = colsByTable.get(k) ?? [];
    list.push({ ord: num(r, 'ordinal_position', 'ordinal'), col });
    colsByTable.set(k, list);
    // A column row may itself flag the PK (MySQL column_key='PRI').
    if ((str(r, 'column_key') ?? '').toUpperCase() === 'PRI') ensure(schema, name).primaryKey.push(colName);
  }
  for (const [k, list] of colsByTable) {
    list.sort((a, b) => a.ord - b.ord);
    tables.get(k)!.columns = list.map((x) => x.col);
  }

  // Primary keys (explicit rows win; ordered by ordinal).
  const pkByTable = new Map<string, { ord: number; col: string }[]>();
  for (const r of pkRows) {
    const schema = str(r, 'table_schema', 'schema') ?? defaultSchema;
    const name = str(r, 'table_name', 'table');
    const col = str(r, 'column_name', 'name');
    if (!name || !col) continue;
    ensure(schema, name);
    const k = key(schema, name);
    const list = pkByTable.get(k) ?? [];
    list.push({ ord: num(r, 'ordinal_position', 'ordinal', 'key_ordinal'), col });
    pkByTable.set(k, list);
  }
  for (const [k, list] of pkByTable) {
    list.sort((a, b) => a.ord - b.ord);
    tables.get(k)!.primaryKey = list.map((x) => x.col);
  }

  // Foreign keys (grouped by constraint, ordered by ordinal).
  const fkByConstraint = new Map<string, { ord: number; col: string; refCol: string }[]>();
  const fkMeta = new Map<string, { schema: string; name: string; refSchema: string; refTable: string; onDelete?: string; onUpdate?: string; cname?: string }>();
  for (const r of fkRows) {
    const schema = str(r, 'table_schema', 'schema') ?? defaultSchema;
    const name = str(r, 'table_name', 'table');
    const col = str(r, 'column_name', 'name');
    const refTable = str(r, 'ref_table', 'referenced_table_name', 'referenced_table');
    const refCol = str(r, 'ref_column', 'referenced_column_name', 'referenced_column');
    if (!name || !col || !refTable || !refCol) continue;
    const cname = str(r, 'constraint_name') ?? `${name}.${col}->${refTable}`;
    const gk = `${schema}.${name}::${cname}`;
    ensure(schema, name);
    const list = fkByConstraint.get(gk) ?? [];
    list.push({ ord: num(r, 'ordinal_position', 'ordinal', 'position_in_unique_constraint'), col, refCol });
    fkByConstraint.set(gk, list);
    if (!fkMeta.has(gk)) {
      fkMeta.set(gk, {
        schema, name,
        refSchema: str(r, 'ref_schema', 'referenced_table_schema') ?? schema,
        refTable,
        onDelete: str(r, 'on_delete', 'delete_rule'),
        onUpdate: str(r, 'on_update', 'update_rule'),
        cname: str(r, 'constraint_name'),
      });
    }
  }
  for (const [gk, list] of fkByConstraint) {
    list.sort((a, b) => a.ord - b.ord);
    const meta = fkMeta.get(gk)!;
    const fk: DbForeignKey = {
      columns: list.map((x) => x.col),
      refSchema: meta.refSchema,
      refTable: meta.refTable,
      refColumns: list.map((x) => x.refCol),
    };
    if (meta.cname) fk.name = meta.cname;
    if (meta.onDelete && meta.onDelete.toUpperCase() !== 'NO ACTION') fk.onDelete = meta.onDelete.toUpperCase();
    if (meta.onUpdate && meta.onUpdate.toUpperCase() !== 'NO ACTION') fk.onUpdate = meta.onUpdate.toUpperCase();
    tables.get(key(meta.schema, meta.name))!.foreignKeys.push(fk);
  }

  // Unique constraints (grouped by constraint name).
  const uqByConstraint = new Map<string, { ord: number; col: string }[]>();
  const uqMeta = new Map<string, { schema: string; name: string; cname?: string }>();
  for (const r of uqRows) {
    const schema = str(r, 'table_schema', 'schema') ?? defaultSchema;
    const name = str(r, 'table_name', 'table');
    const col = str(r, 'column_name', 'name');
    const cname = str(r, 'constraint_name') ?? `${name}.${col}`;
    if (!name || !col) continue;
    const gk = `${schema}.${name}::${cname}`;
    ensure(schema, name);
    const list = uqByConstraint.get(gk) ?? [];
    list.push({ ord: num(r, 'ordinal_position', 'ordinal'), col });
    uqByConstraint.set(gk, list);
    if (!uqMeta.has(gk)) uqMeta.set(gk, { schema, name, cname: str(r, 'constraint_name') });
  }
  for (const [gk, list] of uqByConstraint) {
    list.sort((a, b) => a.ord - b.ord);
    const meta = uqMeta.get(gk)!;
    tables.get(key(meta.schema, meta.name))!.uniques.push(
      meta.cname ? { name: meta.cname, columns: list.map((x) => x.col) } : { columns: list.map((x) => x.col) },
    );
  }

  // Checks.
  for (const r of ckRows) {
    const schema = str(r, 'table_schema', 'schema') ?? defaultSchema;
    const name = str(r, 'table_name', 'table');
    const expr = str(r, 'check_clause', 'expression', 'definition');
    if (!name || !expr) continue;
    ensure(schema, name);
    const t = tables.get(key(schema, name))!;
    const cname = str(r, 'constraint_name');
    const colName = str(r, 'column_name');
    const cols = colName ? [colName] : t.columns.map((c) => c.name).filter((n) => new RegExp(`(^|[^A-Za-z0-9_])${n}([^A-Za-z0-9_]|$)`).test(expr.replace(/[`"]/g, '')));
    t.checks.push({ ...(cname ? { name: cname } : {}), expression: expr, ...(cols.length ? { columns: cols } : {}) });
  }

  // Table comments.
  for (const r of tcRows) {
    const schema = str(r, 'table_schema', 'schema') ?? defaultSchema;
    const name = str(r, 'table_name', 'table');
    const comment = str(r, 'comment', 'table_comment');
    if (!name || !comment) continue;
    const t = tables.get(key(schema, name));
    if (t) t.comment = comment;
  }

  const tablesOut = order.map((k) => tables.get(k)!).filter(Boolean);
  const dialect: DbDialect = opts.dialect;
  return {
    dialect,
    sourceKind: 'upload',
    schemas: Array.from(new Set(tablesOut.map((t) => t.schema))),
    tables: tablesOut,
    views: [],
  };
}
