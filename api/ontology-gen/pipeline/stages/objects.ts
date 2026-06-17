// ============================================================================
//  ONTOLOGY GENERATOR — STAGE 1: OBJECT TYPES (+ relationships)  [PURE EXTRACT]
// ============================================================================
//
//  extractObjects(ctx) is the FIRST and most important extraction stage. For
//  each parsed source/chunk it builds the Stage-1 prompt, calls the single LLM
//  abstraction, parses the JSON defensively, and maps the result into typed
//  ObjectType[] + top-level Relationship[]. It mints deterministic ids via
//  makeId (recording them in ctx.taken) and stamps every node with its
//  sources[]/confidence/provenance/reviewState envelope.
//
//  This function is PURE EXTRACT: it does NOT ground offsets, recompute
//  quoteVerified, apply the confidence rubric, or validate cross-refs — the
//  ORCHESTRATOR owns all of that AFTER the stage returns. It only:
//    - calls the model + parses,
//    - mints ids and uuids,
//    - copies the model's verbatim snippet into sources[],
//    - records a RAW confidence,
//    - de-dupes across chunks by canonical name.
//
//  HARD RULES (NodeNext / strict TS): relative project imports carry `.js`;
//  schema types come from the generated backend mirror; all LLM calls go
//  through executeLLMWithTracking.
// ============================================================================

import { randomUUID } from 'crypto';

import type {
  Cardinality,
  Confidence,
  ObjectProperty,
  ObjectType,
  PropertyType,
  Relationship,
  SourceRef,
} from '../../../_shared/ontology-schema.js';
import { PROPERTY_TYPES } from '../../../_shared/ontology-schema.js';
import { makeId } from '../../../_shared/ids.js';
import { executeLLMWithTracking } from '../../llm.js';
import type { ExecuteLLMOptions } from '../../llm.js';
import { buildObjectsPrompt } from '../../prompts.js';
import { ctxAgentLlm } from '../../llm-router.js';
import type { StageContext } from '../context.js';

// ---------------------------------------------------------------------------
//  Loose shapes the model returns (parsed JSON is untrusted — narrow defensively).
// ---------------------------------------------------------------------------

interface RawSourceRef {
  documentId?: unknown;
  documentName?: unknown;
  section?: unknown;
  snippet?: unknown;
  page?: unknown;
  line?: unknown;
}

interface RawProperty {
  name?: unknown;
  nameZh?: unknown;
  type?: unknown;
  description?: unknown;
  descriptionZh?: unknown;
  is_foreign_key?: unknown;
  references?: unknown;
  // legacy shapes accepted as a fallback:
  keyRole?: unknown;
  refObjectTypeId?: unknown;
}

interface RawObject {
  id?: unknown;
  name?: unknown;
  nameZh?: unknown;
  description?: unknown;
  descriptionZh?: unknown;
  /** 'data' | 'system' (also accepted under the legacy key `objectClass`). */
  type?: unknown;
  objectClass?: unknown;
  /** Prose describing this object's relationships (also legacy `relationshipNote`). */
  relationship_description?: unknown;
  relationshipNote?: unknown;
  /** The primary-key property name. */
  primary_key?: unknown;
  /** The object's fields (also accepted under the legacy key `attributes`). */
  properties?: unknown;
  attributes?: unknown;
  display?: { emoji?: unknown; color?: unknown };
  sources?: unknown;
  confidence?: unknown;
}

interface RawRelationship {
  id?: unknown;
  name?: unknown;
  nameZh?: unknown;
  sourceObjectTypeId?: unknown;
  targetObjectTypeId?: unknown;
  cardinality?: unknown;
  viaAttribute?: unknown;
  description?: unknown;
  sources?: unknown;
  confidence?: unknown;
}

interface RawObjectsPayload {
  objects?: unknown;
  relationships?: unknown;
}

// ---------------------------------------------------------------------------
//  Small pure helpers (closed-vocab coercion + defensive JSON parsing).
// ---------------------------------------------------------------------------

