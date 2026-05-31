// Input screen — pick a source, then kick off the generator.
//
// THE FIXED CONTRACT: this screen receives only `{ t, lang, ctrl }`. All setup
// flows route through the controller:
//   - real multi-file upload (<input multiple> + drag/drop) → ctrl.startUpload(files)
//   - a sample-corpus picker (ctrl.listSamples() → pills)    → ctrl.startSample(domain)
//   - "Try the demo"                                          → ctrl.startDemo()
// Navigation to `discover` is the container's job: it watches `ctrl.mode`/run
// and advances once setup fires (DESIGN_SPEC §8.5).
//
// The original Input.jsx aesthetic is preserved: left source-tabs + dropzone +
// advanced disclosure, right "selected sources" queue + Generate. The `db`/`apps`
// tabs stay as visual placeholders (no live backend) — only the `docs` upload,
// the sample pills, and the demo button actually start a run.
//
// Compiles under strict / noUnusedLocals / noUnusedParameters. No `any`.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DomainKey } from '@/ontology/schema/types';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';

interface InputScreenProps {
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
}

type SourceTab = 'docs' | 'db' | 'apps';

/** A sample-corpus pill, as projected by ctrl.listSamples(). */
interface SampleEntry {
  domain: DomainKey;
  title: string;
  docCount: number;
}

const ACCEPTED_FILES = '.pdf,.docx,.doc,.md,.markdown,.txt,.html,.htm';
const MAX_BYTES = 50 * 1024 * 1024; // 50MB, matching the on-screen hint.

/** Bilingual labels for each DomainKey — the only id→name lookup this screen needs. */
const DOMAIN_LABELS: Record<DomainKey, { en: string; zh: string }> = {
  retail_o2c: { en: 'Retail · Order-to-Cash', zh: '零售 · 订单到回款' },
  commercial_lending: { en: 'Commercial Lending', zh: '企业信贷' },
  healthcare_revcycle: { en: 'Healthcare Revenue Cycle', zh: '医疗收入周期' },
  manufacturing_bom_quality: { en: 'Manufacturing · BOM & Quality', zh: '制造 · BOM 与质量' },
  logistics_fulfillment: { en: 'Logistics & Fulfillment', zh: '物流与履约' },
  energy_grid_outage: { en: 'Energy · Grid Outage', zh: '能源 · 电网中断' },
  hr_talent_acquisition: { en: 'HR · Talent Acquisition', zh: '人力 · 人才招募' },
  insurance_claims_underwriting: { en: 'Insurance · Claims & Underwriting', zh: '保险 · 理赔与核保' },
  public_sector_permitting: { en: 'Public Sector · Permitting', zh: '公共部门 · 许可审批' },
  saas_subscription_entitlement: { en: 'SaaS · Subscription Entitlement', zh: 'SaaS · 订阅权益' },
  outsourced_recruitment: { en: 'Outsourced Recruitment', zh: '外包招聘全流程' },
  outsourced_recruitment_native: { en: 'Outsourced Recruitment (raw)', zh: '外包招聘（原生详尽版）' },
  expense_control: { en: 'Enterprise Expense Control', zh: '企业费控与报销' },
  expense_control_native: { en: 'Enterprise Expense Control (raw)', zh: '企业费控报销（原生详尽版）' },
  insurance_underwriting_native: { en: 'Insurance Underwriting & Claims (raw)', zh: '保险核保与理赔（原生详尽版）' },
  contract_approval: { en: 'Contract Approval', zh: '合同审批全流程' },
  inventory_erp: { en: 'Inventory / Purchase-Sell-Stock', zh: '进销存' },
  hr_management: { en: 'HR Management', zh: '人事管理全流程' },
  generic: { en: 'Generic enterprise', zh: '通用企业' },
};

