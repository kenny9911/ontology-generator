// Objects review — canonical-model edition. Renders ctrl.ontology.objects:
//   left  : object list (confidence / reviewState),
//   center: schema (attributes with keyRole pk/fk markers, enumValues,
//           refObjectTypeId resolved to a name, required) + relationships
//           (from ctrl.ontology.relationships filtered to this object),
//   right : clickable source citations (snippet; quoteVerified===false -> warn).
// Accept / Edit / Merge / Reject drive ctrl.setReview / editEntity / mergeObjects
// then ctrl.save(); "re-run this stage" calls ctrl.reRunStage("objects").
// Bilingual EN/中文. Preserves the .ontogen visual system + inline-style aesthetic.
import { useEffect, useMemo, useState } from 'react';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import type {
  ObjectType,
  ObjectProperty,
  PropertyType,
  Relationship,
  SourceRef,
  ReviewStatus,
} from '@/ontology/schema/types';
import { PROPERTY_TYPES } from '@/ontology/schema/types';
import CleanNodeCard from './CleanNodeCard';
import { toCleanNodes } from './json-editor/clean';

interface ObjectsScreenProps {
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
}

// --- review-state → tag style map (mirrors the .ontogen tag variants) --------
function reviewTagClass(state: ReviewStatus): string {
  switch (state) {
    case 'accepted':
      return 'tag ok';
    case 'rejected':
      return 'tag warn';
    case 'edited':
    case 'merged':
      return 'tag ai';
    default:
      return 'tag';
  }
}
function reviewLabel(t: Strings, state: ReviewStatus): string {
  switch (state) {
    case 'accepted':
      return t.accepted;
    case 'rejected':
      return t.rejected;
    case 'edited':
      return t.edited;
    case 'merged':
      return t.merged;
    default:
      return t.pending;
  }
}

