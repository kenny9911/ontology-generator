// ============================================================================
//  JsonEditorScreen — a VS Code-style JSON editor for the ontology layers.
//
//  Five tabs (Data Objects / Rules / Actions / Events / Workflow) each edit one
//  ontology layer's JSON in a Monaco editor (the real VS Code engine, bundled
//  offline). One editor instance switches between five persistent models so each
//  tab keeps its own content, undo history, and inline squiggles.
//
//  Validation is layered like VS Code:
//   • inline (Monaco): syntax + per-layer JSON-Schema squiggles, live.
//   • panel (ours): structural parse issues, schema-shape suggestions with
//     one-click fixes, and the canonical cross-tab `validateOntology` semantics.
//  "Auto-fix" repairs broken JSON deterministically; per-issue "Apply" resolves
//  a shape suggestion. Save reassembles the layers and persists via the
//  controller (append-only version bump); demo mode keeps edits in memory.
//
//  Locked to the { t, lang, ctrl } screen contract; navigation is via the
//  TopBar braces button (StepId 'editor').
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { Lang } from './data';
import type { Strings } from './i18n';
import type { OntologyRunController } from './useOntologyRun';
import type { OntologySummary } from './api';
import { validateOntology } from '@/ontology/schema/validate';

import {
  monaco,
  defineOntogenTheme,
  registerLayerSchemas,
  ONTOGEN_DARK,
  type Monaco,
} from './json-editor/monaco-setup';
import {
  extractLayer,
  serializeLayer,
  serializeLayerDoc,
  parseLayer,
  type EditorLayer,
} from './json-editor/layers';
import { toCleanNodes, fromCleanNodes } from './json-editor/clean';
import { layerUri } from './json-editor/layer-schemas';
import { repairJson } from './json-editor/json-repair';
import { suggestFixes, applySuggestion, type SchemaSuggestion } from './json-editor/json-suggest';
import { buildCandidateOntology, mapIdToLayer, type OwnerLayer } from './json-editor/assemble';
import {
  issueToDiagnostic,
  summarize,
  locateInModel,
  type Diagnostic,
  type DiagnosticsSummary,
} from './json-editor/diagnostics';

interface JsonEditorScreenProps {
  t: Strings;
  lang: Lang;
  ctrl: OntologyRunController;
}

type TabKey = 'objects' | 'rules' | 'actions' | 'events' | 'workflow';
const TABS: { layer: EditorLayer; key: TabKey }[] = [
  { layer: 'objects', key: 'objects' },
  { layer: 'rules', key: 'rules' },
  { layer: 'actions', key: 'actions' },
  { layer: 'events', key: 'events' },
  { layer: 'processes', key: 'workflow' }, // "Workflow" tab == processes layer
];

const NO_DIRTY: Record<EditorLayer, boolean> = {
  objects: false,
  rules: false,
  actions: false,
  events: false,
  processes: false,
};

interface TabState {
  model: monaco.editor.ITextModel;
  baseline: string;
}

/** A panel row: a unified diagnostic plus (optionally) an applyable suggestion. */
interface PanelItem {
  diag: Diagnostic;
  layer: EditorLayer;
  suggestion?: SchemaSuggestion;
}

function ownerToTab(owner: OwnerLayer): EditorLayer {
  if (owner === 'relationships') return 'objects';
  if (owner === 'ruleGroups') return 'rules';
  if (owner === 'unknown') return 'objects';
  return owner;
}

