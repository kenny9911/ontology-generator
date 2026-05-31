// Discover screen — the AI magic moment, now driven by the ONE controller.
//
//   LIVE  (ctrl.mode === 'live')  — loops ctrl.step() until the run reports
//       status 'complete' (or 'error'), rendering ctrl.run.stages[].count as the
//       live counters and ctrl.run.log[] as the streaming log. The phase bar
//       runs parse → objects → rules → actions → events → processes, tracked off
//       the run's stage progress. The emerging graph grows from the partial
//       ctrl.ontology.objects as each stage lands.
//
//   DEMO  (ctrl.mode === 'demo') — plays the existing canned discovery script
//       (buildDiscoveryScript) so the offline tour still animates exactly as
//       before. ctrl.step() is a no-op in demo, so we never call it here.
//
//   "See results →" appears once discovery is done and routes to the Objects
//   step. Navigation flows through the container, which owns the stepper; the
//   locked screen contract is { t, lang, ctrl } (no nav callback), so we ask the
//   container to advance via a window CustomEvent ('ontogen:goto') it listens for.
//
// Visual system preserved verbatim from the original: SourceStream, EmergingGraph,
// Counter, AiShimmer, the phase bar, and the column-reverse streaming log. Only
// the data SOURCE behind them changed (controller vs. local script).
//
// Compiles under strict / noUnusedLocals / noUnusedParameters; no `any`.
import { useState, useEffect, useRef, useMemo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { buildDiscoveryScript, DATASETS } from './data';
import type { Dataset, Lang, OntObject, DiscoveryEvent, DiscoveryScript } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import type { ObjectType, Stage } from '@/ontology/schema/types';

interface DiscoverScreenProps {
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
}

/** Ask the container (which owns the stepper) to advance to another step. */
function gotoStep(target: 'objects'): void {
  window.dispatchEvent(new CustomEvent('ontogen:goto', { detail: target }));
}

export default function DiscoverScreen({ t, lang, ctrl }: DiscoverScreenProps) {
  if (ctrl.mode === 'live') {
    return <LiveDiscover t={t} lang={lang} ctrl={ctrl} />;
  }
  return <DemoDiscover t={t} lang={lang} ctrl={ctrl} />;
}

// ===========================================================================
//  Phase model — shared shape both modes render through the phase bar.
// ===========================================================================

interface PhaseDef {
  id: string;
  label: string;
  /** Flex weight of this segment in the bar. */
  frac: number;
}

// ===========================================================================
//  LIVE — loop ctrl.step() until complete; counters/log/graph off run + ontology.
// ===========================================================================

/** The live phase bar: a synthetic `parse` segment + one per STAGE_ORDER stage. */
function livePhases(t: Strings): PhaseDef[] {
  return [
    { id: 'parse', label: t.phaseParse, frac: 0.12 },
    { id: 'objects', label: t.phaseEntity, frac: 0.22 },
    { id: 'rules', label: t.phaseRule, frac: 0.18 },
    { id: 'actions', label: t.phaseAction, frac: 0.18 },
    { id: 'events', label: t.phaseEvent, frac: 0.16 },
    { id: 'processes', label: t.phaseProc, frac: 0.14 },
  ];
}

function LiveDiscover({ t, lang, ctrl }: { t: Strings; lang: Lang; ctrl: OntologyRunController }) {
  const { run, ontology, running, error, step } = ctrl;

  const done = run?.status === 'complete';
  const errored = run?.status === 'error' || error != null;

  // Drive the pipeline: advance exactly one stage whenever the run is idle and
  // not yet complete. `step()` guards itself (no-op if running/complete/errored),
  // and `running` flipping false after each call re-triggers this effect.
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    if (!run) return;
    if (run.status === 'complete' || run.status === 'error') return;
    if (running) return;
    void stepRef.current();
    // Re-run when the run object or the in-flight flag changes.
  }, [run, running]);

  // ---- counters (off run.stages[].count; attrs off the partial ontology) ----
  const counts = useMemo(() => stageCounts(run?.stages), [run]);
  const totalAttrs = useMemo(() => countAttributes(ontology?.objects), [ontology]);

  // ---- emerging graph nodes (partial ontology.objects → OntObject view) ------
  // Edges are drawn by EmergingGraph from each node's `relations` labels (it
  // name-matches the target), so we hydrate those from the relationship table.
  const graphObjs = useMemo(() => {
    if (!ontology) return [];
    const nameById = new Map<string, string>();
    for (const o of ontology.objects) nameById.set(o.id, o.name);
    const relLabelsBySource = new Map<string, string[]>();
    for (const rel of ontology.relationships) {
      const targetName = nameById.get(rel.targetObjectTypeId);
      if (!targetName) continue;
      const list = relLabelsBySource.get(rel.sourceObjectTypeId) ?? [];
      list.push(`${rel.name} → ${targetName}`);
      relLabelsBySource.set(rel.sourceObjectTypeId, list);
    }
    return ontology.objects.map((o) => toGraphObject(o, relLabelsBySource.get(o.id) ?? []));
  }, [ontology]);

  // ---- phase bar -------------------------------------------------------------
  const phaseList = livePhases(t);
  const { currentPhase, passedPhases } = livePhaseState(run?.stages, run?.currentStage ?? null, !!done);
  const totalProgress = liveProgress(run?.stages, !!done);

  // ---- log (newest window, like the demo) ------------------------------------
  const logs: LogLine[] = (run?.log ?? [])
    .slice(-40)
    .map((l) => ({ at: formatIso(l.at), text: l.text }));

  const statusBadge = errored
    ? (lang === 'zh' ? '● 出错' : '● error')
    : done
      ? '● done'
      : '● live';

  return (
    <DiscoverLayout
      t={t}
      lang={lang}
      done={!!done}
      sourceStream={<LiveSourceStream lang={lang} ctrl={ctrl} logs={logs} />}
      graphObjs={graphObjs}
      graphKey={(run?.id ?? 'live') + ':' + graphObjs.length}
      phaseList={phaseList}
      currentPhase={currentPhase}
      passedPhases={passedPhases}
      totalProgress={totalProgress}
      counts={counts}
      totalAttrs={totalAttrs}
      logs={logs}
      statusBadge={statusBadge}
      statusColor={errored ? 'var(--node-attr)' : done ? 'var(--accent-3)' : 'var(--accent-2)'}
      controls={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="mono-cap">{(totalProgress * 100).toFixed(0)}%</span>
          {done && (
            <button className="btn primary" style={{ padding: '8px 14px' }} onClick={() => gotoStep('objects')}>
              {t.seeResults} →
            </button>
          )}
        </div>
      }
    />
  );
}

