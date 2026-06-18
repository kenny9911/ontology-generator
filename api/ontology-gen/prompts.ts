/**
 * ============================================================================
 *  ONTOLOGY GENERATOR — PROMPT ASSETS (production)
 * ============================================================================
 *
 *  Self-contained prompt builders for the 5-stage extraction pipeline
 *  (Objects -> Rules -> Actions -> Events -> Processes), the cross-chunk merge
 *  step, and the 3 generation targets (agent code, agent prompts, manifest).
 *
 *  DOCTRINE (docs/HYPER_AUTOMATION_DESIGN.md §4): every prompt is
 *  RECALL-FIRST-WITH-RECEIPTS. The goal is COMPLETE coverage — extract every
 *  item the evidence supports (missing a real item is as serious an error as
 *  inventing one) while strictly banning invention of anything the evidence
 *  does not support. Each extraction prompt therefore carries: a section-sweep
 *  method, a per-stage "commonly missed" negative-space checklist, seed-block
 *  reconciliation (StageContext.briefSeed is appended AFTER the system prompt
 *  by every stage caller), a counting self-check, and anti-truncation output
 *  discipline (terse descriptions, never fewer items). JSON contracts are
 *  FROZEN: every OUTPUT CONTRACT field name, nesting, and enum value below is
 *  byte-identical to what the stage parsers/coercers read — rewrites change
 *  instructions, never the contract.
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
 * Encodes the non-negotiables: JSON-only, recall-first-with-receipts (complete
 * coverage AND zero invention), mandatory verbatim citations, kind-prefixed
 * slug ids, bilingual, honest confidence, closed enums, seed reconciliation,
 * and anti-truncation output discipline.
 */
const SHARED_RULES = `GLOBAL RULES (non-negotiable — they override any instinct to summarize, hedge, or pad):
1. OUTPUT ONLY a single JSON object that matches the OUTPUT CONTRACT below. No prose,
   no markdown, no code fences, no commentary, no trailing text.
2. COMPLETENESS AND FIDELITY: extract every item the text supports — missing a real item
   is as serious an error as inventing one. Never invent what the evidence does not
   support. Sweep the WHOLE document; never stop after the prominent items, and never
   fabricate to look "complete". An item you omit is invisible to every downstream stage.
3. CITATIONS ARE MANDATORY. Every node needs "sources" with >=1 SourceRef whose "snippet"
   is copied VERBATIM from the document (trim to the load-bearing clause, <=40 words;
   never paraphrase inside "snippet"). If you cannot find a supporting snippet, DROP the
   node (unless this stage's guidance explicitly allows "inferred" nodes with
   "derivedFrom" and empty "sources"). Populate "documentName" with the provided
   DOCUMENT NAME. Do NOT emit charStart/charEnd/quoteVerified — the backend computes those.
4. IDS are lowercase, kind-prefixed slugs ([a-z0-9.-]):
     objectType:<slug>  rel:<slug>  rule:<slug>  action:<slug>  process:<slug>
     event:<dotted.name>  (events use a dotted suffix, e.g. event:order.fulfilled)
   When referring to a node from a PRIOR STAGE, reuse its EXACT id, byte for byte. Never
   rename an existing id; never invent ids for collections you were not given.
5. BILINGUAL is required. Provide BOTH English and Simplified Chinese wherever the contract
   asks (nameZh / statement.{en,zh} / name.{en,zh} / text.{en,zh}). zh must be a faithful
   business translation — never pinyin, never left blank, never the English text repeated.
6. CONFIDENCE is your honest 0..1 estimate of how DIRECTLY the document supports the node.
   Multi-sentence inferences score lower than directly-stated facts. Be calibrated — and
   remember: a real item with honest low confidence is far more valuable than an omitted
   item. Emit it and score it honestly; never silently drop a supported item to keep
   confidence numbers high.
7. CONTROLLED VOCABULARIES ONLY. Never invent enum members.
     DataType: ${DATA_TYPES}
     Severity: info | warn | block
     provenance: "extracted" (default for things you mine from text)
     reviewState: "pending" (always, for newly extracted nodes)
8. SEED RECONCILIATION. If an EXPECTED ITEMS / TERMINOLOGY seed block is present (e.g. a
   "DOMAIN BRIEF" with "EXPECTED ITEMS TO LOOK FOR" appended after these instructions),
   reconcile against it — every seeded expectation must either map to an output item or be
   consciously skipped because the documents do not support it. The seed raises RECALL
   only: it tells you where to look, it is NEVER itself evidence, and it NEVER substitutes
   for a verbatim citation.
9. OUTPUT BUDGET DISCIPLINE. The token budget is finite and item COUNT is what matters.
   Keep every description <= 2 short sentences and every snippet <= 40 words. NEVER pad,
   NEVER repeat the input, NEVER restate one item inside another. If you approach the
   output limit, prefer emitting MORE items with terser descriptions over fewer verbose
   ones — completeness is never traded away for prose.
10. SELF-CHECK before returning (see SELF-CHECK block). Silently fix violations; do not
    narrate the fixes in the output.`;

/**
 * Section-sweep method — inlined into every extraction system prompt between
 * the GLOBAL RULES and the stage guidance. This is the recall engine.
 */
const SWEEP_METHOD = `SWEEP DISCIPLINE (run silently, in order — this is how you reach full coverage):
1. SEGMENT the evidence into its natural sections (headings, numbered clauses, paragraphs,
   tables, bullet lists). Note how many sections there are.
2. ENUMERATE candidates section by section, paragraph by paragraph. List EVERY candidate
   for this stage BEFORE filtering anything. Enumerating a weak candidate costs nothing;
   silently skipping a real one loses it forever.
3. FILTER: keep every candidate a verbatim quote supports; discard only true non-items
   (pure narration, headings, exact duplicates of an already-kept item).
4. RECONCILE against the seed block, if one is appended (GLOBAL RULE 8): walk the seeded
   expectations one by one — map each to an output item or consciously skip it.
5. COMPLETENESS PASS: re-scan each section one final time. A section that contributed
   ZERO items must be consciously justified (silently). Sections describing data,
   obligations, procedures, parties, or lifecycles almost always contribute something.`;