/** Build a Diagnostic from a json-suggest suggestion (so it joins the summary). */
export default function JsonEditorScreen({ t, lang, ctrl }: JsonEditorScreenProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const modelsRef = useRef<Map<EditorLayer, TabState>>(new Map());
  const dirtyRef = useRef<Record<EditorLayer, boolean>>({ ...NO_DIRTY });
  const loadedIdRef = useRef<string | null>(null);
  const recomputeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState<EditorLayer>('objects');
  const [dirty, setDirty] = useState<Record<EditorLayer, boolean>>({ ...NO_DIRTY });
  const [summary, setSummary] = useState<DiagnosticsSummary | null>(null);
  const [panel, setPanel] = useState<PanelItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ msg: string; err?: boolean } | null>(null);
  const [sessions, setSessions] = useState<OntologySummary[] | null>(null);
  const [sessionErr, setSessionErr] = useState(false);

  const ontology = ctrl.ontology;
  const je = t.jsonEditor;

  // -- flash a transient toolbar message ------------------------------------
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashMsg = useCallback((msg: string, err = false) => {
    setFlash({ msg, err });
    if (flashRef.current) clearTimeout(flashRef.current);
    flashRef.current = setTimeout(() => setFlash(null), err ? 4000 : 2200);
  }, []);

  const setDirtyLayer = useCallback((layer: EditorLayer, value: boolean) => {
    if (dirtyRef.current[layer] === value) return;
    const next = { ...dirtyRef.current, [layer]: value };
    dirtyRef.current = next;
    setDirty(next);
  }, []);

  // -- recompute all diagnostics (debounced caller below) -------------------
  const recompute = useCallback(() => {
    const m = monacoRef.current;
    if (!m) return;
    const items: PanelItem[] = [];
    const parsedLayers: Partial<Record<EditorLayer, unknown[]>> = {};
    let allParsed = true;

    for (const { layer } of TABS) {
      const ts = modelsRef.current.get(layer);
      if (!ts) continue;
      const text = ts.model.getValue();
      const pr = parseLayer(text);
      if (!pr.ok) {
        allParsed = false;
        for (const iss of pr.issues) {
          if (iss.kind === 'syntax' || iss.kind === 'not_an_array' || iss.kind === 'item_not_object') {
            items.push({
              diag: {
                key: `syntax:${layer}:${iss.kind}:${iss.index ?? -1}`,
                source: iss.kind === 'syntax' ? 'syntax' : 'schema',
                severity: 'error',
                layer,
                nodeId: '',
                kind: iss.kind === 'syntax' ? 'json_syntax' : 'json_schema',
                message: iss.message,
              },
              layer,
            });
          }
        }
        continue;
      }
      const nodes = pr.nodes ?? [];
      parsedLayers[layer] = nodes;
      for (const iss of pr.issues) {
        if (iss.kind === 'duplicate_id') {
          items.push({
            diag: {
              key: `schema:${layer}:dup:${iss.index ?? -1}`,
              source: 'schema',
              severity: 'error',
              layer,
              nodeId: '',
              kind: 'duplicate_id',
              message: iss.message,
            },
            layer,
          });
        }
      }
      // suggestFixes assumes the INTERNAL shape (id prefixes, bilingual, enum
      // vocab); it would misfire on the clean sample shape, so it is not run
      // here. Cross-tab semantics are validated against the merged internal
      // ontology below.
    }

    // Tier 2 — canonical cross-tab semantics, only when everything parses.
    // The editor shows the CLEAN shape; merge edits back to the internal shape
    // so the canonical validator runs against the real structured ontology.
    if (allParsed && ontology) {
      const internalLayers: Partial<Record<EditorLayer, unknown[]>> = {};
      for (const { layer } of TABS) {
        if (parsedLayers[layer]) internalLayers[layer] = fromCleanNodes(layer, parsedLayers[layer]!, ontology);
      }
      const candidate = buildCandidateOntology(ontology, internalLayers);
      for (const issue of validateOntology(candidate)) {
        const diag = issueToDiagnostic(issue);
        items.push({ diag, layer: ownerToTab(mapIdToLayer(issue.from)) });
      }
    }

    setPanel(items);
    setSummary(summarize(items.map((p) => p.diag), allParsed));
  }, [ontology]);

  const scheduleRecompute = useCallback(() => {
    if (recomputeTimer.current) clearTimeout(recomputeTimer.current);
    recomputeTimer.current = setTimeout(() => recompute(), 220);
  }, [recompute]);

  // -- (re)build the five models from an ontology ---------------------------
  const buildModels = useCallback(
    (m: Monaco) => {
      // dispose any existing models first
      for (const ts of modelsRef.current.values()) ts.model.dispose();
      modelsRef.current.clear();
      for (const { layer } of TABS) {
        const text = ontology
          ? serializeLayerDoc(layer, toCleanNodes(layer, extractLayer(ontology, layer), ontology), ontology)
          : '[]';
        const uri = m.Uri.parse(layerUri(layer));
        const existing = m.editor.getModel(uri);
        if (existing) existing.dispose();
        const model = m.editor.createModel(text, 'json', uri);
        model.onDidChangeContent(() => {
          const cur = modelsRef.current.get(layer);
          if (cur) setDirtyLayer(layer, cur.model.getValue() !== cur.baseline);
          scheduleRecompute();
        });
        modelsRef.current.set(layer, { model, baseline: text });
      }
      dirtyRef.current = { ...NO_DIRTY };
      setDirty({ ...NO_DIRTY });
    },
    [ontology, scheduleRecompute, setDirtyLayer],
  );

  const onMount: OnMount = useCallback(
    (editor, m) => {
      editorRef.current = editor;
      monacoRef.current = m as Monaco;
      defineOntogenTheme(m as Monaco);
      m.editor.setTheme(ONTOGEN_DARK);
      registerLayerSchemas(m as Monaco);
      buildModels(m as Monaco);
      loadedIdRef.current = ontology?.id ?? null;
      const first = modelsRef.current.get(active);
      // @monaco-editor/react mounts with its own auto-created model; we swap in
      // our named-URI model and must dispose the orphan or it leaks per mount.
      const auto = editor.getModel();
      if (first) editor.setModel(first.model);
      if (auto && auto !== first?.model) auto.dispose();
      setMounted(true);
      recompute();
    },
    [active, buildModels, ontology, recompute],
  );

  // -- when the controller's ontology changes, refresh models ---------------
  useEffect(() => {
    const m = monacoRef.current;
    if (!mounted || !m) return;
    if (!ontology) {
      // ontology cleared (reset) — blank every tab
      buildModels(m);
      loadedIdRef.current = null;
      const ts = modelsRef.current.get(active);
      if (ts) editorRef.current?.setModel(ts.model);
      recompute();
      return;
    }
    const changedOntology = loadedIdRef.current !== ontology.id;
    if (changedOntology) {
      buildModels(m);
      loadedIdRef.current = ontology.id;
      const ts = modelsRef.current.get(active);
      if (ts) editorRef.current?.setModel(ts.model);
      recompute();
      return;
    }
    // same ontology, fresh reference (e.g. after save) — refresh non-dirty tabs.
    // Set baseline BEFORE setValue: model.setValue fires onDidChangeContent
    // synchronously, and that listener compares getValue() vs baseline — so the
    // new baseline must already be in place or the tab spuriously flips dirty.
    for (const { layer } of TABS) {
      const ts = modelsRef.current.get(layer);
      if (!ts || dirtyRef.current[layer]) continue;
      const text = serializeLayerDoc(layer, toCleanNodes(layer, extractLayer(ontology, layer), ontology), ontology);
      ts.baseline = text;
      if (ts.model.getValue() !== text) ts.model.setValue(text);
      setDirtyLayer(layer, false);
    }
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ontology]);

  // -- dispose models on unmount --------------------------------------------
  useEffect(() => {
    return () => {
      if (recomputeTimer.current) clearTimeout(recomputeTimer.current);
      if (flashRef.current) clearTimeout(flashRef.current);
      for (const ts of modelsRef.current.values()) ts.model.dispose();
      modelsRef.current.clear();
    };
  }, []);

  // -- lock the editor while a save is in flight (mid-save keystrokes would
  //    otherwise be absorbed into the new baseline and lose dirty tracking) ----
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: busy });
  }, [busy]);

  // -- tab switch -----------------------------------------------------------
  const switchTab = useCallback((layer: EditorLayer) => {
    setActive(layer);
    const ts = modelsRef.current.get(layer);
    if (ts && editorRef.current) editorRef.current.setModel(ts.model);
  }, []);

  // -- toolbar actions ------------------------------------------------------
  const onAutoFix = useCallback(() => {
    const editor = editorRef.current;
    const ts = modelsRef.current.get(active);
    if (!editor || !ts) return;
    const before = ts.model.getValue();
    const res = repairJson(before);
    if (!res.changed) {
      flashMsg(je.noIssues);
      return;
    }
    const full = ts.model.getFullModelRange();
    editor.executeEdits('auto-fix', [{ range: full, text: res.text }]);
    const n = res.fixes.reduce((a, f) => a + f.count, 0);
    // Only claim success if the buffer is actually valid now; a partial repair
    // that still doesn't parse must not flash a misleading "N fixed".
    flashMsg(res.ok ? `${n} ${je.fixed}` : je.invalidJson, !res.ok);
    scheduleRecompute();
  }, [active, flashMsg, je.fixed, je.invalidJson, je.noIssues, scheduleRecompute]);

  const onFormat = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.getAction('editor.action.formatDocument')?.run();
  }, []);

  const onRevert = useCallback(() => {
    const ts = modelsRef.current.get(active);
    if (!ts) return;
    if (ts.model.getValue() !== ts.baseline) ts.model.setValue(ts.baseline);
    setDirtyLayer(active, false);
    scheduleRecompute();
  }, [active, scheduleRecompute, setDirtyLayer]);

  const onApplySuggestion = useCallback(
    (item: PanelItem) => {
      if (!item.suggestion) return;
      const ts = modelsRef.current.get(item.layer);
      if (!ts) return;
      const pr = parseLayer(ts.model.getValue());
      if (!pr.ok || !pr.nodes) return;
      // Re-derive the suggestion against the CURRENT model (not the possibly-stale
      // snapshot in `item`), so an id fix's collision-dedupe sees ids applied by a
      // prior click within the debounce window — matching onFixAll's safety.
      const sug = item.suggestion;
      const fresh =
        suggestFixes(pr.nodes, item.layer).find(
          (s) => s.index === sug.index && s.field === sug.field && s.kind === sug.kind,
        ) ?? sug;
      const next = applySuggestion(pr.nodes, fresh);
      const text = ontology ? serializeLayerDoc(item.layer, next, ontology) : serializeLayer(next);
      if (item.layer !== active) switchTab(item.layer);
      ts.model.setValue(text);
      scheduleRecompute();
    },
    [active, scheduleRecompute, switchTab],
  );

  const onFixAll = useCallback(() => {
    const ts = modelsRef.current.get(active);
    if (!ts) return;
    // 1. syntactic repair
    const repaired = repairJson(ts.model.getValue());
    let text = repaired.ok ? repaired.text : ts.model.getValue();
    // Schema-suggestion auto-fixing assumes the INTERNAL shape and would corrupt
    // the clean sample shape shown here, so only syntactic repair runs.
    if (text !== ts.model.getValue()) {
      const editor = editorRef.current;
      if (editor) {
        editor.executeEdits('fix-all', [{ range: ts.model.getFullModelRange(), text }]);
      } else {
        ts.model.setValue(text);
      }
      flashMsg(je.fixed);
    } else {
      flashMsg(je.noIssues);
    }
    scheduleRecompute();
  }, [active, flashMsg, je.fixed, je.noIssues, scheduleRecompute]);

  const onSave = useCallback(async () => {
    if (!ontology) return;
    const edits: Partial<Record<EditorLayer, unknown[]>> = {};
    for (const { layer } of TABS) {
      const ts = modelsRef.current.get(layer);
      if (!ts) continue;
      const pr = parseLayer(ts.model.getValue());
      if (!pr.ok) return; // gated by `saveable`, but stay defensive
      // The editor shows the CLEAN sample shape; merge the edits back onto the
      // original internal nodes so the structural fields are preserved.
      edits[layer] = fromCleanNodes(layer, pr.nodes ?? [], ontology);
    }
    // The editor's trust boundary: user-edited JSON is `unknown[]`; the canonical
    // validator (run on save / in the panel) is defensive about partial shapes.
    ctrl.applyLayers(edits as Parameters<typeof ctrl.applyLayers>[0]);
    setBusy(true);
    let ok = false;
    try {
      ok = await ctrl.save();
    } finally {
      setBusy(false);
    }
    if (!ok) {
      // Save failed — keep dirty state + edits intact, don't claim "Saved".
      flashMsg(je.saveFailed, true);
      return;
    }
    for (const { layer } of TABS) {
      const ts = modelsRef.current.get(layer);
      if (ts) ts.baseline = ts.model.getValue();
    }
    dirtyRef.current = { ...NO_DIRTY };
    setDirty({ ...NO_DIRTY });
    flashMsg(je.saved);
    recompute();
  }, [ontology, ctrl, flashMsg, je.saved, je.saveFailed, recompute]);

  // -- historical-ontology picker -------------------------------------------
  const refreshSessions = useCallback(() => {
    setSessionErr(false);
    ctrl
      .listSaved()
      .then(setSessions)
      .catch(() => {
        setSessions([]);
        setSessionErr(true);
      });
  }, [ctrl]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  const anyDirty = useMemo(() => Object.values(dirty).some(Boolean), [dirty]);

  const onPick = useCallback(
    async (id: string) => {
      if (!id) return;
      if (anyDirty && !window.confirm(je.discardConfirm)) return;
      // Force a full rebuild even when re-selecting the SAME ontology id: clear
      // loadedIdRef so the [ontology] effect takes the buildModels branch (which
      // resets dirty + reseeds every tab). Otherwise the same-id "refresh
      // non-dirty tabs" path would skip dirty tabs and the confirmed discard
      // would be a silent no-op.
      loadedIdRef.current = null;
      try {
        await ctrl.loadSaved(id);
        refreshSessions();
      } catch {
        /* ctrl.error surfaces elsewhere */
      }
    },
    [anyDirty, ctrl, je.discardConfirm, refreshSessions],
  );

  // -- locate a diagnostic in the editor ------------------------------------
  const onLocate = useCallback(
    (item: PanelItem) => {
      if (item.layer !== active) switchTab(item.layer);
      const ts = modelsRef.current.get(item.layer);
      const editor = editorRef.current;
      if (!ts || !editor) return;
      if (item.diag.range) {
        editor.revealRangeInCenter(item.diag.range);
        editor.setPosition({
          lineNumber: item.diag.range.startLineNumber,
          column: item.diag.range.startColumn,
        });
      } else if (item.diag.nodeId) {
        const range = locateInModel(ts.model, item.diag.nodeId, item.diag.field);
        editor.revealRangeInCenter(range);
        editor.setPosition({ lineNumber: range.startLineNumber, column: range.startColumn });
      }
      editor.focus();
    },
    [active, switchTab],
  );

  const isDemo = ctrl.mode === 'demo';
  const saveable = summary?.saveable ?? false;
  const canSave = mounted && !!ontology && anyDirty && saveable && !busy && !ctrl.running;

  return (
    <div className="screen json-editor">
      <div className="json-ed-head">
        <div>
          <h2 className="screen-title">{je.title}</h2>
          <p className="screen-sub">{je.subtitle}</p>
        </div>
        <div className="json-ed-picker">
          <select
            className="ctl"
            value=""
            onChange={(e) => void onPick(e.target.value)}
            disabled={ctrl.running}
            aria-label={je.pickOntology}
          >
            <option value="">{je.pickOntology}</option>
            {sessions?.map((s) => (
              <option key={s.id} value={s.id}>
                {(lang === 'zh' ? s.nameZh ?? s.name : s.name) || s.id} · v1.{s.version}.0
              </option>
            ))}
          </select>
          <button className="ctl" type="button" onClick={refreshSessions} title={je.reload}>
            ⟳
          </button>
          {sessionErr && <span className="tag warn">{je.loadError}</span>}
        </div>
      </div>

      <div className="json-ed-tabs" role="tablist">
        {TABS.map(({ layer, key }) => {
          const counts = summary?.byLayer[layer];
          const errs = counts?.errors ?? 0;
          return (
            <button
              key={layer}
              role="tab"
              aria-selected={active === layer}
              className={`json-ed-tab ${active === layer ? 'active' : ''}`}
              onClick={() => switchTab(layer)}
            >
              <span className="json-ed-tab-label">{je.tabs[key]}</span>
              {dirty[layer] && <span className="json-ed-dot" title={je.dirtyBadge} />}
              {errs > 0 && <span className="json-ed-count">{errs}</span>}
            </button>
          );
        })}
      </div>

      <div className="json-ed-toolbar">
        <button className="btn" type="button" onClick={onAutoFix} disabled={!mounted}>
          {je.autofix}
        </button>
        <button className="btn" type="button" onClick={onFixAll} disabled={!mounted}>
          {je.applyAllFixes}
        </button>
        <button className="btn" type="button" onClick={onFormat} disabled={!mounted}>
          {je.format}
        </button>
        <button className="btn" type="button" onClick={onRevert} disabled={!mounted || !dirty[active]}>
          {je.revert}
        </button>
        <span className="json-ed-spacer" />
        {flash && <span className={`tag ${flash.err ? 'warn' : 'ok'} json-ed-flash`}>{flash.msg}</span>}
        {isDemo && <span className="tag json-ed-demo">{je.demoNotPersisted}</span>}
        {ontology && anyDirty && summary && !summary.saveable && (
          <span className="tag warn">{je.invalidJson}</span>
        )}
        <button className="btn primary" type="button" onClick={() => void onSave()} disabled={!canSave}>
          {busy ? je.saving : je.save}
        </button>
      </div>

      <div className="json-ed-body">
        <div className="json-ed-monaco">
          {!ontology && (
            <div className="json-ed-empty mono-cap">{je.empty}</div>
          )}
          <Editor
            height="100%"
            theme={ONTOGEN_DARK}
            defaultLanguage="json"
            loading=""
            onMount={onMount}
            options={{
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 13,
              tabSize: 2,
              scrollBeyondLastLine: false,
              formatOnPaste: true,
              fixedOverflowWidgets: true,
              renderValidationDecorations: 'on',
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            }}
          />
        </div>

        <aside className="json-ed-issues card scroll">
          <div className="card-h">
            <span>{je.issuesTitle}</span>
            {summary && (
              <span className="mono-cap">
                {summary.errors} {je.errors} · {summary.warnings} {je.warnings}
              </span>
            )}
          </div>
          {(!summary || summary.diagnostics.length === 0) && (
            <div className="json-ed-noissues mono-cap">{je.noIssues}</div>
          )}
          {panel
            .slice()
            .sort((a, b) =>
              a.diag.severity === b.diag.severity ? 0 : a.diag.severity === 'error' ? -1 : 1,
            )
            .map((item) => (
              <div
                key={item.diag.key}
                className="json-ed-issue"
                data-sev={item.diag.severity}
                onClick={() => onLocate(item)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onLocate(item);
                  }
                }}
              >
                <div className="json-ed-issue-msg">{item.diag.message}</div>
                <div className="json-ed-issue-line">
                  <span className="mono-cap">{je.tabs[tabKeyFor(item.layer)]}</span>
                  {item.diag.nodeId && <span className="mono-cap"> · {item.diag.nodeId}</span>}
                  {item.diag.relatedLayer && item.diag.relatedLayer !== item.layer && (
                    <span className="json-ed-related">
                      {je.expectedIn} {je.tabs[tabKeyFor(item.diag.relatedLayer)]}
                    </span>
                  )}
                </div>
                {item.suggestion?.fixable && (
                  <button
                    type="button"
                    className="btn tiny json-ed-apply"
                    onClick={(e) => {
                      e.stopPropagation();
                      onApplySuggestion(item);
                    }}
                  >
                    {je.applyFix}
                  </button>
                )}
              </div>
            ))}
          {summary && !summary.saveable && summary.diagnostics.length > 0 && (
            <div className="json-ed-gate mono-cap">{je.cantCheck}</div>
          )}
        </aside>
      </div>
    </div>
  );
}

function tabKeyFor(layer: EditorLayer): TabKey {
  return TABS.find((tab) => tab.layer === layer)?.key ?? 'objects';
}
