// LLM Settings screen — per-agent model routing (HYPER_AUTOMATION_DESIGN §5.1).
// Renders the agent registry from `GET llm.agents` grouped by pipeline, shows
// each agent's resolved provider+model with a source badge (env > settings >
// router > default), and lets the user edit per-agent overrides plus the
// global defaults / smart-router toggle. Save posts the draft to
// `POST llm.settings` and re-renders the recomputed assignments.
//
// Reachable at any time (needs no run, no LLM key). The locked screen contract
// is { t, lang, ctrl }; this screen never touches the controller, so `ctrl` is
// accepted in the prop TYPE but not destructured (noUnusedParameters).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import type { AgentDef, AgentModelAssignment, Bilingual, LlmSettings } from '@/ontology/schema/types';
import { getLlmAgents, saveLlmSettings } from './api';

function tx(b: Bilingual | undefined, lang: Lang): string {
  if (!b) return '';
  return lang === 'zh' ? b.zh || b.en : b.en || b.zh;
}

/** Fixed display order of the agent groups. */
const GROUP_ORDER: AgentDef['group'][] = ['fast', 'swarm', 'hyper', 'inference', 'shared'];

/** Providers the backend LLM client supports (llm.ts). Empty = inherit. */
const PROVIDERS = ['openrouter', 'openai', 'google', 'deepseek', 'qwen', 'moonshot'] as const;

/** Deep-enough clone so draft edits never mutate the last-loaded settings. */
function cloneSettings(s: LlmSettings): LlmSettings {
  const overrides: LlmSettings['overrides'] = {};
  for (const [id, ov] of Object.entries(s.overrides ?? {})) overrides[id] = { ...ov };
  return { ...s, overrides };
}

/** Build the save payload: empty-string / blank overrides are OMITTED (the
 *  key is deleted), never sent as ''. Same for the global defaults. */
function sanitizeSettings(s: LlmSettings): LlmSettings {
  const overrides: LlmSettings['overrides'] = {};
  for (const [id, ov] of Object.entries(s.overrides ?? {})) {
    const model = ov.model?.trim();
    const provider = ov.provider?.trim();
    const out: { provider?: string; model?: string } = {};
    if (model) out.model = model;
    if (provider) out.provider = provider;
    if (out.model !== undefined || out.provider !== undefined) overrides[id] = out;
  }
  const result: LlmSettings = { overrides };
  const defaultModel = s.defaultModel?.trim();
  const defaultProvider = s.defaultProvider?.trim();
  if (defaultModel) result.defaultModel = defaultModel;
  if (defaultProvider) result.defaultProvider = defaultProvider;
  if (s.routerEnabled !== undefined) result.routerEnabled = s.routerEnabled;
  const tavilyApiKey = s.tavilyApiKey?.trim();
  if (tavilyApiKey) result.tavilyApiKey = tavilyApiKey;
  return result;
}

