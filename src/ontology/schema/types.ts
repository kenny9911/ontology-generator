/**
 * ============================================================================
 *  CANONICAL ONTOLOGY SCHEMA — THE CONTRACT
 * ============================================================================
 *
 *  This file is the SINGLE SOURCE OF TRUTH for the shape of every ontology the
 *  Ontology Generator produces, persists, versions, imports into Neo4j, and
 *  compiles into agent code / prompts / a deployable workflow manifest.
 *
 *  HARD RULES for this file (every lens must honor — see docs/.../SCHEMA.md §Shared-types):
 *  --------------------------------------------------------------------------
 *  1. PURE TYPES + LITERAL CONSTS ONLY. No runtime logic, no side effects,
 *     and — critically — NO relative imports of other project files. This is a
 *     dependency-graph LEAF so it can be consumed by BOTH the bundler-resolved
 *     frontend (`src/`) and the NodeNext/`.js`-suffix backend (`api/`) without
 *     dragging one build's resolution rules into the other.
 *  2. Every extracted node carries `sources: SourceRef[]`, `confidence`, and a
 *     `reviewState`. These are the product's "receipts" and are never dropped.
 *  3. Cross-references between nodes are ALWAYS by `id` (a stable, kind-prefixed
 *     slug). Storage / Neo4j joins additionally use `uuid`. Refs are by `id`.
 *  4. Extraction order is fixed and encoded in `STAGE_ORDER`:
 *     Objects -> Rules -> Actions -> Events -> Processes. A later layer may only
 *     reference ids from earlier layers (Events are co-discovered with Actions).
 *  5. Bilingual is mandatory on names/statements/labels via `Bilingual`/`*Zh`.
 *
 *  This file compiles under strict TS (`strict`, `noUnusedLocals`,
 *  `noUnusedParameters`, `isolatedModules`). `any` is not used.
 * ============================================================================
 */

// ===========================================================================
// 0. Versioning + shared primitives
// ===========================================================================

/**
 * Format version of THIS schema. Bump on a breaking change to any interface
 * below so importers/migrators can branch. Persisted on every Ontology as
 * `Ontology.schemaVersion` (a numeric literal) and surfaced as this string for
 * human display / changelog. Keep the numeric and string in lockstep.
 */
export const SCHEMA_VERSION = '1.0.0' as const;

/** Numeric form of {@link SCHEMA_VERSION}, stored on the envelope. */
export const SCHEMA_VERSION_NUMBER = 1 as const;

/**
 * The fixed extraction / discovery order. The pipeline runs stages in this
 * order; the UI stepper inserts `actions` and `events` between `rules` and
 * `processes`. This is the canonical ordering all lenses reference.
 */
export const STAGE_ORDER = ['objects', 'rules', 'actions', 'events', 'processes'] as const;
export type Stage = (typeof STAGE_ORDER)[number];

/** Severity ladder for rules / preconditions, ordered least -> most blocking. */
export const SEVERITY_LEVELS = ['info', 'warn', 'block'] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

/** Closed attribute / field type vocabulary. Makes codegen + Neo4j deterministic. */
export const DATA_TYPES = [
  'string',
  'integer',
  'decimal',
  'money',
  'boolean',
  'date',
  'datetime',
  'uuid',
  'enum',
  'reference',
  'json',
  'array',
] as const;
export type DataType = (typeof DATA_TYPES)[number];

/** Key role of an attribute within its object. */
export type KeyRole = 'pk' | 'fk' | 'none';

/** Cardinality of a relationship/IO, read as source -> target. */
export type Cardinality = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';

/** How a node entered the ontology. `inferred` nodes may have empty `sources`. */
export type Provenance = 'extracted' | 'inferred' | 'web_search' | 'merged' | 'human';

/** Human-in-the-loop review status; gates what gets published. */
export type ReviewStatus = 'pending' | 'accepted' | 'edited' | 'merged' | 'rejected';

/** The 10 target domains (+ generic fallback). */
export type DomainKey =
  | 'retail_o2c'
  | 'commercial_lending'
  | 'healthcare_revcycle'
  | 'manufacturing_bom_quality'
  | 'logistics_fulfillment'
  | 'energy_grid_outage'
  | 'hr_talent_acquisition'
  | 'insurance_claims_underwriting'
  | 'public_sector_permitting'
  | 'saas_subscription_entitlement'
  | 'outsourced_recruitment'
  | 'expense_control'
  | 'contract_approval'
  | 'inventory_erp'
  | 'hr_management'
  | 'outsourced_recruitment_native'
  | 'expense_control_native'
  | 'insurance_underwriting_native'
  | 'generic';

export type Lang = 'en' | 'zh';

/** A required bilingual string. Both languages produced in one extraction pass. */
export interface Bilingual {
  en: string;
  zh: string;
}

/** Confidence score in [0,1]. Computed by the deterministic rubric, not raw LLM. */
export type Confidence = number;

/** The kinds of first-class nodes. Used by patch ops, graph rendering, codegen. */
export type EntityKind = 'object' | 'rule' | 'action' | 'event' | 'process' | 'relationship';

// ===========================================================================
// 1. Provenance — SourceDocument + SourceRef (citations)
// ===========================================================================

/** A document or system the ontology was extracted from. */
export interface SourceDocument {
  /** Stable slug id, e.g. "doc:order-fulfillment-sop". */
  id: string;
  /** Globally-unique storage handle. */
  uuid: string;
  /** Display name, e.g. "Order Fulfillment SOP.docx". */
  name: string;
  kind: 'doc' | 'db' | 'app';
  mimeType?: string;
  sizeBytes?: number;
  pageCount?: number;
  /** Object-store key / row id for the raw upload. Never the raw bytes. */
  storageRef?: string;
  /**
   * Opaque ref to the persisted, normalized plaintext of this source (stored
   * OUT of the ontology JSON to keep it light). Citation char offsets are into
   * that text; the UI highlights against it. See ParsedSource.
   */
  parsedRef?: string;
  /** SHA-256 of normalized text — detect re-uploads, re-key stable ids. */
  contentHash?: string;
}

