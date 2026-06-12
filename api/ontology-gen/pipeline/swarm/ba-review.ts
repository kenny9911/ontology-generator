// ============================================================================
//  DEEP-SWARM — Business-Analyst review.
//
//  Reviews the extracted ontology against EVERY use case + the expected-item
//  checklist and returns concrete coverage GAPS (missing/underspecified items).
//  Coverage numbers are computed deterministically elsewhere (coverage.ts).
// ============================================================================

import { buildBaReviewPrompt } from '../../prompts.js';
import type { Ontology, BusinessBrief, CoverageGap, Severity } from '../../../_shared/ontology-schema.js';
import { callJson } from './llm-json.js';
import { asArray, asRecord, bil, str, localId } from './util.js';

const LAYER = new Set<string>(['object', 'rule', 'action', 'event', 'process', 'relationship', 'general']);
const SEV = new Set<string>(['info', 'warn', 'block']);

/** A compact ids + names + key-fields projection of the ontology for review. */
function digest(o: Ontology): unknown {
  return {
    objects: o.objects.map((n) => ({ id: n.id, name: n.name, attributes: n.attributes?.map((a) => a.name) })),
    relationships: o.relationships.map((n) => ({ id: n.id, name: n.name, from: n.sourceObjectTypeId, to: n.targetObjectTypeId })),
    rules: o.rules.map((n) => ({ id: n.id, title: n.title, statement: n.statement?.en, severity: n.severity })),
    actions: o.actions.map((n) => ({ id: n.id, name: n.name, inputs: n.inputs?.map((i) => i.name), emits: n.emitsEvents?.map((e) => e.eventTypeId) })),
    events: o.events.map((n) => ({ id: n.id, name: n.name })),
    processes: o.processes.map((n) => ({ id: n.id, name: n.name?.en, steps: n.steps?.length })),
  };
}

export interface BaOptions {
  iteration: number;
  brief: BusinessBrief;
  ontology: Ontology;
  model: string;
  provider: string;
  userInfo: unknown | null;
  taken: Set<string>;
  log: (t: string) => void;
}

export async function runBaReview(opts: BaOptions): Promise<CoverageGap[]> {
  const { system, user } = buildBaReviewPrompt({
    iteration: opts.iteration,
    useCases: opts.brief.useCases,
    expectedEntities: opts.brief.expectedEntities,
    ontologyDigest: digest(opts.ontology),
  });
  const json = await callJson({
    system,
    user,
    model: opts.model,
    provider: opts.provider,
    userInfo: opts.userInfo,
    actionName: `ontology_ba_review_${opts.iteration}`,
    maxTokens: 12000,
    temperature: 0.2,
  });
  const gaps = parseGaps(json, opts.taken);
  opts.log(`[swarm] BA review (iteration ${opts.iteration}): ${gaps.length} gap(s) found`);
  return gaps;
}

function parseGaps(json: unknown, taken: Set<string>): CoverageGap[] {
  const out: CoverageGap[] = [];
  for (const raw of asArray(asRecord(json).gaps)) {
    const r = asRecord(raw);
    const description = bil(r.description);
    if (!description.en && !description.zh) continue;
    const layer = (LAYER.has(str(r.layer)) ? str(r.layer) : 'general') as CoverageGap['layer'];
    const severity = (SEV.has(str(r.severity)) ? str(r.severity) : 'warn') as Severity;
    out.push({
      id: localId('gap', str(r.id) || description.en, taken),
      layer,
      description,
      severity,
      useCaseId: str(r.useCaseId) || undefined,
      relatedItemId: str(r.relatedItemId) || undefined,
    });
  }
  return out;
}
