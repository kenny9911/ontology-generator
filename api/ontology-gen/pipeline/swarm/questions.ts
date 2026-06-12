// ============================================================================
//  DEEP-SWARM — follow-up question generation (the run's final step).
//
//  Turns the remaining gaps + low-confidence/inferred items into clear,
//  domain-owner-answerable questions, each tied to the gap/item it addresses.
//  Read-only output (not interactive in v1). Falls back to one question per
//  block-severity gap if the model returns nothing.
// ============================================================================

import { buildQuestionsPrompt } from '../../prompts.js';
import type { Ontology, BusinessBrief, CoverageGap, FollowUpQuestion, EntityKind } from '../../../_shared/ontology-schema.js';
import { callJson } from './llm-json.js';
import { asArray, asRecord, bil, bilOpt, str, localId } from './util.js';

const LAYER = new Set<string>(['object', 'rule', 'action', 'event', 'process', 'relationship', 'general']);

/** The weakest nodes (inferred or confidence < 0.6) — prime question candidates. */
function lowConfidenceItems(o: Ontology, cap = 40): unknown[] {
  const items: { id: string; kind: string; name: string; confidence: number; provenance: string }[] = [];
  const push = (id: string, kind: string, name: string, confidence: number, provenance: string) =>
    items.push({ id, kind, name, confidence, provenance });
  for (const n of o.objects) push(n.id, 'object', n.name, n.confidence, n.provenance);
  for (const n of o.rules) push(n.id, 'rule', n.title || n.id, n.confidence, n.provenance);
  for (const n of o.actions) push(n.id, 'action', n.name, n.confidence, n.provenance);
  for (const n of o.events) push(n.id, 'event', n.name, n.confidence, n.provenance);
  for (const n of o.processes) push(n.id, 'process', n.name?.en || n.id, n.confidence, n.provenance);
  for (const n of o.relationships) push(n.id, 'relationship', n.name, n.confidence, n.provenance);
  return items
    .filter((i) => i.provenance === 'inferred' || i.confidence < 0.6)
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, cap);
}

export interface QuestionOptions {
  domain: string;
  brief: BusinessBrief;
  ontology: Ontology;
  gaps: CoverageGap[];
  model: string;
  provider: string;
  userInfo: unknown | null;
  taken: Set<string>;
  log: (t: string) => void;
}

export async function runQuestions(opts: QuestionOptions): Promise<FollowUpQuestion[]> {
  const { system, user } = buildQuestionsPrompt({
    domain: opts.domain,
    gaps: opts.gaps,
    lowConfidenceItems: lowConfidenceItems(opts.ontology),
    useCases: opts.brief.useCases,
  });
  const json = await callJson({
    system,
    user,
    model: opts.model,
    provider: opts.provider,
    userInfo: opts.userInfo,
    actionName: 'ontology_followup_questions',
    maxTokens: 10000,
    temperature: 0.3,
  });

  let questions = parseQuestions(json, opts.taken);

  // Fallback: never finish a swarm run with zero questions when gaps remain.
  if (questions.length === 0 && opts.gaps.length > 0) {
    questions = opts.gaps
      .filter((g) => g.severity !== 'info')
      .slice(0, 12)
      .map((g) => ({
        id: localId('q', g.id, opts.taken),
        question: {
          en: `Can you clarify how to address this gap: ${g.description.en}?`,
          zh: `请说明如何补足以下缺口：${g.description.zh || g.description.en}？`,
        },
        rationale: g.description,
        layer: g.layer,
        addressesGapId: g.id,
        relatedItemId: g.relatedItemId,
      }));
  }

  opts.log(`[swarm] follow-up questions: ${questions.length} prepared`);
  return questions;
}

function parseQuestions(json: unknown, taken: Set<string>): FollowUpQuestion[] {
  const out: FollowUpQuestion[] = [];
  for (const raw of asArray(asRecord(json).questions)) {
    const r = asRecord(raw);
    const question = bil(r.question);
    if (!question.en && !question.zh) continue;
    const layer = (LAYER.has(str(r.layer)) ? str(r.layer) : 'general') as EntityKind | 'general';
    out.push({
      id: localId('q', str(r.id) || question.en, taken),
      question,
      rationale: bilOpt(r.rationale),
      layer,
      addressesGapId: str(r.addressesGapId) || undefined,
      relatedItemId: str(r.relatedItemId) || undefined,
    });
  }
  return out;
}
