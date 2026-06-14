// ActionsScreen — review the discovered ActionTypes (DESIGN_SPEC §8, step 05).
//
// The agentic centerpiece. Reads the canonical Ontology from `ctrl`. For each
// ActionType we render:
//   • typed inputs / outputs — object-typed params resolve to (and label with)
//     their ObjectType; scalar params show their DataType;
//   • ordered steps, each optionally guarded by a Rule and reading/writing objects;
//   • precondition rule chips (severity-colored);
//   • triggeredBy / emits EventType chips (unknown event ids show a NEW tag);
//   • side-effects, actor, and the AgentBinding tool contract (toolName, execution,
//     parameter schema) — what makes the action callable by an agent;
//   • source citations, confidence, reviewState pill + Accept/Edit/Reject/Re-run.
//
// Same three-column `.screen` grid + visual language as ObjectsScreen/EventsScreen;
// all mutation flows through the controller. Compiles under strict /
// noUnusedLocals / noUnusedParameters. No `any`.
import { useMemo, useState, type ReactNode } from 'react';

import type {
  ActionIO,
  ActionStep,
  ActionType,
  AgentBinding,
  EmitSpec,
  EventType,
  ObjectType,
  PreconditionRef,
  Rule,
  ReviewStatus,
  Severity,
  SideEffect,
} from '@/ontology/schema/types';

import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';

interface ActionsScreenProps {
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
}

/** Map a ReviewStatus to a `.tag` variant + localized label. */
function reviewTag(status: ReviewStatus, t: Strings): { cls: string; label: string } {
  switch (status) {
    case 'accepted':
      return { cls: 'tag ok', label: t.accepted };
    case 'edited':
      return { cls: 'tag ai', label: t.edited };
    case 'merged':
      return { cls: 'tag', label: t.merged };
    case 'rejected':
      return { cls: 'tag warn', label: t.rejected };
    case 'pending':
    default:
      return { cls: 'tag warn', label: t.pending };
  }
}

/** Severity → color + localized label (block is the most blocking). */
function severityMeta(sev: Severity | undefined, t: Strings): { color: string; label: string } {
  switch (sev) {
    case 'block':
      return { color: 'var(--danger)', label: t.sevBlock };
    case 'warn':
      return { color: 'var(--warn)', label: t.sevWarn };
    case 'info':
    default:
      return { color: 'var(--accent-2)', label: t.sevInfo };
  }
}

