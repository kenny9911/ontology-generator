// ============================================================================
//  DEEP-SWARM — phase machine.
//
//  The opt-in deep-swarm mode is CLIENT-PACED: the client calls `run.swarm.step`
//  repeatedly; each call runs ONE fine-grained sub-step (kept under the 60s
//  serverless cap) and reports it under one of 4 high-level SwarmPhases. The
//  cursor (which sub-step is next) is persisted by the handler in a side stash;
//  all artifacts (brief / coverage / questions) ride on `ontology.metadata`.
//
//  Sub-steps:
//    business_understanding: SME swarm → BusinessBrief
//    iteration_1 (breadth): extract objects→rules→actions→events→processes
//                           (brief-seeded) → BA review → coverage v1
//    iteration_2 (depth):   deepen objects/rules/actions/events → link synthesis
//                           → deepen processes → BA re-review → coverage v2
//    follow_up:             follow-up questions
//
//  Reuses the deterministic core (runStage/buildOntology) verbatim.
// ============================================================================

import {
  SWARM_PHASE_ORDER,
} from '../../../_shared/ontology-schema.js';
import type {
  Ontology,
  OntologyRun,
  SwarmPhase,
  SwarmPhaseProgress,
  SwarmAgentProgress,
  Stage,
  Bilingual,
  RunStatus,
  BusinessBrief,
  CoverageReport,
  FollowUpQuestion,
} from '../../../_shared/ontology-schema.js';
import type { StageContext } from '../context.js';
import { runStage, buildAndCarry } from '../orchestrator.js';
import { ctxAgentLlm } from '../../llm-router.js';
import { webSearchAvailable } from './web-search.js';
import { runBusinessUnderstanding, renderBriefSeed } from './business-understanding.js';
import { runBaReview } from './ba-review.js';
import { computeCoverage } from './coverage.js';
import { runLinkSynthesis } from './links.js';
import { runQuestions } from './questions.js';
import { deepenStage, countOfStage } from './deepen.js';

type StepKind = 'sme' | 'extract' | 'ba1' | 'deepen' | 'links' | 'ba2' | 'questions';

interface StepDef {
  phase: SwarmPhase;
  label: string;
  kind: StepKind;
  stage?: Stage;
}

const STEPS: StepDef[] = [
  { phase: 'business_understanding', label: 'SME swarm', kind: 'sme' },
  { phase: 'iteration_1', label: 'Extract objects', kind: 'extract', stage: 'objects' },
  { phase: 'iteration_1', label: 'Extract rules', kind: 'extract', stage: 'rules' },
  { phase: 'iteration_1', label: 'Extract actions', kind: 'extract', stage: 'actions' },
  { phase: 'iteration_1', label: 'Extract events', kind: 'extract', stage: 'events' },
  { phase: 'iteration_1', label: 'Extract processes', kind: 'extract', stage: 'processes' },
  { phase: 'iteration_1', label: 'BA review (every use case)', kind: 'ba1' },
  { phase: 'iteration_2', label: 'Deepen objects', kind: 'deepen', stage: 'objects' },
  { phase: 'iteration_2', label: 'Deepen rules', kind: 'deepen', stage: 'rules' },
  { phase: 'iteration_2', label: 'Deepen actions', kind: 'deepen', stage: 'actions' },
  { phase: 'iteration_2', label: 'Deepen events', kind: 'deepen', stage: 'events' },
  { phase: 'iteration_2', label: 'Link synthesis (full set)', kind: 'links' },
  { phase: 'iteration_2', label: 'Deepen processes', kind: 'deepen', stage: 'processes' },
  { phase: 'iteration_2', label: 'BA re-review + coverage', kind: 'ba2' },
  { phase: 'follow_up', label: 'Follow-up questions', kind: 'questions' },
];

export const SWARM_STEP_COUNT = STEPS.length;

const PHASE_LABELS: Record<SwarmPhase, Bilingual> = {
  business_understanding: { en: 'Business understanding', zh: '业务理解' },
  iteration_1: { en: 'Iteration 1 · breadth', zh: '第一轮 · 广度' },
  iteration_2: { en: 'Iteration 2 · depth', zh: '第二轮 · 深度' },
  follow_up: { en: 'Follow-up questions', zh: '待确认问题' },
};

const SME_ROLES = ['SME · Process', 'SME · Data', 'SME · Rules', 'SME · Systems'];

function phaseRange(phase: SwarmPhase): [number, number] {
  let lo = -1;
  let hi = -1;
  STEPS.forEach((s, i) => {
    if (s.phase === phase) {
      if (lo < 0) lo = i;
      hi = i;
    }
  });
  return [lo, hi];
}

/** Initial all-pending phase list for a freshly-seeded swarm run. */
export function seedSwarmPhases(): SwarmPhaseProgress[] {
  return SWARM_PHASE_ORDER.map((phase) => ({ phase, status: 'pending' as RunStatus, label: PHASE_LABELS[phase] }));
}

function buildPhases(cursor: number, done: boolean): SwarmPhaseProgress[] {
  // After running sub-step `cursor`, indices 0..cursor are complete.
  const completedCount = done ? STEPS.length : cursor + 1;
  const currentStep = STEPS[Math.min(cursor, STEPS.length - 1)]!;

  return SWARM_PHASE_ORDER.map((phase): SwarmPhaseProgress => {
    const [lo, hi] = phaseRange(phase);
    let status: RunStatus;
    if (hi < completedCount) status = 'complete';
    else if (lo < completedCount) status = 'running';
    else status = 'pending';

    const progress: SwarmPhaseProgress = { phase, status, label: PHASE_LABELS[phase] };
    if (status === 'running' && !done) progress.detail = currentStep.label;

    if (phase === 'business_understanding') {
      const agentStatus: RunStatus = status === 'complete' ? 'complete' : status === 'running' ? 'running' : 'pending';
      progress.agents = SME_ROLES.map(
        (role, i): SwarmAgentProgress => ({ id: `sme-${i}`, role, status: agentStatus }),
      );
    }
    return progress;
  });
}