/** Per-stage item counts, keyed by Stage. */
function stageCounts(stages: { stage: Stage; count: number }[] | undefined): Record<Stage, number> {
  const out: Record<Stage, number> = {
    objects: 0,
    rules: 0,
    actions: 0,
    events: 0,
    processes: 0,
  };
  for (const sp of stages ?? []) out[sp.stage] = sp.count;
  return out;
}

function countAttributes(objects: ObjectType[] | undefined): number {
  if (!objects) return 0;
  return objects.reduce((n, o) => n + o.attributes.length, 0);
}

/** Map a canonical ObjectType onto the OntObject VIEW shape EmergingGraph wants. */
function toGraphObject(o: ObjectType, relations: string[]): OntObject {
  return {
    id: o.id,
    name: o.name,
    zh: o.nameZh,
    emoji: o.display?.emoji ?? '◻',
    color: o.display?.color ?? 'accent',
    confidence: o.confidence,
    sources: o.sources.length,
    attrs: [],
    // Edge labels carry the target object name (e.g. "places → Order"), which
    // EmergingGraph name-matches against other nodes to draw the edges.
    relations,
  };
}

/** Which phase segments are passed / current, derived from stage progress. */
function livePhaseState(
  stages: { stage: Stage; status: string; count: number }[] | undefined,
  currentStage: Stage | null,
  done: boolean,
): { currentPhase: string; passedPhases: Set<string> } {
  const passed = new Set<string>();
  if (done) {
    passed.add('parse');
    for (const s of stages ?? []) passed.add(s.stage);
    return { currentPhase: 'processes', passedPhases: passed };
  }

  // `parse` is the synthetic lead-in; it's "passed" the moment any stage exists
  // (a run with stages has finished parsing/seeding).
  if ((stages?.length ?? 0) > 0) passed.add('parse');

  let current = 'parse';
  for (const s of stages ?? []) {
    if (s.status === 'complete') {
      passed.add(s.stage);
    } else if (s.status === 'running') {
      current = s.stage;
    }
  }
  if (currentStage) current = currentStage;
  else if (current === 'parse' && (stages?.length ?? 0) === 0) current = 'parse';

  return { currentPhase: current, passedPhases: passed };
}

/** Overall progress fraction from completed/total stages (+1 for parse). */
function liveProgress(stages: { status: string }[] | undefined, done: boolean): number {
  if (done) return 1;
  const total = (stages?.length ?? 5) + 1; // +1 = parse lead-in
  const finished = 1 + (stages ?? []).filter((s) => s.status === 'complete').length; // parse counted done once stages exist
  const partial = (stages ?? []).some((s) => s.status === 'running') ? 0.4 : 0;
  return Math.min(0.99, (finished + partial) / total);
}

