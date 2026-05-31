// api/_shared/ids.ts
//
// Deterministic, kind-prefixed id helper for the Ontology Generator.
//
// Every ontology node carries a human-readable, git-diffable `id` that is a
// lowercase, kind-prefixed slug (charset `[a-z0-9.-]`). Cross-references are by
// `id`. IDs are generated ONCE via makeId() and are immutable thereafter; a
// "merge" remaps references, it never regenerates ids. Determinism makes
// re-runs and Neo4j MERGE idempotent.
//
// LOCKED prefixes (see SCHEMA.md §"IDs"):
//   object       -> "objectType:"   e.g. objectType:order
//   relationship -> "rel:"          e.g. rel:customer-places-order
//   rule         -> "rule:"         e.g. rule:fulfill-after-payment
//   ruleGroup    -> "ruleGroup:"    e.g. ruleGroup:credit-hold
//   action       -> "action:"       e.g. action:fulfill-order
//   event        -> "event:"        e.g. event:order.fulfilled  (dotted suffix)
//   process      -> "process:"      e.g. process:order-to-cash
//   document     -> "doc:"          e.g. doc:order-fulfillment-sop
//   ontology     -> "ontology:"     e.g. ontology:acme-retail-o2c
//   instance     -> "inst:"         e.g. inst:order
//
// Pure module: no project imports.

/** The kinds of nodes that receive a deterministic id. */
export type Kind =
  | 'object'
  | 'relationship'
  | 'rule'
  | 'ruleGroup'
  | 'action'
  | 'event'
  | 'process'
  | 'document'
  | 'ontology'
  | 'instance';

const PREFIXES: Record<Kind, string> = {
  object: 'objectType:',
  relationship: 'rel:',
  rule: 'rule:',
  ruleGroup: 'ruleGroup:',
  action: 'action:',
  event: 'event:',
  process: 'process:',
  document: 'doc:',
  ontology: 'ontology:',
  instance: 'inst:',
};

/**
 * Slugify a name to the LOCKED charset `[a-z0-9.-]`.
 *
 * - Lowercased.
 * - Any run of disallowed characters (incl. whitespace) collapses to a single `-`.
 * - Dots are PRESERVED (events use a dotted suffix, e.g. `order.fulfilled`).
 * - Leading/trailing `-` and `.` are trimmed.
 * - Empty result falls back to `"x"` so an id is always non-empty.
 */
function slugify(name: string): string {
  const slug = (name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    // strip combining diacritical marks left by NFKD
    .replace(/[̀-ͯ]/g, '')
    // collapse any run of disallowed chars to a single hyphen
    .replace(/[^a-z0-9.-]+/g, '-')
    // collapse repeated separators
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    // trim leading/trailing separators
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  return slug.length > 0 ? slug : 'x';
}

/**
 * Produce a deterministic, kind-prefixed, deduped id and record it in `taken`.
 *
 * On collision the base slug gets a numeric suffix `-2`, `-3`, ... The chosen id
 * is added to `taken` so subsequent calls dedupe against it.
 *
 * @param kind  one of the LOCKED node kinds
 * @param name  human-readable name (or dotted event name) to slugify
 * @param taken set of ids already in use (mutated: the new id is inserted)
 * @returns the newly minted, unique id
 */
export function makeId(kind: Kind, name: string, taken: Set<string>): string {
  const prefix = PREFIXES[kind];
  const base = `${prefix}${slugify(name)}`;

  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  let n = 2;
  let candidate = `${base}-${n}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  taken.add(candidate);
  return candidate;
}

/*
 * --- Unit self-test (run manually) ---------------------------------------
 * Compile + run with: npx tsx api/_shared/ids.ts  (or paste into a scratch test)
 *
 *   const t = new Set<string>();
 *   console.assert(makeId('object', 'Order', t) === 'objectType:order');
 *   console.assert(makeId('object', 'Order', t) === 'objectType:order-2');   // collision
 *   console.assert(makeId('object', 'Order', t) === 'objectType:order-3');   // collision
 *   console.assert(makeId('relationship', 'Customer places Order', t) === 'rel:customer-places-order');
 *   console.assert(makeId('rule', 'Fulfill after payment', t) === 'rule:fulfill-after-payment');
 *   console.assert(makeId('ruleGroup', 'Credit Hold', t) === 'ruleGroup:credit-hold');
 *   console.assert(makeId('action', 'Fulfill Order', t) === 'action:fulfill-order');
 *   console.assert(makeId('event', 'order.fulfilled', t) === 'event:order.fulfilled');   // dotted preserved
 *   console.assert(makeId('event', 'Order Fulfilled', t) === 'event:order-fulfilled');   // spaces -> hyphen
 *   console.assert(makeId('process', 'Order to Cash', t) === 'process:order-to-cash');
 *   console.assert(makeId('document', 'Order Fulfillment SOP.docx', t) === 'doc:order-fulfillment-sop.docx');
 *   console.assert(makeId('ontology', 'Acme Retail O2C', t) === 'ontology:acme-retail-o2c');
 *   console.assert(makeId('instance', 'Order', t) === 'inst:order');
 *   console.assert(makeId('object', '  !!!  ', t) === 'objectType:x');        // empty-slug fallback
 *   console.assert(t.has('objectType:order'));                                // taken populated
 *   console.log('ids.ts self-test OK');
 * --------------------------------------------------------------------------
 */