/**
 * A precise pointer back into a source document — the spine of trust.
 * Every extracted node carries >= 1. Rules carry SENTENCE-level refs.
 */
export interface SourceRef {
  /** Which document this came from. MUST resolve to a SourceDocument.id. */
  documentId: string;
  /** Denormalized document name for display without a lookup. */
  documentName: string;
  /**
   * The VERBATIM sentence/clause the node was mined from (the model returns
   * this `excerpt`/quote; the backend recomputes offsets by locating it).
   */
  snippet: string;
  /** 1-based page (PDF) when known; 0/undefined for db/app sources. */
  page?: number;
  /** 1-based line number when known. */
  line?: number;
  /** Section marker, e.g. "§3.2". */
  section?: string;
  /** Char offsets into the source's normalized parsed text (for highlight). */
  charStart?: number;
  charEnd?: number;
  /** For rules: index/indices into the chunk's numbered-sentence array. */
  sentenceRefs?: number[];
  /**
   * Set by a DETERMINISTIC backend substring check (whitespace-normalized),
   * NOT by the model. When false, the owning node's confidence is downgraded
   * and the citation is flagged for the human reviewer — never auto-dropped.
   */
  quoteVerified?: boolean;
  /** Per-citation confidence that THIS snippet supports THIS node. */
  confidence?: Confidence;
}

/**
 * Fields shared by every first-class extracted node. Inlined (not extended via
 * a base interface that gets erased) so each node's shape is fully explicit.
 */
interface NodeProvenance {
  /** >= 1 for `extracted`/`merged` nodes; may be [] only for `inferred`. */
  sources: SourceRef[];
  confidence: Confidence;
  provenance: Provenance;
  /** Ids of other nodes an `inferred`/`merged` node was derived from. */
  derivedFrom?: string[];
  reviewState: ReviewStatus;
}

// ===========================================================================
// 2. ObjectType (extracted FIRST, most carefully)
// ===========================================================================

/**
 * Closed, human-facing property type vocabulary (the spec format). Mapped from
 * the internal DATA_TYPES during extraction: integer→Integer; decimal/money→
 * Float; boolean→Boolean; date→Date; datetime→Timestamp; enum/array→List<String>;
 * everything else (string/uuid/reference/json)→String.
 */
