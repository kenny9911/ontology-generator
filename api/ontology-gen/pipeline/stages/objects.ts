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
  DataType,
  KeyRole,
  ObjectAttribute,
  ObjectType,
  Relationship,
  SourceRef,
} from '../../../_shared/ontology-schema.js';
import { DATA_TYPES } from '../../../_shared/ontology-schema.js';
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

interface RawAttribute {
  name?: unknown;
  nameZh?: unknown;
  type?: unknown;
  required?: unknown;
  keyRole?: unknown;
  enumValues?: unknown;
  refObjectTypeId?: unknown;
  description?: unknown;
  descriptionZh?: unknown;
}

interface RawObject {
  id?: unknown;
  name?: unknown;
  nameZh?: unknown;
  description?: unknown;
  descriptionZh?: unknown;
  /** Spec-format classification ('data' | 'system'); also accepted as `type`. */
  objectClass?: unknown;
  type?: unknown;
  /** Spec-format relationship prose; also accepted as `relationship_description`. */
  relationshipNote?: unknown;
  relationship_description?: unknown;
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

const DATA_TYPE_SET = new Set<string>(DATA_TYPES as readonly string[]);
const KEY_ROLES = new Set<KeyRole>(['pk', 'fk', 'none']);
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

/** Coerce to the closed DataType vocabulary; anything unknown falls back to 'string'. */
function toDataType(v: unknown): DataType {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return (DATA_TYPE_SET.has(s) ? s : 'string') as DataType;
}

function toKeyRole(v: unknown): KeyRole {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return KEY_ROLES.has(s as KeyRole) ? (s as KeyRole) : 'none';
}

function toCardinality(v: unknown): Cardinality {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return CARDINALITIES.has(s as Cardinality) ? (s as Cardinality) : 'many_to_many';
}

/** Coerce the spec-format object classification; undefined when unrecognized. */
function toObjectClass(v: unknown): 'data' | 'system' | undefined {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return s === 'data' || s === 'system' ? s : undefined;
}

/** Coerce an optional bilingual blob (or bare string) into `{en,zh}` or undefined. */
function optBilingual(v: unknown): { en: string; zh: string } | undefined {
  if (typeof v === 'string' && v.trim().length > 0) return { en: v, zh: v };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as { en?: unknown; zh?: unknown };
    const en = typeof o.en === 'string' ? o.en : '';
    const zh = typeof o.zh === 'string' ? o.zh : '';
    if (en || zh) return { en: en || zh, zh: zh || en };
  }
  return undefined;
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

function mapAttributes(rawAttrs: unknown): ObjectAttribute[] {
  const arr = Array.isArray(rawAttrs) ? (rawAttrs as RawAttribute[]) : [];
  const out: ObjectAttribute[] = [];
  for (const a of arr) {
    const name = str(a?.name).trim();
    if (!name) continue;
    const type = toDataType(a?.type);
    const keyRole = toKeyRole(a?.keyRole);
    const attr: ObjectAttribute = {
      name,
      type,
      required: a?.required === true,
      keyRole,
    };
    const nameZh = optStr(a?.nameZh);
    if (nameZh) attr.nameZh = nameZh;
    const description = optStr(a?.description);
    if (description) attr.description = description;
    const descriptionZh = optStr(a?.descriptionZh);
    if (descriptionZh) attr.descriptionZh = descriptionZh;
    // enumValues iff type === 'enum'
    if (type === 'enum' && Array.isArray(a?.enumValues)) {
      const vals = (a.enumValues as unknown[]).filter((v): v is string => typeof v === 'string');
      if (vals.length > 0) attr.enumValues = vals;
    }
    // refObjectTypeId iff type === 'reference' OR keyRole === 'fk'
    if (type === 'reference' || keyRole === 'fk') {
      const ref = optStr(a?.refObjectTypeId);
      if (ref) attr.refObjectTypeId = ref;
    }
    out.push(attr);
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
      const attributes = mapAttributes(ro?.attributes);
      const modelId = str(ro?.id).trim();

      const existing = objectByName.get(key);
      if (existing) {
        // Same object seen in an earlier chunk: union sources, keep max confidence,
        // and remember this chunk's model id maps to the canonical id.
        existing.sources.push(...sources);
        if (confidence > existing.confidence) existing.confidence = confidence;
        if (attributes.length > 0 && existing.attributes.length === 0) {
          existing.attributes = attributes;
        }
        if (!existing.objectClass) {
          const oc = toObjectClass(ro?.objectClass ?? ro?.type);
          if (oc) existing.objectClass = oc;
        }
        if (!existing.relationshipNote) {
          const rn = optBilingual(ro?.relationshipNote ?? ro?.relationship_description);
          if (rn) existing.relationshipNote = rn;
        }
        if (modelId) chunkObjectId.set(modelId, existing.id);
        chunkObjectId.set(key, existing.id);
        continue;
      }

      const id = makeId('object', name, ctx.taken);
      const obj: ObjectType = {
        id,
        uuid: randomUUID(),
        name,
        nameZh: str(ro?.nameZh),
        description: str(ro?.description),
        attributes,
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
      const objectClass = toObjectClass(ro?.objectClass ?? ro?.type);
      if (objectClass) obj.objectClass = objectClass;
      const relationshipNote = optBilingual(ro?.relationshipNote ?? ro?.relationship_description);
      if (relationshipNote) obj.relationshipNote = relationshipNote;

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

  ctx.log(`[objects] extracted ${objects.length} objects, ${relationships.length} relationships`);
  return { objects, relationships };
}
