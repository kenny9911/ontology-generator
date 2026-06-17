// Publish — summary stats, Neo4j mirror status, and the generated artifact
// bundles (agent-code / prompts / manifest) for the LIVE canonical ontology.
//
// Drives `ctrl.publish()` (replaces the old fake setTimeout). On success the
// controller flips `ontology.status` to 'published', sets `ctrl.generated`
// (GeneratedBundle[] from generate "all"), and returns the Neo4j mirror result.
// Publishing SUCCEEDS even when `neo4j.mirrored === false` (json-only fallback).
//
// Contract: rendered by the container as <PublishScreen t={tx} lang={lang} ctrl={ctrl} />.
import { useMemo, useState } from 'react';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import type { GeneratedBundle, GeneratorTarget } from '@/ontology/schema/types';
import { Sparkle } from './InputScreen';

interface PublishScreenProps {
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
}

export default function PublishScreen({ t, lang, ctrl }: PublishScreenProps) {
  const { ontology, generated, running, error } = ctrl;

  // Local publish flow state — the controller owns persistence; this only tracks
  // the in-flight click + the returned mirror status to drive the success view.
  const [publishing, setPublishing] = useState(false);
  const [mirrored, setMirrored] = useState<boolean | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Published once the controller flipped status (live) OR we hold a result.
  const published = ontology?.status === 'published' && (mirrored !== null || generated != null);

  async function doPublish() {
    setPublishing(true);
    try {
      const result = await ctrl.publish();
      setMirrored(result.mirrored);
    } finally {
      setPublishing(false);
    }
  }

  // Explicit Save — persists the current (possibly edited) ontology as a new
  // version. (Generation also auto-saves on completion.) ctrl.save swallows
  // errors into ctrl.error, so the error card surfaces any failure.
  async function doSave() {
    setSaveState('saving');
    await ctrl.save();
    setSaveState('saved');
    window.setTimeout(() => setSaveState('idle'), 1800);
  }

  // Generate again — re-run the pipeline against the same sources, then show
  // the discovery loop. Falls back to the Input screen if sources are gone.
  async function doRegenerate() {
    await ctrl.regenerate();
    window.dispatchEvent(new CustomEvent('ontogen:goto', { detail: 'discover' }));
  }

  // ---- counts (the source of truth for the summary cards) ------------------
  const counts = useMemo(() => ({
    objects: ontology?.objects.length ?? 0,
    rules: ontology?.rules.length ?? 0,
    actions: ontology?.actions.length ?? 0,
    events: ontology?.events.length ?? 0,
    processes: ontology?.processes.length ?? 0,
    relationships: ontology?.relationships.length ?? 0,
  }), [ontology]);

  const ontologyName = ontology ? (lang === 'zh' ? ontology.nameZh ?? ontology.name : ontology.name) : '';
  const versionStr = ontology ? `v1.${ontology.version}.0` : 'v1.0.0';

  // =========================================================================
  // SUCCESS VIEW — published headline + Neo4j mirror status + artifact tabs.
  // =========================================================================
  if (published) {
    const isMirrored = mirrored === true;
    return (
      <div className="screen" style={{ gridTemplateColumns: '1fr' }}>
        <div className="scroll" style={{ padding: 'var(--s-7)' }}>
          <div style={{
            maxWidth: 960, margin: '0 auto',
            display: 'grid', gap: 'var(--s-6)',
          }}>
            {/* Success hero */}
            <div style={{
              textAlign: 'center',
              padding: 'var(--s-6) 0 var(--s-2)',
              background: 'radial-gradient(700px 360px at 50% 0%, color-mix(in oklab, var(--accent-3) 16%, transparent), transparent 70%)',
            }}>
              <div style={{
                margin: '0 auto var(--s-5)',
                width: 80, height: 80,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--accent), var(--accent-2), var(--accent-3))',
                display: 'grid', placeItems: 'center',
                boxShadow: '0 0 60px color-mix(in oklab, var(--accent-3) 50%, transparent)',
                animation: 'og-node-pop 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)',
              }}>
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
                  <path d="M5 12 L10 17 L19 7" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h1 style={{
                fontFamily: 'var(--font-display)', fontSize: 38, fontWeight: 600,
                letterSpacing: '-0.02em', margin: '0 0 var(--s-3)',
              }}>{t.publishedHeadline}</h1>
              <p style={{ color: 'var(--fg-3)', lineHeight: 1.6, fontSize: 15, margin: '0 auto var(--s-5)', maxWidth: 540 }}>
                {t.publishedSub}
              </p>
              <div style={{ display: 'flex', gap: 'var(--s-3)', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="btn primary">{t.viewLive} →</button>
                <button className="btn ghost" onClick={() => void doRegenerate()} disabled={running}>
                  {t.generateAgain}
                </button>
                <button className="btn ghost" onClick={ctrl.reset}>{t.runAnother}</button>
              </div>
            </div>

            {/* Summary stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--s-3)' }}>
              <SummaryStat label={t.foundObjects} value={counts.objects} accent="var(--accent)" />
              <SummaryStat label={t.foundRules} value={counts.rules} accent="var(--accent-2)" />
              <SummaryStat label={t.foundActions} value={counts.actions} accent="var(--node-action, var(--accent-3))" />
              <SummaryStat label={t.foundEvents} value={counts.events} accent="var(--node-event, var(--accent))" />
              <SummaryStat label={t.foundProcesses} value={counts.processes} accent="var(--accent-3)" />
            </div>

            {/* Neo4j mirror status + version meta */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-3)' }}>
              <div className="card">
                <div className="card-h">
                  <span>{t.neo4jStatus}</span>
                  <span className={`tag ${isMirrored ? 'ok' : ''}`}>
                    {isMirrored ? 'CONNECTED' : 'JSON-ONLY'}
                  </span>
                </div>
                <div className="card-b" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
                  <span style={{
                    width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                    background: isMirrored ? 'var(--accent-3)' : 'var(--fg-4)',
                    boxShadow: isMirrored ? '0 0 10px var(--accent-3)' : 'none',
                  }} />
                  <span style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                    {isMirrored ? t.graphConnected : t.graphOffline}
                  </span>
                </div>
              </div>
              <div className="card">
                <div className="card-h">
                  <span>{t.versionLabel}</span>
                  <span className="tag">{t.new}</span>
                </div>
                <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, color: 'var(--accent-3)', letterSpacing: '-0.01em' }}>
                    {versionStr}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{ontologyName}</span>
                </div>
              </div>
            </div>

            {/* Generated artifact bundles */}
            <ArtifactTabs t={t} bundles={generated ?? []} />
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // PRE-PUBLISH VIEW — summary + the big publish CTA.
  // =========================================================================
  const busy = publishing || running;
  return (
    <div className="screen" style={{ gridTemplateColumns: '1fr 420px', gap: 0 }}>
      <div className="scroll" style={{ padding: 'var(--s-7)' }}>
        <div className="mono-cap">{lang === 'zh' ? '09 · 发布' : '09 · PUBLISH'}</div>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 600,
          letterSpacing: '-0.02em', margin: '8px 0 8px',
        }}>{t.publishTitle}</h1>
        <p style={{ color: 'var(--fg-3)', maxWidth: 640, lineHeight: 1.6, margin: '0 0 var(--s-6)' }}>{t.publishSub}</p>

        {/* Summary cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--s-3)', marginBottom: 'var(--s-6)' }}>
          <SummaryStat label={t.foundObjects} value={counts.objects} accent="var(--accent)" />
          <SummaryStat label={t.foundRules} value={counts.rules} accent="var(--accent-2)" />
          <SummaryStat label={t.foundActions} value={counts.actions} accent="var(--node-action, var(--accent-3))" />
          <SummaryStat label={t.foundEvents} value={counts.events} accent="var(--node-event, var(--accent))" />
          <SummaryStat label={t.foundProcesses} value={counts.processes} accent="var(--accent-3)" />
        </div>

        {/* Changelog preview */}
        <div className="card">
          <div className="card-h">
            <span>{lang === 'zh' ? `本次变更 · ${versionStr}` : `Changelog · ${versionStr}`}</span>
            <span className="tag">{t.new}</span>
          </div>
          <div className="card-b" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.8, color: 'var(--fg-2)' }}>
            <div style={{ color: 'var(--accent-3)' }}>+ {counts.objects} {lang === 'zh' ? '个对象类型' : 'object types established'}</div>
            <div style={{ color: 'var(--accent-3)' }}>+ {counts.rules} {lang === 'zh' ? '条业务规则' : 'business rules codified'}</div>
            <div style={{ color: 'var(--accent-3)' }}>+ {counts.actions} {lang === 'zh' ? '个动作类型' : 'action types bound'}</div>
            <div style={{ color: 'var(--accent-3)' }}>+ {counts.events} {lang === 'zh' ? '个事件类型' : 'event types wired'}</div>
            <div style={{ color: 'var(--accent-3)' }}>+ {counts.processes} {lang === 'zh' ? '个流程' : 'processes documented'}</div>
            <div style={{ color: 'var(--accent-3)' }}>+ {counts.relationships} {lang === 'zh' ? '条关联' : 'relations linked'}</div>
          </div>
        </div>

        {error && (
          <div className="card" style={{ marginTop: 'var(--s-4)', borderColor: 'var(--err, #ef4444)' }}>
            <div className="card-b" style={{ color: 'var(--err, #ef4444)', fontSize: 13 }}>{error}</div>
          </div>
        )}
      </div>

      {/* Right rail — publish CTA */}
      <aside style={{
        borderLeft: '1px solid var(--line)',
        padding: 'var(--s-6) var(--s-5)',
        display: 'flex', flexDirection: 'column', gap: 'var(--s-4)',
      }}>
        <div>
          <div className="mono-cap" style={{ marginBottom: 4 }}>{t.versionLabel}</div>
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 24,
            color: 'var(--accent-3)', letterSpacing: '-0.01em',
          }}>{versionStr}</div>
          <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4 }}>
            {lang === 'zh' ? '首次发布 · 将创建主分支' : 'Initial publish · creates main branch'}
          </div>
        </div>

        <div className="divider" />

        <div style={{ display: 'grid', gap: 'var(--s-3)', fontSize: 12 }}>
          <DiffRow label={lang === 'zh' ? '对象层' : 'Object layer'} status="new" />
          <DiffRow label={lang === 'zh' ? '规则引擎' : 'Rule engine'} status="new" />
          <DiffRow label={lang === 'zh' ? '动作绑定' : 'Action bindings'} status="new" />
          <DiffRow label={lang === 'zh' ? '事件连接' : 'Event wiring'} status="new" />
          <DiffRow label={lang === 'zh' ? '流程编排' : 'Process orchestration'} status="new" />
          <DiffRow label={lang === 'zh' ? '关联图谱' : 'Relation graph'} status="new" />
          <DiffRow label={lang === 'zh' ? '向后兼容' : 'Backward compat'} status="ok" />
        </div>

        <div style={{ flex: 1 }} />

        {/* Save (explicit) + Generate again, above the publish CTA. */}
        <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
          <button
            className="btn ghost"
            onClick={() => void doSave()}
            disabled={busy || !ontology || ctrl.mode === 'demo'}
            title={ctrl.mode === 'demo' ? (lang === 'zh' ? '演示模式不支持保存' : 'Saving is unavailable in demo mode') : undefined}
            style={{ flex: 1, justifyContent: 'center', padding: '10px', fontSize: 13 }}
          >
            {saveState === 'saving' ? t.saving : saveState === 'saved' ? `✓ ${t.saved}` : t.save}
          </button>
          <button
            className="btn ghost"
            onClick={() => void doRegenerate()}
            disabled={busy || !ontology}
            style={{ flex: 1, justifyContent: 'center', padding: '10px', fontSize: 13 }}
          >
            {t.generateAgain}
          </button>
        </div>

        <button
          className="btn ai"
          onClick={doPublish}
          disabled={busy || !ontology}
          style={{ width: '100%', justifyContent: 'center', padding: '12px', fontSize: 14 }}
        >
          {busy ? (
            <>
              <Spinner />
              {lang === 'zh' ? '正在发布…' : 'Publishing…'}
            </>
          ) : (
            <>
              <Sparkle />
              {t.publishBtn}
            </>
          )}
        </button>
        <div className="mono-cap" style={{ textAlign: 'center', color: 'var(--fg-4)' }}>
          {lang === 'zh' ? '可随时回滚' : 'Reversible · 24-hour rollback'}
        </div>
      </aside>
    </div>
  );
}

