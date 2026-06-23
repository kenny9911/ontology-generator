// ============================================================================
//  CleanNodeCard — renders ONE node of the clean sample shape, identical to the
//  JSON-editor / `generate spec` output: the sample fields ONLY, plus the four
//  review receipts (confidence / provenance / reviewState / sources). Shared by
//  all five review screens so the page shows EXACTLY what the clean JSON shows.
//
//  The node passed in is already the clean projection (see json-editor/clean.ts
//  `toCleanNodes`), so this component never reaches into the internal model.
// ============================================================================

import type { ReactNode } from 'react';
import type { Lang } from '@/ontology/schema/types';

type Dict = Record<string, unknown>;
const RECEIPT_KEYS = new Set(['confidence', 'provenance', 'reviewState', 'sources']);

/** Bilingual labels for the clean field keys (fallback: the key itself). */
const LABELS: Record<string, [string, string]> = {
  id: ['ID', 'ID'],
  name: ['Name', '名称'],
  description: ['Description', '描述'],
  type: ['Type', '类型'],
  relationship_description: ['Relationships', '关系描述'],
  primary_key: ['Primary key', '主键'],
  properties: ['Properties', '属性'],
  specificScenarioStage: ['Scenario / stage', '场景/阶段'],
  businessLogicRuleName: ['Rule name', '规则名称'],
  applicableClient: ['Client', '适用客户'],
  applicableDepartment: ['Department', '适用部门'],
  submissionCriteria: ['Submission criteria', '触发条件'],
  submission_criteria: ['Submission criteria', '触发条件'],
  standardizedLogicRule: ['Logic', '标准化逻辑'],
  relatedEntities: ['Related entities', '关联实体'],
  businessBackgroundReason: ['Background', '业务背景'],
  ruleSource: ['Source', '来源'],
  executor: ['Executor', '执行者'],
  enforcementLevel: ['Enforcement', '强制级别'],
  failurePolicy: ['On failure', '失败策略'],
  object_type: ['Object type', '对象类型'],
  category: ['Category', '类别'],
  actor: ['Actor', '执行者'],
  trigger: ['Trigger', '触发事件'],
  target_objects: ['Target objects', '目标对象'],
  inputs: ['Inputs', '输入'],
  outputs: ['Outputs', '输出'],
  action_steps: ['Steps', '步骤'],
  system_prompt: ['System prompt', '系统提示词'],
  user_prompt: ['User prompt', '用户提示词'],
  typescript_code: ['TypeScript', 'TypeScript'],
  tool_use: ['Tools', '工具'],
  side_effects: ['Side effects', '副作用'],
  triggered_event: ['Emits events', '触发事件'],
  payload: ['Payload', '载荷'],
  actions: ['Steps', '步骤'],
};

function label(key: string, lang: Lang): string {
  const l = LABELS[key];
  return l ? l[lang === 'zh' ? 1 : 0] : key;
}

/** Map a provenance value → bilingual origin label (源文档 / 常识补充 / 联网搜索). */
const ORIGIN: Record<string, [string, string]> = {
  extracted: ['From document', '源文档'],
  inferred: ['Common-sense', '常识补充'],
  web_search: ['Web search', '联网搜索'],
  merged: ['Merged', '合并'],
  human: ['Human', '人工'],
};
export function originText(p: unknown, lang: Lang): string {
  const o = typeof p === 'string' ? ORIGIN[p] : undefined;
  return o ? o[lang === 'zh' ? 1 : 0] : String(p ?? '');
}

const FG3 = 'var(--fg-3)';
const FG2 = 'var(--fg-2)';
const MONO = 'var(--font-mono)';

function Chips({ items }: { items: unknown[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map((v, i) => (
        <span key={i} className="tag">{String(v)}</span>
      ))}
    </div>
  );
}

function Text({ value }: { value: string }) {
  return <div style={{ fontSize: 13, color: 'var(--fg)', whiteSpace: 'pre-wrap', lineHeight: 1.6, wordBreak: 'break-word' }}>{value}</div>;
}

