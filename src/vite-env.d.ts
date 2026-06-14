/// <reference types="vite/client" />

// Brings in Vite's ambient module declarations for asset/worker imports
// (e.g. `import X from 'foo?worker'`). Required by the Monaco editor setup,
// which bundles its language/editor web workers locally via `?worker`
// (see src/ontology-generator/json-editor/monaco-setup.ts) so the editor runs
// fully offline with no CDN loader.
