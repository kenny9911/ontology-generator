// ============================================================================
//  DATABASE INGESTION — deterministic object + relationship seed
// ----------------------------------------------------------------------------
//  docs/DATABASE_INGESTION_DESIGN.md §2.4.
//
//  PURE + DETERMINISTIC (no LLM, no I/O). Maps the structural facts of a
//  `DbModel` straight onto the ontology's stage-1 layer:
//
//    table  -> ObjectType            (id = makeId('object', '<schema>_<table>'))
//    column -> ObjectProperty        (type via sqlTypeToPropertyType)
//    FK     -> Relationship  + child property is_foreign_key/references
//
//  Every node is `provenance:'extracted'`, cites a VERBATIM line from the schema
//  evidence document (textualize.ts) so it survives grounding, and carries a high
//  raw confidence (a structural fact, not an inference). The orchestrator's
//  applyObjects re-grounds, re-scores and validates exactly as for the document
//  path — this seed only replaces the LLM *discovery*, not the deterministic core.
//
//  HARD RULES (NodeNext / strict TS): relative imports carry `.js`; schema types
//  are TYPE-ONLY (so this runs alias-free under tsx); `makeId` + the shared line
//  renderers are the only runtime imports.
// ============================================================================

import { randomUUID } from 'crypto';

import { makeId } from '../../_shared/ids.js';
import type {
  Cardinality,
  ObjectProperty,
  ObjectType,
  PropertyType,
  Relationship,
  SourceRef,
} from '../../_shared/ontology-schema.js';
import type { DbModel, DbTable, DbColumn, DbForeignKey } from './types.js';
import {
  SCHEMA_DOC_ID,
  SCHEMA_DOC_NAME,
  tableHeaderSnippet,
  viewHeaderSnippet,
  foreignKeyLine,
} from './textualize.js';

/** Structural facts are near-certain; the rubric still re-scores downstream. */
const SEED_CONFIDENCE = 0.95;

// ---------------------------------------------------------------------------
// SQL type family -> closed PropertyType vocabulary.
//
// The catalog reports RAW dialect types ("varchar(20)", "numeric(12,2)",
// "bigint", "timestamptz", "enum('a','b')"). The stage-1 helper in objects.ts
// only normalizes already-tokenized type names, so DB ingestion needs its own
// family mapper. Deterministic and dialect-spanning (PostgreSQL + MySQL).
// ---------------------------------------------------------------------------

const INTEGER_TYPES = new Set([
  'int', 'integer', 'smallint', 'bigint', 'mediumint', 'tinyint',
  'int2', 'int4', 'int8', 'serial', 'bigserial', 'smallserial', 'serial2', 'serial4', 'serial8',
  'year', 'bit',
]);
const FLOAT_TYPES = new Set([
  'numeric', 'decimal', 'dec', 'real', 'double', 'double precision', 'float', 'float4', 'float8', 'money',
]);
const BOOLEAN_TYPES = new Set(['bool', 'boolean']);
const DATE_TYPES = new Set(['date']);
const TIMESTAMP_TYPES = new Set([
  'timestamp', 'timestamptz', 'timestamp without time zone', 'timestamp with time zone', 'datetime',
]);

/**
 * Map a raw SQL type to the closed PropertyType vocabulary. Handles array (`[]`)
 * and enum/set as `List<String>`, the boolean idiom `tinyint(1)`, multi-word
 * dialect types (`character varying`, `double precision`,
 * `timestamp without time zone`, `int unsigned`), then strips precision parens
 * and matches the type family on the first word. Anything unrecognized
 * (text/char/uuid/json/inet/time/…) falls back to `String`.
 */
