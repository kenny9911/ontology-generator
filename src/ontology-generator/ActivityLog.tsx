// ActivityLog — turns the flat run.log stream (`{ at, text }[]`) into a rich,
// grouped "thinking & activity" timeline. It is purely presentational: it parses
// each log line into a (scope, kind) pair, folds consecutive same-scope lines
// into timeline GROUPS (one per task — objects / rules / a swarm phase / …), and
// renders each group as a node on a vertical rail with a live status, the items
// it produced, and the narration lines beneath it.
//
// Nothing here is wired to the backend; it derives everything from the run state
// the controller already holds, so it degrades gracefully (empty log → empty
// state, loaded session → static history). Compiles under strict /
// noUnusedLocals / noUnusedParameters; no `any`.
import { useEffect, useMemo, useRef } from 'react';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRun, RunStatus, Stage, StageProgress } from '@/ontology/schema/types';

interface ActivityLogProps {
  run: OntologyRun;
  running: boolean;
  t: Strings;
  lang: Lang;
}

// ---- scope / kind model ----------------------------------------------------

type Scope =
  | 'parse'
  | 'objects'
  | 'rules'
  | 'actions'
  | 'events'
  | 'processes'
  | 'swarm'
  | 'hyper'
  | 'general';

/** The semantic flavour of a single narration line, drives its glyph + tint. */
type LineKind = 'start' | 'extract' | 'critique' | 'coverage' | 'complete' | 'warn' | 'info';

type GroupStatus = 'pending' | 'running' | 'complete' | 'error';

interface ParsedLine {
  clock: string;
  scope: Scope;
  kind: LineKind;
  text: string;
}

interface Group {
  key: string;
  scope: Scope;
  status: GroupStatus;
  lines: ParsedLine[];
  startClock: string;
  /** Item count to surface in the header (stage count when known, else line count). */
  count: number | null;
}

const STAGE_SCOPES: Scope[] = ['objects', 'rules', 'actions', 'events', 'processes'];
const isStageScope = (s: Scope): s is Stage => (STAGE_SCOPES as string[]).includes(s);

/** Map a raw prefix token (bracket / colon) onto a known scope. */
function mapScope(token: string): Scope {
  switch (token) {
    case 'object':
    case 'objects':
      return 'objects';
    case 'rule':
    case 'rules':
      return 'rules';
    case 'action':
    case 'actions':
      return 'actions';
    case 'event':
    case 'events':
      return 'events';
    case 'process':
    case 'processes':
      return 'processes';
    case 'parse':
    case 'parsing':
      return 'parse';
    case 'swarm':
      return 'swarm';
    case 'hyper':
      return 'hyper';
    default:
      return 'general';
  }
}

const COLON_SCOPE_WORDS = new Set(['rules', 'processes', 'objects', 'actions', 'events', 'parse']);

/** Split a raw log line into its scope prefix and the human-readable remainder. */
function classifyScope(raw: string): { scope: Scope; body: string } {
  const bracket = raw.match(/^\s*\[([a-z_]+)\]\s*/i);
  if (bracket) {
    return { scope: mapScope(bracket[1]!.toLowerCase()), body: raw.slice(bracket[0].length).trim() };
  }
  // "Stage 4 (events): defined …"
  const stageParen = raw.match(/^\s*Stage\s*\d+\s*\(([a-z]+)\)\s*:\s*/i);
  if (stageParen) {
    return { scope: mapScope(stageParen[1]!.toLowerCase()), body: raw.slice(stageParen[0].length).trim() };
  }
  // "rules: extracted …" / "processes: synthesized …"
  const colon = raw.match(/^\s*([a-z]+)\s*:\s*/i);
  if (colon && COLON_SCOPE_WORDS.has(colon[1]!.toLowerCase())) {
    return { scope: mapScope(colon[1]!.toLowerCase()), body: raw.slice(colon[0].length).trim() };
  }
  return { scope: 'general', body: raw.trim() };
}

/** Classify a line body into a LineKind (order matters — most specific first). */
function classifyKind(body: string): LineKind {
  const s = body.toLowerCase();
  if (/(error|failed|fail\b|could not|cannot|no output|no rules|no actions|nothing|skip|empty|not parse|unparse|degrade)/.test(s)) {
    return 'warn';
  }
  if (/\b(start|starting|begin|sweep|sweeping|reading)\b/.test(s)) return 'start';
  if (/\b(complete|completed|done|prepared|finished)\b/.test(s)) return 'complete';
  if (/(critique|review|\bgap|issue|question)/.test(s)) return 'critique';
  if (/(coverage|sentence|covered|recall|target)/.test(s)) return 'coverage';
  if (/(extracted|synthesi|defined|recognized|deepen|merged|relationship|\+\d|node\(s\)|term)/.test(s)) return 'extract';
  return 'info';
}

