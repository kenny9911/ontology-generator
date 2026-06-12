// ============================================================================
//  DEEP-SWARM — dedicated relationship (link) synthesis.
//
//  The per-document objects stage only finds intra-chunk relationships. This
//  pass reasons over the COMPLETE ObjectType set to add edges the extraction
//  missed (especially cross-document ones). Inferred edges are kept via
//  `provenance:'inferred'` + `derivedFrom`; grounded ones carry a real snippet.
// ============================================================================

import { randomUUID } from 'crypto';

import { buildLinksPrompt } from '../../prompts.js';
import { makeId } from '../../../_shared/ids.js';
import { groundSources, dropUngroundedNodes } from '../ground.js';
import { scoreConfidence, relationshipCompleteness } from '../confidence.js';
import type { Relationship, Cardinality } from '../../../_shared/ontology-schema.js';
import type { StageContext } from '../context.js';
import { ctxAgentLlm } from '../../llm-router.js';
import { callJson } from './llm-json.js';
import { asArray, asRecord, str, parseSourceRefs } from './util.js';

const CARD = new Set<string>(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']);

/** Synthesize cross-corpus relationships; merge into ctx.relationships. Returns count added. */
export async function runLinkSynthesis(ctx: StageContext, docName: string): Promise<number> {
  if (ctx.objects.length < 2) return 0;

  const objects = ctx.objects.map((o) => ({
    id: o.id,
    name: o.name,
    attributes: o.attributes?.map((a) => ({ name: a.name, keyRole: a.keyRole, ref: a.refObjectTypeId })),
  }));
  const existing = ctx.relationships.map((r) => ({
    id: r.id,
    name: r.name,
    from: r.sourceObjectTypeId,
    to: r.targetObjectTypeId,
  }));

  const { system, user } = buildLinksPrompt({ objects, existingRelationships: existing, docName });
  const llm = ctxAgentLlm(ctx, 'link_synthesizer');
  const json = await callJson({
    system,
    user,
    model: llm.model,
    provider: llm.provider,
    userInfo: ctx.userInfo,
    actionName: 'ontology_link_synthesis',
    maxTokens: 12000,
    temperature: 0.2,
  });
  if (!json) {
    ctx.log('[swarm] link synthesis: no output');
    return 0;
  }

  const objectIds = new Set(ctx.objects.map((o) => o.id));
  const sig = new Set(ctx.relationships.map((r) => `${r.sourceObjectTypeId}|${r.name}|${r.targetObjectTypeId}`));
  const additions: Relationship[] = [];

  for (const raw of asArray(asRecord(json).relationships)) {
    const r = asRecord(raw);
    const name = str(r.name);
    const from = str(r.sourceObjectTypeId);
    const to = str(r.targetObjectTypeId);
    if (!name || !objectIds.has(from) || !objectIds.has(to)) continue;
    const key = `${from}|${name}|${to}`;
    if (sig.has(key)) continue;
    sig.add(key);

    const cardinality = (CARD.has(str(r.cardinality)) ? str(r.cardinality) : 'many_to_many') as Cardinality;
    const extracted = str(r.provenance) === 'extracted';
    const sources = extracted ? parseSourceRefs(r.sources, docName) : [];
    const fromBare = from.replace(/^objectType:/, '');
    const toBare = to.replace(/^objectType:/, '');

    additions.push({
      id: makeId('relationship', `${fromBare}-${name}-${toBare}`, ctx.taken),
      uuid: randomUUID(),
      name,
      nameZh: str(r.nameZh) || undefined,
      sourceObjectTypeId: from,
      targetObjectTypeId: to,
      cardinality,
      viaAttribute: str(r.viaAttribute) || undefined,
      sources,
      confidence: 0.5,
      provenance: extracted ? 'extracted' : 'inferred',
      derivedFrom: extracted ? undefined : [from, to],
      reviewState: 'pending',
    });
  }

  if (additions.length === 0) {
    ctx.log('[swarm] link synthesis: no new relationships');
    return 0;
  }

  // Ground citations, drop ungrounded EXTRACTED edges (inferred survive), score.
  groundSources(additions, ctx.parsed);
  const kept = dropUngroundedNodes(additions);
  for (const rel of kept) {
    const refs = [rel.sourceObjectTypeId, rel.targetObjectTypeId];
    const resolved = refs.filter((id) => objectIds.has(id)).length;
    rel.confidence = scoreConfidence(
      rel,
      { rawSelfRating: rel.confidence, totalRefs: refs.length, resolvedRefs: resolved },
      relationshipCompleteness(rel),
    );
  }

  ctx.relationships = [...ctx.relationships, ...kept];
  ctx.log(`[swarm] link synthesis: +${kept.length} relationship(s) across the full object set`);
  return kept.length;
}
