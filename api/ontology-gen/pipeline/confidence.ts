/**
 * ============================================================================
 *  ONTOLOGY GENERATOR — DETERMINISTIC CONFIDENCE RUBRIC (pipeline stage 4)
 * ============================================================================
 *
 *  PURE module. No LLM calls, no I/O, no side effects. Given a freshly-extracted
 *  node (with grounded `sources[]`) and a small bundle of `ConfidenceSignals`,
 *  this computes the node's FINAL confidence by the LOCKED rubric
 *  (DESIGN_SPEC §5.1 step 4 / TASK_PLAN T9):
 *
 *      final = clamp(base × grounding × agreement × integrity × schemaBonus, 0, 1)
 *
 *  Each multiplier is a [0,1] (with a couple capped >1 *bonuses* for strong
 *  corroboration) factor with a clear meaning:
 *    - base        — a conservative PRIOR. The raw LLM self-rating is used ONLY
 *                    as a *minor* nudge inside a narrow band around a neutral
 *                    prior; it is deliberately NOT trusted as the sole signal.
 *    - grounding   — fraction of citations whose `quoteVerified === true`.
 *    - agreement   — corroboration across DISTINCT witnesses (documents + snippets).
 *    - integrity   — fraction of this node's cross-references that resolve.
 *    - schemaBonus — required-field completeness for the node's kind.
 *
 *  Exports:
 *    - scoreConfidence(node, signals)            -> Confidence
 *    - computeOntologyConfidence(o)              -> Confidence (weighted mean)
 *    - recomputeConfidenceOnMerge(node, others)  -> Confidence (union of witnesses)
 *    - mergeWitnessSources(...sourceLists)       -> SourceRef[] (deduped union)
 *
 *  HARD RULES: relative imports use the '.js' suffix (NodeNext). Schema types
 *  come from the generated backend mirror.
 * ============================================================================
 */

import type {
  Confidence,
  SourceRef,
  Ontology,
  ObjectType,
  Relationship,
  Rule,
  ActionType,
  EventType,
  Process,
  Provenance,
} from '../../_shared/ontology-schema.js';

// ===========================================================================
// 0. Tunable constants (single source for the rubric's magic numbers)
// ===========================================================================

/**
 * Neutral prior for `base`. A node with no signals at all should NOT read as
 * near-certain; it should read as "plausible but unverified".
 */
const BASE_PRIOR = 0.6 as const;

/**
 * How far the (untrusted) raw LLM self-rating may pull `base` away from the
 * neutral prior. Small on purpose: the model's self-assessment is a weak hint,
 * never the deciding factor. base = clamp(PRIOR + WEIGHT*(selfRating - PRIOR)).
 */
const SELF_RATING_WEIGHT = 0.25 as const;

/** `base` is kept inside this band so a single signal can never dominate. */
const BASE_MIN = 0.45 as const;
const BASE_MAX = 0.8 as const;

/**
 * Floor for the grounding factor when a node legitimately carries NO citations
 * (synthesized / inferred nodes keep `sources: []` + `derivedFrom`). Without a
 * floor they would be annihilated to 0 by the product; with it they remain
 * plausible-but-unverified and rely on integrity/schema to earn their score.
 */
const SYNTHESIZED_GROUNDING = 0.7 as const;

/** Grounding when an EXTRACTED node has citations but none verified. */
const UNVERIFIED_GROUNDING_FLOOR = 0.4 as const;

/** Agreement multipliers keyed by the count of distinct corroborating witnesses. */
const AGREEMENT_SINGLE_UNVERIFIED = 0.85 as const; // 1 witness, not verbatim-verified
const AGREEMENT_SINGLE = 1.0 as const; // exactly one solid witness — neutral
const AGREEMENT_TWO = 1.05 as const; // two independent witnesses — mild bonus
const AGREEMENT_MANY = 1.1 as const; // 3+ independent witnesses — stronger bonus
const AGREEMENT_NONE = 0.9 as const; // no witnesses at all (synthesized)

/** Integrity floor so a node with one broken ref isn't zeroed out. */
const INTEGRITY_FLOOR = 0.5 as const;

/** Schema-completeness multipliers. */
const SCHEMA_COMPLETE = 1.0 as const;
const SCHEMA_MIN = 0.7 as const; // fully incomplete required-field set

// ===========================================================================
// 1. Public signal bundle
// ===========================================================================

/**
 * The non-source signals the ORCHESTRATOR supplies. Everything derivable from
 * the node itself (grounding from `sources`, schema completeness from its shape)
 * is computed here; the orchestrator only needs to provide cross-ref resolution
 * results and the optional, untrusted raw self-rating.
 */