/** Format an ISO timestamp into a compact HH:MM:SS gutter clock (never throws). */
function clockOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Resolve a group's status, preferring authoritative StageProgress when scoped. */
function resolveStatus(
  scope: Scope,
  lines: ParsedLine[],
  stages: StageProgress[],
  currentStage: Stage | null,
  runStatus: RunStatus,
  isLast: boolean,
): GroupStatus {
  if (isStageScope(scope)) {
    const sp = stages.find((s) => s.stage === scope);
    if (sp) {
      if (sp.status === 'error') return 'error';
      if (sp.status === 'complete') return 'complete';
      if (sp.status === 'running' || currentStage === scope) return 'running';
    }
  }
  if (lines.some((l) => l.kind === 'warn' && /(error|failed|fail\b|cannot)/.test(l.text.toLowerCase()))) {
    return 'error';
  }
  if (lines.some((l) => l.kind === 'complete')) return 'complete';
  if (isLast && runStatus === 'running') return 'running';
  if (isLast && runStatus === 'error') return 'error';
  // A past group with no explicit "complete" line reads as a finished task.
  return 'complete';
}

/** Fold the flat log into chronological, same-scope groups. */
function buildGroups(run: OntologyRun): Group[] {
  const stages = run.stages ?? [];
  const lines = (run.log ?? []).slice(-300).map((l): ParsedLine => {
    const { scope, body } = classifyScope(l.text);
    return { clock: clockOf(l.at), scope, kind: classifyKind(body), text: body || l.text };
  });

  const groups: Group[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && last.scope === line.scope) {
      last.lines.push(line);
    } else {
      groups.push({
        key: `${line.scope}:${groups.length}`,
        scope: line.scope,
        status: 'pending',
        lines: [line],
        startClock: line.clock,
        count: null,
      });
    }
  }

  groups.forEach((g, i) => {
    const isLast = i === groups.length - 1;
    g.status = resolveStatus(g.scope, g.lines, stages, run.currentStage ?? null, run.status, isLast);
    if (isStageScope(g.scope)) {
      const sp = stages.find((s) => s.stage === g.scope);
      g.count = sp ? sp.count : null;
    }
  });

  return groups;
}

// ---- presentation tables ---------------------------------------------------

/** Per-scope geometric glyph + CSS accent var (matches the app's node palette). */
const SCOPE_VIEW: Record<Scope, { glyph: string; accent: string }> = {
  parse: { glyph: '⌁', accent: 'var(--fg-3)' },
  objects: { glyph: '◆', accent: 'var(--accent)' },
  rules: { glyph: '⚖', accent: 'var(--accent-2)' },
  actions: { glyph: '⚡', accent: 'var(--accent-2)' },
  events: { glyph: '✦', accent: 'var(--accent-3)' },
  processes: { glyph: '⟳', accent: 'var(--accent-3)' },
  swarm: { glyph: '⬡', accent: 'var(--accent-2)' },
  hyper: { glyph: '✺', accent: 'var(--accent-3)' },
  general: { glyph: '•', accent: 'var(--fg-4)' },
};

const KIND_GLYPH: Record<LineKind, string> = {
  start: '▸',
  extract: '＋',
  critique: '◈',
  coverage: '▦',
  complete: '✓',
  warn: '⚠',
  info: '·',
};

function scopeLabel(scope: Scope, t: Strings): string {
  switch (scope) {
    case 'objects':
      return t.steps.objects;
    case 'rules':
      return t.steps.rules;
    case 'actions':
      return t.steps.actions;
    case 'events':
      return t.steps.events;
    case 'processes':
      return t.steps.processes;
    case 'parse':
      return t.actScopeParse;
    case 'swarm':
      return t.actScopeSwarm;
    case 'hyper':
      return t.actScopeHyper;
    default:
      return t.actScopeGeneral;
  }
}

function statusWord(status: GroupStatus, t: Strings): string {
  switch (status) {
    case 'running':
      return t.actRunning;
    case 'complete':
      return t.actComplete;
    case 'error':
      return t.actError;
    default:
      return t.actPending;
  }
}

