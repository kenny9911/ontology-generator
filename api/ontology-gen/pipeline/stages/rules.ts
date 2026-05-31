// ============================================================================
//  ONTOLOGY GENERATOR — PIPELINE STAGE 2: RULES (pure extract)
// ============================================================================
//
//  `extractRules(ctx)` mines business rules SENTENCE BY SENTENCE from the
//  policy / SOP sources, links each rule to the object vocabulary already
//  discovered in stage 1 (`ctx.objects`), and clusters the rules into
//  `RuleGroup[]`. It is a PURE EXTRACT step:
//    - one `executeLLMWithTracking` call (via the canonical LLM dispatcher),
//    - defensive JSON parse of the model output,
//    - deterministic id minting (`makeId`) for rules + groups,
//    - `sources[].snippet` set to the verbatim sentence + `sentenceRefs`,
//    - a RAW confidence taken from the model (clamped) — the ORCHESTRATOR
//      re-grounds offsets, applies the confidence rubric, and validates later.
//
//  This stage NEVER mutates prior-layer arrays and NEVER throws on a malformed
//  model response: it degrades to an empty result so the run can continue.
//
//  HARD RULES (NodeNext / strict TS): every relative project import carries a
//  `.js` suffix; schema types come from the generated backend mirror.
// ============================================================================

import type { ChatMessage, UserInfo } from '../../llm.js';
import { executeLLMWithTracking } from '../../llm.js';
import type { LLMProvider } from '../../llm.js';
import { makeId } from '../../../_shared/ids.js';
import { buildRulesPrompt } from '../../prompts.js';
import type { StageContext } from '../context.js';
import type {
  Rule,
  RuleExpression,
  RuleGroup,
  RuleKind,
  Severity,
  SourceRef,
} from '../../../_shared/ontology-schema.js';
import { SEVERITY_LEVELS } from '../../../_shared/ontology-schema.js';

// ---------------------------------------------------------------------------
// Local vocabularies (kept in sync with the schema's RuleKind union).
// ---------------------------------------------------------------------------

const RULE_KINDS: ReadonlySet<RuleKind> = new Set<RuleKind>([
  'validation',
  'constraint',
  'derivation',
  'state_transition',
  'authorization',
  'temporal',
]);

const SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(SEVERITY_LEVELS);

/** A numbered sentence handed to the prompt + used to recover snippets. */
interface NumberedSentence {
  idx: number;
  text: string;
  /** Which source document this sentence belongs to (for citation backfill). */
  documentId: string;
  documentName: string;
}

// ---------------------------------------------------------------------------
// PUBLIC: stage entry point.
// ---------------------------------------------------------------------------

/**
 * Mine rules sentence-by-sentence from the policy/SOP sources, resolve each
 * rule against the known object vocabulary (`ctx.objects`), and cluster the
 * rules into `RuleGroup[]`. Returns ONLY the layer this stage produces; the
 * orchestrator merges it back into the context.
 */
export async function extractRules(
  ctx: StageContext,
): Promise<{ rules: Rule[]; ruleGroups: RuleGroup[] }> {
  // 1. Number every sentence across the parsed sources (rules cite by idx).
  const sentences = numberSentences(ctx);
  if (sentences.length === 0) {
    ctx.log('rules: no source text to mine — skipping.');
    return { rules: [], ruleGroups: [] };
  }

  // 2. A compact, lookup-by-id object vocabulary for cross-refs + the prompt.
  const objectIds = new Set<string>(ctx.objects.map((o) => o.id));
  const priorObjects = ctx.objects.map((o) => ({
    id: o.id,
    name: o.name,
    nameZh: o.nameZh,
  }));

  // 3. Build the prompt (the builder OWNS all prompt text — never duplicated).
  const docName = primaryDocName(ctx);
  const { system, user } = buildRulesPrompt({
    docName,
    numberedSentences: sentences.map((s) => ({ idx: s.idx, text: s.text })),
    priorObjects,
  });

  // 4. ONE LLM call through the canonical dispatcher. Never raw fetch.
  let raw: string;
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    raw = await executeLLMWithTracking({
      model: ctx.model,
      provider: ctx.provider as LLMProvider,
      messages,
      temperature: 0.1,
      maxTokens: 28000,
      module: 'ontology_generator',
      actionName: 'ontology_extract_rules',
      userInfo: (ctx.userInfo as UserInfo | null) ?? null,
    });
  } catch (err) {
    ctx.log(`rules: LLM call failed (${errMsg(err)}) — returning empty.`);
    return { rules: [], ruleGroups: [] };
  }

  // 5. Defensive parse of the model's JSON.
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    ctx.log('rules: model output was not parseable JSON — returning empty.');
    return { rules: [], ruleGroups: [] };
  }

  const rawRules = asArray(parsed.rules);
  if (rawRules.length === 0) {
    ctx.log('rules: model returned no rules.');
    return { rules: [], ruleGroups: [] };
  }

  // 6. Normalize each raw rule into a strict `Rule`, minting a deterministic id.
  const sentenceByIdx = new Map<number, NumberedSentence>();
  for (const s of sentences) sentenceByIdx.set(s.idx, s);

  const rules: Rule[] = [];
  // Capture the model's clustering hint (raw groupId) per minted rule id so we
  // can fall back to it before topic-based clustering.
  const rawGroupHint = new Map<string, string>();

  for (const rr of rawRules) {
    const built = buildRule(rr, ctx, objectIds, sentenceByIdx, docName);
    if (!built) continue;
    rules.push(built.rule);
    if (built.rawGroupId) rawGroupHint.set(built.rule.id, built.rawGroupId);
  }

  if (rules.length === 0) {
    ctx.log('rules: no rules survived normalization — returning empty.');
    return { rules: [], ruleGroups: [] };
  }

  // 7. Cluster the rules into groups; stamp `groupId` on each member rule.
  const ruleGroups = clusterRules(rules, rawGroupHint, parsed, ctx.taken);

  ctx.log(`rules: extracted ${rules.length} rule(s) in ${ruleGroups.length} group(s).`);
  return { rules, ruleGroups };
}