export function sqlTypeToPropertyType(sqlType: string): PropertyType {
  const raw = (sqlType ?? '').trim().toLowerCase();
  if (!raw) return 'String';
  // Array types (e.g. "text[]", "integer[]") and SQL enum/set -> a list.
  if (raw.endsWith('[]') || raw.startsWith('enum') || raw.startsWith('set(') || raw === 'set') {
    return 'List<String>';
  }
  // MySQL boolean idiom.
  if (raw === 'tinyint(1)' || raw === 'bool' || raw === 'boolean') return 'Boolean';
  // Strip "(...)" precision/length and any array marker, collapse spaces.
  const base = raw.replace(/\(.*$/, '').replace(/\[\]$/, '').replace(/\s+/g, ' ').trim();
  // Multi-word families (checked before the single-word family sets).
  if (base.includes('varying') || base.startsWith('char') || base.startsWith('national char')) return 'String';
  if (base.startsWith('double')) return 'Float';
  if (base.startsWith('timestamp') || base.startsWith('datetime')) return 'Timestamp';
  // First word handles "int unsigned", "bigint unsigned", "numeric(…)", etc.
  const first = base.split(' ')[0] ?? base;
  if (INTEGER_TYPES.has(first)) return 'Integer';
  if (FLOAT_TYPES.has(first)) return 'Float';
  if (BOOLEAN_TYPES.has(first)) return 'Boolean';
  if (DATE_TYPES.has(first)) return 'Date';
  if (TIMESTAMP_TYPES.has(first)) return 'Timestamp';
  return 'String'; // varchar/char/text/uuid/json/jsonb/bytea/inet/time/xml/...
}

// ---------------------------------------------------------------------------
// Deterministic ids.
// ---------------------------------------------------------------------------

/**
 * The deterministic object id for a table, fully-qualified by schema so two
 * schemas sharing a table name never collide and the id is a stable key for M3
 * re-sync. Passed through `makeId`'s slugifier against a FRESH set, so it returns
 * the collision-free BASE id (`objectType:<schema>-<table>`) — the SAME id
 * `seedObjects` registers and that `seed-rules` recomputes to find its table's
 * object. NOTE: we join schema/table with `_` (not `.`) so the slug carries no
 * dot, keeping object ids disjoint from the `appliesToAttributes` "id.attr" form.
 */
export function tableObjectId(schema: string, name: string): string {
  return makeId('object', `${schema}_${name}`, new Set<string>());
}

// ---------------------------------------------------------------------------
// Seed.
// ---------------------------------------------------------------------------

function headerSource(t: DbTable): SourceRef {
  return { documentId: SCHEMA_DOC_ID, documentName: SCHEMA_DOC_NAME, snippet: tableHeaderSnippet(t) };
}

function fkSource(fk: DbForeignKey): SourceRef {
  return { documentId: SCHEMA_DOC_ID, documentName: SCHEMA_DOC_NAME, snippet: foreignKeyLine(fk) };
}

/** Map a column to an ObjectProperty (FK flags are wired in the relationship pass). */
function toProperty(c: DbColumn): ObjectProperty {
  const prop: ObjectProperty = {
    name: c.name,
    type: sqlTypeToPropertyType(c.sqlType),
    description: c.comment?.trim() || '',
  };
  return prop;
}

/** Best-effort PK name when there is no PK constraint: a `*_id` property, else `<slug>_id`. */
function guessPkName(props: ObjectProperty[], objId: string): string {
  const idProp = props.find((p) => /_id$/i.test(p.name));
  if (idProp) return idProp.name;
  const slug = objId.replace(/^objectType:/, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return `${slug}_id`;
}

/** The primary-key property name: first PK column, else any `*_id`, else `<slug>_id`. */
function pickPrimaryKey(t: DbTable, props: ObjectProperty[], objId: string): string {
  if (t.primaryKey.length > 0) return t.primaryKey[0]!;
  return guessPkName(props, objId);
}

/**
 * Build the stage-1 layer (objects + relationships) from a `DbModel`,
 * deterministically. Registers every minted id in `taken` so later stages /
 * layers do not collide. Returns the same shape as `extractObjects`, so the
 * orchestrator's applyObjects path is reused unchanged.
 */
export function seedObjects(
  model: DbModel,
  taken: Set<string>,
): { objects: ObjectType[]; relationships: Relationship[] } {
  const objects: ObjectType[] = [];
  // table key "schema.name" -> minted object id, for FK endpoint resolution.
  const idByTable = new Map<string, string>();

  // --- pass 1: objects + properties --------------------------------------
  for (const t of model.tables) {
    let id = tableObjectId(t.schema, t.name);
    // Defensive: qualified names are unique, but never emit a duplicate id.
    if (taken.has(id)) id = makeId('object', `${t.schema}_${t.name}`, taken);
    else taken.add(id);
    idByTable.set(`${t.schema}.${t.name}`, id);

    const properties = t.columns.map(toProperty);
    const obj: ObjectType = {
      id,
      uuid: randomUUID(),
      name: t.name,
      nameZh: t.name, // enriched to a real Chinese name by schema_interpreter (M0 LLM step)
      description: t.comment?.trim() || '',
      type: 'data', // DB tables are data entities by default; enrichment may reclassify
      relationship_description: '',
      primary_key: pickPrimaryKey(t, properties, id),
      properties,
      sources: [headerSource(t)],
      confidence: SEED_CONFIDENCE,
      provenance: 'extracted',
      reviewState: 'pending',
    };
    objects.push(obj);
  }

  const objectIds = new Set(objects.map((o) => o.id));
  const objById = new Map(objects.map((o) => [o.id, o] as const));

  // --- pass 2: foreign keys -> relationships + child property FK refs -----
  const relationships: Relationship[] = [];
  for (const t of model.tables) {
    const childId = idByTable.get(`${t.schema}.${t.name}`);
    if (!childId) continue;
    const child = objById.get(childId)!;
    for (const fk of t.foreignKeys) {
      const parentId = idByTable.get(`${fk.refSchema}.${fk.refTable}`);
      // Parent outside the introspected set (external/unknown table): skip the
      // relationship AND leave the property unflagged (no dangling reference).
      if (!parentId || !objectIds.has(parentId)) continue;

      // Wire the child FK column(s) as property-level references.
      for (const col of fk.columns) {
        const prop = child.properties.find((p) => p.name === col);
        if (prop) {
          prop.is_foreign_key = true;
          prop.references = parentId;
        }
      }

      const id = makeId('relationship', `${childId}-references-${parentId}`, taken);
      const rel: Relationship = {
        id,
        uuid: randomUUID(),
        name: 'references',
        sourceObjectTypeId: childId,
        targetObjectTypeId: parentId,
        cardinality: fkCardinality(t, fk),
        viaAttribute: fk.columns.join(', '),
        sources: [fkSource(fk)],
        confidence: SEED_CONFIDENCE,
        provenance: 'extracted',
        reviewState: 'pending',
      };
      relationships.push(rel);
    }
  }

  // --- pass 3: views -> derived objects (no PK/FK; cite the view header) ----
  for (const v of model.views) {
    let id = tableObjectId(v.schema, v.name);
    if (taken.has(id)) id = makeId('object', `${v.schema}_${v.name}`, taken);
    else taken.add(id);
    const properties = (v.columns ?? []).map(toProperty);
    const obj: ObjectType = {
      id,
      uuid: randomUUID(),
      name: v.name,
      nameZh: v.name,
      description: v.comment?.trim() || '',
      type: 'data', // a view is a derived data concept; enrichment may reclassify
      relationship_description: `${v.name} is a database view.`,
      primary_key: guessPkName(properties, id),
      properties,
      sources: [{ documentId: SCHEMA_DOC_ID, documentName: SCHEMA_DOC_NAME, snippet: viewHeaderSnippet(v) }],
      confidence: SEED_CONFIDENCE,
      provenance: 'extracted',
      reviewState: 'pending',
    };
    objects.push(obj);
  }

  fillRelationshipDescriptions(objects, relationships);
  return { objects, relationships };
}

/**
 * many_to_one normally (many children -> one parent); one_to_one when the child
 * FK columns are themselves unique on the child (the PK, or a UNIQUE constraint).
 */
function fkCardinality(t: DbTable, fk: DbForeignKey): Cardinality {
  const cols = [...fk.columns].sort();
  const sameSet = (a: string[]): boolean => {
    const b = [...a].sort();
    return b.length === cols.length && b.every((v, i) => v === cols[i]);
  };
  if (sameSet(t.primaryKey)) return 'one_to_one';
  if (t.uniques.some((u) => sameSet(u.columns))) return 'one_to_one';
  return 'many_to_one';
}

/**
 * Synthesize each object's `relationship_description` from its FK edges
 * (mirrors objects.ts#fillRelationshipDescriptions). Deterministic prose so the
 * spec projection has a non-empty field even before LLM enrichment.
 */
function fillRelationshipDescriptions(objects: ObjectType[], relationships: Relationship[]): void {
  const nameById = new Map(objects.map((o) => [o.id, o.name] as const));
  for (const o of objects) {
    // Views (and any object pre-filled with prose, e.g. by enrichment) keep theirs.
    if (o.relationship_description && o.relationship_description.trim()) continue;
    const parts: string[] = [];
    for (const rel of relationships) {
      if (rel.sourceObjectTypeId === o.id && nameById.has(rel.targetObjectTypeId)) {
        parts.push(`${o.name} references ${nameById.get(rel.targetObjectTypeId)} via ${rel.viaAttribute ?? rel.name}.`);
      } else if (rel.targetObjectTypeId === o.id && nameById.has(rel.sourceObjectTypeId)) {
        parts.push(`${nameById.get(rel.sourceObjectTypeId)} references ${o.name}.`);
      }
    }
    const deduped = Array.from(new Set(parts));
    o.relationship_description = deduped.length
      ? deduped.join(' ')
      : `${o.name} has no foreign-key relationships to other tables.`;
  }
}
