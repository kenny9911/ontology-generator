// Root of the Ontology Generator — a THIN container. It owns the page-local
// presentation state (lang, theme, graph-layout, active step) and binds the ONE
// run/review controller hook (`useOntologyRun`). Every screen receives the same
// fixed contract — `t={tx} lang={lang} ctrl={ctrl}` — and reads/mutates the
// canonical Ontology through `ctrl` (the demo `dataset` + `accepted` boolean map
// are retired). See DESIGN_SPEC §8.3 + design-notes/frontend.md.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import './ontology-generator.css';
import type { Lang } from './data';
import { useT, type StepId } from './i18n';
import TopBar, { STEP_ORDER, stepOrderFor, isThemeName, type ThemeName, type LayoutMode } from './TopBar';
import type { Stage } from '@/ontology/schema/types';
import { useOntologyRun } from './useOntologyRun';
import InputScreen from './InputScreen';
import DiscoverScreen from './DiscoverScreen';
import ObjectsScreen from './ObjectsScreen';
import RulesScreen from './RulesScreen';
import ActionsScreen from './ActionsScreen';
import EventsScreen from './EventsScreen';
import ProcessesScreen from './ProcessesScreen';
import GraphScreen from './GraphScreen';
import PublishScreen from './PublishScreen';
import BusinessUnderstandingScreen from './BusinessUnderstandingScreen';
import CoverageScreen from './CoverageScreen';
import FollowUpQuestionsScreen from './FollowUpQuestionsScreen';
import LLMSettingsScreen from './LLMSettingsScreen';
// Lazy-loaded: the JSON editor statically pulls in Monaco (~the VS Code engine),
// so it ships as its own chunk that only downloads when the user opens it.
const JsonEditorScreen = lazy(() => import('./JsonEditorScreen'));
import ThinkingPanel from './ThinkingPanel';

/** Review steps that map 1:1 onto a pipeline {@link Stage}. */
const STAGE_STEPS: Partial<Record<StepId, Stage>> = {
  objects: 'objects',
  rules: 'rules',
  actions: 'actions',
  events: 'events',
  processes: 'processes',
};

const THEME_STORAGE_KEY = 'ontogen_theme';

/** Initial theme: a previously-saved choice wins; otherwise honor the OS
 *  `prefers-color-scheme` (light → the allmeta light theme, else the `lumen`
 *  dark default). SSR/private-mode safe — any access failure falls back to
 *  `lumen`. */
function initialTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeName(saved)) return saved;
  } catch { /* localStorage blocked — fall through */ }
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
  } catch { /* matchMedia unavailable — fall through */ }
  return 'lumen';
}

