// ============================================================================
//  INFERENCE — multi-hop graph-reasoning engine (design §3.2).
//
//  The engine owns the graph; the LLM owns the reasoning. One seed call picks
//  entry nodes, then an expansion loop hands the agent batches of frontier-
//  adjacent triples; the agent selects evidence (a hop), and either expands
//  the frontier or answers. Every accepted hop is recorded as an
//  `InferenceHop`, so the final answer is auditable end-to-end.
//
//  Failure doctrine: NEVER throw. Unparseable replies get ONE corrective
//  retry; a failed seed degrades to lexical seeding, a failed step degrades
//  to one auto-expansion then a forced-answer call, and a failed forced
//  answer degrades to the graceful bilingual "no answer" result.
// ============================================================================

import type {
  Bilingual,
  InferenceHop,
  InferenceResult,
  Ontology,
  Triple,
} from '../../_shared/ontology-schema.js';
import { executeLLMWithTracking } from '../llm.js';
import type { ChatMessage, ExecuteLLMOptions, UserInfo } from '../llm.js';
import { extractJson } from '../pipeline/swarm/llm-json.js';
import { ontologyToTriples, tripleLabelMap } from './triples.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface InferenceInput {
  ontology: Ontology;
  question: string;
  model: string;
  provider: string;
  userInfo: UserInfo | null;
  log?: (s: string) => void;
  /** Expansion-loop LLM calls (default 4; total LLM calls ≤ 1 + this + 1 forced). */
  maxIterations?: number;
  /** Accepted reasoning hops before the engine forces an answer (default 6). */
  maxHops?: number;
}

const DEFAULT_MAX_ITERATIONS = 4;
const DEFAULT_MAX_HOPS = 6;
const NODE_INDEX_CAP = 400;
const TRIPLES_PER_ITERATION_CAP = 150;
const LEXICAL_SEED_TOP = 8;
const AUTO_FRONTIER_TOP = 12;

const NO_ANSWER: Bilingual = {
  en: 'No answer could be derived from the ontology graph.',
  zh: '无法从本体图谱中推导出答案。',
};

/** Run one multi-hop inference over the ontology graph. Never throws. */
export async function runInference(input: InferenceInput): Promise<InferenceResult> {
  const started = Date.now();
  const log = input.log ?? (() => undefined);
  try {
    return await runInferenceInner(input, log, started);
  } catch (err) {
    // Hard safety net — every expected failure already degrades inside.
    log(`inference: unexpected failure — ${err instanceof Error ? err.message : String(err)}`);
    return {
      question: input.question,
      answer: NO_ANSWER,
      hops: [],
      pathNodeIds: [],
      tripleCount: 0,
      usedTripleCount: 0,
      iterations: 0,
      durationMs: Date.now() - started,
    };
  }
}

// ---------------------------------------------------------------------------
// Graph structures (deterministic — built once per run)
// ---------------------------------------------------------------------------

interface NodeIndexEntry {
  id: string;
  kind: string;
  label: string;
}

interface Graph {
  triples: Triple[];
  /** nodeId → triples touching it (s always; o only for non-literal triples). */
  adjacency: Map<string, Triple[]>;
  labels: Record<string, string>;
  /** All addressable ids: nodes, attribute pseudo-ids, adjacency endpoints. */
  knownIds: Set<string>;
  /** One entry per first-class node, in layer order (for the seed call). */
  nodeIndex: NodeIndexEntry[];
}

function tripleKey(t: Triple): string {
  return `${t.s}\u0001${t.p}\u0001${t.o}`;
}

function buildGraph(ontology: Ontology): Graph {
  const triples = ontologyToTriples(ontology);
  const labels = tripleLabelMap(ontology);

  const adjacency = new Map<string, Triple[]>();
  const push = (id: string, t: Triple): void => {
    const list = adjacency.get(id);
    if (list) list.push(t);
    else adjacency.set(id, [t]);
  };
  for (const t of triples) {
    push(t.s, t);
    if (!t.literal && t.o !== t.s) push(t.o, t);
  }

  const knownIds = new Set<string>(Object.keys(labels));
  for (const id of adjacency.keys()) knownIds.add(id);

  const nodeIndex: NodeIndexEntry[] = [];
  const addNodes = (ids: { id: string }[], kind: string): void => {
    for (const n of ids) nodeIndex.push({ id: n.id, kind, label: labels[n.id] ?? n.id });
  };
  addNodes(ontology.objects, 'object');
  addNodes(ontology.relationships, 'relationship');
  addNodes(ontology.rules, 'rule');
  addNodes(ontology.actions, 'action');
  addNodes(ontology.events, 'event');
  addNodes(ontology.processes, 'process');

  return { triples, adjacency, labels, knownIds, nodeIndex };
}