export const PROPERTY_TYPES = [
  'String',
  'Integer',
  'Float',
  'Boolean',
  'Date',
  'Timestamp',
  'List<String>',
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/**
 * One property (field) of an ObjectType — the spec-format shape. A foreign-key
 * property sets `is_foreign_key` + `references` (the target ObjectType.id).
 */
export interface ObjectProperty {
  /** Unique within its ObjectType. snake_case, e.g. "order_id". */
  name: string;
  /** Human-facing closed-vocabulary type. */
  type: PropertyType;
  /** Generic description of the field (language-natural). */
  description: string;
  /** True when this property points at another object (a foreign key). */
  is_foreign_key?: boolean;
  /** Set iff `is_foreign_key` — the referenced ObjectType.id. */
  references?: string;
  // ---- retained bilingual / receipt extras (optional) ----
  nameZh?: string;
  descriptionZh?: string;
  /** Property-level citation when available. */
  sources?: SourceRef[];
  confidence?: Confidence;
  /** Origin of THIS property: extracted (document) | inferred (common-sense) | web_search. */
  provenance?: Provenance;
}

export interface ObjectType extends NodeProvenance {
  /** Slug id. MUST be prefixed "objectType:". e.g. "objectType:order". */
  id: string;
  /** Globally-unique storage / Neo4j key. Immutable across edits. */
  uuid: string;
  /** PascalCase singular canonical name, e.g. "Order". */
  name: string;
  /** Chinese name, e.g. "订单". REQUIRED (bilingual product). */
  nameZh: string;
  /** Description (the document's language; the UI shows descriptionZh when zh). */
  description: string;
  descriptionZh?: string;
  /** 'data' (a business entity) vs 'system' (an application / external system). */
  type: 'data' | 'system';
  /**
   * Prose describing how this object relates to the OTHER objects — the key
   * input for building inter-object relationships. Synthesizable from
   * `Ontology.relationships` + FK properties when the model omits it.
   */
  relationship_description: string;
  /** The primary-key property name. Defaults to `<id>_id`. */
  primary_key: string;
  /** The object's fields/properties (the spec-format shape). */
  properties: ObjectProperty[];
  /**
   * Cached index of outbound Relationship ids for THIS object (UI/codegen
   * convenience). Authoritative edge list is `Ontology.relationships`.
   */
  relationshipIds?: string[];
  /** UI affordances carried so cards/graph render without a second model. */
  display?: { emoji?: string; color?: string };
}

// ===========================================================================
// 3. Relationship (first-class top-level edges between ObjectTypes)
// ===========================================================================

export interface Relationship extends NodeProvenance {
  /** Slug id, e.g. "rel:customer-places-order". Prefix "rel:". */
  id: string;
  uuid: string;
  /** Verb phrase, snake_case canonical, e.g. "places", "contains". */
  name: string;
  nameZh?: string;
  /** Optional human label for graph edges, e.g. "places → Order". */
  label?: Bilingual;
  /** Source ObjectType.id. */
  sourceObjectTypeId: string;
  /** Target ObjectType.id. */
  targetObjectTypeId: string;
  cardinality: Cardinality;
  /** If realized by an FK attribute, name it for codegen/import. */
  viaAttribute?: string;
  description?: string;
}

// ===========================================================================
// 4. Rule (mined sentence-by-sentence, then grouped)
// ===========================================================================

export type RuleKind =
  | 'validation'
  | 'constraint'
  | 'derivation'
  | 'state_transition'
  | 'authorization'
  | 'temporal';

/** Optional machine form of a rule, when the pipeline can express it. */
export interface RuleExpression {
  /** Target dialect for evaluation. CEL-style predicate strings. */
  dialect: 'cel';
  /** Compilable predicate referencing object fields by `Object.attr`. */
  predicate: string;
  /** Variables the predicate binds, mapped to ObjectType ids. */
  bindings: { var: string; objectTypeId: string }[];
}

export interface Rule extends NodeProvenance {
  /** Slug id, e.g. "rule:fulfill-after-payment". Prefix "rule:". */
  id: string;
  uuid: string;
  // ---- spec-format fields (the published rule shape) ----
  /** The scenario / lifecycle stage this rule applies in. */
  specificScenarioStage: string;
  /** Business rule name (English form; `title`/`titleZh` keep the bilingual pair). */
  businessLogicRuleName: string;
  /** Which client this applies to ("通用" = all clients). */
  applicableClient: string;
  /** Which department this applies to ("N/A" = all). */
  applicableDepartment: string;
  /** Preconditions for the rule to be evaluated. */
  submissionCriteria: string;
  /** The standardized natural-language logic (English form of `statement`). */
  standardizedLogicRule: string;
  /** Related objects as "Name (Id)" — display form of `appliesToObjectTypeIds`. */
  relatedEntities: string[];
  /** Why the rule exists (business rationale). */
  businessBackgroundReason: string;
  /** Where the rule came from (document name / interview / policy). */
  ruleSource: string;
  /** Who carries the rule out. */
  executor: 'Human' | 'Agent';
  /** Mandatory (must hold) vs optional (advisory). */
  enforcementLevel: 'mandatory' | 'optional';
  /** On violation: 'block' the gated action vs 'warn' only. */
  failurePolicy: 'warn' | 'block';
  // ---- retained engine + bilingual structure (receipts) ----
  /** Short handle/title for lists, bilingual. */
  title: string;
  titleZh?: string;
  /** The rule in natural language — REQUIRED in both languages. */
  statement: Bilingual;
  /** Human-readable formal/logical expression string (always present). */
  formal: string;
  /** Optional structured machine form (best-effort). */
  expression?: RuleExpression;
  kind: RuleKind;
  /** block aborts a gated action; warn surfaces; info documents. */
  severity: Severity;
  /** ObjectType ids this rule constrains. At least one. */
  appliesToObjectTypeIds: string[];
  /** Specific attributes referenced, "objectTypeId.attr" form. Optional. */
  appliesToAttributes?: string[];
  /** When the rule is evaluated. */
  trigger?: { description: string; onEventTypeId?: string };
  /** Post-grouping cluster id (rules mined sentence-by-sentence are GROUPED). */
  groupId?: string;
}

/** Organizational grouping of related rules (never deletes a rule/citation). */
export interface RuleGroup {
  /** Slug id, e.g. "ruleGroup:credit-hold". */
  id: string;
  title: Bilingual;
  ruleIds: string[];
  rationale?: string;
}

// ===========================================================================
// 5. ActionType (each maps to an agent tool / function — the AGENTIC core)
// ===========================================================================

/** A typed input/output of an action, referencing an ObjectType or a scalar. */
export interface ActionIO {
  /** snake_case local param name, e.g. "order". */
  name: string;
  /** Human-facing type ("String" / "Integer" / "List<String>" / ...). */
  type?: string;
  /** Generic description of the parameter. */
  description?: string;
  /** For an object-typed param: "ObjectId.primary_key" (the spec source_object). */
  source_object?: string;
  required?: boolean;
  /** Retained: the ObjectType id when this param IS a domain object. */
  objectTypeId?: string;
  isArray?: boolean;
  cardinality?: 'one' | 'many';
}

export interface ActionStep {
  /** 1-based order. Array order is the default; `order` is the durable key. */
  order: number;
  /** Human description, bilingual. */
  text: Bilingual;
  /** ObjectType ids this step reads. */
  readsObjectTypeIds?: string[];
  /** ObjectType ids this step writes. */
  writesObjectTypeIds?: string[];
  /** If this step is itself an action call (composition). */
  callsActionTypeId?: string;
  /** If the step is gated by a rule. */
  guardRuleId?: string;
}

/** A precondition rule reference (severity cached for display). */
export interface PreconditionRef {
  ruleId: string;
  /** Cached from the Rule for display; the Rule's value is authoritative. */
  severity?: Severity;
}

/** Spec for an event emitted by an action. */
export interface EmitSpec {
  eventTypeId: string;
  /** When the event fires. */
  on: 'success' | 'failure' | 'always';
  /** Optional CEL guard. */
  condition?: string;
}

/** Observable side-effect of an action — for codegen + risk review. */
export interface SideEffect {
  kind: 'db_write' | 'external_call' | 'notification' | 'state_change' | 'payment' | 'other';
  description: string;
  /** Target ObjectType id for db_write/state_change. */
  objectTypeId?: string;
}

/** Who performs an action / participates in a process. */
export interface ActorRef {
  /** Human role name, e.g. "Fulfillment", "Adjuster". */
  role: string;
  roleZh?: string;
  /** Drives whether an LLM agent owns this action. */
  kind: 'human' | 'agent' | 'system';
}

/** Minimal JSON-Schema subset emitted/consumed for tool parameters. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProp>;
  required?: string[];
}
export interface JsonSchemaProp {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: JsonSchemaProp;
  /** Cross-link back to the domain object this property represents. */
  $objectTypeId?: string;
}

/**
 * The AGENTIC binding — turns an ActionType into a callable tool. Only
 * `parameterSchema` is cached in the ontology JSON; the rest is derived.
 */
export interface AgentBinding {
  /** Canonical tool/function name an agent calls. snake_case, e.g. "fulfill_order". */
  toolName: string;
  /** JSON-Schema for the tool's parameters (derived from inputs, cached here). */
  parameterSchema: JsonSchema;
  /** Short description for the agent's tool list. */
  toolDescription: string;
  /** Hints injected when an agent owns this action (style, cautions, citations). */
  promptHints?: string[];
  /** Suggested runtime mapping. */
  execution: 'function' | 'llm_tool' | 'human_task';
  /** If it maps to an existing integration (Salesforce, Stripe...). */
  integration?: string;
}

