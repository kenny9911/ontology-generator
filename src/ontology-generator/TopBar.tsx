// Top bar: brand, stepper, and compact controls (lang / theme / graph layout).
// Ported from OntologyGen_design/src/Shell.jsx; the design's floating dev
// "Tweaks" panel is replaced by the inline .ctl controls here.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lang } from './data';
import type { Strings, StepId } from './i18n';
import type { OntologySummary } from './api';
import type { OntologyRunController } from './useOntologyRun';
import { ThinkingIcon } from './ThinkingPanel';

export type ThemeName = 'light' | 'dark' | 'lumen' | 'midnight' | 'forest' | 'ember' | 'mono';
export type LayoutMode = 'force' | 'radial' | 'hierarchical' | 'clustered';

export const STEP_ORDER: StepId[] = ['input', 'discover', 'objects', 'rules', 'actions', 'events', 'processes', 'graph', 'publish'];

/** Deep-swarm adds business-understanding, coverage, and follow-up-question steps.
 *  Hyper mode reuses the same order (all three artifact screens apply); the
 *  `settings` step is deliberately in NO order — it is reached via the gear only. */
export const SWARM_STEP_ORDER: StepId[] = ['input', 'discover', 'brief', 'objects', 'rules', 'actions', 'events', 'processes', 'coverage', 'questions', 'graph', 'publish'];

/** The stepper order for the active mode. */
export function stepOrderFor(mode: string): StepId[] {
  return mode === 'swarm' || mode === 'hyper' ? SWARM_STEP_ORDER : STEP_ORDER;
}

export function BrandMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
      <defs>
        <linearGradient id="bm-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      <circle cx="13" cy="13" r="11" stroke="url(#bm-g)" strokeWidth="1.2" fill="none" />
      <circle cx="13" cy="13" r="2.4" fill="url(#bm-g)" />
      <circle cx="6.5" cy="7.5" r="1.6" fill="var(--accent)" />
      <circle cx="20" cy="9" r="1.6" fill="var(--accent-2)" />
      <circle cx="20.5" cy="19" r="1.6" fill="var(--accent-3)" />
      <circle cx="6" cy="19" r="1.6" fill="var(--accent-2)" />
      <line x1="13" y1="13" x2="6.5" y2="7.5" stroke="var(--accent)" strokeWidth="0.6" opacity="0.6" />
      <line x1="13" y1="13" x2="20" y2="9" stroke="var(--accent-2)" strokeWidth="0.6" opacity="0.6" />
      <line x1="13" y1="13" x2="20.5" y2="19" stroke="var(--accent-3)" strokeWidth="0.6" opacity="0.6" />
      <line x1="13" y1="13" x2="6" y2="19" stroke="var(--accent-2)" strokeWidth="0.6" opacity="0.6" />
    </svg>
  );
}

interface TopBarProps {
  step: StepId;
  setStep: (s: StepId) => void;
  /** The ordered stepper ids for the active mode (fast vs. deep-swarm). */
  steps: StepId[];
  /** Return to the generator home (Input screen). */
  onHome: () => void;
  /** Controller — powers the saved-ontology dropdown (list / load / delete). */
  ctrl: OntologyRunController;
  t: Strings;
  lang: Lang;
  completed: Partial<Record<StepId, boolean>>;
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
  setLang: (l: Lang) => void;
  layout: LayoutMode;
  setLayout: (l: LayoutMode) => void;
  /** Show the thinking-log toggle (only when a run exists). */
  showLog: boolean;
  /** Whether the thinking-log panel is currently open. */
  logOpen: boolean;
  /** Toggle the thinking-log panel. */
  onToggleLog: () => void;
  /** A run is actively streaming — lights the toggle's live indicator. */
  logLive: boolean;
}

const THEME_OPTIONS: { value: ThemeName; label: string; labelZh?: string }[] = [
  { value: 'light', label: 'Light', labelZh: '浅色' },
  { value: 'dark', label: 'Dark', labelZh: '深色' },
  { value: 'lumen', label: 'Lumen' },
  { value: 'midnight', label: 'Midnight' },
  { value: 'forest', label: 'Forest' },
  { value: 'ember', label: 'Ember' },
  { value: 'mono', label: 'Mono' },
];

/** Type-guard for a persisted theme string (used by the container to validate
 *  a `localStorage` value before adopting it). */
export function isThemeName(s: string | null | undefined): s is ThemeName {
  return !!s && THEME_OPTIONS.some((o) => o.value === s);
}

