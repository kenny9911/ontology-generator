// Processes review — list left, a WorkflowStep flow graph on the right.
// Now driven by the canonical Ontology model (ctrl.ontology.processes): each
// step resolves its actionTypeId -> action name, next-edges are annotated with
// condition / onEventTypeId, and the header surfaces actors, objectTypeIds,
// triggers, and the orchestration spec. The original flow-diagram aesthetic
// (numbered step cards + dashed connector arrows, '.ontogen' classes,
// CSS-var styling, EN/中文) is preserved — only the data source changed.
import { useMemo, useState, Fragment } from 'react';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import type {
  Ontology,
  Process,
  WorkflowStep,
  ProcessEdge,
  ActionType,
  EventType,
  ObjectType,
  ActorRef,
  ProcessTrigger,
  ReviewStatus,
} from '@/ontology/schema/types';

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

function orchStrategyLabel(strategy: Process['orchestration']['strategy'], lang: Lang): string {
  switch (strategy) {
    case 'event_driven':
      return lang === 'zh' ? '事件驱动' : 'Event-driven';
    case 'state_machine':
      return lang === 'zh' ? '状态机' : 'State machine';
    case 'sequential':
    default:
      return lang === 'zh' ? '顺序执行' : 'Sequential';
  }
}

function onFailureLabel(of: NonNullable<Process['orchestration']['onFailure']>, lang: Lang): string {
  switch (of) {
    case 'compensate':
      return lang === 'zh' ? '补偿回滚' : 'Compensate';
    case 'escalate':
      return lang === 'zh' ? '升级处理' : 'Escalate';
    case 'halt':
    default:
      return lang === 'zh' ? '中止' : 'Halt';
  }
}

function triggerLabel(tr: ProcessTrigger, lang: Lang, evName: (id: string) => string): string {
  switch (tr.kind) {
    case 'event':
      return tr.eventTypeId
        ? `${lang === 'zh' ? '事件' : 'Event'} · ${evName(tr.eventTypeId)}`
        : lang === 'zh'
          ? '事件'
          : 'Event';
    case 'schedule':
      return `${lang === 'zh' ? '定时' : 'Schedule'}${tr.schedule ? ` · ${tr.schedule}` : ''}`;
    case 'manual':
    default:
      return lang === 'zh' ? '手动' : 'Manual';
  }
}