// ===========================================================================
//  DEMO — the original canned animation, verbatim in behaviour.
// ===========================================================================

function demoPhases(t: Strings): PhaseDef[] {
  return [
    { id: 'parse', label: t.phaseParse, frac: 0.1 },
    { id: 'entity', label: t.phaseEntity, frac: 0.35 },
    { id: 'rule', label: t.phaseRule, frac: 0.25 },
    { id: 'proc', label: t.phaseProc, frac: 0.2 },
    { id: 'link', label: t.phaseLink, frac: 0.1 },
  ];
}

function DemoDiscover({ t, lang, ctrl }: { t: Strings; lang: Lang; ctrl: OntologyRunController }) {
  // The demo ontology is assembled up front; we still narrate with the canned
  // script for the "magic moment". Use the commerce fixture (the dataset the
  // controller seeded) so the script matches what objects/rules will be shown.
  const dataset: Dataset = DATASETS.commerce;
  const speedMultiplier = 1;
  void ctrl; // demo discovery is self-contained; controller already holds ontology

  const [tick, setTick] = useState<number>(0); // simulated time, ms
  const [paused, setPaused] = useState(false);
  const [done, setDone] = useState(false);
  const scriptRef = useRef<DiscoveryScript | null>(null);
  const startRef = useRef<number>(0);
  const offsetRef = useRef<number>(0);
  const pauseStartRef = useRef<number>(0);

  // Build the script once for this dataset/speed.
  useEffect(() => {
    scriptRef.current = buildDiscoveryScript(dataset, speedMultiplier);
    startRef.current = Date.now();
    offsetRef.current = 0;
    setTick(0);
    setDone(false);
    setPaused(false);
  }, [dataset, speedMultiplier]);

  // Wallclock-driven timer (not rAF — survives background throttling).
  useEffect(() => {
    if (done) return;
    if (paused) {
      pauseStartRef.current = Date.now();
      return;
    }
    if (pauseStartRef.current) {
      offsetRef.current += Date.now() - pauseStartRef.current;
      pauseStartRef.current = 0;
    }
    const id = setInterval(() => {
      const elapsed = Date.now() - startRef.current - offsetRef.current;
      if (scriptRef.current && elapsed >= scriptRef.current.duration) {
        setTick(scriptRef.current.duration);
        setDone(true);
        clearInterval(id);
      } else {
        setTick(elapsed);
      }
    }, 80);
    return () => clearInterval(id);
  }, [paused, done]);

  const script: DiscoveryScript = scriptRef.current || { events: [], duration: 1 };
  const elapsed = tick;
  const fired = script.events.filter((e) => e.at <= elapsed);

  const objs = fired
    .filter((e): e is Extract<DiscoveryEvent, { kind: 'object' }> => e.kind === 'object')
    .map((e) => e.obj);
  const rules = fired
    .filter((e): e is Extract<DiscoveryEvent, { kind: 'rule' }> => e.kind === 'rule')
    .map((e) => e.rule);
  const procs = fired
    .filter((e): e is Extract<DiscoveryEvent, { kind: 'process' }> => e.kind === 'process')
    .map((e) => e.proc);
  const logEvents = fired
    .filter((e): e is Extract<DiscoveryEvent, { kind: 'log' }> => e.kind === 'log')
    .slice(-40);

  const totalAttrs = objs.reduce((n, o) => n + o.attrs.length, 0);

  const phaseList = demoPhases(t);
  const lastPhaseEvent = [...fired]
    .reverse()
    .find((e): e is Extract<DiscoveryEvent, { kind: 'phase' }> => e.kind === 'phase');
  const currentPhase = lastPhaseEvent ? lastPhaseEvent.name : 'parse';

  // Passed = any phase whose marker has fired AND is not the current one (or all
  // when done) — mirrors the original per-segment logic.
  const passedPhases = new Set<string>();
  for (const p of phaseList) {
    const reached = fired.some((e) => e.kind === 'phase' && e.name === p.id);
    if ((reached && currentPhase !== p.id) || (done && reached)) passedPhases.add(p.id);
  }

  const totalProgress = Math.min(1, elapsed / script.duration);

  // Demo log carries `at` (ms); reuse the simulated-time formatter.
  const logs = logEvents.map((l) => ({ at: formatTime(l.at), text: l.text }));

  const counts: Record<Stage, number> = {
    objects: objs.length,
    rules: rules.length,
    actions: 0,
    events: 0,
    processes: procs.length,
  };

  return (
    <DiscoverLayout
      t={t}
      lang={lang}
      done={done}
      sourceStream={<DemoSourceStream dataset={dataset} fired={fired} lang={lang} />}
      graphObjs={objs}
      graphKey={dataset.id + speedMultiplier}
      phaseList={phaseList}
      currentPhase={currentPhase}
      passedPhases={passedPhases}
      totalProgress={totalProgress}
      counts={counts}
      totalAttrs={totalAttrs}
      logs={logs}
      statusBadge={done ? '● done' : '● live'}
      statusColor={done ? 'var(--accent-3)' : 'var(--accent-2)'}
      controls={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="mono-cap">{(totalProgress * 100).toFixed(0)}%</span>
          {!done && (
            <button
              className="btn ghost"
              style={{ padding: '5px 12px', fontSize: 12 }}
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? t.resume : t.pause}
            </button>
          )}
          {done && (
            <button className="btn primary" style={{ padding: '8px 14px' }} onClick={() => gotoStep('objects')}>
              {t.seeResults} →
            </button>
          )}
        </div>
      }
    />
  );
}

