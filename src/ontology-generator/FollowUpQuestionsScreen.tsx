// Follow-up Questions screen — renders the questions the swarm emits at the end
// of iteration 2, grouped by layer, each linked to the gap/item it addresses.
import { useState } from 'react';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import type { Bilingual, FollowUpQuestion } from '@/ontology/schema/types';

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

const LAYER_ORDER = ['object', 'rule', 'action', 'event', 'process', 'relationship', 'general'];

export default function FollowUpQuestionsScreen({ t, lang, ctrl }: { t: Strings; lang: Lang; ctrl: OntologyRunController }) {
  const [copied, setCopied] = useState(false);
  const questions = ctrl.followUpQuestions;

  if (!questions || questions.length === 0) {
    return (
      <div className="screen">
        <p className="mono-cap" style={{ color: 'var(--fg-4)' }}>{t.questionsEmpty}</p>
      </div>
    );
  }

  const groups = new Map<string, FollowUpQuestion[]>();
  for (const q of questions) {
    const k = q.layer || 'general';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(q);
  }
  const orderedLayers = LAYER_ORDER.filter((l) => groups.has(l));

  const copyAll = () => {
    const text = questions.map((q, i) => `${i + 1}. ${tx(q.question, lang)}`).join('\n');
    void navigator.clipboard?.writeText(text).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); },
      () => undefined,
    );
  };

  return (
    <div className="screen">
      <div className="card-h">
        <div>
          <h2 style={{ margin: 0 }}>{t.questionsTitle}</h2>
          <p className="mono-cap" style={{ color: 'var(--fg-4)' }}>{t.questionsSub}</p>
        </div>
        <button className="btn" onClick={copyAll}>{copied ? t.copied : t.copyQuestions}</button>
      </div>

      <div style={{ display: 'grid', gap: 18, marginTop: 16 }}>
        {orderedLayers.map((layer) => (
          <section key={layer}>
            <div className="mono-cap">{layerLabel(t, layer)} · {groups.get(layer)!.length}</div>
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              {groups.get(layer)!.map((q) => {
                const target = q.relatedItemId ? stepForItem(q.relatedItemId) : null;
                return (
                  <div key={q.id} className="card" style={{ padding: 12 }}>
                    <div style={{ fontWeight: 600 }}>{tx(q.question, lang)}</div>
                    {q.rationale && (
                      <div className="mono-cap" style={{ color: 'var(--fg-3)', marginTop: 4 }}>{tx(q.rationale, lang)}</div>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {q.addressesGapId && <span className="tag">{t.addressesGap}</span>}
                      {target && (
                        <button className="btn" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => gotoStep(target)}>
                          {t.relatedItem} →
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
