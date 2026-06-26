// ============================================================================
//  DATABASE INGESTION — LIVE read-only introspection (PostgreSQL + MySQL)
// ----------------------------------------------------------------------------
//  docs/DATABASE_INGESTION_DESIGN.md §2.2 (live path).
//
//  Connects READ-ONLY to a running database, reads ONLY catalog metadata
//  (tables / columns / PK / FK / UNIQUE / CHECK / comments — never row data),
//  and shapes it into the SAME grouped rows the information_schema JSON parser
//  consumes, then reuses `parseInfoSchemaJson` to build the dialect-neutral
//  `DbModel`. One modelling path, already unit-tested.
//
//  CREDENTIAL HYGIENE (design tenet 9): the `DbConnection` (with its password)
//  lives only for the duration of one introspection call — it is never persisted,
//  never logged, and never placed on the DbModel / DatabaseProfile / ontology.
//  The connection is opened read-only with short timeouts and ALWAYS closed in a
//  finally block. Only the rendered schema digest ever leaves the process.
//
//  Drivers (`pg`, `mysql2`) are LAZY-imported (dynamic import) so upload-only
//  deployments never load them — same spirit as the env-gated Neo4j driver.
//
//  HARD RULES (NodeNext / strict TS): relative imports carry `.js`; the only
//  project imports are the DbModel IR + the info-schema JSON parser.
// ============================================================================

import type { DbModel, DbDialect, DbView, DbColumn, DbRoutine, DbParam, DbTrigger } from '../types.js';
import { parseInfoSchemaJson } from '../parse/info-schema-json.js';

/** Read-only connection details. TRANSIENT — never persisted, logged, or sent to an LLM. */
export interface DbConnection {
  dialect: DbDialect;
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  /** Use TLS (accepts self-signed certs — common for managed cloud databases). */
  ssl?: boolean;
  /** Restrict to these schemas. Default: all non-system schemas (PG) / the connected db (MySQL). */
  schemas?: string[];
}

type Row = Record<string, unknown>;

/** Connect read-only, introspect the schema, and return a dialect-neutral DbModel. */
export async function introspect(conn: DbConnection): Promise<DbModel> {
  const model = conn.dialect === 'mysql' ? await introspectMysql(conn) : await introspectPostgres(conn);
  // parseInfoSchemaJson stamps 'upload'; a live connection is the 'live' kind.
  model.sourceKind = 'live';
  return model;
}

// ---------------------------------------------------------------------------
// PostgreSQL — via pg_catalog (richer + exact comments / constraint defs).
// ---------------------------------------------------------------------------

