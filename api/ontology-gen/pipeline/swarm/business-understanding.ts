// ============================================================================
//  DEEP-SWARM — business understanding (the web-augmented SME swarm).
//
//  Runs N SME agents (one per perspective) IN PARALLEL, each producing a
//  BusinessBrief fragment (personas / use cases / expected items / glossary)
//  for the {domain}. The fragments are merged deterministically into one brief.
//  The brief is a RECALL TARGET — it is never inserted into the ontology as fact.
// ============================================================================

import { buildSmePrompt } from '../../prompts.js';
import type { SmePerspective } from '../../prompts.js';
import type {
  BusinessBrief,
  Persona,
  UseCase,
  ExpectedEntity,
  GlossaryTerm,
  Bilingual,
  EntityKind,
  ParsedSource,
} from '../../../_shared/ontology-schema.js';
import { callJson } from './llm-json.js';
import { webSearchAvailable } from './web-search.js';
import { asArray, asRecord, bil, bilOpt, str, localId } from './util.js';

const PERSPECTIVES: SmePerspective[] = ['process', 'data', 'rules', 'systems'];
const KINDS = new Set<string>(['object', 'rule', 'action', 'event', 'process', 'relationship']);

const norm = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function corpusFrom(parsed: ParsedSource[], cap = 20000): string {
  const joined = parsed.map((p) => p.text).join('\n\n---\n\n');
  return joined.length > cap ? joined.slice(0, cap) : joined;
}

export interface SmeOptions {
  domain: string;
  parsed: ParsedSource[];
  model: string;
  provider: string;
  userInfo: unknown | null;
  log: (t: string) => void;
}

/** Run the SME swarm and return the merged BusinessBrief. */
export async function runBusinessUnderstanding(opts: SmeOptions): Promise<BusinessBrief> {
  const web = webSearchAvailable(opts.provider);
  const corpus = corpusFrom(opts.parsed);
  opts.log(
    `[swarm] business understanding — ${PERSPECTIVES.length} SME agents ${web ? '(live web search)' : '(parametric knowledge)'}`,
  );

  const fragments = await Promise.all(
    PERSPECTIVES.map(async (perspective) => {
      const { system, user } = buildSmePrompt({ domain: opts.domain, perspective, corpusText: corpus, web });
      const json = await callJson({
        system,
        user,
        model: opts.model,
        provider: opts.provider,
        userInfo: opts.userInfo,
        actionName: `ontology_sme_${perspective}`,
        maxTokens: 9000,
        temperature: 0.3,
        web,
      });
      opts.log(`[swarm] SME · ${perspective}: ${json ? 'brief fragment ready' : 'no output (skipped)'}`);
      return json;
    }),
  );

  return mergeBrief(fragments, web);
}