export default function OntologyGenerator() {
  const [lang, setLang] = useState<Lang>('zh');
  const [theme, setTheme] = useState<ThemeName>(initialTheme);
  const [graphLayout, setGraphLayout] = useState<LayoutMode>('force');
  const [step, setStep] = useState<StepId>('input');
  // Thinking & activity panel — a right-docked window the user can toggle from
  // the top bar. It auto-opens when a fresh (non-complete) run starts.
  const [logOpen, setLogOpen] = useState(false);

  const tx = useT(lang);
  const ctrl = useOntologyRun();

  // Persist the theme choice so it survives reloads (and overrides the
  // OS-preference default on the next visit).
  useEffect(() => {
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* storage blocked — ignore */ }
  }, [theme]);

  // A run/ontology exists once setup has fired (demo seeds it synchronously;
  // live seeds a draft on runStart). Until then, only `input` is reachable.
  const hasRun = ctrl.mode !== 'idle' && ctrl.ontology != null;

  // Derive stepper "done" marks from the live run's stage progress (demo marks
  // every stage done since the ontology is fully assembled up front).
  const completed = useMemo<Partial<Record<StepId, boolean>>>(() => {
    const done: Partial<Record<StepId, boolean>> = {};
    if (!hasRun) return done;
    done.input = true;

    if (ctrl.mode === 'demo') {
      done.discover = true;
      for (const s of STEP_ORDER) done[s] = true;
      done.publish = ctrl.ontology?.status === 'published';
      return done;
    }

    // live: a review step is "done" once its stage has finished extracting.
    const stages = ctrl.run?.stages ?? [];
    let allStagesComplete = stages.length > 0;
    for (const [stepId, stage] of Object.entries(STAGE_STEPS) as [StepId, Stage][]) {
      const sp = stages.find((p) => p.stage === stage);
      const finished = sp?.status === 'complete';
      done[stepId] = finished;
      if (!finished) allStagesComplete = false;
    }
    done.discover = ctrl.run?.status === 'complete' || allStagesComplete;
    done.graph = done.discover;
    done.publish = ctrl.ontology?.status === 'published';
    if (ctrl.mode === 'swarm' || ctrl.mode === 'hyper') {
      done.brief = ctrl.businessBrief != null;
      done.coverage = ctrl.coverageReport != null || ctrl.documentCoverage != null;
      done.questions = ctrl.followUpQuestions != null;
    }
    return done;
  }, [hasRun, ctrl.mode, ctrl.run, ctrl.ontology, ctrl.businessBrief, ctrl.coverageReport, ctrl.documentCoverage, ctrl.followUpQuestions]);

  // Gate navigation: `input` and `settings` always (the LLM settings page needs
  // no run); everything else only once a run exists. For a live run, a stage's
  // review screen unlocks once that stage produced items (its StageProgress has
  // a count) — demo unlocks everything.
  function canVisit(target: StepId): boolean {
    // input / settings / editor are always reachable — the JSON editor carries
    // its own historical-ontology picker, so it works with or without a run.
    if (target === 'input' || target === 'settings' || target === 'editor') return true;
    if (!hasRun) return false;
    if (ctrl.mode === 'demo') return true;

    if (ctrl.mode === 'swarm' || ctrl.mode === 'hyper') {
      if (target === 'brief') return ctrl.businessBrief != null;
      if (target === 'coverage') return ctrl.coverageReport != null || ctrl.documentCoverage != null;
      if (target === 'questions') return ctrl.followUpQuestions != null;
    }

    const stage = STAGE_STEPS[target];
    if (stage) {
      const sp = ctrl.run?.stages.find((p) => p.stage === stage);
      return (sp?.count ?? 0) > 0 || sp?.status === 'complete';
    }
    // discover / graph / publish — reachable whenever a live run exists.
    return true;
  }

  function go(target: StepId) {
    if (canVisit(target)) setStep(target);
  }

  // When the controller is reset (PublishScreen → ctrl.reset()), snap the
  // stepper back to `input` so the page returns to its empty setup state.
  // `settings` is exempt — it is reachable at any time, run or no run.
  useEffect(() => {
    if (!hasRun && step !== 'input' && step !== 'settings' && step !== 'editor') setStep('input');
  }, [hasRun, step]);

  // On setup (InputScreen → startDemo/startUpload/startSample/loadSaved), a
  // run/ontology appears; advance the stepper from `input`. A freshly started
  // run (or the demo tour) goes to `discover` to watch extraction; a LOADED
  // session arrives already complete, so jump straight to the graph
  // (DESIGN_SPEC §8.5). The hasRun false→true TRANSITION is tracked via a ref
  // so the jump also fires when a session is loaded from the `settings` screen
  // (LLM settings is reachable with no run) — while never yanking a user who
  // merely browses settings during an already-active run.
  const hadRun = useRef(false);
  useEffect(() => {
    const appeared = hasRun && !hadRun.current;
    hadRun.current = hasRun;
    if (appeared && (step === 'input' || step === 'settings')) {
      const loadedComplete = (ctrl.mode === 'live' || ctrl.mode === 'swarm' || ctrl.mode === 'hyper') && ctrl.run?.status === 'complete';
      setStep(loadedComplete ? 'graph' : 'discover');
    }
  }, [hasRun, step, ctrl.mode, ctrl.run]);

  // Auto-open the thinking panel whenever a NEW, still-running run appears (a
  // fresh generation) so the user sees the AI work; loaded/complete runs don't
  // pop it open. Tracked off the run id so closing it stays sticky until the
  // next run starts.
  const prevRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = ctrl.run?.id ?? null;
    if (id && id !== prevRunIdRef.current && ctrl.run?.status !== 'complete') {
      setLogOpen(true);
    }
    prevRunIdRef.current = id;
  }, [ctrl.run?.id, ctrl.run?.status]);

  // Screens are locked to the { t, lang, ctrl } prop contract — they carry no
  // navigation callback. To let one request a step change (DiscoverScreen's
  // "See results →" → Objects), they dispatch a window `ontogen:goto` event
  // whose detail is the target StepId; the container honors it through `go`
  // (which still applies the same `canVisit` gating).
  useEffect(() => {
    function onGoto(e: Event) {
      const target = (e as CustomEvent<StepId>).detail;
      if (target) go(target);
    }
    window.addEventListener('ontogen:goto', onGoto as EventListener);
    return () => window.removeEventListener('ontogen:goto', onGoto as EventListener);
    // Re-subscribe when the gating inputs change so `go`/`canVisit` see fresh state.
  }, [hasRun, ctrl.mode, ctrl.run, ctrl.businessBrief, ctrl.coverageReport, ctrl.documentCoverage, ctrl.followUpQuestions]);

  return (
    <div className="ontogen" data-theme={theme} data-density="regular">
      <TopBar
        step={step}
        setStep={go}
        steps={stepOrderFor(ctrl.mode)}
        onHome={ctrl.reset}
        ctrl={ctrl}
        t={tx}
        lang={lang}
        completed={completed}
        theme={theme}
        setTheme={setTheme}
        setLang={setLang}
        layout={graphLayout}
        setLayout={setGraphLayout}
        showLog={ctrl.run != null}
        logOpen={logOpen}
        onToggleLog={() => setLogOpen((o) => !o)}
        logLive={ctrl.running || ctrl.run?.status === 'running'}
      />
      <main className="viewport">
        {step === 'input' && <InputScreen t={tx} lang={lang} ctrl={ctrl} />}
        {step === 'discover' && <DiscoverScreen t={tx} lang={lang} ctrl={ctrl} />}
        {step === 'brief' && <BusinessUnderstandingScreen t={tx} lang={lang} ctrl={ctrl} />}
        {step === 'objects' && <ObjectsScreen t={tx} lang={lang} ctrl={ctrl} />}
        {step === 'rules' && <RulesScreen t={tx} lang={lang} ctrl={ctrl} />}
        {step === 'actions' && <ActionsScreen t={tx} lang={lang} ctrl={ctrl} />}
        {step === 'events' && <EventsScreen t={tx} lang={lang} ctrl={ctrl} />}
        {step === 'processes' && <ProcessesScreen t={tx} lang={lang} ctrl={ctrl} />}
        {step === 'coverage' && <CoverageScreen t={tx} lang={lang} ctrl={ctrl} />}
        {step === 'questions' && <FollowUpQuestionsScreen t={tx} lang={lang} ctrl={ctrl} />}
        {step === 'graph' && <GraphScreen t={tx} lang={lang} ctrl={ctrl} layout={graphLayout} />}
        {step === 'publish' && <PublishScreen t={tx} lang={lang} ctrl={ctrl} />}
        {step === 'editor' && (
          <Suspense
            fallback={
              <div className="screen" style={{ display: 'grid', placeItems: 'center', color: 'var(--fg-4)' }}>
                {lang === 'zh' ? '正在加载编辑器…' : 'Loading editor…'}
              </div>
            }
          >
            <JsonEditorScreen t={tx} lang={lang} ctrl={ctrl} />
          </Suspense>
        )}
        {step === 'settings' && <LLMSettingsScreen t={tx} lang={lang} ctrl={ctrl} />}
      </main>
      {ctrl.run && (
        <ThinkingPanel
          open={logOpen}
          onClose={() => setLogOpen(false)}
          run={ctrl.run}
          running={ctrl.running || ctrl.run.status === 'running'}
          t={tx}
          lang={lang}
        />
      )}
    </div>
  );
}
