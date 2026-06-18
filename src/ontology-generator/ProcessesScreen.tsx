// Processes review — list left, a WorkflowStep flow graph on the right.
// Now driven by the canonical Ontology model (ctrl.ontology.processes): each
// step resolves its actionTypeId -> action name, next-edges are annotated with
// condition / onEventTypeId, and the header surfaces actors, objectTypeIds,
// triggers, and the orchestration spec. The original flow-diagram aesthetic
// (numbered step cards + dashed connector arrows, '.ontogen' classes,
// CSS-var styling, EN/中文) is preserved — only the data source changed.
import { useMemo, useState } from 'react';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import type {
  Ontology,
  Process,
  ActorRef,
  ReviewStatus,
} from '@/ontology/schema/types';
import CleanNodeCard from './CleanNodeCard';
import CleanNodeEditor from './CleanNodeEditor';
import { toCleanNodes, fromCleanNodes } from './json-editor/clean';

interface ProcessesScreenProps {
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
}

/** A required-bilingual value localized to the active language. */
function biq(v: { en: string; zh: string }, lang: Lang): string {
  return lang === 'zh' ? v.zh || v.en : v.en;
}

/** An optional-zh value localized to the active language. */
function loc(en: string, zh: string | undefined, lang: Lang): string {
  return lang === 'zh' ? zh || en : en;
}

/** Localized actor role label. */
function actorLabel(a: ActorRef, lang: Lang): string {
  return loc(a.role, a.roleZh, lang);
}

/** Visual accent per review status (mirrors the other review screens). */
const STATUS_COLOR: Record<ReviewStatus, string> = {
  pending: 'var(--accent-2)',
  accepted: 'var(--accent-3)',
  edited: 'var(--accent)',
  merged: 'var(--fg-3)',
  rejected: 'var(--warn)',
};

function statusLabel(t: Strings, status: ReviewStatus): string {
  switch (status) {
    case 'accepted':
      return t.accepted;
    case 'edited':
      return t.edited;
    case 'merged':
      return t.merged;
    case 'rejected':
      return t.rejected;
    case 'pending':
    default:
      return t.pending;
  }
}