const LAYOUT_OPTIONS: { value: LayoutMode; label: string }[] = [
  { value: 'force', label: 'Force' },
  { value: 'radial', label: 'Radial' },
  { value: 'hierarchical', label: 'Tiers' },
  { value: 'clustered', label: 'Cluster' },
];

export default function TopBar({ step, setStep, steps, onHome, ctrl, t, lang, completed, theme, setTheme, setLang, layout, setLayout, showLog, logOpen, onToggleLog, logLive }: TopBarProps) {
  return (
    <header className="topbar">
      <button
        type="button"
        className="brand"
        onClick={onHome}
        title={lang === 'zh' ? '返回首页' : 'Back to home'}
        aria-label={lang === 'zh' ? '返回本体生成器首页' : 'Ontology Gen home'}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit' }}
      >
        <span className="brand-mark"><BrandMark /></span>
        <span>{t.brand}</span>
        <span className="brand-sub">{t.brandSub}</span>
      </button>

      <nav className="stepper">
        {steps.map((s, i) => {
          const isActive = s === step;
          const isDone = completed[s];
          const num = String(i + 1).padStart(2, '0');
          return (
            <button
              key={s}
              className={`step ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}`}
              onClick={() => setStep(s)}
            >
              <span className="step-num">{isDone ? '✓' : num}</span>
              <span className="step-label">{t.steps[s]}</span>
            </button>
          );
        })}
      </nav>

      <div className="top-actions">
        <SavedOntologyMenu t={t} lang={lang} ctrl={ctrl} />
        {step === 'graph' && (
          <select
            className="ctl"
            value={layout}
            onChange={(e) => setLayout(e.target.value as LayoutMode)}
            title={t.layout}
          >
            {LAYOUT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        <select
          className="ctl"
          value={theme}
          onChange={(e) => setTheme(e.target.value as ThemeName)}
          title={lang === 'zh' ? '主题' : 'Theme'}
        >
          {THEME_OPTIONS.map((o) => <option key={o.value} value={o.value}>{lang === 'zh' && o.labelZh ? o.labelZh : o.label}</option>)}
        </select>
        <button
          className="ctl"
          onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
          title="Language"
        >
          {lang === 'zh' ? 'EN' : '中文'}
        </button>
        {showLog && (
          <button
            className={`ctl ctl-icon ${logOpen ? 'ctl-active' : ''} ${logLive ? 'ctl-live' : ''}`}
            onClick={onToggleLog}
            title={t.activityToggle}
            aria-label={t.activityToggle}
            aria-pressed={logOpen}
          >
            <ThinkingIcon size={14} live={logLive} />
          </button>
        )}
        <button
          className={`ctl ctl-icon ${step === 'editor' ? 'ctl-active' : ''}`}
          onClick={() => setStep('editor')}
          title={t.jsonEditor.title}
          aria-label={t.jsonEditor.title}
        >
          <BracesIcon />
        </button>
        <button
          className={`ctl ctl-icon ${step === 'settings' ? 'ctl-active' : ''}`}
          onClick={() => setStep('settings')}
          title={t.settingsNav}
          aria-label={t.settingsNav}
        >
          <GearIcon />
        </button>
        <span className="pill" title={lang === 'zh' ? 'AI 在线' : 'AI online'}>
          <span className="dot" />
          <span className="pill-text">{lang === 'zh' ? 'AI 在线' : 'AI online'}</span>
        </span>
      </div>
    </header>
  );
}

/** Compact clock/history glyph for the saved-sessions dropdown — lets the
 *  control collapse to an icon (its label hides on narrow screens). */
function HistoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: 'block' }}>
      <circle cx="7" cy="7" r="5.4" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M7 3.9 V7 L9.1 8.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** Compact gear glyph for the LLM-settings button, drawn in the BrandMark's
 *  inline-SVG idiom so it sits flush with the other `.ctl` controls. */
function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: 'block' }}>
      <circle cx="7" cy="7" r="2.1" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <line x1="7" y1="0.8" x2="7" y2="2.6" />
        <line x1="7" y1="11.4" x2="7" y2="13.2" />
        <line x1="0.8" y1="7" x2="2.6" y2="7" />
        <line x1="11.4" y1="7" x2="13.2" y2="7" />
        <line x1="2.6" y1="2.6" x2="3.9" y2="3.9" />
        <line x1="10.1" y1="10.1" x2="11.4" y2="11.4" />
        <line x1="11.4" y1="2.6" x2="10.1" y2="3.9" />
        <line x1="3.9" y1="10.1" x2="2.6" y2="11.4" />
      </g>
    </svg>
  );
}

