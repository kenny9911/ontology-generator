// ============================================================================
//  ONTOLOGY GENERATOR — API HANDLER (Vercel default export, ?action= router)
// ----------------------------------------------------------------------------
//  DESIGN_SPEC.md §1–§3 (conventions, endpoint catalog, detailed contracts);
//  TASK_PLAN T23–T28.
//
//  A single action-routed serverless handler under the /api/ontology-gen prefix.
//  Responsibilities:
//    - CORS (answer OPTIONS) + method routing (GET reads, POST/DELETE writes);
//    - JWT auth (Bearer) gated on the `ontology_studio` module — mirrors the COE
//      pattern (extractToken -> verifyToken). Module gating uses the Supabase
//      permissions table when configured; admins/COE/developer always pass;
//      when Supabase is ABSENT (no-DB local path) authenticated users pass so the
//      product runs locally with no DB;
//    - dispatch ?action= to: upload, parse, samples, run.start, run.step, run.get,
//      stage.<objects|rules|actions|events|processes>, list, get, save, publish,
//      delete, validate, generate, import-graph, graph-status;
//    - error envelope { ok:false, error } with a sane status — NEVER 500 on a
//      missing Supabase/Neo4j env (graceful degradation through getStore() and the
//      env-gated Neo4j driver).
//
//  HARD RULES (NodeNext / strict TS): relative project imports carry `.js`;
//  schema types/consts come from the generated backend mirror; all LLM work is
//  delegated to the pipeline stages (which call executeLLMWithTracking) — this
//  handler never calls the model directly except indirectly via runStage.
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';

import { STAGE_ORDER } from '../_shared/ontology-schema.js';
import type {
  ActionType,
  Bilingual,
  DatabaseProfile,
  DomainKey,
  EventType,
  ObjectType,
  Ontology,
  OntologyRun,
  ParsedSource,
  Process,
  Relationship,
  Rule,
  SourceDocument,
  Stage,
  StageProgress,
} from '../_shared/ontology-schema.js';

import { makeId } from '../_shared/ids.js';
import { validateOntology } from '../_shared/ontology-validate.js';
import type { ValidationIssue } from '../_shared/ontology-validate.js';
import type { LlmSettings } from '../_shared/ontology-schema.js';

import { getStore, newUuid } from './store.js';
import type { OntologyStore } from './store.js';
import { parseDocument } from './parse.js';
import { runStage, buildOntology } from './pipeline/orchestrator.js';
import type { StageContext } from './pipeline/context.js';
import { advanceSwarm, seedSwarmPhases } from './pipeline/swarm/orchestrator.js';
import { advanceHyper, seedHyperPhases } from './pipeline/hyper/orchestrator.js';
import { runInference } from './inference/engine.js';
import { renderWebAugment, runWebAugment } from './pipeline/web-augment.js';
import { tavilyAvailable } from './tavily.js';
import {
  resolveAgentLlm,
  listAssignments,
  loadLlmSettings,
  saveLlmSettings,
  makeAgentLlmResolver,
} from './llm-router.js';
import { AGENT_REGISTRY } from './agents.js';
import { executeLLMWithTracking } from './llm.js';
import type { ChatMessage, ExecuteLLMOptions } from './llm.js';
import { logEvent, logStep } from './logger.js';
import { extractJson } from './pipeline/swarm/llm-json.js';
import { generate } from './generators/index.js';
import type { GeneratorTarget } from './generators/index.js';
import { importOntology } from './neo4j/import.js';
import { neo4jEnabled, neo4jHealthy } from './neo4j/driver.js';
import { parseDdl } from './db/parse/ddl.js';
import { parseInfoSchemaJson } from './db/parse/info-schema-json.js';
import { textualizeSchema, SCHEMA_DOC_ID, SCHEMA_DOC_NAME } from './db/textualize.js';
import type { DbModel } from './db/types.js';
import { introspect } from './db/introspect/information-schema.js';
import type { DbConnection } from './db/introspect/information-schema.js';

// Sample corpora are read from disk (bundled fixtures). Node builtins only.
import { promises as fs } from 'fs';
import * as path from 'path';

// ===========================================================================
// Auth (mirrors the COE handler pattern).
// ===========================================================================

interface AuthUser {
  userId: string;
  email?: string;
  role?: string;
  name?: string;
  status?: string;
}

function getJwtSecret(): string {
  // No hardcoded fallback. When JWT_SECRET is unset, token verification fails
  // closed (verifyToken returns null), so requests run as anonymous guests —
  // unless ONTOLOGY_GEN_REQUIRE_AUTH=1, which then forces a 401.
  return process.env.JWT_SECRET || '';
}

function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.substring(7);
}

function verifyToken(token: string): AuthUser | null {
  try {
    return jwt.verify(token, getJwtSecret()) as AuthUser;
  } catch {
    return null;
  }
}

// ===========================================================================
// HTTP envelope helpers.
// ===========================================================================

function setCors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function ok(res: VercelResponse, payload: Record<string, unknown>): void {
  res.status(200).json({ ok: true, ...payload });
}