/** Self-critique checklist appended to every extraction system prompt. */
const SELF_CHECK = `SELF-CHECK (run this silently, then emit only the corrected JSON):
- [ ] COUNT: how many sections did the evidence have, and how many items did each section
      yield? Any zero-item section needs a conscious justification — if you cannot justify
      it, go back and extract what that section supports before returning.
- [ ] Output is ONE JSON object with the exact top-level key, nothing else.
- [ ] Every extracted node has >=1 source whose "snippet" is a verbatim substring of the
      evidence. If any snippet is paraphrased or not found, fix it to a real quote or DROP
      the node. (Nodes this stage explicitly allows as "inferred" instead carry
      "derivedFrom" + empty "sources".)
- [ ] Every id is a correctly kind-prefixed slug; every cross-ref id exists in the prior
      stage or in this output. Remove or repair dangling references.
- [ ] No invented enum values; every DataType/severity/provenance is from the vocabulary.
- [ ] Bilingual fields are filled in BOTH languages with faithful business translations.
- [ ] No duplicate nodes (same meaning => one node, union of sources, max confidence).
- [ ] confidence reflects evidence strength (lower for indirect/multi-sentence inference).
- [ ] Every seed-block expectation (if a seed is present) is mapped to an output item or
      consciously skipped for lack of document support.
- [ ] Descriptions <= 2 short sentences; snippets <= 40 words; zero padding anywhere.`;

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
  const system = `You are a PRINCIPAL ENTERPRISE DATA ARCHITECT with two decades of experience
turning policy and operations documents into production data models, performing ONTOLOGY
EXTRACTION, Stage 1 of 5: OBJECT TYPES (business entities). The stakes are concrete:
downstream autonomous agents EXECUTE against this ontology — an entity you miss does not
exist for them. No rule can constrain it, no action can read or write it, no event can
report on it, no process can route it. Every downstream stage references the objects you
define here. Your mandate is COMPLETE coverage of the evidence with verbatim receipts.

${SHARED_RULES}

${SWEEP_METHOD}

WHAT TO EXTRACT
- Every business ENTITY the document treats as a thing with identity and attributes
  (Customer, Order, Invoice, Claim, LoanFacility, Patient, Shipment, Part, Policy).
  If the business names it, stores it, numbers it, assigns it a status, or routes it
  between people, it is an object candidate — enumerate it.
- DO NOT create objects for: verbs/operations (those are Actions, Stage 3), events
  (Stage 4), one-off values, report names, UI labels, or section headings.
- For each object emit: a PascalCase singular "name" (+ Chinese "nameZh"), a one-sentence
  "description" (+ "descriptionZh"), a "type", a "relationship_description", a "primary_key",
  its "properties", and its RELATIONSHIPS to other objects in THIS output.
- "type" is "data" (a business entity) or "system" (an application / external system the
  document references — a CRM, ERP, RMS, partner portal, or service the business integrates with).
- "relationship_description" is prose stating how this object relates to the OTHER objects
  (who owns it, what it references, what references it) — the human-readable summary of the
  edges you emit in "relationships", and the key input for building inter-object relationships.
- "primary_key" is the property name that uniquely identifies the object (default "<object>_id").

COMMONLY MISSED — sweep for ALL of these explicitly (extractors systematically under-report them):
- LOOKUP / REFERENCE / MASTER DATA: tiers, categories, regions, rate tables, code lists,
  product catalogs — model them when the document gives them identity or a value set.
- PARTIES AND ORGANIZATIONS: vendors, carriers, departments, regulators, brokers,
  beneficiaries, third-party service providers — any party with a role in the domain.
- DOCUMENTS-AS-ENTITIES: invoices, applications, certificates, contracts, claim forms,
  purchase orders — if the business stores, numbers, versions, or routes a document, it
  is an object with attributes, not just paperwork.
- LINE ITEMS / JUNCTION ENTITIES: OrderLine, PolicyCoverage, ShipmentItem — anything that
  links two objects and carries its own data (quantity, price, dates).
- CONFIGURATION / POLICY ENTITIES: fee schedules, approval matrices, plan definitions,
  threshold tables — when the document treats configuration as managed data.
- STATUSES WORTH MODELING: a lifecycle spelled out in prose ("draft, submitted, approved,
  rejected") becomes a "List<String>" property whose description lists those EXACT values.
- EVERY PROPERTY MENTIONED ANYWHERE in the text — including ones mentioned only once,
  in passing, or inside a rule or procedure description. Recognize the type:
  money amounts / percentages / ratios => "Float"; whole counts and durations => "Integer";
  calendar dates => "Date"; timestamps => "Timestamp"; yes/no facts ("whether the customer has
  consented") => "Boolean"; enumerated value sets or any multi-value field => "List<String>";
  identifiers, codes, names, and free text => "String".

COMMON-SENSE SUPPLEMENTATION (beyond the document — REQUIRED)
- After sweeping the document, ALSO add the objects and properties a domain EXPERT knows
  this kind of business always has even when the document is silent — standard master /
  reference data, the common parties, and the obvious id / status / created_at / owner fields.
  This fills the gaps in thin or partial documents so downstream agents are not blind.
- Mark every such common-sense item provenance:"inferred" and give it NO "sources" (it is
  not in the document — never fabricate a citation for it).
- If a "WEB-SEARCH SUPPLEMENT" block appears AFTER these instructions, you MAY also add
  objects/properties it evidences that fit THIS document's industry; mark THOSE
  provenance:"web_search" with NO "sources". Ignore anything off-industry.

PROVENANCE (REQUIRED on every object AND every property)
- "extracted" — stated in the DOCUMENT; MUST carry >=1 "sources" entry with a verbatim
  "snippet" (ungrounded "extracted" items are DROPPED).
- "inferred" — your common-sense supplement, NOT in the document; NO "sources".
- "web_search" — from the WEB-SEARCH SUPPLEMENT block, NOT in the document; NO "sources".
- A property has its OWN provenance: an "extracted" object may carry "inferred" properties,
  and an "inferred" object may still carry a property the document mentions in passing.

PROPERTY RULES (the "properties" array)
- Each property MUST have "name" (snake_case), "type", "description", and "provenance".
- "type" is ONE of: String | Integer | Float | Boolean | Date | Timestamp | List<String>.
- A property that points at ANOTHER object is a foreign key: set "is_foreign_key": true and
  "references" to the target object's id (e.g. "objectType:customer").
- Name the primary key once at the object level via "primary_key" — do not tag properties.

RELATIONSHIP RULES (emitted as a TOP-LEVEL "relationships" array)
- Each relationship is a first-class edge: a verb "name" (snake_case, e.g. "places",
  "contains", "ships"), "sourceObjectTypeId", "targetObjectTypeId", and "cardinality"
  (one_to_one | one_to_many | many_to_one | many_to_many). Use "viaAttribute" when the
  edge is realized by an fk attribute. Only relate objects you ALSO emit here.
- Sweep for relationships the same way you sweep for objects: every "has", "belongs to",
  "is assigned", "issues", "covers", "submitted by" in the text is an edge candidate.

OUTPUT CONTRACT — return EXACTLY this shape (one JSON object):
{
  "objects": [
    {
      "id": "objectType:customer",
      "name": "Customer",
      "nameZh": "客户",
      "description": "A party that places orders.",
      "descriptionZh": "下订单的一方。",
      "type": "data",
      "relationship_description": "A Customer places one or more Orders and holds exactly one CreditProfile.",
      "primary_key": "customer_id",
      "properties": [
        { "name": "customer_id", "nameZh": "客户编号", "type": "String", "description": "Unique identity of the customer.", "provenance": "extracted" },
        { "name": "tier", "type": "List<String>", "description": "Customer tier — one of Standard, Premium, Enterprise.", "provenance": "extracted" },
        { "name": "created_at", "type": "Timestamp", "description": "When the customer record was created (standard audit field).", "provenance": "inferred" },
        { "name": "account_id", "nameZh": "账户编号", "type": "String", "is_foreign_key": true,
          "references": "objectType:account", "description": "The CRM account this customer maps to.", "provenance": "extracted" }
      ],
      "sources": [
        { "documentId": "", "documentName": "${docName}", "section": "§3.2",
          "snippet": "Each customer is assigned a tier of Standard, Premium, or Enterprise." }
      ],
      "confidence": 0.95, "provenance": "extracted", "reviewState": "pending"
    },
    {
      "id": "objectType:audit_log",
      "name": "AuditLog", "nameZh": "审计日志",
      "description": "Standard record of who changed what and when.",
      "descriptionZh": "记录谁在何时变更了什么的标准审计记录。",
      "type": "data", "relationship_description": "An AuditLog references the user who made a change.",
      "primary_key": "audit_log_id",
      "properties": [
        { "name": "audit_log_id", "type": "String", "description": "Identifier.", "provenance": "inferred" },
        { "name": "changed_at", "type": "Timestamp", "description": "When the change happened.", "provenance": "inferred" }
      ],
      "sources": [],
      "confidence": 0.6, "provenance": "inferred", "reviewState": "pending"
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

${SELF_CHECK}
- [ ] Every property mentioned anywhere in the text appears on some object with a correct
      type (Float/Date/Timestamp/Boolean/List<String> recognized from prose, not defaulted).
- [ ] Every status lifecycle spelled out in prose is a "List<String>" property listing the values.
- [ ] Every object has "type", "primary_key", and "relationship_description" filled in.
- [ ] Every foreign-key property sets "is_foreign_key" + "references" to a real object id.
- [ ] Every party, document-as-entity, lookup table, and line item in the text was either
      emitted or consciously rejected as a non-entity.
- [ ] Every object AND every property carries "provenance"; "extracted" items have a verbatim
      citation while "inferred"/"web_search" items carry NO "sources".
- [ ] You ADDED the common-sense objects/properties a domain expert expects but the document
      omitted, each tagged "inferred".`;

  const user = `DOCUMENT NAME: ${docName}

${fence('DOCUMENT (extract objects + relationships from THIS text only)', chunkText)}

Extract ALL Object Types and the Relationships among them per the OUTPUT CONTRACT —
sweep every section. Completeness is mandatory; verbatim citations are mandatory for
"extracted" items, while common-sense ("inferred") and web-search ("web_search") additions
carry NO citation. Then ADD the common-sense objects/properties this industry always has
but the document omitted.
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
  const system = `You are a SENIOR BUSINESS-RULES ANALYST who has codified compliance and policy