function Row({ k, lang, children }: { k: string; lang: Lang; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div className="mono-cap" style={{ color: FG3 }}>{label(k, lang)}</div>
      {children}
    </div>
  );
}

function MiniTable({ rows, cols }: { rows: Dict[]; cols: { key: string; w?: string }[] }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-2)', overflow: 'hidden' }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, padding: '6px 10px', borderTop: i ? '1px solid var(--line)' : 'none', fontSize: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          {cols.map((c) => {
            const v = r[c.key];
            if (v === undefined || v === null || v === '' || v === false) return null;
            const isName = c.key === 'name';
            return (
              <span key={c.key} style={{ fontFamily: isName || c.key === 'type' || c.key === 'source_object' ? MONO : undefined, color: isName ? 'var(--accent-3)' : FG2, minWidth: c.w, whiteSpace: c.key === 'description' ? 'normal' : 'nowrap' }}>
                {c.key === 'references' ? `→ ${String(v)}` : c.key === 'required' && v === true ? '必填' : c.key === 'is_foreign_key' && v === true ? 'FK' : String(v)}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function renderField(key: string, value: unknown, lang: Lang): ReactNode {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return null;

  // Arrays of plain strings → chips.
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return <Row k={key} lang={lang} key={key}><Chips items={value} /></Row>;
  }

  // Objects' properties / action IO.
  if ((key === 'properties' || key === 'inputs' || key === 'outputs') && Array.isArray(value)) {
    const cols =
      key === 'properties'
        ? [{ key: 'name', w: '160px' }, { key: 'type', w: '90px' }, { key: 'is_foreign_key' }, { key: 'references' }, { key: 'description' }]
        : [{ key: 'name', w: '140px' }, { key: 'type', w: '90px' }, { key: 'required' }, { key: 'source_object', w: '160px' }, { key: 'description' }];
    return <Row k={key} lang={lang} key={key}><MiniTable rows={value as Dict[]} cols={cols} /></Row>;
  }

  // Action steps / workflow steps.
  if ((key === 'action_steps' || key === 'actions') && Array.isArray(value)) {
    return (
      <Row k={key} lang={lang} key={key}>
        <div style={{ display: 'grid', gap: 6 }}>
          {(value as Dict[]).map((s, i) => (
            <div key={i} style={{ fontSize: 12, color: FG2, borderLeft: '2px solid var(--line)', paddingLeft: 8 }}>
              <span style={{ fontFamily: MONO, color: 'var(--accent-3)' }}>{String(s.order ?? i + 1)}. {String(s.name ?? '')}</span>
              {s.type ? <span className="mono-cap" style={{ marginLeft: 6, color: FG3 }}>{String(s.type)}</span> : null}
              <div style={{ marginTop: 2, whiteSpace: 'pre-wrap' }}>{String(s.description ?? '')}</div>
              {s.condition ? <div style={{ color: FG3 }}>条件: {String(s.condition)}</div> : null}
              {Array.isArray(s.rules) ? (s.rules as Dict[]).map((rl, j) => <div key={j} style={{ color: FG3 }}>· {String(rl.name ?? rl.id)}</div>) : null}
            </div>
          ))}
        </div>
      </Row>
    );
  }

  // Event payload.
  if (key === 'payload' && typeof value === 'object') {
    const p = value as Dict;
    return (
      <Row k={key} lang={lang} key={key}>
        <div style={{ display: 'grid', gap: 6 }}>
          {p.source_action ? <div style={{ fontSize: 12, color: FG2 }}><span className="mono-cap" style={{ color: FG3 }}>source_action: </span><span style={{ fontFamily: MONO }}>{String(p.source_action)}</span></div> : null}
          {Array.isArray(p.event_data) && p.event_data.length > 0 ? (
            <MiniTable rows={(p.event_data as Dict[]).map((d) => ({ ...d, references: d.target_object }))} cols={[{ key: 'name', w: '160px' }, { key: 'type', w: '90px' }, { key: 'references' }]} />
          ) : null}
          {Array.isArray(p.state_mutations) && p.state_mutations.length > 0 ? (
            <Chips items={(p.state_mutations as Dict[]).map((m) => `${m.target_object} (${m.mutation_type})`)} />
          ) : null}
        </div>
      </Row>
    );
  }

  // Action side_effects.
  if (key === 'side_effects' && typeof value === 'object') {
    const se = value as Dict;
    const dc = Array.isArray(se.data_changes) ? (se.data_changes as Dict[]) : [];
    const nf = Array.isArray(se.notifications) ? (se.notifications as Dict[]) : [];
    if (dc.length === 0 && nf.length === 0) return null;
    return (
      <Row k={key} lang={lang} key={key}>
        <div style={{ display: 'grid', gap: 6, fontSize: 12, color: FG2 }}>
          {dc.map((d, i) => <div key={`d${i}`}><span className="tag ok">{String(d.action)}</span> <span style={{ fontFamily: MONO }}>{String(d.object_type)}</span> — {String(d.description ?? '')}</div>)}
          {nf.map((n, i) => <div key={`n${i}`}><span className="tag">{String(n.recipient)}</span> {String(n.message ?? '')}</div>)}
        </div>
      </Row>
    );
  }

  if (typeof value === 'string') return <Row k={key} lang={lang} key={key}><Text value={value} /></Row>;
  // Fallback: pretty JSON.
  return <Row k={key} lang={lang} key={key}><pre style={{ fontSize: 11, fontFamily: MONO, color: FG2, whiteSpace: 'pre-wrap' }}>{JSON.stringify(value, null, 2)}</pre></Row>;
}

