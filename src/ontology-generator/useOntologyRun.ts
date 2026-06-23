// ============================================================================
//  useOntologyRun.ts — the ONE controller hook the Ontology Generator container
//  binds and threads to every screen as the `ctrl` prop (DESIGN_SPEC §8.3).
//
//  It owns ALL run/ontology state and exposes the FIXED `OntologyRunController`
//  contract. Two modes share one surface:
//
//    DEMO ('demo')  — offline. `startDemo()` builds a complete canonical
//                     Ontology from the `commerce` fixture via
//                     `datasetToOntology` (all five layers + relationships, so
//                     every one of the 9 steps lights up). `step()` is a no-op;
//                     review/edit/merge mutate the in-memory ontology nodes;
//                     `save()`/`reRunStage()` are no-ops; `publish()` returns
//                     `{ mirrored: false }`; `generate()` is computed/stubbed
//                     locally (no backend in demo).
//
//    LIVE ('live')  — `startUpload`/`startSample` create a server run and seed a
//                     draft ontology (`api.runStart`); `step()` advances exactly
//                     one stage (`api.runStep`) and merges the returned partial
//                     ontology + run progress until `run.status === 'complete'`;
//                     `reRunStage` re-runs one stage; `save`/`publish` persist;
//                     `publish` also pulls the generated bundles via
//                     `api.generate(id, 'all')`.
//
//  Pure React state (useState) + stable callbacks (useCallback). No `any`,
//  compiles under strict / noUnusedLocals / noUnusedParameters.
// ============================================================================

import { useCallback, useMemo, useRef, useState } from 'react';

import type {
  Bilingual,
  Ontology,
  OntologyRun,
  StageProgress,
  GeneratedBundle,
  Stage,
  DomainKey,
  EntityKind,
  ReviewStatus,
  RunPhase,
  BusinessBrief,
  CoverageReport,
  FollowUpQuestion,
  TerminologyExtraction,
  DocumentCoverageEval,
} from '@/ontology/schema/types';
import { STAGE_ORDER } from '@/ontology/schema/types';

import { DATASETS } from './data';
import { datasetToOntology } from './adapters';
import { normalizeOntologyObjects } from './normalize-objects';
import * as api from './api';
import type { RunStartInput, SampleCorpus, OntologySummary } from './api';

// ===========================================================================
// Public controller contract (THE FIXED FRONTEND CONTRACT — implemented EXACTLY).
// ===========================================================================

export interface OntologyRunController {
  mode: 'idle' | 'demo' | 'live' | 'swarm' | 'hyper';
  /** Working ontology (partial during a live run, complete in demo). */
  ontology: Ontology | null;
  /** Live pipeline run-state (stages + log). null in idle/demo. */
  run: OntologyRun | null;
  running: boolean;
  error: string | null;
  generated: GeneratedBundle[] | null;

  // ---- deep-swarm / hyper state (null on the fast/demo paths) ----
  /** Current high-level swarm/hyper phase. */
  phase: RunPhase | null;
  /** SME business-understanding brief, once produced. */
  businessBrief: BusinessBrief | null;
  /** Latest coverage/recall report, once produced. */
  coverageReport: CoverageReport | null;
  /** Follow-up questions, once produced. */
  followUpQuestions: FollowUpQuestion[] | null;
  /** Business terminology glossary (hyper mode only), once produced. */
  terminology: TerminologyExtraction | null;
  /** Latest sentence-level document-coverage eval (hyper mode only). */
  documentCoverage: DocumentCoverageEval | null;

  // ---- setup (InputScreen) ----
  startDemo: () => void;
  startUpload: (files: File[], opts?: { webSearch?: boolean }) => Promise<void>;
  startSample: (domain: DomainKey, opts?: { webSearch?: boolean }) => Promise<void>;
  /** Deep-swarm: start a multi-agent run from uploaded files OR a sample corpus. */
  startSwarm: (input: { files?: File[]; sample?: DomainKey; webSearch?: boolean }) => Promise<void>;
  /** Hyper-automation: start a full-coverage run from uploaded files OR a sample corpus. */
  startHyper: (input: { files?: File[]; sample?: DomainKey; webSearch?: boolean }) => Promise<void>;
  listSamples: () => Promise<{ domain: DomainKey; title: string; docCount: number }[]>;