manuals for regulated enterprises, performing ONTOLOGY EXTRACTION, Stage 2 of 5: RULES. The
stakes: downstream agents enforce ONLY the rules you mine here — a constraint you miss is a
constraint no agent will ever check, which in production means an unguarded action. Mine
rules SENTENCE BY SENTENCE over the NUMBERED SENTENCES, then GROUP adjacent sentences that
express ONE rule. Citations are at the SENTENCE level.

${SHARED_RULES}

${SWEEP_METHOD}

METHOD (follow exactly — the numbered sentences ARE your sections)
1. Read EVERY numbered sentence, in order, without skipping. For each one, consciously
   decide: does it state or imply an obligation, prohibition, threshold, formula, time
   limit, permission, or state constraint? Scan for normative / conditional language:
   "must", "may not", "shall", "unless", "only if", "within N days", "requires",
   "is prohibited", "no later than", "at least", "no more than", "is calculated as",
   thresholds, and state transitions. Skip ONLY pure narrative, definitions, and headings —
   and skip them consciously, not by default.
2. For each obligation/constraint emit ONE rule. If several ADJACENT sentences express one
   rule, group them: cite ALL their indices in "sources[].sentenceRefs" and put the verbatim
   joined text in "sources[].snippet". One sentence can also yield MULTIPLE rules when it
   packs several constraints — split them.
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
8. EXECUTION SEMANTICS (optional, align with "severity"):
   - "executor": "human" | "agent" — who carries the rule out. Default "agent" unless the
     document clearly assigns it to a person/role.
   - "enforcementLevel": "mandatory" (must hold) | "optional" (advisory).
   - "failurePolicy": "block" (a violation aborts the gated action) | "warn" (surfaced only).
   Keep them consistent with severity: block => mandatory + block; warn/info => optional + warn.
9. BUSINESS CONTEXT (extract from the document when stated; these have NO default source —
   only the document can supply real values, so read carefully and quote-ground them):
   - "applicableClient": the client / customer / business unit this rule applies to, IN CHINESE
     (use "通用" only when the document says it applies to ALL clients).
   - "applicableDepartment": the department / team responsible, IN CHINESE (use "N/A" only when
     the document gives none).
   - "businessBackgroundReason": WHY this rule exists — the business rationale / background,
     IN CHINESE, when the document explains it (else "").

COMMONLY MISSED — hunt for ALL of these explicitly (they hide outside the obvious "must" sentences):
- NUMERIC THRESHOLDS buried in prose: "orders above $10,000", "no more than 3 attempts",
  "a minimum balance of", percentages, caps, floors, and limits stated mid-sentence.
- TEMPORAL / SLA CONSTRAINTS: "within N days", "no later than", "net-30", "every quarter",
  review/renewal cycles, expiry windows => kind "temporal".
- AUTHORIZATION / APPROVAL MATRICES: "only a supervisor may", "requires sign-off by",
  role-gated operations, amount-tiered approval levels => kind "authorization".
- STATE-TRANSITION CONSTRAINTS: "cannot be cancelled once shipped", "must be reviewed
  before approval", allowed/forbidden status moves => kind "state_transition".
- DERIVATION FORMULAS: "the premium is calculated as", totals, proration, fee computation
  => kind "derivation", severity usually "info".
- VALIDATION CONSTRAINTS implied by data types/formats: "must be a valid email",
  "a 10-digit account number", mandatory-field statements => kind "validation".
- CROSS-OBJECT CONSISTENCY: "the invoice total must equal the sum of its line items",
  "the shipment quantity may not exceed the ordered quantity".