export default function ObjectsScreen({ t, lang, ctrl }: ObjectsScreenProps) {
  const objects = useMemo<ObjectType[]>(() => ctrl.ontology?.objects ?? [], [ctrl.ontology]);
  const relationships = useMemo<Relationship[]>(
    () => ctrl.ontology?.relationships ?? [],
    [ctrl.ontology],
  );

  const [selectedId, setSelectedId] = useState<string | undefined>(objects[0]?.id);
  // If the working ontology changes (re-run / merge), keep selection valid.
  useEffect(() => {
    if (!objects.some((o) => o.id === selectedId)) {
      setSelectedId(objects[0]?.id);
    }
  }, [objects, selectedId]);

  // Per-citation expand toggle (keyed object id + index).
  const [openCite, setOpenCite] = useState<string | null>(null);
  // Inline edit + merge UI state.
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editNameZh, setEditNameZh] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editDescZh, setEditDescZh] = useState('');
  const [editType, setEditType] = useState<'data' | 'system'>('data');
  const [editRelDesc, setEditRelDesc] = useState('');
  const [editPk, setEditPk] = useState('');
  const [editProps, setEditProps] = useState<ObjectProperty[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);

  const sel = objects.find((o) => o.id === selectedId);
  // The clean sample-shaped projection of the selected object (id English, name
  // Chinese, sample fields only) — what the JSON editor / export also show.
  const cleanSel = useMemo(
    () => (sel && ctrl.ontology ? (toCleanNodes('objects', [sel], ctrl.ontology)[0] as Record<string, unknown>) : undefined),
    [sel, ctrl.ontology],
  );

  // id -> display name lookup, resolved against the objects layer.
  const nameOf = (id: string | undefined): string => {
    if (!id) return '—';
    const o = objects.find((x) => x.id === id);
    if (!o) return id;
    return lang === 'zh' && o.nameZh ? o.nameZh : o.name;
  };

  const acceptedCount = objects.filter((o) => o.reviewState === 'accepted').length;
  const pendingCount = objects.filter(
    (o) => o.reviewState !== 'accepted' && o.reviewState !== 'rejected',
  ).length;

  // Object-level + attribute-level citations for the right rail.
  const selCitations: { cite: SourceRef; from: string }[] = useMemo(() => {
    if (!sel) return [];
    const out: { cite: SourceRef; from: string }[] = [];
    for (const c of sel.sources ?? []) out.push({ cite: c, from: sel.name });
    for (const p of sel.properties) {
      for (const c of p.sources ?? []) out.push({ cite: c, from: `${sel.name}.${p.name}` });
    }
    return out;
  }, [sel]);

  function beginEdit() {
    if (!sel) return;
    setEditName(sel.name);
    setEditNameZh(sel.nameZh);
    setEditDesc(sel.description);
    setEditDescZh(sel.descriptionZh ?? '');
    setEditType(sel.type);
    setEditRelDesc(sel.relationship_description ?? '');
    setEditPk(sel.primary_key ?? '');
    // Deep-copy properties so row edits don't mutate the working ontology until save.
    setEditProps((sel.properties ?? []).map((p) => ({ ...p })));
    setEditing(true);
    setMergeOpen(false);
  }

  function updateProp(i: number, patch: Partial<ObjectProperty>) {
    setEditProps((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }
  function addProp() {
    setEditProps((prev) => [...prev, { name: '', type: 'String', description: '' }]);
  }
  function removeProp(i: number) {
    setEditProps((prev) => prev.filter((_, j) => j !== i));
  }

  async function commitEdit() {
    if (!sel) return;
    // Normalize properties: drop blank-named rows; keep references only when fk.
    const cleaned: ObjectProperty[] = editProps
      .map((p) => {
        const out: ObjectProperty = {
          name: p.name.trim(),
          type: p.type,
          description: p.description ?? '',
        };
        if (p.nameZh) out.nameZh = p.nameZh;
        if (p.descriptionZh) out.descriptionZh = p.descriptionZh;
        if (p.is_foreign_key && p.references) {
          out.is_foreign_key = true;
          out.references = p.references;
        }
        if (p.sources) out.sources = p.sources;
        return out;
      })
      .filter((p) => p.name.length > 0);
    ctrl.editEntity('object', sel.id, {
      name: editName,
      nameZh: editNameZh,
      description: editDesc,
      descriptionZh: editDescZh,
      type: editType,
      relationship_description: editRelDesc,
      primary_key: editPk.trim() || `${sel.id.replace(/^objectType:/, '').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_id`,
      properties: cleaned,
    });
    setEditing(false);
    await ctrl.save();
  }

  async function review(status: ReviewStatus) {
    if (!sel) return;
    await ctrl.reviewOne('object', sel.id, status);
  }

  async function mergeInto(targetId: string) {
    if (!sel) return;
    // Keep the target, fold the currently-selected object into it.
    ctrl.mergeObjects(targetId, sel.id);
    setMergeOpen(false);
    setSelectedId(targetId);
    await ctrl.save();
  }

  // Empty state — no ontology / no objects yet.
  if (objects.length === 0) {
    return (
      <div className="screen" style={{ placeItems: 'center', padding: 'var(--s-7)' }}>
        <div className="mono-cap" style={{ textAlign: 'center' }}>
          {lang === 'zh' ? '暂无对象 —— 请先运行发现阶段' : 'No objects yet — run discovery first'}
        </div>
      </div>
    );
  }

  return (
    <div className="screen" style={{ gridTemplateColumns: '280px 1fr 320px', gap: 0 }}>
      {/* ============================ Left: object list ====================== */}
      <div style={{ borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 'var(--s-5)', borderBottom: '1px solid var(--line)' }}>
          <div className="mono-cap">{lang === 'zh' ? '03 · 对象' : '03 · OBJECTS'}</div>
          <h2 style={{ margin: '6px 0 2px', fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>
            {t.objectsTitle}
          </h2>
          <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>
            {acceptedCount} {t.of} {objects.length} {t.accepted.toLowerCase()}
          </div>
          <button
            className="btn ghost"
            style={{ marginTop: 'var(--s-3)', width: '100%', padding: '6px 10px', fontSize: 12 }}
            disabled={ctrl.running || pendingCount === 0}
            onClick={() => void ctrl.acceptAll('object')}
          >
            ✓ {t.acceptAll}
            {pendingCount > 0 && <span style={{ color: 'var(--fg-4)', marginLeft: 6 }}>· {pendingCount}</span>}
          </button>
        </div>
        <div className="scroll" style={{ padding: 'var(--s-2)', flex: 1 }}>
          {objects.map((o) => {
            const isSel = o.id === selectedId;
            const isAccepted = o.reviewState === 'accepted';
            return (
              <button
                key={o.id}
                onClick={() => {
                  setSelectedId(o.id);
                  setEditing(false);
                  setMergeOpen(false);
                  setOpenCite(null);
                }}
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
                  opacity: o.reviewState === 'rejected' ? 0.55 : 1,
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
                    border: '1px solid var(--line)',
                  }}
                >
                  {o.display?.emoji ?? '◆'}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>
                    {o.name}{' '}
                    {lang === 'zh' && o.nameZh && (
                      <span style={{ color: 'var(--fg-4)', fontSize: 11 }}>{o.nameZh}</span>
                    )}
                  </div>
                  <div className="mono-cap">
                    {o.properties.length} {t.attributes.toLowerCase()} ·{' '}
                    {relationships.filter((r) => r.sourceObjectTypeId === o.id || r.targetObjectTypeId === o.id).length} rel
                  </div>
                </div>
                {isAccepted ? (
                  <span style={{ color: 'var(--accent-3)', fontSize: 14 }}>✓</span>
                ) : (
                  <span className="mono-cap" style={{ color: 'var(--accent-2)' }}>
                    {(o.confidence * 100).toFixed(0)}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ========================== Center: schema view ===================== */}
      {sel && (
        <div className="scroll" style={{ padding: 'var(--s-6)', display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
          {/* Header: identity + review actions */}
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
                flexShrink: 0,
              }}
            >
              {sel.display?.emoji ?? '◆'}
            </span>
            <div style={{ flex: 1, minWidth: 200 }}>
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 520 }}>
                  <input
                    className="ctl"
                    style={{ borderRadius: 'var(--r-2)', padding: '8px 12px', fontFamily: 'var(--font-display)', fontSize: 18 }}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="name"
                  />
                  <input
                    className="ctl"
                    style={{ borderRadius: 'var(--r-2)', padding: '8px 12px' }}
                    value={editNameZh}
                    onChange={(e) => setEditNameZh(e.target.value)}
                    placeholder={t.nameZhLabel}
                  />
                  <textarea
                    className="ctl"
                    style={{ borderRadius: 'var(--r-2)', padding: '8px 12px', minHeight: 48, resize: 'vertical', fontFamily: 'var(--font-body)' }}
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    placeholder={`${t.description} (EN)`}
                  />
                  <textarea
                    className="ctl"
                    style={{ borderRadius: 'var(--r-2)', padding: '8px 12px', minHeight: 48, resize: 'vertical', fontFamily: 'var(--font-body)' }}
                    value={editDescZh}
                    onChange={(e) => setEditDescZh(e.target.value)}
                    placeholder={`${t.description} (中文)`}
                  />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <label className="mono-cap" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {t.objectClass}
                      <select
                        className="ctl"
                        style={{ borderRadius: 'var(--r-2)', padding: '6px 10px' }}
                        value={editType}
                        onChange={(e) => setEditType(e.target.value === 'system' ? 'system' : 'data')}
                      >
                        <option value="data">data</option>
                        <option value="system">system</option>
                      </select>
                    </label>
                    <label className="mono-cap" style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 160 }}>
                      {t.primaryKey}
                      <input
                        className="ctl"
                        style={{ borderRadius: 'var(--r-2)', padding: '6px 10px', fontFamily: 'var(--font-mono)', flex: 1 }}
                        value={editPk}
                        onChange={(e) => setEditPk(e.target.value)}
                        placeholder="primary_key"
                      />
                    </label>
                  </div>
                  <textarea
                    className="ctl"
                    style={{ borderRadius: 'var(--r-2)', padding: '8px 12px', minHeight: 56, resize: 'vertical', fontFamily: 'var(--font-body)' }}
                    value={editRelDesc}
                    onChange={(e) => setEditRelDesc(e.target.value)}
                    placeholder={t.relationshipDescription}
                  />
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
                    <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', margin: 0 }}>
                      {sel.name}
                    </h2>
                    {lang === 'zh' && sel.nameZh && <span style={{ color: 'var(--fg-3)', fontSize: 16 }}>{sel.nameZh}</span>}
                    <span className={reviewTagClass(sel.reviewState)} style={{ whiteSpace: 'nowrap' }}>
                      {reviewLabel(t, sel.reviewState)}
                    </span>
                    {sel.provenance !== 'human' && (
                      <span className="tag ai" style={{ whiteSpace: 'nowrap' }}>
                        {t.autoDetected}
                      </span>
                    )}
                    <span
                      className="tag"
                      style={
                        sel.type === 'system'
                          ? {
                              background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                              color: 'var(--accent)',
                              borderColor: 'color-mix(in oklab, var(--accent) 30%, transparent)',
                            }
                          : undefined
                      }
                    >
                      {sel.type === 'system' ? t.classSystem : t.classData}
                    </span>
                  </div>
                  {(lang === 'zh' && sel.descriptionZh ? sel.descriptionZh : sel.description) && (
                    <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55, maxWidth: 620 }}>
                      {lang === 'zh' && sel.descriptionZh ? sel.descriptionZh : sel.description}
                    </p>
                  )}
                  <div className="mono-cap" style={{ marginTop: 4 }}>
                    {t.primaryKey}: <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{sel.primary_key}</span>
                    {' · '}
                    {t.confidence}: <span style={{ color: 'var(--accent-2)' }}>{(sel.confidence * 100).toFixed(1)}%</span>
                    {' · '}
                    {selCitations.length} {t.sources.toLowerCase()}
                  </div>
                </>
              )}
            </div>

            {/* Action cluster */}
            <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap', position: 'relative' }}>
              {editing ? (
                <>
                  <button className="btn ghost" onClick={() => setEditing(false)}>
                    {t.cancelEdit}
                  </button>
                  <button className="btn primary" onClick={() => void commitEdit()}>
                    {t.saveEdit}
                  </button>
                </>
              ) : (
                <>
                  <button className="btn ghost" onClick={() => void review('rejected')}>
                    {t.reject}
                  </button>
                  <button
                    className={mergeOpen ? 'btn primary' : 'btn ghost'}
                    onClick={() => {
                      setMergeOpen((v) => !v);
                      setEditing(false);
                    }}
                  >
                    {t.merge}
                  </button>
                  <button className="btn ghost" onClick={beginEdit}>
                    {t.edit}
                  </button>
                  <button
                    className={sel.reviewState === 'accepted' ? 'btn' : 'btn primary'}
                    onClick={() => void review('accepted')}
                  >
                    {sel.reviewState === 'accepted' ? '✓ ' + t.accepted : t.accept}
                  </button>

                  {/* Merge-target dropdown */}
                  {mergeOpen && (
                    <div
                      className="card"
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 6px)',
                        right: 0,
                        zIndex: 20,
                        minWidth: 220,
                        maxHeight: 280,
                        overflow: 'auto',
                        padding: 'var(--s-2)',
                        boxShadow: 'var(--glow-accent)',
                      }}
                    >
                      <div className="mono-cap" style={{ padding: '4px 8px' }}>
                        {t.mergeInto}
                      </div>
                      {objects
                        .filter((o) => o.id !== sel.id && o.reviewState !== 'rejected')
                        .map((o) => (
                          <button
                            key={o.id}
                            onClick={() => void mergeInto(o.id)}
                            style={{
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '8px 10px',
                              background: 'transparent',
                              border: 'none',
                              borderRadius: 'var(--r-2)',
                              color: 'var(--fg)',
                              textAlign: 'left',
                              fontSize: 13,
                              cursor: 'pointer',
                            }}
                          >
                            <span style={{ fontSize: 13 }}>{o.display?.emoji ?? '◆'}</span>
                            <span>
                              {o.name}
                              {lang === 'zh' && o.nameZh && (
                                <span style={{ color: 'var(--fg-4)', fontSize: 11, marginLeft: 6 }}>{o.nameZh}</span>
                              )}
                            </span>
                          </button>
                        ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* ---- Clean sample-shaped view: description + relationship_description
                  + receipts. id/name/type/primary_key are in the header above;
                  `properties` is the read table below; sources are the right column. */}
          {!editing && cleanSel && (
            <CleanNodeCard node={cleanSel} lang={lang} skip={['id', 'name', 'type', 'primary_key', 'properties', 'sources']} />
          )}

          {/* ----------------------------- Properties ------------------------- */}
          <section>
            <div className="mono-cap" style={{ marginBottom: 'var(--s-3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{t.attributes}</span>
              {editing && (
                <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={addProp}>
                  + {t.addProperty}
                </button>
              )}
            </div>

            {editing ? (
              /* ---- editable property rows ---- */
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {editProps.map((p, i) => (
                  <div
                    key={i}
                    className="card"
                    style={{ padding: 'var(--s-3)', display: 'grid', gap: 6 }}
                  >
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <input
                        className="ctl"
                        style={{ borderRadius: 'var(--r-2)', padding: '6px 10px', fontFamily: 'var(--font-mono)', flex: '2 1 140px' }}
                        value={p.name}
                        onChange={(e) => updateProp(i, { name: e.target.value })}
                        placeholder="name"
                      />
                      <select
                        className="ctl"
                        style={{ borderRadius: 'var(--r-2)', padding: '6px 10px', flex: '1 1 120px' }}
                        value={p.type}
                        onChange={(e) => updateProp(i, { type: e.target.value as PropertyType })}
                      >
                        {PROPERTY_TYPES.map((ty) => (
                          <option key={ty} value={ty}>{ty}</option>
                        ))}
                      </select>
                      <button
                        className="btn ghost"
                        style={{ padding: '6px 10px', fontSize: 12, flexShrink: 0 }}
                        onClick={() => removeProp(i)}
                        title={t.remove}
                      >
                        ✕
                      </button>
                    </div>
                    <input
                      className="ctl"
                      style={{ borderRadius: 'var(--r-2)', padding: '6px 10px' }}
                      value={p.description}
                      onChange={(e) => updateProp(i, { description: e.target.value })}
                      placeholder={t.description}
                    />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-3)' }}>
                        <input
                          type="checkbox"
                          checked={p.is_foreign_key === true}
                          onChange={(e) =>
                            updateProp(i, e.target.checked ? { is_foreign_key: true } : { is_foreign_key: false, references: undefined })
                          }
                        />
                        {t.foreignKey}
                      </label>
                      {p.is_foreign_key && (
                        <select
                          className="ctl"
                          style={{ borderRadius: 'var(--r-2)', padding: '6px 10px', flex: 1, minWidth: 160 }}
                          value={p.references ?? ''}
                          onChange={(e) => updateProp(i, { references: e.target.value || undefined })}
                        >
                          <option value="">{t.references}…</option>
                          {objects
                            .filter((o) => o.id !== sel.id)
                            .map((o) => (
                              <option key={o.id} value={o.id}>{o.name}</option>
                            ))}
                        </select>
                      )}
                    </div>
                  </div>
                ))}
                {editProps.length === 0 && (
                  <div className="mono-cap">{lang === 'zh' ? '暂无属性' : 'No properties'}</div>
                )}
              </div>
            ) : (
              /* ---- read-only: name | type | description ---- */
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1.4fr 130px 2fr',
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
                  <span>{t.description}</span>
                </div>
                {sel.properties.map((p: ObjectProperty, i) => (
                  <div
                    key={p.name + i}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1.4fr 130px 2fr',
                      padding: '10px var(--s-4)',
                      alignItems: 'start',
                      fontSize: 13,
                      borderBottom: i < sel.properties.length - 1 ? '1px solid var(--line-soft)' : 'none',
                    }}
                  >
                    {/* name + key markers + zh */}
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, minWidth: 0 }}>
                      {p.name === sel.primary_key && <span style={{ color: 'var(--accent-2)', marginRight: 6 }} title={t.primaryKey}>◆</span>}
                      {p.is_foreign_key && <span style={{ color: 'var(--accent)', marginRight: 6 }} title={t.foreignKey}>◇</span>}
                      {p.name}
                      {lang === 'zh' && p.nameZh && (
                        <span style={{ color: 'var(--fg-4)', fontSize: 11, marginLeft: 6, fontFamily: 'var(--font-body)' }}>
                          {p.nameZh}
                        </span>
                      )}
                    </span>
                    {/* type + fk ref */}
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-3)', fontSize: 12, minWidth: 0 }}>
                      {p.type}
                      {p.is_foreign_key && p.references && (
                        <span style={{ color: 'var(--accent)', display: 'block' }}>{`→ ${nameOf(p.references)}`}</span>
                      )}
                    </span>
                    {/* description */}
                    <span style={{ color: 'var(--fg-2)', fontSize: 12, lineHeight: 1.5, minWidth: 0 }}>
                      {(lang === 'zh' && p.descriptionZh ? p.descriptionZh : p.description) || '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Structured relationships are NOT part of the clean sample shape —
              `relationship_description` (prose, shown above) is the clean form. */}
        </div>
      )}

      {/* ======================= Right: source citations ==================== */}
      {sel && (
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="mono-cap">{t.citations}</div>
            <button
              className="btn ghost"
              style={{ padding: '5px 10px', fontSize: 11 }}
              disabled={ctrl.running || ctrl.mode === 'demo'}
              onClick={() => void ctrl.reRunStage('objects')}
            >
              ↻ {t.reRunStage}
            </button>
          </div>
          <div className="scroll" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            {selCitations.length === 0 && (
              <div className="mono-cap">{lang === 'zh' ? '暂无直接引用' : 'No direct citations'}</div>
            )}
            {selCitations.map(({ cite, from }, i) => {
              const key = `${sel.id}:${i}`;
              const open = openCite === key;
              const unverified = cite.quoteVerified === false;
              return (
                <button
                  key={key}
                  onClick={() => setOpenCite(open ? null : key)}
                  className="card"
                  style={{
                    padding: 'var(--s-3)',
                    textAlign: 'left',
                    cursor: 'pointer',
                    color: 'var(--fg)',
                    borderColor: unverified ? 'color-mix(in oklab, var(--warn) 45%, var(--line))' : 'var(--line)',
                    background: unverified ? 'color-mix(in oklab, var(--warn) 7%, var(--bg-1))' : 'var(--bg-1)',
                  }}
                >
                  <div
                    className="mono-cap"
                    style={{
                      color: unverified ? 'var(--warn)' : 'var(--accent)',
                      marginBottom: 6,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cite.documentName}
                      {cite.page ? ` · p.${cite.page}` : ''}
                      {cite.section ? ` · ${cite.section}` : ''}
                    </span>
                    {unverified && (
                      <span className="tag warn" style={{ flexShrink: 0 }}>
                        ⚠ {lang === 'zh' ? '未核实' : 'unverified'}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.55,
                      color: 'var(--fg-2)',
                      borderLeft: `2px solid ${unverified ? 'var(--warn)' : 'var(--accent-2)'}`,
                      paddingLeft: 10,
                      display: open ? 'block' : '-webkit-box',
                      WebkitLineClamp: open ? 'unset' : 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    “{cite.snippet}”
                  </div>
                  <div className="mono-cap" style={{ marginTop: 6, color: 'var(--fg-4)' }}>
                    {from}
                    {unverified && (
                      <span style={{ color: 'var(--warn)', marginLeft: 8 }}>{t.quoteUnverified}</span>
                    )}
                    {typeof cite.confidence === 'number' && (
                      <span style={{ color: 'var(--accent-2)', marginLeft: 8 }}>
                        {(cite.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