/** Who/what performs an action or workflow step (spec-format). */
export type SpecActor = 'Human' | 'Agent' | 'System';

/** A rule referenced inside an action step (spec-format). */
export interface SpecActionStepRule {
  id: string;
  name: string;
  submission_criteria: string;
  description: string;
}

/** One step of an action's plan (spec-format). */
export interface SpecActionStep {
  order: string;
  name: string;
  description: string;
  object_type: string;
  submission_criteria: string;
  rules?: SpecActionStepRule[];
}

export type DataChangeAction = 'CREATE' | 'MODIFY' | 'DELETE';

export interface SpecDataChange {
  object_type: string;
  action: DataChangeAction;
  property_impacted: string[];
  description: string;
}

export interface SpecNotification {
  recipient: string;
  channel: string | string[];
  condition: string;
  message: string;
  triggered_event: string;
}

export interface SpecSideEffects {
  data_changes: SpecDataChange[];
  notifications: SpecNotification[];
}

export interface ActionType extends NodeProvenance {
  /** Slug id, e.g. "action:fulfill-order". Prefix "action:". */
  id: string;
  uuid: string;
  /** camelCase function-style name, e.g. "fulfillOrder". */
  name: string;
  nameZh?: string;
  description: string;
  descriptionZh?: string;
  // ---- spec-format fields (the published action shape) ----
  /** Preconditions / events that must be met before running. */
  submission_criteria: string;
  /** Always "action". */
  object_type: 'action';
  /** Short category label. */
  category: string;
  /** Who performs it (spec form). */
  actor: SpecActor[];
  /** Event names that trigger this action. */
  trigger: string[];
  /** Spec object ids this action reads/writes. */
  target_objects: string[];
  /** Ordered logic steps (spec form). */
  action_steps: SpecActionStep[];
  /** Agent system prompt. */
  system_prompt: string;
  /** Agent user prompt. */
  user_prompt: string;
  /** Optional generated TypeScript implementation (spec-format, default ""). */
  typescript_code?: string;
  /** External tools/integrations the action calls. */
  tool_use: string[];
  /** Data changes + notifications (spec form). */
  side_effects: SpecSideEffects;
  /** Event names this action emits. */
  triggered_event: string[];
  // ---- retained engine structure (receipts) ----
  /** Typed inputs/outputs (enriched: type + source_object + retained objectTypeId). */
  inputs: ActionIO[];
  outputs: ActionIO[];
  /** Ordered, human-readable execution plan. */
  steps: ActionStep[];
  /** Rules that MUST pass before the action runs. */
  preconditions: PreconditionRef[];
  /** EventType ids that cause this action to run. */
  triggeredByEventIds: string[];
  /** Events this action emits (on success/failure/always). */
  emitsEvents: EmitSpec[];
  /** Observable side-effects (structured). */
  sideEffects?: SideEffect[];
  /** Who is allowed/expected to perform it (structured; `actor` is the spec form). */
  actorRef: ActorRef;
  /** Capability strings, e.g. "order:fulfill". */
  permissions?: string[];
  /** AGENTIC binding — the callable tool contract. */
  agent: AgentBinding;
}

// ===========================================================================
// 6. EventType (the events Actions reference)
// ===========================================================================

export interface EventField {
  name: string;
  type: DataType;
  /** When the field carries a domain object/ref. */
  objectTypeId?: string;
  required: boolean;
  description?: string;
}

/** One payload datum of an event (spec-format). */
export interface SpecEventData {
  name: string;
  type: string;
  /** The spec object id this datum belongs to, or null. */
  target_object: string | null;
}

/** A state mutation an event records (spec-format). */
export interface SpecStateMutation {
  target_object: string;
  mutation_type: string;
  impacted_properties: string[];
}

/** Event payload (spec-format): the source action + data + state mutations. */
export interface SpecEventPayload {
  source_action: string;
  event_data: SpecEventData[];
  state_mutations: SpecStateMutation[];
}

export interface EventType extends NodeProvenance {
  /** Slug id in dotted form, e.g. "event:order.fulfilled". Prefix "event:". */
  id: string;
  uuid: string;
  /** Event name in UPPER_SNAKE form, e.g. "ORDER_FULFILLED". */
  name: string;
  nameZh: string;
  description?: string;
  descriptionZh?: string;
  // ---- spec-format fields (the published event shape) ----
  /** Payload (spec form): source action + event data + state mutations. */
  payload: SpecEventPayload;
  // ---- retained engine structure (receipts) ----
  /** Payload field shapes (retained; `payload.event_data` is the spec view). */
  payloadFields: EventField[];
  /** Action ids that emit this event (derived from Action.emitsEvents). */
  producedByActionIds: string[];
  /** Action ids triggered by this event (derived from Action.triggeredByEventIds). */
  consumedByActionIds: string[];
}

// ===========================================================================
// 7. Process / Workflow (chains ActionTypes end-to-end)
// ===========================================================================

/** A single step in a process: an action plus its outgoing edges. */
export interface WorkflowStep {
  /** Stable id within the process, e.g. "s1". */
  id: string;
  /** The ActionType this step executes. */
  actionTypeId: string;
  /** Display order / default linear sequence. */
  order: number;
  /** The role responsible (must be one of Process.actors). */
  actorRole?: string;
  /** Outgoing edges. Empty => terminal. Multiple => a branch. */
  next: ProcessEdge[];
}

export interface ProcessEdge {
  /** Target WorkflowStep id. */
  toStepId: string;
  /** Branch condition (CEL) — taken when true. Omit for unconditional. */
  condition?: string;
  /** If the transition is event-driven, the EventType id that fires it. */
  onEventTypeId?: string;
  /** Human label for the branch. */
  label?: Bilingual;
}