// ---------------------------------------------------------------------------
// Defensive JSON coercion (the agent's replies are untrusted)
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = asString(item);
    if (s) out.push(s);
  }
  return out;
}

function asIndexArray(v: unknown, max: number): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const item of v) {
    const n = typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN;
    if (Number.isInteger(n) && n >= 0 && n < max && !out.includes(n)) out.push(n);
  }
  return out;
}

function coerceIds(v: unknown, knownIds: Set<string>): string[] {
  const out: string[] = [];
  for (const id of asStringArray(v)) {
    if (knownIds.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function coerceAnswer(v: unknown): Bilingual | null {
  const plain = asString(v);
  if (plain) return { en: plain, zh: plain };
  const rec = asRecord(v);
  if (!rec) return null;
  const en = asString(rec.en);
  const zh = asString(rec.zh);
  const either = en ?? zh;
  if (!either) return null;
  return { en: en ?? either, zh: zh ?? either };
}

function coerceHop(v: unknown, batch: Triple[], step: number): InferenceHop | null {
  const rec = asRecord(v);
  if (!rec) return null;
  const idxs = asIndexArray(rec.tripleIdxs, batch.length);
  const inference = asString(rec.inference);
  if (idxs.length === 0 && !inference) return null;
  return {
    step,
    triples: idxs.map((i) => batch[i]),
    inference: inference ?? '(no inference text provided)',
  };
}

// ---------------------------------------------------------------------------
// LLM round-trip — one corrective retry, parse via extractJson, never throw
// ---------------------------------------------------------------------------

interface CallArgs {
  system: string;
  user: string;
  actionName: 'ontology_infer_seed' | 'ontology_infer_step';
  input: InferenceInput;
  log: (s: string) => void;
}

async function callOnce(args: CallArgs, messages: ChatMessage[]): Promise<string | null> {
  try {
    return await executeLLMWithTracking({
      model: args.input.model,
      provider: args.input.provider as ExecuteLLMOptions['provider'],
      messages,
      temperature: 0.1,
      maxTokens: 4000,
      module: 'ontology_generator',
      actionName: args.actionName,
      userInfo: args.input.userInfo,
    });
  } catch (err) {
    args.log(
      `inference: ${args.actionName} call failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** One tracked call + ONE corrective retry on unparseable output. */
async function callJsonWithRetry(args: CallArgs): Promise<Record<string, unknown> | null> {
  const messages: ChatMessage[] = [
    { role: 'system', content: args.system },
    { role: 'user', content: args.user },
  ];
  const raw = await callOnce(args, messages);
  if (raw === null) return null;
  const parsed = asRecord(extractJson(raw));
  if (parsed) return parsed;

  args.log(`inference: ${args.actionName} reply unparseable — issuing one JSON-only retry`);
  const retryRaw = await callOnce(args, [
    ...messages,
    { role: 'assistant', content: raw },
    {
      role: 'user',
      content:
        'Your previous reply was not parseable as JSON. Output ONLY the JSON object of the OUTPUT CONTRACT now — no prose, no code fences.',
    },
  ]);
  if (retryRaw === null) return null;
  return asRecord(extractJson(retryRaw));
}

// ---------------------------------------------------------------------------
// Seed call + lexical fallback
// ---------------------------------------------------------------------------

const SEED_SYSTEM_PROMPT = `You are a graph-reasoning agent answering business questions over an enterprise ontology knowledge graph.
The graph's nodes are domain objects, relationships, business rules, actions, events, and processes, connected by typed triples (consumes, produces, emits, triggered_by, precedes, applies_to, ...).
Your task in THIS call: choose the seed nodes a multi-hop walk should start from — the entities the question names, plus the entities the answer most likely lives on. You will see the triples around your seeds in later calls, so favor coverage of the question's entities over guessing the answer.

OUTPUT CONTRACT — reply with ONLY this JSON object, no prose, no code fences:
{ "seedIds": ["<node id>", "..."], "reasoning": "<one sentence on why these seeds>" }

Rules:
- Use node ids EXACTLY as written in the index (they are case-sensitive).
- Pick 1 to 6 seeds. Never invent ids.
- Sweep the WHOLE index before deciding; entities are listed by layer (objects, relationships, rules, actions, events, processes) and the relevant one may be near the end.`;

function buildSeedUser(question: string, graph: Graph): string {
  const total = graph.nodeIndex.length;
  const shown = graph.nodeIndex.slice(0, NODE_INDEX_CAP);
  const lines = shown.map((n) => `${n.id} | ${n.kind} | ${n.label}`);
  const capNote =
    total > NODE_INDEX_CAP
      ? `\n(index capped: showing the first ${NODE_INDEX_CAP} of ${total} nodes)`
      : '';
  return `QUESTION: ${question}\n\nNODE INDEX (id | kind | label), ${total} nodes:${capNote}\n${lines.join('\n')}\n\nReply with the OUTPUT CONTRACT JSON only.`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((w) => w.length >= 2);
}

/** Deterministic fallback: nodes whose label/id shares a word with the question. */
function lexicalSeeds(question: string, graph: Graph): string[] {
  const qTokens = new Set(tokenize(question));
  const qLower = question.toLowerCase();
  const scored = graph.nodeIndex
    .map((n) => {
      const nTokens = tokenize(`${n.label} ${n.id}`);
      let score = 0;
      for (const t of nTokens) if (qTokens.has(t)) score += 1;
      if (n.label && qLower.includes(n.label.toLowerCase())) score += 2;
      return { id: n.id, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, LEXICAL_SEED_TOP)
    .map((s) => s.id);
  if (scored.length > 0) return scored;
  // Last resort so the walk always has somewhere to stand.
  return graph.nodeIndex.slice(0, LEXICAL_SEED_TOP).map((n) => n.id);
}

async function seedFrontier(input: InferenceInput, graph: Graph, log: (s: string) => void): Promise<string[]> {
  const reply = await callJsonWithRetry({
    system: SEED_SYSTEM_PROMPT,
    user: buildSeedUser(input.question, graph),
    actionName: 'ontology_infer_seed',
    input,
    log,
  });
  if (reply) {
    const seeds = coerceIds(reply.seedIds, graph.knownIds);
    if (seeds.length > 0) {
      log(`inference: seeds [${seeds.join(', ')}]`);
      return seeds;
    }
    log('inference: seed reply had no known ids — falling back to lexical match');
  } else {
    log('inference: seed call failed — falling back to lexical match');
  }
  const lexical = lexicalSeeds(input.question, graph);
  log(`inference: lexical seeds [${lexical.join(', ')}]`);
  return lexical;
}

// ---------------------------------------------------------------------------
// Expansion loop
// ---------------------------------------------------------------------------

const STEP_SYSTEM_PROMPT = `You are a graph-reasoning agent walking an enterprise ontology knowledge graph to answer a business question, one hop at a time.
Each round the engine hands you NEW numbered triples adjacent to your current frontier. Triples marked [lit] are literal facts (labels, kinds, datatypes, severities); the rest are graph edges you can walk. You select the triples that advance the reasoning chain, state the conclusion they support, then either EXPAND the frontier or ANSWER.

OUTPUT CONTRACT — reply with ONLY this JSON object, no prose, no code fences:
{
  "action": "expand" | "answer",
  "hop": { "tripleIdxs": [<indices into THIS round's numbered triples>], "inference": "<the conclusion these triples prove>" },
  "expandToIds": ["<node ids to pull triples for next round>"],
  "answer": { "en": "<answer in English>", "zh": "<同一答案的中文>" },
  "pathNodeIds": ["<ordered node ids tracing the full reasoning path>"]
}

Rules:
- "hop" refers ONLY to this round's numbered triples; include it whenever any triple was informative, with the indices you actually used.
- On "expand": "expandToIds" is required — the frontier nodes whose neighborhoods you need next. On "answer": "answer" (both languages) and "pathNodeIds" are required.
- An answer is only complete when the full chain from the question's entities to the answer is spelled out hop by hop — prefer "expand" until that chain is complete. Typical questions need 3 or more hops; do not answer from the first batch unless the chain is already closed.
- Chain MULTI-HOP reasoning: each hop's inference must connect to the previous hops, building one continuous path from question to answer.
- Never invent node ids; use only ids that appeared in triples shown to you.
- The final answer must state the conclusion AND the chain that supports it, in BOTH English and Chinese.
- Be honest: if the graph genuinely lacks the fact, answer that it cannot be derived — do not fabricate.`;

function fmtId(id: string, labels: Record<string, string>): string {
  const label = labels[id];
  return label && label !== id ? `${id} ("${label}")` : id;
}

function fmtTriple(i: number, t: Triple, labels: Record<string, string>): string {
  if (t.literal) return `${i}. ${fmtId(t.s, labels)} --${t.p}--> "${t.o}" [lit]`;
  return `${i}. ${fmtId(t.s, labels)} --${t.p}--> ${fmtId(t.o, labels)}`;
}

function fmtHops(hops: InferenceHop[]): string {
  if (hops.length === 0) return '(none yet)';
  return hops
    .map((h) => `Hop ${h.step} (${h.triples.length} triples): ${h.inference}`)
    .join('\n');
}

/**
 * Gather the next batch: all unsent triples adjacent to the frontier,
 * prioritizing non-literal edges, then label/kind literals of the nodes those
 * edges introduce, then remaining literals — capped per iteration.
 */
function gatherBatch(graph: Graph, frontier: string[], sentKeys: Set<string>): Triple[] {
  const seen = new Set<string>();
  const nonLiteral: Triple[] = [];
  const frontierLiterals: Triple[] = [];

  const take = (t: Triple): boolean => {
    const k = tripleKey(t);
    if (sentKeys.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  };

  for (const id of frontier) {
    for (const t of graph.adjacency.get(id) ?? []) {
      if (!take(t)) continue;
      if (t.literal) frontierLiterals.push(t);
      else nonLiteral.push(t);
    }
  }

  // label/kind literals of the nodes the new edges introduce.
  const newNodeLiterals: Triple[] = [];
  const frontierSet = new Set(frontier);
  for (const t of nonLiteral) {
    for (const endpoint of [t.s, t.o]) {
      if (frontierSet.has(endpoint)) continue;
      for (const adj of graph.adjacency.get(endpoint) ?? []) {
        if (adj.literal && (adj.p === 'label' || adj.p === 'kind') && adj.s === endpoint && take(adj)) {
          newNodeLiterals.push(adj);
        }
      }
    }
  }

  return [...nonLiteral, ...newNodeLiterals, ...frontierLiterals].slice(0, TRIPLES_PER_ITERATION_CAP);
}

function buildStepUser(question: string, hops: InferenceHop[], batch: Triple[], round: number, labels: Record<string, string>): string {
  const lines = batch.map((t, i) => fmtTriple(i, t, labels));
  return `QUESTION: ${question}

REASONING SO FAR:
${fmtHops(hops)}

NEW TRIPLES (round ${round}, ${batch.length} triples, numbered 0..${batch.length - 1}):
${lines.join('\n')}

Decide: "expand" (chain incomplete — record this round's hop and name the next frontier) or "answer" (the full chain from question to answer is closed). Reply with the OUTPUT CONTRACT JSON only.`;
}

/** Ordered unique endpoints of a triple list (s, then o for edges). */
function endpointsOf(triples: Triple[]): string[] {
  const out: string[] = [];
  for (const t of triples) {
    if (!out.includes(t.s)) out.push(t.s);
    if (!t.literal && !out.includes(t.o)) out.push(t.o);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function runInferenceInner(
  input: InferenceInput,
  log: (s: string) => void,
  started: number,
): Promise<InferenceResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxHops = input.maxHops ?? DEFAULT_MAX_HOPS;
  const graph = buildGraph(input.ontology);
  log(`inference: graph built — ${graph.triples.length} triples, ${graph.nodeIndex.length} nodes`);

  let frontier = await seedFrontier(input, graph, log);

  const sentKeys = new Set<string>();
  const hops: InferenceHop[] = [];
  let answer: Bilingual | null = null;
  let pathNodeIds: string[] = [];
  let iterations = 0;
  let autoFrontierUsed = false;

  for (let round = 1; round <= maxIterations && answer === null; round++) {
    if (hops.length >= maxHops) {
      log(`inference: hop budget (${maxHops}) reached — forcing answer`);
      break;
    }
    const batch = gatherBatch(graph, frontier, sentKeys);
    if (batch.length === 0) {
      log('inference: frontier exhausted (no unsent adjacent triples) — forcing answer');
      break;
    }
    for (const t of batch) sentKeys.add(tripleKey(t));

    iterations++;
    const reply = await callJsonWithRetry({
      system: STEP_SYSTEM_PROMPT,
      user: buildStepUser(input.question, hops, batch, round, graph.labels),
      actionName: 'ontology_infer_step',
      input,
      log,
    });

    if (reply === null) {
      if (!autoFrontierUsed) {
        autoFrontierUsed = true;
        frontier = endpointsOf(batch.slice(0, AUTO_FRONTIER_TOP));
        log('inference: step reply unusable — auto-expanding frontier once');
        continue;
      }
      log('inference: step reply unusable again — forcing answer');
      break;
    }

    const hop = coerceHop(reply.hop, batch, hops.length + 1);
    if (hop) {
      hops.push(hop);
      log(`inference: hop ${hop.step} — ${hop.triples.length} triples — ${hop.inference}`);
    }

    const action = asString(reply.action);
    // 'answer' is authoritative; a missing/invalid action with a usable answer
    // also counts (an explicit 'expand' keeps walking even if a draft answer
    // tagged along).
    if (action === 'answer' || (action !== 'expand' && coerceAnswer(reply.answer) !== null)) {
      answer = coerceAnswer(reply.answer);
      pathNodeIds = coerceIds(reply.pathNodeIds, graph.knownIds);
      if (answer === null) {
        log('inference: "answer" action carried no usable answer — forcing answer');
        break;
      }
      log('inference: agent answered');
    } else {
      let next = coerceIds(reply.expandToIds, graph.knownIds);
      if (next.length === 0 && hop) {
        next = endpointsOf(hop.triples).filter((id) => graph.knownIds.has(id));
      }
      if (next.length === 0) next = endpointsOf(batch.slice(0, AUTO_FRONTIER_TOP));
      frontier = next;
      log(`inference: expanding to [${frontier.slice(0, 8).join(', ')}${frontier.length > 8 ? ', ...' : ''}]`);
    }
  }

  // Forced answer — the agent never said "answer" (or said it without one).
  if (answer === null) {
    iterations++;
    const reply = await callJsonWithRetry({
      system: STEP_SYSTEM_PROMPT,
      user: `QUESTION: ${input.question}

REASONING SO FAR:
${fmtHops(hops)}

You must answer NOW with the evidence gathered — no more expansion rounds are available. Reply with the OUTPUT CONTRACT JSON only, using "action": "answer" with the bilingual "answer" and "pathNodeIds". If the gathered evidence is genuinely insufficient, say so honestly in both languages.`,
      actionName: 'ontology_infer_step',
      input,
      log,
    });
    if (reply) {
      answer = coerceAnswer(reply.answer);
      if (pathNodeIds.length === 0) pathNodeIds = coerceIds(reply.pathNodeIds, graph.knownIds);
    }
    log(answer ? 'inference: forced answer produced' : 'inference: forced answer failed — degrading to no-answer');
  }

  if (pathNodeIds.length === 0) {
    pathNodeIds = endpointsOf(hops.flatMap((h) => h.triples)).filter((id) => graph.knownIds.has(id));
  }

  const usedKeys = new Set<string>();
  for (const h of hops) for (const t of h.triples) usedKeys.add(tripleKey(t));

  return {
    question: input.question,
    answer: answer ?? NO_ANSWER,
    hops,
    pathNodeIds,
    tripleCount: graph.triples.length,
    usedTripleCount: usedKeys.size,
    iterations,
    durationMs: Date.now() - started,
  };
}