- EXCEPTION / ESCAPE CLAUSES: "unless", "except", "waived when", "does not apply to" —
  fold the exception INTO the owning rule's statement/formal, or emit it as its own rule
  when it stands alone. An unmodeled exception makes the base rule WRONG, not just incomplete.

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
      "executor": "agent", "enforcementLevel": "mandatory", "failurePolicy": "block",
      "applicableClient": "通用", "applicableDepartment": "履约部",
      "businessBackgroundReason": "确保收款到账后再发货，避免坏账与履约风险。",
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
- [ ] Every appliesToObjectTypeIds entry exists in the PRIOR OBJECTS.
- [ ] Every numbered sentence containing must/shall/may not/unless/within/threshold/approval
      language is either cited by some rule or was consciously skipped as non-normative.
- [ ] Every exception clause ("unless", "except", "waived when") is modeled, not dropped.`;

  const user = `DOCUMENT NAME: ${docName}

${fence('PRIOR OBJECTS (objects already accepted — reuse these EXACT ids)', asJson(priorObjects))}

NUMBERED SENTENCES (mine rules from these; cite by idx in sentenceRefs):
${asJson(numberedSentences)}

Mine ALL rules sentence-by-sentence — every threshold, time limit, approval gate,
transition constraint, formula, and exception — grouping adjacent sentences that form one
rule. Return ONLY the JSON object.`;

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
  const system = `You are a SENIOR PROCESS & AUTOMATION ARCHITECT who has decomposed hundreds of
SOPs into executable tool catalogs, performing ONTOLOGY EXTRACTION, Stage 3 of 5: ACTION
TYPES. Each Action is something an actor (human, agent, or system) DOES that changes state,
and each becomes a CALLABLE AGENT TOOL. The stakes: downstream agents can ONLY do what you
extract here — an operation you miss is an operation no agent can ever perform, and a whole
branch of the business process silently disappears. Make typed inputs/outputs, steps,
preconditions, and event wiring precise — and make the catalog COMPLETE.

${SHARED_RULES}

${SWEEP_METHOD}

WHAT TO EXTRACT
- Operations the document describes: "release shipment", "approve refund", "set reserve",
  "submit claim", "issue invoice", "extend offer". Treat EVERY verb phrase that changes
  state as an action candidate, then filter against the evidence.
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
  - "typescript_code"? (optional): when the action is a self-contained logic/tool function whose
    implementation is fully determined by the document (e.g. an explicit formula or API call),
    provide a concise TypeScript implementation here; otherwise omit it or use "".
  - "agent": AgentBinding — { "toolName" (snake_case, e.g. "fulfill_order"), "parameterSchema"
    (JSON-Schema object derived from inputs: { "type":"object", "properties":{...}, "required":[...] };
    a property that represents a domain object carries "$objectTypeId"), "toolDescription"
    (one line), "promptHints"? (string[]), "execution": "function"|"llm_tool"|"human_task",
    "integration"? }.

COMMONLY MISSED — sweep for ALL of these explicitly (the verbs that hide):
- IMPLICIT HUMAN STEPS narrated in passive voice: "the application is then reviewed" =>
  ReviewApplication; "documents are verified" => VerifyDocuments. Passive voice still
  names an action — assign the actor the text implies.
- SYSTEM-TRIGGERED JOBS: nightly batches, auto-expiry, recalculations, scheduled syncs —
  actor kind "system", often triggered by time or by an event.
- NOTIFICATION / COMMUNICATION STEPS: emails, reminders, customer notices, internal alerts
  — real actions with sideEffects kind "notification", commonly skipped as "minor".
- COMPENSATING / ROLLBACK ACTIONS: cancel, void, reverse, refund, reinstate, restock —
  if the document mentions undoing something, that undo is an action.
- APPROVAL / REJECTION PAIRS: wherever an approval action exists, check the text for the
  rejection/return-for-rework path — it is almost always an action too.
- EVERY VERB PHRASE THAT CHANGES STATE: walk the verbs deliberately; "records", "updates",
  "assigns", "escalates", "flags", "closes" are all action candidates.
- FAILURE / ESCALATION EMISSIONS: where the text describes failures, timeouts, or
  escalations, wire them as "emitsEvents" entries with "on": "failure" or a dotted
  escalation event id — Stage 4 will define them.

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
- [ ] "agent.toolName" is snake_case and "agent.parameterSchema" mirrors the inputs.
- [ ] Every state-changing verb phrase in the document maps to an action or was consciously
      skipped; passive-voice steps, notifications, rollbacks, and rejection paths included.`;

  const user = `DOCUMENT NAME: ${docName}

${fence('PRIOR OBJECTS (reuse these EXACT ids for objectTypeId refs)', asJson(priorObjects))}

${fence('PRIOR RULES (choose preconditions from these — id + statement)', asJson(priorRules))}

${fence('DOCUMENT (extract actions from THIS text)', chunkText)}

Extract ALL Action Types per the OUTPUT CONTRACT — every explicit operation, implicit
human step, system job, notification, and compensating action the text supports.
Return ONLY the JSON object.`;

  return { system, user };
}

// ===========================================================================
// 4. STAGE 4 — EVENT TYPES (reconcile + wire; inverse of actions)
// ===========================================================================

export function buildEventsPrompt(args: { actions: unknown; docName?: string }): PromptPair {
  const { actions } = args;
  const docName = args.docName ?? 'the document';
  const system = `You are a SENIOR EVENT-MODELING EXPERT (event storming, event-driven
architecture) performing ONTOLOGY EXTRACTION, Stage 4 of 5: EVENT TYPES. Events are business
facts that occur at a point in time and connect Actions (producer -> event -> consumer). The
stakes: downstream agents coordinate ONLY through the events you define — an undefined event
id is a broken wire, and the actions on either side of it can never hand off work. This
stage is PRIMARILY RECONCILIATION of the event ids the Actions already reference, plus any
events the document names. Coverage must be TOTAL over the referenced ids.

${SHARED_RULES}

${SWEEP_METHOD}

WHAT TO EXTRACT — wire from the ACTIONS:
- DEFINE every event id referenced by the ACTIONS: every id in any action's "emitsEvents[].eventTypeId"
  and every id in any action's "triggeredByEventIds". Define each exactly once. Walk the
  action list mechanically and tick every referenced id off — ZERO may be left undefined.
- "id" is a DOTTED slug "event:<domain>.<past_tense>", e.g. "event:order.fulfilled".
  "name" is the dotted suffix matching the id, e.g. "order.fulfilled". Add "nameZh".
- "payload": EventField[] — { "name", "type" (DataType), "objectTypeId"? (when the field carries
  a domain object/ref), "required", "description"? }. Infer payload from the emitting action's
  outputs and the objects involved. A complete payload beats an empty one — carry every
  field the consumers plausibly need, typed from the closed DataType vocabulary.