export default function ProcessesScreen({ t, lang, ctrl }: ProcessesScreenProps) {
  const ontology: Ontology | null = ctrl.ontology;
  const processes: Process[] = ontology?.processes ?? [];

  const [selectedId, setSelectedId] = useState<string | undefined>(processes[0]?.id);

  // Keep selection valid as the working ontology mutates underneath us.
  const sel: Process | undefined =
    processes.find((p) => p.id === selectedId) ?? processes[0];

  // ---- id -> name resolvers against the earlier ontology layers --------------
  const actionById = useMemo(() => {
    const m = new Map<string, ActionType>();
    for (const a of ontology?.actions ?? []) m.set(a.id, a);
    return m;
  }, [ontology]);

  const eventById = useMemo(() => {
    const m = new Map<string, EventType>();
    for (const e of ontology?.events ?? []) m.set(e.id, e);
    return m;
  }, [ontology]);

  const objectById = useMemo(() => {
    const m = new Map<string, ObjectType>();
    for (const o of ontology?.objects ?? []) m.set(o.id, o);
    return m;
  }, [ontology]);

  const stepById = useMemo(() => {
    const m = new Map<string, WorkflowStep>();
    for (const s of sel?.steps ?? []) m.set(s.id, s);
    return m;
  }, [sel]);

  const actionName = (id: string): string => {
    const a = actionById.get(id);
    return a ? loc(a.name, a.nameZh, lang) : id;
  };
  const eventName = (id: string): string => {
    const e = eventById.get(id);
    return e ? loc(e.name, e.nameZh, lang) : id;
  };
  const objectName = (id: string): string => {
    const o = objectById.get(id);
    return o ? loc(o.name, o.nameZh, lang) : id;
  };
  const stepName = (id: string): string => {
    const s = stepById.get(id);
    return s ? actionName(s.actionTypeId) : id;
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
                {sel.description && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 13,
                      lineHeight: 1.55,
                      color: 'var(--fg-3)',
                      maxWidth: 620,
                    }}
                  >
                    {sel.description}
                  </div>
                )}
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
              </div>
              {/* Review controls — wired to ctrl */}
              <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
                <button
                  className="btn ghost"
                  onClick={() => ctrl.setReview('process', sel.id, 'rejected')}
                >
                  {t.reject}
                </button>
                <button className="btn ghost" onClick={() => void ctrl.reRunStage('processes')}>
                  {t.reRun}
                </button>
                <button
                  className={sel.reviewState === 'accepted' ? 'btn' : 'btn primary'}
                  onClick={() => ctrl.setReview('process', sel.id, 'accepted')}
                >
                  {sel.reviewState === 'accepted' ? '✓ ' + t.accepted : t.accept}
                </button>
              </div>
            </div>

            {/* Meta row: actors · objects · triggers */}
            <div
              style={{
                marginTop: 'var(--s-4)',
                display: 'flex',
                gap: 'var(--s-6)',
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div className="mono-cap">{t.procActors}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  {sel.actors.map((a, i) => (
                    <span key={`${a.role}-${i}`} className="tag">
                      {actorLabel(a, lang)}
                      <span style={{ color: 'var(--fg-4)', marginLeft: 6, fontSize: 10 }}>
                        {a.kind}
                      </span>
                    </span>
                  ))}
                  {sel.actors.length === 0 && <span className="mono-cap">—</span>}
                </div>
              </div>

              <div>
                <div className="mono-cap">{t.procObjects}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  {sel.objectTypeIds.map((oid) => (
                    <span
                      key={oid}
                      className="tag"
                      style={{
                        background: 'color-mix(in oklab, var(--accent-3) 14%, transparent)',
                        color: 'var(--accent-3)',
                        borderColor: 'color-mix(in oklab, var(--accent-3) 30%, transparent)',
                      }}
                    >
                      {objectName(oid)}
                    </span>
                  ))}
                  {sel.objectTypeIds.length === 0 && <span className="mono-cap">—</span>}
                </div>
              </div>

              <div>
                <div className="mono-cap">{t.triggers}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  {sel.triggers.map((tr, i) => (
                    <span
                      key={i}
                      className="tag"
                      style={{
                        background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
                        color: 'var(--accent)',
                        borderColor: 'color-mix(in oklab, var(--accent) 28%, transparent)',
                      }}
                    >
                      {triggerLabel(tr, lang, eventName)}
                    </span>
                  ))}
                  {sel.triggers.length === 0 && <span className="mono-cap">—</span>}
                </div>
              </div>
            </div>

            {/* Orchestration spec */}
            <div
              className="card"
              style={{
                marginTop: 'var(--s-4)',
                padding: 'var(--s-3) var(--s-4)',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s-5)',
                flexWrap: 'wrap',
              }}
            >
              <div className="mono-cap" style={{ color: 'var(--fg-3)' }}>
                {t.orchestration}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="mono-cap">{t.orchStrategy}</span>
                <span className="tag">{orchStrategyLabel(sel.orchestration.strategy, lang)}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="mono-cap">{t.agentOrchestrated}</span>
                <span
                  className="tag"
                  style={
                    sel.orchestration.agentOrchestrated
                      ? {
                          background: 'color-mix(in oklab, var(--accent-3) 14%, transparent)',
                          color: 'var(--accent-3)',
                          borderColor: 'color-mix(in oklab, var(--accent-3) 30%, transparent)',
                        }
                      : undefined
                  }
                >
                  {sel.orchestration.agentOrchestrated ? (lang === 'zh' ? '是' : 'Yes') : lang === 'zh' ? '否' : 'No'}
                </span>
              </div>
              {sel.orchestration.onFailure && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="mono-cap">{lang === 'zh' ? '失败时' : 'On failure'}</span>
                  <span
                    className="tag"
                    style={{
                      background: 'color-mix(in oklab, var(--warn) 14%, transparent)',
                      color: 'var(--warn)',
                      borderColor: 'color-mix(in oklab, var(--warn) 30%, transparent)',
                    }}
                  >
                    {onFailureLabel(sel.orchestration.onFailure, lang)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Flow diagram — driven by the WorkflowStep graph */}
          <div className="scroll grid-bg" style={{ flex: 1, padding: 'var(--s-6) var(--s-7)' }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 0,
                maxWidth: 820,
                margin: '0 auto',
              }}
            >
              {sel.steps.map((s, i) => {
                const act = actionById.get(s.actionTypeId);
                // Linear "fall-through" edge to the next step in display order —
                // suppressed when the step already names that step in `next`.
                const nextInOrder = sel.steps[i + 1];
                const edges: ProcessEdge[] = s.next;
                const hasExplicitToNext =
                  nextInOrder != null && edges.some((e) => e.toStepId === nextInOrder.id);
                const isTerminal = edges.length === 0;

                return (
                  <Fragment key={s.id}>
                    {/* Step card */}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr auto',
                        alignItems: 'center',
                        gap: 'var(--s-4)',
                        padding: 'var(--s-4) var(--s-5)',
                        background: 'var(--bg-1)',
                        border: '1px solid var(--line)',
                        borderRadius: 'var(--r-3)',
                      }}
                    >
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          background: 'var(--bg-3)',
                          border: '1px solid var(--line)',
                          display: 'grid',
                          placeItems: 'center',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 12,
                          color: 'var(--accent)',
                        }}
                      >
                        {String(s.order ?? i + 1).padStart(2, '0')}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, color: 'var(--fg)', fontWeight: 500 }}>
                          {actionName(s.actionTypeId)}
                        </div>
                        <div
                          className="mono-cap"
                          style={{ marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}
                        >
                          <span style={{ color: 'var(--fg-4)' }}>{s.actionTypeId}</span>
                          {s.actorRole && (
                            <span style={{ color: 'var(--fg-3)' }}>· {s.actorRole}</span>
                          )}
                          {act?.agent?.toolName && (
                            <span style={{ color: 'var(--accent-2)' }}>
                              · {act.agent.toolName}()
                            </span>
                          )}
                        </div>
                      </div>
                      {isTerminal ? (
                        <span
                          className="tag"
                          style={{
                            background: 'color-mix(in oklab, var(--fg-3) 12%, transparent)',
                            color: 'var(--fg-3)',
                            borderColor: 'color-mix(in oklab, var(--fg-3) 26%, transparent)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {lang === 'zh' ? '终止' : 'End'}
                        </span>
                      ) : (
                        <span
                          className="tag"
                          style={{
                            background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                            color: 'var(--accent)',
                            borderColor: 'color-mix(in oklab, var(--accent) 30%, transparent)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {edges.length} {t.next.toLowerCase()}
                        </span>
                      )}
                    </div>

                    {/* Branch edges that DON'T just fall through to the next step:
                        render them as labeled jump rows so conditions /
                        onEventTypeId / target are explicit. */}
                    {edges
                      .filter((e) => !(nextInOrder && e.toStepId === nextInOrder.id))
                      .map((e, ei) => (
                        <div
                          key={`${s.id}-edge-${ei}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--s-3)',
                            margin: '6px 0 6px var(--s-6)',
                            padding: '6px 10px',
                            background: 'var(--bg-1)',
                            border: '1px dashed var(--line-strong)',
                            borderRadius: 'var(--r-2)',
                            fontSize: 12,
                          }}
                        >
                          <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
                            <path
                              d="M0 6 H11 M8 3 L12 6 L8 9"
                              stroke="var(--accent)"
                              strokeWidth="1.4"
                              fill="none"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          <span style={{ color: 'var(--fg-3)' }}>
                            {lang === 'zh' ? '跳转至' : 'to'}
                          </span>
                          <span style={{ color: 'var(--accent)', fontWeight: 500 }}>
                            {stepName(e.toStepId)}
                          </span>
                          {e.onEventTypeId && (
                            <span
                              className="mono-cap"
                              style={{
                                padding: '2px 6px',
                                borderRadius: 3,
                                background: 'color-mix(in oklab, var(--accent-2) 14%, transparent)',
                                color: 'var(--accent-2)',
                              }}
                            >
                              {t.onEvent}: {eventName(e.onEventTypeId)}
                            </span>
                          )}
                          {e.condition && (
                            <span
                              style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11,
                                color: 'var(--warn)',
                              }}
                            >
                              {e.condition}
                            </span>
                          )}
                          {e.label && (
                            <span style={{ color: 'var(--fg-4)' }}>{biq(e.label, lang)}</span>
                          )}
                        </div>
                      ))}

                    {/* Connector arrow to the next step in display order. Annotated
                        when an explicit edge targets it with a condition / event. */}
                    {nextInOrder && (
                      <div
                        style={{
                          minHeight: 28,
                          display: 'flex',
                          justifyContent: 'center',
                          alignItems: 'center',
                          gap: 'var(--s-3)',
                          flexWrap: 'wrap',
                          padding: '4px 0',
                        }}
                      >
                        <svg width="18" height="28" viewBox="0 0 18 28" fill="none">
                          <line
                            x1="9"
                            y1="0"
                            x2="9"
                            y2="22"
                            stroke="var(--line-strong)"
                            strokeWidth="1"
                            strokeDasharray="2 3"
                          />
                          <path
                            d="M5 20 L9 24 L13 20"
                            stroke="var(--accent)"
                            strokeWidth="1.4"
                            fill="none"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        {hasExplicitToNext &&
                          edges
                            .filter((e) => e.toStepId === nextInOrder.id)
                            .map((e, ei) =>
                              e.condition || e.onEventTypeId || e.label ? (
                                <span
                                  key={`fall-${ei}`}
                                  className="mono-cap"
                                  style={{
                                    padding: '2px 8px',
                                    borderRadius: 3,
                                    background: 'var(--bg-2)',
                                    border: '1px solid var(--line)',
                                    color: 'var(--fg-3)',
                                  }}
                                >
                                  {e.onEventTypeId
                                    ? `${t.onEvent}: ${eventName(e.onEventTypeId)}`
                                    : e.condition
                                      ? e.condition
                                      : e.label
                                        ? biq(e.label, lang)
                                        : ''}
                                </span>
                              ) : null,
                            )}
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
