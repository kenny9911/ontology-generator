// ============================================================================
//  DATABASE INGESTION — DbModel IR (dialect-neutral intermediate representation)
// ----------------------------------------------------------------------------
//  docs/DATABASE_INGESTION_DESIGN.md §2.1.
//
//  The ONE backend-only intermediate representation both ingestion paths (live
//  introspection / uploaded artifacts) and both dialects (PostgreSQL / MySQL)
//  converge on. The pipeline core only ever sees `ParsedSource` + an optional
//  `DbModel`; everything downstream (grounding, confidence, validation, review)
//  is dialect-agnostic.
//
//  This file is a dependency-graph LEAF — pure types + literal consts, NO
//  runtime logic and NO project imports — exactly like spec-format/types.ts and
//  the canonical schema. It is DELIBERATELY NOT part of the schema mirror: a
//  `DbModel` never enters the ontology JSON, it is only the staging IR that the
//  deterministic seed + textualization read. (The ontology-facing summary that
//  DOES persist is `OntologyMetadata.databaseProfile`, which lives in the mirror.)
//
//  M0 fields only. M1 (routines / triggers / view definitions) and M2
//  (logProfile) fields are added with their milestones — all optional, so this
//  IR grows without breaking the M0 readers.
// ============================================================================

/** The SQL dialects database ingestion supports (M0: PostgreSQL + MySQL/MariaDB). */
export const DB_DIALECTS = ['postgres', 'mysql'] as const;
export type DbDialect = (typeof DB_DIALECTS)[number];

/** Where a `DbModel` came from — a live read-only connection or uploaded artifacts. */
export type DbSourceKind = 'live' | 'upload';

/**
 * The complete dialect-neutral picture of a database's structure (M0 = schema).
 * Tables/columns/constraints/foreign keys are facts; the deterministic seed maps
 * them straight onto the ontology, and the LLM only adds semantics on top.
 */
export interface DbModel {
  dialect: DbDialect;
  sourceKind: DbSourceKind;
  /** Namespaces (schemas) introspected, e.g. ["public"]. */
  schemas: string[];
  tables: DbTable[];
  /** Views — M1 (always [] in M0, but typed now so readers never branch on absence). */
  views: DbView[];
  /** Stored procedures / functions (M1) — projected onto the actions layer. Optional;
   *  populated by live introspection (raw DDL routine bodies are not parsed). */
  routines?: DbRoutine[];
  /** Triggers (M1) — projected onto the events layer. Optional; live introspection only. */
  triggers?: DbTrigger[];
}

/** A trigger (M1) — its (table, operation) pairs become EventTypes (state changes). */
export interface DbTrigger {
  schema: string;
  table: string;
  name: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  /** The DML operations the trigger fires on. */
  events: ('INSERT' | 'UPDATE' | 'DELETE')[];
  /** The trigger body / full definition, when available. */
  definition?: string;
  comment?: string;
}

/** A stored-procedure / function parameter (M1). */
export interface DbParam {
  name: string;
  /** IN (default) / OUT / INOUT. */
  mode?: 'IN' | 'OUT' | 'INOUT';
  sqlType: string;
}

/** A stored procedure or function (M1) — becomes an ActionType (a callable tool). */
export interface DbRoutine {
  schema: string;
  name: string;
  kind: 'procedure' | 'function';
  language?: string;
  params: DbParam[];
  /** Return type (functions). */
  returns?: string;
  /** The routine body / full definition (drives DML side-effect detection + citation). */
  definition: string;
  comment?: string;
}

/** One table (or, from M1, a view materialized as a derived object). */
export interface DbTable {
  /** Namespace, e.g. "public". Always present (defaults to the dialect's default schema). */
  schema: string;
  /** Raw identifier as it appears in the catalog, e.g. "t_ord_hdr". */
  name: string;
  /** Table comment / description when the catalog carries one. */
  comment?: string;
  columns: DbColumn[];
  /** Primary-key column names, in key order. Empty when the table has no PK. */
  primaryKey: string[];
  /** Multi-column UNIQUE constraints (single-column uniques stay structural on the column). */
  uniques: DbUnique[];
  /** CHECK constraints, verbatim expression preserved for citation + rule text. */
  checks: DbCheck[];
  foreignKeys: DbForeignKey[];
}

/** One column. `sqlType` is preserved RAW (e.g. "varchar(20)") for verbatim evidence. */
export interface DbColumn {
  name: string;
  /** Raw SQL type as the catalog reports it, e.g. "varchar(20)", "numeric(12,2)", "bigint". */
  sqlType: string;
  nullable: boolean;
  /** Column default expression, when present, verbatim. */
  default?: string;
  /** Column comment / description when present. */
  comment?: string;
  /**
   * Enumerated values, when discoverable — a MySQL `enum(...)` type or a
   * `CHECK (col IN (...))`. Carried on the IR for later use; in M0 these surface
   * to the user via the generated CHECK rule (the canonical ObjectProperty has
   * no enum-values field), not as property metadata.
   */
  enumValues?: string[];
}

/** A foreign key: child columns -> parent (referenced) columns. */
export interface DbForeignKey {
  /** Constraint name when the catalog names it. */
  name?: string;
  /** Child-side column names (the columns in THIS table). */
  columns: string[];
  refSchema: string;
  refTable: string;
  /** Parent-side column names (the referenced columns). */
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

/** A multi-column UNIQUE constraint (a real business invariant -> a first-class rule). */
export interface DbUnique {
  name?: string;
  columns: string[];
}

/** A CHECK constraint. `expression` is preserved verbatim for citation + rule statement. */
export interface DbCheck {
  name?: string;
  expression: string;
  /** Columns the check references, when resolvable (routes the rule's appliesToAttributes). */
  columns?: string[];
}

/** A view (M1) — projected onto the ontology as a derived ObjectType. */
export interface DbView {
  schema: string;
  name: string;
  comment?: string;
  /** The view's SELECT, when available (live introspection / a CREATE VIEW dump). */
  definition?: string;
  /** Result columns, when known (live introspection exposes them; raw DDL does not). */
  columns?: DbColumn[];
}