async function introspectPostgres(conn: DbConnection): Promise<DbModel> {
  const { Client } = await import('pg');
  const client = new Client({
    host: conn.host,
    port: conn.port ?? 5432,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    application_name: 'ontology-generator',
  });

  try {
    await client.connect();
    // Belt-and-braces read-only: we only SELECT from the catalog anyway.
    await client.query('SET default_transaction_read_only = on').catch(() => {});

    const q = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
      (await client.query(sql, params)).rows as Row[];

    const schemas =
      conn.schemas && conn.schemas.length > 0
        ? conn.schemas
        : (await q(
            `SELECT schema_name FROM information_schema.schemata
             WHERE schema_name NOT IN ('pg_catalog','information_schema') AND schema_name NOT LIKE 'pg\\_%'`,
          )).map((r) => String(r.schema_name));
    if (schemas.length === 0) schemas.push('public');

    const tableComments = await q(
      `SELECT pn.nspname AS table_schema, pc.relname AS table_name, obj_description(pc.oid) AS comment
       FROM pg_catalog.pg_class pc JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
       WHERE pc.relkind = 'r' AND pn.nspname = ANY($1)`,
      [schemas],
    );

    const columns = await q(
      `SELECT pn.nspname AS table_schema, pc.relname AS table_name, a.attname AS column_name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
              NOT a.attnotnull AS is_nullable, a.attnum AS ordinal_position,
              pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
              col_description(pc.oid, a.attnum) AS column_comment
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class pc ON pc.oid = a.attrelid AND pc.relkind = 'r'
       JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE pn.nspname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY pn.nspname, pc.relname, a.attnum`,
      [schemas],
    );

    const primaryKeys = await q(
      `SELECT pn.nspname AS table_schema, pc.relname AS table_name, a.attname AS column_name, k.ord AS ordinal_position
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class pc ON pc.oid = con.conrelid
       JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
       JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       WHERE con.contype = 'p' AND pn.nspname = ANY($1)`,
      [schemas],
    );

    const foreignKeys = await q(
      `SELECT pn.nspname AS table_schema, pc.relname AS table_name, con.conname AS constraint_name,
              a.attname AS column_name, fn.nspname AS ref_schema, fc.relname AS ref_table, fa.attname AS ref_column,
              k.ord AS ordinal_position,
              CASE con.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'RESTRICT' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE 'NO ACTION' END AS on_delete,
              CASE con.confupdtype WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'RESTRICT' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE 'NO ACTION' END AS on_update
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class pc ON pc.oid = con.conrelid
       JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
       JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
       JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
       JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord) ON true
       JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       JOIN pg_catalog.pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.fattnum
       WHERE con.contype = 'f' AND pn.nspname = ANY($1)`,
      [schemas],
    );

    const uniques = await q(
      `SELECT pn.nspname AS table_schema, pc.relname AS table_name, con.conname AS constraint_name,
              a.attname AS column_name, k.ord AS ordinal_position
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class pc ON pc.oid = con.conrelid
       JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
       JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       WHERE con.contype = 'u' AND pn.nspname = ANY($1)`,
      [schemas],
    );

    const checkRows = await q(
      `SELECT pn.nspname AS table_schema, pc.relname AS table_name, con.conname AS constraint_name,
              pg_get_constraintdef(con.oid) AS check_clause
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class pc ON pc.oid = con.conrelid
       JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
       WHERE con.contype = 'c' AND pn.nspname = ANY($1)`,
      [schemas],
    );
    const checks = checkRows.map((r) => ({ ...r, check_clause: normalizePgCheck(String(r.check_clause ?? '')) }));

    const model = parseInfoSchemaJson(
      { dialect: 'postgres', columns, primaryKeys, foreignKeys, uniques, checks, tableComments },
      { dialect: 'postgres', defaultSchema: schemas[0] },
    );

    // Views (relkind 'v') -> derived objects: their result columns + definition.
    const viewList = await q(
      `SELECT pn.nspname AS view_schema, pc.relname AS view_name, obj_description(pc.oid) AS comment,
              pg_get_viewdef(pc.oid, true) AS definition
       FROM pg_catalog.pg_class pc JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
       WHERE pc.relkind = 'v' AND pn.nspname = ANY($1)`,
      [schemas],
    );
    const viewCols = await q(
      `SELECT pn.nspname AS view_schema, pc.relname AS view_name, a.attname AS column_name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, NOT a.attnotnull AS is_nullable, a.attnum AS ordinal_position
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class pc ON pc.oid = a.attrelid AND pc.relkind = 'v'
       JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
       WHERE pn.nspname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY pn.nspname, pc.relname, a.attnum`,
      [schemas],
    );
    model.views = buildViews(viewList, viewCols, schemas[0]!);

    // Stored procedures / functions (prokind f|p) with their full definition.
    try {
      const routineRows = await q(
        `SELECT n.nspname AS schema, p.proname AS name,
                CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END AS kind,
                CASE WHEN p.prokind = 'f' THEN pg_get_function_result(p.oid) ELSE NULL END AS returns,
                pg_get_functiondef(p.oid) AS definition, l.lanname AS language,
                obj_description(p.oid) AS comment, pg_get_function_arguments(p.oid) AS args
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         LEFT JOIN pg_catalog.pg_language l ON l.oid = p.prolang
         WHERE n.nspname = ANY($1) AND p.prokind IN ('f', 'p')`,
        [schemas],
      );
      model.routines = buildRoutinesPg(routineRows);
    } catch {
      model.routines = []; // older PG / restricted catalog — skip routines
    }

    // Triggers (non-internal) -> events. pg_get_triggerdef carries timing + events.
    try {
      const triggerRows = await q(
        `SELECT n.nspname AS trg_schema, c.relname AS trg_table, t.tgname AS trg_name,
                pg_get_triggerdef(t.oid) AS trg_def, obj_description(t.oid) AS trg_comment
         FROM pg_catalog.pg_trigger t
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY($1) AND NOT t.tgisinternal`,
        [schemas],
      );
      model.triggers = buildTriggersPg(triggerRows);
    } catch {
      model.triggers = [];
    }
    return model;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Parse timing + DML events out of a `pg_get_triggerdef` string. */
function parseTriggerTimingEvents(def: string): { timing: DbTrigger['timing']; events: DbTrigger['events'] } {
  const tm = /\b(before|after|instead\s+of)\b/i.exec(def);
  const timingRaw = tm ? tm[1]!.toUpperCase().replace(/\s+/g, ' ') : 'AFTER';
  const timing: DbTrigger['timing'] = timingRaw === 'BEFORE' ? 'BEFORE' : timingRaw === 'INSTEAD OF' ? 'INSTEAD OF' : 'AFTER';
  const onIdx = def.toUpperCase().indexOf(' ON ');
  const mid = tm ? def.slice(tm.index + tm[0].length, onIdx >= 0 ? onIdx : undefined) : def;
  const events: DbTrigger['events'] = [];
  if (/\binsert\b/i.test(mid)) events.push('INSERT');
  if (/\bupdate\b/i.test(mid)) events.push('UPDATE');
  if (/\bdelete\b/i.test(mid)) events.push('DELETE');
  return { timing, events };
}

function buildTriggersPg(rows: Row[]): DbTrigger[] {
  const out: DbTrigger[] = [];
  for (const r of rows) {
    const name = String(r.trg_name ?? '');
    const table = String(r.trg_table ?? '');
    if (!name || !table) continue;
    const def = String(r.trg_def ?? '');
    const { timing, events } = parseTriggerTimingEvents(def);
    if (events.length === 0) continue;
    const trigger: DbTrigger = { schema: String(r.trg_schema ?? 'public'), table, name, timing, events, definition: def };
    if (r.trg_comment && String(r.trg_comment).trim()) trigger.comment = String(r.trg_comment).trim();
    out.push(trigger);
  }
  return out;
}

/** Split on top-level commas, respecting parens (e.g. `numeric(12,2)`). */
function splitArgsTopLevel(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth = Math.max(0, depth - 1); cur += ch; }
    else if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Parse a `pg_get_function_arguments` string ("IN p_x bigint, OUT p_y numeric(12,2)") into params. */
function parsePgArgs(args: string): DbParam[] {
  if (!args || !args.trim()) return [];
  const out: DbParam[] = [];
  for (const seg of splitArgsTopLevel(args)) {
    let s = seg.trim();
    if (!s) continue;
    let mode: DbParam['mode'] = 'IN';
    const mm = /^(IN|OUT|INOUT|VARIADIC)\s+/i.exec(s);
    if (mm) {
      const m = mm[1]!.toUpperCase();
      mode = m === 'OUT' ? 'OUT' : m === 'INOUT' ? 'INOUT' : 'IN';
      s = s.slice(mm[0].length);
    }
    const sp = s.indexOf(' ');
    if (sp < 0) continue; // a bare type with no name — skip
    const name = s.slice(0, sp).trim();
    const sqlType = s.slice(sp + 1).replace(/\s+default\s+[\s\S]*$/i, '').trim() || 'unknown';
    if (name) out.push({ name, mode, sqlType });
  }
  return out;
}

function buildRoutinesPg(rows: Row[]): DbRoutine[] {
  const out: DbRoutine[] = [];
  for (const r of rows) {
    const name = String(r.name ?? '');
    if (!name) continue;
    // Trigger / event-trigger functions are plumbing, not business actions — skip.
    const ret = String(r.returns ?? '').toLowerCase();
    if (ret === 'trigger' || ret === 'event_trigger') continue;
    const routine: DbRoutine = {
      schema: String(r.schema ?? 'public'),
      name,
      kind: r.kind === 'procedure' ? 'procedure' : 'function',
      params: parsePgArgs(String(r.args ?? '')),
      definition: String(r.definition ?? ''),
    };
    if (r.returns && String(r.returns).trim()) routine.returns = String(r.returns).trim();
    if (r.language && String(r.language).trim()) routine.language = String(r.language).trim();
    if (r.comment && String(r.comment).trim()) routine.comment = String(r.comment).trim();
    out.push(routine);
  }
  return out;
}

/** Group view-column rows by view and assemble DbView[] with their definition + comment. */
function buildViews(viewList: Row[], viewCols: Row[], defaultSchema: string): DbView[] {
  const colsByView = new Map<string, DbColumn[]>();
  for (const r of viewCols) {
    const schema = String(r.view_schema ?? r.table_schema ?? defaultSchema);
    const name = String(r.view_name ?? r.table_name ?? '');
    if (!name || !r.column_name) continue;
    const key = `${schema}.${name}`;
    const list = colsByView.get(key) ?? [];
    list.push({
      name: String(r.column_name),
      sqlType: String(r.column_type ?? r.data_type ?? 'unknown'),
      nullable: r.is_nullable === true || (typeof r.is_nullable === 'string' && r.is_nullable.toUpperCase() !== 'NO'),
    });
    colsByView.set(key, list);
  }
  const views: DbView[] = [];
  for (const r of viewList) {
    const schema = String(r.view_schema ?? r.table_schema ?? defaultSchema);
    const name = String(r.view_name ?? r.table_name ?? '');
    if (!name) continue;
    const v: DbView = { schema, name, columns: colsByView.get(`${schema}.${name}`) ?? [] };
    if (r.comment && String(r.comment).trim()) v.comment = String(r.comment).trim();
    if (r.definition && String(r.definition).trim()) v.definition = String(r.definition).trim();
    views.push(v);
  }
  return views;
}

/**
 * Normalize a pg_get_constraintdef CHECK into a clean expression: strip the
 * leading `CHECK` + redundant parens, and rewrite the verbose
 * `(col)::text = ANY ((ARRAY['a','b'])::text[])` form back to `col IN ('a','b')`
 * (so it reads well AND the seed lifts the enum values).
 */
function normalizePgCheck(raw: string): string {
  let e = raw.trim().replace(/^check\s*/i, '').trim();
  e = stripRedundantParens(e);
  const m = /^\(?\s*([a-z0-9_"]+)\s*\)?\s*(?:::[a-z0-9_ ]+)?\s*=\s*any\s*\(/i.exec(e);
  if (m) {
    const col = m[1]!.replace(/"/g, '');
    const vals = [...e.matchAll(/'((?:[^']|'')*)'/g)].map((x) => `'${x[1]}'`);
    if (vals.length > 0) return `${col} IN (${vals.join(',')})`;
  }
  return e;
}

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

// ---------------------------------------------------------------------------
// MySQL / MariaDB — via information_schema (COLUMN_TYPE carries enum + length).
// ---------------------------------------------------------------------------

async function introspectMysql(conn: DbConnection): Promise<DbModel> {
  const { createConnection } = await import('mysql2/promise');
  const schemas = conn.schemas && conn.schemas.length > 0 ? conn.schemas : [conn.database];
  const connection = await createConnection({
    host: conn.host,
    port: conn.port ?? 3306,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 10_000,
  });

  try {
    const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => {
      const [rows] = await connection.query(sql, params);
      return rows as Row[];
    };

    const tableComments = await q(
      `SELECT table_schema, table_name, table_comment AS comment
       FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema IN (?)`,
      [schemas],
    );

    const columns = await q(
      `SELECT table_schema, table_name, column_name, column_type AS data_type, is_nullable,
              column_default, ordinal_position, column_comment, column_type, column_key
       FROM information_schema.columns WHERE table_schema IN (?)
       ORDER BY table_schema, table_name, ordinal_position`,
      [schemas],
    );

    // PK / UNIQUE / FK all come from key_column_usage joined to table_constraints.
    const keyUsage = await q(
      `SELECT k.table_schema, k.table_name, k.column_name, k.ordinal_position, k.constraint_name,
              k.referenced_table_schema AS ref_schema, k.referenced_table_name AS ref_table,
              k.referenced_column_name AS ref_column, t.constraint_type
       FROM information_schema.key_column_usage k
       JOIN information_schema.table_constraints t
         ON t.constraint_schema = k.constraint_schema AND t.constraint_name = k.constraint_name AND t.table_name = k.table_name
       WHERE k.table_schema IN (?)
       ORDER BY k.table_name, k.constraint_name, k.ordinal_position`,
      [schemas],
    );
    const primaryKeys = keyUsage.filter((r) => r.constraint_type === 'PRIMARY KEY');
    const uniques = keyUsage.filter((r) => r.constraint_type === 'UNIQUE');
    const fkRows = keyUsage.filter((r) => r.constraint_type === 'FOREIGN KEY' && r.ref_table);

    // FK referential actions (on delete / on update).
    const refConstraints = await q(
      `SELECT constraint_schema, table_name, constraint_name, delete_rule, update_rule
       FROM information_schema.referential_constraints WHERE constraint_schema IN (?)`,
      [schemas],
    );
    const ruleBy = new Map<string, { delete_rule?: unknown; update_rule?: unknown }>();
    for (const r of refConstraints) ruleBy.set(`${r.table_name}::${r.constraint_name}`, r);
    const foreignKeys = fkRows.map((r) => {
      const rule = ruleBy.get(`${r.table_name}::${r.constraint_name}`);
      return { ...r, on_delete: rule?.delete_rule, on_update: rule?.update_rule };
    });

    // CHECK constraints (MySQL 8.0.16+ / MariaDB 10.2+); absent on older servers.
    let checks: Row[] = [];
    try {
      checks = await q(
        `SELECT tc.table_schema, tc.table_name, cc.constraint_name, cc.check_clause
         FROM information_schema.check_constraints cc
         JOIN information_schema.table_constraints tc
           ON tc.constraint_schema = cc.constraint_schema AND tc.constraint_name = cc.constraint_name
         WHERE tc.table_schema IN (?) AND tc.constraint_type = 'CHECK'`,
        [schemas],
      );
    } catch {
      checks = []; // older MySQL has no check_constraints view — degrade to none
    }

    const model = parseInfoSchemaJson(
      { dialect: 'mysql', columns, primaryKeys, foreignKeys, uniques, checks, tableComments },
      { dialect: 'mysql', defaultSchema: schemas[0] },
    );

    const viewList = await q(
      `SELECT table_schema AS view_schema, table_name AS view_name, view_definition AS definition
       FROM information_schema.views WHERE table_schema IN (?)`,
      [schemas],
    );
    const viewCols = await q(
      `SELECT c.table_schema AS view_schema, c.table_name AS view_name, c.column_name,
              c.column_type AS data_type, c.is_nullable, c.ordinal_position
       FROM information_schema.columns c
       JOIN information_schema.views v ON v.table_schema = c.table_schema AND v.table_name = c.table_name
       WHERE c.table_schema IN (?)
       ORDER BY c.table_name, c.ordinal_position`,
      [schemas],
    );
    model.views = buildViews(viewList, viewCols, schemas[0]!);

    // Stored procedures / functions + their parameters.
    try {
      const routineRows = await q(
        `SELECT routine_schema AS \`schema\`, routine_name AS name, LOWER(routine_type) AS kind,
                dtd_identifier AS \`returns\`, routine_definition AS definition, routine_comment AS comment
         FROM information_schema.routines WHERE routine_schema IN (?)`,
        [schemas],
      );
      const paramRows = await q(
        `SELECT specific_name, ordinal_position, parameter_name AS name, parameter_mode AS mode, dtd_identifier AS sqltype
         FROM information_schema.parameters WHERE specific_schema IN (?) AND parameter_name IS NOT NULL
         ORDER BY specific_name, ordinal_position`,
        [schemas],
      );
      model.routines = buildRoutinesMysql(routineRows, paramRows);
    } catch {
      model.routines = [];
    }

    // Triggers — one row per (trigger, event) in MySQL.
    try {
      const triggerRows = await q(
        `SELECT trigger_schema AS trg_schema, event_object_table AS trg_table, trigger_name AS trg_name,
                action_timing AS trg_timing, event_manipulation AS trg_event, action_statement AS trg_def
         FROM information_schema.triggers WHERE trigger_schema IN (?)`,
        [schemas],
      );
      model.triggers = buildTriggersMysql(triggerRows);
    } catch {
      model.triggers = [];
    }
    return model;
  } finally {
    await connection.end().catch(() => {});
  }
}

function buildTriggersMysql(rows: Row[]): DbTrigger[] {
  const out: DbTrigger[] = [];
  for (const r of rows) {
    const name = String(r.trg_name ?? '');
    const table = String(r.trg_table ?? '');
    const ev = String(r.trg_event ?? '').toUpperCase();
    if (!name || !table || (ev !== 'INSERT' && ev !== 'UPDATE' && ev !== 'DELETE')) continue;
    const timing: DbTrigger['timing'] = String(r.trg_timing ?? 'AFTER').toUpperCase() === 'BEFORE' ? 'BEFORE' : 'AFTER';
    out.push({
      schema: String(r.trg_schema ?? ''),
      table,
      name,
      timing,
      events: [ev],
      definition: String(r.trg_def ?? ''),
    });
  }
  return out;
}

function buildRoutinesMysql(routineRows: Row[], paramRows: Row[]): DbRoutine[] {
  const paramsByRoutine = new Map<string, DbParam[]>();
  for (const r of paramRows) {
    const sn = String(r.specific_name ?? '');
    const name = String(r.name ?? '');
    if (!sn || !name) continue;
    const mode = String(r.mode ?? 'IN').toUpperCase();
    const list = paramsByRoutine.get(sn) ?? [];
    list.push({ name, mode: mode === 'OUT' ? 'OUT' : mode === 'INOUT' ? 'INOUT' : 'IN', sqlType: String(r.sqltype ?? 'unknown') });
    paramsByRoutine.set(sn, list);
  }
  const out: DbRoutine[] = [];
  for (const r of routineRows) {
    const name = String(r.name ?? '');
    if (!name) continue;
    const routine: DbRoutine = {
      schema: String(r.schema ?? ''),
      name,
      kind: String(r.kind ?? 'procedure') === 'function' ? 'function' : 'procedure',
      params: paramsByRoutine.get(name) ?? [], // specific_name == routine_name (no overloading in MySQL)
      definition: String(r.definition ?? ''),
    };
    if (r.returns && String(r.returns).trim()) routine.returns = String(r.returns).trim();
    if (r.comment && String(r.comment).trim()) routine.comment = String(r.comment).trim();
    out.push(routine);
  }
  return out;
}