const PROPERTY_TYPE_SET = new Set<string>(PROPERTY_TYPES as readonly string[]);
const CARDINALITIES = new Set<Cardinality>([
  'one_to_one',
  'one_to_many',
  'many_to_one',
  'many_to_many',
]);

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Clamp a raw model confidence into [0,1]; default mid when absent/bad. */
function rawConfidence(v: unknown): Confidence {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}

/**
 * Coerce any model-emitted type token to the closed PropertyType vocabulary.
 * Accepts the spec forms ("String", "List<String>"), the legacy internal
 * DataType forms ("string", "enum", "datetime", …), and loose synonyms.
 */
function toPropertyType(v: unknown): PropertyType {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (!raw) return 'String';
  if (PROPERTY_TYPE_SET.has(raw)) return raw as PropertyType;
  if (/^list<.+>$/i.test(raw)) return 'List<String>';
  switch (raw.toLowerCase()) {
    case 'integer':
    case 'int':
      return 'Integer';
    case 'decimal':
    case 'money':
    case 'float':
    case 'number':
    case 'double':
      return 'Float';
    case 'boolean':
    case 'bool':
      return 'Boolean';
    case 'date':
      return 'Date';
    case 'datetime':
    case 'timestamp':
      return 'Timestamp';
    case 'enum':
    case 'array':
      return 'List<String>';
    default:
      return 'String'; // string / uuid / reference / json / text / unknown
  }
}

function toCardinality(v: unknown): Cardinality {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return CARDINALITIES.has(s as Cardinality) ? (s as Cardinality) : 'many_to_many';
}

/** Coerce the object classification ('data' | 'system'); undefined when unknown. */
function toObjectClass(v: unknown): 'data' | 'system' | undefined {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return s === 'data' || s === 'system' ? s : undefined;
}

const SYSTEM_RE =
  /(system|platform|gateway|portal|\bapi\b|\berp\b|\bcrm\b|\brms\b|engine|middleware|database|系统|平台|网关|中台|引擎)/i;

/** Heuristic 'data' vs 'system' classification from the object's names. */
function classify(name: string, id: string, nameZh: string): 'data' | 'system' {
  return SYSTEM_RE.test(`${id} ${name} ${nameZh}`) ? 'system' : 'data';
}

/** Pull a plain string from a string or a {en,zh} blob (prefers en). */
function optString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as { en?: unknown; zh?: unknown };
    const en = typeof o.en === 'string' ? o.en.trim() : '';
    const zh = typeof o.zh === 'string' ? o.zh.trim() : '';
    return en || zh || undefined;
  }
  return undefined;
}

