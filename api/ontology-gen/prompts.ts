/**
 * ============================================================================
 *  ONTOLOGY GENERATOR — PROMPT ASSETS (production)
 * ============================================================================
 *
 *  Self-contained prompt builders for the 5-stage extraction pipeline
 *  (Objects -> Rules -> Actions -> Events -> Processes), the cross-chunk merge
 *  step, and the 3 generation targets (agent code, agent prompts, manifest).
 *
 *  HARD RULES for THIS file:
 *  --------------------------------------------------------------------------
 *  - ZERO project imports. Pure functions, no runtime side effects. This file
 *    is a dependency-graph LEAF so the dev-server rewriter (`scripts/api-server.cjs`)
 *    can shim it to `prompts.dev.ts` and Vercel can bundle it without dragging
 *    schema/`ai.ts` resolution rules in. The schema field names below are
 *    inlined VERBATIM (they restate the LOCKED contract in
 *    `src/ontology/schema/types.ts` + `docs/ontology-generator/SCHEMA.md` §4)
 *    and are kept honest by review, not by import.
 *  - Every builder returns `{ system, user }`. The caller wires these into
 *    `executeLLMWithTracking({ module: 'ontology_generator', actionName, model,
 *    messages: [{role:'system',content:system},{role:'user',content:user}],
 *    temperature, maxTokens, userInfo })`. Extraction temperature 0.1;
 *    generation 0.3. The caller owns model/maxTokens/temperature.
 *
 *  CONTRACT NOTES (these are the binding field names — do NOT drift):
 *  - IDs are kind-prefixed slugs: `objectType:` `rel:` `rule:` `action:`
 *    `event:` `process:`. Events use a DOTTED suffix: `event:order.fulfilled`.
 *  - Every extracted node carries: `sources: SourceRef[]` (>=1 verbatim
 *    `snippet`), `confidence` (0..1), `provenance` ('extracted'|'inferred'|
 *    'merged'|'human'), `reviewState` ('pending'|'accepted'|'edited'|'merged'|
 *    'rejected'). The model emits these; the backend recomputes offsets and
 *    `quoteVerified` deterministically (NEVER the model).
 *  - Bilingual is mandatory: objects/actions/events carry `nameZh`; rules a
 *    `statement: {en,zh}`; processes a `name: {en,zh}`.
 *  - DataType is a CLOSED vocabulary (lowercase). Severity is info|warn|block.
 *  - Cross-refs by `id` only; later stages reuse EXACT ids from prior stages.
 * ============================================================================
 */

export interface PromptPair {
  system: string;
  user: string;
}

// ===========================================================================
// 0. Shared scaffolding (inlined into every extraction system prompt)
// ===========================================================================

/** Closed DataType vocabulary, restated for the model (matches DATA_TYPES). */
const DATA_TYPES =
  'string | integer | decimal | money | boolean | date | datetime | uuid | enum | reference | json | array';

/**
 * GLOBAL RULES — inlined verbatim at the top of every extraction system prompt.
 * Encodes the non-negotiables: JSON-only, extract-not-invent, mandatory verbatim
 * citations, kind-prefixed slug ids, bilingual, honest confidence, closed enums.
 */
const SHARED_RULES = `GLOBAL RULES (these override any instinct to be verbose or "helpful"):
1. OUTPUT ONLY a single JSON object that matches the OUTPUT CONTRACT below. No prose,
   no markdown, no code fences, no commentary, no trailing text.
2. EXTRACT, never invent. If the document does not state it, do NOT emit it. Returning
   FEWER, correct items is the goal. Never fabricate to look "complete".
3. CITATIONS ARE MANDATORY. Every node needs "sources" with >=1 SourceRef whose "snippet"
   is copied VERBATIM from the document (trim to one sentence/clause; never paraphrase
   inside "snippet"). If you cannot find a supporting snippet, DROP the node. Populate
   "documentName" with the provided DOCUMENT NAME. Do NOT emit charStart/charEnd/
   quoteVerified — the backend computes those.
4. IDS are lowercase, kind-prefixed slugs ([a-z0-9.-]):
     objectType:<slug>  rel:<slug>  rule:<slug>  action:<slug>  process:<slug>
     event:<dotted.name>  (events use a dotted suffix, e.g. event:order.fulfilled)
   When referring to a node from a PRIOR STAGE, reuse its EXACT id. Never rename an
   existing id; never invent ids for collections you were not given.
5. BILINGUAL is required. Provide BOTH English and Simplified Chinese where the contract
   asks (nameZh / statement.{en,zh} / name.{en,zh} / text.{en,zh}). zh must be a faithful
   business translation, never pinyin, never left blank.
6. CONFIDENCE is your honest 0..1 estimate of how DIRECTLY the document supports the node.
   Multi-sentence inferences score lower than directly-stated facts. Be calibrated.
7. CONTROLLED VOCABULARIES ONLY. Never invent enum members.
     DataType: ${DATA_TYPES}
     Severity: info | warn | block
     provenance: "extracted" (default for things you mine from text)
     reviewState: "pending" (always, for newly extracted nodes)
8. SELF-CHECK before returning (see SELF-CHECK block). Silently fix violations; do not
   narrate the fixes in the output.`;

