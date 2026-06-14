// ============================================================================
//  monaco-setup.ts — wire the Monaco editor (the VS Code engine) to run fully
//  OFFLINE inside this Vite SPA. No CDN loader.
//
//  Three things happen here (the first two as import side-effects, once):
//    1. Teach Monaco how to spawn its web workers from Vite-bundled chunks. The
//       JSON language service runs in `json.worker`; everything else in the base
//       `editor.worker`. Vite's `?worker` suffix turns each import into a bundled
//       Worker constructor, so the whole engine ships in `dist/` (offline).
//    2. Point @monaco-editor/react at the LOCALLY-bundled `monaco-editor`
//       package (loader.config) instead of its default CDN loader.
//    3. Expose `defineOntogenTheme` (the .ontogen dark theme) and
//       `registerLayerSchemas` (per-layer JSON Schemas → inline diagnostics),
//       both idempotent, called from the screen's onMount.
//
//  `src/vite-env.d.ts` provides the `vite/client` types for the `?worker` imports.
// ============================================================================

import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { LAYER_SCHEMAS, schemaUri, layerFileMatch } from './layer-schemas';
import { EDITOR_LAYERS } from './layers';

export type Monaco = typeof monaco;

/** The .ontogen dark theme name (deep-space blue, aligned to the CSS tokens). */
export const ONTOGEN_DARK = 'ontogen-dark';

// 1. Local worker factory — runs at import time.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    return label === 'json' ? new JsonWorker() : new EditorWorker();
  },
};

// 2. Use the bundled package, not the CDN.
loader.config({ monaco });

let themeDefined = false;

/** Register the .ontogen dark theme. Idempotent. */
export function defineOntogenTheme(m: Monaco): void {
  if (themeDefined) return;
  themeDefined = true;
  m.editor.defineTheme(ONTOGEN_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string.key.json', foreground: '7aa2ff' },
      { token: 'string.value.json', foreground: '6cf2d9' },
      { token: 'number', foreground: 'ffc266' },
      { token: 'keyword.json', foreground: 'b495ff' },
    ],
    colors: {
      'editor.background': '#0f1426',
      'editor.foreground': '#f2f6ff',
      'editorLineNumber.foreground': '#8290bb',
      'editorLineNumber.activeForeground': '#ccd7f2',
      'editor.lineHighlightBackground': '#131a2e',
      'editor.selectionBackground': '#2e3a5c',
      'editorCursor.foreground': '#7aa2ff',
      'editorIndentGuide.background1': '#232b45',
      'editorWhitespace.foreground': '#232b45',
      'editorError.foreground': '#ff7e9c',
      'editorWarning.foreground': '#ffc266',
    },
  });
}

/** Shape of the (runtime-present, type-deprecated in 0.55) JSON defaults object. */
interface JsonDiagnosticsOptions {
  validate?: boolean;
  allowComments?: boolean;
  trailingCommas?: 'error' | 'warning' | 'ignore';
  enableSchemaRequest?: boolean;
  schemas?: { uri: string; fileMatch?: string[]; schema?: object }[];
}
interface JsonDefaultsLike {
  setDiagnosticsOptions(options: JsonDiagnosticsOptions): void;
}

/** Register per-layer JSON Schemas + diagnostics options. Idempotent-safe.
 *  `monaco.languages.json` is type-deprecated in 0.55 but present at runtime
 *  (the full `monaco-editor` bundle registers the JSON contribution), so we
 *  reach `jsonDefaults` through a narrow cast rather than the deprecated type. */
export function registerLayerSchemas(m: Monaco): void {
  const jsonLang = (m.languages as unknown as { json?: { jsonDefaults?: JsonDefaultsLike } }).json;
  const defaults = jsonLang?.jsonDefaults;
  if (!defaults) return;
  defaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    trailingCommas: 'error',
    enableSchemaRequest: false,
    schemas: EDITOR_LAYERS.map((layer) => ({
      uri: schemaUri(layer),
      fileMatch: [layerFileMatch(layer)],
      schema: LAYER_SCHEMAS[layer] as object,
    })),
  });
}

export { monaco };