- INVERSE WIRING (must be the EXACT inverse of the actions):
  - "producedByActionIds": every action whose "emitsEvents" includes THIS event id.
  - "consumedByActionIds": every action whose "triggeredByEventIds" includes THIS event id.
- If an event is referenced by an action but the document gives no detail, still define it with
  an empty payload, "provenance": "inferred", "derivedFrom": [the referencing action id],
  "sources": [], and confidence ≤ 0.6. Otherwise "provenance": "extracted" with a verbatim source.

COMMONLY MISSED — check the referenced ids against this list (and define any the document names):
- LIFECYCLE EVENTS for EVERY object the actions touch: created / updated / closed /
  cancelled — if an action mints or retires an object, its lifecycle events are usually
  referenced or named somewhere; ground them when the text supports it.
- FAILURE / TIMEOUT EVENTS: "event:payment.failed", "event:review.timed-out" — actions
  with "on": "failure" emissions need these defined just as carefully as success events.
- ESCALATION EVENTS: handoffs to supervisors or exception queues named in the text.

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
- [ ] COUNT the distinct event ids referenced by the actions and COUNT your output events —
      the two sets must match exactly; every referenced id is defined exactly once.
- [ ] producedByActionIds / consumedByActionIds are the EXACT inverse of the actions' emits/triggers.
- [ ] Inferred events (no document detail) carry derivedFrom + empty sources + confidence ≤ 0.6.`;

  const user = `DOCUMENT NAME: ${docName}

${fence('ACTIONS (define and wire every event these reference; invert their emits/triggers)', asJson(actions))}

Define and wire ALL Event Types per the OUTPUT CONTRACT — every referenced id, none
skipped, payloads as complete as the evidence supports. Return ONLY the JSON object.`;

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
  const system = `You are a PRINCIPAL BUSINESS-PROCESS ARCHITECT (BPMN, workflow orchestration)
performing ONTOLOGY EXTRACTION, Stage 5 of 5: PROCESSES. A Process chains Action Types
end-to-end into a workflow STEP-GRAPH, linked by the Events they emit/consume and guarded by
Rules. The stakes: this is the source for a deployable workflow manifest — a flow you miss
is a flow no agent can ever run, and an exception path you omit means the happy path fails
with nowhere to go. Ordering and wiring must be correct, and the process catalog COMPLETE.

${SHARED_RULES}

${SWEEP_METHOD}