/** Self-critique checklist appended to every extraction system prompt. */
const SELF_CHECK = `SELF-CHECK (run this silently, then emit only the corrected JSON):
- [ ] Output is ONE JSON object with the exact top-level key, nothing else.
- [ ] Every node has >=1 source whose "snippet" is a verbatim substring of the evidence.
      If any snippet is paraphrased or not found, fix it to a real quote or DROP the node.
- [ ] Every id is a correctly kind-prefixed slug; every cross-ref id exists in the prior
      stage or in this output. Remove or repair dangling references.
- [ ] No invented enum values; every DataType/severity/provenance is from the vocabulary.
- [ ] Bilingual fields are filled in BOTH languages with faithful business translations.
- [ ] No duplicate nodes (same meaning => one node, union of sources, max confidence).
- [ ] confidence reflects evidence strength (lower for indirect/multi-sentence inference).`;

/** Pretty-print a value for embedding in a prompt; tolerates undefined. */
function asJson(v: unknown): string {
  if (v === undefined || v === null) return '[]';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

/** Fence a block of evidence so the model sees clear boundaries. */
function fence(label: string, body: string): string {
  return `${label}:\n"""\n${body}\n"""`;
}

// ===========================================================================
// 1. STAGE 1 — OBJECT TYPES
// ===========================================================================

export function buildObjectsPrompt(args: { docName: string; chunkText: string }): PromptPair {
  const { docName, chunkText } = args;
  const system = `You are an expert enterprise data architect performing ONTOLOGY EXTRACTION,
Stage 1 of 5: OBJECT TYPES (business entities). This is the MOST important stage — every
downstream rule, action, event, and process references the objects you define here, so be
precise and conservative.

${SHARED_RULES}

WHAT TO EXTRACT
- Every business ENTITY the document treats as a thing with identity and attributes
  (Customer, Order, Invoice, Claim, LoanFacility, Patient, Shipment, Part, Policy).
- DO NOT create objects for: verbs/operations (those are Actions, Stage 3), events
  (Stage 4), one-off values, report names, UI labels, or section headings.
- For each object: PascalCase singular "name" (+ "nameZh"), a one-sentence "description"
  (+ "descriptionZh"), its ATTRIBUTES, and its RELATIONSHIPS to other objects in THIS output.

ATTRIBUTE RULES
- "name" in snake_case. "type" from the closed DataType vocabulary ONLY.
- "keyRole" is "pk" (primary identifier), "fk" (points at another object), or "none".
- If "type" is "enum", list "enumValues" exactly as written in the document.
- If "keyRole" is "fk" OR "type" is "reference", set "refObjectTypeId" to the target object id.
- "required": true only when the document implies the field is mandatory.

RELATIONSHIP RULES (emitted as a TOP-LEVEL "relationships" array)
- Each relationship is a first-class edge: a verb "name" (snake_case, e.g. "places",
  "contains", "ships"), "sourceObjectTypeId", "targetObjectTypeId", and "cardinality"
  (one_to_one | one_to_many | many_to_one | many_to_many). Use "viaAttribute" when the
  edge is realized by an fk attribute. Only relate objects you ALSO emit here.

OUTPUT CONTRACT — return EXACTLY this shape (one JSON object):
{
  "objects": [
    {
      "id": "objectType:customer",
      "name": "Customer",
      "nameZh": "客户",
      "description": "A party that places orders.",
      "descriptionZh": "下订单的一方。",
      "attributes": [
        { "name": "customer_id", "nameZh": "客户编号", "type": "uuid", "required": true,
          "keyRole": "pk", "description": "Unique identity." },
        { "name": "tier", "type": "enum", "required": true, "keyRole": "none",
          "enumValues": ["Standard","Premium","Enterprise"] }
      ],
      "sources": [
        { "documentId": "", "documentName": "${docName}", "section": "§3.2",
          "snippet": "Each customer is assigned a tier of Standard, Premium, or Enterprise." }
      ],
      "confidence": 0.95, "provenance": "extracted", "reviewState": "pending"
    }
  ],
  "relationships": [
    {
      "id": "rel:customer-places-order",
      "name": "places", "nameZh": "下单",
      "sourceObjectTypeId": "objectType:customer",
      "targetObjectTypeId": "objectType:order",
      "cardinality": "one_to_many", "viaAttribute": "customer_id",
      "sources": [ { "documentId": "", "documentName": "${docName}",
        "snippet": "A customer places one or more orders." } ],
      "confidence": 0.9, "provenance": "extracted", "reviewState": "pending"
    }
  ]
}

NEGATIVE EXAMPLE: "Refund" is usually an action outcome / event, NOT an object — do not emit
it as an object unless the document gives it identity and attributes of its own.

${SELF_CHECK}`;

  const user = `DOCUMENT NAME: ${docName}

${fence('DOCUMENT (extract objects + relationships from THIS text only)', chunkText)}

Extract all Object Types and the Relationships among them per the OUTPUT CONTRACT.
Return ONLY the JSON object.`;

  return { system, user };
}

// ===========================================================================
// 2. STAGE 2 — RULES (sentence-by-sentence, then grouped)
// ===========================================================================

export function buildRulesPrompt(args: {
  docName: string;
  numberedSentences: { idx: number; text: string }[];
  priorObjects: unknown;
}): PromptPair {
  const { docName, numberedSentences, priorObjects } = args;
  const system = `You are an expert business-rules analyst performing ONTOLOGY EXTRACTION,
Stage 2 of 5: RULES. Mine rules SENTENCE BY SENTENCE over the NUMBERED SENTENCES, then GROUP
adjacent sentences that express ONE rule. Citations are at the SENTENCE level.

${SHARED_RULES}

METHOD (follow exactly)
1. Read the NUMBERED SENTENCES. Scan each for normative / conditional language: "must",
   "may not", "shall", "unless", "only if", "within N days", "requires", "is prohibited",
   thresholds, and state transitions. Skip narrative, definitions, and headings.
2. For each obligation/constraint emit ONE rule. If several ADJACENT sentences express one
   rule, group them: cite ALL their indices in "sources[].sentenceRefs" and put the verbatim
   joined text in "sources[].snippet".
3. Express each rule THREE ways: a bilingual natural-language "statement" {en, zh}, a
   "formal" string (always present), and an optional "expression" (CEL machine form).
4. Link each rule to the object ids it constrains via "appliesToObjectTypeIds" — use ids
   from the PRIOR OBJECTS only; never invent object ids. Optional "appliesToAttributes" in
   "objectTypeId.attr" form.
5. "kind": validation | constraint | derivation | state_transition | authorization | temporal.
6. "severity": "block" (hard — gated action aborts), "warn" (should-not, surfaced),
   "info" (documentary / derivation).
7. "trigger" (optional): { "description": "...", "onEventTypeId"?: "event:..." } — when the
   rule is evaluated. Omit onEventTypeId if no event is known yet.

FORMAL STYLE: object.attribute notation + logical operators (->, ∧, ∨, ¬, =, ≠, <, >, ≤, ≥, ∈, Σ).
  e.g. "Order.status = Fulfilled -> (Payment.amount ≥ Invoice.total) ∨ (Customer.tier = Enterprise)".
CEL "expression" (optional, best-effort): { "dialect": "cel", "predicate": "...", "bindings":
  [{ "var": "order", "objectTypeId": "objectType:order" }] }.

OUTPUT CONTRACT — return EXACTLY this shape:
{
  "rules": [
    {
      "id": "rule:fulfill-after-payment",
      "title": "Fulfill after payment", "titleZh": "收款后履约",
      "statement": {
        "en": "An order may only be fulfilled after payment is received in full, unless the customer's tier is Enterprise.",
        "zh": "订单仅在收到全额付款后方可履约；客户层级为 Enterprise 时除外。"
      },
      "formal": "Order.status = Fulfilled -> (Payment.amount ≥ Invoice.total) ∨ (Customer.tier = Enterprise)",
      "expression": { "dialect": "cel",
        "predicate": "order.status != 'Fulfilled' || payment.amount >= invoice.total || customer.tier == 'Enterprise'",
        "bindings": [{ "var": "order", "objectTypeId": "objectType:order" }] },
      "kind": "state_transition", "severity": "block",
      "appliesToObjectTypeIds": ["objectType:order","objectType:payment","objectType:customer"],
      "appliesToAttributes": ["objectType:order.status"],
      "trigger": { "description": "on Order.status transition to Fulfilled" },
      "sources": [
        { "documentId": "", "documentName": "${docName}", "section": "§3.2",
          "sentenceRefs": [42, 43],
          "snippet": "Fulfillment teams may not release goods until payment has cleared. Enterprise customers operate under net-30 terms." }
      ],
      "confidence": 0.94, "provenance": "extracted", "reviewState": "pending"
    }
  ]
}

${SELF_CHECK}
- [ ] Every rule has at least one "sentenceRefs" index and a verbatim "snippet".
- [ ] Every appliesToObjectTypeIds entry exists in the PRIOR OBJECTS.`;

  const user = `DOCUMENT NAME: ${docName}

${fence('PRIOR OBJECTS (objects already accepted — reuse these EXACT ids)', asJson(priorObjects))}

NUMBERED SENTENCES (mine rules from these; cite by idx in sentenceRefs):
${asJson(numberedSentences)}

Mine all rules sentence-by-sentence, grouping adjacent sentences that form one rule.
Return ONLY the JSON object.`;

  return { system, user };
}

// ===========================================================================
// 3. STAGE 3 — ACTION TYPES (the agentic core)
// ===========================================================================

export function buildActionsPrompt(args: {
  priorObjects: unknown;
  priorRules: unknown;
  chunkText: string;
  docName?: string;
}): PromptPair {
  const { priorObjects, priorRules, chunkText } = args;
  const docName = args.docName ?? 'the document';
  const system = `You are an expert process & automation architect performing ONTOLOGY
EXTRACTION, Stage 3 of 5: ACTION TYPES. Each Action is something an actor (human, agent, or
system) DOES that changes state. Each Action will later become a CALLABLE AGENT TOOL, so make
typed inputs/outputs, steps, preconditions, and event wiring precise.

${SHARED_RULES}

WHAT TO EXTRACT
- Operations the document describes: "release shipment", "approve refund", "set reserve",
  "submit claim", "issue invoice", "extend offer".
- For each Action emit:
  - "name": PascalCase imperative verb-object, e.g. "FulfillOrder" (+ "nameZh").
  - "description" (+ "descriptionZh").
  - "inputs"/"outputs": typed ActionIO. Use "objectTypeId" (an id from PRIOR OBJECTS) when the
    param IS a domain object; otherwise use a scalar "type" from the DataType vocabulary.
    "objectTypeId" and "type" are MUTUALLY EXCLUSIVE. Include "required"; optional "isArray"/
    "cardinality" ('one'|'many').
  - "steps": ordered ActionStep[] — { "order", "text": {en,zh}, "readsObjectTypeIds"?,
    "writesObjectTypeIds"?, "callsActionTypeId"?, "guardRuleId"? }.
  - "preconditions": PreconditionRef[] — { "ruleId", "severity"? } — rules (from PRIOR RULES)
    that MUST pass before the action. Choose from the provided rules; do not invent rule ids.
  - "triggeredByEventIds": event ids that cause this action to run. If you EXPECT an event but
    it is not yet defined, use a best-effort dotted slug "event:<dotted.name>"; Stage 4 reconciles.
  - "emitsEvents": EmitSpec[] — { "eventTypeId", "on": "success"|"failure"|"always", "condition"? }.
  - "sideEffects": SideEffect[] — { "kind": "db_write"|"external_call"|"notification"|
    "state_change"|"payment"|"other", "description", "objectTypeId"? }.
  - "actor": ActorRef — { "role", "roleZh"?, "kind": "human"|"agent"|"system" }.
  - "permissions"?: capability strings, e.g. "order:fulfill".
  - "agent": AgentBinding — { "toolName" (snake_case, e.g. "fulfill_order"), "parameterSchema"
    (JSON-Schema object derived from inputs: { "type":"object", "properties":{...}, "required":[...] };
    a property that represents a domain object carries "$objectTypeId"), "toolDescription"
    (one line), "promptHints"? (string[]), "execution": "function"|"llm_tool"|"human_task",
    "integration"? }.

OUTPUT CONTRACT — return EXACTLY this shape:
{
  "actions": [
    {
      "id": "action:fulfill-order",
      "name": "FulfillOrder", "nameZh": "履约订单",
      "description": "Release goods for a paid order.", "descriptionZh": "为已付款订单放行货物。",
      "inputs": [{ "name": "order", "objectTypeId": "objectType:order", "required": true }],
      "outputs": [{ "name": "shipment", "objectTypeId": "objectType:shipment", "required": true }],
      "steps": [
        { "order": 1, "text": { "en": "Verify payment cleared", "zh": "确认收款到账" },
          "readsObjectTypeIds": ["objectType:payment"], "guardRuleId": "rule:fulfill-after-payment" },
        { "order": 2, "text": { "en": "Generate carrier label", "zh": "生成承运面单" },
          "writesObjectTypeIds": ["objectType:shipment"] }
      ],
      "preconditions": [{ "ruleId": "rule:fulfill-after-payment", "severity": "block" }],
      "triggeredByEventIds": ["event:payment.received"],
      "emitsEvents": [{ "eventTypeId": "event:order.fulfilled", "on": "success" }],
      "sideEffects": [{ "kind": "state_change", "description": "Order.status := Fulfilled",
        "objectTypeId": "objectType:order" }],
      "actor": { "role": "Fulfillment", "roleZh": "履约", "kind": "agent" },
      "permissions": ["order:fulfill"],
      "agent": {
        "toolName": "fulfill_order",
        "parameterSchema": { "type": "object",
          "properties": { "order": { "type": "object", "$objectTypeId": "objectType:order" } },
          "required": ["order"] },
        "toolDescription": "Release goods for a paid order.", "execution": "function"
      },
      "sources": [{ "documentId": "", "documentName": "${docName}",
        "snippet": "Release the shipment once payment clears." }],
      "confidence": 0.9, "provenance": "extracted", "reviewState": "pending"
    }
  ]
}

${SELF_CHECK}
- [ ] Every input/output uses EITHER objectTypeId (an id in PRIOR OBJECTS) OR a scalar type, never both.
- [ ] Every preconditions[].ruleId exists in PRIOR RULES.
- [ ] "agent.toolName" is snake_case and "agent.parameterSchema" mirrors the inputs.`;

  const user = `DOCUMENT NAME: ${docName}

${fence('PRIOR OBJECTS (reuse these EXACT ids for objectTypeId refs)', asJson(priorObjects))}

${fence('PRIOR RULES (choose preconditions from these — id + statement)', asJson(priorRules))}

${fence('DOCUMENT (extract actions from THIS text)', chunkText)}

Extract all Action Types per the OUTPUT CONTRACT. Return ONLY the JSON object.`;

  return { system, user };
}

// ===========================================================================
// 4. STAGE 4 — EVENT TYPES (reconcile + wire; inverse of actions)
// ===========================================================================

export function buildEventsPrompt(args: { actions: unknown; docName?: string }): PromptPair {
  const { actions } = args;
  const docName = args.docName ?? 'the document';
  const system = `You are an event-modeling expert performing ONTOLOGY EXTRACTION, Stage 4 of 5:
EVENT TYPES. Events are business facts that occur at a point in time and connect Actions
(producer -> event -> consumer). This stage is PRIMARILY RECONCILIATION of the event ids the
Actions already reference, plus any events the document names.

${SHARED_RULES}

WHAT TO EXTRACT — wire from the ACTIONS:
- DEFINE every event id referenced by the ACTIONS: every id in any action's "emitsEvents[].eventTypeId"
  and every id in any action's "triggeredByEventIds". Define each exactly once.
- "id" is a DOTTED slug "event:<domain>.<past_tense>", e.g. "event:order.fulfilled".
  "name" is the dotted suffix matching the id, e.g. "order.fulfilled". Add "nameZh".
- "payload": EventField[] — { "name", "type" (DataType), "objectTypeId"? (when the field carries
  a domain object/ref), "required", "description"? }. Infer payload from the emitting action's
  outputs and the objects involved.
- INVERSE WIRING (must be the EXACT inverse of the actions):
  - "producedByActionIds": every action whose "emitsEvents" includes THIS event id.
  - "consumedByActionIds": every action whose "triggeredByEventIds" includes THIS event id.
- If an event is referenced by an action but the document gives no detail, still define it with
  an empty payload, "provenance": "inferred", "derivedFrom": [the referencing action id],
  "sources": [], and confidence ≤ 0.6. Otherwise "provenance": "extracted" with a verbatim source.

OUTPUT CONTRACT — return EXACTLY this shape:
{
  "events": [
    {
      "id": "event:payment.received",
      "name": "payment.received", "nameZh": "已收款",
      "description": "Payment for an order has cleared.", "descriptionZh": "订单付款已到账。",
      "payload": [
        { "name": "payment", "type": "reference", "objectTypeId": "objectType:payment", "required": true },
        { "name": "amount", "type": "money", "required": true }
      ],
      "producedByActionIds": ["action:record-payment"],
      "consumedByActionIds": ["action:fulfill-order"],
      "sources": [{ "documentId": "", "documentName": "${docName}",
        "snippet": "When payment clears, fulfillment is notified." }],
      "confidence": 0.85, "provenance": "extracted", "reviewState": "pending"
    }
  ]
}

${SELF_CHECK}
- [ ] Every event id referenced by any action is defined exactly once.
- [ ] producedByActionIds / consumedByActionIds are the EXACT inverse of the actions' emits/triggers.
- [ ] Inferred events (no document detail) carry derivedFrom + empty sources + confidence ≤ 0.6.`;

  const user = `DOCUMENT NAME: ${docName}

${fence('ACTIONS (define and wire every event these reference; invert their emits/triggers)', asJson(actions))}

Define and wire all Event Types per the OUTPUT CONTRACT. Return ONLY the JSON object.`;

  return { system, user };
}

// ===========================================================================
// 5. STAGE 5 — PROCESSES (workflow step-graph + orchestration)
// ===========================================================================

export function buildProcessesPrompt(args: {
  actions: unknown;
  events: unknown;
  objects: unknown;
  docName?: string;
}): PromptPair {
  const { actions, events, objects } = args;
  const docName = args.docName ?? 'the document';
  const system = `You are a business-process architect performing ONTOLOGY EXTRACTION, Stage 5
of 5: PROCESSES. A Process chains Action Types end-to-end into a workflow STEP-GRAPH, linked by
the Events they emit/consume and guarded by Rules. This is the source for a deployable workflow
manifest, so ordering and wiring must be correct.

${SHARED_RULES}

WHAT TO EXTRACT
- End-to-end workflows the document describes (e.g. "Order to Cash", "FNOL to Settlement").
- Build the chain by following event producer -> consumer links in the ACTIONS + EVENTS:
  an action that emits event E is followed by the action(s) whose triggeredByEventIds include E.
- Each process emits a STEP-GRAPH in "steps": WorkflowStep[] where each step is
  { "id" (process-local, e.g. "s1"), "actionTypeId" (an id from ACTIONS), "order",
    "actorRole"? (one of the process actors), "next": ProcessEdge[] }.
  ProcessEdge = { "toStepId", "condition"? (CEL, taken when true), "onEventTypeId"? (the event
  that fires the transition), "label"? {en,zh} }. Linear flow = exactly one edge per step;
  a terminal step has "next": []. Branches = multiple edges with conditions.
- "name": { en, zh }. "actors": ActorRef[] ({role, roleZh?, kind}). "objectTypeIds": object ids
  the process touches (denormalized). "triggers": ProcessTrigger[] — { "kind": "event"|"manual"|
  "schedule", "eventTypeId"? (kind=event), "schedule"? (cron, kind=schedule), "description"? }.
- "orchestration": OrchestrationSpec — { "strategy": "sequential"|"event_driven"|"state_machine",
  "agentOrchestrated": boolean, "agentRoles"? [{ "role", "promptProfile" }],
  "onFailure"?: "halt"|"compensate"|"escalate" }.
- Processes are typically SYNTHESIZED from the action/event graph: set "provenance": "inferred"
  and "derivedFrom": [contributing action/event ids] with "sources": [] when there is no single
  verbatim sentence; use "provenance": "extracted" with a real snippet only when the document
  names the workflow directly.

OUTPUT CONTRACT — return EXACTLY this shape:
{
  "processes": [
    {
      "id": "process:order-to-cash",
      "name": { "en": "Order to Cash", "zh": "订单到回款" },
      "description": "From order placement through cash collection.",
      "actors": [
        { "role": "Customer", "kind": "human" },
        { "role": "Fulfillment", "kind": "agent" }
      ],
      "objectTypeIds": ["objectType:order","objectType:invoice","objectType:shipment","objectType:payment"],
      "steps": [
        { "id": "s1", "actionTypeId": "action:place-order", "order": 1, "actorRole": "Customer",
          "next": [{ "toStepId": "s2", "onEventTypeId": "event:order.placed" }] },
        { "id": "s2", "actionTypeId": "action:fulfill-order", "order": 2, "actorRole": "Fulfillment",
          "next": [{ "toStepId": "s3", "onEventTypeId": "event:order.fulfilled",
                     "label": { "en": "after fulfillment", "zh": "履约后" } }] },
        { "id": "s3", "actionTypeId": "action:settle-payment", "order": 3, "actorRole": "Finance",
          "next": [] }
      ],
      "triggers": [{ "kind": "event", "eventTypeId": "event:order.placed" }],
      "orchestration": { "strategy": "event_driven", "agentOrchestrated": true, "onFailure": "escalate" },
      "sources": [], "confidence": 0.85, "provenance": "inferred",
      "derivedFrom": ["action:place-order","action:fulfill-order","action:settle-payment"],
      "reviewState": "pending"
    }
  ]
}

${SELF_CHECK}
- [ ] Every step.actionTypeId exists in ACTIONS; every onEventTypeId exists in EVENTS.
- [ ] Every ProcessEdge.toStepId points to a step in the SAME process; exactly one terminal step.
- [ ] actorRole on a step is one of the process "actors".`;

  const user = `DOCUMENT NAME: ${docName}

${fence('OBJECTS (id + name — for objectTypeIds)', asJson(objects))}

${fence('ACTIONS (chain these by following event emit -> trigger links)', asJson(actions))}

${fence('EVENTS (producer/consumer wiring already computed)', asJson(events))}

Synthesize all Processes as step-graphs per the OUTPUT CONTRACT. Return ONLY the JSON object.`;

  return { system, user };
}

// ===========================================================================
// 6. MERGE — cross-chunk de-duplication (map/reduce reduce step)
// ===========================================================================

export function buildMergePrompt(args: {
  stage: 'objects' | 'rules' | 'actions' | 'events' | 'processes' | 'relationships';
  chunkOutputs: unknown[];
}): PromptPair {
  const { stage, chunkOutputs } = args;
  // The top-level key the model must emit per stage.
  const key = stage;
  const system = `You merge multiple PARTIAL extractions of ONTOLOGY stage "${stage}" — produced
from different chunks of the SAME corpus — into ONE clean, de-duplicated list. Output ONLY JSON.

MERGE RULES
1. Items with the SAME id, OR the same canonical name/meaning, are the SAME item. Merge them:
   - union "attributes" / "steps" / "inputs" / "outputs" / "payload" / "next" by their own
     identity (attribute name / step order / IO name / field name / edge toStepId);
   - union and DEDUPLICATE "sources" (a citation is unique by documentName + snippet + sentenceRefs);
   - keep the LONGEST non-empty description and the most complete bilingual fields;
   - take the MAX "confidence";
   - if "provenance" differs, prefer "extracted" over "inferred"; set "merged" only when two
     extracted items combined; preserve/union "derivedFrom".
2. MERGE NEVER DROPS A CITATION. The merged item's sources is the UNION of all inputs' sources.
   Never invent items not present in any input; never drop a uniquely-cited item.
3. KEEP ids STABLE. If two items clearly mean the same thing under DIFFERENT ids, keep ONE id
   (the more canonical / earlier slug) and record the remap in a top-level "_aliases" map
   { "<droppedId>": "<keptId>" }. The backend rewrites cross-references using this map.
4. Do NOT alter cross-reference ids inside items except via the "_aliases" remap.
5. reviewState stays "pending"; do not invent new enum values.

OUTPUT CONTRACT — one JSON object:
{ "${key}": [ ...merged items, same shape as the stage contract... ],
  "_aliases": { "objectType:client": "objectType:customer" } }
"_aliases" may be {} when nothing was remapped.

SELF-CHECK before returning:
- [ ] No two output items share an id or an obvious canonical name.
- [ ] Every input item is represented (merged or kept); no citation lost.
- [ ] Any id collapse is recorded in "_aliases".`;

  const user = `STAGE: ${stage}

${fence('PARTIAL CHUNK OUTPUTS (array of per-chunk "' + key + '" arrays)', asJson(chunkOutputs))}

Merge into one de-duplicated "${key}" list. Return ONLY the JSON object.`;

  return { system, user };
}

// ===========================================================================
// 7. GENERATION — agent code (LLM-assisted)
// ===========================================================================

export function buildAgentCodePrompt(ontology: unknown): PromptPair {
  const system = `You are a senior TypeScript engineer generating an AGENT TOOLKIT from a
PUBLISHED ontology (the canonical JSON below). Output ONLY a single JSON object listing files.

WHAT TO GENERATE
1. One TS interface per ObjectType (in "types.ts"): attributes -> fields. Map DataType -> TS:
   string/uuid -> string; integer -> number; decimal/money -> number; boolean -> boolean;
   date/datetime -> string (ISO); enum -> a string-literal union of enumValues; reference/fk ->
   the referenced interface type; json -> unknown; array -> T[].
2. Event payload types (in "events.ts") as a discriminated union keyed by the event "name",
   derived from each EventType.payload.
3. One exported async function per ActionType (in "tools.ts"): function name = action.agent.toolName.
   Parameters typed from action.inputs (objects -> the generated interface; scalars -> mapped TS
   type), return type from action.outputs. At the TOP of each body, emit precondition checks as
   "assertRule_<ruleSlug>(...)" calls — one per preconditions[].ruleId — each preceded by a
   comment with the rule's statement.en and a "// FORMAL: <rule.formal>" line. Leave the body as
   a "// TODO: implement" block listing the action's sideEffects. Add a JSDoc citing the first
   source (documentName + page/section if present).
4. One orchestrator per Process (in "processes.ts"): "export async function run<ProcessName>(...)"
   that calls the step actions in WorkflowStep "order", following "next" edges; where a step has a
   guardRuleId or the action has preconditions, wrap the call in the matching assert.
5. A "rules.ts" with one "assertRule_<ruleSlug>" stub per Rule (throws on block severity; warns
   otherwise), each documented with statement.{en,zh} and formal.

RULES: valid TypeScript only; deterministic naming from ids/toolNames; no external imports beyond
relative ones between the generated files; properly escape newlines/quotes inside "content".

OUTPUT CONTRACT — one JSON object (matches GeneratedBundle.files):
{
  "target": "agent-code",
  "files": [
    { "path": "src/agents/types.ts", "language": "typescript", "content": "..." },
    { "path": "src/agents/events.ts", "language": "typescript", "content": "..." },
    { "path": "src/agents/rules.ts", "language": "typescript", "content": "..." },
    { "path": "src/agents/tools.ts", "language": "typescript", "content": "..." },
    { "path": "src/agents/processes.ts", "language": "typescript", "content": "..." }
  ],
  "warnings": []
}
Return ONLY the JSON object.`;

  const user = `${fence('ONTOLOGY (published, canonical JSON)', asJson(ontology))}

Generate the agent toolkit per the OUTPUT CONTRACT. Return ONLY the JSON object.`;

  return { system, user };
}

// ===========================================================================
// 8. GENERATION — per-role agent system prompts (LLM-assisted)
// ===========================================================================

export function buildPromptsPrompt(ontology: unknown): PromptPair {
  const system = `You are a prompt engineer turning a PUBLISHED ontology into AGENT SYSTEM
PROMPTS — one per distinct actor role (action.actor.role) that has kind "agent" or "system"
across the Actions and Processes. Output ONLY a single JSON object.

FOR EACH ROLE, write a production system prompt that:
1. States the role's mission in business terms.
2. Lists the TOOLS it may call — the agent.toolName of every Action whose actor.role matches —
   each with its agent.toolDescription and its input/output objects.
3. Encodes the RULES that constrain the role as hard guardrails: every Rule whose
   appliesToObjectTypeIds intersect the role's action inputs/outputs. Quote each rule's
   statement.en and cite its source (documentName + page/section). severity "block" rules become
   MUST-NOT guardrails; "warn" become cautions.
4. Describes the EVENTS the role reacts to (events consumed by its actions) and emits.
Write the full prompt in English, plus a short Chinese summary ("zhSummary").

OUTPUT CONTRACT — one JSON object:
{
  "target": "prompts",
  "files": [
    { "path": "src/agents/prompts/fulfillment.md", "language": "markdown",
      "content": "<full EN system prompt with tools, guardrails, events>" }
  ],
  "prompts": [
    { "role": "Fulfillment", "toolNames": ["fulfill_order"],
      "systemPrompt": "<full EN prompt>", "zhSummary": "<中文要点>" }
  ],
  "warnings": []
}
Return ONLY the JSON object.`;

  const user = `${fence('ONTOLOGY (published, canonical JSON)', asJson(ontology))}

Generate one system prompt per agent/system actor role per the OUTPUT CONTRACT.
Return ONLY the JSON object.`;

  return { system, user };
}

// ===========================================================================
// 9. GENERATION — workflow manifest (DETERMINISTIC; recommended)
// ===========================================================================

/**
 * RECOMMENDATION (per design notes [CC-5] / SCHEMA §8): the WorkflowManifest is
 * derived DETERMINISTICALLY from the ontology by the backend — it is a pure
 * projection (tools from Actions, events from EventTypes, agents from roles,
 * nodes from Process.steps), pinning `ontologyVersion`. An LLM is neither needed
 * nor desirable here: determinism guarantees the manifest never disagrees with
 * the ontology and re-runs are idempotent.
 *
 * `buildManifestPrompt` is provided ONLY as an optional fallback / sanity layer.
 * Prefer `buildManifestDeterministic(ontology)` in the handler.
 *
 * This function is pure data transformation, no LLM, no imports. The `ontology`
 * is typed loosely (unknown) because this module takes ZERO project imports; the
 * caller passes the canonical `Ontology`. Returns a `WorkflowManifest`-shaped
 * object per manifest (one per Process), as `unknown` to avoid a type import.
 */
export function buildManifestDeterministic(ontology: unknown): unknown[] {
  const o = (ontology ?? {}) as Record<string, unknown>;
  const ontologyId = String(o.id ?? '');
  const ontologyVersion = Number(o.version ?? 0);
  const actions = (o.actions as Record<string, unknown>[]) ?? [];
  const events = (o.events as Record<string, unknown>[]) ?? [];
  const processes = (o.processes as Record<string, unknown>[]) ?? [];

  // toolName + binding per action id, for node + tool catalog assembly.
  const actionById = new Map<string, Record<string, unknown>>();
  for (const a of actions) actionById.set(String(a.id), a);

  const eventNameById = new Map<string, string>();
  for (const e of events) eventNameById.set(String(e.id), String(e.name ?? e.id));

  // Tool catalog: one entry per action's agent binding.
  const tools = actions.map((a) => {
    const agent = (a.agent as Record<string, unknown>) ?? {};
    return {
      toolName: String(agent.toolName ?? ''),
      parameterSchema: agent.parameterSchema ?? { type: 'object', properties: {} },
      execution: String(agent.execution ?? 'function'),
      integration: agent.integration,
    };
  });

  // Agents: one per distinct actor role, with composed (placeholder) prompt + owned tools.
  const roleTools = new Map<string, Set<string>>();
  for (const a of actions) {
    const actor = (a.actor as Record<string, unknown>) ?? {};
    const role = String(actor.role ?? 'System');
    const agent = (a.agent as Record<string, unknown>) ?? {};
    const tool = String(agent.toolName ?? '');
    if (!roleTools.has(role)) roleTools.set(role, new Set());
    if (tool) roleTools.get(role)!.add(tool);
  }
  const agents = Array.from(roleTools.entries()).map(([role, toolSet]) => ({
    role,
    prompt: `You are the ${role} agent. Use only your assigned tools and honor every precondition rule.`,
    tools: Array.from(toolSet),
  }));

  // One manifest per process.
  return processes.map((p) => {
    const steps = (p.steps as Record<string, unknown>[]) ?? [];
    const nodes = steps.map((s) => {
      const action = actionById.get(String(s.actionTypeId)) ?? {};
      const agent = (action.agent as Record<string, unknown>) ?? {};
      const actor = (action.actor as Record<string, unknown>) ?? {};
      const preconditions = ((action.preconditions as Record<string, unknown>[]) ?? []).map(
        (pc) => ({ ruleId: String(pc.ruleId), severity: pc.severity ?? 'block' }),
      );
      const emits = ((action.emitsEvents as Record<string, unknown>[]) ?? []).map((em) => ({
        eventTypeId: String(em.eventTypeId),
        on: String(em.on ?? 'success'),
      }));
      const next = ((s.next as Record<string, unknown>[]) ?? []).map((e) => ({
        toStepId: String(e.toStepId),
        condition: e.condition,
        onEventTypeId: e.onEventTypeId,
      }));
      return {
        id: String(s.id),
        actionToolName: String(agent.toolName ?? ''),
        actorRole: s.actorRole ?? actor.role,
        preconditions,
        emits,
        next,
      };
    });
    return {
      manifestVersion: 1,
      ontologyId,
      ontologyVersion,
      processId: String(p.id),
      name: p.name ?? { en: '', zh: '' },
      trigger: p.triggers ?? [],
      nodes,
      tools,
      agents,
    };
  });
}

/**
 * OPTIONAL LLM fallback for the manifest (NOT recommended — prefer
 * `buildManifestDeterministic`). Kept so the generation surface is uniform and a
 * handler can A/B the deterministic projection against an LLM rendering.
 */
export function buildManifestPrompt(ontology: unknown): PromptPair {
  const system = `You convert a PUBLISHED ontology into a DEPLOYABLE WORKFLOW MANIFEST (one per
Process) for an agentic operator runtime. NOTE: this is normally built DETERMINISTICALLY by the
backend; produce JSON that exactly mirrors that projection. Output ONLY a single JSON object.

The manifest matches the WorkflowManifest type:
{
  "manifests": [
    {
      "manifestVersion": 1,
      "ontologyId": "<ontology.id>",
      "ontologyVersion": <ontology.version>,
      "processId": "<process.id>",
      "name": { "en": "...", "zh": "..." },
      "trigger": [ <copied from process.triggers> ],
      "nodes": [
        { "id": "<WorkflowStep.id>", "actionToolName": "<action.agent.toolName>",
          "actorRole": "<step.actorRole|action.actor.role>",
          "preconditions": [{ "ruleId": "...", "predicate"?: "<rule.expression.predicate>", "severity": "block" }],
          "emits": [{ "eventTypeId": "...", "on": "success" }],
          "next": [{ "toStepId": "...", "condition"?: "...", "onEventTypeId"?: "..." }] }
      ],
      "tools": [ { "toolName": "...", "parameterSchema": {...}, "execution": "function", "integration"?: "..." } ],
      "agents": [ { "role": "...", "prompt": "...", "tools": ["..."] } ]
    }
  ]
}

RULES
1. tools[] has one entry per ActionType (its agent binding). nodes derive from Process.steps.
2. node.preconditions / node.emits copy the action's preconditions / emitsEvents.
3. agents[] = one per distinct actor.role, owning the toolNames of its actions.
4. Pin "ontologyVersion" from ontology.version. Never invent steps/tools not in the ontology.
Return ONLY the JSON object.`;

  const user = `${fence('ONTOLOGY (published, canonical JSON)', asJson(ontology))}

Generate one WorkflowManifest per Process per the contract. Return ONLY the JSON object.`;

  return { system, user };
}
