// ============================================================================
//  HYPER-AUTOMATION — phase machine ("100% document coverage" mode).
//
//  The opt-in hyper mode is CLIENT-PACED: the client calls `run.hyper.step`
//  repeatedly; each call runs ONE fine-grained sub-step (kept under the 60s
//  serverless cap) and reports it under one of the 10 HyperPhases. A superset
//  of the swarm machine (whose modules are reused verbatim) adding:
//
//    terminology:    exhaustive glossary + data-type sweep, seeded into every
//                    later extraction prompt alongside the business brief
//    coverage_eval:  sentence-level document-coverage eval after each iteration
//    remediation:    eval findings → targeted CoverageGaps → deepenStage
//                    (no-ops once the eval meets the coverage target)
//    final_eval:     the last coverage pass that records `meetsTarget`
//
//  Sub-steps (fixed array, see HYPER_STEP_COUNT; cursor persisted by the
//  handler in the same stash):
//    terminology → SME swarm → extract ×5 → BA review → eval pass 1 →
//    remediate ×5 (one stage per request) → deepen ×4 → links → deepen
//    processes → BA re-review → eval pass 2 → remediate ×5 (round 2) →
//    eval pass 3 (final gate) → follow-up questions.
//  Remediation is one stage per sub-step so a single request never runs more
//  than one full-stage LLM re-extraction (60 s serverless budget).
//
//  Step failures are caught and logged, never thrown (identical to swarm);
//  all artifacts ride on `ontology.metadata`.
// ============================================================================

import {
  HYPER_PHASE_ORDER,
} from '../../../_shared/ontology-schema.js';
import type {
  Ontology,
  OntologyRun,
  HyperPhase,
  SwarmPhaseProgress,
  SwarmAgentProgress,
  Stage,
  Bilingual,
  RunStatus,
  BusinessBrief,
  CoverageReport,
  FollowUpQuestion,
  TerminologyExtraction,
  DocumentCoverageEval,
} from '../../../_shared/ontology-schema.js';
import { runStage, buildAndCarry } from '../orchestrator.js';
import type { AdvanceInput } from '../swarm/orchestrator.js';
import { runBusinessUnderstanding, renderBriefSeed } from '../swarm/business-understanding.js';
import { runBaReview } from '../swarm/ba-review.js';
import { computeCoverage } from '../swarm/coverage.js';
import { runLinkSynthesis } from '../swarm/links.js';
import { runQuestions } from '../swarm/questions.js';
import { deepenStage, countOfStage } from '../swarm/deepen.js';
import { webSearchAvailable } from '../swarm/web-search.js';
import { runTerminology, renderTermSeed, matchTerms } from './terminology.js';
import { runDocumentCoverageEval, coverageTarget } from './doc-coverage.js';
import { runRemediation } from './remediate.js';

type StepKind =
  | 'terminology'
  | 'sme'
  | 'extract'
  | 'ba1'
  | 'eval'
  | 'remediate'
  | 'deepen'
  | 'links'
  | 'ba2'
  | 'questions';

interface StepDef {
  phase: HyperPhase;
  label: string;
  kind: StepKind;
  stage?: Stage;
  /** Stages a remediation step may re-extract through. */
  stages?: Stage[];
  /** Which eval pass this step runs (1 | 2 | 3 = final). */
  pass?: number;
  /** Which remediation round this step belongs to (1 | 2). */
  round?: number;
}