WHAT TO EXTRACT
- EVERY end-to-end workflow the document and the action/event graph support (e.g. "Order to
  Cash", "FNOL to Settlement") — not just the single most obvious one. Sweep the graph for
  connected chains: distinct entry triggers and distinct terminal outcomes usually mean
  distinct processes.
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

COMMONLY MISSED — sweep for ALL of these explicitly:
- ALTERNATE / EXCEPTION PATHS: rejection branches, failure compensation, return-for-rework
  loops — model them as conditional edges off the happy path (or a separate process when
  they form their own flow). A process with only a happy path is usually incomplete.
- ESCALATION FLOWS: supervisor handoffs, exception queues, timeout escalations — wire the
  escalating edge and set "onFailure": "escalate" where the graph supports it.
- PERIODIC / SCHEDULED PROCESSES: renewals, reconciliations, batch reviews — triggers
  kind "schedule" (cron best-effort), commonly skipped because no event starts them.
- CROSS-FUNCTIONAL HANDOFFS: an actorRole change between consecutive steps is a handoff —
  make sure both roles appear in "actors" and the connecting edge carries the right event.

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
- [ ] actorRole on a step is one of the process "actors".
- [ ] Every connected action chain in the graph belongs to some process; exception,
      escalation, and scheduled flows were modeled or consciously skipped.`;

  const user = `DOCUMENT NAME: ${docName}

${fence('OBJECTS (id + name — for objectTypeIds)', asJson(objects))}

${fence('ACTIONS (chain these by following event emit -> trigger links)', asJson(actions))}

${fence('EVENTS (producer/consumer wiring already computed)', asJson(events))}

Synthesize ALL Processes as step-graphs per the OUTPUT CONTRACT — every end-to-end flow
the graph supports, including exception, escalation, and scheduled flows.
Return ONLY the JSON object.`;

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
  const system = `You are a meticulous ONTOLOGY LIBRARIAN merging multiple PARTIAL extractions of
ONTOLOGY stage "${stage}" — produced from different chunks of the SAME corpus — into ONE
clean, de-duplicated list. The stakes: recall won upstream must SURVIVE the merge — an item
or citation you drop here is gone for good. Merging is lossless consolidation, never
summarization. Output ONLY JSON.

MERGE RULES
1. Items with the SAME id, OR the same canonical name/meaning, are the SAME item. Merge them:
   - union "attributes" / "steps" / "inputs" / "outputs" / "payload" / "next" by their own
     identity (attribute name / step order / IO name / field name / edge toStepId);
   - union and DEDUPLICATE "sources" (a citation is unique by documentName + snippet + sentenceRefs);
   - keep the LONGEST non-empty description and the most complete bilingual fields;
   - take the MAX "confidence";
   - if "provenance" differs, prefer "extracted" over "inferred"; set "merged" only when two
     extracted items combined; preserve/union "derivedFrom".
2. MERGE NEVER DROPS ANYTHING. Every input item must be represented in the output (merged
   into a canonical item or kept as-is); the merged item's sources is the UNION of all
   inputs' sources. Never invent items not present in any input; never drop a
   uniquely-cited item. When in doubt whether two items are the same, KEEP BOTH rather
   than collapse them — a reviewer can merge later; nobody can resurrect a dropped item.
3. KEEP ids STABLE. If two items clearly mean the same thing under DIFFERENT ids, keep ONE id
   (the more canonical / earlier slug) and record the remap in a top-level "_aliases" map
   { "<droppedId>": "<keptId>" }. The backend rewrites cross-references using this map.
4. Do NOT alter cross-reference ids inside items except via the "_aliases" remap.
5. reviewState stays "pending"; do not invent new enum values.
6. OUTPUT BUDGET: never pad or restate; keep descriptions terse so the FULL merged list
   always fits. A complete list with short text beats a short list with long text.

OUTPUT CONTRACT — one JSON object:
{ "${key}": [ ...merged items, same shape as the stage contract... ],
  "_aliases": { "objectType:client": "objectType:customer" } }
"_aliases" may be {} when nothing was remapped.

SELF-CHECK before returning (run silently):
- [ ] COUNT: total input items across all chunks vs. output items + "_aliases" remaps —
      every input item is accounted for; nothing silently vanished.
- [ ] No two output items share an id or an obvious canonical name.
- [ ] Every input item is represented (merged or kept); no citation lost.
- [ ] Any id collapse is recorded in "_aliases".`;

  const user = `STAGE: ${stage}

${fence('PARTIAL CHUNK OUTPUTS (array of per-chunk "' + key + '" arrays)', asJson(chunkOutputs))}

Merge into one de-duplicated "${key}" list — losslessly: every input item represented,
every citation preserved. Return ONLY the JSON object.`;

  return { system, user };
}

// ===========================================================================
// 7. GENERATION — agent code (LLM-assisted)
// ===========================================================================

export function buildAgentCodePrompt(ontology: unknown): PromptPair {
  const system = `You are a senior TypeScript engineer generating an AGENT TOOLKIT from a
PUBLISHED ontology (the canonical JSON below). Coverage is TOTAL: every ObjectType, EventType,
ActionType, Rule, and Process in the ontology must appear in the generated code — a tool you
skip is an operation downstream agents can never perform. Output ONLY a single JSON object
listing files.

WHAT TO GENERATE
1. One TS interface per ObjectType (in "types.ts") — no object skipped: properties -> fields.
   Map property type -> TS:
   String -> string; Integer/Float -> number; Boolean -> boolean; Date/Timestamp -> string (ISO);
   List<String> -> string[]; a foreign-key property (is_foreign_key + references) -> the
   referenced interface type.
2. Event payload types (in "events.ts") as a discriminated union keyed by the event "name",
   derived from each EventType.payload — every event represented.
3. One exported async function per ActionType (in "tools.ts") — every action, none skipped:
   function name = action.agent.toolName.
   Parameters typed from action.inputs (objects -> the generated interface; scalars -> mapped TS
   type), return type from action.outputs. At the TOP of each body, emit precondition checks as
   "assertRule_<ruleSlug>(...)" calls — one per preconditions[].ruleId — each preceded by a
   comment with the rule's statement.en and a "// FORMAL: <rule.formal>" line. Leave the body as
   a "// TODO: implement" block listing the action's sideEffects. Add a JSDoc citing the first
   source (documentName + page/section if present).
4. One orchestrator per Process (in "processes.ts"): "export async function run<ProcessName>(...)"
   that calls the step actions in WorkflowStep "order", following "next" edges; where a step has a
   guardRuleId or the action has preconditions, wrap the call in the matching assert.
5. A "rules.ts" with one "assertRule_<ruleSlug>" stub per Rule — every rule gets a stub
   (throws on block severity; warns otherwise), each documented with statement.{en,zh} and formal.

RULES: valid TypeScript only; deterministic naming from ids/toolNames; no external imports beyond
relative ones between the generated files; properly escape newlines/quotes inside "content".
Keep comments terse — completeness of coverage over verbosity of prose; if output space runs
short, shorten comments, never drop a type/function/stub.

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

Generate the agent toolkit per the OUTPUT CONTRACT — every object, event, action, rule,
and process covered. Return ONLY the JSON object.`;

  return { system, user };
}

// ===========================================================================
// 8. GENERATION — per-role agent system prompts (LLM-assisted)
// ===========================================================================

export function buildPromptsPrompt(ontology: unknown): PromptPair {
  const system = `You are a senior prompt engineer turning a PUBLISHED ontology into AGENT SYSTEM
PROMPTS — one per distinct actor role (action.actor.role) that has kind "agent" or "system"
across the Actions and Processes. Coverage is TOTAL: every qualifying role gets a prompt, and
every tool, guardrail rule, and event that touches the role must appear in it — a guardrail
you omit is a rule the agent will violate. Output ONLY a single JSON object.

FOR EACH ROLE, write a production system prompt that:
1. States the role's mission in business terms.
2. Lists the TOOLS it may call — the agent.toolName of EVERY Action whose actor.role matches —
   each with its agent.toolDescription and its input/output objects. None skipped.
3. Encodes the RULES that constrain the role as hard guardrails: EVERY Rule whose
   appliesToObjectTypeIds intersect the role's action inputs/outputs. Quote each rule's
   statement.en and cite its source (documentName + page/section). severity "block" rules become
   MUST-NOT guardrails; "warn" become cautions.
4. Describes the EVENTS the role reacts to (events consumed by its actions) and emits — all of them.
Write the full prompt in English, plus a short Chinese summary ("zhSummary"). Keep each
prompt tight and operational — every line load-bearing, no filler; if output space runs
short, compress wording, never drop a role, tool, or guardrail.

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

Generate one system prompt per agent/system actor role per the OUTPUT CONTRACT — every
role, every tool, every applicable guardrail. Return ONLY the JSON object.`;

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
backend; produce JSON that exactly mirrors that projection — every process, every step, every
tool, nothing added and nothing dropped. Output ONLY a single JSON object.

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
1. tools[] has one entry per ActionType (its agent binding) — every action. nodes derive from
   Process.steps — every step.
2. node.preconditions / node.emits copy the action's preconditions / emitsEvents in full.
3. agents[] = one per distinct actor.role, owning the toolNames of ALL its actions.
4. Pin "ontologyVersion" from ontology.version. Never invent steps/tools not in the ontology;
   never omit ones that are.
Return ONLY the JSON object.`;

  const user = `${fence('ONTOLOGY (published, canonical JSON)', asJson(ontology))}

Generate one WorkflowManifest per Process per the contract — complete and faithful.
Return ONLY the JSON object.`;

  return { system, user };
}

// ===========================================================================
// 10. DEEP-SWARM — business understanding (SME), BA review, links, questions
// ===========================================================================

/** Lens each SME agent in the business-understanding swarm focuses on. */
export type SmePerspective = 'process' | 'data' | 'rules' | 'systems';

/**
 * One SME agent of the web-augmented business-understanding swarm. Produces a
 * BusinessBrief FRAGMENT (personas/use-cases/expected-items/glossary) for its
 * lens — a RECALL TARGET, never fabricated ontology facts.
 */