// ===========================================================================
// Generated artifact tabs — agent-code / prompts / manifest, each listing its
// files with content in a <pre> and copy / download buttons.
// ===========================================================================

const TARGET_ORDER: GeneratorTarget[] = ['agent-code', 'prompts', 'manifest', 'spec'];

function ArtifactTabs({ t, bundles }: { t: Strings; bundles: GeneratedBundle[] }) {
  // Order the tabs by the canonical target order, keeping only what we received.
  const tabs = useMemo<GeneratedBundle[]>(
    () =>
      TARGET_ORDER.map((target) => bundles.find((b) => b.target === target)).filter(
        (b): b is GeneratedBundle => b != null,
      ),
    [bundles],
  );

  const [active, setActive] = useState<GeneratorTarget>(tabs[0]?.target ?? 'agent-code');
  const current = tabs.find((b) => b.target === active) ?? tabs[0];

  const tabLabel = (target: GeneratorTarget): string =>
    target === 'agent-code'
      ? t.agentCode
      : target === 'prompts'
        ? t.prompts
        : target === 'spec'
          ? t.specFormat
          : t.manifest;

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="card">
      <div className="card-h">
        <span>{t.artifacts}</span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 'var(--s-4)' }}>
        {/* Tab bar */}
        <div role="tablist" style={{ display: 'flex', gap: 'var(--s-2)', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
          {tabs.map((b) => {
            const isActive = b.target === active;
            return (
              <button
                key={b.target}
                role="tab"
                aria-selected={isActive}
                onClick={() => setActive(b.target)}
                style={{
                  appearance: 'none',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
                  color: isActive ? 'var(--fg)' : 'var(--fg-3)',
                  padding: '8px 4px',
                  marginBottom: -1,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                {tabLabel(b.target)}
                <span className="pill" style={{ fontSize: 10 }}>{b.files.length}</span>
              </button>
            );
          })}
        </div>

        {/* Active bundle warnings */}
        {current && current.warnings.length > 0 && (
          <div style={{
            display: 'grid', gap: 4,
            padding: 'var(--s-3)',
            background: 'color-mix(in oklab, var(--accent-2) 10%, transparent)',
            border: '1px solid color-mix(in oklab, var(--accent-2) 35%, transparent)',
            borderRadius: 'var(--r-2)',
            fontSize: 12, color: 'var(--fg-2)',
          }}>
            {current.warnings.map((w, i) => (
              <div key={i} style={{ display: 'flex', gap: 6 }}>
                <span style={{ color: 'var(--accent-2)' }}>!</span>
                <span style={{ lineHeight: 1.5 }}>{w}</span>
              </div>
            ))}
          </div>
        )}

        {/* Files for the active bundle */}
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          {current?.files.map((file) => (
            <FileBlock key={file.path} t={t} path={file.path} language={file.language} content={file.content} />
          ))}
        </div>
      </div>
    </div>
  );
}

function FileBlock({ t, path, language, content }: { t: Strings; path: string; language: string; content: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }

  function download() {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'artifact.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{
      border: '1px solid var(--line)',
      borderRadius: 'var(--r-2)',
      background: 'var(--bg-1)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)',
        padding: '8px var(--s-3)',
        borderBottom: '1px solid var(--line)',
        background: 'var(--bg-2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{path}</span>
          <span className="pill" style={{ fontSize: 10, flexShrink: 0 }}>{language}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={copy}>
            {copied ? t.copied : t.copy}
          </button>
          <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={download}>
            {t.download}
          </button>
        </div>
      </div>
      <pre className="scroll" style={{
        margin: 0,
        padding: 'var(--s-3)',
        maxHeight: 320,
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--fg-2)',
        whiteSpace: 'pre',
      }}>{content}</pre>
    </div>
  );
}

// ===========================================================================
// Small presentational helpers (carried from the original aesthetic).
// ===========================================================================

function SummaryStat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div style={{
      padding: 'var(--s-4)',
      background: 'var(--bg-1)',
      border: '1px solid var(--line)',
      borderRadius: 'var(--r-3)',
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: accent }} />
      <div className="mono-cap">{label}</div>
      <div style={{
        fontFamily: 'var(--font-display)',
        fontSize: 28, fontWeight: 600,
        letterSpacing: '-0.02em',
        color: accent,
        marginTop: 4,
      }}>{value}</div>
    </div>
  );
}

function DiffRow({ label, status }: { label: string; status: 'new' | 'ok' }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <span style={{ color: 'var(--fg-2)' }}>{label}</span>
      {status === 'new'
        ? <span className="tag ai" style={{ flexShrink: 0 }}>NEW</span>
        : <span className="tag ok" style={{ flexShrink: 0 }}>OK</span>}
    </div>
  );
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" style={{ animation: 'og-spin 0.8s linear infinite' }}>
      <circle cx="12" cy="12" r="9" stroke="white" strokeOpacity="0.3" strokeWidth="3" fill="none" />
      <path d="M21 12 a9 9 0 0 0 -9 -9" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}