const STEPS: StepDef[] = [
  { phase: 'terminology', label: 'Terminology & data-type scan', kind: 'terminology' },
  { phase: 'business_understanding', label: 'SME swarm', kind: 'sme' },
  { phase: 'iteration_1', label: 'Extract objects', kind: 'extract', stage: 'objects' },
  { phase: 'iteration_1', label: 'Extract rules', kind: 'extract', stage: 'rules' },
  { phase: 'iteration_1', label: 'Extract actions', kind: 'extract', stage: 'actions' },
  { phase: 'iteration_1', label: 'Extract events', kind: 'extract', stage: 'events' },
  { phase: 'iteration_1', label: 'Extract processes', kind: 'extract', stage: 'processes' },
  { phase: 'iteration_1', label: 'BA review (every use case)', kind: 'ba1' },
  { phase: 'coverage_eval_1', label: 'Document coverage eval · pass 1', kind: 'eval', pass: 1 },
  // One stage per sub-step: each remediation request makes AT MOST one
  // deepenStage LLM call, keeping every request inside the 60 s budget.
  { phase: 'remediation_1', label: 'Remediate objects', kind: 'remediate', stages: ['objects'], round: 1 },
  { phase: 'remediation_1', label: 'Remediate rules', kind: 'remediate', stages: ['rules'], round: 1 },
  { phase: 'remediation_1', label: 'Remediate actions', kind: 'remediate', stages: ['actions'], round: 1 },
  { phase: 'remediation_1', label: 'Remediate events', kind: 'remediate', stages: ['events'], round: 1 },
  { phase: 'remediation_1', label: 'Remediate processes', kind: 'remediate', stages: ['processes'], round: 1 },
  { phase: 'iteration_2', label: 'Deepen objects', kind: 'deepen', stage: 'objects' },
  { phase: 'iteration_2', label: 'Deepen rules', kind: 'deepen', stage: 'rules' },
  { phase: 'iteration_2', label: 'Deepen actions', kind: 'deepen', stage: 'actions' },
  { phase: 'iteration_2', label: 'Deepen events', kind: 'deepen', stage: 'events' },
  { phase: 'iteration_2', label: 'Link synthesis (full set)', kind: 'links' },
  { phase: 'iteration_2', label: 'Deepen processes', kind: 'deepen', stage: 'processes' },
  { phase: 'iteration_2', label: 'BA re-review + coverage', kind: 'ba2' },
  { phase: 'coverage_eval_2', label: 'Document coverage eval · pass 2', kind: 'eval', pass: 2 },
  { phase: 'remediation_2', label: 'Remediate objects (round 2)', kind: 'remediate', stages: ['objects'], round: 2 },
  { phase: 'remediation_2', label: 'Remediate rules (round 2)', kind: 'remediate', stages: ['rules'], round: 2 },
  { phase: 'remediation_2', label: 'Remediate actions (round 2)', kind: 'remediate', stages: ['actions'], round: 2 },
  { phase: 'remediation_2', label: 'Remediate events (round 2)', kind: 'remediate', stages: ['events'], round: 2 },
  { phase: 'remediation_2', label: 'Remediate processes (round 2)', kind: 'remediate', stages: ['processes'], round: 2 },
  { phase: 'final_eval', label: 'Document coverage eval · final gate', kind: 'eval', pass: 3 },
  { phase: 'follow_up', label: 'Follow-up questions', kind: 'questions' },
];

export const HYPER_STEP_COUNT = STEPS.length;

const PHASE_LABELS: Record<HyperPhase, Bilingual> = {
  terminology: { en: 'Terminology & data types', zh: '术语与数据类型识别' },
  business_understanding: { en: 'Business understanding', zh: '业务理解' },
  iteration_1: { en: 'Iteration 1 · breadth', zh: '第一轮 · 广度' },
  coverage_eval_1: { en: 'Document coverage eval 1', zh: '全量覆盖校验 1' },
  remediation_1: { en: 'Gap remediation 1', zh: '缺口补全 1' },
  iteration_2: { en: 'Iteration 2 · depth', zh: '第二轮 · 深度' },
  coverage_eval_2: { en: 'Document coverage eval 2', zh: '全量覆盖校验 2' },
  remediation_2: { en: 'Gap remediation 2', zh: '缺口补全 2' },
  final_eval: { en: 'Final coverage gate', zh: '最终覆盖闸门' },
  follow_up: { en: 'Follow-up questions', zh: '待确认问题' },
};

const SME_ROLES = ['SME · Process', 'SME · Data', 'SME · Rules', 'SME · Systems'];

