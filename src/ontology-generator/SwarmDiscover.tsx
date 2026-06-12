// Swarm/hyper discover view — drives the deep-swarm OR hyper-automation phase
// machine (auto-steps `ctrl.step()` until the run completes) and renders the
// high-level phases generically off `run.phases` (4 swarm phases, 10 hyper
// phases), a per-agent roster, and the streaming log. Self-contained; the
// locked screen contract is { t, lang, ctrl } and navigation flows via an
// `ontogen:goto` event.
import { useEffect, useRef } from 'react';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';

function gotoStep(target: string): void {
  window.dispatchEvent(new CustomEvent('ontogen:goto', { detail: target }));
}

export default function SwarmDiscover({ t, lang, ctrl }: { t: Strings; lang: Lang; ctrl: OntologyRunController }) {
  const { run, running, error, step } = ctrl;
  const done = run?.status === 'complete';
  const errored = run?.status === 'error' || error != null;

  // Auto-advance ONE swarm sub-step whenever idle and not yet complete.
  // A failed step sets ctrl.error WITHOUT flipping run.status, so the loop
  // must also halt on error — otherwise it would retry forever with no
  // backoff. The user resumes explicitly via the Retry button below.
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    if (!run) return;
    if (run.status === 'complete' || run.status === 'error') return;
    if (error != null) return;
    if (running) return;
    void stepRef.current();
  }, [run, running, error]);

  const phases = run?.phases ?? [];
  const log = run?.log ?? [];

  return (
    <div className="screen" style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16, alignItems: 'start' }}>
      <div>
        <div className="card-h">
          <div>
            <h2 style={{ margin: 0 }}>{t.steps.discover} · {ctrl.run?.mode === 'hyper' ? t.modeHyper : t.modeSwarm}</h2>
            <p className="mono-cap" style={{ color: 'var(--fg-4)' }}>{done ? '' : t.swarmRunning}</p>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          {phases.map((p) => {
            const label = p.label ? (lang === 'zh' ? p.label.zh : p.label.en) : p.phase;
            const tagCls = p.status === 'complete' ? 'tag ok' : p.status === 'running' ? 'tag ai' : 'tag';
            const mark = p.status === 'complete' ? '✓' : p.status === 'running' ? '…' : '·';
            return (
              <div key={p.phase} className="card" style={{ padding: 12, opacity: p.status === 'pending' ? 0.55 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={tagCls}>{mark}</span>
                  <strong>{label}</strong>
                  {p.detail && <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>· {p.detail}</span>}
                </div>
                {p.agents && p.agents.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {p.agents.map((a) => (
                      <span key={a.id} className="agent-row">
                        <span
                          className="dot"
                          style={{ background: a.status === 'complete' ? 'var(--accent-3)' : a.status === 'running' ? 'var(--accent)' : 'var(--fg-4)' }}
                        />
                        {a.role}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {errored && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <p style={{ color: 'var(--warn)', margin: 0 }}>{error}</p>
            {!done && (
              <button className="btn" onClick={() => void step()}>
                {t.llmSettings.retry}
              </button>
            )}
          </div>
        )}

        {done && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
            <button className="btn" onClick={() => gotoStep('brief')}>{t.briefTitle} →</button>
            <button className="btn" onClick={() => gotoStep('objects')}>{t.steps.objects} →</button>
            <button className="btn" onClick={() => gotoStep('coverage')}>{t.coverageTitle} →</button>
            <button className="btn" onClick={() => gotoStep('questions')}>{t.questionsTitle} →</button>
          </div>
        )}
      </div>

      <div
        className="card scroll"
        style={{ padding: 12, maxHeight: '72vh', overflowY: 'auto', display: 'flex', flexDirection: 'column-reverse' }}
      >
        <div>
          <div className="mono-cap" style={{ color: 'var(--fg-4)', marginBottom: 6 }}>{t.swarmAgents} · log</div>
          {[...log].reverse().map((l, i) => (
            <div key={i} className="mono-cap" style={{ padding: '2px 0', color: 'var(--fg-3)' }}>{l.text}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