/** Compact curly-braces glyph for the JSON-editor button (matches GearIcon's idiom). */
function BracesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: 'block' }}>
      <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M5 1.4C3.6 1.4 3.4 2.2 3.4 3.2v1.4c0 0.9-0.6 1.4-1.4 1.4 0.8 0 1.4 0.5 1.4 1.4v1.4c0 1 0.2 1.8 1.6 1.8" />
        <path d="M9 1.4c1.4 0 1.6 0.8 1.6 1.8v1.4c0 0.9 0.6 1.4 1.4 1.4-0.8 0-1.4 0.5-1.4 1.4v1.4c0 1-0.2 1.8-1.6 1.8" />
      </g>
    </svg>
  );
}

/** Best-effort short date for a session's updatedAt (ISO) — never throws. */
function fmtSessionDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Top-bar dropdown listing the generator's saved ontologies (server-backed:
 * the local .data store in dev, Supabase in prod). Picking one loads it into
 * the workspace; the container then jumps to the graph.
 */
function SavedOntologyMenu({ t, lang, ctrl }: { t: Strings; lang: Lang; ctrl: OntologyRunController }) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<OntologySummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    ctrl.listSaved().then(setSessions).catch(() => setSessions([]));
  }, [ctrl]);

  // Fetch when the menu opens so the list reflects any newly-saved ontology.
  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  // Dismiss on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const load = useCallback(async (id: string) => {
    if (ctrl.running) return;
    setBusyId(id);
    try {
      await ctrl.loadSaved(id); // container advances to the graph on success
      setOpen(false);
    } catch {
      /* ctrl.error is surfaced elsewhere */
    } finally {
      setBusyId(null);
    }
  }, [ctrl]);

  const remove = useCallback(async (id: string, name: string) => {
    if (!window.confirm(`${t.confirmDeleteSession}\n\n${name}`)) return;
    setBusyId(id);
    try {
      await ctrl.deleteSaved(id);
      refresh();
    } catch {
      /* ignore — refresh keeps the list coherent */
    } finally {
      setBusyId(null);
    }
  }, [ctrl, refresh, t]);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className={`ctl ctl-combo ${open ? 'ctl-active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={t.previousSessionsHint}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.previousSessions}
      >
        <HistoryIcon />
        <span className="ctl-text">{t.previousSessions}</span>
        <span className="ctl-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          className="scroll"
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0,
            width: 300, maxHeight: 360, overflowY: 'auto',
            background: 'var(--bg-1)', border: '1px solid var(--line)',
            borderRadius: 'var(--r-3)', boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
            zIndex: 60, padding: 6,
          }}
        >
          {sessions == null && (
            <div className="mono-cap" style={{ padding: '10px 8px', color: 'var(--fg-4)' }}>
              {lang === 'zh' ? '加载中…' : 'Loading…'}
            </div>
          )}
          {sessions && sessions.length === 0 && (
            <div className="mono-cap" style={{ padding: '12px 8px', textAlign: 'center', color: 'var(--fg-4)' }}>
              {t.noSavedSessions}
            </div>
          )}
          {sessions && sessions.map((s) => {
            const title = lang === 'zh' ? s.nameZh ?? s.name : s.name;
            const date = fmtSessionDate(s.updatedAt);
            const isBusy = busyId === s.id;
            return (
              <div
                key={s.id}
                role="menuitem"
                tabIndex={0}
                onClick={() => void load(s.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void load(s.id); } }}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr auto auto',
                  alignItems: 'center', gap: 8, padding: '8px 10px',
                  borderRadius: 'var(--r-2)',
                  cursor: ctrl.running ? 'default' : 'pointer',
                  opacity: ctrl.running && !isBusy ? 0.5 : 1,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-2)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {title || s.id}
                  </div>
                  {date && <div className="mono-cap" style={{ color: 'var(--fg-4)' }}>{date}</div>}
                </div>
                <span className={`tag ${s.status === 'published' ? 'ok' : ''}`} style={{ flexShrink: 0 }}>
                  {`v1.${s.version}.0`}
                </span>
                <button
                  type="button"
                  aria-label={t.deleteSession}
                  title={t.deleteSession}
                  onClick={(e) => { e.stopPropagation(); void remove(s.id, title || s.id); }}
                  disabled={ctrl.running}
                  style={{ background: 'none', border: 'none', color: 'var(--fg-4)', cursor: ctrl.running ? 'default' : 'pointer', fontSize: 14, lineHeight: 1, flexShrink: 0 }}
                >×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
