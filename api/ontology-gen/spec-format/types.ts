// ============================================================================
//  spec-format/types.ts — the EXPORT/PRESENTATION schema (the "spec format").
// ----------------------------------------------------------------------------
//  This is the shape the product PUBLISHES per ontology layer, mirroring the
//  hand-authored reference samples in `fixtures/spec-samples/*.json`
//  (objects_sample / rules_sample / actions_sample / events_sample /
//  workflow_sample). It is DELIBERATELY distinct from the canonical internal
//  schema (`api/_shared/ontology-schema.ts`): the spec format carries no
//  internal "receipts" (`sources` / `confidence` / `reviewState` / `uuid`) and
//  uses business-friendly field names + a human-facing type vocabulary
//  (String / Integer / Float / Boolean / Date / Timestamp / List<...>).
//
//  The deterministic projection from an internal `Ontology` to these types lives
//  in `./project.ts`; the contract validators in `./validate.ts`.
//
//  HARD RULES: pure types + literal consts ONLY — no runtime logic, no relative
//  project imports (a dependency-graph leaf, like the canonical schema). Strict
//  TS; `any` is not used.
// ============================================================================

// ---------------------------------------------------------------------------
// Closed vocabularies (mirror the reference samples).
// ---------------------------------------------------------------------------

/** Human-facing scalar property/IO types. `List<X>` composites are also valid. */
export const SPEC_SCALAR_TYPES = [
  'String',
  'Integer',
  'Float',
  'Boolean',
  'Date',
  'Timestamp',
] as const;
export type SpecScalarType = (typeof SPEC_SCALAR_TYPES)[number];

/** A property/IO type string: a scalar, or a `List<...>` composite. */
export type SpecPropertyType = string;

/** Object classification — a business entity vs an application/external system. */
export const SPEC_OBJECT_CLASSES = ['data', 'system'] as const;
export type SpecObjectClass = (typeof SPEC_OBJECT_CLASSES)[number];

/** Who performs a rule. */
export const SPEC_EXECUTORS = ['Human', 'Agent'] as const;
export type SpecExecutor = (typeof SPEC_EXECUTORS)[number];

/** Whether a rule is mandatory or advisory. */
export const SPEC_ENFORCEMENT_LEVELS = ['mandatory', 'optional'] as const;
export type SpecEnforcementLevel = (typeof SPEC_ENFORCEMENT_LEVELS)[number];

/** What happens on a rule violation. */
export const SPEC_FAILURE_POLICIES = ['warn', 'block'] as const;
export type SpecFailurePolicy = (typeof SPEC_FAILURE_POLICIES)[number];

/** Who/what performs an action or owns a workflow step. */
export const SPEC_ACTORS = ['Human', 'Agent', 'System'] as const;
export type SpecActor = (typeof SPEC_ACTORS)[number];

/** A workflow step's execution kind. */
export const SPEC_WORKFLOW_STEP_TYPES = ['manual', 'tool', 'logic'] as const;
export type SpecWorkflowStepType = (typeof SPEC_WORKFLOW_STEP_TYPES)[number];

