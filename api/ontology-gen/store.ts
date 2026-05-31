// ============================================================================
// OntologyStore — JSON-source-of-truth persistence for the Ontology Generator.
//
// Two interchangeable implementations, auto-selected by environment:
//   - SupabaseOntologyStore  : durable; uses the jsonb `data` columns on the
//                              ontologies / ontology_runs / ontology_parsed
//                              tables (see supabase migration).
//   - InMemoryOntologyStore  : process-local Maps; the local "no-DB" path.
//
// HARD RULES (SCHEMA.md §6, DESIGN_SPEC §4):
//   * Append-only versioning. save()/publish() write a NEW row with version+1;
//     prior versions are immutable, deep-frozen snapshots.
//   * Missing Supabase env NEVER throws / 500s — getStore() silently falls back
//     to in-memory. Even a runtime Supabase failure degrades to a thrown store
//     error the handler can envelope, never an unhandled 500 on missing config.
// ============================================================================

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import type {
  Ontology,
  OntologyRun,
  ParsedSource,
  ObjectInstance,
  DomainKey,
  Confidence,
  UserRef,
} from '../_shared/ontology-schema.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Lightweight projection of an Ontology used by `list`. */
export interface OntologySummary {
  id: string;
  uuid: string;
  name: string;
  nameZh?: string;
  domain: DomainKey;
  version: number;
  status: 'draft' | 'published';
  confidence: Confidence;
  stats?: Record<string, number>;
  updatedAt: string;
  publishedAt?: string;
}

export interface OntologyStore {
  // CRUD + versioning ------------------------------------------------------
  list(filter?: { domain?: DomainKey }): Promise<OntologySummary[]>;
  get(id: string, version?: number): Promise<Ontology | null>;
  getVersion(id: string, version: number): Promise<Ontology | null>;
  /** Append-only: writes version = currentMax + 1; never mutates a prior row. */
  save(o: Ontology, changeSummary?: string, by?: UserRef): Promise<Ontology>;
  /** Append-only: writes a new version with status 'published'. */
  publish(id: string, version?: number, by?: UserRef): Promise<Ontology>;
  delete(id: string): Promise<void>;

  // Run state --------------------------------------------------------------
  saveRun(run: OntologyRun): Promise<void>;
  getRun(id: string): Promise<OntologyRun | null>;

  // Parsed-source companions (stored OUT of the envelope) ------------------
  saveParsed(p: ParsedSource): Promise<void>;
  /** Alias of {@link saveParsed} (DESIGN_SPEC §3.4 naming). */
  putParsed(p: ParsedSource): Promise<void>;
  getParsed(ref: string): Promise<ParsedSource | null>;