function domainLabel(domain: DomainKey, lang: Lang): string {
  const entry = DOMAIN_LABELS[domain];
  return entry ? entry[lang] : domain;
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export default function InputScreen({ t, lang, ctrl }: InputScreenProps) {
  const [tab, setTab] = useState<SourceTab>('docs');
  const [inferenceDepth, setInferenceDepth] = useState(2);
  const profiles = lang === 'zh'
    ? ['通用企业', '零售电商', '制造业', '金融服务', '医疗健康']
    : ['Generic', 'Retail/eComm', 'Manufacturing', 'Financial', 'Healthcare'];
  const [profile, setProfile] = useState(0);

  // Staged upload files (drag/drop or browse). The Generate button uploads these.
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Sample corpora — fetched lazily from the controller.
  const [samples, setSamples] = useState<SampleEntry[] | null>(null);
  const [samplesError, setSamplesError] = useState<string | null>(null);
  // Track which start path is in flight (so the right pill / button shows a spinner).
  const [pending, setPending] = useState<'upload' | 'demo' | DomainKey | null>(null);

  const running = ctrl.running;

  // Load sample corpora once on mount.
  useEffect(() => {
    let alive = true;
    ctrl
      .listSamples()
      .then((list) => {
        if (alive) setSamples(list);
      })
      .catch((cause: unknown) => {
        if (alive) setSamplesError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
    // listSamples is a stable useCallback on the controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- file staging --------------------------------------------------------

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const accepted: File[] = [];
    for (const f of Array.from(incoming)) {
      if (f.size > MAX_BYTES) continue;
      accepted.push(f);
    }
    if (accepted.length === 0) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((p) => `${p.name}:${p.size}`));
      const merged = [...prev];
      for (const f of accepted) {
        const key = `${f.name}:${f.size}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(f);
        }
      }
      return merged;
    });
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  // ---- start paths ---------------------------------------------------------

  const startUpload = useCallback(async () => {
    if (files.length === 0 || running) return;
    setPending('upload');
    try {
      await ctrl.startUpload(files);
      // On success the container advances to `discover`; nothing else to do.
    } catch {
      // ctrl.error already carries the message; surface it inline below.
    } finally {
      setPending(null);
    }
  }, [files, running, ctrl]);

  const startSample = useCallback(
    async (domain: DomainKey) => {
      if (running) return;
      setPending(domain);
      try {
        await ctrl.startSample(domain);
      } catch {
        /* ctrl.error surfaced inline */
      } finally {
        setPending(null);
      }
    },
    [running, ctrl],
  );

  const startDemo = useCallback(() => {
    if (running) return;
    setPending('demo');
    ctrl.startDemo();
    // startDemo is synchronous; the container advances on the next render.
    setPending(null);
  }, [running, ctrl]);

  const canGenerate = files.length > 0 && !running;

  return (
    <div className="screen" style={{ gridTemplateColumns: '1fr 380px', gap: 'var(--s-5)', padding: 'var(--s-6)', overflowY: 'auto', alignItems: 'start' }}>
      {/* Left: source picker */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)', minHeight: 0 }}>
        <div>
          <div className="mono-cap">{lang === 'zh' ? '01 · 输入' : '01 · INPUT'}</div>
          <h1 style={{
            fontFamily: 'var(--font-display)',
            fontSize: 38,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: '8px 0 6px',
            textWrap: 'balance',
          }}>{t.inputTitle}</h1>
          <p style={{ color: 'var(--fg-3)', maxWidth: 640, lineHeight: 1.55, margin: 0 }}>{t.inputSub}</p>
        </div>

        {/* Source tabs */}
        <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
          {([
            { id: 'docs', label: t.sourceDocs, hint: t.sourceDocsHint, icon: '📄' },
            { id: 'db', label: t.sourceDB, hint: t.sourceDBHint, icon: '🗄' },
            { id: 'apps', label: t.sourceApps, hint: t.sourceAppsHint, icon: '🔌' },
          ] as { id: SourceTab; label: string; hint: string; icon: string }[]).map((s) => (
            <button
              key={s.id}
              onClick={() => setTab(s.id)}
              style={{
                flex: 1,
                background: tab === s.id ? 'var(--bg-2)' : 'transparent',
                border: `1px solid ${tab === s.id ? 'var(--accent)' : 'var(--line)'}`,
                borderRadius: 'var(--r-3)',
                padding: 'var(--s-4)',
                textAlign: 'left',
                color: 'var(--fg)',
                cursor: 'pointer',
                boxShadow: tab === s.id ? '0 0 0 3px color-mix(in oklab, var(--accent) 18%, transparent)' : 'none',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ fontSize: 20, marginBottom: 6 }}>{s.icon}</div>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>{s.label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-4)' }}>{s.hint}</div>
            </button>
          ))}
        </div>

        {/* Active source panel */}
        {tab === 'docs' && (
          <>
            {/* Real upload dropzone */}
            <div
              className="card grid-bg"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              style={{
                borderStyle: 'dashed',
                borderColor: dragOver ? 'var(--accent)' : undefined,
                padding: 'var(--s-7)',
                textAlign: 'center',
                display: 'flex', flexDirection: 'column', gap: 'var(--s-3)',
                alignItems: 'center', justifyContent: 'center',
                minHeight: 200,
                cursor: 'pointer',
                boxShadow: dragOver ? '0 0 0 3px color-mix(in oklab, var(--accent) 22%, transparent)' : 'none',
                transition: 'all 0.15s',
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPTED_FILES}
                onChange={(e) => {
                  if (e.target.files?.length) addFiles(e.target.files);
                  e.target.value = ''; // allow re-selecting the same file
                }}
                style={{ display: 'none' }}
              />
              <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
                <rect x="10" y="6" width="24" height="32" rx="2" stroke="var(--accent)" strokeWidth="1.4" fill="none" />
                <line x1="14" y1="14" x2="30" y2="14" stroke="var(--accent)" strokeWidth="1" opacity="0.5" />
                <line x1="14" y1="20" x2="30" y2="20" stroke="var(--accent)" strokeWidth="1" opacity="0.5" />
                <line x1="14" y1="26" x2="24" y2="26" stroke="var(--accent)" strokeWidth="1" opacity="0.5" />
                <circle cx="22" cy="22" r="20" stroke="var(--accent)" strokeWidth="0.5" opacity="0.2" strokeDasharray="2 4" />
              </svg>
              <div>
                <span style={{ color: 'var(--fg-2)' }}>{t.dropHint} </span>
                <button
                  type="button"
                  className="btn ghost"
                  style={{ padding: '4px 10px', fontSize: 13 }}
                  onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                >{t.browse}</button>
              </div>
              <div className="mono-cap">PDF · DOCX · MD · TXT · HTML · 50MB max</div>
            </div>

            {/* Sample corpus picker */}
            <div className="card" style={{ padding: 'var(--s-5)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--s-3)' }}>
                <div className="mono-cap">{t.sampleCorpus}</div>
                <div className="mono-cap" style={{ color: 'var(--fg-4)' }}>{t.pickSample}</div>
              </div>
              {samplesError && (
                <div style={{ fontSize: 12, color: 'var(--accent-2)', marginBottom: 'var(--s-2)' }}>{samplesError}</div>
              )}
              {samples == null && !samplesError && (
                <div className="mono-cap" style={{ color: 'var(--fg-4)' }}>{lang === 'zh' ? '加载中…' : 'Loading…'}</div>
              )}
              <div className="scroll" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 168, overflowY: 'auto', paddingRight: 4 }}>
                {(samples ?? []).map((s) => {
                  const isPending = pending === s.domain;
                  return (
                    <button
                      key={s.domain}
                      type="button"
                      onClick={() => void startSample(s.domain)}
                      disabled={running}
                      title={s.title}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 999,
                        background: isPending ? 'var(--accent)' : 'var(--bg-2)',
                        color: isPending ? 'var(--bg)' : 'var(--fg-2)',
                        border: `1px solid ${isPending ? 'var(--accent)' : 'var(--line)'}`,
                        fontSize: 12,
                        fontFamily: 'var(--font-mono)',
                        cursor: running ? 'default' : 'pointer',
                        opacity: running && !isPending ? 0.5 : 1,
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        transition: 'all 0.15s',
                      }}
                    >
                      <span>{domainLabel(s.domain, lang)}</span>
                      <span style={{ color: isPending ? 'var(--bg)' : 'var(--fg-4)' }}>
                        · {s.docCount} {t.docCount}
                      </span>
                      {isPending && <span style={{ animation: 'og-pulse-soft 1s infinite' }}>●</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Try the demo */}
            <div className="card" style={{
              padding: 'var(--s-5)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 'var(--s-4)',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>{t.tryDemo}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.5 }}>{t.demoHint}</div>
              </div>
              <button
                type="button"
                className="btn ghost"
                onClick={startDemo}
                disabled={running}
                style={{ whiteSpace: 'nowrap', opacity: running ? 0.5 : 1 }}
              >
                {t.tryDemo} →
              </button>
            </div>
          </>
        )}
        {tab === 'db' && (
          <div className="card" style={{ padding: 'var(--s-5)' }}>
            <div className="mono-cap" style={{ marginBottom: 'var(--s-3)' }}>{lang === 'zh' ? '已连接的数据源' : 'Connected datasources'}</div>
            <div style={{
              padding: 'var(--s-5)',
              textAlign: 'center',
              color: 'var(--fg-4)',
              fontSize: 13,
              border: '1px dashed var(--line)',
              borderRadius: 'var(--r-2)',
            }}>
              {lang === 'zh' ? '数据库直连即将上线 —— 当前请上传文档或选择示例语料。' : 'Live database connectors coming soon — upload documents or pick a sample for now.'}
            </div>
            <button type="button" className="btn ghost" style={{ marginTop: 'var(--s-3)', justifyContent: 'center', width: '100%' }} disabled>
              + {lang === 'zh' ? '添加数据库连接' : 'Add connection'}
            </button>
          </div>
        )}
        {tab === 'apps' && (
          <div className="card" style={{ padding: 'var(--s-5)' }}>
            <div className="mono-cap" style={{ marginBottom: 'var(--s-3)' }}>{lang === 'zh' ? '已接入业务系统' : 'Linked applications'}</div>
            <div style={{
              padding: 'var(--s-5)',
              textAlign: 'center',
              color: 'var(--fg-4)',
              fontSize: 13,
              border: '1px dashed var(--line)',
              borderRadius: 'var(--r-2)',
            }}>
              {lang === 'zh' ? '业务系统接入即将上线 —— 当前请上传文档或选择示例语料。' : 'Application connectors coming soon — upload documents or pick a sample for now.'}
            </div>
          </div>
        )}

        {/* Advanced */}
        <details className="card" style={{ padding: 0 }}>
          <summary className="card-h" style={{ cursor: 'pointer' }}>
            <span>{t.advanced}</span>
            <span className="mono-cap">▾</span>
          </summary>
          <div className="card-b" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-5)' }}>
            <div>
              <div className="mono-cap" style={{ marginBottom: 'var(--s-2)' }}>{t.inferenceDepth}</div>
              <input
                type="range"
                min={1} max={3} step={1}
                value={inferenceDepth}
                onChange={(e) => setInferenceDepth(+e.target.value)}
                style={{ width: '100%', accentColor: 'var(--accent)' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--fg-4)', fontFamily: 'var(--font-mono)' }}>
                <span>{t.inferenceShallow}</span>
                <span>medium</span>
                <span>{t.inferenceDeep}</span>
              </div>
            </div>
            <div>
              <div className="mono-cap" style={{ marginBottom: 'var(--s-2)' }}>{t.profile}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {profiles.map((p, i) => (
                  <button key={p} type="button" onClick={() => setProfile(i)} style={{
                    padding: '5px 12px',
                    borderRadius: 999,
                    background: i === profile ? 'var(--accent)' : 'var(--bg-2)',
                    color: i === profile ? 'var(--bg)' : 'var(--fg-2)',
                    border: `1px solid ${i === profile ? 'var(--accent)' : 'var(--line)'}`,
                    fontSize: 12,
                    fontFamily: 'var(--font-mono)',
                    cursor: 'pointer',
                  }}>{p}</button>
                ))}
              </div>
            </div>
          </div>
        </details>
      </section>

      {/* Right: queue + go button */}
      <aside style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', minHeight: 0 }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="card-h">
            <span>{t.selectedFiles}</span>
            <span className="tag">{files.length}</span>
          </div>
          <div className="scroll" style={{ padding: 'var(--s-3)', display: 'grid', gap: 6, maxHeight: 360 }}>
            {files.length === 0 && (
              <div style={{
                padding: 'var(--s-5)',
                textAlign: 'center',
                color: 'var(--fg-4)',
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
              }}>
                {t.uploadHint}
              </div>
            )}
            {files.map((f, i) => (
              <div key={`${f.name}:${f.size}:${i}`} style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr auto',
                alignItems: 'center',
                gap: 'var(--s-3)',
                padding: 'var(--s-2) var(--s-3)',
                background: 'var(--bg-2)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--r-2)',
              }}>
                <span style={{ fontSize: 14 }}>📄</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{f.name}</div>
                  <div className="mono-cap">{humanSize(f.size)}</div>
                </div>
                <button
                  type="button"
                  aria-label={t.removeFile}
                  title={t.removeFile}
                  onClick={() => removeFile(i)}
                  disabled={running}
                  style={{ background: 'none', border: 'none', color: 'var(--fg-4)', cursor: running ? 'default' : 'pointer', fontSize: 14 }}
                >×</button>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: 'var(--s-4)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--s-3)' }}>
            <span className="mono-cap">{t.estimatedTime}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16, color: 'var(--accent-3)' }}>~ 38s</span>
          </div>
          <button
            className="btn ai"
            onClick={() => void startUpload()}
            disabled={!canGenerate}
            style={{
              width: '100%', justifyContent: 'center', padding: '12px 16px', fontSize: 14,
              opacity: canGenerate ? 1 : 0.5,
              cursor: canGenerate ? 'pointer' : 'default',
            }}
          >
            <Sparkle />
            {pending === 'upload' ? t.uploading : t.generateBtn}
            {pending !== 'upload' && <span style={{ marginLeft: 6 }} className="kbd">⏎</span>}
          </button>
          {ctrl.error && (
            <div style={{ textAlign: 'center', marginTop: 'var(--s-2)', fontSize: 12, color: 'var(--accent-2)' }}>
              {t.uploadFailed}: {ctrl.error}
            </div>
          )}
          <div className="mono-cap" style={{ textAlign: 'center', marginTop: 'var(--s-2)', color: 'var(--fg-4)' }}>
            {lang === 'zh' ? '首次将创建本体 v1.0' : 'First run will produce ontology v1.0'}
          </div>
        </div>
      </aside>
    </div>
  );
}

export function Sparkle() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 1 L9.6 6.4 L15 8 L9.6 9.6 L8 15 L6.4 9.6 L1 8 L6.4 6.4 Z" fill="white" />
      <circle cx="13" cy="3" r="1" fill="white" opacity="0.7" />
      <circle cx="3" cy="12" r="0.8" fill="white" opacity="0.5" />
    </svg>
  );
}
