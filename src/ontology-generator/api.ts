/**
 * Ontology Generator — client API service (THE ONLY fetch site).
 *
 * Every screen and the `useOntologyRun` controller call these typed wrappers;
 * no component issues a raw `fetch`. All requests go to the dedicated
 * action-routed serverless handler at `/api/ontology-gen?action=…`
 * (DESIGN_SPEC §8.2). Request/response bodies are typed against the LOCKED
 * canonical schema in `@/ontology/schema/types`.
 *
 * Conventions (DESIGN_SPEC §1):
 *   - GET for pure reads (`samples`, `list`, `get`, `run.get`, `graph-status`);
 *     POST for everything else; DELETE for `delete`.
 *   - Auth: OPTIONAL. If a JWT is present in localStorage under the
 *     `ontogen_auth_token` key it is sent as `Authorization: Bearer <JWT>`;
 *     otherwise requests are sent unauthenticated (the backend treats them as
 *     an anonymous guest unless ONTOLOGY_GEN_REQUIRE_AUTH=1).
 *   - Success envelope: `{ ok: true, …payload }`. Error envelope:
 *     `{ ok: false, error: string, code?: string }`. Non-2xx (or `ok:false`)
 *     throws a typed `ApiError`.
 */

import type {
  Ontology,
  SourceDocument,
  ParsedSource,
  OntologyRun,
  Stage,
  GeneratedBundle,
  GeneratorTarget,
  DomainKey,
  Bilingual,
  SwarmPhase,
  RunPhase,
  BusinessBrief,
  CoverageReport,
  FollowUpQuestion,
  TerminologyExtraction,
  DocumentCoverageEval,
  InferenceResult,
  AgentDef,
  AgentModelAssignment,
  LlmSettings,
} from '@/ontology/schema/types';
import type { ValidationIssue } from '@/ontology/schema/validate';

// ===========================================================================
// Public auxiliary types (frontend-only projections of backend shapes)
// ===========================================================================

/** A bundled sample corpus (one per DomainKey + generic), from `?action=samples`. */
export interface SampleCorpus {
  id: string;
  domain: DomainKey;
  label: Bilingual;
  sublabel: Bilingual;
  docNames: string[];
}

/**
 * Summary projection returned by `?action=list` (defined in the backend
 * `store.ts`; mirrored here for the frontend, DESIGN_SPEC §3.4).
 */
export interface OntologySummary {
  id: string;
  uuid: string;
  name: string;
  nameZh?: string;
  domain: DomainKey;
  version: number;
  status: 'draft' | 'published';
  confidence: number;
  stats?: Record<string, number>;
  updatedAt: string;
  publishedAt?: string;
}

/** Input for `run.start`: either explicit source ids or a bundled sample. */
export type RunStartInput =
  | { name: Bilingual; domain?: DomainKey; sourceIds: string[]; autoName?: boolean }
  | { name: Bilingual; sampleId: string };

/** Result of a single re-run of one extraction stage (`stage.*`). */
export interface StageRunResult {
  stage: Stage;
  items: unknown[];
  log: string[];
  stageCritique?: string;
  issues: ValidationIssue[];
}

/** Neo4j mirror status returned alongside `publish` / `import-graph`. */
export interface Neo4jStatus {
  mirrored: boolean;
  nodes?: number;
  rels?: number;
  reason?: string;
}

// ===========================================================================
// Transport — single fetch chokepoint + typed errors
// ===========================================================================

/** Thrown on any non-ok response or an `{ ok: false }` error envelope. */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const BASE = '/api/ontology-gen';

/** localStorage key holding an optional JWT. Absent token => requests are
 *  sent without an Authorization header (the backend treats them as guest). */
const TOKEN_KEY = 'ontogen_auth_token';

function authToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = authToken();
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** The success-envelope shape every endpoint wraps its payload in. */
type Envelope<T> = ({ ok: true } & T) | { ok: false; error?: string; code?: string };

/**
 * Core request. Builds the action URL, attaches auth, parses the JSON
 * envelope, and throws `ApiError` on transport failure, non-2xx, or
 * `{ ok: false }`. Returns the parsed envelope (sans the `ok` flag) typed as T.
 */