function phaseRange(phase: HyperPhase): [number, number] {
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

/** Initial all-pending phase list for a freshly-seeded hyper run. */
export function seedHyperPhases(): SwarmPhaseProgress[] {
  return HYPER_PHASE_ORDER.map((phase) => ({ phase, status: 'pending' as RunStatus, label: PHASE_LABELS[phase] }));
}

function buildPhases(cursor: number, done: boolean): SwarmPhaseProgress[] {
  // After running sub-step `cursor`, indices 0..cursor are complete.
  const completedCount = done ? STEPS.length : cursor + 1;
  const currentStep = STEPS[Math.min(cursor, STEPS.length - 1)]!;

  return HYPER_PHASE_ORDER.map((phase): SwarmPhaseProgress => {
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
  terminology?: TerminologyExtraction;
  docCoverage?: DocumentCoverageEval;
  docCoverageHistory?: DocumentCoverageEval[];
}

export type HyperAdvanceInput = AdvanceInput;

export interface HyperAdvanceResult {
  cursor: number;
  run: OntologyRun;
  ontology: Ontology;
  done: boolean;
  phase: HyperPhase;
  businessBrief?: BusinessBrief;
  coverageReport?: CoverageReport;
  followUpQuestions?: FollowUpQuestion[];
  terminology?: TerminologyExtraction;
  documentCoverage?: DocumentCoverageEval;
}

/** Run exactly ONE hyper sub-step and return the updated run + ontology. */
export async function advanceHyper(input: HyperAdvanceInput): Promise<HyperAdvanceResult> {
  const { ctx, run } = input;
  const cursor = Math.max(0, Math.min(input.cursor, STEPS.length - 1));
  const step = STEPS[cursor]!;

  const meta: MetaAcc = {
    brief: input.ontology.metadata?.businessBrief,
    coverage: input.ontology.metadata?.coverageReport,
    questions: input.ontology.metadata?.followUpQuestions,
    terminology: input.ontology.metadata?.terminology,
    docCoverage: input.ontology.metadata?.documentCoverage,
    docCoverageHistory: input.ontology.metadata?.documentCoverageHistory,
  };

  const domain = String(input.ontology.domain);
  const docName = ctx.sources[0]?.name || 'the corpus';

  run.status = 'running';
  run.currentPhase = step.phase;
  ctx.log(`[hyper] phase "${PHASE_LABELS[step.phase].en}" — ${step.label}`);

  // Seed brief + terminology into the iteration-1 extraction stages for recall.
  if (step.kind === 'extract') {
    const parts: string[] = [];
    if (meta.brief) parts.push(renderBriefSeed(meta.brief));
    if (meta.terminology) parts.push(renderTermSeed(meta.terminology));
    if (parts.length > 0) ctx.briefSeed = parts.join('\n\n');
  }

  try {
    switch (step.kind) {
      case 'terminology':
        meta.terminology = await runTerminology(ctx);
        break;

      case 'sme': {
        // Mirror the swarm orchestrator: only ask the router to pin the
        // OpenRouter path when web search is actually available there —
        // an unconditional pin breaks direct-provider deployments.
        const llm =
          ctx.agentLlm?.('sme_swarm', { needsWeb: webSearchAvailable(ctx.provider) }) ??
          { model: ctx.model, provider: ctx.provider };
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

      case 'ba1':
      case 'ba2': {
        if (meta.brief) {
          const iteration = step.kind === 'ba1' ? 1 : 2;
          const current = buildAndCarry(ctx, input.ontology);
          const llm = ctx.agentLlm?.('ba_reviewer') ?? { model: ctx.model, provider: ctx.provider };
          const gaps = await runBaReview({
            iteration,
            brief: meta.brief,
            ontology: current,
            model: llm.model,
            provider: llm.provider,
            userInfo: ctx.userInfo,
            taken: ctx.taken,
            log: ctx.log,
          });
          meta.coverage = computeCoverage(iteration, meta.brief, current, gaps);
        }
        break;
      }

      case 'eval': {
        const current = buildAndCarry(ctx, input.ontology);
        const report = await runDocumentCoverageEval({ ctx, ontology: current, pass: step.pass! });
        // Retire the previous pass into history (findings trimmed) before replacing.
        if (meta.docCoverage) {
          meta.docCoverageHistory = [...(meta.docCoverageHistory ?? []), { ...meta.docCoverage, findings: [] }];
        }
        meta.docCoverage = report;
        // At the final gate, re-reconcile the glossary so matchedId is fresh.
        if (step.pass === 3 && meta.terminology) meta.terminology = matchTerms(meta.terminology, current);
        break;
      }

      case 'remediate': {
        const added = await runRemediation(ctx, meta.brief, meta.docCoverage, step.stages!, step.round!);
        for (const st of step.stages!) updateStage(run, st, 'complete', countOfStage(ctx, st));
        ctx.log(`[hyper] ${step.label}: +${added} node(s)`);
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

      case 'questions': {
        if (meta.brief) {
          const current = buildAndCarry(ctx, input.ontology);
          const llm = ctx.agentLlm?.('question_generator') ?? { model: ctx.model, provider: ctx.provider };
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
    ctx.log(`[hyper] step "${step.label}" failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Reassemble the ontology from ctx and re-attach the accumulated artifacts.
  const passesRun = (meta.docCoverageHistory?.length ?? 0) + (meta.docCoverage ? 1 : 0);
  const roundsRun = new Set(
    STEPS.filter((s, i) => i <= cursor && s.kind === 'remediate').map((s) => s.round),
  ).size;

  const ontology = buildAndCarry(ctx, input.ontology);
  ontology.metadata = {
    ...ontology.metadata,
    businessBrief: meta.brief,
    coverageReport: meta.coverage,
    followUpQuestions: meta.questions,
    terminology: meta.terminology,
    documentCoverage: meta.docCoverage,
    documentCoverageHistory: meta.docCoverageHistory,
    hyper: {
      passes: passesRun,
      coverageTarget: meta.docCoverage?.target ?? coverageTarget(),
      remediationRounds: roundsRun,
      web: meta.brief?.webAugmented ?? false,
    },
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
    terminology: meta.terminology,
    documentCoverage: meta.docCoverage,
  };
}