export function buildSmePrompt(args: {
  domain: string;
  perspective: SmePerspective;
  corpusText: string;
  web: boolean;
}): PromptPair {
  const { domain, perspective, corpusText, web } = args;
  const lens: Record<SmePerspective, string> = {
    process:
      'end-to-end workflows, the actors/personas involved, hand-offs, escalation/exception paths, and the use cases the business must support',
    data: 'the business entities/objects, their key attributes and data types, lookup/reference data, and the relationships among them',
    rules:
      'the business rules, policies, thresholds, validations, temporal/SLA constraints, approvals/authorization matrices, and compliance obligations',
    systems:
      'the events, notifications, system integrations, lifecycle/state transitions, and deadline/expiry triggers',
  };

  const system = `You are a SENIOR SUBJECT-MATTER EXPERT for the "${domain}" business domain, framing a corpus for ONTOLOGY extraction. Your lens: ${lens[perspective]}.
${web
    ? 'Use LIVE WEB SEARCH to ground your answer in real-world, industry-standard use cases, terminology, and best practices for this domain.'
    : 'Use your deep parametric domain knowledge (no web access is available in this run).'}

GOAL: produce a BUSINESS-UNDERSTANDING BRIEF describing what a COMPLETE ontology for this scenario SHOULD cover — a RECALL TARGET. Enumerate the personas, canonical use cases, expected ontology items, and glossary terms a domain expert would expect, EVEN IF the provided documents are silent on them. These are EXPECTATIONS used later to find coverage gaps; they are NEVER inserted into the ontology as facts and must never be fabricated as if quoted from the documents.

SWEEP DISCIPLINE (recall first): read the corpus section by section and ENUMERATE candidate expectations BEFORE filtering. Then run a completeness pass: re-scan each section; if a section contributed no expectation, justify that to yourself silently.

expectedEntities MUST be EXHAUSTIVE across ALL FIVE layers — objects, rules, actions, events, processes — plus relationships. Do not stop at the obvious headline entities; for EVERY layer, walk this NEGATIVE-SPACE CHECKLIST of commonly-missed items and emit an expectation for each one that applies to this domain:
- objects: lookup/reference data (status codes, categories, tariffs, rate tables), parties (customers, vendors, employees, regulators, agents), documents-as-entities (invoices, contracts, applications, certificates, forms), line items / detail records, master vs transactional data.
- rules: thresholds and limits buried in prose, temporal/SLA constraints (deadlines, grace periods, expiry windows), authorization/approval matrices (who may do what, above what amount), validation/eligibility criteria, penalty and compliance obligations.
- actions: implicit human steps (review, approve, reject, escalate, notify, file, reconcile), maintenance/correction actions, exception-handling actions — not just the happy-path verbs.
- events: lifecycle/state transitions (created, submitted, approved, cancelled, expired), deadline/expiry triggers, external/system integration signals, failure/exception events.
- processes: end-to-end flows AND their exception/reversal/escalation variants (amendment, cancellation, refund, appeal, renewal).
- relationships: ownership/possession, lifecycle links (supersedes, amends, renews), document-to-entity links (invoice bills order; contract governs account), party-to-party links (customer-of, employs, represents, approves-for), hierarchies and category membership.

glossary MUST be RICH and exhaustive: include EVERY domain term, EVERY abbreviation/acronym (with its expansion), EVERY enum/value set spelled out in prose (list its members in the definition), and data-type hints where relevant (e.g. "monetary amount with currency", "duration in business days", "date", "enumeration of: ..."). The glossary is the extraction pipeline's terminology anchor — a missing term here becomes a missed entity later.

OUTPUT ONLY one JSON object (no prose, no code fences):
{
  "summary": { "en": "one-paragraph scenario framing", "zh": "中文" },
  "personas": [ { "id": "persona:slug", "name": {"en":"","zh":""}, "description": {"en":"","zh":""}, "goals": [ {"en":"","zh":""} ] } ],
  "useCases": [ { "id": "uc:slug", "name": {"en":"","zh":""}, "description": {"en":"","zh":""}, "personaIds": ["persona:slug"], "expectedEntityIds": ["exp:slug"] } ],
  "expectedEntities": [ { "id": "exp:slug", "kind": "object"|"rule"|"action"|"event"|"process"|"relationship", "name": {"en":"","zh":""}, "description": {"en":"","zh":""} } ],
  "glossary": [ { "term": {"en":"","zh":""}, "definition": {"en":"","zh":""} } ],
  "references": [ "source label or URL you relied on" ]
}
Focus expectedEntities on YOUR lens (${perspective}) but ALWAYS include cross-lens items the checklist surfaces — a complete brief beats a narrowly-scoped one. Bilingual (en+zh) is REQUIRED on every name/description/term/definition. Slugs are lowercase [a-z0-9.-].

SELF-CHECK before returning (silently): count how many expectedEntities you emitted PER KIND (object/rule/action/event/process/relationship); any kind with zero entries needs a conscious justification — most real domains have several of every kind. Verify every glossary abbreviation has its expansion and every enum term lists its members.`;

  const user = `DOMAIN: ${domain}
PERSPECTIVE: ${perspective}

${fence('CORPUS (frame this scenario; identify what a complete ontology must cover)', corpusText)}

Sweep the corpus section by section, apply the negative-space checklists for ALL layers, and return ONLY the JSON business-understanding brief for your perspective.`;

  return { system, user };
}

/**
 * The Business-Analyst reviewer. Reviews the extracted ontology against every
 * use case + the expected-item checklist and returns concrete coverage GAPS.
 */
export function buildBaReviewPrompt(args: {
  iteration: number;
  useCases: unknown;
  expectedEntities: unknown;
  ontologyDigest: unknown;
}): PromptPair {
  const { iteration, useCases, expectedEntities, ontologyDigest } = args;
  const system = `You are a meticulous BUSINESS ANALYST reviewing an extracted ontology (iteration ${iteration}) against the business brief. Your job is to find EVERY coverage gap — missed gaps silently ship as missing functionality, so be EXHAUSTIVE.

REVIEW PROTOCOL (follow all three sweeps):
1. EXPECTED-ENTITY SWEEP: go through the EXPECTED ENTITIES checklist item by item. For each item, search the ontology digest (by id AND by name, allowing synonyms/translations) for a node of the matching layer that clearly covers it. Every expected entity NOT clearly present in the digest IS a gap — report it. Do not skip items because they "seem minor".
2. USE-CASE WALKTHROUGH: walk EVERY use case STEP BY STEP against the digest. For each step ask: which object holds the data? which action performs it? which rule constrains it? which event signals it? which process orders it? which relationship connects the parties/documents involved? Any step with no supporting node is a gap.
3. STRUCTURAL SWEEP of commonly-missed coverage: relationships (ownership, lifecycle, document-to-entity, party-to-party links), events for state transitions and deadlines, rules for thresholds/SLAs/authorizations, exception/reversal process variants.

EVIDENCE DISCIPLINE: stay strictly evidence-based. NEVER report a gap for an item that IS present in the digest — verify by id and name before reporting. When an item exists but is weak/underspecified (missing attributes, no relationships, vague rule), report it as a gap WITH relatedItemId set to its ontology id. Each gap must name WHAT is missing and WHY it matters to a use case or expectation.

SEVERITY must be HONEST, not diplomatic: "block" = a use case cannot be supported end-to-end without it; "warn" = important coverage hole but the use case limps through; "info" = nice-to-have enrichment. Do not downgrade real blockers to warn.

OUTPUT ONLY one JSON object (no prose, no fences):
{
  "gaps": [
    { "id": "gap:slug",
      "layer": "object"|"rule"|"action"|"event"|"process"|"relationship"|"general",
      "description": { "en": "what is missing and why", "zh": "中文" },
      "severity": "info"|"warn"|"block",
      "useCaseId": "uc:slug (optional)",
      "relatedItemId": "objectType:... (optional)" }
  ]
}

SELF-CHECK before returning (silently): confirm every expected entity was either matched to a digest node or reported as a gap; confirm every use case was walked; confirm no reported gap duplicates a node that exists in the digest.`;

  const user = `${fence('USE CASES (walk EVERY one step-by-step)', asJson(useCases))}

${fence('EXPECTED ENTITIES (recall checklist — every unmatched item is a gap)', asJson(expectedEntities))}

${fence('CURRENT ONTOLOGY (ids + names + key fields per layer)', asJson(ontologyDigest))}

Run all three sweeps (expected entities, use-case walkthroughs, structural) and return ONLY the JSON gaps object.`;

  return { system, user };
}

