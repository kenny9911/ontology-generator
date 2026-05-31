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
export type Provenance = 'extracted' | 'inferred' | 'merged' | 'human';

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

export interface ObjectAttribute {
  /** Unique within its ObjectType. snake_case, e.g. "order_id". */
  name: string;
  nameZh?: string;
  /** Closed-vocabulary type. Enums via `enumValues`, refs via `refObjectTypeId`. */
  type: DataType;
  required: boolean;
  /** 'pk' | 'fk' | 'none'. Explicit (default 'none') so reviewers always see it. */
  keyRole: KeyRole;
  /** Present iff type === 'enum'. Allowed values, in document order. */
  enumValues?: string[];
  /** Present iff type === 'reference' OR keyRole === 'fk'. Target ObjectType.id. */
  refObjectTypeId?: string;
  description?: string;
  descriptionZh?: string;
  /** Attribute-level citation when available. */
  sources?: SourceRef[];
  confidence?: Confidence;
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
  description: string;
  descriptionZh?: string;
  attributes: ObjectAttribute[];
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
  /** Set when the param IS a domain object. */
  objectTypeId?: string;
  /** Set when the param is a scalar (mutually exclusive with objectTypeId). */
  type?: DataType;
  required: boolean;
  isArray?: boolean;
  cardinality?: 'one' | 'many';
  description?: string;
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

export interface ActionType extends NodeProvenance {
  /** Slug id, e.g. "action:fulfill-order". Prefix "action:". */
  id: string;
  uuid: string;
  /** Imperative verb-object name, e.g. "FulfillOrder". */
  name: string;
  nameZh?: string;
  description: string;
  descriptionZh?: string;
  /** Typed inputs/outputs referencing ObjectTypes — the action's signature. */
  inputs: ActionIO[];
  outputs: ActionIO[];
  /** Ordered, human-readable execution plan — the spine of actionability. */
  steps: ActionStep[];
  /** Rules that MUST pass before the action runs. 'block' among these abort. */
  preconditions: PreconditionRef[];
  /** EventType ids that cause this action to run. */
  triggeredByEventIds: string[];
  /** Events this action emits (on success/failure/always). */
  emitsEvents: EmitSpec[];
  /** Observable side-effects. */
  sideEffects?: SideEffect[];
  /** Who is allowed/expected to perform it. */
  actor: ActorRef;
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

export interface EventType extends NodeProvenance {
  /** Slug id in dotted form, e.g. "event:order.fulfilled". Prefix "event:". */
  id: string;
  uuid: string;
  /** Dotted canonical name matching the id suffix, e.g. "order.fulfilled". */
  name: string;
  nameZh: string;
  description?: string;
  descriptionZh?: string;
  /** Payload shape — fields, each optionally referencing an ObjectType. */
  payload: EventField[];
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

export interface Process extends NodeProvenance {
  /** Slug id, e.g. "process:order-to-cash". Prefix "process:". */
  id: string;
  uuid: string;
  name: Bilingual;
  description?: string;
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
}

// ===========================================================================
// 11. Generation projections (derived artifacts — NOT stored in the ontology)
// ===========================================================================

export type GeneratorTarget = 'agent-code' | 'prompts' | 'manifest';

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