export interface ProcessTrigger {
  kind: 'event' | 'manual' | 'schedule';
  /** When kind==='event'. */
  eventTypeId?: string;
  /** Cron, when kind==='schedule'. */
  schedule?: string;
  description?: string;
}

export interface OrchestrationSpec {
  /** How steps run relative to each other. */
  strategy: 'sequential' | 'event_driven' | 'state_machine';
  /** If true, the whole process can be owned by a single orchestrating agent. */
  agentOrchestrated: boolean;
  /** Role -> agent prompt-profile binding for codegen. */
  agentRoles?: { role: string; promptProfile: string }[];
  /** Compensation/rollback hint for failed steps (saga-style). */
  onFailure?: 'halt' | 'compensate' | 'escalate';
}

/** One step of a workflow (spec-format). */
export interface SpecWorkflowStep {
  order: string;
  name: string;
  description: string;
  type: 'manual' | 'tool' | 'logic';
  condition: string;
}

export interface Process extends NodeProvenance {
  /** Slug id, e.g. "process:order-to-cash". Prefix "process:". */
  id: string;
  uuid: string;
  /** Bilingual name; the spec export camelCases `name.en` (e.g. "manualEntry"). */
  name: Bilingual;
  description?: string;
  // ---- spec-format fields (the published workflow shape) ----
  /** Who runs the workflow (spec form). */
  actor: SpecActor[];
  /** Event names that start the workflow (or "SCHEDULED_SYNC"). */
  trigger: string[];
  /** Ordered workflow steps (spec form). */
  actions: SpecWorkflowStep[];
  /** Event names the workflow emits. */
  triggered_event: string[];
  // ---- retained engine structure (receipts) ----
  /** Actors that participate, with their kind. */
  actors: ActorRef[];
  /** ObjectType ids the process touches (denormalized for UI/summary). */
  objectTypeIds: string[];
  /** The ordered graph of steps. Linear by default; branches via `next` edges. */
  steps: WorkflowStep[];
  /** Entry points: events / manual / schedule. */
  triggers: ProcessTrigger[];
  /** AGENTIC orchestration metadata for the operator runtime. */
  orchestration: OrchestrationSpec;
}

// ===========================================================================
// 8. Ontology envelope (the unit of versioning / validation / publish / import)
// ===========================================================================

export interface UserRef {
  userId: string;
  name?: string;
  email?: string;
}

export interface VersionEntry {
  version: number;
  at: string; // ISO-8601
  by?: UserRef;
  note?: string;
  /** Counts vs previous version. */
  delta?: { added: number; changed: number; removed: number };
}

/**
 * Web-search (Tavily) supplement appended to extraction context when the user
 * enables live web search. Computed ONCE per run, cached on metadata, and
 * injected into every stage prompt. Objects/properties derived solely from it
 * are tagged `provenance: 'web_search'`.
 */
export interface WebAugmentation {
  /** The industry/domain the planner identified from the corpus. */
  industry: string;
  /** The business scenario the planner identified. */
  scenario: string;
  /** The search queries actually run against Tavily. */
  queries: string[];
  /** The synthesized, density-filtered supplement text (capped). */
  text: string;
  /** Result provenance the user can audit (title + url). */
  sources: { title: string; url: string }[];
  /** ISO-8601 timestamp the augmentation was computed. */
  at: string;
}

export interface OntologyMetadata {
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  createdBy?: UserRef;
  publishedAt?: string;
  /** Pipeline provenance for reproducibility. */
  generation?: {
    model: string;
    provider: string;
    runId: string;
    durationMs?: number;
  };
  /** Computed counters surfaced in UI (objects/rules/...). */
  stats?: Record<string, number>;
  /** Per-version changelog, newest first. */
  history?: VersionEntry[];
  /** Review-trail: dangling cross-refs detected at validate time, for UI. */
  danglingRefs?: { from: string; field: string; missingId: string }[];
  /** Review-trail: per-stage critique notes from the extraction pass. */
  stageCritiques?: Partial<Record<Stage, string>>;
  /** Live web-search (Tavily) supplement that augmented extraction, when enabled.
   *  Set for any mode whose run requested web search; absent otherwise. */
  webAugmentation?: WebAugmentation;

  // ---- Deep-swarm artifacts (optional; only set by the opt-in swarm mode) ----
  /** Web-augmented SME business-understanding brief that framed extraction. */
  businessBrief?: BusinessBrief;
  /** Latest coverage/recall report (recomputed at the end of each iteration). */
  coverageReport?: CoverageReport;
  /** Follow-up questions for the user, emitted at the end of the swarm run. */
  followUpQuestions?: FollowUpQuestion[];
  /** Swarm run provenance. */
  swarm?: { iterations: number; web: boolean };

  // ---- Hyper-automation artifacts (optional; only set by the opt-in hyper mode) ----
  /** Recognized business terminology / data-type glossary (hyper phase 1). */
  terminology?: TerminologyExtraction;
  /** Latest document-coverage eval pass. */
  documentCoverage?: DocumentCoverageEval;
  /** Earlier coverage passes, findings trimmed to [] to keep the envelope light. */
  documentCoverageHistory?: DocumentCoverageEval[];
  /** Hyper run provenance. */
  hyper?: { passes: number; coverageTarget: number; remediationRounds: number; web: boolean };
}

/**
 * The complete, versioned, citable model of one enterprise domain.
 * THIS JSON is the source of truth. Neo4j is a projection of it.
 */
export interface Ontology {
  /** Stable slug id, unique per tenant. e.g. "ontology:acme-retail-o2c". */
  id: string;
  /** Globally-unique storage / Neo4j key. Immutable. */
  uuid: string;
  /** Human name, bilingual. */
  name: string;
  nameZh?: string;
  /** One of the 10 target domains (+ generic). */
  domain: DomainKey;
  /** Monotonic publish version. Bumped on each save/publish (append-only). */
  version: number;
  /** Numeric schema-format version (=== SCHEMA_VERSION_NUMBER). */
  schemaVersion: typeof SCHEMA_VERSION_NUMBER;
  /** 'draft' until published. */
  status: 'draft' | 'published';

