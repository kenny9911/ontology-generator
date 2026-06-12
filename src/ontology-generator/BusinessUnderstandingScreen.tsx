// Business Understanding screen — renders the SME swarm's BusinessBrief:
// personas, use cases, glossary, and the expected-vs-found recall checklist.
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import type { Bilingual } from '@/ontology/schema/types';

function tx(b: Bilingual | undefined, lang: Lang): string {
  if (!b) return '';
  return lang === 'zh' ? b.zh || b.en : b.en || b.zh;
}

export default function BusinessUnderstandingScreen({ t, lang, ctrl }: { t: Strings; lang: Lang; ctrl: OntologyRunController }) {
  const brief = ctrl.businessBrief;
  if (!brief) {
    return (
      <div className="screen">
        <p className="mono-cap" style={{ color: 'var(--fg-4)' }}>{t.briefEmpty}</p>
      </div>
    );
  }

  const foundCount = brief.expectedEntities.filter((e) => e.found).length;

  return (
    <div className="screen">
      <div className="card-h">
        <div>
          <h2 style={{ margin: 0 }}>{t.briefTitle}</h2>
          <p className="mono-cap" style={{ color: 'var(--fg-4)' }}>{t.briefSub}</p>
        </div>
        <span className={`tag ${brief.webAugmented ? 'ok' : ''}`}>{brief.webAugmented ? t.webAugmented : t.parametric}</span>
      </div>

      <p style={{ marginTop: 10 }}>{tx(brief.summary, lang)}</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 16, alignItems: 'start' }}>
        <section>
          <div className="mono-cap">{t.personas} · {brief.personas.length}</div>
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            {brief.personas.map((p) => (
              <div key={p.id} className="persona-card">
                <strong>{tx(p.name, lang)}</strong>
                {p.description && <div className="mono-cap" style={{ color: 'var(--fg-3)', marginTop: 4 }}>{tx(p.description, lang)}</div>}
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="mono-cap">{t.useCases} · {brief.useCases.length}</div>
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            {brief.useCases.map((u) => (
              <div key={u.id} className="card" style={{ padding: 10 }}>
                <strong>{tx(u.name, lang)}</strong>
                {u.description && <div className="mono-cap" style={{ color: 'var(--fg-3)', marginTop: 4 }}>{tx(u.description, lang)}</div>}
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="mono-cap">{t.glossary} · {brief.glossary.length}</div>
          <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
            {brief.glossary.map((g, i) => (
              <div key={i} className="card" style={{ padding: 8 }}>
                <strong>{tx(g.term, lang)}</strong>
                <div className="mono-cap" style={{ color: 'var(--fg-3)' }}>{tx(g.definition, lang)}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div style={{ marginTop: 20 }}>
        <div className="mono-cap">
          {t.expectedItems} · {foundCount}/{brief.expectedEntities.length} {t.entityFound}
        </div>
        <div className="checklist" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {brief.expectedEntities.map((e) => (
            <span key={e.id} className={`tag ${e.found ? 'ok' : 'warn'}`} title={e.kind}>
              {e.found ? '✓' : '○'} {tx(e.name, lang)}
            </span>
          ))}
        </div>
      </div>

      {brief.references && brief.references.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="mono-cap">{t.references}</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {brief.references.map((r, i) => (
              <li key={i} className="mono-cap" style={{ color: 'var(--fg-3)' }}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