  // ---- discover ----
  /** live: advance ONE stage (run.step); demo: no-op. */
  step: () => Promise<void>;

  // ---- review (Objects/Rules/Actions/Events/Processes screens) ----
  setReview: (kind: EntityKind, id: string, status: ReviewStatus) => void;
  /** Set one node's review status AND persist it (per-item Accept/Reject). */
  reviewOne: (kind: EntityKind, id: string, status: ReviewStatus) => Promise<void>;
  /** Accept every still-pending node of one layer in a single persisted write. */
  acceptAll: (kind: EntityKind) => Promise<void>;
  editEntity: (kind: EntityKind, id: string, patch: Record<string, unknown>) => void;
  /** Replace whole layers of the working ontology (JSON Editor). Synchronous via
   *  the ontology ref so a following save() persists the new layers. No-op when
   *  no ontology is loaded. */
  applyLayers: (
    layers: Partial<Pick<Ontology, 'objects' | 'rules' | 'actions' | 'events' | 'processes'>>,
  ) => void;
  mergeObjects: (keepId: string, mergeId: string) => void;
  reRunStage: (stage: Stage) => Promise<void>;

  // ---- persist (PublishScreen) ----
  /** Persist the working ontology. Resolves `true` on success, `false` if the
   *  save failed (the error is also surfaced on `error`); demo resolves `true`. */
  save: () => Promise<boolean>;
  publish: () => Promise<{ mirrored: boolean }>;
  reset: () => void;

  // ---- sessions (load / re-generate previously generated ontologies) ----
  /** List previously saved/generated ontology sessions (newest first). */
  listSaved: () => Promise<OntologySummary[]>;
  /** Load a saved session (latest, or a specific version) into the workspace. */
  loadSaved: (id: string, version?: number) => Promise<void>;
  /** Soft-delete a saved session. */
  deleteSaved: (id: string) => Promise<void>;
  /** Re-run the full extraction pipeline against the current ontology's sources. */
  regenerate: () => Promise<void>;
}

// ===========================================================================
// Internal helpers — entity-kind → ontology array seam.
// ===========================================================================

/** Map an EntityKind to the field on the Ontology that holds that node array. */
const KIND_TO_FIELD: Record<EntityKind, keyof Ontology> = {
  object: 'objects',
  rule: 'rules',
  action: 'actions',
  event: 'events',
  process: 'processes',
  relationship: 'relationships',
};

/** A node carries (at least) an id + reviewState — the shape every layer shares. */
interface ReviewableNode {
  id: string;
  reviewState: ReviewStatus;
  [key: string]: unknown;
}

/**
 * Immutably patch the node `id` inside the `kind` array of `o`, via `mutate`.
 * Returns a NEW Ontology when the node was found, else the same reference.
 */
function patchNode(
  o: Ontology,
  kind: EntityKind,
  id: string,
  mutate: (node: ReviewableNode) => ReviewableNode,
): Ontology {
  const field = KIND_TO_FIELD[kind];
  const arr = o[field] as unknown as ReviewableNode[] | undefined;
  if (!Array.isArray(arr)) return o;

  let touched = false;
  const next = arr.map((node) => {
    if (node.id !== id) return node;
    touched = true;
    return mutate(node);
  });
  if (!touched) return o;

  return { ...o, [field]: next } as Ontology;
}

/** Bump the working ontology's updatedAt so consumers see a fresh edit stamp. */
function touchUpdatedAt(o: Ontology): Ontology {
  return {
    ...o,
    metadata: { ...o.metadata, updatedAt: new Date().toISOString() },
  };
}

/** Best-effort local "generate" stub for DEMO mode (no backend round-trip). */
function demoGenerate(o: Ontology): GeneratedBundle[] {
  const summary =
    `Ontology "${o.name}" — ${o.objects.length} objects, ${o.rules.length} rules, ` +
    `${o.actions.length} actions, ${o.events.length} events, ${o.processes.length} processes.`;
  return [
    {
      target: 'manifest',
      files: [
        {
          path: `${o.id.replace(/^ontology:/, '')}.manifest.json`,
          language: 'json',
          content: JSON.stringify(
            { ontologyId: o.id, version: o.version, summary },
            null,
            2,
          ),
        },
      ],
      warnings: ['Demo mode — manifest generated locally, not by the backend.'],
    },
  ];
}

function errMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === 'string' ? cause : 'Unexpected error';
}

/**
 * Derive a human-readable name from the uploaded filenames so a fresh upload is
 * never seeded as the generic "Uploaded corpus / 上传语料" (which also collapsed
 * every upload onto the same ontology id). Filenames are language-neutral, so
 * en/zh share the slug; the backend upgrades this to a content-descriptive
 * bilingual title once extraction completes (the run carries `autoName`).
 */
function deriveCorpusName(files: File[]): Bilingual {
  const prettify = (filename: string): string =>
    filename
      .replace(/\.[^./\\]+$/, '') // strip extension
      .replace(/[_\-]+/g, ' ') // separators → spaces
      .replace(/\s+/g, ' ')
      .trim();
  const first = files.length > 0 ? prettify(files[0]!.name) : '';
  if (!first) return { en: 'Uploaded corpus', zh: '上传语料' };
  const label = files.length > 1 ? `${first} +${files.length - 1}` : first;
  return { en: label, zh: label };
}

/**
 * Synthesize an already-complete run for a LOADED ontology so the stepper
 * unlocks every review/graph/publish step (the container derives "done" marks
 * and `canVisit` gating from `run.stages`). A loaded session has no live
 * pipeline, so we mark all stages complete with their layer counts.
 */
function completedRunFor(o: Ontology): OntologyRun {
  const at = o.metadata?.updatedAt ?? new Date().toISOString();
  const counts: Record<Stage, number> = {
    objects: o.objects.length,
    rules: o.rules.length,
    actions: o.actions.length,
    events: o.events.length,
    processes: o.processes.length,
  };
  // Recover the extraction mode from the metadata artifacts the run left behind
  // (hyper checked first — a hyper run also carries the swarm artifacts).
  const mode: OntologyRun['mode'] =
    o.metadata?.hyper || o.metadata?.documentCoverage
      ? 'hyper'
      : o.metadata?.businessBrief
        ? 'swarm'
        : 'fast';
  return {
    id: o.metadata?.generation?.runId ?? `run:loaded:${o.id}`,
    ontologyId: o.id,
    status: 'complete',
    currentStage: null,
    stages: STAGE_ORDER.map(
      (stage): StageProgress => ({ stage, status: 'complete', count: counts[stage] }),
    ),
    log: [],
    createdAt: o.metadata?.createdAt ?? at,
    updatedAt: at,
    mode,
  };
}

// ===========================================================================
// Hook
// ===========================================================================

