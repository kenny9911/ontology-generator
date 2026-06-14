// ThinkingPanel — a right-docked, non-modal "window" that surfaces the live
// thinking & activity timeline (ActivityLog) over any screen. It is toggled from
// a top-bar icon, closeable, auto-opens when a fresh run starts, and slides in/out
// so the user can keep reviewing the ontology while watching the AI work.
//
// Self-contained; reads only the run state the controller already holds. Escape
// closes it. Compiles under strict / noUnusedLocals / noUnusedParameters; no `any`.
import { useEffect } from 'react';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRun } from '@/ontology/schema/types';
import ActivityLog from './ActivityLog';

interface ThinkingPanelProps {
  open: boolean;
  onClose: () => void;
  run: OntologyRun;
  running: boolean;
  t: Strings;
  lang: Lang;
}

/** A neural "thinking" glyph drawn in the BrandMark idiom — used in the top-bar
 *  toggle and the panel header. `live` lights the core when a run is streaming. */
export function ThinkingIcon({ size = 14, live = false }: { size?: number; live?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: 'block' }}>
      <circle cx="8" cy="8" r="2.1" fill={live ? 'var(--accent-2)' : 'currentColor'} opacity={live ? 1 : 0.85}>
        {live && <animate attributeName="opacity" values="0.5;1;0.5" dur="1.3s" repeatCount="indefinite" />}
      </circle>
      <g stroke="currentColor" strokeWidth="1" opacity="0.7">
        <line x1="8" y1="8" x2="3" y2="3.4" />
        <line x1="8" y1="8" x2="13" y2="4" />
        <line x1="8" y1="8" x2="12.6" y2="12.4" />
        <line x1="8" y1="8" x2="3.4" y2="12.6" />
      </g>
      <circle cx="3" cy="3.4" r="1.25" fill="var(--accent)" />
      <circle cx="13" cy="4" r="1.25" fill="var(--accent-2)" />
      <circle cx="12.6" cy="12.4" r="1.25" fill="var(--accent-3)" />
      <circle cx="3.4" cy="12.6" r="1.25" fill="var(--accent-2)" />
    </svg>
  );
}

export default function ThinkingPanel({ open, onClose, run, running, t, lang }: ThinkingPanelProps) {
  // Escape closes the panel while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const status =
    run.status === 'error'
      ? { cls: 'error', label: t.actErrored }
      : run.status === 'complete'
        ? { cls: 'done', label: t.actDone }
        : { cls: 'live', label: t.actLive };

  return (
    <aside
      className={`thinkpanel ${open ? 'open' : ''}`}
      role="complementary"
      aria-hidden={!open}
      aria-label={t.activityTitle}
    >
      <div className="thinkpanel-h">
        <span className="thinkpanel-title">
          <ThinkingIcon size={16} live={running} />
          <span className="thinkpanel-titles">
            <strong>{t.activityTitle}</strong>
            <span className="mono-cap">{t.activitySub}</span>
          </span>
        </span>
        <span className={`thinkpanel-status ${status.cls}`}>
          <span className="dot" />
          {status.label}
        </span>
        <button
          type="button"
          className="thinkpanel-x"
          onClick={onClose}
          title={lang === 'zh' ? '关闭' : 'Close'}
          aria-label={lang === 'zh' ? '关闭思考面板' : 'Close thinking panel'}
        >
          ✕
        </button>
      </div>
      <div className="thinkpanel-b">
        <ActivityLog run={run} running={running} t={t} lang={lang} />
      </div>
    </aside>
  );
}