function updateStage(run: OntologyRun, stage: Stage, status: RunStatus, count: number, error?: string): void {
  const row = run.stages.find((s) => s.stage === stage);
  if (!row) return;
  row.status = status;
  row.count = count;
  if (error) row.error = error;
}

interface MetaAcc {
  brief?: BusinessBrief;
  coverage?: CoverageReport;
  questions?: FollowUpQuestion[];
}

export interface AdvanceInput {
  cursor: number;
  ctx: StageContext;
  run: OntologyRun;
  ontology: Ontology;
}

export interface AdvanceResult {
  cursor: number;
  run: OntologyRun;
  ontology: Ontology;
  done: boolean;
  phase: SwarmPhase;
  businessBrief?: BusinessBrief;
  coverageReport?: CoverageReport;
  followUpQuestions?: FollowUpQuestion[];
}

/** Run exactly ONE swarm sub-step and return the updated run + ontology. */
export async function advanceSwarm(input: AdvanceInput): Promise<AdvanceResult> {
  const { ctx, run } = input;
  const cursor = Math.max(0, Math.min(input.cursor, STEPS.length - 1));
  const step = STEPS[cursor]!;

  const meta: MetaAcc = {
    brief: input.ontology.metadata?.businessBrief,
    coverage: input.ontology.metadata?.coverageReport,
    questions: input.ontology.metadata?.followUpQuestions,
  };

  const domain = String(input.ontology.domain);
  const docName = ctx.sources[0]?.name || 'the corpus';

  run.status = 'running';
  run.currentPhase = step.phase;
  ctx.log(`[swarm] phase "${PHASE_LABELS[step.phase].en}" — ${step.label}`);

  // Seed the brief into the iteration-1 extraction stages for recall.
  if (meta.brief && step.kind === 'extract') ctx.briefSeed = renderBriefSeed(meta.brief);

  try {
    switch (step.kind) {
      case 'sme': {
        const llm = ctxAgentLlm(ctx, 'sme_swarm', { needsWeb: webSearchAvailable(ctx.provider) });
        meta.brief = await runBusinessUnderstanding({
          domain,
          parsed: ctx.parsed,
          model: llm.model,
          provider: llm.provider,
          userInfo: ctx.userInfo,
          log: ctx.log,
        });
        break;
      }

      case 'extract': {
        const res = await runStage(step.stage!, ctx);
        updateStage(run, step.stage!, res.progress.status, res.progress.count, res.progress.error);
        break;
      }

      case 'ba1': {
        if (meta.brief) {
          const current = buildAndCarry(ctx, input.ontology);
          const llm = ctxAgentLlm(ctx, 'ba_reviewer');
          const gaps = await runBaReview({
            iteration: 1,
            brief: meta.brief,
            ontology: current,
            model: llm.model,
            provider: llm.provider,
            userInfo: ctx.userInfo,
            taken: ctx.taken,
            log: ctx.log,
          });
          meta.coverage = computeCoverage(1, meta.brief, current, gaps);
        }
        break;
      }

      case 'deepen': {
        if (meta.brief) {
          await deepenStage(ctx, step.stage!, meta.brief, meta.coverage?.gaps ?? []);
          updateStage(run, step.stage!, 'complete', countOfStage(ctx, step.stage!));
        }
        break;
      }

      case 'links':
        await runLinkSynthesis(ctx, docName);
        break;

      case 'ba2': {
        if (meta.brief) {
          const current = buildAndCarry(ctx, input.ontology);
          const llm = ctxAgentLlm(ctx, 'ba_reviewer');
          const gaps = await runBaReview({
            iteration: 2,
            brief: meta.brief,
            ontology: current,
            model: llm.model,
            provider: llm.provider,
            userInfo: ctx.userInfo,
            taken: ctx.taken,
            log: ctx.log,
          });
          meta.coverage = computeCoverage(2, meta.brief, current, gaps);
        }
        break;
      }

      case 'questions': {
        if (meta.brief) {
          const current = buildAndCarry(ctx, input.ontology);
          const llm = ctxAgentLlm(ctx, 'question_generator');
          meta.questions = await runQuestions({
            domain,
            brief: meta.brief,
            ontology: current,
            gaps: meta.coverage?.gaps ?? [],
            model: llm.model,
            provider: llm.provider,
            userInfo: ctx.userInfo,
            taken: ctx.taken,
            log: ctx.log,
          });
        }
        break;
      }
    }
  } catch (err) {
    ctx.log(`[swarm] step "${step.label}" failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Reassemble the ontology from ctx and re-attach the accumulated artifacts.
  const ontology = buildAndCarry(ctx, input.ontology);
  ontology.metadata = {
    ...ontology.metadata,
    businessBrief: meta.brief,
    coverageReport: meta.coverage,
    followUpQuestions: meta.questions,
    swarm: { iterations: 2, web: meta.brief?.webAugmented ?? false },
  };

  const done = cursor + 1 >= STEPS.length;
  run.phases = buildPhases(cursor, done);
  run.currentPhase = done ? null : step.phase;
  run.status = done ? 'complete' : 'running';

  return {
    cursor: cursor + 1,
    run,
    ontology,
    done,
    phase: step.phase,
    businessBrief: meta.brief,
    coverageReport: meta.coverage,
    followUpQuestions: meta.questions,
  };
}