function fail(res: VercelResponse, status: number, error: string, code?: string): void {
  res.status(status).json(code ? { ok: false, error, code } : { ok: false, error });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A handler error that carries a desired HTTP status. */
class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ===========================================================================
// Request-body access (works on Vercel and through the local dev shim, which
// JSON.parses the body or leaves it as a raw string).
// ===========================================================================

function bodyObject(req: VercelRequest): Record<string, unknown> {
  const b = req.body;
  if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>;
  if (typeof b === 'string' && b.trim().length > 0) {
    try {
      const parsed = JSON.parse(b) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON — treat as empty
    }
  }
  return {};
}

function queryStr(req: VercelRequest, key: string): string | undefined {
  const v = req.query[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

function queryInt(req: VercelRequest, key: string): number | undefined {
  const s = queryStr(req, key);
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ===========================================================================
// LLM model / provider defaults.
// ===========================================================================

function defaultModel(): string {
  // ONTOLOGY_GEN_MODEL lets extraction use a FAST model (each stage is one
  // synchronous LLM call; slow reasoning models risk exceeding the per-request
  // limit) without changing the app-wide LLM_MODEL default.
  return process.env.ONTOLOGY_GEN_MODEL || process.env.LLM_MODEL || 'openrouter/google/gemini-2.5-pro';
}
function defaultProvider(): string {
  return process.env.LLM_PROVIDER || 'openrouter';
}

// ===========================================================================
// Sample corpora — the 10 DomainKeys (+ generic falls back to retail).
// ===========================================================================

interface SampleDef {
  id: DomainKey;
  dir: string;
  label: Bilingual;
  sublabel: Bilingual;
  docNames: string[];
}

const CORPUS_ROOT = path.join(process.cwd(), 'fixtures', 'ontology-corpus');

const SAMPLES: SampleDef[] = [
  {
    id: 'retail_o2c',
    dir: 'retail-order-to-cash',
    label: { en: 'Retail Order-to-Cash', zh: '零售订单到回款' },
    sublabel: { en: 'SOP · rules · systems', zh: '作业程序 · 规则 · 系统' },
    docNames: ['Order Fulfillment SOP.md', 'Business Rules Policy.md', 'Systems and Data.md'],
  },
  {
    id: 'commercial_lending',
    dir: 'commercial-lending',
    label: { en: 'Commercial Lending', zh: '商业贷款' },
    sublabel: { en: 'Origination to funding', zh: '受理到放款' },
    docNames: ['Lending SOP.md', 'Covenant Rules.md', 'Systems and Data.md'],
  },
  {
    id: 'healthcare_revcycle',
    dir: 'healthcare-care-pathway',
    label: { en: 'Healthcare Revenue Cycle', zh: '医疗收入周期' },
    sublabel: { en: 'Care pathway to billing', zh: '诊疗路径到计费' },
    docNames: ['Care Pathway SOP.md', 'Coding Rules.md', 'Systems and Data.md'],
  },
  {
    id: 'manufacturing_bom_quality',
    dir: 'manufacturing-bom-quality',
    label: { en: 'Manufacturing BOM & Quality', zh: '制造物料清单与质量' },
    sublabel: { en: 'ECO to inspection', zh: '工程变更到检验' },
    docNames: ['Manufacturing SOP.md', 'Quality Rules.md', 'Systems and Data.md'],
  },
  {
    id: 'logistics_fulfillment',
    dir: 'logistics-freight-fulfillment',
    label: { en: 'Logistics & Freight Fulfillment', zh: '物流与货运履约' },
    sublabel: { en: 'Order to delivery', zh: '订单到送达' },
    docNames: ['Warehouse SOP.md', 'Freight Rules.md', 'Systems and Data.md'],
  },
  {
    id: 'energy_grid_outage',
    dir: 'energy-grid-outage',
    label: { en: 'Energy Grid Outage', zh: '电网停电处置' },
    sublabel: { en: 'Detection to restoration', zh: '检测到恢复' },
    docNames: ['Outage SOP.md', 'Restoration Rules.md', 'Systems and Data.md'],
  },
  {
    id: 'hr_talent_acquisition',
    dir: 'hr-talent-acquisition',
    label: { en: 'HR Talent Acquisition', zh: '人力资源招聘' },
    sublabel: { en: 'Requisition to hire', zh: '需求到入职' },
    docNames: ['Talent Acquisition SOP.md', 'Hiring Rules.md', 'Systems and Data.md'],
  },
  {
    id: 'insurance_claims_underwriting',
    dir: 'insurance-claims-underwriting',
    label: { en: 'Insurance Claims & Underwriting', zh: '保险理赔与核保' },
    sublabel: { en: 'FNOL to settlement', zh: '报案到结案' },
    docNames: ['Claims SOP.md', 'Underwriting Rules.md', 'Systems and Data.md'],
  },
  {
    id: 'public_sector_permitting',
    dir: 'public-sector-permitting',
    label: { en: 'Public Sector Permitting', zh: '公共部门许可' },
    sublabel: { en: 'Intake to adjudication', zh: '受理到裁定' },
    docNames: ['Permitting SOP.md', 'Eligibility Rules.md', 'Systems and Data.md'],
  },
  {
    id: 'saas_subscription_entitlement',
    dir: 'saas-subscription-entitlement',
    label: { en: 'SaaS Subscription & Entitlement', zh: 'SaaS 订阅与权益' },
    sublabel: { en: 'Quote to provision', zh: '报价到开通' },
    docNames: ['Subscription SOP.md', 'Entitlement Rules.md', 'Systems and Data.md'],
  },
  {
    id: 'outsourced_recruitment',
    dir: 'recruitment-outsourcing-zh',
    label: { en: 'Outsourced Recruitment (RAAS)', zh: '外包招聘全流程' },
    sublabel: { en: 'Requisition to onboarding', zh: '需求分析到入职' },
    docNames: ['01-业务流程SOP.md', '02-业务规则与制度.md', '03-系统与数据实体.md', '04-事件与工作流编排.md'],
  },
  {
    id: 'expense_control',
    dir: 'expense-control-zh',
    label: { en: 'Enterprise Expense Control', zh: '企业费控与报销' },
    sublabel: { en: 'Budget to payment', zh: '预算到付款' },
    docNames: ['01-业务流程SOP.md', '02-业务规则与制度.md', '03-系统与数据实体.md', '04-事件与工作流编排.md'],
  },
  {
    id: 'contract_approval',
    dir: 'contract-approval-zh',
    label: { en: 'Contract Approval', zh: '合同审批全流程' },
    sublabel: { en: 'Draft to archive', zh: '起草到归档' },
    docNames: ['01-业务流程SOP.md', '02-业务规则与制度.md', '03-系统与数据实体.md', '04-事件与工作流编排.md'],
  },
  {
    id: 'inventory_erp',
    dir: 'inventory-erp-zh',
    label: { en: 'Inventory / Purchase-Sell-Stock', zh: '进销存（采购·库存·销售）' },
    sublabel: { en: 'Purchase to receivables', zh: '采购到应收应付' },
    docNames: ['01-业务流程SOP.md', '02-业务规则与制度.md', '03-系统与数据实体.md', '04-事件与工作流编排.md'],
  },
  {
    id: 'hr_management',
    dir: 'hr-management-zh',
    label: { en: 'HR Management', zh: '人事管理全流程' },
    sublabel: { en: 'Onboarding to offboarding', zh: '入职到离职' },
    docNames: ['01-业务流程SOP.md', '02-业务规则与制度.md', '03-系统与数据实体.md', '04-事件与工作流编排.md'],
  },
  {
    id: 'outsourced_recruitment_native',
    dir: 'recruitment-raas-native-zh',
    label: { en: 'Outsourced Recruitment · raw docs', zh: '外包招聘 · 原生详尽版' },
    sublabel: { en: 'Unannotated, employee-written (10+ pages each)', zh: '员工原生撰写 · 未标注 · 每篇10+页' },
    docNames: ['01-交付作业手册.md', '02-业务规则与管理制度.md', '03-系统操作与数据填写规范.md', '04-新人培训手册与实战话术.md', '05-客户交付与服务管理手册.md'],
  },
  {
    id: 'expense_control_native',
    dir: 'expense-control-native-zh',
    label: { en: 'Enterprise Expense Control · raw docs', zh: '企业费控报销 · 原生详尽版' },
    sublabel: { en: 'Unannotated, finance panel reviewed · 9 docs', zh: '财务团队评审增补 · 未标注 · 9 篇' },
    docNames: ['01-员工报销操作手册.md', '02-费控制度与报销规则.md', '03-报销科目与税务处理明细手册.md', '04-业务部门报销与审批操作指引.md', '05-费控系统操作与数据填写规范.md', '06-三类员工差异化与特殊场景报销手册.md', '07-多客户多项目成本归集、分摊与可报销范围规则手册.md', '08-内部控制、审计稽核与违规处理手册.md', '09-报销场景案例汇编（准予与驳回判例集）.md'],
  },
  {
    id: 'insurance_underwriting_native',
    dir: 'insurance-underwriting-native-zh',
    label: { en: 'Insurance Underwriting & Claims · raw docs', zh: '保险核保与理赔 · 原生详尽版' },
    sublabel: { en: 'Multi-line (life/health/auto/property/liability) · unannotated · 14 docs', zh: '多险种（寿险/健康/车险/财产/责任）· 未标注 · 14 篇' },
    docNames: ['01-投保与核保作业手册.md', '02-保单条款与保险责任手册.md', '03-核保规则与风险评估手册.md', '04-理赔作业手册与申请资料档案管理.md', '05-核保系统智核操作与数据填写规范.md', '06-理赔系统智赔操作与单证影像管理规范.md', '07-业务规则与管理制度.md', '08-审核审批稽核与内部审计手册.md', '09-核保理赔案例汇编（承保与理赔判例集）.md', '10-机动车辆保险核保查勘定损与理赔手册.md', '11-财产保险核保与理赔手册（家财企财工程）.md', '12-健康保险核保理赔深度手册.md', '13-多险种反欺诈识别调查与处置手册.md', '14-多险种核保理赔风险评估与评定策略手册.md'],
  },
  {
    id: 'generic',
    dir: 'retail-order-to-cash',
    label: { en: 'Generic (Retail demo)', zh: '通用（零售示例）' },
    sublabel: { en: 'Default sample corpus', zh: '默认示例语料' },
    docNames: ['Order Fulfillment SOP.md', 'Business Rules Policy.md', 'Systems and Data.md'],
  },
];

function findSample(id: string): SampleDef | undefined {
  return SAMPLES.find((s) => s.id === id);
}

/**
 * Read every markdown file in a sample corpus directory (filename-agnostic, so
 * English- or Chinese-named corpora with any number of docs all work). Sorted
 * by filename for stable ordering; returns [] when the fixtures dir is absent.
 */
async function readSampleDocs(def: SampleDef): Promise<{ name: string; text: string }[]> {
  const dir = path.join(CORPUS_ROOT, def.dir);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch {
    return [];
  }
  const out: { name: string; text: string }[] = [];
  for (const f of files) {
    try {
      out.push({ name: f, text: await fs.readFile(path.join(dir, f), 'utf8') });
    } catch {
      // Unreadable file — skip; a demo run still works with what's present.
    }
  }
  return out;
}

// ===========================================================================
// SourceDocument + ParsedSource construction from parsed text.
// ===========================================================================

/**
 * Parse one raw input (bytes or text) into a persisted ParsedSource + a
 * SourceDocument, minting deterministic ids against `taken`. The ParsedSource is
 * written to the store under a stable `parsedRef`.
 */
async function ingestOne(
  store: OntologyStore,
  taken: Set<string>,
  input: { name: string; mime?: string; bytes?: Buffer; text?: string },
): Promise<{ source: SourceDocument; parsed: ParsedSource }> {
  const pd = await parseDocument({ name: input.name, mime: input.mime, bytes: input.bytes, text: input.text });

  const docId = makeId('document', input.name, taken);
  // Re-key the parsed ref to the authoritative document id so a re-parse is stable.
  const parsedRef = pd.ref;

  const source: SourceDocument = {
    id: docId,
    uuid: newUuid(),
    name: input.name,
    kind: pd.kind,
    mimeType: input.mime,
    sizeBytes: input.bytes ? input.bytes.length : Buffer.byteLength(pd.text, 'utf8'),
    pageCount: pd.pageCount || undefined,
    parsedRef,
    contentHash: pd.contentHash,
  };

  const parsed: ParsedSource = {
    ref: parsedRef,
    documentId: docId,
    text: pd.text,
    pageMap: pd.pageMap,
  };

  await store.putParsed(parsed);
  return { source, parsed };
}

// ===========================================================================
// StageContext assembly from persisted run state.
// ===========================================================================

/**
 * Rebuild a StageContext from a persisted run's in-progress Ontology + its
 * sources' ParsedSource rows. Used by `run.step` (resume after refresh) and by
 * the single-stage `stage.*` re-run actions.
 */
async function contextFromOntology(
  store: OntologyStore,
  ontology: Ontology,
  parsedRefs: string[] | undefined,
  userInfo: unknown | null,
  log: (text: string) => void,
  overrides?: { model?: string; provider?: string },
): Promise<StageContext> {
  const sources = ontology.sourceDocuments ?? [];

  // Resolve the parsed text for the requested refs (or all attached sources).
  const wantRefs = parsedRefs && parsedRefs.length > 0
    ? parsedRefs
    : sources.map((s) => s.parsedRef).filter((r): r is string => typeof r === 'string');

  const parsed: ParsedSource[] = [];
  for (const ref of wantRefs) {
    const p = await store.getParsed(ref);
    if (p) parsed.push(p);
  }

  // Seed the `taken` id set with every id already present so re-mints don't collide.
  const taken = collectTakenIds(ontology, sources);

  // Per-agent LLM routing: load the global settings ONCE per request and attach
  // a resolver closure; call sites pick their model via ctxAgentLlm(ctx, ...).
  const settings = await loadLlmSettings(store);
  const model = overrides?.model || defaultModel();
  const provider = overrides?.provider || defaultProvider();

  const ctx: StageContext = {
    ontologyId: ontology.id,
    domain: ontology.domain,
    sources,
    parsed,
    taken,
    objects: ontology.objects ?? [],
    relationships: ontology.relationships ?? [],
    rules: ontology.rules ?? [],
    ruleGroups: ontology.ruleGroups ?? [],
    actions: ontology.actions ?? [],
    events: ontology.events ?? [],
    processes: ontology.processes ?? [],
    model,
    provider,
    userInfo,
    log,
    // Attach the cached web-search supplement (if any) so extraction stages see
    // it; ensureWebAugmentation computes+caches it on the first step.
    webAugment: renderWebAugment(ontology.metadata?.webAugmentation),
    agentLlm: makeAgentLlmResolver(settings, model, provider),
  };

  // Database input kind: attach the stashed DbModel so the objects/rules stages
  // take the deterministic seed path. Absent for document runs (ctx.dbModel stays
  // undefined), so the classic pipeline is byte-identical.
  const dbModel = await loadStashedDbModel(store, dbModelRef(ontology.id));
  if (dbModel) ctx.dbModel = dbModel;

  return ctx;
}

/**
 * Compute the live web-search supplement ONCE per run and cache it on
 * `ontology.metadata.webAugmentation`, then attach the rendered block to
 * `ctx.webAugment` for this step's extraction. No-op unless the run requested
 * web search and a Tavily key is configured; idempotent once computed. The
 * caller persists the mutated ontology — carryMetadata and the orchestrators'
 * buildAndCarry both carry `webAugmentation` forward across rebuilds.
 */
async function ensureWebAugmentation(
  store: OntologyStore,
  run: OntologyRun,
  ontology: Ontology,
  ctx: StageContext,
): Promise<void> {
  if (run.webSearch !== true) return;
  if (ontology.metadata.webAugmentation) {
    ctx.webAugment = renderWebAugment(ontology.metadata.webAugmentation);
    return;
  }
  const settings = await loadLlmSettings(store);
  if (!tavilyAvailable(settings)) {
    ctx.log('[web-search] enabled but no Tavily key configured (set TAVILY_API_KEY or save it in Settings) — skipping');
    return;
  }
  const aug = await runWebAugment(ctx, settings);
  ontology.metadata = { ...ontology.metadata, webAugmentation: aug };
  ctx.webAugment = renderWebAugment(aug);
}

function collectTakenIds(ontology: Ontology, sources: SourceDocument[]): Set<string> {
  const taken = new Set<string>();
  taken.add(ontology.id);
  for (const s of sources) taken.add(s.id);
  for (const o of ontology.objects ?? []) taken.add(o.id);
  for (const r of ontology.relationships ?? []) taken.add(r.id);
  for (const r of ontology.rules ?? []) taken.add(r.id);
  for (const g of ontology.ruleGroups ?? []) taken.add(g.id);
  for (const a of ontology.actions ?? []) taken.add(a.id);
  for (const e of ontology.events ?? []) taken.add(e.id);
  for (const p of ontology.processes ?? []) taken.add(p.id);
  return taken;
}

/** Carry the run's accumulated ontology back into the freshly-built one. */
function carryMetadata(next: Ontology, prev: Ontology | undefined): Ontology {
  if (!prev) return next;
  next.uuid = prev.uuid;
  next.name = prev.name || next.name;
  next.nameZh = prev.nameZh ?? next.nameZh;
  next.version = prev.version || next.version;
  next.status = prev.status;
  next.metadata = {
    ...next.metadata,
    createdAt: prev.metadata?.createdAt ?? next.metadata.createdAt,
    createdBy: prev.metadata?.createdBy ?? next.metadata.createdBy,
    history: prev.metadata?.history ?? next.metadata.history,
    webAugmentation: prev.metadata?.webAugmentation ?? next.metadata.webAugmentation,
  };
  return next;
}

// ===========================================================================
// Action: upload — multipart in spirit; JSON base64 in practice (codebase
// convention, see coe/kb.ts). Body: { files: [{ name, mimeType, contentBase64
// | text }], ontologyId? }.
// ===========================================================================

interface UploadFile {
  name: string;
  mimeType?: string;
  contentBase64?: string;
  text?: string;
}

async function actionUpload(req: VercelRequest, res: VercelResponse, userInfo: unknown | null): Promise<void> {
  void userInfo;
  const store = getStore();
  const body = bodyObject(req);
  const rawFiles = body.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new HttpError(400, 'upload requires a non-empty files[] array', 'NO_FILES');
  }

  const ontologyId = typeof body.ontologyId === 'string' ? body.ontologyId : undefined;

  // Seed taken with existing ids when attaching to a draft.
  const taken = new Set<string>();
  let existing: Ontology | null = null;
  if (ontologyId) {
    existing = await store.get(ontologyId);
    if (existing) for (const id of collectTakenIds(existing, existing.sourceDocuments ?? [])) taken.add(id);
  }

  const sources: SourceDocument[] = [];
  const parsedRefs: string[] = [];
  for (const f of rawFiles as UploadFile[]) {
    if (!f || typeof f.name !== 'string') continue;
    const bytes = typeof f.contentBase64 === 'string' ? Buffer.from(f.contentBase64, 'base64') : undefined;
    const { source } = await ingestOne(store, taken, {
      name: f.name,
      mime: f.mimeType,
      bytes,
      text: typeof f.text === 'string' ? f.text : undefined,
    });
    sources.push(source);
    if (source.parsedRef) parsedRefs.push(source.parsedRef);
  }

  if (sources.length === 0) {
    throw new HttpError(400, 'no parseable files in upload', 'NO_PARSEABLE_FILES');
  }

  ok(res, { sources, parsedRefs });
}

// ===========================================================================
// Action: parse — idempotent (re)parse of already-uploaded sources, returning
// their persisted ParsedSource payloads.
// ===========================================================================

async function actionParse(req: VercelRequest, res: VercelResponse): Promise<void> {
  const store = getStore();
  const body = bodyObject(req);
  const sourceIds = Array.isArray(body.sourceIds) ? (body.sourceIds as unknown[]).filter((s) => typeof s === 'string') as string[] : [];
  const refs = Array.isArray(body.parsedRefs) ? (body.parsedRefs as unknown[]).filter((s) => typeof s === 'string') as string[] : [];

  const parsed: ParsedSource[] = [];

  // Direct parsedRefs lookups.
  for (const ref of refs) {
    const p = await store.getParsed(ref);
    if (p) parsed.push(p);
  }

  // Resolve sourceIds via any attached ontology (best-effort) — sourceIds are
  // SourceDocument ids; we look up the parsedRef from the document. Without a
  // dedicated source table we accept the document id == parsed ref convention or
  // require the caller to pass the parsedRef. We also tolerate parsedRef-as-id.
  for (const sid of sourceIds) {
    const direct = await store.getParsed(sid);
    if (direct) {
      parsed.push(direct);
    }
  }

  ok(res, { parsed });
}

// ===========================================================================
// Action: db.upload / db.preview — ingest a database SCHEMA (M0) from an
// uploaded pg_dump/mysqldump DDL or an information_schema JSON export. Both
// build a dialect-neutral DbModel; db.upload persists the citable schema
// evidence + stashes the model for run.start, db.preview only renders it for
// audit. Live introspection (pg/mysql2) is a later milestone. No credentials
// are ever involved — these consume uploaded artifacts only.
// ===========================================================================

/** Parse a db.upload/db.preview body into a DbModel; throws HttpError on bad input. */
function parseDbUploadBody(body: Record<string, unknown>): { model: DbModel } {
  const dialect = body.dialect === 'mysql' ? 'mysql' : 'postgres';
  const format = body.format === 'information_schema_json' ? 'information_schema_json' : 'ddl';
  const defaultSchema = typeof body.defaultSchema === 'string' ? body.defaultSchema : undefined;

  const texts: string[] = [];
  const rawFiles = Array.isArray(body.files) ? (body.files as UploadFile[]) : [];
  for (const f of rawFiles) {
    if (!f) continue;
    const t =
      typeof f.text === 'string'
        ? f.text
        : typeof f.contentBase64 === 'string'
          ? Buffer.from(f.contentBase64, 'base64').toString('utf8')
          : '';
    if (t.trim()) texts.push(t);
  }
  if (texts.length === 0 && typeof body.content === 'string' && body.content.trim()) {
    texts.push(body.content);
  }
  if (texts.length === 0) throw new HttpError(400, 'db.upload requires files[] or content', 'NO_CONTENT');

  let model: DbModel;
  try {
    model =
      format === 'information_schema_json'
        ? parseInfoSchemaJson(JSON.parse(texts[0]!), { dialect, defaultSchema })
        : parseDdl(texts.join('\n\n'), { dialect, defaultSchema });
  } catch (err) {
    throw new HttpError(400, `failed to parse ${format}: ${errText(err)}`, 'DB_PARSE_FAILED');
  }
  if (model.tables.length === 0) throw new HttpError(400, 'no tables found in the uploaded schema', 'DB_EMPTY');
  return { model };
}

/** Audit-only summary of a DbModel (no credentials). Shapes a DatabaseProfile. */
function dbProfile(model: DbModel): DatabaseProfile {
  return {
    dialect: model.dialect,
    sourceKind: model.sourceKind,
    schemas: model.schemas,
    counts: {
      tables: model.tables.length,
      views: model.views.length,
      foreignKeys: model.tables.reduce((n, t) => n + t.foreignKeys.length, 0),
      constraints: model.tables.reduce((n, t) => n + t.checks.length + t.uniques.length, 0),
    },
    connectedAt: nowIso(),
  };
}

/** Merge several DbModels (multi-file upload) into one, de-duping tables by schema.name. */
function mergeDbModels(models: DbModel[]): DbModel {
  if (models.length === 1) return models[0]!;
  const byKey = new Map<string, DbModel['tables'][number]>();
  for (const m of models) for (const t of m.tables) byKey.set(`${t.schema}.${t.name}`, t);
  return {
    dialect: models[0]!.dialect,
    sourceKind: models[0]!.sourceKind,
    schemas: Array.from(new Set(models.flatMap((m) => m.schemas))),
    tables: Array.from(byKey.values()),
    views: models.flatMap((m) => m.views),
  };
}

/**
 * Persist a parsed DbModel as the citable schema evidence (a ParsedSource) +
 * stash the model keyed by the parsedRef, and respond with the run.start handle.
 * SHARED by db.upload (parsed from artifacts) and db.introspect (read live), so
 * both ingestion paths produce identical persisted state.
 */
async function persistDbModelAndRespond(res: VercelResponse, store: OntologyStore, model: DbModel): Promise<void> {
  const text = textualizeSchema(model);
  const ref = `parsed_db_${newUuid()}`;
  const source: SourceDocument = { id: SCHEMA_DOC_ID, uuid: newUuid(), name: SCHEMA_DOC_NAME, kind: 'db', parsedRef: ref };
  await store.putParsed({ ref, documentId: SCHEMA_DOC_ID, text });
  await store.putParsed({ ref: dbModelUploadRef(ref), documentId: SCHEMA_DOC_ID, text: JSON.stringify(model) });
  ok(res, { sources: [source], parsedRefs: [ref], preview: text, databaseProfile: dbProfile(model) });
}

async function actionDbUpload(req: VercelRequest, res: VercelResponse): Promise<void> {
  const store = getStore();
  const { model } = parseDbUploadBody(bodyObject(req));
  await persistDbModelAndRespond(res, store, model);
}

/** Parse a db.introspect body into a transient DbConnection; throws HttpError on bad input. */
function parseDbConnectionBody(body: Record<string, unknown>): DbConnection {
  const dialect = body.dialect === 'mysql' ? 'mysql' : 'postgres';
  const host = typeof body.host === 'string' ? body.host.trim() : '';
  const database = typeof body.database === 'string' ? body.database.trim() : '';
  const user = typeof body.user === 'string' ? body.user.trim() : '';
  if (!host) throw new HttpError(400, 'db.introspect requires host', 'NO_HOST');
  if (!database) throw new HttpError(400, 'db.introspect requires database', 'NO_DATABASE');
  if (!user) throw new HttpError(400, 'db.introspect requires user', 'NO_USER');
  const portRaw = body.port;
  const port =
    typeof portRaw === 'number' ? portRaw : typeof portRaw === 'string' && portRaw.trim() ? Number(portRaw) : undefined;
  const schemas = Array.isArray(body.schemas)
    ? (body.schemas as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : typeof body.schema === 'string' && body.schema.trim()
      ? [body.schema.trim()]
      : undefined;
  return {
    dialect,
    host,
    port: Number.isFinite(port as number) ? (port as number) : undefined,
    database,
    user,
    password: typeof body.password === 'string' ? body.password : undefined,
    ssl: body.ssl === true || body.ssl === 'true',
    schemas,
  };
}

/** Sanitize a driver error so a connection-failure message never leaks credentials. */
function sanitizeDbError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/(postgres(?:ql)?|mysql):\/\/[^\s]*/gi, '$1://[redacted]')
    .replace(/password=[^\s&;]*/gi, 'password=[redacted]')
    .slice(0, 200);
}

async function actionDbIntrospect(req: VercelRequest, res: VercelResponse): Promise<void> {
  const store = getStore();
  const conn = parseDbConnectionBody(bodyObject(req));
  let model: DbModel;
  try {
    // The connection (with its password) is used for THIS call only and then
    // discarded — never persisted, never logged, never sent to an LLM.
    model = await introspect(conn);
  } catch (err) {
    throw new HttpError(400, `database introspection failed: ${sanitizeDbError(err)}`, 'DB_CONNECT_FAILED');
  }
  if (model.tables.length === 0) {
    throw new HttpError(400, 'no tables found in the selected schema(s)', 'DB_EMPTY');
  }
  await persistDbModelAndRespond(res, store, model);
}

async function actionDbPreview(req: VercelRequest, res: VercelResponse): Promise<void> {
  const { model } = parseDbUploadBody(bodyObject(req));
  ok(res, { preview: textualizeSchema(model), databaseProfile: dbProfile(model), tableCount: model.tables.length });
}

// ===========================================================================
// Action: samples — list the bundled sample corpora (10 DomainKeys + generic).
// ===========================================================================

async function actionSamples(_req: VercelRequest, res: VercelResponse): Promise<void> {
  const samples = [];
  for (const def of SAMPLES) {
    const docs = await readSampleDocs(def);
    samples.push({
      id: def.id,
      domain: def.id,
      label: def.label,
      sublabel: def.sublabel,
      docNames: docs.length > 0 ? docs.map((d) => d.name) : def.docNames,
    });
  }
  ok(res, { samples });
}

// ===========================================================================
// Run lifecycle helpers.
// ===========================================================================

function freshRun(runId: string, ontologyId: string): OntologyRun {
  const at = nowIso();
  return {
    id: runId,
    ontologyId,
    status: 'pending',
    currentStage: null,
    stages: STAGE_ORDER.map((stage) => ({ stage, status: 'pending', count: 0 } as StageProgress)),
    log: [],
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Persist the run together with its in-progress Ontology. The store's run row
 * carries the run; we also persist the partial ontology snapshot via saveRun by
 * piggy-backing it on the run object so run.get can rebuild context. To keep the
 * OntologyRun type clean we stash the partial under a side-table: we serialize it
 * into the run's persistence by storing the ontology in the parsed store under a
 * run-scoped ref. This keeps types intact and works on both stores.
 */
const runOntologyRef = (runId: string): string => `run_ontology:${runId}`;

async function persistRunState(store: OntologyStore, run: OntologyRun, ontology: Ontology): Promise<void> {
  run.updatedAt = nowIso();
  await store.saveRun(run);
  // Stash the partial ontology as a ParsedSource-shaped row (text = JSON) so we
  // can resume without a dedicated column. Graceful + works in-memory & Supabase.
  await store.putParsed({
    ref: runOntologyRef(run.id),
    documentId: run.id,
    text: JSON.stringify(ontology),
  });
}

async function loadRunState(
  store: OntologyStore,
  runId: string,
): Promise<{ run: OntologyRun; ontology: Ontology } | null> {
  const run = await store.getRun(runId);
  if (!run) return null;
  const stash = await store.getParsed(runOntologyRef(runId));
  if (!stash) return null;
  let ontology: Ontology;
  try {
    ontology = JSON.parse(stash.text) as Ontology;
  } catch {
    return null;
  }
  return { run, ontology };
}

// ---------------------------------------------------------------------------
// Deep-swarm working state — the sub-step cursor, stashed like the partial
// ontology (a ParsedSource-shaped row) so it persists across `run.swarm.step`
// calls on every store. Brief/coverage/questions ride on ontology.metadata.
// ---------------------------------------------------------------------------

const swarmStateRef = (runId: string): string => `swarm_state:${runId}`;

async function persistSwarmState(store: OntologyStore, runId: string, cursor: number): Promise<void> {
  await store.putParsed({ ref: swarmStateRef(runId), documentId: runId, text: JSON.stringify({ cursor }) });
}

async function loadSwarmState(store: OntologyStore, runId: string): Promise<{ cursor: number } | null> {
  const stash = await store.getParsed(swarmStateRef(runId));
  if (!stash) return null;
  try {
    const o = JSON.parse(stash.text) as { cursor?: unknown };
    return { cursor: Number(o.cursor) || 0 };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Database-ingestion working state — the parsed DbModel is stashed like the
// partial ontology / swarm cursor (a ParsedSource-shaped row, text = JSON) so it
// persists across requests on every store backend. Two keys: one scoped to the
// upload's parsedRef (handed to run.start), one scoped to the ontology id
// (loaded into ctx.dbModel by every later stage context).
// ---------------------------------------------------------------------------

const dbModelUploadRef = (parsedRef: string): string => `db_model_upload:${parsedRef}`;
const dbModelRef = (ontologyId: string): string => `db_model:${ontologyId}`;

async function loadStashedDbModel(store: OntologyStore, ref: string): Promise<DbModel | null> {
  const stash = await store.getParsed(ref);
  if (!stash) return null;
  try {
    return JSON.parse(stash.text) as DbModel;
  } catch {
    return null;
  }
}

// ===========================================================================
// Action: run.start — seed an OntologyRun + a draft Ontology from sources or a
// sample corpus.
// ===========================================================================

async function buildSeededRun(
  req: VercelRequest,
  userInfo: unknown | null,
): Promise<{ store: OntologyStore; run: OntologyRun; ontology: Ontology }> {
  const store = getStore();
  const body = bodyObject(req);

  const nameInput = body.name;
  const name: Bilingual =
    nameInput && typeof nameInput === 'object'
      ? {
          en: String((nameInput as Bilingual).en ?? 'Untitled Ontology'),
          zh: String((nameInput as Bilingual).zh ?? '未命名本体'),
        }
      : { en: 'Untitled Ontology', zh: '未命名本体' };

  const domain: DomainKey = isDomainKey(body.domain) ? body.domain : 'generic';
  const taken = new Set<string>();

  // Resolve sources: either a bundled sampleId, or already-uploaded sourceIds.
  const sources: SourceDocument[] = [];
  // Database run (inputKind='database'): the sources are db.upload evidence docs,
  // and we collect their stashed DbModel(s) to re-stash under the new ontology id.
  const wantDb = body.inputKind === 'database';
  const dbModels: DbModel[] = [];

  const sampleId = typeof body.sampleId === 'string' ? body.sampleId : undefined;
  if (sampleId) {
    const def = findSample(sampleId);
    if (!def) throw new HttpError(400, `unknown sampleId: ${sampleId}`, 'UNKNOWN_SAMPLE');
    const docs = await readSampleDocs(def);
    if (docs.length === 0) throw new HttpError(400, `sample corpus not available: ${sampleId}`, 'SAMPLE_EMPTY');
    for (const d of docs) {
      const { source } = await ingestOne(store, taken, { name: d.name, mime: 'text/markdown', text: d.text });
      sources.push(source);
    }
    if (name.en === 'Untitled Ontology') {
      name.en = def.label.en;
      name.zh = def.label.zh;
    }
  } else {
    const sourceIds = Array.isArray(body.sourceIds)
      ? (body.sourceIds as unknown[]).filter((s) => typeof s === 'string') as string[]
      : [];
    if (sourceIds.length === 0) throw new HttpError(400, 'run.start requires sourceIds or sampleId', 'NO_SOURCES');
    // sourceIds reference uploaded SourceDocuments. We resolve their parsed text
    // (uploaded via `upload`) and reconstruct minimal SourceDocuments. The upload
    // action keyed parsed rows by parsedRef; the client passes parsedRefs as
    // sourceIds in the no-source-table design, so we accept either.
    for (const sid of sourceIds) {
      const p = await store.getParsed(sid);
      if (!p) continue;
      if (wantDb) {
        // Database input: one schema-evidence source (kind 'db'); collect the
        // stashed DbModel so it can be re-stashed under the new ontology id below.
        const docId = taken.has(SCHEMA_DOC_ID) ? makeId('document', SCHEMA_DOC_ID, taken) : (taken.add(SCHEMA_DOC_ID), SCHEMA_DOC_ID);
        sources.push({ id: docId, uuid: newUuid(), name: SCHEMA_DOC_NAME, kind: 'db', parsedRef: p.ref });
        const m = await loadStashedDbModel(store, dbModelUploadRef(p.ref));
        if (m) dbModels.push(m);
        continue;
      }
      const docId = taken.has(p.documentId) ? makeId('document', p.documentId, taken) : (taken.add(p.documentId), p.documentId);
      sources.push({
        id: docId,
        uuid: newUuid(),
        name: p.documentId.replace(/^doc:/, ''),
        kind: 'doc',
        parsedRef: p.ref,
      });
    }
    if (sources.length === 0) throw new HttpError(400, 'no parsed sources found for the given sourceIds', 'SOURCES_NOT_FOUND');
  }

  const ontologyId = makeId('ontology', name.en, taken);

  // Build a seed (empty-layer) ontology via the orchestrator's assembler.
  // The seed context makes no LLM calls, but carries the per-agent resolver for
  // consistency with every other StageContext built in this handler.
  const settings = await loadLlmSettings(store);
  const seedCtx: StageContext = {
    ontologyId,
    domain,
    sources,
    parsed: [],
    taken,
    objects: [],
    relationships: [],
    rules: [],
    ruleGroups: [],
    actions: [],
    events: [],
    processes: [],
    model: defaultModel(),
    provider: defaultProvider(),
    userInfo,
    log: () => {},
    agentLlm: makeAgentLlmResolver(settings, defaultModel(), defaultProvider()),
  };
  const ontology = buildOntology(seedCtx);
  ontology.name = name.en;
  ontology.nameZh = name.zh;

  // Database input: stash the (merged) DbModel under the new ontology id so every
  // later stage context attaches it, and record the audit-only DatabaseProfile.
  if (wantDb && dbModels.length > 0) {
    const model = mergeDbModels(dbModels);
    await store.putParsed({ ref: dbModelRef(ontology.id), documentId: ontology.id, text: JSON.stringify(model) });
    ontology.metadata = { ...ontology.metadata, databaseProfile: dbProfile(model) };
    if (name.en === 'Untitled Ontology') {
      ontology.name = `Database: ${model.schemas.join(', ') || model.dialect}`;
      ontology.nameZh = `数据库本体（${model.schemas.join('、') || model.dialect}）`;
    }
  }

  const runId = `run_${newUuid()}`;
  const run = freshRun(runId, ontologyId);
  // Uploaded corpora seed a filename-derived name; flag the run so completion
  // upgrades it to a content-descriptive title. Sample corpora keep their label.
  if (body.autoName === true) run.autoName = true;
  if (body.webSearch === true) run.webSearch = true;
  // A database run takes the deterministic seed path; flag autoName so its title
  // is upgraded from the placeholder once objects are discovered.
  if (wantDb) {
    run.inputKind = 'database';
    run.autoName = true;
  }

  return { store, run, ontology };
}

// Thin wrappers over the shared seeding helper.
async function actionRunStart(req: VercelRequest, res: VercelResponse, userInfo: unknown | null): Promise<void> {
  const { store, run, ontology } = await buildSeededRun(req, userInfo);
  await persistRunState(store, run, ontology);
  ok(res, { run, ontology });
}

// run.swarm.start — seed a run flagged for the opt-in deep-swarm pipeline.
async function actionSwarmStart(req: VercelRequest, res: VercelResponse, userInfo: unknown | null): Promise<void> {
  const { store, run, ontology } = await buildSeededRun(req, userInfo);
  run.mode = 'swarm';
  run.phases = seedSwarmPhases();
  run.currentPhase = null;
  await persistRunState(store, run, ontology);
  await persistSwarmState(store, run.id, 0);
  ok(res, { run, ontology });
}

// run.hyper.start — seed a run flagged for the opt-in hyper-automation pipeline.
// Identical body contract + source/sample seeding to run.swarm.start; only the
// mode flag and the (10-phase) phase machine differ.
async function actionHyperStart(req: VercelRequest, res: VercelResponse, userInfo: unknown | null): Promise<void> {
  const { store, run, ontology } = await buildSeededRun(req, userInfo);
  run.mode = 'hyper';
  run.phases = seedHyperPhases();
  run.currentPhase = null;
  await persistRunState(store, run, ontology);
  await persistSwarmState(store, run.id, 0);
  ok(res, { run, ontology });
}

// ===========================================================================
// Auto-naming — upgrade a filename-derived ontology name to a content-descriptive
// bilingual title once extraction has discovered objects/processes/actions.
// ===========================================================================

/**
 * Ask the LLM for a concise bilingual title naming the business domain/process
 * the discovered ontology describes. Returns null on any failure (no key, parse
 * error, empty layers) so callers degrade silently to the filename-derived name.
 */
async function suggestOntologyName(
  ontology: Ontology,
  userInfo: unknown | null,
): Promise<Bilingual | null> {
  const objects = ontology.objects.slice(0, 12).map((o) => o.name).filter(Boolean);
  const processes = ontology.processes
    .slice(0, 6)
    .map((p) => p.name?.en || p.name?.zh || '')
    .filter(Boolean);
  const actions = ontology.actions.slice(0, 8).map((a) => a.name).filter(Boolean);
  // Nothing was discovered — a name from this would be guesswork.
  if (objects.length === 0 && processes.length === 0 && actions.length === 0) return null;

  const system =
    'You name enterprise ontologies. Given the key entities discovered from a ' +
    'business corpus, return a concise, specific title that names the business ' +
    'domain or end-to-end process — never a generic label like "Uploaded corpus". ' +
    'Respond with STRICT JSON only: {"en": "...", "zh": "..."}. ' +
    '"en": 2-6 words in Title Case, no quotes, no trailing punctuation. ' +
    '"zh": 简体中文 4-12 字。Do not add the word "Ontology"/"本体" unless it reads naturally.';
  const user = [
    `Domain: ${ontology.domain}`,
    objects.length ? `Objects: ${objects.join(', ')}` : '',
    processes.length ? `Processes: ${processes.join(', ')}` : '',
    actions.length ? `Actions: ${actions.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let raw: string;
  try {
    // Route the (one-shot, per-request) title call through the agent router.
    const settings = await loadLlmSettings(getStore());
    const llm = resolveAgentLlm('title_generator', {
      settings,
      baseModel: defaultModel(),
      baseProvider: defaultProvider(),
    });
    raw = await executeLLMWithTracking({
      provider: llm.provider as ExecuteLLMOptions['provider'],
      model: llm.model,
      messages,
      temperature: 0.2,
      maxTokens: 200,
      module: 'ontology_generator',
      actionName: 'name.suggest',
      userInfo: userInfo as ExecuteLLMOptions['userInfo'],
    });
  } catch {
    return null;
  }

  const parsed = extractJson(raw) as { en?: unknown; zh?: unknown } | null;
  if (!parsed) return null;
  const en = typeof parsed.en === 'string' ? parsed.en.trim() : '';
  const zh = typeof parsed.zh === 'string' ? parsed.zh.trim() : '';
  if (!en && !zh) return null;
  return { en: en || zh, zh: zh || en };
}

/**
 * One-shot: when a run is flagged `autoName`, replace the filename-derived name
 * with an LLM-suggested title (mutates `ontology`), then clear the flag whether
 * or not the suggestion succeeded so it never re-fires. Never throws.
 */
async function maybeUpgradeAutoName(
  run: OntologyRun,
  ontology: Ontology,
  userInfo: unknown | null,
): Promise<void> {
  if (!run.autoName) return;
  run.autoName = false;
  try {
    const suggested = await suggestOntologyName(ontology, userInfo);
    if (suggested) {
      ontology.name = suggested.en;
      ontology.nameZh = suggested.zh;
    }
  } catch {
    // degrade silently — the filename-derived name stands.
  }
}

// ===========================================================================
// Action: run.step — advance exactly ONE stage (next pending stage in
// STAGE_ORDER), persist the partial Ontology + updated OntologyRun.
// ===========================================================================

async function actionRunStep(req: VercelRequest, res: VercelResponse, userInfo: unknown | null): Promise<void> {
  const store = getStore();
  const body = bodyObject(req);
  const runId = typeof body.runId === 'string' ? body.runId : queryStr(req, 'runId');
  if (!runId) throw new HttpError(400, 'run.step requires runId', 'NO_RUN_ID');

  const state = await loadRunState(store, runId);
  if (!state) throw new HttpError(404, `run not found: ${runId}`, 'RUN_NOT_FOUND');

  const { run } = state;
  let { ontology } = state;

  // Phase-machine runs advance through their own cursor-driven step actions;
  // letting run.step drive them would corrupt the cursor/phase bookkeeping.
  if (run.mode === 'swarm' || run.mode === 'hyper') {
    throw new HttpError(
      400,
      `run ${runId} is a ${run.mode} run — use run.${run.mode}.step`,
      'WRONG_RUN_MODE',
    );
  }

  if (run.status === 'complete') {
    ok(res, { run, ontology });
    return;
  }

  // Pick the next stage to run: first non-complete stage in STAGE_ORDER.
  const nextIdx = run.stages.findIndex((s) => s.status !== 'complete');
  if (nextIdx < 0) {
    run.status = 'complete';
    run.currentStage = null;
    await persistRunState(store, run, ontology);
    ok(res, { run, ontology });
    return;
  }

  const stage: Stage = run.stages[nextIdx]!.stage;
  run.status = 'running';
  run.currentStage = stage;
  appendLog(run, `[${stage}] starting`);

  // Rebuild the stage context from the accumulated ontology + parsed text.
  const log = (text: string) => appendLog(run, text);
  const ctx = await contextFromOntology(store, ontology, undefined, userInfo, log);
  await ensureWebAugmentation(store, run, ontology, ctx);

  const result = await runStage(stage, ctx);

  // Merge stage progress into the run.
  run.stages[nextIdx] = result.progress;
  if (result.critique) {
    appendLog(run, `[${stage}] critique: ${result.critique}`);
  }

  // Reassemble the partial ontology from the (mutated) context, carrying forward
  // version/uuid/name/history from the run's prior snapshot.
  const rebuilt = carryMetadata(buildOntology(ctx), ontology);
  rebuilt.metadata.danglingRefs = collectDangling(result.issues);
  if (result.critique) {
    rebuilt.metadata.stageCritiques = { ...rebuilt.metadata.stageCritiques, [stage]: result.critique };
  }
  ontology = rebuilt;

  if (result.progress.status === 'error') {
    run.status = 'error';
    appendLog(run, `[${stage}] error: ${result.progress.error ?? 'unknown'}`);
  } else {
    appendLog(run, `[${stage}] complete (${result.progress.count})`);
    const remaining = run.stages.some((s) => s.status !== 'complete');
    if (!remaining) {
      run.status = 'complete';
      run.currentStage = null;
      // Run finished — upgrade a filename-derived name to a content title.
      await maybeUpgradeAutoName(run, ontology, userInfo);
    } else {
      run.status = 'running';
    }
  }

  await persistRunState(store, run, ontology);
  ok(res, { run, ontology });
}

// ===========================================================================
// Action: run.get — resume; read run + current ontology.
// ===========================================================================

async function actionRunGet(req: VercelRequest, res: VercelResponse): Promise<void> {
  const store = getStore();
  const runId = queryStr(req, 'runId') || (typeof bodyObject(req).runId === 'string' ? String(bodyObject(req).runId) : undefined);
  if (!runId) throw new HttpError(400, 'run.get requires runId', 'NO_RUN_ID');
  const state = await loadRunState(store, runId);
  if (!state) throw new HttpError(404, `run not found: ${runId}`, 'RUN_NOT_FOUND');
  ok(res, { run: state.run, ontology: state.ontology });
}

// ===========================================================================
// Action: run.swarm.step / run.hyper.step — advance ONE sub-step of a
// client-paced multi-phase run (see pipeline/swarm and pipeline/hyper).
//
// MODE GUARD: both step actions share this driver and dispatch on the
// PERSISTED `run.mode` — never on the endpoint name — so a client hitting the
// wrong endpoint cannot corrupt a run: a swarm run always advances via
// `advanceSwarm` and a hyper run via `advanceHyper`. The cursor stash
// (`swarm_state:<runId>`) is mode-agnostic and reused unchanged for hyper.
// Hyper responses additionally carry `terminology` + `documentCoverage`.
// ===========================================================================

async function actionModeStep(
  req: VercelRequest,
  res: VercelResponse,
  userInfo: unknown | null,
  actionName: 'run.swarm.step' | 'run.hyper.step',
): Promise<void> {
  const store = getStore();
  const body = bodyObject(req);
  const runId = typeof body.runId === 'string' ? body.runId : queryStr(req, 'runId');
  if (!runId) throw new HttpError(400, `${actionName} requires runId`, 'NO_RUN_ID');

  const state = await loadRunState(store, runId);
  if (!state) throw new HttpError(404, `run not found: ${runId}`, 'RUN_NOT_FOUND');

  const { run } = state;
  let { ontology } = state;

  // Only phase-machine runs may be stepped here; a fast run has no cursor and
  // must advance through run.step.
  if (run.mode !== 'swarm' && run.mode !== 'hyper') {
    throw new HttpError(400, `run ${runId} is a fast run — use run.step`, 'WRONG_RUN_MODE');
  }
  const isHyper = run.mode === 'hyper';

  // Idempotent terminal: a completed run echoes its artifacts.
  if (run.status === 'complete') {
    const payload: Record<string, unknown> = {
      run,
      ontology,
      phase: run.currentPhase ?? 'follow_up',
      businessBrief: ontology.metadata?.businessBrief,
      coverageReport: ontology.metadata?.coverageReport,
      followUpQuestions: ontology.metadata?.followUpQuestions,
    };
    if (isHyper) {
      payload.terminology = ontology.metadata?.terminology;
      payload.documentCoverage = ontology.metadata?.documentCoverage;
    }
    ok(res, payload);
    return;
  }

  const cursor = (await loadSwarmState(store, runId))?.cursor ?? 0;
  const log = (text: string) => appendLog(run, text);
  const ctx = await contextFromOntology(store, ontology, undefined, userInfo, log);
  await ensureWebAugmentation(store, run, ontology, ctx);

  const result = isHyper
    ? await advanceHyper({ cursor, ctx, run, ontology })
    : await advanceSwarm({ cursor, ctx, run, ontology });
  ontology = result.ontology;

  // Run finished — upgrade a filename-derived name to a content title.
  if (result.run.status === 'complete') {
    await maybeUpgradeAutoName(result.run, ontology, userInfo);
  }

  await persistRunState(store, result.run, ontology);
  await persistSwarmState(store, runId, result.cursor);

  const payload: Record<string, unknown> = {
    run: result.run,
    ontology,
    phase: result.phase,
    businessBrief: result.businessBrief,
    coverageReport: result.coverageReport,
    followUpQuestions: result.followUpQuestions,
  };
  if ('terminology' in result) {
    payload.terminology = result.terminology;
    payload.documentCoverage = result.documentCoverage;
  }
  ok(res, payload);
}

// ===========================================================================
// Action: stage.<x> — single-stage re-run against an inline draft Ontology.
// Returns ONLY this stage's items + log + critique + this stage's issues.
// ===========================================================================

async function actionStage(
  req: VercelRequest,
  res: VercelResponse,
  stage: Stage,
  userInfo: unknown | null,
): Promise<void> {
  const store = getStore();
  const body = bodyObject(req);
  const draft = body.ontology as Ontology | undefined;
  if (!draft || typeof draft !== 'object') {
    throw new HttpError(400, `stage.${stage} requires an ontology draft`, 'NO_ONTOLOGY');
  }

  const parsedRefs = Array.isArray(body.parsedRefs)
    ? (body.parsedRefs as unknown[]).filter((s) => typeof s === 'string') as string[]
    : undefined;
  const options = (body.options as { model?: string; temperature?: number } | undefined) ?? {};

  const logLines: string[] = [];
  const log = (text: string) => { logLines.push(text); logEvent('step', text); };

  const ctx = await contextFromOntology(store, draft, parsedRefs, userInfo, log, { model: options.model });

  // runStage enforces STAGE_ORDER preconditions (throws on out-of-order, which we
  // surface as a 400). Idempotent: re-running a stage replaces its layer.
  let result;
  try {
    result = await runStage(stage, ctx);
  } catch (err) {
    const msg = errText(err);
    if (msg.startsWith('STAGE_OUT_OF_ORDER')) {
      throw new HttpError(400, msg, 'STAGE_OUT_OF_ORDER');
    }
    throw err;
  }

  const items = stageItems(stage, ctx);
  const issues = stageIssues(stage, result.issues);

  const payload: Record<string, unknown> = {
    stage,
    items,
    log: logLines,
    issues,
  };
  if (result.critique) payload.stageCritique = result.critique;
  // Objects stage also returns relationships under items.relationships.
  if (stage === 'objects') {
    payload.relationships = ctx.relationships;
  }
  if (stage === 'rules') {
    payload.ruleGroups = ctx.ruleGroups;
  }
  ok(res, payload);
}

function stageItems(
  stage: Stage,
  ctx: StageContext,
): ObjectType[] | Rule[] | ActionType[] | EventType[] | Process[] | Relationship[] {
  switch (stage) {
    case 'objects':
      return ctx.objects;
    case 'rules':
      return ctx.rules;
    case 'actions':
      return ctx.actions;
    case 'events':
      return ctx.events;
    case 'processes':
      return ctx.processes;
    default:
      return [];
  }
}

/** Filter validation issues down to those originating from this stage's ids. */
function stageIssues(stage: Stage, issues: ValidationIssue[]): ValidationIssue[] {
  const prefix: Record<Stage, string> = {
    objects: 'objectType:',
    rules: 'rule:',
    actions: 'action:',
    events: 'event:',
    processes: 'process:',
  };
  const objPrefix = prefix[stage];
  const relPrefix = stage === 'objects' ? 'rel:' : null;
  return issues.filter(
    (i) => i.from.startsWith(objPrefix) || (relPrefix !== null && i.from.startsWith(relPrefix)),
  );
}

// ===========================================================================
// Action: list / get / save / publish / delete.
// ===========================================================================

async function actionList(req: VercelRequest, res: VercelResponse): Promise<void> {
  const store = getStore();
  const domain = queryStr(req, 'domain');
  const ontologies = await store.list(isDomainKey(domain) ? { domain } : undefined);
  ok(res, { ontologies });
}

async function actionGet(req: VercelRequest, res: VercelResponse): Promise<void> {
  const store = getStore();
  const id = queryStr(req, 'ontologyId');
  if (!id) throw new HttpError(400, 'get requires ontologyId', 'NO_ONTOLOGY_ID');
  const version = queryInt(req, 'version');
  const ontology = await store.get(id, version);
  if (!ontology) throw new HttpError(404, `ontology not found: ${id}`, 'ONTOLOGY_NOT_FOUND');
  ok(res, { ontology });
}

async function actionSave(req: VercelRequest, res: VercelResponse, user: AuthUser): Promise<void> {
  const store = getStore();
  const body = bodyObject(req);
  const draft = body.ontology as Ontology | undefined;
  if (!draft || typeof draft !== 'object' || typeof draft.id !== 'string') {
    throw new HttpError(400, 'save requires an ontology with an id', 'NO_ONTOLOGY');
  }
  const changeSummary = typeof body.changeSummary === 'string' ? body.changeSummary : undefined;

  // Validate + recompute review-trail before persisting.
  const issues = validateOntology(draft);
  draft.metadata = { ...draft.metadata, danglingRefs: collectDangling(issues) };

  const saved = await store.save(draft, changeSummary, { userId: user.userId, name: user.name, email: user.email });
  ok(res, { ontology: saved, issues });
}

async function actionPublish(req: VercelRequest, res: VercelResponse, user: AuthUser): Promise<void> {
  const store = getStore();
  const body = bodyObject(req);
  const id = typeof body.ontologyId === 'string' ? body.ontologyId : queryStr(req, 'ontologyId');
  if (!id) throw new HttpError(400, 'publish requires ontologyId', 'NO_ONTOLOGY_ID');
  const version = typeof body.version === 'number' ? body.version : queryInt(req, 'version');

  let published: Ontology;
  try {
    published = await store.publish(id, version, { userId: user.userId, name: user.name, email: user.email });
  } catch (err) {
    const msg = errText(err);
    if (msg.startsWith('ONTOLOGY_NOT_FOUND')) {
      throw new HttpError(404, `ontology not found: ${id}`, 'ONTOLOGY_NOT_FOUND');
    }
    throw err;
  }

  // Best-effort Neo4j import — NEVER fails publish.
  const neo4j = await safeImport(published);
  ok(res, { ontology: published, neo4j });
}

async function actionDelete(req: VercelRequest, res: VercelResponse): Promise<void> {
  const store = getStore();
  const id = queryStr(req, 'ontologyId') || (typeof bodyObject(req).ontologyId === 'string' ? String(bodyObject(req).ontologyId) : undefined);
  if (!id) throw new HttpError(400, 'delete requires ontologyId', 'NO_ONTOLOGY_ID');
  await store.delete(id);
  ok(res, {});
}

// ===========================================================================
// Action: validate / generate / import-graph / graph-status.
// ===========================================================================

async function actionValidate(req: VercelRequest, res: VercelResponse): Promise<void> {
  const body = bodyObject(req);
  const ontology = body.ontology as Ontology | undefined;
  if (!ontology || typeof ontology !== 'object') {
    throw new HttpError(400, 'validate requires an ontology', 'NO_ONTOLOGY');
  }
  const issues = validateOntology(ontology);
  ok(res, { issues, danglingRefs: collectDangling(issues) });
}

async function actionGenerate(req: VercelRequest, res: VercelResponse): Promise<void> {
  const store = getStore();
  const body = bodyObject(req);

  const target = body.target;
  if (!isGeneratorTarget(target) && target !== 'all') {
    throw new HttpError(400, `generate requires target in agent-code|prompts|manifest|spec|all`, 'BAD_TARGET');
  }

  // Either an inline ontology or an id (+ optional version) to load.
  let ontology = body.ontology as Ontology | undefined;
  if (!ontology) {
    const id = typeof body.ontologyId === 'string' ? body.ontologyId : undefined;
    if (!id) throw new HttpError(400, 'generate requires ontology or ontologyId', 'NO_ONTOLOGY');
    const version = typeof body.version === 'number' ? body.version : undefined;
    const loaded = await store.get(id, version);
    if (!loaded) throw new HttpError(404, `ontology not found: ${id}`, 'ONTOLOGY_NOT_FOUND');
    ontology = loaded;
  }

  const result = await generate(ontology, target as GeneratorTarget | 'all');
  if (Array.isArray(result)) {
    ok(res, { bundles: result });
  } else {
    ok(res, { bundle: result });
  }
}

async function actionImportGraph(req: VercelRequest, res: VercelResponse): Promise<void> {
  const store = getStore();
  const body = bodyObject(req);
  const id = typeof body.ontologyId === 'string' ? body.ontologyId : queryStr(req, 'ontologyId');
  if (!id) throw new HttpError(400, 'import-graph requires ontologyId', 'NO_ONTOLOGY_ID');
  const version = typeof body.version === 'number' ? body.version : queryInt(req, 'version');

  const ontology = await store.get(id, version);
  if (!ontology) throw new HttpError(404, `ontology not found: ${id}`, 'ONTOLOGY_NOT_FOUND');

  const neo4j = await safeImport(ontology);
  ok(res, { neo4j });
}

async function actionGraphStatus(_req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!neo4jEnabled()) {
    ok(res, { neo4j: 'disabled' });
    return;
  }
  const healthy = await neo4jHealthy();
  ok(res, { neo4j: healthy ? 'connected' : 'unreachable' });
}

/** Best-effort importOntology with a normalized, never-throwing result shape. */
async function safeImport(ontology: Ontology): Promise<{ mirrored: boolean; nodes?: number; rels?: number; reason?: string }> {
  if (!neo4jEnabled()) {
    return { mirrored: false, reason: 'disabled' };
  }
  try {
    const r = await importOntology(ontology);
    if (r.mirrored) return { mirrored: true, nodes: r.nodes, rels: r.rels };
    return { mirrored: false, reason: r.error ?? 'unreachable' };
  } catch (err) {
    return { mirrored: false, reason: errText(err) };
  }
}

// ===========================================================================
// Action: llm.agents / llm.settings — the per-agent LLM routing surface
// (agent registry + resolved assignments + the persisted LlmSettings).
// ===========================================================================

async function actionLlmAgents(_req: VercelRequest, res: VercelResponse): Promise<void> {
  const store = getStore();
  const settings = await loadLlmSettings(store);
  ok(res, {
    agents: AGENT_REGISTRY,
    assignments: listAssignments(settings, defaultModel(), defaultProvider()),
    settings: settings ?? { overrides: {} },
  });
}

async function actionLlmSettings(req: VercelRequest, res: VercelResponse): Promise<void> {
  const body = bodyObject(req);

  // Defensive narrowing of the LlmSettings shape; saveLlmSettings sanitizes
  // further (unknown agent ids dropped, empty strings stripped).
  const input: LlmSettings = { overrides: {} };
  const rawOverrides = body.overrides;
  if (rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)) {
    input.overrides = rawOverrides as LlmSettings['overrides'];
  }
  if (typeof body.defaultProvider === 'string') input.defaultProvider = body.defaultProvider;
  if (typeof body.defaultModel === 'string') input.defaultModel = body.defaultModel;
  if (typeof body.routerEnabled === 'boolean') input.routerEnabled = body.routerEnabled;
  if (typeof body.tavilyApiKey === 'string') input.tavilyApiKey = body.tavilyApiKey;

  const store = getStore();
  const saved = await saveLlmSettings(store, input);
  ok(res, {
    settings: saved,
    assignments: listAssignments(saved, defaultModel(), defaultProvider()),
  });
}

// ===========================================================================
// Action: infer — multi-hop graph reasoning over an ontology (inline or by id).
// ===========================================================================

async function actionInfer(req: VercelRequest, res: VercelResponse, userInfo: unknown | null): Promise<void> {
  const store = getStore();
  const body = bodyObject(req);

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) throw new HttpError(400, 'infer requires a non-empty question', 'NO_QUESTION');

  // Either an inline ontology or an id (+ optional version) to load.
  let ontology = body.ontology && typeof body.ontology === 'object' && !Array.isArray(body.ontology)
    ? (body.ontology as Ontology)
    : undefined;
  if (!ontology) {
    const id = typeof body.ontologyId === 'string' ? body.ontologyId : undefined;
    if (!id) throw new HttpError(400, 'infer requires ontology or ontologyId', 'NO_ONTOLOGY');
    const version = typeof body.version === 'number' ? body.version : undefined;
    const loaded = await store.get(id, version);
    if (!loaded) throw new HttpError(404, `ontology not found: ${id}`, 'NOT_FOUND');
    ontology = loaded;
  }

  const settings = await loadLlmSettings(store);
  const llm = resolveAgentLlm('inference_agent', {
    settings,
    baseModel: defaultModel(),
    baseProvider: defaultProvider(),
  });

  const result = await runInference({
    ontology,
    question,
    model: llm.model,
    provider: llm.provider,
    userInfo: userInfo as ExecuteLLMOptions['userInfo'] ?? null,
    maxHops: typeof body.maxHops === 'number' ? body.maxHops : undefined,
    maxIterations: typeof body.maxIterations === 'number' ? body.maxIterations : undefined,
  });

  ok(res, { result });
}

// ===========================================================================
// Small shared helpers.
// ===========================================================================

const nowIso = (): string => new Date().toISOString();

function appendLog(run: OntologyRun, text: string): void {
  run.log.push({ at: nowIso(), text });
  logStep(`run=${run.id}`, text); // mirror every run-log line to the file logger
}

function collectDangling(issues: ValidationIssue[]): { from: string; field: string; missingId: string }[] {
  const out: { from: string; field: string; missingId: string }[] = [];
  for (const i of issues) {
    if (i.kind === 'dangling_ref' && i.field && i.missingId) {
      out.push({ from: i.from, field: i.field, missingId: i.missingId });
    }
  }
  return out;
}

const DOMAIN_KEYS = new Set<string>([
  'retail_o2c',
  'commercial_lending',
  'healthcare_revcycle',
  'manufacturing_bom_quality',
  'logistics_fulfillment',
  'energy_grid_outage',
  'hr_talent_acquisition',
  'insurance_claims_underwriting',
  'public_sector_permitting',
  'saas_subscription_entitlement',
  'generic',
]);

function isDomainKey(v: unknown): v is DomainKey {
  return typeof v === 'string' && DOMAIN_KEYS.has(v);
}

function isGeneratorTarget(v: unknown): v is GeneratorTarget {
  return v === 'agent-code' || v === 'prompts' || v === 'manifest' || v === 'spec';
}

// ===========================================================================
// Stage-action name → Stage mapping.
// ===========================================================================

const STAGE_ACTIONS: Record<string, Stage> = {
  'stage.objects': 'objects',
  'stage.rules': 'rules',
  'stage.actions': 'actions',
  'stage.events': 'events',
  'stage.processes': 'processes',
};

// Which actions are pure reads (GET).
const READ_ACTIONS = new Set<string>(['samples', 'run.get', 'list', 'get', 'graph-status', 'llm.agents']);

// ===========================================================================
// Default export — the Vercel handler.
// ===========================================================================

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const action = queryStr(req, 'action');
  if (!action) {
    fail(res, 400, 'missing ?action=', 'NO_ACTION');
    return;
  }

  // ---- Auth: OPTIONAL. The /ontology-generator route is PUBLIC (trial/demo),
  // so we do not hard-require a login. A valid Bearer JWT is attributed and,
  // when a real Supabase backend is configured, module-gated on ontology_studio;
  // otherwise the request runs as an anonymous guest. Set
  // ONTOLOGY_GEN_REQUIRE_AUTH=1 to re-lock the endpoint (mandatory valid token).
  const verified = verifyToken(extractToken(req.headers.authorization) || '');
  if (process.env.ONTOLOGY_GEN_REQUIRE_AUTH === '1' && (!verified || !verified.userId)) {
    fail(res, 401, 'Unauthorized', 'NO_TOKEN');
    return;
  }
  const user: AuthUser =
    verified && verified.userId
      ? verified
      : { userId: 'anonymous', email: 'anonymous@local', name: 'Guest', role: 'guest', status: 'approved' };

  const userInfo = {
    userId: user.userId,
    userName: user.name || (user.userId === 'anonymous' ? 'Guest' : 'Unknown'),
    userEmail: user.email || 'unknown@unknown.com',
  };

  // ---- Method check: pure reads are GET; everything else POST/DELETE. -------
  const isRead = READ_ACTIONS.has(action);
  if (isRead) {
    if (req.method !== 'GET') {
      fail(res, 405, `Method ${req.method} not allowed for ${action} (use GET)`, 'METHOD_NOT_ALLOWED');
      return;
    }
  } else if (action === 'delete') {
    if (req.method !== 'DELETE' && req.method !== 'POST') {
      fail(res, 405, `Method ${req.method} not allowed for delete`, 'METHOD_NOT_ALLOWED');
      return;
    }
  } else if (req.method !== 'POST') {
    fail(res, 405, `Method ${req.method} not allowed for ${action} (use POST)`, 'METHOD_NOT_ALLOWED');
    return;
  }

  try {
    logEvent('action', `${action} ${req.method ?? ''} user=${userInfo.userId}`);
    // Stage re-run actions.
    const maybeStage = STAGE_ACTIONS[action];
    if (maybeStage) {
      await actionStage(req, res, maybeStage, userInfo);
      return;
    }

    switch (action) {
      case 'upload':
        await actionUpload(req, res, userInfo);
        return;
      case 'parse':
        await actionParse(req, res);
        return;
      case 'db.upload':
        await actionDbUpload(req, res);
        return;
      case 'db.preview':
        await actionDbPreview(req, res);
        return;
      case 'db.introspect':
        await actionDbIntrospect(req, res);
        return;
      case 'samples':
        await actionSamples(req, res);
        return;
      case 'run.start':
        await actionRunStart(req, res, userInfo);
        return;
      case 'run.step':
        await actionRunStep(req, res, userInfo);
        return;
      case 'run.get':
        await actionRunGet(req, res);
        return;
      case 'run.swarm.start':
        await actionSwarmStart(req, res, userInfo);
        return;
      case 'run.swarm.step':
        await actionModeStep(req, res, userInfo, 'run.swarm.step');
        return;
      case 'run.hyper.start':
        await actionHyperStart(req, res, userInfo);
        return;
      case 'run.hyper.step':
        await actionModeStep(req, res, userInfo, 'run.hyper.step');
        return;
      case 'llm.agents':
        await actionLlmAgents(req, res);
        return;
      case 'llm.settings':
        await actionLlmSettings(req, res);
        return;
      case 'infer':
        await actionInfer(req, res, userInfo);
        return;
      case 'list':
        await actionList(req, res);
        return;
      case 'get':
        await actionGet(req, res);
        return;
      case 'save':
        await actionSave(req, res, user);
        return;
      case 'publish':
        await actionPublish(req, res, user);
        return;
      case 'delete':
        await actionDelete(req, res);
        return;
      case 'validate':
        await actionValidate(req, res);
        return;
      case 'generate':
        await actionGenerate(req, res);
        return;
      case 'import-graph':
        await actionImportGraph(req, res);
        return;
      case 'graph-status':
        await actionGraphStatus(req, res);
        return;
      default:
        fail(res, 400, `unknown action: ${action}`, 'UNKNOWN_ACTION');
        return;
    }
  } catch (err) {
    if (err instanceof HttpError) {
      logEvent('error', `action=${action} ${err.code ?? ''} ${err.message}`);
      fail(res, err.status, err.message, err.code);
      return;
    }
    // Store/runtime failures degrade to a 400 envelope — never an unhandled 500
    // on missing Supabase/Neo4j env (those paths fall back before reaching here).
    const msg = errText(err);
    const status = msg.includes('NOT_FOUND') ? 404 : 400;
    logEvent('error', `action=${action} ${msg}`);
    fail(res, status, msg, 'HANDLER_ERROR');
  }
}