export interface ConfidenceSignals {
  /**
   * The model's self-reported confidence for this node, if any. Used ONLY as a
   * weak nudge to `base`; never the sole determinant.
   */
  rawSelfRating?: number;
  /** Total number of cross-references this node makes to other ids. */
  totalRefs?: number;
  /** How many of those references resolve to a real node. */
  resolvedRefs?: number;
  /**
   * Override for the witness count used by the `agreement` factor. When omitted
   * it is derived from the node's distinct (documentId, normalized-snippet)
   * citations. Useful post-merge to pass the union witness count.
   */
  witnessCount?: number;
}

/**
 * The minimal node shape this module reads. Every first-class extracted node
 * (`NodeProvenance`) satisfies it. Kept structural so callers can pass an
 * ObjectType / Rule / ActionType / etc. directly.
 */
export interface ConfidenceNode {
  id?: string;
  sources: SourceRef[];
  provenance: Provenance;
  /** The node's *current* confidence; not trusted, present for completeness. */
  confidence?: Confidence;
  derivedFrom?: string[];
}

// ===========================================================================
// 2. Helpers — clamp + snippet normalization
// ===========================================================================

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Whitespace/case-normalize a snippet for witness-dedup (matches grounding). */
function normalizeSnippet(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Distinct corroborating witnesses behind a node: a witness is a unique
 * (documentId, normalized snippet) pair. Two citations of the same sentence in
 * the same document count once; the same fact in two documents counts twice.
 */
function distinctWitnessCount(sources: SourceRef[]): number {
  if (!sources || sources.length === 0) return 0;
  const seen = new Set<string>();
  for (const s of sources) {
    const doc = (s.documentId ?? '').trim();
    const snip = normalizeSnippet(s.snippet ?? '');
    seen.add(`${doc}::${snip}`);
  }
  return seen.size;
}

// ===========================================================================
// 3. The five rubric factors
// ===========================================================================

/**
 * `base` — conservative prior, gently nudged by the (untrusted) self-rating.
 * Deliberately band-limited so the LLM number can never be the sole signal.
 */
function baseFactor(rawSelfRating: number | undefined): number {
  if (rawSelfRating === undefined || !Number.isFinite(rawSelfRating)) {
    return BASE_PRIOR;
  }
  const r = clamp01(rawSelfRating);
  const nudged = BASE_PRIOR + SELF_RATING_WEIGHT * (r - BASE_PRIOR);
  return Math.min(BASE_MAX, Math.max(BASE_MIN, nudged));
}

/**
 * `grounding` — fraction of citations the deterministic backend check marked
 * `quoteVerified === true`. No citations (synthesized) → a fixed floor; some
 * citations but none verified → a low floor (extraction is suspect).
 */
function groundingFactor(node: ConfidenceNode): number {
  const sources = node.sources ?? [];
  if (sources.length === 0) {
    // Legitimately source-less only for inferred/merged synthesized nodes.
    return SYNTHESIZED_GROUNDING;
  }
  const verified = sources.filter((s) => s.quoteVerified === true).length;
  const ratio = verified / sources.length;
  if (verified === 0) return UNVERIFIED_GROUNDING_FLOOR;
  // Blend the floor up to 1.0 by verified ratio so partial verification helps.
  return UNVERIFIED_GROUNDING_FLOOR + (1 - UNVERIFIED_GROUNDING_FLOOR) * ratio;
}

/**
 * `agreement` — corroboration across DISTINCT witnesses. A single witness is
 * neutral (or slightly penalized if unverified); two or more independent
 * witnesses earn a capped bonus. Synthesized (zero witness) is penalized.
 */
function agreementFactor(node: ConfidenceNode, override?: number): number {
  const count = override ?? distinctWitnessCount(node.sources ?? []);
  if (count <= 0) return AGREEMENT_NONE;
  if (count === 1) {
    const anyVerified = (node.sources ?? []).some((s) => s.quoteVerified === true);
    return anyVerified ? AGREEMENT_SINGLE : AGREEMENT_SINGLE_UNVERIFIED;
  }
  if (count === 2) return AGREEMENT_TWO;
  return AGREEMENT_MANY;
}

/**
 * `integrity` — fraction of this node's cross-references that resolve. A node
 * with no outbound refs is neutral (1.0). Broken refs drag it toward a floor.
 */
function integrityFactor(totalRefs: number | undefined, resolvedRefs: number | undefined): number {
  const total = totalRefs ?? 0;
  if (total <= 0) return 1;
  const resolved = Math.min(Math.max(resolvedRefs ?? 0, 0), total);
  const ratio = resolved / total;
  return INTEGRITY_FLOOR + (1 - INTEGRITY_FLOOR) * ratio;
}

/**
 * `schemaBonus` — required-field completeness in [SCHEMA_MIN, 1]. Computed from
 * the count of satisfied required slots; the orchestrator can pass exact counts
 * via signals in the future, but the structural defaults below cover v1.
 */
function schemaBonusFactor(completenessRatio: number): number {
  const r = clamp01(completenessRatio);
  return SCHEMA_MIN + (SCHEMA_COMPLETE - SCHEMA_MIN) * r;
}

// ===========================================================================
// 4. scoreConfidence — the LOCKED product
// ===========================================================================

/**
 * Compute a node's final confidence.
 *
 * @param node            The node (any `NodeProvenance`-bearing entity), already
 *                        GROUNDED (sources[].quoteVerified set by ground.ts).
 * @param signals         Cross-ref resolution counts + optional untrusted self-rating.
 * @param schemaCompleteness Required-field completeness ratio in [0,1]. Defaults
 *                        to 1 (caller computes it via the kind-specific helpers
 *                        below, e.g. `objectCompleteness`).
 */
export function scoreConfidence(
  node: ConfidenceNode,
  signals: ConfidenceSignals = {},
  schemaCompleteness = 1,
): Confidence {
  const base = baseFactor(signals.rawSelfRating);
  const grounding = groundingFactor(node);
  const agreement = agreementFactor(node, signals.witnessCount);
  const integrity = integrityFactor(signals.totalRefs, signals.resolvedRefs);
  const schemaBonus = schemaBonusFactor(schemaCompleteness);

  const raw = base * grounding * agreement * integrity * schemaBonus;
  return clamp01(raw);
}

// ===========================================================================
// 5. Kind-specific required-field completeness helpers (structural)
// ===========================================================================
//
// Each returns the fraction of the node's REQUIRED slots that are satisfied.
// Bilingual fields count their `zh` half so the bilingual contract is rewarded.

function ratio(satisfied: number, total: number): number {
  if (total <= 0) return 1;
  return satisfied / total;
}

function nonEmpty(s: string | undefined | null): boolean {
  return typeof s === 'string' && s.trim().length > 0;
}

export function objectCompleteness(o: ObjectType): number {
  const checks: boolean[] = [
    nonEmpty(o.name),
    nonEmpty(o.nameZh),
    nonEmpty(o.description),
    nonEmpty(o.primary_key),
    o.type === 'data' || o.type === 'system',
    Array.isArray(o.properties) && o.properties.length > 0,
    // every property has a name + closed-vocab type
    Array.isArray(o.properties) && o.properties.every((p) => nonEmpty(p.name) && nonEmpty(p.type)),
  ];
  return ratio(checks.filter(Boolean).length, checks.length);
}

export function relationshipCompleteness(r: Relationship): number {
  const checks: boolean[] = [
    nonEmpty(r.name),
    nonEmpty(r.sourceObjectTypeId),
    nonEmpty(r.targetObjectTypeId),
    nonEmpty(r.cardinality),
  ];
  return ratio(checks.filter(Boolean).length, checks.length);
}

export function ruleCompleteness(r: Rule): number {
  const checks: boolean[] = [
    nonEmpty(r.statement?.en),
    nonEmpty(r.statement?.zh),
    nonEmpty(r.formal),
    nonEmpty(r.kind),
    nonEmpty(r.severity),
    Array.isArray(r.appliesToObjectTypeIds) && r.appliesToObjectTypeIds.length > 0,
  ];
  return ratio(checks.filter(Boolean).length, checks.length);
}

export function actionCompleteness(a: ActionType): number {
  const checks: boolean[] = [
    nonEmpty(a.name),
    nonEmpty(a.description),
    Array.isArray(a.inputs),
    Array.isArray(a.outputs),
    Array.isArray(a.steps) && a.steps.length > 0,
    !!a.actorRef && nonEmpty(a.actorRef.role) && nonEmpty(a.actorRef.kind),
    !!a.agent && nonEmpty(a.agent.toolName) && !!a.agent.parameterSchema,
  ];
  return ratio(checks.filter(Boolean).length, checks.length);
}

export function eventCompleteness(e: EventType): number {
  const checks: boolean[] = [
    nonEmpty(e.name),
    nonEmpty(e.nameZh),
    Array.isArray(e.payload),
    // an event should be wired to at least one producer or consumer
    (Array.isArray(e.producedByActionIds) && e.producedByActionIds.length > 0) ||
      (Array.isArray(e.consumedByActionIds) && e.consumedByActionIds.length > 0),
  ];
  return ratio(checks.filter(Boolean).length, checks.length);
}

export function processCompleteness(p: Process): number {
  const checks: boolean[] = [
    nonEmpty(p.name?.en),
    nonEmpty(p.name?.zh),
    Array.isArray(p.actors) && p.actors.length > 0,
    Array.isArray(p.steps) && p.steps.length > 0,
    Array.isArray(p.triggers) && p.triggers.length > 0,
    !!p.orchestration && nonEmpty(p.orchestration.strategy),
  ];
  return ratio(checks.filter(Boolean).length, checks.length);
}

// ===========================================================================
// 6. recompute-on-merge — union the witnesses, re-score
// ===========================================================================

/**
 * Dedupe-union of several SourceRef lists. A merge must NEVER drop a citation
 * (invariant SCHEMA.md §8.3): the union is keyed by (documentId, normalized
 * snippet, charStart) so distinct witnesses survive and exact duplicates fold.
 */
export function mergeWitnessSources(...sourceLists: SourceRef[][]): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set<string>();
  for (const list of sourceLists) {
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      if (!s) continue;
      const key = `${(s.documentId ?? '').trim()}::${normalizeSnippet(s.snippet ?? '')}::${
        s.charStart ?? ''
      }`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/**
 * Recompute confidence for a node being formed by MERGING `node` with `others`.
 * The merged node inherits the UNION of all witnesses, so grounding/agreement
 * improve when independent sources corroborate. Cross-ref integrity and schema
 * completeness for the merged shape are supplied by the caller (via `signals`
 * and `schemaCompleteness`) since they depend on the post-merge id remapping.
 *
 * The merged base prior is the conservative MAX of the inputs' self-ratings (a
 * merge of two plausible extractions is at least as plausible as the better
 * one), still band-limited by `baseFactor`.
 */
export function recomputeConfidenceOnMerge(
  node: ConfidenceNode,
  others: ConfidenceNode[],
  signals: ConfidenceSignals = {},
  schemaCompleteness = 1,
): Confidence {
  const all = [node, ...others];
  const unionSources = mergeWitnessSources(...all.map((n) => n.sources ?? []));

  const mergedNode: ConfidenceNode = {
    id: node.id,
    sources: unionSources,
    provenance: 'merged',
    derivedFrom: all.flatMap((n) => (n.id ? [n.id] : [])),
  };

  // Best (highest) prior among inputs, band-limited by baseFactor downstream.
  const bestSelf = Math.max(
    signals.rawSelfRating ?? 0,
    ...all.map((n) => (typeof n.confidence === 'number' ? n.confidence : 0)),
  );

  const witnessCount = signals.witnessCount ?? distinctWitnessCount(unionSources);

  return scoreConfidence(
    mergedNode,
    {
      ...signals,
      rawSelfRating: bestSelf > 0 ? bestSelf : signals.rawSelfRating,
      witnessCount,
    },
    schemaCompleteness,
  );
}

// ===========================================================================
// 7. computeOntologyConfidence — weighted mean of node confidences
// ===========================================================================

/**
 * Aggregate confidence for a whole ontology: a WEIGHTED mean of every node's
 * confidence. Weights reflect how load-bearing a layer is for an *actionable*
 * ontology — actions/processes (the agentic spine) weigh more than relationships.
 * `accepted`/`edited` human-reviewed nodes weigh more (they are trusted facts);
 * `rejected` nodes are excluded entirely. Returns 0 for an empty ontology.
 */
const KIND_WEIGHT = {
  object: 1.0,
  relationship: 0.6,
  rule: 1.0,
  action: 1.4,
  event: 0.9,
  process: 1.3,
} as const;

function reviewWeight(reviewState: string): number {
  switch (reviewState) {
    case 'accepted':
    case 'edited':
    case 'human':
      return 1.25;
    case 'merged':
      return 1.1;
    case 'rejected':
      return 0; // excluded from the aggregate
    default:
      return 1.0; // pending
  }
}

export function computeOntologyConfidence(o: Ontology): Confidence {
  let weightedSum = 0;
  let weightTotal = 0;

  const accumulate = (
    confidence: Confidence | undefined,
    kindWeight: number,
    reviewState: string,
  ): void => {
    const rw = reviewWeight(reviewState);
    if (rw <= 0) return;
    const c = typeof confidence === 'number' && Number.isFinite(confidence) ? clamp01(confidence) : 0;
    const w = kindWeight * rw;
    weightedSum += c * w;
    weightTotal += w;
  };

  for (const n of o.objects ?? []) accumulate(n.confidence, KIND_WEIGHT.object, n.reviewState);
  for (const n of o.relationships ?? [])
    accumulate(n.confidence, KIND_WEIGHT.relationship, n.reviewState);
  for (const n of o.rules ?? []) accumulate(n.confidence, KIND_WEIGHT.rule, n.reviewState);
  for (const n of o.actions ?? []) accumulate(n.confidence, KIND_WEIGHT.action, n.reviewState);
  for (const n of o.events ?? []) accumulate(n.confidence, KIND_WEIGHT.event, n.reviewState);
  for (const n of o.processes ?? []) accumulate(n.confidence, KIND_WEIGHT.process, n.reviewState);

  if (weightTotal <= 0) return 0;
  return clamp01(weightedSum / weightTotal);
}