  /** The documents/systems this ontology was extracted from. */
  sourceDocuments: SourceDocument[];

  /** The five extracted layers, in canonical order, each ordered by discovery. */
  objects: ObjectType[];
  rules: Rule[];
  actions: ActionType[];
  events: EventType[];
  processes: Process[];

  /** First-class top-level edges between objects. */
  relationships: Relationship[];
  /** Optional rule groupings. */
  ruleGroups?: RuleGroup[];

  /** Aggregate confidence (0..1), weighted mean of node confidences. Computed. */
  confidence: Confidence;

  metadata: OntologyMetadata;
}

// ===========================================================================
// 9. Out-of-envelope companions (persisted separately, referenced by ontology)
// ===========================================================================

/**
 * The normalized plaintext + page map of one parsed source. Stored OUT of the
 * Ontology JSON (keyed by SourceDocument.parsedRef) so the envelope stays light;
 * citation offsets/highlights are computed against `text`.
 */
export interface ParsedSource {
  ref: string;
  documentId: string;
  text: string;
  pageMap?: { page: number; charStart: number; charEnd: number }[];
}

/**
 * Runtime object data (actual Orders, Claims, ...). Type-vs-instance split:
 * this schema defines TYPES; instances live primarily in Neo4j. JSON instance
 * sets are a demo/seed convenience only.
 */
export interface ObjectInstance {
  /** Slug id, e.g. "inst:order:8f2c...". */
  id: string;
  /** -> ObjectType.id. */
  objectTypeId: string;
  props: Record<string, unknown>;
  edges?: { relationshipId: string; toInstanceId: string }[];
}

// ===========================================================================
// 10. Pipeline run state (client-driven staged orchestration)
// ===========================================================================

export type RunStatus = 'pending' | 'running' | 'complete' | 'error';

