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
const PROPERTY_TYPE_ENUM = ['String', 'Integer', 'Float', 'Boolean', 'Date', 'Timestamp', 'List<String>'] as const;
const OBJECT_CLASS_ENUM = ['data', 'system'] as const;
const EXECUTOR_ENUM = ['Human', 'Agent'] as const;
const ACTOR_ENUM = ['Human', 'Agent', 'System'] as const;
const ENFORCEMENT_ENUM = ['mandatory', 'optional'] as const;
const FAILURE_POLICY_ENUM = ['warn', 'block'] as const;
const WF_STEP_TYPE_ENUM = ['manual', 'tool', 'logic'] as const;
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
  required: ['id', 'name', 'type', 'primary_key', 'properties'],
  properties: {
    ...sharedProps,
    name: str,
    nameZh: str,
    description: str,
    type: enumOf(OBJECT_CLASS_ENUM),
    relationship_description: str,
    primary_key: str,
    properties: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'type', 'description'],
        properties: {
          name: str,
          type: enumOf(PROPERTY_TYPE_ENUM),
          description: str,
          is_foreign_key: bool,
          references: str,
        },
        additionalProperties: true,
      },
    },
  },
});

const rulesSchema = layerArray('^rule:', {
  required: [
    'id', 'businessLogicRuleName', 'standardizedLogicRule',
    'executor', 'enforcementLevel', 'failurePolicy',
  ],
  properties: {
    ...sharedProps,
    // spec-format fields
    specificScenarioStage: str,
    businessLogicRuleName: str,
    applicableClient: str,
    applicableDepartment: str,
    submissionCriteria: str,
    standardizedLogicRule: str,
    relatedEntities: strArray,
    businessBackgroundReason: str,
    ruleSource: str,
    executor: enumOf(EXECUTOR_ENUM),
    enforcementLevel: enumOf(ENFORCEMENT_ENUM),
    failurePolicy: enumOf(FAILURE_POLICY_ENUM),
    // retained engine + bilingual structure
    title: str,
    statement: bilingual,
    formal: str,
    kind: enumOf(RULE_KIND_ENUM),
    severity: enumOf(SEVERITY_ENUM),
    appliesToObjectTypeIds: strArray,
  },
});

const ioItem: JsonSchemaDoc = {
  type: 'object',
  properties: { name: str, type: enumOf(PROPERTY_TYPE_ENUM), description: str, source_object: str, required: bool },
  additionalProperties: true,
};
const actionsSchema = layerArray('^action:', {
  required: ['id', 'name', 'object_type', 'submission_criteria', 'actor', 'action_steps'],
  properties: {
    ...sharedProps,
    name: str,
    description: str,
    // spec-format fields
    submission_criteria: str,
    object_type: { enum: ['action'] },
    category: str,
    actor: { type: 'array', items: enumOf(ACTOR_ENUM) },
    trigger: strArray,
    target_objects: strArray,
    inputs: { type: 'array', items: ioItem },
    outputs: { type: 'array', items: ioItem },
    action_steps: { type: 'array', items: { type: 'object', properties: { order: str, name: str, description: str, object_type: str, submission_criteria: str }, additionalProperties: true } },
    system_prompt: str,
    user_prompt: str,
    tool_use: strArray,
    side_effects: { type: 'object', additionalProperties: true },
    triggered_event: strArray,
    // retained engine structure
    preconditions: { type: 'array', items: { type: 'object', properties: { ruleId: str, severity: enumOf(SEVERITY_ENUM) }, additionalProperties: true } },
    triggeredByEventIds: strArray,
    emitsEvents: { type: 'array' },
  },
});

const eventsSchema = layerArray('^event:', {
  required: ['id', 'name', 'payload'],
  properties: {
    ...sharedProps,
    name: str,
    nameZh: str,
    // spec-format payload object
    payload: {
      type: 'object',
      properties: {
        source_action: str,
        event_data: { type: 'array', items: { type: 'object', properties: { name: str, type: enumOf(PROPERTY_TYPE_ENUM), target_object: { type: ['string', 'null'] } }, additionalProperties: true } },
        state_mutations: { type: 'array', items: { type: 'object', properties: { target_object: str, mutation_type: str, impacted_properties: strArray }, additionalProperties: true } },
      },
      additionalProperties: true,
    },
    // retained engine structure
    payloadFields: { type: 'array', items: { type: 'object', properties: { name: str, type: enumOf(DATA_TYPE_ENUM), objectTypeId: str }, additionalProperties: true } },
    producedByActionIds: strArray,
    consumedByActionIds: strArray,
  },
});

const processesSchema = layerArray('^process:', {
  required: ['id', 'name', 'actor', 'actions'],
  properties: {
    ...sharedProps,
    name: bilingual,
    description: str,
    // spec-format workflow fields
    actor: { type: 'array', items: enumOf(ACTOR_ENUM) },
    trigger: strArray,
    actions: { type: 'array', items: { type: 'object', properties: { order: str, name: str, description: str, type: enumOf(WF_STEP_TYPE_ENUM), condition: str }, additionalProperties: true } },
    triggered_event: strArray,
    // retained engine structure
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
