// EventsScreen — review the discovered EventTypes (DESIGN_SPEC §8, step 06).
//
// Reads the canonical Ontology from `ctrl` (NOT the retired demo dataset). For
// each EventType we render:
//   • payload fields — object-typed fields resolve to (and click through to)
//     their ObjectType; scalar fields show their DataType;
//   • producedByActionIds + consumedByActionIds as chips resolving to action
//     names — an ORPHAN warning when both are empty (no wiring on either side);
//   • source citations, confidence, and a reviewState pill;
//   • Accept / Edit-name / Reject review controls wired through `ctrl`.
//
// Master (left list) → detail (centre) → citations (right) — the same
// three-column `.screen` grid the Objects step uses. Pure presentation +
// local selection state; all mutation flows through the controller.
import { useMemo, useState } from 'react';

import type { EventType, ReviewStatus } from '@/ontology/schema/types';

import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import CleanNodeCard from './CleanNodeCard';
import { toCleanNodes } from './json-editor/clean';

interface EventsScreenProps {
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
}

/** Map a ReviewStatus to a `.tag` variant + localized label. */
function reviewTag(
  status: ReviewStatus,
  t: Strings,
): { cls: string; label: string } {
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

export default function EventsScreen({ t, lang, ctrl }: EventsScreenProps) {
  const ontology = ctrl.ontology;
  const events: EventType[] = useMemo(() => ontology?.events ?? [], [ontology]);

  const [selectedId, setSelectedId] = useState<string | undefined>(events[0]?.id);

  // Resolve to a still-present event (selection can dangle after a re-run/merge).
  const sel = events.find((e) => e.id === selectedId) ?? events[0];
  const cleanSel = useMemo(
    () => (sel && ctrl.ontology ? (toCleanNodes('events', [sel], ctrl.ontology)[0] as Record<string, unknown>) : undefined),
    [sel, ctrl.ontology],
  );

  // ---- id → display-name resolvers (against the working ontology layers) ----
  const eventName = (e: EventType): string =>
    lang === 'zh' ? e.nameZh || e.name : e.name;

  const eventDesc = (e: EventType): string | undefined =>
    (lang === 'zh' ? e.descriptionZh : e.description) ?? e.description;

  // Empty state — the events stage hasn't produced anything yet.
  if (!ontology || events.length === 0) {
    return (
      <div className="screen" style={{ placeItems: 'center', padding: 'var(--s-7)' }}>
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <div className="mono-cap">{lang === 'zh' ? '06 · 事件' : '06 · EVENTS'}</div>
          <h2
            style={{
              margin: '8px 0 6px',
              fontFamily: 'var(--font-display)',
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: '-0.02em',
            }}
          >
            {t.eventsTitle}
          </h2>
          <p style={{ color: 'var(--fg-3)', fontSize: 13, margin: 0 }}>{t.eventsSub}</p>
        </div>
      </div>
    );
  }

  const acceptedCount = events.filter((e) => e.reviewState === 'accepted').length;
  const pendingCount = events.filter(
    (e) => e.reviewState !== 'accepted' && e.reviewState !== 'rejected',
  ).length;

  return (
    <div className="screen" style={{ gridTemplateColumns: '300px 1fr 320px', gap: 0 }}>
      {/* ---- Left: event list ------------------------------------------- */}
      <div
        style={{
          borderRight: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div style={{ padding: 'var(--s-5)', borderBottom: '1px solid var(--line)' }}>
          <div className="mono-cap">{lang === 'zh' ? '06 · 事件' : '06 · EVENTS'}</div>
          <h2
            style={{
              margin: '6px 0 2px',
              fontFamily: 'var(--font-display)',
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: '-0.01em',
            }}
          >
            {t.eventsTitle}
          </h2>
          <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>
            {acceptedCount} {t.of} {events.length} {t.accepted.toLowerCase()}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 'var(--s-3)', flexWrap: 'wrap' }}>
            <button
              className="btn ghost"
              style={{ flex: 1, padding: '6px 10px', fontSize: 12 }}
              disabled={ctrl.running || pendingCount === 0}
              onClick={() => void ctrl.acceptAll('event')}
            >
              ✓ {t.acceptAll}
              {pendingCount > 0 && <span style={{ color: 'var(--fg-4)', marginLeft: 6 }}>· {pendingCount}</span>}
            </button>
            <button
              className="btn ghost"
              style={{ padding: '6px 10px', fontSize: 12 }}
              disabled={ctrl.running || ctrl.mode === 'demo'}
              onClick={() => void ctrl.reRunStage('events')}
              title={t.reRunStage}
            >
              ↻
            </button>
          </div>
        </div>

        <div className="scroll" style={{ padding: 'var(--s-2)', flex: 1 }}>
          {events.map((e) => {
            const isSel = e.id === sel?.id;
            const orphan =
              e.producedByActionIds.length === 0 && e.consumedByActionIds.length === 0;
            const done = e.reviewState === 'accepted';
            return (
              <button
                key={e.id}
                onClick={() => setSelectedId(e.id)}
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
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 6,
                    background: 'var(--bg-3)',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 13,
                    border: `1px solid ${orphan ? 'var(--warn)' : 'var(--line)'}`,
                    color: orphan ? 'var(--warn)' : 'var(--accent-3)',
                  }}
                >
                  {orphan ? '!' : '⚡'}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 500,
                      fontSize: 13,
                      fontFamily: 'var(--font-mono)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {e.name}
                  </div>
                  <div className="mono-cap">
                    {e.payloadFields.length} {t.payload.toLowerCase()} ·{' '}
                    {e.producedByActionIds.length}↑ {e.consumedByActionIds.length}↓
                  </div>
                </div>
                {done ? (
                  <span style={{ color: 'var(--accent-3)', fontSize: 14 }}>✓</span>
                ) : (
                  <span className="mono-cap" style={{ color: 'var(--accent-2)' }}>
                    {(e.confidence * 100).toFixed(0)}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- Center: selected event detail ------------------------------ */}
      {sel && (
        <div
          className="scroll"
          style={{
            padding: 'var(--s-6)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-5)',
          }}
        >
          <EventHeader
            event={sel}
            title={eventName(sel)}
            description={eventDesc(sel)}
            t={t}
            lang={lang}
            ctrl={ctrl}
          />

          {/* Clean sample-shaped view: description + payload (spec) + receipts.
              name is in the header; sources are the right citations column. */}
          {cleanSel && <CleanNodeCard node={cleanSel} lang={lang} skip={['name', 'sources']} />}
        </div>
      )}

      {/* ---- Right: source citations ------------------------------------ */}
      {sel && <CitationsPanel event={sel} t={t} lang={lang} />}
    </div>
  );
}

// ===========================================================================
// Header — name, dotted id, confidence, reviewState pill + review controls.
// ===========================================================================

function EventHeader({
  event,
  title,
  description,
  t,
  lang,
  ctrl,
}: {
  event: EventType;
  title: string;
  description?: string;
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
}) {
  const tag = reviewTag(event.reviewState, t);
  const accepted = event.reviewState === 'accepted';

  const onEditName = () => {
    const next = window.prompt(t.eventsTitle, event.name);
    if (next != null && next.trim() && next.trim() !== event.name) {
      ctrl.editEntity('event', event.id, { name: next.trim() });
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
      <span
        style={{
          width: 48,
          height: 48,
          borderRadius: 12,
          background: 'var(--bg-2)',
          border: '1px solid var(--line)',
          display: 'grid',
          placeItems: 'center',
          fontSize: 22,
          color: 'var(--accent-3)',
          flexShrink: 0,
        }}
      >
        ⚡
      </span>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              margin: 0,
            }}
          >
            {title}
          </h2>
          {lang === 'zh' && event.nameZh && event.nameZh !== title && (
            <span style={{ color: 'var(--fg-3)', fontSize: 16 }}>{event.nameZh}</span>
          )}
          <span className={tag.cls} style={{ whiteSpace: 'nowrap' }}>
            {tag.label}
          </span>
        </div>
        <div
          className="mono-cap"
          style={{ marginTop: 4, fontSize: 11, color: 'var(--accent-2)' }}
        >
          {event.name}
        </div>
        {description && (
          <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--fg-2)' }}>
            {description}
          </p>
        )}
        <div className="mono-cap" style={{ marginTop: 6 }}>
          {t.confidence}:{' '}
          <span style={{ color: 'var(--accent-2)' }}>{(event.confidence * 100).toFixed(1)}%</span>
          {' · '}
          {event.sources.length} {t.sources.toLowerCase()}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
        <button
          className="btn ghost"
          onClick={() => void ctrl.reviewOne('event', event.id, 'rejected')}
        >
          {t.reject}
        </button>
        <button className="btn ghost" onClick={onEditName}>
          {t.edit}
        </button>
        <button
          className={accepted ? 'btn' : 'btn primary'}
          onClick={() => void ctrl.reviewOne('event', event.id, accepted ? 'pending' : 'accepted')}
        >
          {accepted ? '✓ ' + t.accepted : t.accept}
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Citations — the event's SourceRefs (verbatim snippets + locator).
// ===========================================================================

function CitationsPanel({
  event,
  t,
  lang,
}: {
  event: EventType;
  t: Strings;
  lang: Lang;
}) {
  return (
    <div
      style={{
        borderLeft: '1px solid var(--line)',
        padding: 'var(--s-5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-3)',
        minHeight: 0,
      }}
    >
      <div className="mono-cap">{t.sources}</div>
      <div
        className="scroll"
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}
      >
        {event.sources.length === 0 && (
          <div className="mono-cap">{lang === 'zh' ? '暂无直接引用' : 'No direct citations'}</div>
        )}
        {event.sources.map((s, i) => {
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
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <span className="mono-cap" style={{ color: 'var(--accent)' }}>
                  {s.documentName}
                  {locator && ` · ${locator}`}
                </span>
                <span
                  className="mono-cap"
                  title={verified ? t.quoteVerified : t.quoteUnverified}
                  style={{ color: verified ? 'var(--accent-3)' : 'var(--warn)' }}
                >
                  {verified ? '✓' : '⚠'}
                </span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: 'var(--fg-2)',
                  borderLeft: '2px solid var(--accent-2)',
                  paddingLeft: 12,
                }}
              >
                "{s.snippet}"
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