async function request<T>(
  action: string,
  init?: {
    method?: 'GET' | 'POST' | 'DELETE';
    body?: BodyInit | null;
    headers?: Record<string, string>;
    query?: Record<string, string | number | undefined>;
    signal?: AbortSignal;
  },
): Promise<T> {
  const params = new URLSearchParams({ action });
  if (init?.query) {
    for (const [key, value] of Object.entries(init.query)) {
      if (value !== undefined) params.set(key, String(value));
    }
  }

  let response: Response;
  try {
    response = await fetch(`${BASE}?${params.toString()}`, {
      method: init?.method ?? 'GET',
      headers: authHeaders(init?.headers),
      body: init?.body ?? null,
      signal: init?.signal,
    });
  } catch (cause) {
    // Network / CORS / abort — surface as a 0-status ApiError.
    const message = cause instanceof Error ? cause.message : 'Network request failed';
    throw new ApiError(0, message);
  }

  let data: unknown = null;
  const raw = await response.text();
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const env = data as { error?: string; code?: string } | null;
    throw new ApiError(response.status, env?.error ?? raw ?? response.statusText, env?.code);
  }

  const env = (data ?? { ok: true }) as Envelope<T>;
  if (env && env.ok === false) {
    throw new ApiError(response.status, env.error ?? 'Request failed', env.code);
  }
  return env as unknown as T;
}

/** JSON-body POST/DELETE helper. */
function jsonRequest<T>(
  action: string,
  method: 'POST' | 'DELETE',
  body: unknown,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  return request<T>(action, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
    query,
  });
}

// ===========================================================================
// 1. Upload + parse + samples  (DESIGN_SPEC §3.1)
// ===========================================================================

/** Read a File as base64 (without the `data:…;base64,` prefix). Uses FileReader
 *  so large binaries don't blow the call stack. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * `POST ?action=upload` — sends each file as base64-encoded JSON
 * (`{ files: [{ name, mimeType, contentBase64 }], ontologyId? }`), matching the
 * handler's `UploadFile[]` contract. JSON (not multipart) so it works on Vercel
 * and the local dev shim without any multipart body parsing. Returns the parsed
 * source documents.
 */
export async function uploadDocs(
  files: File[],
  ontologyId?: string,
): Promise<{ sources: SourceDocument[]; parsedRefs: string[] }> {
  const encoded = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      mimeType: file.type || undefined,
      contentBase64: await fileToBase64(file),
    })),
  );
  const res = await jsonRequest<{ sources: SourceDocument[]; parsedRefs: string[] }>(
    'upload',
    'POST',
    { files: encoded, ontologyId },
  );
  return { sources: res.sources, parsedRefs: res.parsedRefs };
}

/** `POST ?action=parse` — idempotent (re)parse of already-uploaded sources. */
export async function parseDoc(sourceIds: string[]): Promise<ParsedSource[]> {
  const res = await jsonRequest<{ parsed: ParsedSource[] }>('parse', 'POST', { sourceIds });
  return res.parsed;
}

/** `GET ?action=samples` — bundled sample corpora for the Input screen. */
export async function listSamples(): Promise<SampleCorpus[]> {
  const res = await request<{ samples: SampleCorpus[] }>('samples');
  return res.samples;
}

// ===========================================================================
// 2. Orchestrated run — run.start / run.step / run.get  (DESIGN_SPEC §3.3)
// ===========================================================================

/** `POST ?action=run.start` — create a run + seed draft ontology. */
export function runStart(input: RunStartInput): Promise<{ ontology: Ontology; run: OntologyRun }> {
  return jsonRequest<{ ontology: Ontology; run: OntologyRun }>('run.start', 'POST', input);
}

/** `POST ?action=run.step` — advance exactly one stage; returns updated state. */
export function runStep(runId: string): Promise<{ ontology: Ontology; run: OntologyRun }> {
  return jsonRequest<{ ontology: Ontology; run: OntologyRun }>('run.step', 'POST', { runId });
}