/** A side-effect data-change verb. */
export const SPEC_DATA_CHANGE_ACTIONS = ['CREATE', 'MODIFY', 'DELETE'] as const;
export type SpecDataChangeAction = (typeof SPEC_DATA_CHANGE_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Receipts — the ONLY non-sample fields kept on the clean JSON (per the product
// decision): confidence + provenance + reviewState + sources. A verbatim source
// citation, mirroring the internal SourceRef.
// ---------------------------------------------------------------------------

export interface SpecSourceRef {
  documentId: string;
  documentName: string;
  snippet: string;
  page?: number;
  line?: number;
  section?: string;
  charStart?: number;
  charEnd?: number;
  sentenceRefs?: number[];
  quoteVerified?: boolean;
  confidence?: number;
}

/** The four receipts retained on every clean node. */
export interface SpecReceipts {
  confidence: number;
  provenance: string;
  reviewState: string;
  sources: SpecSourceRef[];
}

// ---------------------------------------------------------------------------
// Objects.
// ---------------------------------------------------------------------------

export interface SpecObjectProperty {
  name: string;
  type: SpecPropertyType;
  description: string;
  is_foreign_key?: boolean;
  references?: string;
}

export interface SpecObject extends SpecReceipts {
  /** English canonical key, e.g. "Candidate". */
  id: string;
  /** Display name in Chinese, e.g. "候选人". */
  name: string;
  description: string;
  type: SpecObjectClass;
  relationship_description: string;
  primary_key: string;
  properties: SpecObjectProperty[];
}

// ---------------------------------------------------------------------------
// Rules.
// ---------------------------------------------------------------------------

export interface SpecRule extends SpecReceipts {
  id: string;
  specificScenarioStage: string;
  businessLogicRuleName: string;
  applicableClient: string;
  applicableDepartment: string;
  submissionCriteria: string;
  standardizedLogicRule: string;
  relatedEntities: string[];
  businessBackgroundReason: string;
  ruleSource: string;
  executor: SpecExecutor;
  enforcementLevel: SpecEnforcementLevel;
  failurePolicy: SpecFailurePolicy;
}

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

export interface SpecActionIO {
  name: string;
  type: SpecPropertyType;
  description: string;
  source_object?: string;
  required?: boolean;
}

/** A rule referenced inside an action step. */
export interface SpecActionStepRule {
  id: string;
  name: string;
  submission_criteria: string;
  description: string;
}

export interface SpecActionStep {
  order: string;
  name: string;
  description: string;
  object_type: string;
  submission_criteria: string;
  rules?: SpecActionStepRule[];
}

export interface SpecDataChange {
  object_type: string;
  action: SpecDataChangeAction;
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

export interface SpecAction extends SpecReceipts {
  id: string;
  name: string;
  description: string;
  submission_criteria: string;
  object_type: 'action';
  category: string;
  actor: SpecActor[];
  trigger: string[];
  target_objects: string[];
  inputs: SpecActionIO[];
  outputs: SpecActionIO[];
  action_steps: SpecActionStep[];
  system_prompt: string;
  user_prompt: string;
  typescript_code?: string;
  tool_use: string[];
  side_effects: SpecSideEffects;
  triggered_event: string[];
}

// ---------------------------------------------------------------------------
// Events.
// ---------------------------------------------------------------------------

export interface SpecEventData {
  name: string;
  type: SpecPropertyType;
  target_object: string | null;
}

export interface SpecStateMutation {
  target_object: string;
  mutation_type: string;
  impacted_properties: string[];
}

export interface SpecEventPayload {
  source_action: string;
  event_data: SpecEventData[];
  state_mutations: SpecStateMutation[];
}

export interface SpecEvent extends SpecReceipts {
  name: string;
  description: string;
  payload: SpecEventPayload;
}

// ---------------------------------------------------------------------------
// Workflows (the spec-format projection of internal Processes).
// ---------------------------------------------------------------------------

export interface SpecWorkflowStep {
  order: string;
  name: string;
  description: string;
  type: SpecWorkflowStepType;
  condition: string;
}

export interface SpecWorkflow extends SpecReceipts {
  id: string;
  name: string;
  description: string;
  actor: SpecActor[];
  trigger: string[];
  actions: SpecWorkflowStep[];
  triggered_event: string[];
}

// ---------------------------------------------------------------------------
// Envelope — the five layers + the per-file metadata header.
// ---------------------------------------------------------------------------

export interface SpecMetadata {
  project_name: string;
  document_type: string;
  version: string;
  last_updated: string;
  description: string;
}

/** All five spec-format layers, projected from one ontology. */
export interface SpecBundle {
  objects: SpecObject[];
  rules: SpecRule[];
  actions: SpecAction[];
  events: SpecEvent[];
  workflows: SpecWorkflow[];
}

export interface SpecObjectsFile {
  metadata: SpecMetadata;
  objects: SpecObject[];
}
export interface SpecRulesFile {
  metadata: SpecMetadata;
  rules: SpecRule[];
}
export interface SpecActionsFile {
  metadata: SpecMetadata;
  actions: SpecAction[];
}
export interface SpecEventsFile {
  metadata: SpecMetadata;
  events: SpecEvent[];
}
export interface SpecWorkflowsFile {
  metadata: SpecMetadata;
  workflows: SpecWorkflow[];
}
