// ============================================================================
//  CleanNodeEditor — inline, field-by-field editor for ONE clean node (the
//  editable counterpart of CleanNodeCard). Used by the review screens so a
//  reviewer edits the SAME clean sample fields the card shows — no popup, no
//  separate JSON-editor screen. Receipts (confidence/provenance/reviewState/
//  sources) are NOT editable; `id` (and any key field) is shown read-only.
//
//  Simple fields render as inputs / selects / line-lists; nested fields
//  (properties / inputs / outputs / action_steps / side_effects / payload /
//  actions) render as a small JSON textarea (parsed on save). On save the host
//  screen maps the edited clean node back to the internal model via
//  json-editor/clean.ts `fromCleanNodes` and persists with `ctrl.editEntity`.
// ============================================================================

import { useState } from 'react';
import type { Lang } from '@/ontology/schema/types';

type Dict = Record<string, unknown>;
const RECEIPTS = new Set(['confidence', 'provenance', 'reviewState', 'sources']);

const ENUMS: Record<string, string[]> = {
  type: ['data', 'system'],
  executor: ['Human', 'Agent'],
  enforcementLevel: ['mandatory', 'optional'],
  failurePolicy: ['warn', 'block'],
};
// Long free-text fields get a textarea; everything else a single-line input.
const LONG = new Set([
  'description',
  'relationship_description',
  'standardizedLogicRule',
  'submissionCriteria',
  'submission_criteria',
  'businessBackgroundReason',
  'system_prompt',
  'user_prompt',
  'typescript_code',
]);

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
const label = (k: string, lang: Lang): string => (LABELS[k] ? LABELS[k][lang === 'zh' ? 1 : 0] : k);

const ctl: React.CSSProperties = { borderRadius: 'var(--r-2)', padding: '6px 10px', width: '100%', fontFamily: 'var(--font-body)' };
const mono: React.CSSProperties = { ...ctl, fontFamily: 'var(--font-mono)', fontSize: 12 };

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isNested = (v: unknown): boolean => (Array.isArray(v) && !isStringArray(v)) || (typeof v === 'object' && v !== null);

interface Props {
  node: Dict;
  lang: Lang;
  /** Field keys shown read-only (always includes id; events also pass 'name'). */
  readOnly?: string[];
  onSave: (edited: Dict) => void;
  onCancel: () => void;
}

export default function CleanNodeEditor({ node, lang, readOnly, onSave, onCancel }: Props) {
  const ro = new Set(['id', ...(readOnly ?? [])]);
  const fieldKeys = Object.keys(node).filter((k) => !RECEIPTS.has(k));

  // Editable draft: scalars/string-lists as live values; nested fields as JSON text.
  const [draft, setDraft] = useState<Dict>(() => {
    const d: Dict = {};
    for (const k of fieldKeys) d[k] = node[k];
    return d;
  });
  const [jsonText, setJsonText] = useState<Record<string, string>>(() => {
    const j: Record<string, string> = {};
    for (const k of fieldKeys) if (isNested(node[k])) j[k] = JSON.stringify(node[k], null, 2);
    return j;
  });
  const [jsonErr, setJsonErr] = useState<Record<string, string>>({});

  const setField = (k: string, v: unknown): void => setDraft((d) => ({ ...d, [k]: v }));

  const save = (): void => {
    const out: Dict = {};
    const errs: Record<string, string> = {};
    for (const k of fieldKeys) {
      if (isNested(node[k])) {
        try {
          out[k] = JSON.parse(jsonText[k] ?? 'null');
        } catch (e) {
          errs[k] = e instanceof Error ? e.message : 'Invalid JSON';
        }
      } else {
        out[k] = draft[k];
      }
    }
    // carry the receipts through untouched
    for (const k of Object.keys(node)) if (RECEIPTS.has(k)) out[k] = node[k];
    if (Object.keys(errs).length > 0) {
      setJsonErr(errs);
      return;
    }
    onSave(out);
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
      {fieldKeys.map((k) => {
        const v = node[k];
        const readonly = ro.has(k);
        return (
          <div key={k} style={{ display: 'grid', gap: 4 }}>
            <label className="mono-cap" style={{ color: 'var(--fg-3)' }}>{label(k, lang)}</label>
            {readonly ? (
              <div style={{ ...mono, opacity: 0.6, border: '1px solid var(--line)' }}>{String(draft[k] ?? '')}</div>
            ) : ENUMS[k] ? (
              <select className="ctl" style={ctl} value={String(draft[k] ?? '')} onChange={(e) => setField(k, e.target.value)}>
                {ENUMS[k].map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : isStringArray(v) ? (
              <textarea
                className="ctl"
                style={{ ...mono, minHeight: 56, resize: 'vertical' }}
                value={(draft[k] as string[]).join('\n')}
                onChange={(e) => setField(k, e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
                placeholder={lang === 'zh' ? '每行一个' : 'one per line'}
              />
            ) : isNested(v) ? (
              <>
                <textarea
                  className="ctl"
                  style={{ ...mono, minHeight: 96, resize: 'vertical' }}
                  value={jsonText[k] ?? ''}
                  onChange={(e) => setJsonText((j) => ({ ...j, [k]: e.target.value }))}
                  spellCheck={false}
                />
                {jsonErr[k] && <span style={{ color: 'var(--danger, #ef4444)', fontSize: 11 }}>{jsonErr[k]}</span>}
              </>
            ) : LONG.has(k) ? (
              <textarea
                className="ctl"
                style={{ ...ctl, minHeight: 64, resize: 'vertical' }}
                value={String(draft[k] ?? '')}
                onChange={(e) => setField(k, e.target.value)}
              />
            ) : (
              <input className="ctl" style={ctl} value={String(draft[k] ?? '')} onChange={(e) => setField(k, e.target.value)} />
            )}
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={onCancel}>{lang === 'zh' ? '取消' : 'Cancel'}</button>
        <button className="btn primary" onClick={save}>{lang === 'zh' ? '保存' : 'Save'}</button>
      </div>
    </div>
  );
}
