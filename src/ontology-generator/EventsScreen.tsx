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

import type {
  ActionType,
  EventField,
  EventType,
  ObjectType,
  ReviewStatus,
} from '@/ontology/schema/types';

import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';

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

  // ---- id → display-name resolvers (against the working ontology layers) ----
  const objectsById = useMemo(() => {
    const m = new Map<string, ObjectType>();
    for (const o of ontology?.objects ?? []) m.set(o.id, o);
    return m;
  }, [ontology]);

  const actionsById = useMemo(() => {
    const m = new Map<string, ActionType>();
    for (const a of ontology?.actions ?? []) m.set(a.id, a);
    return m;
  }, [ontology]);

  const objectName = (id: string): string => {
    const o = objectsById.get(id);
    if (!o) return id;
    return lang === 'zh' ? o.nameZh || o.name : o.name;
  };

  const actionName = (id: string): string => {
    const a = actionsById.get(id);
    if (!a) return id;
    return lang === 'zh' ? a.nameZh || a.name : a.name;
  };

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
                    {e.payload.length} {t.payload.toLowerCase()} ·{' '}
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

          <PayloadSection
            fields={sel.payload}
            t={t}
            lang={lang}
            objectName={objectName}
          />

          <WiringSection
            event={sel}
            t={t}
            lang={lang}
            actionName={actionName}
          />
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
// Payload — typed field table; object-typed fields are clickable chips.
// ===========================================================================

function PayloadSection({
  fields,
  t,
  lang,
  objectName,
}: {
  fields: EventField[];
  t: Strings;
  lang: Lang;
  objectName: (id: string) => string;
}) {
  return (
    <section>
      <div className="mono-cap" style={{ marginBottom: 'var(--s-3)' }}>
        {t.payload}
      </div>
      {fields.length === 0 ? (
        <div className="mono-cap" style={{ color: 'var(--fg-4)' }}>
          {lang === 'zh' ? '无载荷字段' : 'No payload fields'}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.4fr 1.6fr 110px',
              padding: '10px var(--s-4)',
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: 'var(--fg-4)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              background: 'var(--bg-2)',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <span>name</span>
            <span>{t.type}</span>
            <span>{t.required.toLowerCase()}</span>
          </div>
          {fields.map((f, i) => {
            const isRef = !!f.objectTypeId;
            return (
              <div
                key={f.name + i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.4fr 1.6fr 110px',
                  padding: '10px var(--s-4)',
                  alignItems: 'center',
                  fontSize: 13,
                  borderBottom: i < fields.length - 1 ? '1px solid var(--line-soft)' : 'none',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
                  {isRef && <span style={{ color: 'var(--accent)', marginRight: 6 }}>◇</span>}
                  {f.name}
                </span>
                <span>
                  {isRef && f.objectTypeId ? (
                    <span
                      title={f.objectTypeId}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 10px',
                        background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
                        border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
                        borderRadius: 999,
                        color: 'var(--accent)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                      }}
                    >
                      {objectName(f.objectTypeId)}
                    </span>
                  ) : (
                    <span
                      style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-3)', fontSize: 12 }}
                    >
                      {f.type ?? 'json'}
                    </span>
                  )}
                </span>
                <span
                  style={{
                    color: f.required ? 'var(--warn)' : 'var(--fg-4)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                  }}
                >
                  {f.required ? 'REQUIRED' : 'optional'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ===========================================================================
// Wiring — producedBy / consumedBy chips, with an orphan warning.
// ===========================================================================

function WiringSection({
  event,
  t,
  lang,
  actionName,
}: {
  event: EventType;
  t: Strings;
  lang: Lang;
  actionName: (id: string) => string;
}) {
  const orphan =
    event.producedByActionIds.length === 0 && event.consumedByActionIds.length === 0;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      {orphan && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s-3)',
            padding: 'var(--s-3) var(--s-4)',
            background: 'color-mix(in oklab, var(--warn) 12%, transparent)',
            border: '1px solid color-mix(in oklab, var(--warn) 36%, transparent)',
            borderRadius: 'var(--r-2)',
            color: 'var(--warn)',
            fontSize: 13,
          }}
        >
          <span style={{ fontSize: 16 }}>⚠</span>
          <span>{t.orphanEvent}</span>
        </div>
      )}

      <WiringRow
        label={t.producedBy}
        ids={event.producedByActionIds}
        actionName={actionName}
        arrow="↑"
        accent="var(--accent-3)"
        emptyLabel={lang === 'zh' ? '无生产者' : 'No producer'}
      />
      <WiringRow
        label={t.consumedBy}
        ids={event.consumedByActionIds}
        actionName={actionName}
        arrow="↓"
        accent="var(--accent)"
        emptyLabel={lang === 'zh' ? '无消费者' : 'No consumer'}
      />
    </section>
  );
}

function WiringRow({
  label,
  ids,
  actionName,
  arrow,
  accent,
  emptyLabel,
}: {
  label: string;
  ids: string[];
  actionName: (id: string) => string;
  arrow: string;
  accent: string;
  emptyLabel: string;
}) {
  return (
    <div>
      <div className="mono-cap" style={{ marginBottom: 'var(--s-2)' }}>
        {label}
      </div>
      {ids.length === 0 ? (
        <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>
          {emptyLabel}
        </span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {ids.map((id) => (
            <span
              key={id}
              title={id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                background: 'var(--bg-1)',
                border: '1px solid var(--line)',
                borderRadius: 999,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
              }}
            >
              <span style={{ color: accent }}>{arrow}</span>
              <span style={{ color: 'var(--fg-2)', fontWeight: 500 }}>{actionName(id)}</span>
            </span>
          ))}
        </div>
      )}
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