export default function LLMSettingsScreen({ t, lang }: { t: Strings; lang: Lang; ctrl?: OntologyRunController }) {
  const ls = t.llmSettings;

  const [agents, setAgents] = useState<AgentDef[] | null>(null);
  const [assignments, setAssignments] = useState<AgentModelAssignment[]>([]);
  /** Last-loaded (or last-saved) settings — what Reset restores. */
  const [loaded, setLoaded] = useState<LlmSettings | null>(null);
  /** The editable draft posted on Save. */
  const [draft, setDraft] = useState<LlmSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await getLlmAgents();
      setAgents(res.agents);
      setAssignments(res.assignments);
      setLoaded(res.settings);
      setDraft(cloneSettings(res.settings));
    } catch (cause: unknown) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Clear the transient saved-confirmation timer on unmount.
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const byAgent = useMemo(
    () => new Map(assignments.map((a) => [a.agentId, a])),
    [assignments],
  );

  const grouped = useMemo(() => {
    const map: Record<AgentDef['group'], AgentDef[]> = { fast: [], swarm: [], hyper: [], inference: [], shared: [] };
    for (const a of agents ?? []) map[a.group].push(a);
    return map;
  }, [agents]);

  // ---- draft mutations -------------------------------------------------

  const setOverride = useCallback((agentId: string, field: 'model' | 'provider', value: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = cloneSettings(prev);
      const ov = { ...(next.overrides[agentId] ?? {}) };
      if (value === '') delete ov[field];
      else ov[field] = value;
      if (ov.model === undefined && ov.provider === undefined) delete next.overrides[agentId];
      else next.overrides[agentId] = ov;
      return next;
    });
  }, []);

  const setGlobal = useCallback((field: 'defaultModel' | 'defaultProvider' | 'tavilyApiKey', value: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = cloneSettings(prev);
      if (value === '') delete next[field];
      else next[field] = value;
      return next;
    });
  }, []);

  const setRouter = useCallback((on: boolean) => {
    setDraft((prev) => (prev ? { ...cloneSettings(prev), routerEnabled: on } : prev));
  }, []);

  // ---- save / reset ------------------------------------------------------

  const onSave = useCallback(async () => {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await saveLlmSettings(sanitizeSettings(draft));
      setLoaded(res.settings);
      setDraft(cloneSettings(res.settings));
      setAssignments(res.assignments);
      setSavedFlash(true);
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setSavedFlash(false), 2500);
    } catch (cause: unknown) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [draft, saving]);

  const onReset = useCallback(() => {
    if (loaded) setDraft(cloneSettings(loaded));
    setSaveError(null);
  }, [loaded]);

  // ---- render --------------------------------------------------------------

  if (loadError) {
    return (
      <div className="screen llm-settings">
        <div className="card" style={{ padding: 'var(--s-4)', display: 'flex', alignItems: 'center', gap: 'var(--s-4)' }}>
          <span className="mono-cap" style={{ color: 'var(--danger)' }}>
            {ls.loadError} — {loadError}
          </span>
          <button className="btn ghost" onClick={() => void load()}>{ls.retry}</button>
        </div>
      </div>
    );
  }

  if (!agents || !draft) {
    return (
      <div className="screen llm-settings">
        <p className="mono-cap" style={{ color: 'var(--fg-4)' }}>{t.loading}</p>
      </div>
    );
  }

  return (
    <div className="screen llm-settings scroll">
      <div className="card-h" style={{ borderBottom: 'none', padding: 0 }}>
        <div>
          <h2 style={{ margin: 0 }}>{ls.title}</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
          {savedFlash && <span className="tag ok">{ls.saved}</span>}
          {saveError && <span className="tag warn" title={saveError}>{t.saveFailed}</span>}
          <button className="btn ghost" onClick={onReset}>{ls.reset}</button>
          <button className="btn primary" disabled={saving} onClick={() => void onSave()}>
            {saving ? t.saving : ls.save}
          </button>
        </div>
      </div>
      <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 13, lineHeight: 1.55, maxWidth: 760 }}>
        {ls.subtitle}
      </p>

      {/* Global defaults + smart-router toggle */}
      <div className="card">
        <div className="card-h">{ls.globalSection}</div>
        <div className="llm-global">
          <label className="llm-field">
            <span className="mono-cap">{ls.defaultModel}</span>
            <input
              className="llm-input"
              value={draft.defaultModel ?? ''}
              placeholder={ls.modelPlaceholder}
              onChange={(e) => setGlobal('defaultModel', e.target.value)}
            />
          </label>
          <label className="llm-field">
            <span className="mono-cap">{ls.defaultProvider}</span>
            <select
              className="llm-select"
              value={draft.defaultProvider ?? ''}
              onChange={(e) => setGlobal('defaultProvider', e.target.value)}
            >
              <option value="">{ls.providerInherit}</option>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
          <div className="llm-field">
            <label className="llm-toggle">
              <input
                type="checkbox"
                checked={draft.routerEnabled !== false}
                onChange={(e) => setRouter(e.target.checked)}
              />
              <span>{ls.routerToggle}</span>
            </label>
            <span className="llm-hint">{ls.routerHint}</span>
          </div>
          <label className="llm-field">
            <span className="mono-cap">{ls.tavilyLabel}</span>
            <input
              className="llm-input"
              value={draft.tavilyApiKey ?? ''}
              placeholder={ls.tavilyPlaceholder}
              onChange={(e) => setGlobal('tavilyApiKey', e.target.value)}
            />
            <span className="llm-hint">{ls.tavilyHint}</span>
          </label>
        </div>
      </div>

      {/* Agent registry, grouped fast → swarm → hyper → inference → shared */}
      {GROUP_ORDER.filter((g) => grouped[g].length > 0).map((group) => (
        <div className="card" key={group}>
          <div className="card-h">
            <span>{ls.groupLabels[group]}</span>
            <span>{grouped[group].length}</span>
          </div>
          <div>
            {grouped[group].map((agent) => {
              const resolved = byAgent.get(agent.id);
              const ov = draft.overrides[agent.id];
              return (
                <div className="llm-agent-row" key={agent.id}>
                  <div className="llm-agent-info">
                    <div className="llm-agent-name" title={agent.id}>
                      <span>{tx(agent.label, lang)}</span>
                      <span className="tag ai">{ls.purposeLabels[agent.purpose]}</span>
                    </div>
                    {agent.description && (
                      <div className="llm-agent-desc">{tx(agent.description, lang)}</div>
                    )}
                  </div>
                  <div className="llm-agent-resolved">
                    <span className="llm-model">
                      {resolved ? `${resolved.provider} · ${resolved.model}` : '—'}
                    </span>
                    <span
                      className="llm-source-badge"
                      data-source={resolved?.source ?? 'default'}
                      title={resolved?.rationale ?? ''}
                    >
                      {ls.sourceLabels[resolved?.source ?? 'default']}
                    </span>
                  </div>
                  <div className="llm-agent-overrides">
                    <input
                      className="llm-input"
                      value={ov?.model ?? ''}
                      placeholder={resolved?.model ?? ls.modelPlaceholder}
                      onChange={(e) => setOverride(agent.id, 'model', e.target.value)}
                    />
                    <select
                      className="llm-select"
                      value={ov?.provider ?? ''}
                      onChange={(e) => setOverride(agent.id, 'provider', e.target.value)}
                    >
                      <option value="">{ls.providerInherit}</option>
                      {PROVIDERS.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