// ---------------------------------------------------------------------------
// Sentence numbering — the citation spine for this stage.
// ---------------------------------------------------------------------------

/**
 * Flatten every parsed source into a single globally-numbered sentence list.
 * Numbering is 1-based and continuous across sources so the model can cite a
 * single `idx` per sentence; we keep the owning document on each entry so the
 * backend can attach the correct documentName when the model omits it.
 */
function numberSentences(ctx: StageContext): NumberedSentence[] {
  const docNameById = new Map<string, string>();
  for (const d of ctx.sources) docNameById.set(d.id, d.name);

  const out: NumberedSentence[] = [];
  let idx = 1;
  for (const p of ctx.parsed) {
    const text = typeof p.text === 'string' ? p.text : '';
    if (!text.trim()) continue;
    const documentId = p.documentId;
    const documentName = docNameById.get(documentId) ?? documentId;
    for (const sentence of splitSentences(text)) {
      out.push({ idx, text: sentence, documentId, documentName });
      idx += 1;
    }
  }
  return out;
}

/**
 * Conservative sentence splitter: break on sentence-final punctuation
 * (incl. CJK 。！？；) and on hard line breaks (lists/bullets are one "sentence"
 * each). Keeps the matching robust without a heavyweight NLP dependency.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;。！？；])\s+|\r?\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Rule normalization.
// ---------------------------------------------------------------------------

interface BuiltRule {
  rule: Rule;
  rawGroupId: string | null;
}

/**
 * Turn one raw model object into a strict `Rule`. Drops anything missing a
 * usable statement. Resolves `appliesToObjectTypeIds` against the known object
 * vocabulary, backfills sentence snippets, clamps confidence, and forces
 * provenance/reviewState to the locked extraction defaults.
 */
function buildRule(
  raw: unknown,
  ctx: StageContext,
  objectIds: Set<string>,
  sentenceByIdx: Map<number, NumberedSentence>,
  docName: string,
): BuiltRule | null {
  if (!isRecord(raw)) return null;

  const statement = coerceBilingual(raw.statement);
  const enRaw = statement.en.trim();
  const zh = statement.zh.trim();
  // Keep a rule with a statement in EITHER language — single-language corpora
  // (e.g. Chinese) commonly yield zh-only statements. Fall back across languages
  // so a zh-only rule still gets a usable title / formal / id.
  if (!enRaw && !zh) return null;
  const en = enRaw || zh;

  const title = str(raw.title) || firstClause(en);
  const formal = str(raw.formal) || en;

  const kind = RULE_KINDS.has(raw.kind as RuleKind) ? (raw.kind as RuleKind) : 'constraint';
  const severity = SEVERITIES.has(raw.severity as Severity)
    ? (raw.severity as Severity)
    : 'warn';

  // Resolve applies-to object ids against the stage-1 vocabulary; drop unknowns.
  const appliesToObjectTypeIds = uniq(
    asArray(raw.appliesToObjectTypeIds)
      .map((v) => str(v))
      .filter((id) => id.length > 0 && objectIds.has(id)),
  );

  const appliesToAttributes = uniq(
    asArray(raw.appliesToAttributes)
      .map((v) => str(v))
      .filter((a) => a.length > 0 && objectIds.has(a.split('.')[0] ?? '')),
  );

  const expression = coerceExpression(raw.expression, objectIds);
  const trigger = coerceTrigger(raw.trigger);
  const sources = coerceSources(raw.sources, sentenceByIdx, docName);

  const id = makeId('rule', title, ctx.taken);
  const uuid = `${id}#${ctx.ontologyId}`;

  const rule: Rule = {
    id,
    uuid,
    title,
    ...(zh ? { titleZh: str(raw.titleZh) || zh } : {}),
    statement: { en, zh: zh || en },
    formal,
    ...(expression ? { expression } : {}),
    kind,
    severity,
    appliesToObjectTypeIds,
    ...(appliesToAttributes.length > 0 ? { appliesToAttributes } : {}),
    ...(trigger ? { trigger } : {}),
    sources,
    confidence: clampConfidence(raw.confidence),
    provenance: 'extracted',
    reviewState: 'pending',
  };

  return { rule, rawGroupId: str(raw.groupId) || null };
}

