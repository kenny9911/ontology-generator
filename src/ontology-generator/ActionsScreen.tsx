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
import { useMemo, useState } from 'react';

import type {
  ActionType,
  ReviewStatus,
} from '@/ontology/schema/types';

import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import CleanNodeCard from './CleanNodeCard';
import CleanNodeEditor from './CleanNodeEditor';
import { toCleanNodes, fromCleanNodes } from './json-editor/clean';

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

export default function ActionsScreen({ t, lang, ctrl }: ActionsScreenProps) {
  const ontology = ctrl.ontology;
  const actions: ActionType[] = useMemo(() => ontology?.actions ?? [], [ontology]);

  const [selectedId, setSelectedId] = useState<string | undefined>(actions[0]?.id);
  const sel = actions.find((a) => a.id === selectedId) ?? actions[0];

  // The clean sample-shaped projection of the selected action (inputs/outputs,
  // action_steps, trigger, triggered_event, target_objects, category,
  // submission_criteria, prompts, tool_use, side_effects + receipts) — exactly
  // what the JSON editor / `generate spec` show. name + sources live elsewhere.
  const cleanSel = useMemo(
    () => (sel && ontology ? (toCleanNodes('actions', [sel], ontology)[0] as Record<string, unknown>) : undefined),
    [sel, ontology],
  );

  const [editing, setEditing] = useState(false);
  const saveClean = (edited: Record<string, unknown>): void => {
    if (!ontology || !sel) return;
    const merged = fromCleanNodes('actions', [edited], ontology)[0] as Record<string, unknown>;
    ctrl.editEntity('action', sel.id, merged);
    setEditing(false);
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
          <ActionHeader action={sel} title={actionName(sel)} description={actionDesc(sel)} t={t} lang={lang} ctrl={ctrl} editing={editing} onEdit={() => setEditing(true)} />

          {/* Clean sample-shaped action view (read) or inline editor (edit).
              name is in the header; sources are the right citations column. */}
          {cleanSel &&
            (editing ? (
              <CleanNodeEditor node={cleanSel} lang={lang} onSave={saveClean} onCancel={() => setEditing(false)} />
            ) : (
              <CleanNodeCard node={cleanSel} lang={lang} skip={['name', 'sources']} />
            ))}
        </div>
      )}

      {/* ---- Right: source citations ------------------------------------ */}
      {sel && <CitationsPanel action={sel} t={t} lang={lang} />}
    </div>
  );
}

function actorLabel(a: ActionType, lang: Lang): string {
  const ref = a.actorRef;
  const role = (lang === 'zh' ? ref?.roleZh || ref?.role : ref?.role) || ref?.role || (a.actor?.[0] ?? '');
  return `${role} · ${ref?.kind ?? a.actor?.[0] ?? ''}`;
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
  editing,
  onEdit,
}: {
  action: ActionType;
  title: string;
  description?: string;
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
  editing: boolean;
  onEdit: () => void;
}) {
  const tag = reviewTag(action.reviewState, t);
  const accepted = action.reviewState === 'accepted';

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
          <span className="tag ai" style={{ whiteSpace: 'nowrap' }}>{action.actorRef?.kind ?? action.actor?.[0]}</span>
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
      {!editing && (
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          <button className="btn ghost" onClick={() => void ctrl.reviewOne('action', action.id, 'rejected')}>{t.reject}</button>
          <button className="btn ghost" onClick={onEdit}>{t.edit}</button>
          <button className={accepted ? 'btn' : 'btn primary'} onClick={() => void ctrl.reviewOne('action', action.id, accepted ? 'pending' : 'accepted')}>
            {accepted ? '✓ ' + t.accepted : t.accept}
          </button>
        </div>
      )}
    </div>
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
