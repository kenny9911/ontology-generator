// Coverage screen — renders the CoverageReport: per-layer recall bars,
// per-use-case coverage, and the gaps panel (each gap links to its item).
// In hyper mode it additionally renders the sentence-level Document coverage
// card (DocumentCoverageEval): ratio bar, status counts, and a findings table.
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import type {
  Bilingual,
  Severity,
  DocumentCoverageEval,
  SentenceCoverageStatus,
} from '@/ontology/schema/types';

function tx(b: Bilingual | undefined, lang: Lang): string {
  if (!b) return '';
  return lang === 'zh' ? b.zh || b.en : b.en || b.zh;
}

function layerLabel(t: Strings, layer: string): string {
  switch (layer) {
    case 'object': return t.layerObject;
    case 'rule': return t.layerRule;
    case 'action': return t.layerAction;
    case 'event': return t.layerEvent;
    case 'process': return t.layerProcess;
    case 'relationship': return t.layerRelationship;
    default: return t.layerGeneral;
  }
}

function sevLabel(t: Strings, sev: Severity): string {
  return sev === 'block' ? t.gapBlock : sev === 'warn' ? t.gapWarn : t.gapInfo;
}

/** Map a node id prefix to the review step that owns it. */
function stepForItem(id: string): string | null {
  if (id.startsWith('objectType:') || id.startsWith('rel:')) return 'objects';
  if (id.startsWith('rule:')) return 'rules';
  if (id.startsWith('action:')) return 'actions';
  if (id.startsWith('event:')) return 'events';
  if (id.startsWith('process:')) return 'processes';
  return null;
}

function gotoStep(target: string): void {
  window.dispatchEvent(new CustomEvent('ontogen:goto', { detail: target }));
}

function RecallBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="recall-bar" title={`${pct}%`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Status chip class + label for one sentence-coverage verdict. */
function docCovStatus(t: Strings, status: SentenceCoverageStatus): { cls: string; label: string } {
  switch (status) {
    case 'covered': return { cls: 'tag ok', label: t.docCoverage.covered };
    case 'partial': return { cls: 'tag ai', label: t.docCoverage.partial };
    case 'uncovered': return { cls: 'tag warn', label: t.docCoverage.uncovered };
    case 'uncoverable': return { cls: 'tag', label: t.docCoverage.uncoverable };
  }
}

/** The hyper-mode "Document coverage" card — sentence-level coverage eval. */
function DocCoverageCard({ t, doc }: { t: Strings; doc: DocumentCoverageEval }) {
  const pct = Math.round(Math.max(0, Math.min(1, doc.coverageRatio)) * 100);
  const counts: { key: SentenceCoverageStatus; value: number }[] = [
    { key: 'covered', value: doc.covered },
    { key: 'partial', value: doc.partial },
    { key: 'uncovered', value: doc.uncovered },
    { key: 'uncoverable', value: doc.uncoverable },
  ];
  return (
    <section className="card" style={{ marginTop: 22, padding: 'var(--s-5)' }}>
      <div className="card-h" style={{ padding: 0, border: 'none' }}>
        <div>
          <h3 style={{ margin: 0 }}>{t.docCoverage.title}</h3>
          <p className="mono-cap" style={{ color: 'var(--fg-4)' }}>{t.docCoverage.subtitle}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>
            {t.docCoverage.pass} {doc.pass}
          </span>
          <span className={`tag ${doc.meetsTarget ? 'ok' : 'warn'}`}>
            {doc.meetsTarget ? t.docCoverage.meetsTarget : t.docCoverage.missesTarget}
            {' · '}{t.docCoverage.target} {Math.round(doc.target * 100)}%
          </span>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <span>{t.docCoverage.ratioLabel}</span>
          <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>{pct}%</span>
        </div>
        <RecallBar value={doc.coverageRatio} />
      </div>

      <div className="doccov-stats" style={{ marginTop: 12 }}>
        {counts.map(({ key, value }) => {
          const s = docCovStatus(t, key);
          return (
            <span key={key} className={s.cls}>
              {s.label} · {value}
            </span>
          );
        })}
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="mono-cap">{t.docCoverage.findingsTitle} · {doc.findings.length}</div>
        {doc.findings.length === 0 ? (
          <p className="mono-cap" style={{ color: 'var(--accent-3)', marginTop: 8 }}>{t.docCoverage.empty}</p>
        ) : (
          <table className="doccov-table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>#</th>
                <th>{t.docCoverage.colSentence}</th>
                <th>{t.docCoverage.colStatus}</th>
                <th>{t.docCoverage.colMissing}</th>
                <th>{t.docCoverage.colExpected}</th>
              </tr>
            </thead>
            <tbody>
              {doc.findings.map((f) => {
                const s = docCovStatus(t, f.status);
                return (
                  <tr key={f.idx}>
                    <td className="mono-cap">{f.idx}</td>
                    <td className="sent" title={f.text}>{f.text}</td>
                    <td><span className={s.cls}>{s.label}</span></td>
                    <td>{f.missing ?? ''}</td>
                    <td className="mono-cap">
                      {(f.expectedKinds ?? []).map((k) => layerLabel(t, k)).join(' · ')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export default function CoverageScreen({ t, lang, ctrl }: { t: Strings; lang: Lang; ctrl: OntologyRunController }) {
  const cov = ctrl.coverageReport;
  const brief = ctrl.businessBrief;
  const doccov = ctrl.documentCoverage ?? ctrl.ontology?.metadata?.documentCoverage ?? null;
  if (!cov && !doccov) {
    return (
      <div className="screen">
        <p className="mono-cap" style={{ color: 'var(--fg-4)' }}>{t.coverageEmpty}</p>
      </div>
    );
  }

  const ucName = (id: string): string => {
    const u = brief?.useCases.find((x) => x.id === id);
    return u ? tx(u.name, lang) : id;
  };

  return (
    <div className="screen">
      {cov && (
        <>
          <div className="card-h">
            <div>
              <h2 style={{ margin: 0 }}>{t.coverageTitle}</h2>
              <p className="mono-cap" style={{ color: 'var(--fg-4)' }}>{t.coverageSub}</p>
            </div>
            <span className="tag ok">{t.overallRecall} {Math.round(cov.overallRecall * 100)}%</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 16, alignItems: 'start' }}>
            <section>
              <div className="mono-cap">{t.perLayerCoverage}</div>
              <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
                {cov.perLayer.map((l) => (
                  <div key={l.layer}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span>{layerLabel(t, l.layer)}</span>
                      <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>
                        {l.found}/{l.expected} {t.foundLabel}
                      </span>
                    </div>
                    <RecallBar value={l.recall} />
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="mono-cap">{t.perUseCaseCoverage}</div>
              <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
                {cov.perUseCase.map((u) => (
                  <div key={u.useCaseId}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, gap: 8 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ucName(u.useCaseId)}</span>
                      <span className="mono-cap" style={{ color: 'var(--fg-4)', flexShrink: 0 }}>{Math.round(u.coverage * 100)}%</span>
                    </div>
                    <RecallBar value={u.coverage} />
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div style={{ marginTop: 22 }}>
            <div className="mono-cap">{t.gaps} · {cov.gaps.length}</div>
            {cov.gaps.length === 0 ? (
              <p className="mono-cap" style={{ color: 'var(--fg-4)', marginTop: 8 }}>{t.gapsEmpty}</p>
            ) : (
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                {cov.gaps.map((g) => {
                  const target = g.relatedItemId ? stepForItem(g.relatedItemId) : null;
                  return (
                    <div key={g.id} className="gap-card">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={`tag ${g.severity === 'block' ? 'warn' : g.severity === 'warn' ? '' : 'ai'}`}>
                          {sevLabel(t, g.severity)}
                        </span>
                        <span className="mono-cap" style={{ color: 'var(--fg-4)' }}>{layerLabel(t, g.layer)}</span>
                        {target && (
                          <button className="btn" style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 12 }} onClick={() => gotoStep(target)}>
                            {t.jumpToItem}
                          </button>
                        )}
                      </div>
                      <div style={{ marginTop: 6 }}>{tx(g.description, lang)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {doccov && <DocCoverageCard t={t} doc={doccov} />}
    </div>
  );
}