function mergeBrief(fragments: unknown[], web: boolean): BusinessBrief {
  const taken = new Set<string>();
  const personas: Persona[] = [];
  const useCases: UseCase[] = [];
  const expectedEntities: ExpectedEntity[] = [];
  const glossary: GlossaryTerm[] = [];
  const references: string[] = [];

  const seenUc = new Set<string>();
  const seenTerm = new Set<string>();
  const seenRef = new Set<string>();
  // Personas/expectedEntities are re-minted under fresh local ids, but the
  // model's useCases reference them by ITS raw ids (or by name). Track both
  // mappings so the useCase refs can be rewritten after the merge — otherwise
  // every personaIds/expectedEntityIds entry dangles and per-use-case
  // coverage silently computes against nothing.
  const personaByKey = new Map<string, string>(); // norm(name) -> minted id
  const personaByRawId = new Map<string, string>(); // model raw id -> minted id
  const expByKey = new Map<string, string>(); // kind::norm(name) -> minted id
  const expByName = new Map<string, string>(); // norm(name) -> minted id (first wins)
  const expByRawId = new Map<string, string>(); // model raw id -> minted id
  let summary: Bilingual = { en: '', zh: '' };

  for (const frag of fragments) {
    const f = asRecord(frag);

    if (!summary.en && !summary.zh) {
      const s = bilOpt(f.summary);
      if (s) summary = s;
    }

    for (const p of asArray(f.personas)) {
      const r = asRecord(p);
      const name = bil(r.name);
      if (!name.en && !name.zh) continue;
      const key = norm(name.en || name.zh);
      const rawId = str(r.id);
      const existing = personaByKey.get(key);
      if (existing) {
        if (rawId) personaByRawId.set(rawId, existing); // duplicate from another SME — remap its raw id too
        continue;
      }
      const goals = asArray(r.goals).map((g) => bil(g)).filter((g) => g.en || g.zh);
      const id = localId('persona', name.en || name.zh, taken);
      personaByKey.set(key, id);
      if (rawId) personaByRawId.set(rawId, id);
      personas.push({
        id,
        name,
        description: bilOpt(r.description),
        goals: goals.length > 0 ? goals : undefined,
      });
    }

    for (const u of asArray(f.useCases)) {
      const r = asRecord(u);
      const name = bil(r.name);
      if (!name.en && !name.zh) continue;
      const key = norm(name.en || name.zh);
      if (seenUc.has(key)) continue;
      seenUc.add(key);
      useCases.push({
        id: localId('uc', name.en || name.zh, taken),
        name,
        description: bilOpt(r.description),
        personaIds: asArray(r.personaIds).map((x) => str(x)).filter(Boolean),
        expectedEntityIds: asArray(r.expectedEntityIds).map((x) => str(x)).filter(Boolean),
      });
    }

    for (const e of asArray(f.expectedEntities)) {
      const r = asRecord(e);
      const name = bil(r.name);
      const kind = str(r.kind);
      if ((!name.en && !name.zh) || !KINDS.has(kind)) continue;
      const nameKey = norm(name.en || name.zh);
      const key = `${kind}::${nameKey}`;
      const rawId = str(r.id);
      const existing = expByKey.get(key);
      if (existing) {
        if (rawId) expByRawId.set(rawId, existing);
        continue;
      }
      const id = localId('exp', `${kind}-${name.en || name.zh}`, taken);
      expByKey.set(key, id);
      if (!expByName.has(nameKey)) expByName.set(nameKey, id);
      if (rawId) expByRawId.set(rawId, id);
      expectedEntities.push({
        id,
        kind: kind as EntityKind,
        name,
        description: bilOpt(r.description),
        found: false,
      });
    }

    for (const g of asArray(f.glossary)) {
      const r = asRecord(g);
      const term = bil(r.term);
      if (!term.en && !term.zh) continue;
      const key = norm(term.en || term.zh);
      if (seenTerm.has(key)) continue;
      seenTerm.add(key);
      glossary.push({ term, definition: bil(r.definition) });
    }

    for (const ref of asArray(f.references)) {
      const s = str(ref).trim();
      if (s && !seenRef.has(s)) {
        seenRef.add(s);
        references.push(s);
      }
    }
  }

  if (!summary.en && !summary.zh) {
    summary = {
      en: 'Business scenario derived from the provided corpus.',
      zh: '根据所提供语料推导的业务场景。',
    };
  }

  // Rewrite every useCase reference through the remaps (raw model id first,
  // then name match), dropping anything unresolved — AFTER the whole loop so
  // forward references across fragments resolve too.
  const uniq = (xs: string[]): string[] => [...new Set(xs)];
  for (const uc of useCases) {
    uc.personaIds = uniq(
      uc.personaIds
        .map((x) => personaByRawId.get(x) ?? personaByKey.get(norm(x)) ?? '')
        .filter(Boolean),
    );
    if (uc.expectedEntityIds) {
      uc.expectedEntityIds = uniq(
        uc.expectedEntityIds
          .map((x) => expByRawId.get(x) ?? expByName.get(norm(x)) ?? '')
          .filter(Boolean),
      );
    }
  }

  return { summary, personas, useCases, expectedEntities, glossary, webAugmented: web, references };
}

/**
 * Render the brief into a seed block appended to each extraction stage's system
 * prompt (assigned to `StageContext.briefSeed`) to raise recall in iteration 1.
 */
export function renderBriefSeed(brief: BusinessBrief): string {
  const uc = brief.useCases.slice(0, 30).map((u) => `- ${u.name.en}`).join('\n');
  const exp = brief.expectedEntities.slice(0, 80).map((e) => `- (${e.kind}) ${e.name.en}`).join('\n');
  return [
    'DOMAIN BRIEF (RECALL TARGET). Use it to find MORE real items that ARE supported by the document text.',
    'Do NOT invent items or fabricate citations: anything the document does not support must be omitted (it becomes a follow-up question, not a node).',
    'RECONCILE against this brief before you finish: every expectation below must either MAP to an item you extracted (with a verbatim citation) or be CONSCIOUSLY SKIPPED as unsupported by the documents. Skipping is fine — silently overlooking an expectation that the text DOES support is not. Re-check the document for each unmatched expectation before deciding it is unsupported.',
    `SCENARIO: ${brief.summary.en}`,
    'KEY USE CASES:',
    uc || '- (none provided)',
    'EXPECTED ITEMS TO LOOK FOR (reconcile every line):',
    exp || '- (none provided)',
  ].join('\n');
}

/** Render the iteration-2 deepening seed: brief + open gaps + reproduce-existing rule. */
export function renderDeepenSeed(brief: BusinessBrief, gapLines: string, existingLines: string): string {
  return [
    renderBriefSeed(brief),
    '',
    'DEEPENING PASS (iteration 2): you are REVIEWING an existing extraction to RAISE COVERAGE.',
    'Your output must be the UNION of two sets — both are mandatory:',
    '1. REPRODUCE: every item under ALREADY-FOUND ITEMS appears in your output EXACTLY as before — same id, same fields, byte-identical where possible. Never rename, alter, merge, or drop an existing item; an output missing any listed id is WRONG.',
    '2. ADD: for every OPEN GAP and every unmatched expectation above, re-search the document and add the missing item IF the text supports it (verbatim citation required). A gap the document cannot support is consciously skipped — do not fabricate to close it.',
    'Reuse existing ids verbatim for every cross-reference; mint new ids only for genuinely NEW items.',
    'OPEN GAPS TO CLOSE (re-search the document for each):',
    gapLines || '- (none)',
    'ALREADY-FOUND ITEMS (reproduce these exactly, then add the missing ones):',
    existingLines || '- (none)',
  ].join('\n');
}
