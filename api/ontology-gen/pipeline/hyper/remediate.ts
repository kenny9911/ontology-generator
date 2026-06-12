// ============================================================================
//  HYPER-AUTOMATION — remediation (eval findings → targeted re-extraction).
//
//  Converts the coverage eval's uncovered/partial sentences into targeted
//  CoverageGaps — each gap embeds the VERBATIM uncovered sentence — and
//  re-extracts ONLY those through the proven `deepenStage` merge-preserve path,
//  so remediated nodes get grounding, confidence and validation exactly like
//  every other node and no prior work is ever lost.
//
//  No-ops (each guard logged) when there is no eval report, it already meets
//  the target, there is no brief, or no findings map to the given stages — the
//  fixed-array cursor model stays intact while behaving like loop-until-covered.
// ============================================================================

import { STAGE_ORDER } from '../../../_shared/ontology-schema.js';
import type {
  BusinessBrief,
  CoverageGap,
  DocumentCoverageEval,
  EntityKind,
  SentenceCoverage,
  Stage,
} from '../../../_shared/ontology-schema.js';
import type { StageContext } from '../context.js';
import { deepenStage } from '../swarm/deepen.js';

/** Per stage per round, at most this many gaps go into one deepen pass. */
const MAX_GAPS_PER_STAGE = 40;

const STAGE_TO_KIND: Record<Stage, EntityKind> = {
  objects: 'object',
  rules: 'rule',
  actions: 'action',
  events: 'event',
  processes: 'process',
};

/**
 * Turn coverage findings into CoverageGaps for ONE layer. Severity follows the
 * finding (`uncovered` → block, `partial` → warn); the description embeds the
 * verbatim source sentence so the deepen prompt can re-search the document for
 * exactly the missed information. Pure — capping/logging is the caller's job.
 */
export function findingsToGaps(findings: SentenceCoverage[], layer: EntityKind, round: number): CoverageGap[] {
  return findings.map((f): CoverageGap => {
    const missingEn = f.missing ? ` — missing: ${f.missing}` : '';
    const missingZh = f.missing ? ` — 缺失：${f.missing}` : '';
    return {
      id: `gap:cov-r${round}-${f.idx}`,
      layer,
      severity: f.status === 'uncovered' ? 'block' : 'warn',
      description: {
        en: `Source sentence ${f.idx} is not represented: "${f.text}"${missingEn}`,
        zh: `源文第 ${f.idx} 句未被本体覆盖："${f.text}"${missingZh}`,
      },
    };
  });
}

/** True when this finding should be remediated by the given stage's layer. */
function findingMapsToStage(f: SentenceCoverage, stage: Stage): boolean {
  if (f.expectedKinds && f.expectedKinds.length > 0) return f.expectedKinds.includes(STAGE_TO_KIND[stage]);
  // No expected kinds named: the safest recall default is the structural layers.
  return stage === 'objects' || stage === 'rules';
}

/**
 * Remediate the latest eval's findings through the given stages (respecting
 * STAGE_ORDER). Returns the total number of nodes added across stages.
 */
export async function runRemediation(
  ctx: StageContext,
  brief: BusinessBrief | undefined,
  evalReport: DocumentCoverageEval | undefined,
  stages: Stage[],
  round: number,
): Promise<number> {
  if (!evalReport) {
    ctx.log(`[hyper] remediation r${round}: no coverage eval report — skipping`);
    return 0;
  }
  if (evalReport.meetsTarget) {
    ctx.log(`[hyper] remediation r${round}: coverage target already met (${evalReport.coverageRatio} ≥ ${evalReport.target}) — skipping`);
    return 0;
  }
  if (!brief) {
    ctx.log(`[hyper] remediation r${round}: no business brief — skipping`);
    return 0;
  }

  const ordered = STAGE_ORDER.filter((s) => stages.includes(s));
  const perStage = new Map<Stage, SentenceCoverage[]>();
  for (const stage of ordered) {
    const mapped = evalReport.findings.filter((f) => findingMapsToStage(f, stage));
    if (mapped.length > 0) perStage.set(stage, mapped);
  }
  if (perStage.size === 0) {
    ctx.log(`[hyper] remediation r${round}: no findings map to stage(s) ${stages.join(', ')} — skipping`);
    return 0;
  }

  let added = 0;
  for (const stage of ordered) {
    const mapped = perStage.get(stage);
    if (!mapped) continue;
    const gaps = findingsToGaps(mapped, STAGE_TO_KIND[stage], round).slice(0, MAX_GAPS_PER_STAGE);
    const dropped = mapped.length - gaps.length;
    if (dropped > 0) ctx.log(`[hyper] remediation r${round} ${stage}: capped at ${MAX_GAPS_PER_STAGE} gap(s), ${dropped} dropped`);
    ctx.log(`[hyper] remediation r${round} ${stage}: deepening against ${gaps.length} coverage gap(s)`);
    added += await deepenStage(ctx, stage, brief, gaps);
  }

  ctx.log(`[hyper] remediation r${round}: +${added} node(s) across ${perStage.size} stage(s)`);
  return added;
}