/** `GET ?action=run.get` — resume a run after refresh. */
export function runGet(runId: string): Promise<{ ontology: Ontology; run: OntologyRun }> {
  return request<{ ontology: Ontology; run: OntologyRun }>('run.get', { query: { runId } });
}

// ===========================================================================
// 2b. Deep-swarm run — run.swarm.start / run.swarm.step (opt-in, multi-agent)
// ===========================================================================

/** One `run.swarm.step` result. Artifacts appear as their phase completes. */
export interface SwarmStepResult {
  ontology: Ontology;
  run: OntologyRun;
  phase: SwarmPhase;
  businessBrief?: BusinessBrief;
  coverageReport?: CoverageReport;
  followUpQuestions?: FollowUpQuestion[];
}

/** `POST ?action=run.swarm.start` — seed a run for the deep-swarm pipeline. */
export function runSwarmStart(input: RunStartInput): Promise<{ ontology: Ontology; run: OntologyRun }> {
  return jsonRequest<{ ontology: Ontology; run: OntologyRun }>('run.swarm.start', 'POST', input);
}

/** `POST ?action=run.swarm.step` — advance exactly one swarm sub-step. */
export function runSwarmStep(runId: string): Promise<SwarmStepResult> {
  return jsonRequest<SwarmStepResult>('run.swarm.step', 'POST', { runId });
}

// ===========================================================================
// 2c. Hyper-automation run — run.hyper.start / run.hyper.step / infer
//     (opt-in, full document-coverage multi-agent mode)
// ===========================================================================

/**
 * One `run.hyper.step` result — the swarm artifacts PLUS the hyper extras
 * (the phase machine is the wider {@link RunPhase} HYPER_PHASE_ORDER union).
 */
export interface HyperStepResult extends Omit<SwarmStepResult, 'phase'> {
  phase: RunPhase;
  terminology?: TerminologyExtraction;
  documentCoverage?: DocumentCoverageEval;
}

/** `POST ?action=run.hyper.start` — seed a run for the hyper-automation pipeline. */
export function startHyperRun(input: RunStartInput): Promise<{ ontology: Ontology; run: OntologyRun }> {
  return jsonRequest<{ ontology: Ontology; run: OntologyRun }>('run.hyper.start', 'POST', input);
}

/** `POST ?action=run.hyper.step` — advance exactly one hyper sub-step. */
export function stepHyperRun(runId: string): Promise<HyperStepResult> {
  return jsonRequest<HyperStepResult>('run.hyper.step', 'POST', { runId });
}

/**
 * `POST ?action=infer` — run a multi-hop inference question over a stored
 * ontology (`ontologyId`+`version`) or an inline `ontology` envelope.
 */
export function infer(input: {
  ontologyId?: string;
  version?: number;
  ontology?: Ontology;
  question: string;
  maxHops?: number;
  maxIterations?: number;
}): Promise<{ result: InferenceResult }> {
  return jsonRequest<{ result: InferenceResult }>('infer', 'POST', input);
}

// ===========================================================================
// 3. Single-stage re-run — stage.*  (DESIGN_SPEC §3.2)
// ===========================================================================

/**
 * `POST ?action=stage.<stage>` — re-run ONE extraction stage against the
 * current draft ontology. The caller merges `items` into its draft and `save`s.
 */
export function reRunStage(
  ontology: Ontology,
  stage: Stage,
  parsedRefs?: string[],
): Promise<StageRunResult> {
  return jsonRequest<StageRunResult>(`stage.${stage}`, 'POST', { ontology, parsedRefs });
}

// ===========================================================================
// 4. OntologyStore — list / get / save / publish / delete  (DESIGN_SPEC §3.4)
// ===========================================================================

/** `GET ?action=list` — ontology summaries, optionally filtered by domain. */
export async function listOntologies(domain?: DomainKey): Promise<OntologySummary[]> {
  const res = await request<{ ontologies: OntologySummary[] }>('list', { query: { domain } });
  return res.ontologies;
}