/** Coerce the model's `expression` into a strict `RuleExpression` or undefined. */
function coerceExpression(raw: unknown, objectIds: Set<string>): RuleExpression | undefined {
  if (!isRecord(raw)) return undefined;
  const predicate = str(raw.predicate);
  if (!predicate) return undefined;
  const bindings = asArray(raw.bindings)
    .map((b) => {
      if (!isRecord(b)) return null;
      const varName = str(b.var);
      const objectTypeId = str(b.objectTypeId);
      if (!varName || !objectTypeId || !objectIds.has(objectTypeId)) return null;
      return { var: varName, objectTypeId };
    })
    .filter((b): b is { var: string; objectTypeId: string } => b !== null);
  return { dialect: 'cel', predicate, bindings };
}

/** Coerce the optional `trigger` (description required; onEventTypeId optional). */
function coerceTrigger(
  raw: unknown,
): { description: string; onEventTypeId?: string } | undefined {
  if (!isRecord(raw)) return undefined;
  const description = str(raw.description);
  if (!description) return undefined;
  const onEventTypeId = str(raw.onEventTypeId);
  return onEventTypeId ? { description, onEventTypeId } : { description };
}

/**
 * Coerce `sources` into SENTENCE-level `SourceRef[]`. The snippet is taken as
 * the model's verbatim quote; when absent but `sentenceRefs` resolve, we
 * reconstruct the snippet from the numbered sentences (and backfill the
 * documentName). The backend recomputes char offsets + quoteVerified later, so
 * we never set them here.
 */
function coerceSources(
  raw: unknown,
  sentenceByIdx: Map<number, NumberedSentence>,
  fallbackDocName: string,
): SourceRef[] {
  const out: SourceRef[] = [];
  for (const s of asArray(raw)) {
    if (!isRecord(s)) continue;
    const sentenceRefs = uniq(
      asArray(s.sentenceRefs)
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n)),
    );

    let snippet = str(s.snippet).trim();
    // Reconstruct/repair the snippet from the cited sentences when needed.
    const cited = sentenceRefs
      .map((i) => sentenceByIdx.get(i))
      .filter((x): x is NumberedSentence => x !== undefined);
    if (!snippet && cited.length > 0) {
      snippet = cited.map((c) => c.text).join(' ');
    }
    if (!snippet) continue; // a citation with no quote is useless — skip it.

    const documentName =
      str(s.documentName) || cited[0]?.documentName || fallbackDocName;
    const documentId = str(s.documentId) || cited[0]?.documentId || '';
    const section = str(s.section);

    const ref: SourceRef = {
      documentId,
      documentName,
      snippet,
      ...(section ? { section } : {}),
      ...(sentenceRefs.length > 0 ? { sentenceRefs } : {}),
    };
    out.push(ref);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clustering into RuleGroups.
// ---------------------------------------------------------------------------

/**
 * Cluster rules into `RuleGroup[]` and stamp `groupId` on each member.
 *
 * Grouping precedence:
 *  1. An explicit `_groups` array on the model output (title + ruleIds), when
 *     the ids resolve to minted rules.
 *  2. The per-rule `groupId` HINT the model emitted (rules sharing a hint join).
 *  3. A deterministic fallback: cluster by the rules' shared constrained object
 *     ids (rules touching the same object set form one group), so every rule
 *     always lands in exactly one group.
 */