/** snake-case slug of an object id (prefix stripped), e.g. "objectType:Job_Spec" -> "job_spec". */
function idSlug(id: string): string {
  return id
    .replace(/^objectType:/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** The default primary key: an existing `<slug>_id` / `*_id` property, else `<slug>_id`. */
function guessPrimaryKey(id: string, props: ObjectProperty[]): string {
  const want = `${idSlug(id)}_id`;
  if (props.some((p) => p.name === want)) return want;
  const idProp = props.find((p) => /_id$/i.test(p.name));
  return idProp ? idProp.name : want;
}

/**
 * Parse the model's JSON defensively: strip code fences, then slice the first
 * `{` .. last `}` and JSON.parse. Returns an empty payload on any failure so a
 * single bad chunk never aborts the stage.
 */
function parseObjectsJson(raw: string): RawObjectsPayload {
  if (!raw) return {};
  let text = raw.trim();
  // Strip a leading ```json / ``` fence and trailing ``` if present.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return {};
  const slice = text.slice(first, last + 1);
  try {
    const parsed = JSON.parse(slice) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as RawObjectsPayload) : {};
  } catch {
    return {};
  }
}

/**
 * Build this stage's source-citation envelope from the model's `sources`,
 * binding each ref to the originating document (documentId/documentName) and
 * copying the VERBATIM snippet. Offsets/quoteVerified are NOT set here — the
 * orchestrator grounds them later.
 */
function mapSources(rawSources: unknown, documentId: string, documentName: string): SourceRef[] {
  const arr = Array.isArray(rawSources) ? (rawSources as RawSourceRef[]) : [];
  const refs: SourceRef[] = [];
  for (const r of arr) {
    const snippet = str(r?.snippet);
    if (!snippet) continue; // a citation without a verbatim snippet is useless to grounding
    const ref: SourceRef = {
      documentId,
      documentName: optStr(r?.documentName) ?? documentName,
      snippet,
    };
    const section = optStr(r?.section);
    if (section) ref.section = section;
    const page = optNum(r?.page);
    if (page !== undefined) ref.page = page;
    const line = optNum(r?.line);
    if (line !== undefined) ref.line = line;
    refs.push(ref);
  }
  return refs;
}

/**
 * Map the model's raw properties to typed `ObjectProperty[]`. A foreign-key
 * reference is captured RAW here (a name or id the model emitted); a later pass
 * (`resolveReferences`) rewrites it to the canonical object id or drops it.
 */
function mapProperties(rawProps: unknown): ObjectProperty[] {
  const arr = Array.isArray(rawProps) ? (rawProps as RawProperty[]) : [];
  const out: ObjectProperty[] = [];
  for (const a of arr) {
    const name = str(a?.name).trim();
    if (!name) continue;
    const prop: ObjectProperty = {
      name,
      type: toPropertyType(a?.type),
      description: str(a?.description).trim(),
    };
    const nameZh = optStr(a?.nameZh);
    if (nameZh) prop.nameZh = nameZh;
    const descriptionZh = optStr(a?.descriptionZh);
    if (descriptionZh) prop.descriptionZh = descriptionZh;
    // Foreign key: accept the new `references` or the legacy `refObjectTypeId`,
    // and treat keyRole 'fk' / is_foreign_key as the flag.
    const ref = optStr(a?.references) ?? optStr(a?.refObjectTypeId);
    const flagged = a?.is_foreign_key === true || a?.keyRole === 'fk';
    if (ref) {
      prop.is_foreign_key = true;
      prop.references = ref;
    } else if (flagged) {
      prop.is_foreign_key = true;
    }
    out.push(prop);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Stage entrypoint.
// ---------------------------------------------------------------------------

/**
 * STAGE 1 — extract ObjectTypes and the Relationships among them, chunk by
 * chunk, de-duplicating across chunks by canonical (lowercased) object/relation
 * name. Re-mapping of relationship endpoints onto canonical object ids is left
 * to the orchestrator (cross-ref grounding); here we only normalize endpoints
 * to ids the model emitted in the same chunk.
 */
export async function extractObjects(
  ctx: StageContext,
): Promise<{ objects: ObjectType[]; relationships: Relationship[] }> {
  const docNameById = new Map<string, string>();
  for (const doc of ctx.sources) docNameById.set(doc.id, doc.name);

  // De-dupe registries across chunks, keyed by canonical name.
  const objectByName = new Map<string, ObjectType>();
  const relByName = new Map<string, Relationship>();
  // Per-chunk model id -> canonical minted object id, so relationship endpoints
  // emitted by THIS chunk can be rewritten to the deduped object id.
  const objects: ObjectType[] = [];
  const relationships: Relationship[] = [];

  for (const parsed of ctx.parsed) {
    const chunkText = str(parsed.text);
    if (!chunkText.trim()) continue;
    const documentId = parsed.documentId;
    const documentName = docNameById.get(documentId) ?? documentId;

    const { system, user } = buildObjectsPrompt({ docName: documentName, chunkText });

    let raw = '';
    try {
      const llm = ctxAgentLlm(ctx, 'objects_extractor', { inputChars: chunkText.length });
      const llmOptions: ExecuteLLMOptions = {
        model: llm.model,
        provider: llm.provider as ExecuteLLMOptions['provider'],
        messages: [
          { role: 'system', content: ctx.briefSeed ? `${system}\n\n${ctx.briefSeed}` : system },
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        maxTokens: 16000,
        module: 'ontology_generator',
        actionName: 'ontology_extract_objects',
        userInfo: ctx.userInfo as ExecuteLLMOptions['userInfo'],
      };
      raw = await executeLLMWithTracking(llmOptions);
    } catch (err) {
      ctx.log(`[objects] LLM call failed for "${documentName}": ${String(err)}`);
      continue;
    }

    const payload = parseObjectsJson(raw);

    // --- objects ----------------------------------------------------------
    const rawObjects = Array.isArray(payload.objects) ? (payload.objects as RawObject[]) : [];
    // Maps the model's per-chunk object id (or name) -> canonical minted id.
    const chunkObjectId = new Map<string, string>();

    for (const ro of rawObjects) {
      const name = str(ro?.name).trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const sources = mapSources(ro?.sources, documentId, documentName);
      const confidence = rawConfidence(ro?.confidence);
      const properties = mapProperties(ro?.properties ?? ro?.attributes);
      const modelId = str(ro?.id).trim();
      const relDesc = optString(ro?.relationship_description ?? ro?.relationshipNote);

      const existing = objectByName.get(key);
      if (existing) {
        // Same object seen in an earlier chunk: union sources, keep max confidence,
        // and remember this chunk's model id maps to the canonical id.
        existing.sources.push(...sources);
        if (confidence > existing.confidence) existing.confidence = confidence;
        if (properties.length > 0 && existing.properties.length === 0) {
          existing.properties = properties;
        }
        const oc = toObjectClass(ro?.type ?? ro?.objectClass);
        if (oc) existing.type = oc;
        if (!existing.relationship_description && relDesc) existing.relationship_description = relDesc;
        const pk = str(ro?.primary_key).trim();
        if (pk && !existing.primary_key) existing.primary_key = pk;
        if (modelId) chunkObjectId.set(modelId, existing.id);
        chunkObjectId.set(key, existing.id);
        continue;
      }

      const id = makeId('object', name, ctx.taken);
      const nameZh = str(ro?.nameZh);
      const obj: ObjectType = {
        id,
        uuid: randomUUID(),
        name,
        nameZh,
        description: str(ro?.description),
        type: toObjectClass(ro?.type ?? ro?.objectClass) ?? classify(name, id, nameZh),
        relationship_description: relDesc ?? '',
        primary_key: str(ro?.primary_key).trim() || guessPrimaryKey(id, properties),
        properties,
        sources,
        confidence,
        provenance: 'extracted',
        reviewState: 'pending',
      };
      const descriptionZh = optStr(ro?.descriptionZh);
      if (descriptionZh) obj.descriptionZh = descriptionZh;
      const emoji = optStr(ro?.display?.emoji);
      const color = optStr(ro?.display?.color);
      if (emoji || color) {
        obj.display = {};
        if (emoji) obj.display.emoji = emoji;
        if (color) obj.display.color = color;
      }

      objectByName.set(key, obj);
      objects.push(obj);
      if (modelId) chunkObjectId.set(modelId, id);
      chunkObjectId.set(key, id);
    }

    // --- relationships ----------------------------------------------------
    const rawRels = Array.isArray(payload.relationships)
      ? (payload.relationships as RawRelationship[])
      : [];

    /** Resolve a model-emitted endpoint id to the canonical (deduped) object id. */
    const resolveEndpoint = (raw0: unknown): string => {
      const s = str(raw0).trim();
      if (!s) return s;
      const direct = chunkObjectId.get(s);
      if (direct) return direct;
      // The model may have referenced by name; try the lowercased-name registry.
      const byName = chunkObjectId.get(s.toLowerCase());
      return byName ?? s;
    };

    for (const rr of rawRels) {
      const verb = str(rr?.name).trim();
      const sourceObjectTypeId = resolveEndpoint(rr?.sourceObjectTypeId);
      const targetObjectTypeId = resolveEndpoint(rr?.targetObjectTypeId);
      if (!verb || !sourceObjectTypeId || !targetObjectTypeId) continue;

      // De-dupe relationships by (source, verb, target) canonical signature.
      const relKey = `${sourceObjectTypeId}|${verb.toLowerCase()}|${targetObjectTypeId}`;
      const sources = mapSources(rr?.sources, documentId, documentName);
      const confidence = rawConfidence(rr?.confidence);

      const existing = relByName.get(relKey);
      if (existing) {
        existing.sources.push(...sources);
        if (confidence > existing.confidence) existing.confidence = confidence;
        continue;
      }

      const id = makeId('relationship', `${sourceObjectTypeId}-${verb}-${targetObjectTypeId}`, ctx.taken);
      const rel: Relationship = {
        id,
        uuid: randomUUID(),
        name: verb,
        sourceObjectTypeId,
        targetObjectTypeId,
        cardinality: toCardinality(rr?.cardinality),
        sources,
        confidence,
        provenance: 'extracted',
        reviewState: 'pending',
      };
      const nameZh = optStr(rr?.nameZh);
      if (nameZh) rel.nameZh = nameZh;
      const viaAttribute = optStr(rr?.viaAttribute);
      if (viaAttribute) rel.viaAttribute = viaAttribute;
      const description = optStr(rr?.description);
      if (description) rel.description = description;

      relByName.set(relKey, rel);
      relationships.push(rel);
    }
  }

  // --- post-passes (now that ALL objects across chunks are known) -----------
  resolveReferences(objects);
  fillRelationshipDescriptions(objects, relationships);
  for (const o of objects) {
    if (!o.primary_key) o.primary_key = guessPrimaryKey(o.id, o.properties);
  }

  ctx.log(`[objects] extracted ${objects.length} objects, ${relationships.length} relationships`);
  return { objects, relationships };
}

/**
 * Rewrite each foreign-key property's `references` (a raw model name/id) to the
 * canonical object id. Unresolvable references are dropped (with the fk flag) so
 * the validator never sees a dangling `references`.
 */
function resolveReferences(objects: ObjectType[]): void {
  const idSet = new Set(objects.map((o) => o.id));
  const byName = new Map(objects.map((o) => [o.name.toLowerCase(), o.id] as const));
  const bySlug = new Map(objects.map((o) => [idSlug(o.id), o.id] as const));

  const resolve = (raw: string): string | undefined => {
    if (idSet.has(raw)) return raw;
    const lc = raw.toLowerCase();
    if (byName.has(lc)) return byName.get(lc);
    const slug = idSlug(raw);
    if (bySlug.has(slug)) return bySlug.get(slug);
    return undefined;
  };

  for (const o of objects) {
    for (const p of o.properties) {
      if (!p.references) {
        // is_foreign_key with no reference at all: clear the flag.
        if (p.is_foreign_key) delete p.is_foreign_key;
        continue;
      }
      const resolved = resolve(p.references);
      if (resolved && resolved !== o.id) {
        p.references = resolved;
        p.is_foreign_key = true;
      } else {
        delete p.references;
        delete p.is_foreign_key;
      }
    }
  }
}

/** Synthesize a relationship_description for any object the model left blank. */
function fillRelationshipDescriptions(objects: ObjectType[], relationships: Relationship[]): void {
  const nameById = new Map(objects.map((o) => [o.id, o.name] as const));
  for (const o of objects) {
    if (o.relationship_description && o.relationship_description.trim()) continue;
    const parts: string[] = [];
    for (const rel of relationships) {
      const verb = rel.name.replace(/_/g, ' ');
      if (rel.sourceObjectTypeId === o.id && nameById.has(rel.targetObjectTypeId)) {
        parts.push(`${o.name} ${verb} ${nameById.get(rel.targetObjectTypeId)}.`);
      } else if (rel.targetObjectTypeId === o.id && nameById.has(rel.sourceObjectTypeId)) {
        parts.push(`${nameById.get(rel.sourceObjectTypeId)} ${verb} ${o.name}.`);
      }
    }
    for (const p of o.properties) {
      if (p.references && nameById.has(p.references)) {
        parts.push(`${o.name}.${p.name} references ${nameById.get(p.references)}.`);
      }
    }
    const deduped = Array.from(new Set(parts));
    o.relationship_description = deduped.length
      ? deduped.join(' ')
      : `${o.name} has no documented relationships to other objects.`;
  }
}