export function useOntologyRun(): OntologyRunController {
  const [mode, setMode] = useState<OntologyRunController['mode']>('idle');
  const [ontology, setOntology] = useState<Ontology | null>(null);
  const [run, setRun] = useState<OntologyRun | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<GeneratedBundle[] | null>(null);
  const [phase, setPhase] = useState<RunPhase | null>(null);
  const [businessBrief, setBusinessBrief] = useState<BusinessBrief | null>(null);
  const [coverageReport, setCoverageReport] = useState<CoverageReport | null>(null);
  const [followUpQuestions, setFollowUpQuestions] = useState<FollowUpQuestion[] | null>(null);
  const [terminology, setTerminology] = useState<TerminologyExtraction | null>(null);
  const [documentCoverage, setDocumentCoverage] = useState<DocumentCoverageEval | null>(null);

  // The authoritative, always-current working ontology. React's `ontology`
  // state is one render behind inside an event handler, so a mutation followed
  // by an immediate `save()` (e.g. Accept → persist) would otherwise persist the
  // PRE-mutation value (stale closure) and then overwrite the optimistic update
  // — making review actions silently revert. Every write goes through
  // `commitOntology`, which updates this ref SYNCHRONOUSLY alongside the state,
  // so `save`/`publish`/`reRunStage`/`acceptAll` always read the freshest model.
  const ontologyRef = useRef<Ontology | null>(null);
  const commitOntology = useCallback((next: Ontology | null) => {
    // Normalize legacy `attributes`-shaped objects to the spec `properties` shape
    // on the way in (idempotent), so every screen + the JSON editor see one shape
    // even when an OLD stored ontology is reopened.
    const normalized = next ? normalizeOntologyObjects(next) : null;
    ontologyRef.current = normalized;
    setOntology(normalized);
  }, []);

  // ---- setup ---------------------------------------------------------------

  const startDemo = useCallback(() => {
    setError(null);
    setRun(null);
    setGenerated(null);
    setMode('demo');
    commitOntology(datasetToOntology(DATASETS.commerce));
  }, []);

  const startUpload = useCallback(async (files: File[], opts?: { webSearch?: boolean }) => {
    setError(null);
    setRunning(true);
    setGenerated(null);
    try {
      const { sources, parsedRefs } = await api.uploadDocs(files);
      // run.start resolves sources via store.getParsed(id), which is keyed by
      // parsedRef — so pass the parsedRefs (NOT the SourceDocument ids).
      const sourceIds = parsedRefs.length > 0 ? parsedRefs : sources.map((s) => s.parsedRef).filter((r): r is string => !!r);
      const input: RunStartInput = {
        name: deriveCorpusName(files),
        sourceIds,
        autoName: true,
        webSearch: opts?.webSearch,
      };
      const { ontology: o, run: r } = await api.runStart(input);
      setMode('live');
      commitOntology(o);
      setRun(r);
    } catch (cause) {
      setError(errMessage(cause));
      throw cause instanceof Error ? cause : new Error(errMessage(cause));
    } finally {
      setRunning(false);
    }
  }, []);

  const startSample = useCallback(async (domain: DomainKey, opts?: { webSearch?: boolean }) => {
    setError(null);
    setRunning(true);
    setGenerated(null);
    try {
      const samples = await api.listSamples();
      const match: SampleCorpus | undefined =
        samples.find((s) => s.domain === domain) ?? samples[0];
      if (!match) {
        throw new Error('No sample corpus available for the requested domain.');
      }
      const input: RunStartInput = {
        name: { en: match.label.en, zh: match.label.zh },
        sampleId: match.id,
        webSearch: opts?.webSearch,
      };
      const { ontology: o, run: r } = await api.runStart(input);
      setMode('live');
      commitOntology(o);
      setRun(r);
    } catch (cause) {
      setError(errMessage(cause));
      throw cause instanceof Error ? cause : new Error(errMessage(cause));
    } finally {
      setRunning(false);
    }
  }, []);

  const startSwarm = useCallback(async (input: { files?: File[]; sample?: DomainKey; webSearch?: boolean }) => {
    setError(null);
    setRunning(true);
    setGenerated(null);
    setPhase(null);
    setBusinessBrief(null);
    setCoverageReport(null);
    setFollowUpQuestions(null);
    setTerminology(null);
    setDocumentCoverage(null);
    try {
      let runInput: RunStartInput;
      if (input.files && input.files.length > 0) {
        const { sources, parsedRefs } = await api.uploadDocs(input.files);
        const sourceIds = parsedRefs.length > 0 ? parsedRefs : sources.map((s) => s.parsedRef).filter((r): r is string => !!r);
        runInput = { name: deriveCorpusName(input.files), sourceIds, autoName: true, webSearch: input.webSearch };
      } else if (input.sample) {
        const samples = await api.listSamples();
        const match: SampleCorpus | undefined = samples.find((s) => s.domain === input.sample) ?? samples[0];
        if (!match) throw new Error('No sample corpus available for the requested domain.');
        runInput = { name: { en: match.label.en, zh: match.label.zh }, sampleId: match.id, webSearch: input.webSearch };
      } else {
        throw new Error('startSwarm requires files or a sample.');
      }
      const { ontology: o, run: r } = await api.runSwarmStart(runInput);
      setMode('swarm');
      commitOntology(o);
      setRun(r);
    } catch (cause) {
      setError(errMessage(cause));
      throw cause instanceof Error ? cause : new Error(errMessage(cause));
    } finally {
      setRunning(false);
    }
  }, []);

  const startHyper = useCallback(async (input: { files?: File[]; sample?: DomainKey; webSearch?: boolean }) => {
    setError(null);
    setRunning(true);
    setGenerated(null);
    setPhase(null);
    setBusinessBrief(null);
    setCoverageReport(null);
    setFollowUpQuestions(null);
    setTerminology(null);
    setDocumentCoverage(null);
    try {
      let runInput: RunStartInput;
      if (input.files && input.files.length > 0) {
        const { sources, parsedRefs } = await api.uploadDocs(input.files);
        const sourceIds = parsedRefs.length > 0 ? parsedRefs : sources.map((s) => s.parsedRef).filter((r): r is string => !!r);
        runInput = { name: deriveCorpusName(input.files), sourceIds, autoName: true, webSearch: input.webSearch };
      } else if (input.sample) {
        const samples = await api.listSamples();
        const match: SampleCorpus | undefined = samples.find((s) => s.domain === input.sample) ?? samples[0];
        if (!match) throw new Error('No sample corpus available for the requested domain.');
        runInput = { name: { en: match.label.en, zh: match.label.zh }, sampleId: match.id, webSearch: input.webSearch };
      } else {
        throw new Error('startHyper requires files or a sample.');
      }
      const { ontology: o, run: r } = await api.startHyperRun(runInput);
      setMode('hyper');
      commitOntology(o);
      setRun(r);
    } catch (cause) {
      setError(errMessage(cause));
      throw cause instanceof Error ? cause : new Error(errMessage(cause));
    } finally {
      setRunning(false);
    }
  }, []);

  const listSamples = useCallback(async () => {
    const samples = await api.listSamples();
    return samples.map((s) => ({
      domain: s.domain,
      title: s.label.en,
      docCount: s.docNames.length,
    }));
  }, []);

  // ---- discover ------------------------------------------------------------

  const stepInner = useCallback(async () => {
    // Deep-swarm / hyper: advance ONE sub-step and merge its artifacts. The
    // hyper step result is a superset of the swarm one (+ terminology +
    // documentCoverage), so both routes merge through the same shape.
    if (mode === 'swarm' || mode === 'hyper') {
      if (!run || run.status === 'complete' || run.status === 'error') return;
      setError(null);
      setRunning(true);
      try {
        const res: api.HyperStepResult =
          mode === 'hyper' ? await api.stepHyperRun(run.id) : await api.runSwarmStep(run.id);
        setRun(res.run);
        setPhase(res.phase);
        if (res.businessBrief) setBusinessBrief(res.businessBrief);
        if (res.coverageReport) setCoverageReport(res.coverageReport);
        if (res.followUpQuestions) setFollowUpQuestions(res.followUpQuestions);
        if (res.terminology) setTerminology(res.terminology);
        if (res.documentCoverage) setDocumentCoverage(res.documentCoverage);
        if (res.run.status === 'complete') {
          try {
            const saved = await api.saveOntology(
              res.ontology,
              mode === 'hyper' ? 'Auto-saved on hyper completion' : 'Auto-saved on swarm completion',
            );
            commitOntology(saved);
          } catch {
            commitOntology(res.ontology);
          }
        } else {
          commitOntology(res.ontology);
        }
      } catch (cause) {
        setError(errMessage(cause));
      } finally {
        setRunning(false);
      }
      return;
    }

    // Demo runs are pre-assembled — advancing a stage is a no-op.
    if (mode !== 'live' || !run) return;
    if (run.status === 'complete' || run.status === 'error') return;

    setError(null);
    setRunning(true);
    try {
      const { ontology: o, run: r } = await api.runStep(run.id);
      setRun(r);
      if (r.status === 'complete') {
        // Auto-save on finish: persist the generated ontology so it lands as a
        // local JSON file and shows up under "previous sessions".
        try {
          const saved = await api.saveOntology(o, 'Auto-saved on completion');
          commitOntology(saved);
        } catch {
          commitOntology(o); // persistence failed — keep the freshly generated draft
        }
      } else {
        commitOntology(o);
      }
    } catch (cause) {
      setError(errMessage(cause));
    } finally {
      setRunning(false);
    }
  }, [mode, run]);

  // In-flight guard: the `running` state lives in the same closure, so two
  // synchronous invocations (e.g. a StrictMode double-fired auto-step effect)
  // would both pass a state check and issue concurrent step requests against
  // the same run. A ref flips synchronously and blocks the second call.
  const stepInFlight = useRef(false);
  const step = useCallback(async () => {
    if (stepInFlight.current) return;
    stepInFlight.current = true;
    try {
      await stepInner();
    } finally {
      stepInFlight.current = false;
    }
  }, [stepInner]);

  // ---- review --------------------------------------------------------------

  const setReview = useCallback(
    (kind: EntityKind, id: string, status: ReviewStatus) => {
      const current = ontologyRef.current;
      if (!current) return;
      const next = patchNode(current, kind, id, (node) => ({ ...node, reviewState: status }));
      if (next === current) return;
      commitOntology(touchUpdatedAt(next));
    },
    [commitOntology],
  );

  const editEntity = useCallback(
    (kind: EntityKind, id: string, patch: Record<string, unknown>) => {
      const current = ontologyRef.current;
      if (!current) return;
      const next = patchNode(current, kind, id, (node) => ({
        ...node,
        ...patch,
        // A human edit flips an untouched node to 'edited' (accepts explicit override).
        reviewState:
          (patch.reviewState as ReviewStatus | undefined) ??
          (node.reviewState === 'pending' ? 'edited' : node.reviewState),
      }));
      if (next === current) return;
      commitOntology(touchUpdatedAt(next));
    },
    [commitOntology],
  );

  const applyLayers = useCallback(
    (layers: Partial<Pick<Ontology, 'objects' | 'rules' | 'actions' | 'events' | 'processes'>>) => {
      const current = ontologyRef.current;
      if (!current) return;
      commitOntology(touchUpdatedAt({ ...current, ...layers }));
    },
    [commitOntology],
  );

  const mergeObjects = useCallback(
    (keepId: string, mergeId: string) => {
      if (keepId === mergeId) return;
      const current = ontologyRef.current;
      if (!current) return;

      const merged = current.objects.find((o) => o.id === mergeId);
      const keeper = current.objects.find((o) => o.id === keepId);
      if (!merged || !keeper) return;

      // 1. Mark the absorbed object 'merged' and record the keeper as its origin,
      //    then drop it from the active objects list.
      const mergedDerived = Array.from(
        new Set([...(merged.derivedFrom ?? []), keepId]),
      );
      const keeperDerived = Array.from(
        new Set([...(keeper.derivedFrom ?? []), mergeId]),
      );

      const objects = current.objects
        .filter((o) => o.id !== mergeId)
        .map((o) =>
          o.id === keepId
            ? { ...o, provenance: 'merged' as const, derivedFrom: keeperDerived }
            : o,
        );
      void mergedDerived;

      // 2. Repoint every cross-reference to the absorbed id onto the keeper.
      const relationships = current.relationships.map((r) => ({
        ...r,
        sourceObjectTypeId: r.sourceObjectTypeId === mergeId ? keepId : r.sourceObjectTypeId,
        targetObjectTypeId: r.targetObjectTypeId === mergeId ? keepId : r.targetObjectTypeId,
      }));

      const repointId = (refId: string) => (refId === mergeId ? keepId : refId);

      const rules = current.rules.map((rule) => ({
        ...rule,
        appliesToObjectTypeIds: rule.appliesToObjectTypeIds.map(repointId),
      }));

      const next: Ontology = {
        ...current,
        objects,
        relationships,
        rules,
      };
      commitOntology(touchUpdatedAt(next));
    },
    [commitOntology],
  );

  /**
   * Bulk-accept every still-pending (and 'edited') node of one layer in a single
   * write. Already-rejected nodes are left untouched; already-accepted ones are
   * no-ops. Persists ONCE (live/swarm/hyper) so a whole layer is confirmed
   * without N version bumps; demo stays optimistic/offline.
   */
  const acceptAll = useCallback(
    async (kind: EntityKind) => {
      const current = ontologyRef.current;
      if (!current) return;
      const field = KIND_TO_FIELD[kind];
      const arr = current[field] as unknown as ReviewableNode[] | undefined;
      if (!Array.isArray(arr)) return;
      let changed = false;
      const nextArr = arr.map((node) => {
        if (node.reviewState === 'accepted' || node.reviewState === 'rejected') return node;
        changed = true;
        return { ...node, reviewState: 'accepted' as ReviewStatus };
      });
      if (!changed) return;
      const updated = touchUpdatedAt({ ...current, [field]: nextArr } as Ontology);
      commitOntology(updated);
      if (mode === 'demo') return; // offline — optimistic only
      setError(null);
      setRunning(true);
      try {
        const saved = await api.saveOntology(updated, `Accepted all ${field}`);
        commitOntology(saved);
      } catch (cause) {
        setError(errMessage(cause));
      } finally {
        setRunning(false);
      }
    },
    [mode, commitOntology],
  );

  const reRunStage = useCallback(
    async (stage: Stage) => {
      if (mode !== 'live' && mode !== 'swarm' && mode !== 'hyper') return; // demo stages are fixed
      const current = ontologyRef.current;
      if (!current) return;
      setError(null);
      setRunning(true);
      try {
        // Re-run this stage against the CURRENT draft, then merge its fresh items
        // back into the latest model (a parallel edit may have landed meanwhile).
        const result = await api.reRunStage(current, stage);
        const latest = ontologyRef.current ?? current;
        const field = KIND_TO_FIELD[stage as unknown as EntityKind] ?? stage;
        commitOntology(touchUpdatedAt({ ...latest, [field]: result.items } as Ontology));
      } catch (cause) {
        setError(errMessage(cause));
      } finally {
        setRunning(false);
      }
    },
    [mode, commitOntology],
  );

  // ---- persist -------------------------------------------------------------

  const save = useCallback(async (): Promise<boolean> => {
    // Read the freshest model from the ref, NOT the closure `ontology` (which is
    // a render behind a just-applied review/edit) — otherwise an Accept→save
    // would persist the pre-Accept state and the change would silently revert.
    const current = ontologyRef.current;
    if (!current) return false;
    if (mode === 'demo') return true; // demo is offline — treat as a no-op success
    setError(null);
    setRunning(true);
    try {
      const saved = await api.saveOntology(current, 'Reviewed via Ontology Generator');
      commitOntology(saved);
      return true;
    } catch (cause) {
      setError(errMessage(cause));
      return false; // surface failure so callers don't claim "Saved"
    } finally {
      setRunning(false);
    }
  }, [mode, commitOntology]);

  /** Optimistically set one node's review status AND persist it (live/swarm/
   *  hyper). Used by the per-item Accept/Reject buttons so a single decision
   *  sticks to disk; demo stays offline. */
  const reviewOne = useCallback(
    async (kind: EntityKind, id: string, status: ReviewStatus) => {
      setReview(kind, id, status);
      await save();
    },
    [setReview, save],
  );

  const publish = useCallback(async (): Promise<{ mirrored: boolean }> => {
    const current = ontologyRef.current;
    if (!current) return { mirrored: false };

    if (mode === 'demo') {
      // Offline publish — flip to published locally + locally-computed bundles.
      const published: Ontology = touchUpdatedAt({
        ...current,
        status: 'published',
        metadata: { ...current.metadata, publishedAt: new Date().toISOString() },
      });
      commitOntology(published);
      setGenerated(demoGenerate(published));
      return { mirrored: false };
    }

    setError(null);
    setRunning(true);
    try {
      const { ontology: pub, neo4j } = await api.publishOntology(current.id, current.version);
      commitOntology(pub);
      const bundles = await api.generate(pub.id, 'all', pub.version);
      setGenerated(Array.isArray(bundles) ? bundles : [bundles]);
      return { mirrored: neo4j.mirrored };
    } catch (cause) {
      setError(errMessage(cause));
      return { mirrored: false };
    } finally {
      setRunning(false);
    }
  }, [mode, commitOntology]);

  const reset = useCallback(() => {
    setMode('idle');
    commitOntology(null);
    setRun(null);
    setRunning(false);
    setError(null);
    setGenerated(null);
    setPhase(null);
    setBusinessBrief(null);
    setCoverageReport(null);
    setFollowUpQuestions(null);
    setTerminology(null);
    setDocumentCoverage(null);
  }, []);

  // ---- sessions ------------------------------------------------------------

  const listSaved = useCallback(() => api.listOntologies(), []);

  const loadSaved = useCallback(async (id: string, version?: number) => {
    setError(null);
    setRunning(true);
    setGenerated(null);
    try {
      const o = await api.getOntology(id, version);
      // A stored ontology carrying hyper artifacts (provenance or a document-
      // coverage eval) was produced by hyper automation — check that FIRST,
      // since a hyper run also leaves the swarm artifacts behind. A swarm-only
      // ontology carries a businessBrief. Reopen in the producing mode so the
      // brief/coverage/questions steps appear.
      const isHyper = Boolean(o.metadata?.hyper || o.metadata?.documentCoverage);
      const isSwarm = Boolean(o.metadata?.businessBrief);
      setMode(isHyper ? 'hyper' : isSwarm ? 'swarm' : 'live');
      commitOntology(o);
      // No live pipeline for a stored snapshot — synthesize a complete run so the
      // stepper unlocks every step (the container jumps straight to the graph).
      setRun(completedRunFor(o));
      setBusinessBrief(o.metadata?.businessBrief ?? null);
      setCoverageReport(o.metadata?.coverageReport ?? null);
      setFollowUpQuestions(o.metadata?.followUpQuestions ?? null);
      setTerminology(o.metadata?.terminology ?? null);
      setDocumentCoverage(o.metadata?.documentCoverage ?? null);
      setPhase(isHyper || isSwarm ? 'follow_up' : null);
    } catch (cause) {
      setError(errMessage(cause));
      throw cause instanceof Error ? cause : new Error(errMessage(cause));
    } finally {
      setRunning(false);
    }
  }, []);

  const deleteSaved = useCallback(async (id: string) => {
    await api.deleteOntology(id);
  }, []);

  const regenerate = useCallback(async () => {
    const current = ontologyRef.current;
    if (!current) return;
    if (mode === 'demo') {
      // Demo has no backend sources — just re-seed the canned ontology.
      startDemo();
      return;
    }
    const sourceIds = current.sourceDocuments
      .map((s) => s.parsedRef)
      .filter((r): r is string => typeof r === 'string' && r.length > 0);
    if (sourceIds.length === 0) {
      // Original sources are no longer available to re-run — fall back to a
      // clean Input screen so the user can re-pick a source.
      reset();
      return;
    }
    setError(null);
    setRunning(true);
    setGenerated(null);
    try {
      const input: RunStartInput = {
        name: { en: current.name, zh: current.nameZh ?? current.name },
        sourceIds,
      };
      const { ontology: o, run: r } = await api.runStart(input);
      setMode('live');
      commitOntology(o);
      setRun(r);
    } catch (cause) {
      setError(errMessage(cause));
    } finally {
      setRunning(false);
    }
  }, [mode, startDemo, reset]);

  return useMemo<OntologyRunController>(
    () => ({
      mode,
      ontology,
      run,
      running,
      error,
      generated,
      phase,
      businessBrief,
      coverageReport,
      followUpQuestions,
      terminology,
      documentCoverage,
      startDemo,
      startUpload,
      startSample,
      startSwarm,
      startHyper,
      listSamples,
      step,
      setReview,
      reviewOne,
      acceptAll,
      editEntity,
      applyLayers,
      mergeObjects,
      reRunStage,
      save,
      publish,
      reset,
      listSaved,
      loadSaved,
      deleteSaved,
      regenerate,
    }),
    [
      mode,
      ontology,
      run,
      running,
      error,
      generated,
      phase,
      businessBrief,
      coverageReport,
      followUpQuestions,
      terminology,
      documentCoverage,
      startDemo,
      startUpload,
      startSample,
      startSwarm,
      startHyper,
      listSamples,
      step,
      setReview,
      reviewOne,
      acceptAll,
      editEntity,
      applyLayers,
      mergeObjects,
      reRunStage,
      save,
      publish,
      reset,
      listSaved,
      loadSaved,
      deleteSaved,
      regenerate,
    ],
  );
}