  // Runtime instances (Neo4j-primary; JSON seed convenience only) ----------
  getInstances(id: string): Promise<ObjectInstance[]>;
  putInstances(id: string, rows: ObjectInstance[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();

/** Deep-clone an ontology so persisted snapshots can't be mutated by callers. */
function snapshot<T>(value: T): T {
  // structuredClone is available on Node 18+ (Vercel runtime + local dev).
  const sc = (globalThis as { structuredClone?: <U>(v: U) => U }).structuredClone;
  if (typeof sc === 'function') return sc(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Recursively deep-freeze a value (for immutable in-memory version snapshots). */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Project an Ontology to its list summary. */
function toSummary(o: Ontology): OntologySummary {
  return {
    id: o.id,
    uuid: o.uuid,
    name: o.name,
    nameZh: o.nameZh,
    domain: o.domain,
    version: o.version,
    status: o.status,
    confidence: o.confidence,
    stats: o.metadata?.stats,
    updatedAt: o.metadata?.updatedAt ?? nowIso(),
    publishedAt: o.metadata?.publishedAt,
  };
}

/**
 * Build the next append-only version of an ontology from the incoming draft and
 * the previous persisted version. Recomputes metadata, prepends a history entry,
 * and stamps timestamps. Never mutates `incoming` or `prev`.
 */
function nextVersion(
  incoming: Ontology,
  prev: Ontology | null,
  opts: { publish: boolean; changeSummary?: string; by?: UserRef },
): Ontology {
  const next = snapshot(incoming);
  const prevVersion = prev?.version ?? 0;
  next.version = prevVersion + 1;

  const at = nowIso();
  const createdAt = prev?.metadata?.createdAt ?? next.metadata?.createdAt ?? at;
  next.metadata = {
    ...next.metadata,
    createdAt,
    updatedAt: at,
  };
  if (opts.publish) {
    next.status = 'published';
    next.metadata.publishedAt = at;
  }

  const history = Array.isArray(next.metadata.history) ? [...next.metadata.history] : [];
  history.unshift({
    version: next.version,
    at,
    by: opts.by,
    note: opts.changeSummary ?? (opts.publish ? 'published' : undefined),
    delta: computeDelta(prev, next),
  });
  next.metadata.history = history;

  return next;
}

/** Crude node-count delta between two ontology versions for the history entry. */
function computeDelta(
  prev: Ontology | null,
  next: Ontology,
): { added: number; changed: number; removed: number } {
  const count = (o: Ontology | null): number =>
    o
      ? o.objects.length +
        o.rules.length +
        o.actions.length +
        o.events.length +
        o.processes.length +
        o.relationships.length
      : 0;
  const prevCount = count(prev);
  const nextCount = count(next);
  const diff = nextCount - prevCount;
  return {
    added: diff > 0 ? diff : 0,
    changed: 0,
    removed: diff < 0 ? -diff : 0,
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation (the local "no-DB" path)
// ---------------------------------------------------------------------------

export class InMemoryOntologyStore implements OntologyStore {
  // ontologies keyed by `${id}@${version}`; immutable frozen snapshots.
  // `protected` (not private) so FileOntologyStore can rehydrate them from disk.
  protected readonly ontologies = new Map<string, Ontology>();
  protected readonly runs = new Map<string, OntologyRun>();
  protected readonly parsed = new Map<string, ParsedSource>();
  protected readonly instances = new Map<string, ObjectInstance[]>();
  protected readonly deleted = new Set<string>();

  protected key(id: string, version: number): string {
    return `${id}@${version}`;
  }

  private versionsOf(id: string): number[] {
    const versions: number[] = [];
    for (const k of this.ontologies.keys()) {
      const at = k.lastIndexOf('@');
      if (at > 0 && k.slice(0, at) === id) {
        versions.push(Number(k.slice(at + 1)));
      }
    }
    return versions.sort((a, b) => a - b);
  }

  private latest(id: string): Ontology | null {
    const versions = this.versionsOf(id);
    if (versions.length === 0) return null;
    return this.ontologies.get(this.key(id, versions[versions.length - 1])) ?? null;
  }

  async list(filter?: { domain?: DomainKey }): Promise<OntologySummary[]> {
    const seen = new Map<string, Ontology>();
    for (const id of new Set([...this.ontologies.keys()].map((k) => k.slice(0, k.lastIndexOf('@'))))) {
      if (this.deleted.has(id)) continue;
      const latest = this.latest(id);
      if (latest) seen.set(id, latest);
    }
    let rows = [...seen.values()];
    if (filter?.domain) rows = rows.filter((o) => o.domain === filter.domain);
    return rows
      .map(toSummary)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async get(id: string, version?: number): Promise<Ontology | null> {
    if (typeof version === 'number') return this.getVersion(id, version);
    const latest = this.latest(id);
    return latest ? snapshot(latest) : null;
  }

  async getVersion(id: string, version: number): Promise<Ontology | null> {
    const row = this.ontologies.get(this.key(id, version));
    return row ? snapshot(row) : null;
  }

  async save(o: Ontology, changeSummary?: string, by?: UserRef): Promise<Ontology> {
    const prev = this.latest(o.id);
    const next = nextVersion(o, prev, { publish: false, changeSummary, by });
    this.ontologies.set(this.key(next.id, next.version), deepFreeze(snapshot(next)));
    this.deleted.delete(next.id);
    return snapshot(next);
  }

  async publish(id: string, version?: number, by?: UserRef): Promise<Ontology> {
    const base =
      typeof version === 'number'
        ? this.ontologies.get(this.key(id, version)) ?? null
        : this.latest(id);
    if (!base) throw new Error(`ONTOLOGY_NOT_FOUND:${id}`);
    const prev = this.latest(id);
    const next = nextVersion(base, prev, { publish: true, by });
    this.ontologies.set(this.key(next.id, next.version), deepFreeze(snapshot(next)));
    return snapshot(next);
  }

  async delete(id: string): Promise<void> {
    // Soft delete: versions retained for audit; hidden from list().
    this.deleted.add(id);
  }

  async saveRun(run: OntologyRun): Promise<void> {
    this.runs.set(run.id, snapshot(run));
  }

  async getRun(id: string): Promise<OntologyRun | null> {
    const row = this.runs.get(id);
    return row ? snapshot(row) : null;
  }

  async saveParsed(p: ParsedSource): Promise<void> {
    this.parsed.set(p.ref, snapshot(p));
  }

  async putParsed(p: ParsedSource): Promise<void> {
    return this.saveParsed(p);
  }

  async getParsed(ref: string): Promise<ParsedSource | null> {
    const row = this.parsed.get(ref);
    return row ? snapshot(row) : null;
  }

  async getInstances(id: string): Promise<ObjectInstance[]> {
    return snapshot(this.instances.get(id) ?? []);
  }

  async putInstances(id: string, rows: ObjectInstance[]): Promise<void> {
    this.instances.set(id, snapshot(rows));
  }
}

// ---------------------------------------------------------------------------
// File-backed implementation (the local-dev "JSON on disk" path)
//
// Extends the in-memory store with write-through persistence to a data
// directory: every ontology version, run, parsed source, and instance set is
// mirrored to a `.json` file, and the maps are lazily rehydrated from disk on
// first access. This makes generated ontologies survive a dev-server restart
// and land as inspectable JSON files (requirement: "save generated ontology
// into local json files"). NEVER used on Vercel (read-only FS) — getStore()
// only selects it when Supabase is absent.
//
// Layout (under <dataDir>, default <cwd>/.data/ontology-gen):
//   ontologies/<safeId>@v<version>.json   one file per append-only version
//   runs/<safeRunId>.json                 in-progress run state
//   parsed/<safeRef>.json                 parsed sources + run-ontology stash
//   instances/<safeId>.json              { id, rows }
//   deleted.json                          string[] of soft-deleted ids
// ---------------------------------------------------------------------------

export class FileOntologyStore extends InMemoryOntologyStore {
  private readonly dir: string;
  private loadPromise: Promise<void> | null = null;

  constructor(dir: string) {
    super();
    this.dir = dir;
  }

  private dirFor(kind: 'ontologies' | 'runs' | 'parsed' | 'instances'): string {
    return path.join(this.dir, kind);
  }
  private get deletedFile(): string {
    return path.join(this.dir, 'deleted.json');
  }

  /** Filesystem-safe stem for an id/ref used as a file name. */
  private safe(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
  }

  private async writeJson(file: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  }

  private async readDirJson<T>(dir: string): Promise<T[]> {
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
    } catch {
      return []; // missing dir — nothing to load yet
    }
    const out: T[] = [];
    for (const n of names) {
      try {
        out.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')) as T);
      } catch {
        // skip unreadable / partially-written file
      }
    }
    return out;
  }

  /** Lazily hydrate the in-memory maps from disk exactly once per instance. */
  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.loadFromDisk();
    return this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    for (const o of await this.readDirJson<Ontology>(this.dirFor('ontologies'))) {
      if (o && typeof o.id === 'string' && typeof o.version === 'number') {
        this.ontologies.set(this.key(o.id, o.version), deepFreeze(snapshot(o)));
      }
    }
    for (const r of await this.readDirJson<OntologyRun>(this.dirFor('runs'))) {
      if (r && typeof r.id === 'string') this.runs.set(r.id, snapshot(r));
    }
    for (const p of await this.readDirJson<ParsedSource>(this.dirFor('parsed'))) {
      if (p && typeof p.ref === 'string') this.parsed.set(p.ref, snapshot(p));
    }
    for (const s of await this.readDirJson<{ id: string; rows: ObjectInstance[] }>(this.dirFor('instances'))) {
      if (s && typeof s.id === 'string' && Array.isArray(s.rows)) this.instances.set(s.id, snapshot(s.rows));
    }
    try {
      const ids = JSON.parse(await fs.readFile(this.deletedFile, 'utf8')) as string[];
      if (Array.isArray(ids)) for (const id of ids) this.deleted.add(id);
    } catch {
      // no deleted marker yet
    }
  }

  private async persistOntology(o: Ontology): Promise<void> {
    await this.writeJson(
      path.join(this.dirFor('ontologies'), `${this.safe(o.id)}@v${o.version}.json`),
      o,
    );
  }
  private async persistDeleted(): Promise<void> {
    await this.writeJson(this.deletedFile, [...this.deleted]);
  }

  // ---- reads: hydrate from disk first, then delegate to the in-memory logic --
  async list(filter?: { domain?: DomainKey }): Promise<OntologySummary[]> {
    await this.ensureLoaded();
    return super.list(filter);
  }
  async get(id: string, version?: number): Promise<Ontology | null> {
    await this.ensureLoaded();
    return super.get(id, version);
  }
  async getVersion(id: string, version: number): Promise<Ontology | null> {
    await this.ensureLoaded();
    return super.getVersion(id, version);
  }
  async getRun(id: string): Promise<OntologyRun | null> {
    await this.ensureLoaded();
    return super.getRun(id);
  }
  async getParsed(ref: string): Promise<ParsedSource | null> {
    await this.ensureLoaded();
    return super.getParsed(ref);
  }
  async getInstances(id: string): Promise<ObjectInstance[]> {
    await this.ensureLoaded();
    return super.getInstances(id);
  }

  // ---- writes: hydrate, delegate (versioning), then mirror to disk ----------
  async save(o: Ontology, changeSummary?: string, by?: UserRef): Promise<Ontology> {
    await this.ensureLoaded();
    const saved = await super.save(o, changeSummary, by);
    await this.persistOntology(saved);
    await this.persistDeleted(); // save() clears any soft-delete on this id
    return saved;
  }
  async publish(id: string, version?: number, by?: UserRef): Promise<Ontology> {
    await this.ensureLoaded();
    const published = await super.publish(id, version, by);
    await this.persistOntology(published);
    return published;
  }
  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    await super.delete(id);
    await this.persistDeleted();
  }
  async saveRun(run: OntologyRun): Promise<void> {
    await this.ensureLoaded();
    await super.saveRun(run);
    await this.writeJson(path.join(this.dirFor('runs'), `${this.safe(run.id)}.json`), run);
  }
  async saveParsed(p: ParsedSource): Promise<void> {
    await this.ensureLoaded();
    await super.saveParsed(p);
    await this.writeJson(path.join(this.dirFor('parsed'), `${this.safe(p.ref)}.json`), p);
  }
  // putParsed is inherited; it delegates to this.saveParsed (the override above).
  async putInstances(id: string, rows: ObjectInstance[]): Promise<void> {
    await this.ensureLoaded();
    await super.putInstances(id, rows);
    await this.writeJson(path.join(this.dirFor('instances'), `${this.safe(id)}.json`), { id, rows });
  }
}

// ---------------------------------------------------------------------------
// Supabase implementation
// ---------------------------------------------------------------------------

// Structural type for the Supabase client surface we touch — avoids importing
// @supabase/supabase-js types here (and keeps strict TS happy without `any`).
interface SupabaseLike {
  from(table: string): {
    select: (cols?: string) => QueryBuilder;
    insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => QueryBuilder;
    upsert: (
      rows: Record<string, unknown> | Record<string, unknown>[],
      opts?: { onConflict?: string },
    ) => QueryBuilder;
    update: (row: Record<string, unknown>) => QueryBuilder;
  };
}
interface QueryBuilder extends PromiseLike<{ data: unknown; error: { message: string } | null }> {
  eq: (col: string, val: unknown) => QueryBuilder;
  order: (col: string, opts?: { ascending?: boolean }) => QueryBuilder;
  limit: (n: number) => QueryBuilder;
  maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  select: (cols?: string) => QueryBuilder;
}

interface OntologyRow {
  id: string;
  uuid: string;
  name: string;
  domain: string;
  version: number;
  status: string;
  data: Ontology;
}

export class SupabaseOntologyStore implements OntologyStore {
  private readonly db: SupabaseLike;
  constructor(db: SupabaseLike) {
    this.db = db;
  }

  async list(filter?: { domain?: DomainKey }): Promise<OntologySummary[]> {
    let q = this.db.from('ontologies').select('id, version, data, updated_at');
    if (filter?.domain) q = q.eq('domain', filter.domain);
    const { data, error } = await q.order('version', { ascending: false });
    if (error) throw new Error(`STORE_LIST_FAILED:${error.message}`);
    const rows = (data as { id: string; version: number; data: Ontology }[]) ?? [];
    // Keep only the latest version per id; honor soft-delete (status flag).
    const latest = new Map<string, Ontology>();
    for (const r of rows) {
      const cur = latest.get(r.id);
      if (!cur || r.version > cur.version) latest.set(r.id, r.data);
    }
    return [...latest.values()]
      .filter((o) => o.status !== ('deleted' as Ontology['status']))
      .map(toSummary)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async get(id: string, version?: number): Promise<Ontology | null> {
    if (typeof version === 'number') return this.getVersion(id, version);
    const { data, error } = await this.db
      .from('ontologies')
      .select('data')
      .eq('id', id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`STORE_GET_FAILED:${error.message}`);
    return data ? (data as { data: Ontology }).data : null;
  }

  async getVersion(id: string, version: number): Promise<Ontology | null> {
    const { data, error } = await this.db
      .from('ontologies')
      .select('data')
      .eq('id', id)
      .eq('version', version)
      .maybeSingle();
    if (error) throw new Error(`STORE_GET_VERSION_FAILED:${error.message}`);
    return data ? (data as { data: Ontology }).data : null;
  }

  private async maxVersion(id: string): Promise<Ontology | null> {
    const { data, error } = await this.db
      .from('ontologies')
      .select('data')
      .eq('id', id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`STORE_MAXVER_FAILED:${error.message}`);
    return data ? (data as { data: Ontology }).data : null;
  }

  private async insert(o: Ontology): Promise<Ontology> {
    const row: OntologyRow = {
      id: o.id,
      uuid: o.uuid,
      name: o.name,
      domain: o.domain,
      version: o.version,
      status: o.status,
      data: o,
    };
    const { error } = await this.db.from('ontologies').insert(row as unknown as Record<string, unknown>);
    if (error) throw new Error(`STORE_SAVE_FAILED:${error.message}`);
    return o;
  }

  async save(o: Ontology, changeSummary?: string, by?: UserRef): Promise<Ontology> {
    const prev = await this.maxVersion(o.id);
    const next = nextVersion(o, prev, { publish: false, changeSummary, by });
    return this.insert(next);
  }

  async publish(id: string, version?: number, by?: UserRef): Promise<Ontology> {
    const base = typeof version === 'number' ? await this.getVersion(id, version) : await this.maxVersion(id);
    if (!base) throw new Error(`ONTOLOGY_NOT_FOUND:${id}`);
    const prev = await this.maxVersion(id);
    const next = nextVersion(base, prev, { publish: true, by });
    return this.insert(next);
  }

  async delete(id: string): Promise<void> {
    // Soft delete: stamp the latest version's status; rows retained for audit.
    const latest = await this.maxVersion(id);
    if (!latest) return;
    const { error } = await this.db
      .from('ontologies')
      .update({ status: 'deleted' })
      .eq('id', id)
      .eq('version', latest.version);
    if (error) throw new Error(`STORE_DELETE_FAILED:${error.message}`);
  }

  async saveRun(run: OntologyRun): Promise<void> {
    const row = {
      id: run.id,
      ontology_id: run.ontologyId,
      status: run.status,
      current_stage: run.currentStage,
      stages: run.stages,
      log: run.log,
      ontology: run,
      updated_at: nowIso(),
    };
    const { error } = await this.db.from('ontology_runs').upsert(row, { onConflict: 'id' });
    if (error) throw new Error(`STORE_SAVERUN_FAILED:${error.message}`);
  }

  async getRun(id: string): Promise<OntologyRun | null> {
    const { data, error } = await this.db
      .from('ontology_runs')
      .select('id, ontology_id, status, current_stage, stages, log')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`STORE_GETRUN_FAILED:${error.message}`);
    if (!data) return null;
    const r = data as {
      id: string;
      ontology_id: string;
      status: OntologyRun['status'];
      current_stage: OntologyRun['currentStage'];
      stages: OntologyRun['stages'];
      log: OntologyRun['log'];
    };
    return {
      id: r.id,
      ontologyId: r.ontology_id,
      status: r.status,
      currentStage: r.current_stage,
      stages: r.stages ?? [],
      log: r.log ?? [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  async saveParsed(p: ParsedSource): Promise<void> {
    const row = {
      ref: p.ref,
      document_id: p.documentId,
      text: p.text,
      page_map: p.pageMap ?? null,
    };
    const { error } = await this.db.from('ontology_parsed').upsert(row, { onConflict: 'ref' });
    if (error) throw new Error(`STORE_SAVEPARSED_FAILED:${error.message}`);
  }

  async putParsed(p: ParsedSource): Promise<void> {
    return this.saveParsed(p);
  }

  async getParsed(ref: string): Promise<ParsedSource | null> {
    const { data, error } = await this.db
      .from('ontology_parsed')
      .select('ref, document_id, text, page_map')
      .eq('ref', ref)
      .maybeSingle();
    if (error) throw new Error(`STORE_GETPARSED_FAILED:${error.message}`);
    if (!data) return null;
    const r = data as { ref: string; document_id: string; text: string; page_map: ParsedSource['pageMap'] | null };
    return {
      ref: r.ref,
      documentId: r.document_id,
      text: r.text,
      pageMap: r.page_map ?? undefined,
    };
  }

  // Instances live primarily in Neo4j; JSON store is a seed convenience only.
  // No durable Supabase column in v1 — degrade to empty.
  async getInstances(_id: string): Promise<ObjectInstance[]> {
    return [];
  }

  async putInstances(_id: string, _rows: ObjectInstance[]): Promise<void> {
    // No-op in v1 (Neo4j is the runtime instance store).
  }
}

// ---------------------------------------------------------------------------
// Selection — Supabase when env present, else in-memory. Never throws on
// missing env.
// ---------------------------------------------------------------------------

function supabaseConfigured(): boolean {
  const url = process.env.SUPABASE_URL || process.env.SUPASBASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPASBASE_SERVICE_KEY || '';
  return Boolean(url && key);
}

/** Directory the FileOntologyStore reads/writes JSON sessions under. */
function ontologyGenDataDir(): string {
  return process.env.ONTOLOGY_GEN_DATA_DIR || path.join(process.cwd(), '.data', 'ontology-gen');
}

let cached: OntologyStore | null = null;

/**
 * Return the active OntologyStore. Auto-selects SupabaseOntologyStore when both
 * SUPABASE_URL and SUPABASE_SERVICE_KEY are present; otherwise the in-memory
 * fallback. Missing env never throws — the product runs locally with no DB.
 */
export function getStore(): OntologyStore {
  if (cached) return cached;
  // Scoped overrides for ONLY the ontology-gen store (the rest of the app keeps
  // its Supabase config). These win over Supabase auto-selection:
  //   ONTOLOGY_GEN_STORE=memory  → pure in-memory (no disk; lost on restart)
  //   ONTOLOGY_GEN_STORE=file    → JSON files on disk, even if Supabase is set
  //                                (so "save to local json files" works locally)
  if (process.env.ONTOLOGY_GEN_STORE === 'memory') {
    cached = new InMemoryOntologyStore();
    return cached;
  }
  if (process.env.ONTOLOGY_GEN_STORE === 'file') {
    cached = new FileOntologyStore(ontologyGenDataDir());
    return cached;
  }
  if (supabaseConfigured()) {
    try {
      const url = process.env.SUPABASE_URL || process.env.SUPASBASE_URL || '';
      const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPASBASE_SERVICE_KEY || '';
      // The SDK client is structurally compatible with our SupabaseLike surface.
      cached = new SupabaseOntologyStore(createClient(url, key) as unknown as SupabaseLike);
      return cached;
    } catch {
      // Fall through to the file store on any client construction failure.
    }
  }
  // Local dev (no Supabase): persist generated ontologies as JSON files on disk
  // so sessions survive a restart and can be listed/loaded back. Set
  // ONTOLOGY_GEN_STORE=memory above to opt out (pure in-memory, no files).
  cached = new FileOntologyStore(ontologyGenDataDir());
  return cached;
}

/** Test/dev hook: drop the cached instance so env changes re-select a store. */
export function resetStore(): void {
  cached = null;
}

/** Mint a fresh uuid for new ontology/run/source records. */
export function newUuid(): string {
  return randomUUID();
}