function clusterRules(
  rules: Rule[],
  rawGroupHint: Map<string, string>,
  parsed: Record<string, unknown>,
  taken: Set<string>,
): RuleGroup[] {
  const ruleById = new Map<string, Rule>(rules.map((r) => [r.id, r]));
  const assigned = new Set<string>();
  const groups: RuleGroup[] = [];

  const addGroup = (titleSeed: string, members: Rule[], rationale?: string): void => {
    const realMembers = members.filter((r) => !assigned.has(r.id));
    if (realMembers.length === 0) return;
    const id = makeId('ruleGroup', titleSeed, taken);
    const title = bilingualTitle(titleSeed, realMembers);
    for (const r of realMembers) {
      r.groupId = id;
      assigned.add(r.id);
    }
    groups.push({
      id,
      title,
      ruleIds: realMembers.map((r) => r.id),
      ...(rationale ? { rationale } : {}),
    });
  };

  // (1) Explicit groups from the model, if present and well-formed.
  for (const g of asArray(parsed._groups ?? parsed.ruleGroups ?? parsed.groups)) {
    if (!isRecord(g)) continue;
    const members = asArray(g.ruleIds)
      .map((rid) => ruleById.get(str(rid)))
      .filter((r): r is Rule => r !== undefined && !assigned.has(r.id));
    if (members.length === 0) continue;
    const seed = groupSeedFromTitle(g.title) || members[0]!.title;
    addGroup(seed, members, str(g.rationale) || undefined);
  }

  // (2) Per-rule groupId hints from the model.
  const byHint = new Map<string, Rule[]>();
  for (const r of rules) {
    if (assigned.has(r.id)) continue;
    const hint = rawGroupHint.get(r.id);
    if (!hint) continue;
    if (!byHint.has(hint)) byHint.set(hint, []);
    byHint.get(hint)!.push(r);
  }
  for (const [hint, members] of byHint) addGroup(hint, members);

  // (3) Deterministic fallback: cluster remaining rules by shared object set.
  const byObjects = new Map<string, Rule[]>();
  for (const r of rules) {
    if (assigned.has(r.id)) continue;
    const key = r.appliesToObjectTypeIds.slice().sort().join('|') || '__ungrouped__';
    if (!byObjects.has(key)) byObjects.set(key, []);
    byObjects.get(key)!.push(r);
  }
  for (const [key, members] of byObjects) {
    const seed =
      key === '__ungrouped__'
        ? 'General Rules'
        : objectSeed(members[0]!) || members[0]!.title;
    addGroup(seed, members);
  }

  return groups;
}

/** A human group seed derived from the first constrained object id, if any. */
function objectSeed(rule: Rule): string {
  const first = rule.appliesToObjectTypeIds[0];
  if (!first) return '';
  const bare = first.replace(/^objectType:/, '').replace(/[.-]+/g, ' ').trim();
  return bare ? `${titleCase(bare)} Rules` : '';
}

/** Pull an English-ish title from a possibly-bilingual model group title. */
function groupSeedFromTitle(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (isRecord(raw)) return (str(raw.en) || str(raw.zh)).trim();
  return '';
}

/** Build a bilingual group title from the seed + members (zh best-effort). */
function bilingualTitle(seed: string, members: Rule[]): { en: string; zh: string } {
  const en = seed.trim() || members[0]?.title || 'Rule Group';
  // Best-effort zh: borrow the zh title/statement of the first member.
  const zh =
    members.find((m) => m.titleZh)?.titleZh ||
    members[0]?.statement.zh ||
    en;
  return { en, zh };
}

// ---------------------------------------------------------------------------
// Generic parsing / coercion helpers (defensive — never throw).
// ---------------------------------------------------------------------------

/** The display name of the first source document (for citation fallback). */
function primaryDocName(ctx: StageContext): string {
  return ctx.sources[0]?.name ?? 'the document';
}

/**
 * Defensively parse a single JSON object out of an LLM response: strip code
 * fences, then slice from the first `{` to the last `}` before `JSON.parse`.
 */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  // Strip ```json ... ``` / ``` ... ``` fences.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Coerce an unknown into a `Bilingual` ({en,zh}); accepts a bare string as en. */
function coerceBilingual(raw: unknown): { en: string; zh: string } {
  if (typeof raw === 'string') return { en: raw, zh: '' };
  if (isRecord(raw)) return { en: str(raw.en), zh: str(raw.zh) };
  return { en: '', zh: '' };
}

/** Clamp a raw model confidence into [0,1]; default 0.5 when absent/NaN. */
function clampConfidence(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** First sentence/clause of a statement, for a compact title seed. */
function firstClause(text: string): string {
  const m = text.split(/[.!?;:\n]/)[0]?.trim() ?? '';
  const clipped = m.length > 60 ? `${m.slice(0, 57)}...` : m;
  return clipped || text.slice(0, 57) || 'Rule';
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