/** `GET ?action=get` — fetch one ontology JSON (latest, or a specific version). */
export async function getOntology(id: string, version?: number): Promise<Ontology> {
  const res = await request<{ ontology: Ontology }>('get', {
    query: { ontologyId: id, version },
  });
  return res.ontology;
}

/** `POST ?action=save` — append-only persist; returns the version-bumped ontology. */
export async function saveOntology(o: Ontology, changeSummary?: string): Promise<Ontology> {
  const res = await jsonRequest<{ ontology: Ontology }>('save', 'POST', {
    ontology: o,
    changeSummary,
  });
  return res.ontology;
}

/** `POST ?action=publish` — publish a version + best-effort Neo4j mirror. */
export function publishOntology(
  id: string,
  version?: number,
): Promise<{ ontology: Ontology; neo4j: Neo4jStatus }> {
  return jsonRequest<{ ontology: Ontology; neo4j: Neo4jStatus }>('publish', 'POST', {
    ontologyId: id,
    version,
  });
}

/** `DELETE ?action=delete` — soft-delete an ontology (versions retained). */
export async function deleteOntology(id: string): Promise<void> {
  await request<Record<string, never>>('delete', {
    method: 'DELETE',
    query: { ontologyId: id },
  });
}

// ===========================================================================
// 5. Validate + generate  (DESIGN_SPEC §3.6, §3.7)
// ===========================================================================

/** `POST ?action=validate` — run validateOntology server-side; returns issues. */
export async function validateOntology(o: Ontology): Promise<ValidationIssue[]> {
  const res = await jsonRequest<{ issues: ValidationIssue[] }>('validate', 'POST', { ontology: o });
  return res.issues;
}

/**
 * `POST ?action=generate` — run a generator. For a single `target` the backend
 * returns `{ bundle }`; for `'all'` it returns `{ bundles }`. We normalize to a
 * single bundle or an array.
 */
export async function generate(
  id: string,
  target: GeneratorTarget | 'all',
  version?: number,
): Promise<GeneratedBundle | GeneratedBundle[]> {
  const res = await jsonRequest<{ bundle?: GeneratedBundle; bundles?: GeneratedBundle[] }>(
    'generate',
    'POST',
    { ontologyId: id, target, version },
  );
  if (res.bundles) return res.bundles;
  if (res.bundle) return res.bundle;
  return [];
}

// ===========================================================================
// 6. Neo4j — import-graph / graph-status  (DESIGN_SPEC §3.5)
// ===========================================================================

/** `POST ?action=import-graph` — force a JSON→Neo4j re-sync of a stored version. */
export function importGraph(id: string, version?: number): Promise<Neo4jStatus> {
  return jsonRequest<{ neo4j: Neo4jStatus }>('import-graph', 'POST', {
    ontologyId: id,
    version,
    fullSync: true,
  }).then((res) => res.neo4j);
}

/** `GET ?action=graph-status` — report the Neo4j driver state. */
export async function graphStatus(): Promise<'connected' | 'unreachable' | 'disabled'> {
  const res = await request<{ neo4j: 'connected' | 'unreachable' | 'disabled' }>('graph-status');
  return res.neo4j;
}

// ===========================================================================
// 7. LLM routing — llm.agents / llm.settings (hyper-automation settings page)
// ===========================================================================

/** `GET ?action=llm.agents` — the agent registry, the resolved per-agent
 *  model assignments, and the persisted (possibly empty) LLM settings. */
export function getLlmAgents(): Promise<{
  agents: AgentDef[];
  assignments: AgentModelAssignment[];
  settings: LlmSettings;
}> {
  return request<{ agents: AgentDef[]; assignments: AgentModelAssignment[]; settings: LlmSettings }>(
    'llm.agents',
  );
}

/** `POST ?action=llm.settings` — persist LLM routing settings; returns the
 *  saved settings plus the recomputed per-agent assignments. */
export function saveLlmSettings(
  settings: LlmSettings,
): Promise<{ settings: LlmSettings; assignments: AgentModelAssignment[] }> {
  return jsonRequest<{ settings: LlmSettings; assignments: AgentModelAssignment[] }>(
    'llm.settings',
    'POST',
    settings,
  );
}