interface SourceRefLike {
  documentName?: string;
  snippet?: string;
  section?: string;
  page?: number;
  quoteVerified?: boolean;
}

/** The four receipts (confidence/provenance/reviewState + source citations). */
function Receipts({ node, lang, showSources }: { node: Dict; lang: Lang; showSources: boolean }) {
  const sources = showSources && Array.isArray(node.sources) ? (node.sources as SourceRefLike[]) : [];
  const conf = typeof node.confidence === 'number' ? node.confidence : undefined;
  return (
    <div style={{ display: 'grid', gap: 8, borderTop: '1px dashed var(--line)', paddingTop: 'var(--s-3)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {node.provenance ? <span className="tag">{lang === 'zh' ? '来源' : 'origin'}: {originText(node.provenance, lang)}</span> : null}
        {node.reviewState ? <span className="tag">{lang === 'zh' ? '审阅状态' : 'reviewState'}: {String(node.reviewState)}</span> : null}
        {conf !== undefined ? <span className="mono-cap" style={{ color: 'var(--accent-2)' }}>{lang === 'zh' ? '置信度' : 'confidence'} {(conf * 100).toFixed(0)}%</span> : null}
      </div>
      {sources.length > 0 ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <div className="mono-cap" style={{ color: FG3 }}>{lang === 'zh' ? '来源引用 (sources)' : 'sources'}</div>
          {sources.map((s, i) => (
            <div key={i} style={{ fontSize: 11, color: FG2, borderLeft: '2px solid var(--line)', paddingLeft: 8 }}>
              <span className="mono-cap" style={{ color: FG3 }}>{s.documentName}{s.section ? ` · ${s.section}` : ''}{s.quoteVerified ? ' ✓' : ''}</span>
              <div style={{ fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>{s.snippet}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Render a clean node: its sample fields (in order) + the review receipts.
 *  `skip` omits fields already shown by the host screen's header (no duplication). */
export default function CleanNodeCard({ node, lang, skip }: { node: Dict; lang: Lang; skip?: string[] }) {
  const omit = new Set(skip ?? []);
  const fields = Object.keys(node).filter((k) => !RECEIPT_KEYS.has(k) && !omit.has(k));
  return (
    <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
      {fields.map((k) => renderField(k, node[k], lang))}
      <Receipts node={node} lang={lang} showSources={!omit.has('sources')} />
    </div>
  );
}
