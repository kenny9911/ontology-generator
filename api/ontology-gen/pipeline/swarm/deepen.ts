// ============================================================================
//  DEEP-SWARM — iteration-2 gap-driven deepening of one layer.
//
//  Reuses the deterministic `runStage` pipeline (extract → ground → drop →
//  confidence → validate) with a DEEPENING seed that lists the open gaps and the
//  already-found items, instructing the model to REPRODUCE existing items + ADD
//  the missing ones. `runStage` replaces the layer, so we MERGE-PRESERVE by id
//  afterward to guarantee no iteration-1 work is lost.
// ============================================================================

import { runStage } from '../orchestrator.js';
import type { Stage, EntityKind, BusinessBrief, CoverageGap } from '../../../_shared/ontology-schema.js';
import type { StageContext } from '../context.js';
import { renderDeepenSeed } from './business-understanding.js';

const STAGE_TO_KIND: Record<Stage, EntityKind> = {
  objects: 'object',
  rules: 'rule',
  actions: 'action',
  events: 'event',
  processes: 'process',
};

function existingLines(ctx: StageContext, stage: Stage): string {
  switch (stage) {
    case 'objects':
      return ctx.objects.map((o) => `- ${o.id} :: ${o.name}`).join('\n');
    case 'rules':
      return ctx.rules.map((r) => `- ${r.id} :: ${r.title || r.statement?.en || ''}`).join('\n');
    case 'actions':
      return ctx.actions.map((a) => `- ${a.id} :: ${a.name}`).join('\n');
    case 'events':
      return ctx.events.map((e) => `- ${e.id} :: ${e.name}`).join('\n');
    case 'processes':
      return ctx.processes.map((p) => `- ${p.id} :: ${p.name?.en || ''}`).join('\n');
    default:
      return '';
  }
}

/**
 * Merge the re-extracted layer with the pre-deepen snapshot WITHOUT duplicates.
 *
 * The deepen prompt asks the model to REPRODUCE every existing item with the
 * same id, but the stage parsers re-mint ids against `ctx.taken` — which
 * already contains the originals — so every reproduced item comes back under a
 * `-2`-suffixed id. Keying the merge on ids therefore duplicated the whole
 * layer. Instead we key on a CANONICAL CONTENT KEY (normalized name/title):
 * the snapshot copy wins for any item that existed before (it is already
 * grounded/scored/reviewed and other layers reference ITS id); only items
 * whose key is genuinely new survive from the re-extraction.
 */
export function preserve<T extends { id: string }>(
  current: T[],
  snapshot: T[],
  keyOf: (n: T) => string,
): T[] {
  // An empty content key (blank name) falls back to the id so distinct
  // unnamed items can never collide into one bucket.
  const kf = (n: T): string => keyOf(n) || n.id;
  const merged = [...snapshot];
  const keys = new Set(snapshot.map(kf));
  const ids = new Set(snapshot.map((n) => n.id));
  for (const n of current) {
    if (keys.has(kf(n)) || ids.has(n.id)) continue; // reproduction of an existing item
    keys.add(kf(n));
    ids.add(n.id);
    merged.push(n);
  }
  return merged;
}

/** Canonical content key: normalized display name (id-independent). */
const norm = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export function countOfStage(ctx: StageContext, stage: Stage): number {
  switch (stage) {
    case 'objects':
      return ctx.objects.length;
    case 'rules':
      return ctx.rules.length;
    case 'actions':
      return ctx.actions.length;
    case 'events':
      return ctx.events.length;
    case 'processes':
      return ctx.processes.length;
    default:
      return 0;
  }
}

/** Deepen one layer against the open gaps; returns the number of items added. */
export async function deepenStage(
  ctx: StageContext,
  stage: Stage,
  brief: BusinessBrief,
  gaps: CoverageGap[],
): Promise<number> {
  const kind = STAGE_TO_KIND[stage];
  const layerGaps = gaps.filter((g) => g.layer === kind || g.layer === 'general');
  const gapLines = layerGaps.map((g) => `- (${g.severity}) ${g.description.en}`).join('\n');

  const before = countOfStage(ctx, stage);
  const prevSeed = ctx.briefSeed;
  ctx.briefSeed = renderDeepenSeed(brief, gapLines, existingLines(ctx, stage));

  // Snapshot the arrays runStage will REPLACE, so iteration-1 work is never lost.
  const snapObjects = [...ctx.objects];
  const snapRels = [...ctx.relationships];
  const snapRules = [...ctx.rules];
  const snapGroups = [...ctx.ruleGroups];
  const snapActions = [...ctx.actions];
  const snapEvents = [...ctx.events];
  const snapProcesses = [...ctx.processes];

  try {
    await runStage(stage, ctx);
  } catch (err) {
    ctx.log(`[swarm] deepen ${stage} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    ctx.briefSeed = prevSeed;
  }

  switch (stage) {
    case 'objects':
      ctx.objects = preserve(ctx.objects, snapObjects, (o) => norm(o.name));
      ctx.relationships = preserve(
        ctx.relationships,
        snapRels,
        (r) => `${norm(r.sourceObjectTypeId)}|${norm(r.name)}|${norm(r.targetObjectTypeId)}`,
      );
      break;
    case 'rules':
      ctx.rules = preserve(ctx.rules, snapRules, (r) => norm(r.title || r.statement?.en));
      ctx.ruleGroups = preserve(ctx.ruleGroups, snapGroups, (g) => norm(g.title?.en));
      break;
    case 'actions':
      ctx.actions = preserve(ctx.actions, snapActions, (a) => norm(a.name));
      break;
    case 'events':
      // Event ids ARE the canonical dotted names (minted deterministically
      // from the actions), so the id is the right key here.
      ctx.events = preserve(ctx.events, snapEvents, (e) => norm(e.id));
      break;
    case 'processes':
      ctx.processes = preserve(ctx.processes, snapProcesses, (p) => norm(p.name?.en));
      break;
  }

  const after = countOfStage(ctx, stage);
  const added = Math.max(0, after - before);
  ctx.log(`[swarm] deepen ${stage}: ${before} → ${after} (+${added})`);
  return added;
}