// ===========================================================================
//  Shared layout — the emerging-graph + counters + log composition.
// ===========================================================================

interface LogLine {
  /** Pre-formatted left gutter timestamp. */
  at: string;
  text: string;
}

interface DiscoverLayoutProps {
  t: Strings;
  lang: Lang;
  done: boolean;
  sourceStream: React.ReactNode;
  graphObjs: OntObject[];
  graphKey: string;
  phaseList: PhaseDef[];
  currentPhase: string;
  passedPhases: Set<string>;
  totalProgress: number;
  counts: Record<Stage, number>;
  totalAttrs: number;
  logs: LogLine[];
  statusBadge: string;
  statusColor: string;
  controls: React.ReactNode;
}

function DiscoverLayout(props: DiscoverLayoutProps) {
  const {
    t, lang, done, sourceStream, graphObjs, graphKey,
    phaseList, currentPhase, passedPhases, counts, totalAttrs,
    logs, statusBadge, statusColor, controls,
  } = props;

  return (
    <div className="screen" style={{ gridTemplateColumns: '320px 1fr 340px', gap: 0 }}>
      {/* Left: source stream */}
      {sourceStream}

      {/* Center: emerging graph */}
      <div style={{
        position: 'relative',
        borderLeft: '1px solid var(--line)',
        borderRight: '1px solid var(--line)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: 'var(--s-5) var(--s-6)', borderBottom: '1px solid var(--line)' }}>
          <div className="mono-cap">{lang === 'zh' ? '02 · 发现' : '02 · DISCOVER'}</div>
          <h1 style={{
            fontFamily: 'var(--font-display)',
            fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em',
            margin: '6px 0 4px',
          }}>
            <AiShimmer text={t.discoverTitle} active={!done} />
          </h1>
          <p style={{ color: 'var(--fg-3)', margin: 0, fontSize: 13 }}>{t.discoverSub}</p>
        </div>

        <EmergingGraph objs={graphObjs} containerKey={graphKey} />

        {/* Phase bar */}
        <div style={{ borderTop: '1px solid var(--line)', padding: 'var(--s-4) var(--s-6) var(--s-5)' }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 'var(--s-3)' }}>
            {phaseList.map((p) => {
              const isCurrent = currentPhase === p.id && !done;
              const passed = passedPhases.has(p.id) && !isCurrent;
              return (
                <div key={p.id} style={{
                  flex: p.frac,
                  height: 4,
                  borderRadius: 2,
                  background: passed
                    ? 'var(--accent)'
                    : isCurrent
                      ? 'linear-gradient(90deg, var(--accent), var(--accent-2))'
                      : 'var(--bg-3)',
                  position: 'relative',
                  overflow: 'hidden',
                }}>
                  {isCurrent && (
                    <div style={{
                      position: 'absolute', inset: 0,
                      background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)',
                      backgroundSize: '200% 100%',
                      animation: 'og-shimmer 1.4s linear infinite',
                    }} />
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="mono-cap">
              {phaseList.map((p, i) => {
                const isCurrent = currentPhase === p.id && !done;
                return (
                  <span key={p.id} style={{
                    marginRight: 12,
                    color: isCurrent ? 'var(--accent)' : 'var(--fg-4)',
                    fontWeight: isCurrent ? 600 : 400,
                  }}>{i + 1}. {p.label}</span>
                );
              })}
            </div>
            {controls}
          </div>
        </div>
      </div>

      {/* Right: counters + log */}
      <div style={{ display: 'flex', flexDirection: 'column', padding: 'var(--s-5)', gap: 'var(--s-4)', minHeight: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-3)' }}>
          <Counter label={t.foundObjects} value={counts.objects} accent="var(--accent)" />
          <Counter label={t.foundAttrs} value={totalAttrs} accent="var(--node-attr)" />
          <Counter label={t.foundRules} value={counts.rules} accent="var(--accent-2)" />
          <Counter label={t.foundActions} value={counts.actions} accent="var(--accent-2)" />
          <Counter label={t.foundEvents} value={counts.events} accent="var(--accent-3)" />
          <Counter label={t.foundProcesses} value={counts.processes} accent="var(--accent-3)" />
        </div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          <div className="card-h">
            <span>{t.liveLog}</span>
            <span className="mono-cap" style={{ color: statusColor }}>
              {statusBadge}
            </span>
          </div>
          <div className="scroll" style={{
            padding: 'var(--s-3) var(--s-4)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1.6,
            color: 'var(--fg-3)',
            flex: 1,
            display: 'flex', flexDirection: 'column-reverse',
          }}>
            <div>
              {logs.map((l, i) => {
                const isLatest = i === logs.length - 1 && !done;
                return (
                  <div key={i} style={{ opacity: isLatest ? 1 : 0.7, color: isLatest ? 'var(--fg)' : 'var(--fg-3)' }}>
                    <span style={{ color: 'var(--fg-4)' }}>{l.at}</span>{' '}
                    {l.text}
                    {isLatest && <span style={{ color: 'var(--accent-2)', animation: 'og-pulse-soft 1s infinite' }}>▌</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
//  Atoms (unchanged from the original look).
// ===========================================================================

function formatTime(ms: number) {
  const s = (ms / 1000).toFixed(2);
  return `[${s.padStart(6, '0')}s]`;
}

/** Format an ISO timestamp (live run.log[].at) into the gutter clock. */
function formatIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '[--:--:--]';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `[${hh}:${mm}:${ss}]`;
}

function AiShimmer({ text, active }: { text: string; active: boolean }) {
  if (!active) return <span style={{ color: 'var(--fg)' }}>{text}</span>;
  return (
    <span style={{
      background: 'linear-gradient(90deg, var(--fg) 0%, var(--accent) 30%, var(--accent-2) 50%, var(--accent-3) 70%, var(--fg) 100%)',
      backgroundSize: '200% 100%',
      animation: 'og-shimmer 3s linear infinite',
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      color: 'transparent',
    }}>{text}</span>
  );
}

function Counter({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div style={{
      padding: 'var(--s-4)',
      background: 'var(--bg-1)',
      border: '1px solid var(--line)',
      borderRadius: 'var(--r-3)',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        height: 2, background: accent, opacity: 0.6,
      }} />
      <div className="mono-cap" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{
        fontFamily: 'var(--font-display)',
        fontSize: 32, fontWeight: 500,
        letterSpacing: '-0.02em',
        color: accent,
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
    </div>
  );
}

// ===========================================================================
//  Left column — source stream (two flavours, same look).
// ===========================================================================

// DEMO: document fragments with phrases lighting up as they're "extracted".
function DemoSourceStream({ dataset, fired, lang }: { dataset: Dataset; fired: DiscoveryEvent[]; lang: Lang }) {
  const fragments = dataset.rules.map((r, i) => ({
    doc: r.source.name,
    page: r.source.page,
    text: r.source.excerpt,
    keywords: r.objects,
    activeAt: i,
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: 'var(--s-5)', gap: 'var(--s-3)', minHeight: 0 }}>
      <div className="mono-cap">{lang === 'zh' ? '通读中的文档' : 'Reading sources'}</div>
      <div className="scroll" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)', flex: 1 }}>
        {fragments.map((f, i) => {
          const ruleFired = fired.some((e) => e.kind === 'rule' && e.rule.id === dataset.rules[i].id);
          return (
            <div key={i} style={{
              background: 'var(--bg-1)',
              border: `1px solid ${ruleFired ? 'color-mix(in oklab, var(--accent-2) 50%, var(--line))' : 'var(--line)'}`,
              borderRadius: 'var(--r-2)',
              padding: 'var(--s-3)',
              transition: 'border-color 0.4s',
              boxShadow: ruleFired ? '0 0 0 1px color-mix(in oklab, var(--accent-2) 30%, transparent)' : 'none',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span className="mono-cap" style={{ color: ruleFired ? 'var(--accent-2)' : 'var(--fg-4)' }}>
                  {f.doc}
                </span>
                {f.page > 0 && <span className="mono-cap">p.{f.page}</span>}
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: ruleFired ? 'var(--fg)' : 'var(--fg-3)' }}>
                <Highlighted text={f.text} keywords={f.keywords} active={ruleFired} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// LIVE: the real source documents, each lighting up once it has been cited by an
// extracted node (the ontology carries SourceRef.documentName on every node).
function LiveSourceStream({ lang, ctrl, logs }: { lang: Lang; ctrl: OntologyRunController; logs: LogLine[] }) {
  const ontology = ctrl.ontology;
  const docs = ontology?.sourceDocuments ?? [];

  // A document is "active" once any extracted node cites it.
  const citedDocIds = useMemo(() => {
    const set = new Set<string>();
    if (!ontology) return set;
    const layers = [
      ontology.objects,
      ontology.rules,
      ontology.actions,
      ontology.events,
      ontology.processes,
      ontology.relationships,
    ];
    for (const layer of layers) {
      for (const node of layer) {
        for (const src of node.sources ?? []) set.add(src.documentId);
      }
    }
    return set;
  }, [ontology]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: 'var(--s-5)', gap: 'var(--s-3)', minHeight: 0 }}>
      <div className="mono-cap">{lang === 'zh' ? '通读中的文档' : 'Reading sources'}</div>
      <div className="scroll" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)', flex: 1 }}>
        {docs.length === 0 && (
          <div className="mono-cap" style={{ color: 'var(--fg-4)' }}>
            {lang === 'zh' ? '正在准备数据源…' : 'preparing sources…'}
          </div>
        )}
        {docs.map((d) => {
          const cited = citedDocIds.has(d.id);
          const icon = d.kind === 'db' ? '🗄' : d.kind === 'app' ? '🔌' : '📄';
          return (
            <div key={d.id} style={{
              background: 'var(--bg-1)',
              border: `1px solid ${cited ? 'color-mix(in oklab, var(--accent-2) 50%, var(--line))' : 'var(--line)'}`,
              borderRadius: 'var(--r-2)',
              padding: 'var(--s-3)',
              transition: 'border-color 0.4s',
              boxShadow: cited ? '0 0 0 1px color-mix(in oklab, var(--accent-2) 30%, transparent)' : 'none',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems: 'center', gap: 8 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ fontSize: 13 }}>{icon}</span>
                  <span className="mono-cap" style={{
                    color: cited ? 'var(--accent-2)' : 'var(--fg-4)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{d.name}</span>
                </span>
                {d.pageCount ? <span className="mono-cap">{d.pageCount}p</span> : null}
              </div>
              <div style={{ fontSize: 11, lineHeight: 1.5, color: cited ? 'var(--accent-2)' : 'var(--fg-4)', fontFamily: 'var(--font-mono)' }}>
                {cited
                  ? (lang === 'zh' ? '已抽取引用 ✓' : 'cited ✓')
                  : (lang === 'zh' ? '扫描中…' : 'scanning…')}
              </div>
            </div>
          );
        })}
      </div>
      {/* When there are no docs yet, still hint progress from the freshest log. */}
      {docs.length === 0 && logs.length > 0 && (
        <div className="mono-cap" style={{ color: 'var(--fg-4)' }}>{logs[logs.length - 1].text}</div>
      )}
    </div>
  );
}

function Highlighted({ text, keywords, active }: { text: string; keywords: string[]; active: boolean }) {
  if (!active) return <>{text}</>;
  const escapedKws = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escapedKws.length === 0) return <>{text}</>;
  const re = new RegExp(`\\b(${escapedKws.join('|')})\\b`, 'gi');
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) => {
        const isKw = escapedKws.some((k) => new RegExp(`^${k}$`, 'i').test(p));
        return isKw ? (
          <mark key={i} style={{
            background: 'color-mix(in oklab, var(--accent-2) 25%, transparent)',
            color: 'var(--accent-2)',
            padding: '0 3px', borderRadius: 3,
            borderBottom: '1px solid var(--accent-2)',
          }}>{p}</mark>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </>
  );
}

// ===========================================================================
//  Force-field-style emerging graph (unchanged renderer).
// ===========================================================================

function defaultNodePos(id: string, i: number): { x: number; y: number } {
  const cols = 4;
  const seed = hash(id);
  const col = i % cols;
  const row = Math.floor(i / cols);
  return {
    x: 80 + col * 180 + (seed % 40) - 20,
    y: 70 + row * 130 + ((seed >> 4) % 40) - 20,
  };
}

// View (pan/zoom) limits for the emerging graph.
const MIN_K = 0.2;
const MAX_K = 4;
const clampNum = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A pan/zoom view transform applied to the graph content group. */
interface GraphView {
  k: number;
  tx: number;
  ty: number;
}

function EmergingGraph({ objs, containerKey }: { objs: OntObject[]; containerKey: string }) {
  void containerKey;
  const W = 720, H = 460;

  // Positions are draggable: seeded layout to start, but the user can move any
  // node and we keep its position. New objects (streamed in during discovery)
  // get a default slot without disturbing nodes already placed/dragged.
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  useEffect(() => {
    setPositions((prev) => {
      const out = { ...prev };
      let changed = false;
      objs.forEach((o, i) => {
        if (!out[o.id]) {
          out[o.id] = defaultNodePos(o.id, i);
          changed = true;
        }
      });
      return changed ? out : prev;
    });
  }, [objs]);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const panRef = useRef<{ vx0: number; vy0: number; tx0: number; ty0: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);

  // Pan/zoom of the whole graph. Auto-fit follows the streaming graph until the
  // user takes manual control (pan / zoom / drag); the Fit button re-engages it.
  const [view, setView] = useState<GraphView>({ k: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const userAdjustedRef = useRef(false);

  // Map a client (screen) point into the SVG's viewBox space (CTM is unaffected
  // by the content transform, since the viewBox itself is fixed).
  function toViewBoxPoint(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const sp = pt.matrixTransform(ctm.inverse());
    return { x: sp.x, y: sp.y };
  }

  // Map a client point into graph space (undo the content pan/zoom transform).
  function toGraphPoint(clientX: number, clientY: number): { x: number; y: number } {
    const { k, tx, ty } = viewRef.current;
    const v = toViewBoxPoint(clientX, clientY);
    return { x: (v.x - tx) / k, y: (v.y - ty) / k };
  }

  // ---- fit the whole graph into the canvas (the "see everything" action) ----
  function computeFit(): GraphView | null {
    if (objs.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    objs.forEach((o, i) => {
      const p = positions[o.id] ?? defaultNodePos(o.id, i);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    });
    if (!Number.isFinite(minX)) return null;
    // Pad for each node's glow radius (~34) + the name/confidence labels below.
    const padX = 56, padTop = 46, padBottom = 66;
    const bw = (maxX - minX) + padX * 2;
    const bh = (maxY - minY) + padTop + padBottom;
    const k = clampNum(Math.min(W / bw, H / bh), MIN_K, 1.2);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2 + (padBottom - padTop) / 2;
    return { k, tx: W / 2 - k * cx, ty: H / 2 - k * cy };
  }

  // Auto-fit as the graph grows, unless the user has taken manual control.
  useEffect(() => {
    if (userAdjustedRef.current) return;
    const f = computeFit();
    if (f) setView(f);
    // computeFit reads objs + positions; both are in the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objs, positions]);

  // Native (non-passive) wheel listener so we can preventDefault and zoom to the
  // cursor without scrolling the page. React's onWheel is passive by default.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { k, tx, ty } = viewRef.current;
      const v = toViewBoxPoint(e.clientX, e.clientY);
      const newK = clampNum(k * Math.exp(-e.deltaY * 0.0015), MIN_K, MAX_K);
      const gx = (v.x - tx) / k, gy = (v.y - ty) / k;
      userAdjustedRef.current = true;
      setView({ k: newK, tx: v.x - newK * gx, ty: v.y - newK * gy });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // Reads live state via viewRef; attach once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function zoomBy(factor: number) {
    const { k, tx, ty } = viewRef.current;
    const newK = clampNum(k * factor, MIN_K, MAX_K);
    const cx = W / 2, cy = H / 2; // zoom about the canvas center for button zoom
    const gx = (cx - tx) / k, gy = (cy - ty) / k;
    userAdjustedRef.current = true;
    setView({ k: newK, tx: cx - newK * gx, ty: cy - newK * gy });
  }

  function fitToView() {
    const f = computeFit();
    if (!f) return;
    userAdjustedRef.current = false; // resume auto-follow after an explicit fit
    setView(f);
  }

  // ---- node drag (in graph space) + background pan ---------------------------
  function handleNodePointerDown(e: ReactPointerEvent, id: string) {
    e.preventDefault();
    e.stopPropagation(); // don't start a background pan
    const cur = positions[id] ?? defaultNodePos(id, objs.findIndex((o) => o.id === id));
    const g = toGraphPoint(e.clientX, e.clientY);
    dragRef.current = { id, dx: g.x - cur.x, dy: g.y - cur.y };
    userAdjustedRef.current = true;
    setDragId(id);
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function handleBackgroundPointerDown(e: ReactPointerEvent) {
    e.preventDefault();
    const v = toViewBoxPoint(e.clientX, e.clientY);
    const { tx, ty } = viewRef.current;
    panRef.current = { vx0: v.x, vy0: v.y, tx0: tx, ty0: ty };
    userAdjustedRef.current = true;
    setPanning(true);
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: ReactPointerEvent) {
    const d = dragRef.current;
    if (d) {
      const g = toGraphPoint(e.clientX, e.clientY);
      setPositions((prev) => ({ ...prev, [d.id]: { x: g.x - d.dx, y: g.y - d.dy } }));
      return;
    }
    const pan = panRef.current;
    if (pan) {
      const v = toViewBoxPoint(e.clientX, e.clientY);
      setView((cur) => ({ ...cur, tx: pan.tx0 + (v.x - pan.vx0), ty: pan.ty0 + (v.y - pan.vy0) }));
    }
  }

  function endInteraction(e: ReactPointerEvent) {
    if (!dragRef.current && !panRef.current) return;
    svgRef.current?.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    panRef.current = null;
    setDragId(null);
    setPanning(false);
  }

  const edges: { from: string; to: string; fromIdx: number; toIdx: number }[] = [];
  objs.forEach((o, i) => {
    o.relations.forEach((rel) => {
      const target = objs.find((o2) => rel.toLowerCase().includes(o2.name.toLowerCase()) && o2.id !== o.id);
      if (target) edges.push({ from: o.id, to: target.id, fromIdx: i, toIdx: objs.indexOf(target) });
    });
  });

  return (
    <div ref={wrapRef} className="grid-bg" style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{
          width: '100%', height: '100%', touchAction: 'none', userSelect: 'none',
          cursor: panning ? 'grabbing' : 'grab',
        }}
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
      >
        <defs>
          <radialGradient id="node-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.9" />
            <stop offset="60%" stopColor="var(--accent)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="edge-g" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.7" />
            <stop offset="1" stopColor="var(--accent-2)" stopOpacity="0.7" />
          </linearGradient>
        </defs>

        {/* Pannable / zoomable content group */}
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
          {/* Edges */}
          {edges.map((e, i) => {
            const a = positions[e.from], b = positions[e.to];
            if (!a || !b) return null;
            return (
              <line
                key={i}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="url(#edge-g)"
                strokeWidth="1"
                strokeDasharray="3 3"
                opacity="0.55"
                style={{ animation: `og-draw-line 0.6s ease forwards` }}
              />
            );
          })}

          {/* Nodes */}
          {objs.map((o, i) => {
            const p = positions[o.id] ?? defaultNodePos(o.id, i);
            const dragging = dragId === o.id;
            return (
              <g
                key={o.id}
                transform={`translate(${p.x}, ${p.y})`}
                onPointerDown={(e) => handleNodePointerDown(e, o.id)}
                style={{ cursor: dragging ? 'grabbing' : 'grab' }}
              >
                <circle r="34" fill="url(#node-glow)" opacity="0.5">
                  <animate attributeName="r" from="0" to="34" dur="0.6s" fill="freeze" />
                </circle>
                <circle r="20" fill="var(--bg-1)" stroke="var(--accent)" strokeWidth="1.4">
                  <animate attributeName="r" from="0" to="20" dur="0.4s" fill="freeze" />
                </circle>
                <text textAnchor="middle" dominantBaseline="middle" fontSize="13" fill="var(--fg)" fontFamily="var(--font-display)" fontWeight="600">{o.emoji}</text>
                <text textAnchor="middle" y={38} fontSize="11" fill="var(--fg-2)" fontFamily="var(--font-mono)">{o.name}</text>
                <text textAnchor="middle" y={50} fontSize="9" fill="var(--accent-2)" fontFamily="var(--font-mono)">
                  {(o.confidence * 100).toFixed(0)}%
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Pan/zoom controls */}
      <div style={{
        position: 'absolute', top: 12, right: 12,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <GraphCtrlBtn label="+" title="Zoom in" onClick={() => zoomBy(1.25)} />
        <GraphCtrlBtn label="−" title="Zoom out" onClick={() => zoomBy(1 / 1.25)} />
        <GraphCtrlBtn label="⤢" title="Fit graph to view" onClick={fitToView} />
      </div>

      {/* AI cursor — moves around to suggest "scanning" */}
      <div style={{
        position: 'absolute',
        left: `${30 + (objs.length * 7) % 60}%`,
        top: `${20 + (objs.length * 11) % 60}%`,
        width: 8, height: 8,
        borderRadius: '50%',
        background: 'var(--accent-2)',
        boxShadow: '0 0 18px var(--accent-2), 0 0 4px white',
        transition: 'all 0.4s ease',
        pointerEvents: 'none',
      }} />
    </div>
  );
}

/** Small square control button for the emerging-graph pan/zoom toolbar. */
function GraphCtrlBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      // Don't let a click on the toolbar start a background pan on the svg.
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        width: 30, height: 30,
        display: 'grid', placeItems: 'center',
        background: 'color-mix(in oklab, var(--bg-1) 80%, transparent)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-2)',
        color: 'var(--fg-2)',
        fontSize: 16, lineHeight: 1,
        cursor: 'pointer',
        backdropFilter: 'blur(4px)',
      }}
    >{label}</button>
  );
}

function hash(str: string) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
