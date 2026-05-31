// Rules review — natural-language + formal + sentence-level source evidence.
// Reads the canonical Ontology via the run controller (`ctrl`), groups rules by
// `ruleGroups`, resolves appliesTo object-type ids -> names, shows a severity
// chip + trigger, and exposes accept/edit/reject through `ctrl`. Bilingual.
// See DESIGN_SPEC §8 (frontend) + design-notes/frontend.md.
import { useMemo, useState } from 'react';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import type {
  ObjectType,
  Rule,
  RuleGroup,
  Severity,
  SourceRef,
} from '@/ontology/schema/types';

interface RulesScreenProps {
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
}

// Severity → palette. `info` documents, `warn` surfaces, `block` aborts a gated
// action. Colors lean on the existing CSS vars so the chip stays on-theme.
const SEVERITY_STYLE: Record<Severity, { fg: string; bg: string; bd: string }> = {
  info: {
    fg: 'var(--accent-3)',
    bg: 'color-mix(in oklab, var(--accent-3) 14%, transparent)',
    bd: 'color-mix(in oklab, var(--accent-3) 30%, transparent)',
  },
  warn: {
    fg: 'var(--warn)',
    bg: 'color-mix(in oklab, var(--warn) 14%, transparent)',
    bd: 'color-mix(in oklab, var(--warn) 32%, transparent)',
  },
  block: {
    fg: 'var(--danger, #ef4444)',
    bg: 'color-mix(in oklab, var(--danger, #ef4444) 14%, transparent)',
    bd: 'color-mix(in oklab, var(--danger, #ef4444) 34%, transparent)',
  },
};

function severityLabel(t: Strings, sev: Severity): string {
  switch (sev) {
    case 'info':
      return t.sevInfo;
    case 'warn':
      return t.sevWarn;
    case 'block':
      return t.sevBlock;
  }
}