/** Map a group status to the shared .tag modifier class. */
function statusTagClass(status: GroupStatus): string {
  switch (status) {
    case 'running':
      return 'tag ai';
    case 'complete':
      return 'tag ok';
    case 'error':
      return 'tag warn';
    default:
      return 'tag';
  }
}

// ---- component -------------------------------------------------------------

export default function ActivityLog({ run, running, t, lang }: ActivityLogProps) {
  const groups = useMemo(() => buildGroups(run), [run]);
  const stages = run.stages ?? [];

  // Overall progress: phases (swarm/hyper) → stages → 0; pinned to 100 when done.
  const pct = useMemo(() => {
    if (run.status === 'complete') return 100;
    const phases = run.phases ?? [];
    const frac = phases.length
      ? phases.filter((p) => p.status === 'complete').length / phases.length
      : stages.length
        ? stages.filter((s) => s.status === 'complete').length / stages.length
        : 0;
    return Math.min(99, Math.round(frac * 100));
  }, [run.status, run.phases, stages]);

  const totalLines = groups.reduce((n, g) => n + g.lines.length, 0);

  // Auto-stick to the newest line while a run streams, unless the user scrolled
  // up to read history (then we leave their scroll position alone).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [totalLines, pct]);

  const statCounts: { scope: Scope; count: number }[] = STAGE_SCOPES.map((scope) => ({
    scope,
    count: stages.find((s) => s.stage === scope)?.count ?? 0,
  }));
  const hasCounts = statCounts.some((c) => c.count > 0);

  return (
    <div className="actlog">
      {/* Stat strip: progress bar + per-layer count chips */}
      <div className="actlog-stats">
        <div className="actlog-prog">
          <div className="recall-bar"><span style={{ width: `${pct}%` }} /></div>
          <span className="mono-cap actlog-pct">{pct}%</span>
        </div>
        {hasCounts && (
          <div className="actlog-chips">
            {statCounts.map((c) => (
              <span
                key={c.scope}
                className="actlog-chip"
                style={{ ['--chip' as string]: SCOPE_VIEW[c.scope].accent, opacity: c.count > 0 ? 1 : 0.4 }}
                title={scopeLabel(c.scope, t)}
              >
                <i>{SCOPE_VIEW[c.scope].glyph}</i>
                <b>{c.count}</b>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="actlog-scroll scroll" ref={scrollRef} onScroll={onScroll}>
        {groups.length === 0 ? (
          <div className="actlog-empty mono-cap">{t.activityEmpty}</div>
        ) : (
          <div className="actlog-timeline">
            {groups.map((g, gi) => {
              const isLastGroup = gi === groups.length - 1;
              const view = SCOPE_VIEW[g.scope];
              const node = g.status === 'complete' ? '✓' : g.status === 'error' ? '✕' : view.glyph;
              return (
                <div
                  key={g.key}
                  className="actlog-group"
                  data-status={g.status}
                  style={{ ['--scope' as string]: view.accent }}
                >
                  <div className="actlog-rail">
                    <span className="actlog-node">{node}</span>
                  </div>
                  <div className="actlog-gbody">
                    <div className="actlog-ghead">
                      <span className="actlog-gtitle">{scopeLabel(g.scope, t)}</span>
                      {g.count != null && <span className="actlog-gcount">{g.count}</span>}
                      <span className={statusTagClass(g.status)}>{statusWord(g.status, t)}</span>
                      <span className="actlog-gclock mono-cap">{g.startClock}</span>
                    </div>
                    <div className="actlog-lines">
                      {g.lines.map((l, li) => {
                        const isNewest = isLastGroup && li === g.lines.length - 1;
                        return (
                          <div key={li} className="actlog-line" data-kind={l.kind}>
                            <span className="actlog-lglyph">{KIND_GLYPH[l.kind]}</span>
                            <span className="actlog-ltext">
                              {l.text}
                              {isNewest && running && <span className="actlog-cursor">▌</span>}
                            </span>
                          </div>
                        );
                      })}
                      {g.status === 'running' && (
                        <div className="actlog-working mono-cap">
                          <span className="actlog-spinner" />
                          {t.actWorking}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="actlog-foot mono-cap">
        <span>{lang === 'zh' ? `${groups.length} 个任务 · ${totalLines} 行` : `${groups.length} tasks · ${totalLines} lines`}</span>
      </div>
    </div>
  );
}
