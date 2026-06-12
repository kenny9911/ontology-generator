// ============================================================================
//  DEEP-SWARM — deterministic coverage/recall computation.
//
//  Matches each EXPECTED entity (from the SME brief) to a real ontology node by
//  fuzzy name within its layer, then rolls the matches up into a CoverageReport
//  (per-layer recall, per-use-case coverage, overall recall). Pure, no LLM.
// ============================================================================

import type {
  Ontology,
  BusinessBrief,
  CoverageReport,
  CoverageGap,
  LayerCoverage,
  UseCaseCoverage,
  ExpectedEntity,
  EntityKind,
} from '../../../_shared/ontology-schema.js';
import { clamp01 } from './util.js';

const LAYER_KINDS: EntityKind[] = ['object', 'rule', 'action', 'event', 'process', 'relationship'];

const norm = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function nodesOfKind(o: Ontology, kind: EntityKind): { id: string; name: string }[] {
  switch (kind) {
    case 'object':
      return o.objects.map((n) => ({ id: n.id, name: n.name }));
    case 'rule':
      return o.rules.map((n) => ({ id: n.id, name: n.title || n.statement?.en || n.id }));
    case 'action':
      return o.actions.map((n) => ({ id: n.id, name: n.name }));
    case 'event':
      return o.events.map((n) => ({ id: n.id, name: n.name }));
    case 'process':
      return o.processes.map((n) => ({ id: n.id, name: n.name?.en || n.id }));
    case 'relationship':
      return o.relationships.map((n) => ({ id: n.id, name: n.name }));
    default:
      return [];
  }
}

/** Match each expected entity to an ontology node by fuzzy name within its kind. Mutates `found`/`matchedId`. */
export function matchExpectations(brief: BusinessBrief, o: Ontology): void {
  const byKind = new Map<EntityKind, { id: string; n: string }[]>();
  for (const k of LAYER_KINDS) byKind.set(k, nodesOfKind(o, k).map((x) => ({ id: x.id, n: norm(x.name) })));

  for (const exp of brief.expectedEntities) {
    const candidates = byKind.get(exp.kind) ?? [];
    const target = norm(exp.name.en || exp.name.zh);
    let match: string | undefined;
    if (target) {
      for (const c of candidates) {
        if (!c.n) continue;
        if (c.n === target || c.n.includes(target) || target.includes(c.n)) {
          match = c.id;
          break;
        }
      }
    }
    exp.found = Boolean(match);
    exp.matchedId = match;
  }
}

/** Build the coverage report from matched expectations + the BA's gaps. */
export function computeCoverage(
  iteration: number,
  brief: BusinessBrief,
  o: Ontology,
  gaps: CoverageGap[],
): CoverageReport {
  matchExpectations(brief, o);

  const perLayer: LayerCoverage[] = LAYER_KINDS.map((layer) => {
    const exp = brief.expectedEntities.filter((e) => e.kind === layer);
    const expected = exp.length;
    const found = exp.filter((e) => e.found).length;
    return { layer, expected, found, recall: expected === 0 ? 1 : clamp01(found / expected) };
  });

  const expById = new Map(brief.expectedEntities.map((e) => [e.id, e] as const));
  const perUseCase: UseCaseCoverage[] = brief.useCases.map((uc) => {
    const linked = (uc.expectedEntityIds ?? []).map((id) => expById.get(id)).filter(Boolean) as ExpectedEntity[];
    const exp = linked.length > 0 ? linked : brief.expectedEntities; // fall back to all when unlinked
    const found = exp.filter((e) => e.found).length;
    const coverage = exp.length === 0 ? 1 : clamp01(found / exp.length);
    const gapIds = gaps.filter((g) => g.useCaseId === uc.id).map((g) => g.id);
    return { useCaseId: uc.id, coverage, gapIds };
  });

  const totalExpected = brief.expectedEntities.length;
  const totalFound = brief.expectedEntities.filter((e) => e.found).length;
  const overallRecall = totalExpected === 0 ? 1 : clamp01(totalFound / totalExpected);

  return { iteration, perLayer, perUseCase, gaps, overallRecall };
}