function reviewLabel(t: Strings, status: Rule['reviewState']): string {
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

export default function RulesScreen({ t, lang, ctrl }: RulesScreenProps) {
  const { ontology } = ctrl;
  const rules = useMemo<Rule[]>(() => ontology?.rules ?? [], [ontology]);

  const [expanded, setExpanded] = useState<string | null>(rules[0]?.id ?? null);

  // Resolve an ObjectType id -> a display name (bilingual when zh).
  const objectName = useMemo(() => {
    const byId = new Map<string, ObjectType>();
    for (const o of ontology?.objects ?? []) byId.set(o.id, o);
    return (id: string): string => {
      const o = byId.get(id);
      if (!o) return id.replace(/^objectType:/, '');
      return lang === 'zh' && o.nameZh ? o.nameZh : o.name;
    };
  }, [ontology, lang]);

  // Build the grouped view: each declared RuleGroup, then an implicit
  // "ungrouped" bucket for rules not referenced by any group.
  const groups = useMemo(() => {
    const declared: RuleGroup[] = ontology?.ruleGroups ?? [];
    const byId = new Map<string, Rule>();
    for (const r of rules) byId.set(r.id, r);

    const claimed = new Set<string>();
    const out: { key: string; title: { en: string; zh: string } | null; rationale?: string; rules: Rule[] }[] =
      [];

    for (const g of declared) {
      const members = g.ruleIds.map((id) => byId.get(id)).filter((r): r is Rule => Boolean(r));
      for (const m of members) claimed.add(m.id);
      if (members.length > 0) {
        out.push({ key: g.id, title: g.title, rationale: g.rationale, rules: members });
      }
    }

    const ungrouped = rules.filter((r) => !claimed.has(r.id));
    if (ungrouped.length > 0) {
      out.push({ key: '__ungrouped__', title: null, rules: ungrouped });
    }
    return out;
  }, [ontology, rules]);

  // A running index so the R-badge numbering is stable across groups.
  let ruleIndex = 0;

  return (
    <div className="screen" style={{ display: 'grid', gridTemplateRows: 'auto 1fr', padding: 0 }}>
      <div style={{ padding: 'var(--s-6) var(--s-7) var(--s-4)' }}>
        <div className="mono-cap">{lang === 'zh' ? '04 · 规则' : '04 · RULES'}</div>
        <h2
          style={{
            margin: '6px 0 4px',
            fontFamily: 'var(--font-display)',
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: '-0.02em',
          }}
        >
          {t.rulesTitle}
        </h2>
        <p style={{ color: 'var(--fg-3)', margin: 0, fontSize: 13, maxWidth: 720 }}>{t.rulesSub}</p>
      </div>

      <div
        className="scroll"
        style={{
          padding: '0 var(--s-7) var(--s-7)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-5)',
        }}
      >
        {rules.length === 0 && (
          <div className="mono-cap" style={{ padding: 'var(--s-5) 0', color: 'var(--fg-4)' }}>
            {lang === 'zh' ? '暂无规则' : 'No rules yet'}
          </div>
        )}

        {groups.map((group) => (
          <section
            key={group.key}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}
          >
            {/* Group header */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
              <div className="mono-cap" style={{ color: 'var(--accent-2)' }}>
                {group.title
                  ? `${t.ruleGroup} · ${group.title[lang]}`
                  : lang === 'zh'
                    ? '其他规则'
                    : 'Other rules'}
              </div>
              <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>
                {group.rules.length}
              </span>
              {group.rationale && (
                <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{group.rationale}</span>
              )}
            </div>

            {group.rules.map((r) => {
              ruleIndex += 1;
              const open = expanded === r.id;
              const sev = SEVERITY_STYLE[r.severity];
              return (
                <RuleCard
                  key={r.id}
                  t={t}
                  lang={lang}
                  ctrl={ctrl}
                  rule={r}
                  index={ruleIndex}
                  open={open}
                  sev={sev}
                  objectName={objectName}
                  onToggle={() => setExpanded(open ? null : r.id)}
                />
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single rule card — summary row + (when open) formal expression + evidence.
// ---------------------------------------------------------------------------

interface RuleCardProps {
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
  rule: Rule;
  index: number;
  open: boolean;
  sev: { fg: string; bg: string; bd: string };
  objectName: (id: string) => string;
  onToggle: () => void;
}

function RuleCard({ t, lang, ctrl, rule, index, open, sev, objectName, onToggle }: RuleCardProps) {
  const [editing, setEditing] = useState(false);
  const [draftEn, setDraftEn] = useState(rule.statement.en);
  const [draftZh, setDraftZh] = useState(rule.statement.zh);

  const accepted = rule.reviewState === 'accepted';
  const rejected = rule.reviewState === 'rejected';

  function beginEdit() {
    setDraftEn(rule.statement.en);
    setDraftZh(rule.statement.zh);
    setEditing(true);
  }

  function commitEdit() {
    ctrl.editEntity('rule', rule.id, {
      statement: { en: draftEn, zh: draftZh },
    });
    setEditing(false);
  }

  return (
    <div
      className="card"
      style={{
        padding: 0,
        borderColor: open ? 'var(--line-strong)' : 'var(--line)',
        opacity: rejected ? 0.55 : 1,
        transition: 'border-color 0.15s, opacity 0.15s',
      }}
    >
      {/* Summary row */}
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto auto',
          alignItems: 'center',
          gap: 'var(--s-4)',
          padding: 'var(--s-4) var(--s-5)',
          background: 'transparent',
          border: 'none',
          color: 'var(--fg)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: 'var(--bg-2)',
            border: '1px solid var(--line)',
            display: 'grid',
            placeItems: 'center',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--accent-2)',
            flexShrink: 0,
          }}
        >
          R{index}
        </span>
        <div style={{ minWidth: 0 }}>
          {(rule.title || rule.titleZh) && (
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 13,
                fontWeight: 600,
                marginBottom: 2,
              }}
            >
              {lang === 'zh' ? rule.titleZh || rule.title : rule.title}
            </div>
          )}
          <div
            style={{
              fontSize: 14,
              lineHeight: 1.5,
              color: 'var(--fg)',
              textDecoration: rejected ? 'line-through' : 'none',
            }}
          >
            {rule.statement[lang]}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Severity chip */}
            <span
              className="tag"
              style={{
                background: sev.bg,
                color: sev.fg,
                borderColor: sev.bd,
                whiteSpace: 'nowrap',
              }}
            >
              {severityLabel(t, rule.severity)}
            </span>
            {/* appliesTo object chips */}
            {rule.appliesToObjectTypeIds.map((oid) => (
              <span key={oid} className="tag">
                {objectName(oid)}
              </span>
            ))}
            {/* review status chip (non-pending) */}
            {rule.reviewState !== 'pending' && (
              <span className="mono-cap" style={{ color: accepted ? 'var(--accent-3)' : 'var(--fg-4)' }}>
                {reviewLabel(t, rule.reviewState)}
              </span>
            )}
          </div>
        </div>
        <div className="mono-cap" style={{ color: 'var(--accent-2)', whiteSpace: 'nowrap' }}>
          {(rule.confidence * 100).toFixed(0)}%
        </div>
        <span
          style={{
            color: 'var(--fg-4)',
            transition: 'transform 0.2s',
            transform: open ? 'rotate(180deg)' : 'none',
          }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--line)' }}>
          {/* Trigger (when present) */}
          {rule.trigger?.description && (
            <div
              style={{
                padding: 'var(--s-4) var(--s-5)',
                borderBottom: '1px solid var(--line)',
                display: 'flex',
                alignItems: 'baseline',
                gap: 'var(--s-3)',
                flexWrap: 'wrap',
              }}
            >
              <span className="mono-cap" style={{ color: 'var(--accent)' }}>
                {t.trigger}
              </span>
              <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>{rule.trigger.description}</span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
            {/* Formal expression */}
            <div style={{ padding: 'var(--s-5)', borderRight: '1px solid var(--line)' }}>
              <div className="mono-cap" style={{ marginBottom: 8 }}>
                {t.ruleFormal}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  lineHeight: 1.7,
                  background: 'var(--bg)',
                  padding: 'var(--s-4)',
                  borderRadius: 'var(--r-2)',
                  border: '1px solid var(--line)',
                  color: 'var(--accent-3)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {rule.formal}
              </div>
              {rule.expression?.predicate && (
                <div
                  style={{
                    marginTop: 'var(--s-3)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    lineHeight: 1.6,
                    color: 'var(--fg-3)',
                    wordBreak: 'break-word',
                  }}
                >
                  <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>
                    {rule.expression.dialect}
                  </span>{' '}
                  {rule.expression.predicate}
                </div>
              )}
            </div>

            {/* Evidence — sentence-level source citations */}
            <div style={{ padding: 'var(--s-5)' }}>
              <div className="mono-cap" style={{ marginBottom: 8 }}>
                {t.ruleEvidence}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
                {rule.sources.length === 0 && (
                  <div className="mono-cap" style={{ color: 'var(--fg-4)' }}>
                    {lang === 'zh' ? '暂无引用' : 'No citations'}
                  </div>
                )}
                {rule.sources.map((s, i) => (
                  <SourceCitation key={i} t={t} lang={lang} source={s} />
                ))}
              </div>
            </div>
          </div>

          {/* Edit area + review actions */}
          {editing && (
            <div
              style={{
                borderTop: '1px solid var(--line)',
                padding: 'var(--s-5)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--s-3)',
              }}
            >
              <label className="mono-cap" style={{ color: 'var(--fg-4)' }}>
                {t.rulePlain} · EN
              </label>
              <textarea
                value={draftEn}
                onChange={(e) => setDraftEn(e.target.value)}
                rows={2}
                style={editFieldStyle}
              />
              <label className="mono-cap" style={{ color: 'var(--fg-4)' }}>
                {t.rulePlain} · 中文
              </label>
              <textarea
                value={draftZh}
                onChange={(e) => setDraftZh(e.target.value)}
                rows={2}
                style={editFieldStyle}
              />
            </div>
          )}

          <div
            style={{
              borderTop: '1px solid var(--line)',
              padding: 'var(--s-4) var(--s-5)',
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
              flexWrap: 'wrap',
            }}
          >
            {editing ? (
              <>
                <button className="btn ghost" onClick={() => setEditing(false)}>
                  {t.cancelEdit}
                </button>
                <button className="btn primary" onClick={commitEdit}>
                  {t.saveEdit}
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn ghost"
                  onClick={() => ctrl.setReview('rule', rule.id, 'rejected')}
                >
                  {t.reject}
                </button>
                <button className="btn ghost" onClick={beginEdit}>
                  {t.edit}
                </button>
                <button
                  className={accepted ? 'btn' : 'btn primary'}
                  onClick={() =>
                    ctrl.setReview('rule', rule.id, accepted ? 'pending' : 'accepted')
                  }
                >
                  {accepted ? '✓ ' + t.accepted : t.accept}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const editFieldStyle: React.CSSProperties = {
  width: '100%',
  resize: 'vertical',
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-2)',
  padding: 'var(--s-3)',
  color: 'var(--fg)',
  fontSize: 13,
  lineHeight: 1.5,
  fontFamily: 'inherit',
};

// ---------------------------------------------------------------------------
// One sentence-level citation: doc name · section/page, the snippet, and the
// sentence-ref markers when present.
// ---------------------------------------------------------------------------

function SourceCitation({ t, lang, source }: { t: Strings; lang: Lang; source: SourceRef }) {
  const locParts: string[] = [];
  if (source.section) locParts.push(source.section);
  if (source.page && source.page > 0) locParts.push(`${t.page} ${source.page}`);
  if (source.sentenceRefs && source.sentenceRefs.length > 0) {
    locParts.push(`S${source.sentenceRefs.map((n) => n + 1).join(', ')}`);
  }

  return (
    <div
      style={{
        padding: 'var(--s-4)',
        background: 'var(--bg)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-2)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--s-3)',
          marginBottom: 6,
        }}
      >
        <div className="mono-cap" style={{ color: 'var(--accent)' }}>
          {source.documentName}
          {locParts.length > 0 && ` · ${locParts.join(' · ')}`}
        </div>
        <span
          className="mono-cap"
          title={source.quoteVerified === false ? t.quoteUnverified : t.quoteVerified}
          style={{
            color: source.quoteVerified === false ? 'var(--warn)' : 'var(--accent-3)',
            whiteSpace: 'nowrap',
          }}
        >
          {source.quoteVerified === false
            ? lang === 'zh'
              ? '未核实'
              : 'unverified'
            : '✓'}
        </span>
      </div>
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.6,
          color: 'var(--fg-2)',
          borderLeft: '2px solid var(--accent-2)',
          paddingLeft: 12,
        }}
      >
        “{source.snippet}”
      </div>
    </div>
  );
}