export default function ActionsScreen({ t, lang, ctrl }: ActionsScreenProps) {
  const ontology = ctrl.ontology;
  const actions: ActionType[] = useMemo(() => ontology?.actions ?? [], [ontology]);

  const [selectedId, setSelectedId] = useState<string | undefined>(actions[0]?.id);
  const sel = actions.find((a) => a.id === selectedId) ?? actions[0];

  // ---- id → display-name resolvers (against the working ontology layers) ----
  const objectsById = useMemo(() => {
    const m = new Map<string, ObjectType>();
    for (const o of ontology?.objects ?? []) m.set(o.id, o);
    return m;
  }, [ontology]);
  const rulesById = useMemo(() => {
    const m = new Map<string, Rule>();
    for (const r of ontology?.rules ?? []) m.set(r.id, r);
    return m;
  }, [ontology]);
  const eventsById = useMemo(() => {
    const m = new Map<string, EventType>();
    for (const e of ontology?.events ?? []) m.set(e.id, e);
    return m;
  }, [ontology]);

  const objectName = (id: string): string => {
    const o = objectsById.get(id);
    if (!o) return id;
    return lang === 'zh' ? o.nameZh || o.name : o.name;
  };
  const ruleTitle = (id: string): string => {
    const r = rulesById.get(id);
    if (!r) return id;
    return (lang === 'zh' ? r.titleZh || r.title : r.title) || id;
  };
  const ruleSeverity = (id: string): Severity | undefined => rulesById.get(id)?.severity;
  const eventKnown = (id: string): boolean => eventsById.has(id);
  const eventName = (id: string): string => {
    const e = eventsById.get(id);
    if (!e) return id;
    return lang === 'zh' ? e.nameZh || e.name : e.name;
  };

  const actionName = (a: ActionType): string => (lang === 'zh' ? a.nameZh || a.name : a.name);
  const actionDesc = (a: ActionType): string | undefined =>
    (lang === 'zh' ? a.descriptionZh : a.description) ?? a.description;

  // Empty state — the actions stage hasn't produced anything yet.
  if (!ontology || actions.length === 0) {
    return (
      <div className="screen" style={{ placeItems: 'center', padding: 'var(--s-7)' }}>
        <div style={{ textAlign: 'center', maxWidth: 440 }}>
          <div className="mono-cap">{lang === 'zh' ? '05 · 动作' : '05 · ACTIONS'}</div>
          <h2 style={{ margin: '8px 0 6px', fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em' }}>
            {t.actionsTitle}
          </h2>
          <p style={{ color: 'var(--fg-3)', fontSize: 13, margin: 0 }}>{t.actionsSub}</p>
        </div>
      </div>
    );
  }

  const acceptedCount = actions.filter((a) => a.reviewState === 'accepted').length;
  const pendingCount = actions.filter(
    (a) => a.reviewState !== 'accepted' && a.reviewState !== 'rejected',
  ).length;

  return (
    <div className="screen" style={{ gridTemplateColumns: '300px 1fr 320px', gap: 0 }}>
      {/* ---- Left: action list ------------------------------------------- */}
      <div style={{ borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 'var(--s-5)', borderBottom: '1px solid var(--line)' }}>
          <div className="mono-cap">{lang === 'zh' ? '05 · 动作' : '05 · ACTIONS'}</div>
          <h2 style={{ margin: '6px 0 2px', fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>
            {t.actionsTitle}
          </h2>
          <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>
            {acceptedCount} {t.of} {actions.length} {t.accepted.toLowerCase()}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 'var(--s-3)', flexWrap: 'wrap' }}>
            <button
              className="btn ghost"
              style={{ flex: 1, padding: '6px 10px', fontSize: 12 }}
              disabled={ctrl.running || pendingCount === 0}
              onClick={() => void ctrl.acceptAll('action')}
            >
              ✓ {t.acceptAll}
              {pendingCount > 0 && <span style={{ color: 'var(--fg-4)', marginLeft: 6 }}>· {pendingCount}</span>}
            </button>
            <button
              className="btn ghost"
              style={{ padding: '6px 10px', fontSize: 12 }}
              disabled={ctrl.running || ctrl.mode === 'demo'}
              onClick={() => void ctrl.reRunStage('actions')}
              title={t.reRunStage}
            >
              ↻
            </button>
          </div>
        </div>

        <div className="scroll" style={{ padding: 'var(--s-2)', flex: 1 }}>
          {actions.map((a) => {
            const isSel = a.id === sel?.id;
            const done = a.reviewState === 'accepted';
            return (
              <button
                key={a.id}
                onClick={() => setSelectedId(a.id)}
                style={{
                  width: '100%',
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr auto',
                  alignItems: 'center',
                  gap: 'var(--s-3)',
                  padding: 'var(--s-3)',
                  background: isSel ? 'var(--bg-2)' : 'transparent',
                  border: `1px solid ${isSel ? 'var(--accent)' : 'transparent'}`,
                  borderRadius: 'var(--r-2)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: 'var(--fg)',
                  marginBottom: 2,
                }}
              >
                <span style={{ width: 26, height: 26, borderRadius: 6, background: 'var(--bg-3)', display: 'grid', placeItems: 'center', fontSize: 13, border: '1px solid var(--line)', color: 'var(--accent)' }}>
                  ⚡
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {actionName(a)}
                  </div>
                  <div className="mono-cap" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.agent?.toolName ?? a.name}
                  </div>
                </div>
                {done ? (
                  <span style={{ color: 'var(--accent-3)', fontSize: 14 }}>✓</span>
                ) : (
                  <span className="mono-cap" style={{ color: 'var(--accent-2)' }}>{(a.confidence * 100).toFixed(0)}%</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- Center: selected action detail ------------------------------ */}
      {sel && (
        <div className="scroll" style={{ padding: 'var(--s-6)', display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
          <ActionHeader action={sel} title={actionName(sel)} description={actionDesc(sel)} t={t} lang={lang} ctrl={ctrl} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-5)' }}>
            <IOSection title={t.inputs} io={sel.inputs} t={t} objectName={objectName} />
            <IOSection title={t.outputs} io={sel.outputs} t={t} objectName={objectName} />
          </div>

          <StepsSection steps={sel.steps} t={t} lang={lang} objectName={objectName} ruleTitle={ruleTitle} />

          {sel.preconditions.length > 0 && (
            <ChipSection title={t.preconditions}>
              {sel.preconditions.map((p: PreconditionRef) => {
                const meta = severityMeta(p.severity ?? ruleSeverity(p.ruleId), t);
                return (
                  <span
                    key={p.ruleId}
                    title={p.ruleId}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'var(--bg-1)', border: `1px solid ${meta.color}`, borderRadius: 999, fontSize: 12, color: meta.color }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: meta.color }} />
                    {ruleTitle(p.ruleId)}
                    <span className="mono-cap" style={{ color: meta.color }}>{meta.label}</span>
                  </span>
                );
              })}
            </ChipSection>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-5)' }}>
            <ChipSection title={t.triggeredBy}>
              {sel.triggeredByEventIds.length === 0 ? (
                <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>—</span>
              ) : (
                sel.triggeredByEventIds.map((id) => <EventChip key={id} label={eventName(id)} known={eventKnown(id)} t={t} arrow="←" accent="var(--accent)" />)
              )}
            </ChipSection>
            <ChipSection title={t.emits}>
              {sel.emitsEvents.length === 0 ? (
                <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>—</span>
              ) : (
                sel.emitsEvents.map((e: EmitSpec, i) => (
                  <EventChip key={e.eventTypeId + i} label={eventName(e.eventTypeId)} known={eventKnown(e.eventTypeId)} t={t} arrow="→" accent="var(--accent-3)" on={e.on} />
                ))
              )}
            </ChipSection>
          </div>

          {sel.sideEffects && sel.sideEffects.length > 0 && (
            <section>
              <div className="mono-cap" style={{ marginBottom: 'var(--s-3)' }}>{t.sideEffects}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {sel.sideEffects.map((s: SideEffect, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', fontSize: 13, color: 'var(--fg-2)' }}>
                    <span className="tag warn" style={{ flexShrink: 0 }}>{s.kind}</span>
                    <span>{s.description}{s.objectTypeId ? ` · ${objectName(s.objectTypeId)}` : ''}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <AgentBindingSection agent={sel.agent} actorLabel={actorLabel(sel, lang)} t={t} />
        </div>
      )}

      {/* ---- Right: source citations ------------------------------------ */}
      {sel && <CitationsPanel action={sel} t={t} lang={lang} />}
    </div>
  );
}

function actorLabel(a: ActionType, lang: Lang): string {
  const role = (lang === 'zh' ? a.actor.roleZh || a.actor.role : a.actor.role) || a.actor.role;
  return `${role} · ${a.actor.kind}`;
}

// ===========================================================================
// Header — name, tool name, confidence, reviewState pill + review controls.
// ===========================================================================

function ActionHeader({
  action,
  title,
  description,
  t,
  lang,
  ctrl,
}: {
  action: ActionType;
  title: string;
  description?: string;
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
}) {
  const tag = reviewTag(action.reviewState, t);
  const accepted = action.reviewState === 'accepted';

  const onEditName = () => {
    const next = window.prompt(t.actionsTitle, action.name);
    if (next != null && next.trim() && next.trim() !== action.name) {
      ctrl.editEntity('action', action.id, { name: next.trim() });
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
      <span style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--bg-2)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', fontSize: 22, color: 'var(--accent)', flexShrink: 0 }}>
        ⚡
      </span>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', margin: 0 }}>{title}</h2>
          {lang === 'zh' && action.nameZh && action.nameZh !== title && (
            <span style={{ color: 'var(--fg-3)', fontSize: 16 }}>{action.nameZh}</span>
          )}
          <span className="tag ai" style={{ whiteSpace: 'nowrap' }}>{action.actor.kind}</span>
          <span className={tag.cls} style={{ whiteSpace: 'nowrap' }}>{tag.label}</span>
        </div>
        <div className="mono-cap" style={{ marginTop: 4, fontSize: 11, color: 'var(--accent)' }}>
          {action.agent?.toolName}()
        </div>
        {description && (
          <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--fg-2)' }}>{description}</p>
        )}
        <div className="mono-cap" style={{ marginTop: 6 }}>
          {t.confidence}: <span style={{ color: 'var(--accent-2)' }}>{(action.confidence * 100).toFixed(1)}%</span>
          {' · '}
          {action.sources.length} {t.sources.toLowerCase()}
          {' · '}
          {t.actor}: {actorLabel(action, lang)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
        <button className="btn ghost" onClick={() => void ctrl.reviewOne('action', action.id, 'rejected')}>{t.reject}</button>
        <button className="btn ghost" onClick={onEditName}>{t.edit}</button>
        <button className={accepted ? 'btn' : 'btn primary'} onClick={() => void ctrl.reviewOne('action', action.id, accepted ? 'pending' : 'accepted')}>
          {accepted ? '✓ ' + t.accepted : t.accept}
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Inputs / Outputs — typed IO chips (object-typed resolve to the ObjectType).
// ===========================================================================

function IOSection({
  title,
  io,
  t,
  objectName,
}: {
  title: string;
  io: ActionIO[];
  t: Strings;
  objectName: (id: string) => string;
}) {
  return (
    <section>
      <div className="mono-cap" style={{ marginBottom: 'var(--s-3)' }}>{title}</div>
      {io.length === 0 ? (
        <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>—</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {io.map((p, i) => {
            const isObj = !!p.objectTypeId;
            return (
              <div key={p.name + i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                <span style={{ color: 'var(--fg-2)', fontWeight: 500 }}>{p.name}</span>
                <span style={{ color: 'var(--fg-4)' }}>:</span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: isObj ? 'color-mix(in oklab, var(--accent) 12%, transparent)' : 'var(--bg-2)',
                    border: `1px solid ${isObj ? 'color-mix(in oklab, var(--accent) 30%, transparent)' : 'var(--line)'}`,
                    color: isObj ? 'var(--accent)' : 'var(--fg-3)',
                  }}
                >
                  {isObj && p.objectTypeId ? objectName(p.objectTypeId) : p.type ?? 'json'}
                  {p.isArray || p.cardinality === 'many' ? '[]' : ''}
                </span>
                {p.required && <span className="mono-cap" style={{ color: 'var(--warn)' }}>{t.required.toLowerCase()}</span>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ===========================================================================
// Steps — ordered execution plan; guard + read/write object chips.
// ===========================================================================

function StepsSection({
  steps,
  t,
  lang,
  objectName,
  ruleTitle,
}: {
  steps: ActionStep[];
  t: Strings;
  lang: Lang;
  objectName: (id: string) => string;
  ruleTitle: (id: string) => string;
}) {
  if (steps.length === 0) return null;
  const ordered = [...steps].sort((a, b) => a.order - b.order);
  return (
    <section>
      <div className="mono-cap" style={{ marginBottom: 'var(--s-3)' }}>{t.actionSteps}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        {ordered.map((s, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--s-3)', alignItems: 'start', padding: 'var(--s-3) var(--s-4)', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 'var(--r-2)' }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--bg-3)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)' }}>
              {String(s.order).padStart(2, '0')}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--fg)' }}>{s.text[lang]}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {s.guardRuleId && <span className="tag warn" title={s.guardRuleId}>{t.guard}: {ruleTitle(s.guardRuleId)}</span>}
                {(s.readsObjectTypeIds ?? []).map((id) => <span key={'r' + id} className="tag" title={t.reads}>↓ {objectName(id)}</span>)}
                {(s.writesObjectTypeIds ?? []).map((id) => <span key={'w' + id} className="tag ok" title={t.writes}>↑ {objectName(id)}</span>)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ===========================================================================
// Small shared layout helpers.
// ===========================================================================

function ChipSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="mono-cap" style={{ marginBottom: 'var(--s-3)' }}>{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{children}</div>
    </section>
  );
}

function EventChip({ label, known, t, arrow, accent, on }: { label: string; known: boolean; t: Strings; arrow: string; accent: string; on?: EmitSpec['on'] }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'var(--bg-1)', border: `1px solid ${known ? 'var(--line)' : 'color-mix(in oklab, var(--accent-2) 40%, transparent)'}`, borderRadius: 999, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
      <span style={{ color: accent }}>{arrow}</span>
      <span style={{ color: 'var(--fg-2)', fontWeight: 500 }}>{label}</span>
      {on && <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>{on}</span>}
      {!known && <span className="tag ai" style={{ padding: '0 6px' }}>{t.new}</span>}
    </span>
  );
}

// ===========================================================================
// AgentBinding — the callable tool contract (what makes the ontology agentic).
// ===========================================================================

function AgentBindingSection({ agent, actorLabel: actorText, t }: { agent: AgentBinding; actorLabel: string; t: Strings }) {
  const params = agent.parameterSchema?.properties ?? {};
  const paramNames = Object.keys(params);
  return (
    <section>
      <div className="mono-cap" style={{ marginBottom: 'var(--s-3)' }}>{t.toolBinding}</div>
      <div className="card" style={{ padding: 'var(--s-4)', display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--accent)', fontWeight: 600 }}>{agent.toolName}()</span>
          <span className="tag">{t.execution}: {agent.execution}</span>
          {agent.integration && <span className="tag ai">{agent.integration}</span>}
          <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>{t.actor}: {actorText}</span>
        </div>
        {agent.toolDescription && (
          <div style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>{agent.toolDescription}</div>
        )}
        <div>
          <div className="mono-cap" style={{ marginBottom: 6 }}>{t.parameterSchema}</div>
          <pre style={{ margin: 0, padding: 'var(--s-3)', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 'var(--r-2)', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-3)', overflowX: 'auto', lineHeight: 1.5 }}>
            {paramNames.length === 0
              ? '{}'
              : `{\n${paramNames.map((k) => `  "${k}": "${params[k]?.type ?? 'object'}"${params[k]?.$objectTypeId ? `  // ${params[k]?.$objectTypeId}` : ''}`).join(',\n')}\n}`}
          </pre>
        </div>
      </div>
    </section>
  );
}

// ===========================================================================
// Citations — the action's SourceRefs (verbatim snippets + locator).
// ===========================================================================

function CitationsPanel({ action, t, lang }: { action: ActionType; t: Strings; lang: Lang }) {
  return (
    <div style={{ borderLeft: '1px solid var(--line)', padding: 'var(--s-5)', display: 'flex', flexDirection: 'column', gap: 'var(--s-3)', minHeight: 0 }}>
      <div className="mono-cap">{t.sources}</div>
      <div className="scroll" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        {action.sources.length === 0 && (
          <div className="mono-cap">{lang === 'zh' ? '暂无直接引用' : 'No direct citations'}</div>
        )}
        {action.sources.map((s, i) => {
          const locator = [
            s.page && s.page > 0 ? `p.${s.page}` : null,
            s.line ? `L${s.line}` : null,
            s.section ?? null,
          ]
            .filter(Boolean)
            .join(' · ');
          const verified = s.quoteVerified !== false;
          return (
            <div key={i} className="card" style={{ padding: 'var(--s-3)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <span className="mono-cap" style={{ color: 'var(--accent)' }}>
                  {s.documentName}
                  {locator && ` · ${locator}`}
                </span>
                <span className="mono-cap" title={verified ? t.quoteVerified : t.quoteUnverified} style={{ color: verified ? 'var(--accent-3)' : 'var(--warn)' }}>
                  {verified ? '✓' : '⚠'}
                </span>
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--fg-2)', borderLeft: '2px solid var(--accent-2)', paddingLeft: 12 }}>
                "{s.snippet}"
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