export interface StageProgress {
  stage: Stage;
  status: RunStatus;
  /** Items produced so far. */
  count: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface OntologyRun {
  id: string;
  ontologyId: string;
  status: RunStatus;
  /** null before first step / after complete. */
  currentStage: Stage | null;
  /** One entry per STAGE_ORDER stage. */
  stages: StageProgress[];
  /** Streamed to the live log panel. */
  log: { at: string; text: string }[];
  createdAt: string;
  updatedAt: string;

  /**
   * The ontology name was auto-derived (e.g. from uploaded filenames) and should
   * be upgraded to a content-descriptive title once extraction completes. Set by
   * `run.start` for uploaded corpora; cleared after the one-shot upgrade.
   */
  autoName?: boolean;

  /** The user enabled live web-search augmentation (Tavily) for this run. The
   *  pipeline computes the supplement once, then caches it on metadata. */
  webSearch?: boolean;

  // ---- Deep-swarm / hyper mode (optional; absent on the fast single-pass path) ----
  /** Extraction mode. Absent or `'fast'` = the classic single-pass pipeline. */
  mode?: 'fast' | 'swarm' | 'hyper';
  /** Current high-level swarm/hyper phase (mode === 'swarm' | 'hyper'). null before/after. */
  currentPhase?: RunPhase | null;
  /** One entry per SWARM_PHASE_ORDER (swarm) / HYPER_PHASE_ORDER (hyper) phase. */
  phases?: SwarmPhaseProgress[];
}

// ===========================================================================
// 10b. Deep-swarm extraction (opt-in multi-agent mode). See ONTOLOGY_GENERATION.md.
//      All types optional on the envelope; absent on the fast single-pass path.
// ===========================================================================

/**
 * High-level phases of the opt-in deep-swarm mode. The client steps through
 * these via `run.swarm.step`; each fine-grained backend sub-step reports under
 * one of these for the UI stepper. Mirrors the STAGE_ORDER const pattern.
 */
export const SWARM_PHASE_ORDER = [
  'business_understanding',
  'iteration_1',
  'iteration_2',
  'follow_up',
] as const;
export type SwarmPhase = (typeof SWARM_PHASE_ORDER)[number];

/** A business persona/actor the SME swarm identifies for the domain. */
export interface Persona {
  id: string;
  name: Bilingual;
  description?: Bilingual;
  goals?: Bilingual[];
}

/** A canonical business use case the ontology must support. */
export interface UseCase {
  id: string;
  name: Bilingual;
  description?: Bilingual;
  /** Persona ids that participate. */
  personaIds: string[];
  /** ExpectedEntity ids this use case relies on. */
  expectedEntityIds?: string[];
}

/** A glossary term for the domain (bilingual). */
export interface GlossaryTerm {
  term: Bilingual;
  definition: Bilingual;
}

/**
 * Something the SME swarm EXPECTS to appear for this domain (a recall target).
 * After extraction, `found` records whether the ontology captured it.
 */
export interface ExpectedEntity {
  id: string;
  /** Which layer this expectation belongs to. */
  kind: EntityKind;
  name: Bilingual;
  description?: Bilingual;
  /** True once a matching node was extracted/inferred. */
  found: boolean;
  /** The ontology node id that satisfied this expectation, when found. */
  matchedId?: string;
}

/**
 * The business-understanding brief produced by the web-augmented SME swarm,
 * carried on `OntologyMetadata.businessBrief`. Drives recall in both iterations.
 */
export interface BusinessBrief {
  /** One-paragraph scenario framing, bilingual. */
  summary: Bilingual;
  personas: Persona[];
  useCases: UseCase[];
  /** The expected-vs-found checklist across all layers. */
  expectedEntities: ExpectedEntity[];
  glossary: GlossaryTerm[];
  /** True when live web search contributed; false = parametric fallback. */
  webAugmented: boolean;
  /** Source labels/URLs the SME swarm cited (best-effort). */
  references?: string[];
}

/** A coverage/recall gap the BA review or coverage critic found. */
export interface CoverageGap {
  id: string;
  /** Which layer the gap is in (or 'general'). */
  layer: EntityKind | 'general';
  description: Bilingual;
  severity: Severity;
  /** The use case the gap blocks, when applicable. */
  useCaseId?: string;
  /** A related ontology node id, when the gap concerns a specific item. */
  relatedItemId?: string;
}

/** Per-layer recall: expected vs found. */
export interface LayerCoverage {
  layer: EntityKind;
  expected: number;
  found: number;
  /** found / expected, clamped to [0,1]. */
  recall: number;
}

/** Per-use-case coverage. */
export interface UseCaseCoverage {
  useCaseId: string;
  /** 0..1 — fraction of the use case's expected entities that are present. */
  coverage: number;
  /** CoverageGap ids blocking this use case. */
  gapIds: string[];
}

/**
 * The coverage report produced by the BA/coverage agents, carried on
 * `OntologyMetadata.coverageReport`. Recomputed at the end of each iteration.
 */
export interface CoverageReport {
  /** Which iteration produced this report (1 or 2). */
  iteration: number;
  perLayer: LayerCoverage[];
  perUseCase: UseCaseCoverage[];
  gaps: CoverageGap[];
  /** Weighted overall recall across layers, 0..1. */
  overallRecall: number;
}

/**
 * A follow-up question emitted at the end of the swarm run, each tied to the
 * gap / ambiguity / low-confidence item it addresses. Carried on
 * `OntologyMetadata.followUpQuestions`. Read-only output (not interactive in v1).
 */
export interface FollowUpQuestion {
  id: string;
  question: Bilingual;
  /** Why we're asking — the gap/ambiguity rationale. */
  rationale?: Bilingual;
  layer: EntityKind | 'general';
  /** The CoverageGap.id this resolves, when applicable. */
  addressesGapId?: string;
  /** The ontology node id this concerns, when applicable. */
  relatedItemId?: string;
}

/** Live status of one agent within a swarm phase (for the progress UI). */
export interface SwarmAgentProgress {
  id: string;
  /** Human role label, e.g. "SME · Data", "Business Analyst". */
  role: string;
  status: RunStatus;
  note?: string;
}

/** Progress of one high-level swarm/hyper phase (parallel to StageProgress). */
export interface SwarmPhaseProgress {
  /** Phase id from SWARM_PHASE_ORDER (swarm runs) or HYPER_PHASE_ORDER (hyper runs). */
  phase: RunPhase;
  status: RunStatus;
  /** Short bilingual label for the stepper. */
  label?: Bilingual;
  /** Free-text detail / current sub-step. */
  detail?: string;
  agents?: SwarmAgentProgress[];
  startedAt?: string;
  finishedAt?: string;
}

// ===========================================================================
// 10c. Hyper-automation extraction (opt-in deep mode). See docs/HYPER_AUTOMATION_DESIGN.md.
//      All types optional on the envelope; absent on the fast/swarm paths.
// ===========================================================================

/**
 * High-level phases of the opt-in hyper-automation mode. A superset of the
 * swarm machine: a terminology sweep runs first, and each extraction iteration
 * is followed by a sentence-level document-coverage eval plus targeted
 * remediation of whatever it found uncovered. The client steps through these
 * via `run.hyper.step`. Mirrors the SWARM_PHASE_ORDER const pattern.
 */
export const HYPER_PHASE_ORDER = [
  'terminology',
  'business_understanding',
  'iteration_1',
  'coverage_eval_1',
  'remediation_1',
  'iteration_2',
  'coverage_eval_2',
  'remediation_2',
  'final_eval',
  'follow_up',
] as const;
export type HyperPhase = (typeof HYPER_PHASE_ORDER)[number];

/**
 * Any high-level run phase — swarm or hyper. `OntologyRun.currentPhase` and
 * `SwarmPhaseProgress.phase` use this so one progress surface serves both modes.
 */
export type RunPhase = SwarmPhase | HyperPhase;

/** Closed vocabulary for what kind of business term a glossary entry names. */
export type TermKind =
  | 'entity'
  | 'attribute'
  | 'metric'
  | 'role'
  | 'status'
  | 'document'
  | 'system'
  | 'abbreviation'
  | 'event'
  | 'process'
  | 'other';

/**
 * One business term recognized by the terminology sweep (hyper phase 1).
 * Terms are metadata, NOT layer nodes — they are never grounded by the
 * orchestrator, but their snippets must be verbatim per the prompt contract.
 */
export interface TermEntity {
  /** Slug id, prefix "term:", minted via makeId kind 'term'. */
  id: string;
  /** The term itself, bilingual. */
  term: Bilingual;
  /** Concise definition as evidenced by the documents, bilingual. */
  definition: Bilingual;
  /** What kind of thing the term names. */
  kind: TermKind;
  /** Recognized closed-vocabulary data type, when the term is data-shaped. */
  dataTypeHint?: DataType;
  /** Enumerated values spelled out in the documents, when the term is an enum set. */
  enumValuesHint?: string[];
  /** Synonyms / abbreviations the documents use for the same term. */
  aliases?: string[];
  /** Verbatim citations into the source documents. */
  sources: SourceRef[];
  /** The ontology node id that realized this term (deterministic name/alias match). */
  matchedId?: string;
}

/**
 * The glossary produced by the terminology sweep, carried on
 * `OntologyMetadata.terminology`. Its rendered seed block is appended to every
 * later extraction prompt to drive recall and data-type fidelity.
 */
export interface TerminologyExtraction {
  terms: TermEntity[];
  /** Computed counters (e.g. per kind) surfaced in UI. */
  stats?: Record<string, number>;
}

/** Verdict for one source sentence in the document-coverage eval. */
export type SentenceCoverageStatus = 'covered' | 'partial' | 'uncovered' | 'uncoverable';

/**
 * Coverage verdict for ONE numbered source sentence — the unit of the
 * eval agent's "did the ontology account for the whole document?" check.
 */
export interface SentenceCoverage {
  /** Global 1-based sentence index, continuous across all sources. */
  idx: number;
  /** The document the sentence belongs to (SourceDocument.id). */
  documentId: string;
  /** The sentence text, verbatim from the parsed source. */
  text: string;
  status: SentenceCoverageStatus;
  /** Ontology node ids whose citations cover this sentence. */
  coveredBy?: string[];
  /** Layers that SHOULD represent this sentence (routes remediation). */
  expectedKinds?: EntityKind[];
  /** What the ontology is missing for this sentence, free text. */
  missing?: string;
}

/**
 * The document-coverage eval report — sentence-level verification that every
 * meaningful sentence of every source document is represented in the ontology.
 * Carried on `OntologyMetadata.documentCoverage` (latest pass) and
 * `documentCoverageHistory` (earlier passes, findings trimmed).
 */
export interface DocumentCoverageEval {
  /** Which eval pass produced this report (1, 2, or 3 = final). */
  pass: number;
  totalSentences: number;
  covered: number;
  partial: number;
  uncovered: number;
  uncoverable: number;
  /** covered / max(1, total - uncoverable). */
  coverageRatio: number;
  /** Target ratio (env ONTOLOGY_GEN_COVERAGE_TARGET, default 1.0). */
  target: number;
  /** True when coverageRatio >= target — the hyper run's success gate. */
  meetsTarget: boolean;
  /** ONLY partial|uncovered entries retained (keeps the envelope light). */
  findings: SentenceCoverage[];
  evaluatedAt: string; // ISO-8601
}

// ===========================================================================
// 10d. LLM agent registry / settings + inference (hyper-automation).
// ===========================================================================

/** What an LLM agent is for — drives the smart router's strength-tier choice. */
export const AGENT_PURPOSES = [
  'extraction',
  'enrichment',
  'review',
  'reasoning',
  'synthesis',
  'inference',
  'classification',
] as const;
export type AgentPurpose = (typeof AGENT_PURPOSES)[number];

/** One LLM-calling agent in the system (a frontend-visible registry row). */
export interface AgentDef {
  /** Stable agent id, e.g. "rules_extractor". */
  id: string;
  /** Human label for the settings table, bilingual. */
  label: Bilingual;
  description?: Bilingual;
  purpose: AgentPurpose;
  /** Which pipeline the agent belongs to ('shared' = used by several). */
  group: 'fast' | 'swarm' | 'hyper' | 'inference' | 'shared';
}

/** The resolved provider+model for one agent, plus where the choice came from. */
export interface AgentModelAssignment {
  agentId: string;
  provider: string;
  model: string;
  /** Resolution precedence, first hit wins: env > settings > router > default. */
  source: 'env' | 'settings' | 'router' | 'default';
  /** Human-readable reason for the choice (router tier, env var name, ...). */
  rationale?: string;
}

/** User-editable LLM routing settings (the settings page), persisted globally. */
export interface LlmSettings {
  /** Per-agent overrides, keyed by agent id. */
  overrides: Record<string, { provider?: string; model?: string }>;
  defaultProvider?: string;
  defaultModel?: string;
  /** Smart per-agent router on/off. Default true. */
  routerEnabled?: boolean;
  /** Tavily API key for live web-search augmentation. env TAVILY_API_KEY wins. */
  tavilyApiKey?: string;
  updatedAt?: string;
}

/** One subject–predicate–object fact projected from the ontology graph. */
export interface Triple {
  /** Subject node id. */
  s: string;
  /** Predicate — a closed, documented vocabulary (e.g. 'consumes', 'precedes'). */
  p: string;
  /** Object node id, or a literal value when `literal` is true. */
  o: string;
  literal?: boolean;
}

/** One reasoning hop of the inference agent: the triples used + the conclusion. */
export interface InferenceHop {
  /** 1-based hop number. */
  step: number;
  /** The triples this hop reasoned over. */
  triples: Triple[];
  /** Conclusion drawn at this hop. */
  inference: string;
}

/**
 * The result of one multi-hop inference run over the ontology graph, returned
 * by the `infer` action. The engine owns the graph walk; `hops` record the
 * LLM's reasoning chain so the answer is auditable end-to-end.
 */
export interface InferenceResult {
  question: string;
  answer: Bilingual;
  /** The reasoning chain, one entry per expansion iteration that drew a conclusion. */
  hops: InferenceHop[];
  /** Node ids on the reasoning path (for graph highlighting). */
  pathNodeIds: string[];
  /** Total triples projected from the ontology. */
  tripleCount: number;
  /** Triples actually shown to the agent during the walk. */
  usedTripleCount: number;
  /** LLM expansion iterations consumed. */
  iterations: number;
  durationMs?: number;
}

// ===========================================================================
// 11. Generation projections (derived artifacts — NOT stored in the ontology)
// ===========================================================================

export type GeneratorTarget = 'agent-code' | 'prompts' | 'manifest' | 'spec';

export interface GeneratedFile {
  path: string;
  language: string;
  content: string;
}

export interface GeneratedBundle {
  target: GeneratorTarget;
  files: GeneratedFile[];
  warnings: string[];
}

/** A self-contained, deployable manifest for one Process (pins ontologyVersion). */
export interface WorkflowManifest {
  manifestVersion: 1;
  ontologyId: string;
  ontologyVersion: number;
  processId: string;
  name: Bilingual;
  trigger: ProcessTrigger[];
  /** Flattened, ordered nodes ready for an operator runtime. */
  nodes: ManifestNode[];
  /** Tool catalog referenced by nodes. */
  tools: {
    toolName: string;
    parameterSchema: JsonSchema;
    execution: string;
    integration?: string;
  }[];
  /** Agent roles with their composed prompt + owned tools. */
  agents: { role: string; prompt: string; tools: string[] }[];
}

export interface ManifestNode {
  /** WorkflowStep id. */
  id: string;
  /** ActionType.agent.toolName. */
  actionToolName: string;
  actorRole?: string;
  preconditions: { ruleId: string; predicate?: string; severity: Severity }[];
  emits: { eventTypeId: string; on: string }[];
  next: { toStepId: string; condition?: string; onEventTypeId?: string }[];
}
