// ============================================================================
//  layer-schemas.ts — pragmatic JSON Schemas for each editor layer.
//
//  Registered with Monaco's JSON language service so the editor squiggles
//  missing required fields, bad enums, and wrong id prefixes inline (VS Code
//  style). These are intentionally LENIENT (additionalProperties:true, only the
//  load-bearing fields required) so well-formed ontologies never light up.
//
//  The enum arrays below are a hand-maintained mirror of src/ontology/schema/
//  types.ts; Section 15 of scripts/test-json-editor.mts drift-guards
//  DATA_TYPE_ENUM / SEVERITY_ENUM against the canonical consts.
// ============================================================================

import type { EditorLayer } from './layers';

/** Minimal recursive JSON-Schema shape (draft-07 subset) — no `any`. */
export interface JsonSchemaDoc {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  items?: JsonSchemaDoc;
  properties?: Record<string, JsonSchemaDoc>;
  required?: string[];
  enum?: (string | number | boolean | null)[];
  pattern?: string;
  format?: string;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | JsonSchemaDoc;
  oneOf?: JsonSchemaDoc[];
  anyOf?: JsonSchemaDoc[];
}

// --- closed vocabs (mirror of types.ts) ------------------------------------
export const DATA_TYPE_ENUM = [
  'string', 'integer', 'decimal', 'money', 'boolean', 'date', 'datetime',
  'uuid', 'enum', 'reference', 'json', 'array',
] as const;
export const SEVERITY_ENUM = ['info', 'warn', 'block'] as const;
const KEY_ROLE_ENUM = ['pk', 'fk', 'none'] as const;
const PROVENANCE_ENUM = ['extracted', 'inferred', 'merged', 'human'] as const;
const REVIEW_ENUM = ['pending', 'accepted', 'edited', 'merged', 'rejected'] as const;
const RULE_KIND_ENUM = [
  'validation', 'constraint', 'derivation', 'state_transition', 'authorization', 'temporal',
] as const;

const enumOf = (vals: readonly string[]): JsonSchemaDoc => ({ enum: [...vals] });
const str: JsonSchemaDoc = { type: 'string' };
const num: JsonSchemaDoc = { type: 'number' };
const bool: JsonSchemaDoc = { type: 'boolean' };
const strArray: JsonSchemaDoc = { type: 'array', items: { type: 'string' } };
const bilingual: JsonSchemaDoc = {
  type: 'object',
  properties: { en: str, zh: str },
  required: ['en', 'zh'],
  additionalProperties: true,
};

/** Wrap a node schema as the array-of-nodes a layer's text holds. */
function layerArray(idPattern: string, node: JsonSchemaDoc): JsonSchemaDoc {
  const props = { id: { type: 'string', pattern: idPattern }, ...(node.properties ?? {}) };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'array',
    items: { ...node, type: 'object', properties: props, additionalProperties: true },
  };
}

const sharedProps: Record<string, JsonSchemaDoc> = {
  confidence: num,
  provenance: enumOf(PROVENANCE_ENUM),
  reviewState: enumOf(REVIEW_ENUM),
  sources: { type: 'array' },
};

const objectsSchema = layerArray('^objectType:', {
  required: ['id', 'name', 'nameZh'],
  properties: {
    ...sharedProps,
    name: str,
    nameZh: str,
    description: str,
    attributes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: str,
          type: enumOf(DATA_TYPE_ENUM),
          keyRole: enumOf(KEY_ROLE_ENUM),
          required: bool,
          enumValues: strArray,
          refObjectTypeId: str,
        },
        additionalProperties: true,
      },
    },
  },
});

const rulesSchema = layerArray('^rule:', {
  required: ['id', 'statement', 'kind', 'severity'],
  properties: {
    ...sharedProps,
    title: str,
    statement: bilingual,
    formal: str,
    kind: enumOf(RULE_KIND_ENUM),
    severity: enumOf(SEVERITY_ENUM),
    appliesToObjectTypeIds: strArray,
  },
});

const actionsSchema = layerArray('^action:', {
  required: ['id', 'name'],
  properties: {
    ...sharedProps,
    name: str,
    description: str,
    inputs: { type: 'array', items: { type: 'object', properties: { name: str, type: enumOf(DATA_TYPE_ENUM), objectTypeId: str }, additionalProperties: true } },
    outputs: { type: 'array', items: { type: 'object', properties: { name: str, type: enumOf(DATA_TYPE_ENUM), objectTypeId: str }, additionalProperties: true } },
    preconditions: { type: 'array', items: { type: 'object', properties: { ruleId: str, severity: enumOf(SEVERITY_ENUM) }, additionalProperties: true } },
    triggeredByEventIds: strArray,
    emitsEvents: { type: 'array' },
  },
});

const eventsSchema = layerArray('^event:', {
  required: ['id', 'name', 'nameZh'],
  properties: {
    ...sharedProps,
    name: str,
    nameZh: str,
    payload: { type: 'array', items: { type: 'object', properties: { name: str, type: enumOf(DATA_TYPE_ENUM), objectTypeId: str }, additionalProperties: true } },
    producedByActionIds: strArray,
    consumedByActionIds: strArray,
  },
});

const processesSchema = layerArray('^process:', {
  required: ['id'],
  properties: {
    ...sharedProps,
    name: bilingual,
    description: str,
    actors: { type: 'array' },
    objectTypeIds: strArray,
    steps: { type: 'array' },
    triggers: { type: 'array' },
  },
});

/** The per-layer JSON Schema document used by Monaco's JSON service. */
export const LAYER_SCHEMAS: Record<EditorLayer, JsonSchemaDoc> = {
  objects: objectsSchema,
  rules: rulesSchema,
  actions: actionsSchema,
  events: eventsSchema,
  processes: processesSchema,
};

/** Synthetic model URI for a layer's editor buffer (drives schema fileMatch). */
export function layerUri(layer: EditorLayer): string {
  return `inmemory://ontogen/${layer}.json`;
}

/** Stable schema URI for a layer (used as the registered schema's identity). */
export function schemaUri(layer: EditorLayer): string {
  return `inmemory://ontogen/schema/${layer}.json`;
}

/** The fileMatch glob that binds a layer's model URI to its schema. */
export function layerFileMatch(layer: EditorLayer): string {
  return `${layer}.json`;
}