export default function ProcessesScreen({ t, lang, ctrl }: ProcessesScreenProps) {
  const ontology: Ontology | null = ctrl.ontology;
  const processes: Process[] = ontology?.processes ?? [];
  const pendingCount = processes.filter(
    (p) => p.reviewState !== 'accepted' && p.reviewState !== 'rejected',
  ).length;

  const [selectedId, setSelectedId] = useState<string | undefined>(processes[0]?.id);

  // Keep selection valid as the working ontology mutates underneath us.
  const sel: Process | undefined =
    processes.find((p) => p.id === selectedId) ?? processes[0];

  // The clean sample-shaped projection of the selected workflow (description +
  // `actions` steps + receipts) — exactly what the JSON editor / `generate spec`
  // show. id/name/actor/trigger/triggered_event are in the header; sources, the
  // structural step graph, actor/object/trigger meta + orchestration are dropped.
  const cleanSel = useMemo(
    () => (sel && ontology ? (toCleanNodes('processes', [sel], ontology)[0] as Record<string, unknown>) : undefined),
    [sel, ontology],
  );
  const [editing, setEditing] = useState(false);
  const saveClean = (edited: Record<string, unknown>): void => {
    if (!ontology || !sel) return;
    const merged = fromCleanNodes('processes', [edited], ontology)[0] as Record<string, unknown>;
    ctrl.editEntity('process', sel.id, merged);
    setEditing(false);
  };

  // ---- empty state -----------------------------------------------------------
  if (!ontology || processes.length === 0) {
    return (
      <div className="screen" style={{ placeItems: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--fg-3)', maxWidth: 420 }}>
          <div className="mono-cap">{lang === 'zh' ? '05 · 流程' : '05 · PROCESSES'}</div>
          <h2
            style={{
              margin: '8px 0 6px',
              fontFamily: 'var(--font-display)',
              fontSize: 22,
              fontWeight: 600,
            }}
          >
            {t.procTitle}
          </h2>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            {lang === 'zh'
              ? '尚无流程。请先在“发现”阶段抽取流程层。'
              : 'No processes yet. Extract the process layer in Discover first.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen" style={{ gridTemplateColumns: '300px 1fr', gap: 0 }}>
      {/* Left: process list */}
      <div
        style={{
          borderRight: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div style={{ padding: 'var(--s-5)', borderBottom: '1px solid var(--line)' }}>
          <div className="mono-cap">{lang === 'zh' ? '05 · 流程' : '05 · PROCESSES'}</div>
          <h2
            style={{
              margin: '6px 0 2px',
              fontFamily: 'var(--font-display)',
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: '-0.01em',
            }}
          >
            {t.procTitle}
          </h2>
          <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>
            {processes.length} {lang === 'zh' ? '条流程' : 'processes'}
          </div>
          <button
            className="btn ghost"
            style={{ marginTop: 'var(--s-3)', width: '100%', padding: '6px 10px', fontSize: 12 }}
            disabled={ctrl.running || pendingCount === 0}
            onClick={() => void ctrl.acceptAll('process')}
          >
            ✓ {t.acceptAll}
            {pendingCount > 0 && <span style={{ color: 'var(--fg-4)', marginLeft: 6 }}>· {pendingCount}</span>}
          </button>
        </div>
        <div className="scroll" style={{ padding: 'var(--s-2)', flex: 1 }}>
          {processes.map((p) => {
            const isSel = p.id === sel?.id;
            return (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                style={{
                  width: '100%',
                  display: 'block',
                  padding: 'var(--s-3)',
                  background: isSel ? 'var(--bg-2)' : 'transparent',
                  border: `1px solid ${isSel ? 'var(--accent)' : 'transparent'}`,
                  borderRadius: 'var(--r-2)',
                  marginBottom: 2,
                  textAlign: 'left',
                  color: 'var(--fg)',
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 500,
                      fontSize: 13,
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {biq(p.name, lang)}
                  </span>
                  <span className="mono-cap" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {p.steps.length} {t.procSteps.toLowerCase()}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                  {p.actors.slice(0, 3).map((a, i) => (
                    <span
                      key={`${a.role}-${i}`}
                      className="mono-cap"
                      style={{
                        padding: '2px 6px',
                        background: 'var(--bg-3)',
                        borderRadius: 3,
                        color: 'var(--fg-3)',
                      }}
                    >
                      {actorLabel(a, lang)}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: header + workflow-step graph */}
      {sel && (
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Header — name, review controls, actors, objects, triggers, orchestration */}
          <div style={{ padding: 'var(--s-6) var(--s-7) var(--s-4)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--s-4)',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 240 }}>
                <h2
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 28,
                    fontWeight: 600,
                    letterSpacing: '-0.02em',
                    margin: 0,
                  }}
                >
                  {biq(sel.name, lang)}
                </h2>
                <div className="mono-cap" style={{ marginTop: 8 }}>
                  <span style={{ color: STATUS_COLOR[sel.reviewState] }}>
                    {statusLabel(t, sel.reviewState)}
                  </span>
                  {' · '}
                  {t.confidence}:{' '}
                  <span style={{ color: 'var(--accent-2)' }}>
                    {(sel.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                {/* Spec-format workflow strip */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
                  {(sel.actor ?? []).map((a) => (
                    <span key={`a${a}`} className="tag">{a}</span>
                  ))}
                  {(sel.trigger ?? []).map((ev) => (
                    <span key={`t${ev}`} className="tag" title={t.trigger}>← {ev}</span>
                  ))}
                  {(sel.triggered_event ?? []).map((ev) => (
                    <span key={`e${ev}`} className="tag ok" title={t.emits}>→ {ev}</span>
                  ))}
                </div>
              </div>
              {/* Review controls — wired to ctrl (editor carries its own Save/Cancel) */}
              {!editing && (
                <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
                  <button
                    className="btn ghost"
                    onClick={() => void ctrl.reviewOne('process', sel.id, 'rejected')}
                  >
                    {t.reject}
                  </button>
                  <button className="btn ghost" onClick={() => setEditing(true)}>
                    {t.edit}
                  </button>
                  <button
                    className="btn ghost"
                    disabled={ctrl.running || ctrl.mode === 'demo'}
                    onClick={() => void ctrl.reRunStage('processes')}
                    title={t.reRunStage}
                  >
                    {t.reRun}
                  </button>
                  <button
                    className={sel.reviewState === 'accepted' ? 'btn' : 'btn primary'}
                    onClick={() =>
                      void ctrl.reviewOne(
                        'process',
                        sel.id,
                        sel.reviewState === 'accepted' ? 'pending' : 'accepted',
                      )
                    }
                  >
                    {sel.reviewState === 'accepted' ? '✓ ' + t.accepted : t.accept}
                  </button>
                </div>
              )}
            </div>

          </div>

          {/* Clean sample-shaped workflow view: description + `actions` (the
              clean workflow steps) + receipts. id/name/actor/trigger/
              triggered_event are in the header + spec strip above; the structural
              actors/object/trigger meta, orchestration, and step DAG are dropped
              (not part of the clean sample shape). */}
          <div className="scroll" style={{ flex: 1, padding: 'var(--s-6) var(--s-7)' }}>
            {cleanSel &&
              (editing ? (
                <CleanNodeEditor node={cleanSel} lang={lang} onSave={saveClean} onCancel={() => setEditing(false)} />
              ) : (
                <CleanNodeCard node={cleanSel} lang={lang} skip={['id', 'name', 'actor', 'trigger', 'triggered_event', 'sources']} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