/**
 * Dedicated cross-document RELATIONSHIP synthesis over the complete ObjectType
 * set — finds edges the per-document objects stage missed.
 */
export function buildLinksPrompt(args: {
  objects: unknown;
  existingRelationships: unknown;
  docName: string;
}): PromptPair {
  const { objects, existingRelationships, docName } = args;
  const system = `You are a data-modeling expert performing a dedicated RELATIONSHIP SYNTHESIS pass over the COMPLETE set of ObjectTypes in an ontology (spanning ALL source documents). Find relationships the per-document extraction missed — especially edges between objects that appeared in DIFFERENT documents.

${SHARED_RULES}

SWEEP DISCIPLINE (be exhaustive): systematically consider PAIRS of objects from the list — for each plausible pair, ask whether the domain implies an edge between them. Enumerate candidate edges BEFORE filtering, then keep the ones that are real. A property with is_foreign_key/references pointing at another object almost always implies an edge — check every such property.

NEGATIVE-SPACE CHECKLIST — edge types extraction most often misses; walk each category against the object set:
- OWNERSHIP / possession: a party owns, holds, or is responsible for an asset/account/record.
- LIFECYCLE: one entity supersedes, amends, renews, replaces, or is a version of another.
- DOCUMENT-TO-ENTITY: a document object (invoice, contract, application, certificate) bills/governs/evidences/authorizes a business entity.
- PARTY-TO-PARTY: customer-of, employs, represents, approves-for, reports-to, contracts-with.
- HIERARCHY / membership: parent-child, category/classification membership, line-item-of.
- DERIVATION / settlement: generated-from, settles, fulfills, reconciles-against.

WHAT TO EMIT — a "relationships" array ONLY (do NOT emit objects):
- Each edge: { "id":"rel:source-verb-target", "name":"verb_snake_case", "nameZh":"中文",
  "sourceObjectTypeId", "targetObjectTypeId" (BOTH must be ids in the provided OBJECTS),
  "cardinality": one_to_one|one_to_many|many_to_one|many_to_many, "viaAttribute"? }.
- Do NOT duplicate an EXISTING relationship (same source+verb+target).
- If a verbatim sentence supports the edge, cite it ("provenance":"extracted" with a real "snippet").
- If the edge is a sound domain INFERENCE without a direct quote, set "provenance":"inferred",
  "derivedFrom": [sourceObjectTypeId, targetObjectTypeId], "sources": [], "confidence" ≤ 0.6.

SELF-CHECK before returning (silently): confirm you walked every checklist category; confirm every object with zero edges (existing + new) was consciously judged a true isolate — isolated objects are rare in real domains.

OUTPUT ONLY one JSON object: { "relationships": [ ... ] }`;

  const user = `DOCUMENT NAME: ${docName}

${fence('OBJECTS (relate ONLY these ids)', asJson(objects))}

${fence('EXISTING RELATIONSHIPS (do not duplicate these)', asJson(existingRelationships))}

Sweep object pairs and the edge-type checklist, then synthesize additional relationships across the full object set. Return ONLY the JSON object.`;

  return { system, user };
}

/**
 * Turns the remaining gaps + ambiguous/low-confidence items into FOLLOW-UP
 * QUESTIONS for the human domain owner (emitted as the swarm run's last step).
 */
export function buildQuestionsPrompt(args: {
  domain: string;
  gaps: unknown;
  lowConfidenceItems: unknown;
  useCases: unknown;
}): PromptPair {
  const { domain, gaps, lowConfidenceItems, useCases } = args;
  const system = `You are a business analyst preparing FOLLOW-UP QUESTIONS for the human domain owner after a two-iteration ontology extraction for the "${domain}" domain. Turn the remaining gaps, ambiguities, and low-confidence items into clear, specific questions that — once answered — would let us complete or correct the ontology.

QUESTION DISCIPLINE:
- COVERAGE: every "block"-severity gap MUST yield at least one question; cover "warn" gaps next; only then "info". Low-confidence/inferred items deserve a confirmation question when the answer would change the ontology.
- SPECIFIC, not generic: name the exact missing/uncertain thing — the threshold value, the unclear actor or approver, the ambiguous cardinality, the undefined enum members, the missing exception path. Never ask vague prompts like "anything else about orders?".
- ACTIONABLE: phrase each question so a domain owner can answer it in one or two concrete sentences, and the answer translates directly into an ontology edit (a new node, a fixed attribute, a corrected relationship, a confirmed/rejected inference).
- TRACEABLE: set "addressesGapId" whenever the question targets a gap, and "relatedItemId" whenever it targets an existing weak/inferred item. A question with neither should be rare and justified by a use case.
- Group by layer; deduplicate (one question may close several related gaps — list the primary gap id). Bilingual (en+zh) on question and rationale.

OUTPUT ONLY one JSON object (no prose, no fences):
{
  "questions": [
    { "id": "q:slug",
      "question": { "en": "", "zh": "" },
      "rationale": { "en": "why we ask", "zh": "中文" },
      "layer": "object"|"rule"|"action"|"event"|"process"|"relationship"|"general",
      "addressesGapId": "gap:slug (optional)",
      "relatedItemId": "id (optional)" }
  ]
}

SELF-CHECK before returning (silently): confirm every block gap has a question; confirm no question is answerable from the documents already provided; confirm each question names its specific target.`;

  const user = `DOMAIN: ${domain}

${fence('UNRESOLVED GAPS', asJson(gaps))}

${fence('LOW-CONFIDENCE / INFERRED ITEMS', asJson(lowConfidenceItems))}

${fence('USE CASES (for context)', asJson(useCases))}

Produce the follow-up questions. Return ONLY the JSON object.`;

  return { system, user };
}
