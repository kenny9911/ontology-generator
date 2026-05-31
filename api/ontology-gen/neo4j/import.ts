/**
 * ============================================================================
 *  ONTOLOGY GENERATOR — NEO4J IMPORTER (idempotent JSON → Cypher projection)
 * ============================================================================
 *
 *  Projects one canonical `Ontology` JSON document into the optional, env-gated
 *  Neo4j runtime graph. The JSON is ALWAYS the source of truth; Neo4j is a
 *  derived mirror. This module is the only writer of that mirror on the publish
 *  path.
 *
 *  HARD CONTRACT (SCHEMA.md §5, DESIGN_SPEC endpoint contracts):
 *  - Returns `{ mirrored: false }` and NEVER throws/500 when the driver is null
 *    (env absent) or unhealthy. No request path hard-depends on Neo4j.
 *  - Idempotent: every write is a `MERGE` keyed by the composite node id
 *    `"{ontologyId}@{version}#{id}"`, scoped by `(ontologyId, ontologyVersion)`,
 *    batched via `UNWIND`. Re-running on an unchanged ontology is a no-op delta
 *    (stable node/relationship counts).
 *  - LOCKED pass order:
 *      Sources → ObjectTypes → Attributes/Relationships → EventTypes → Rules →
 *      ActionTypes → Processes/Steps → Citations.
 *    EventTypes MERGE before ActionTypes so action↔event MATCHes resolve.
 *  - Writes BOTH event directions: TRIGGERED_BY/CONSUMES (from
 *    `Action.triggeredByEventIds`) and EMITS/PRODUCED_BY (from
 *    `Action.emitsEvents`); the inverse is derived here so the two can't disagree.
 *  - No APOC on the default path (one labeled `CITES` pass per node kind).
 * ============================================================================
 */

import type {
  ActionType,
  EventType,
  ObjectAttribute,
  ObjectType,
  Ontology,
  Process,
  Relationship,
  Rule,
  SourceRef,
} from '../../_shared/ontology-schema.js';
import { getDriver, neo4jHealthy } from './driver.js';

/** Result of an import attempt. `mirrored:false` = JSON-only (graceful). */
export interface ImportResult {
  mirrored: boolean;
  nodes?: number;
  rels?: number;
  error?: string;
}

/** Batch size for UNWIND payloads — keeps single transactions bounded. */
const BATCH = 500;

/** Composite, Community-safe node key: "{ontologyId}@{version}#{id}". */
function nodeKey(ontologyId: string, version: number, id: string): string {
  return `${ontologyId}@${version}#${id}`;
}

/** Attribute node id per SCHEMA.md §5: "<objId>#<attrName>". */
function attrId(objId: string, attrName: string): string {
  return `${objId}#${attrName}`;
}

/** Chunk an array into batches of at most `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length <= size) {
    return arr.length === 0 ? [] : [arr];
  }
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** A single UNWIND-MERGE unit of work: a cypher statement + its row batch. */
interface Op {
  cypher: string;
  rows: Record<string, unknown>[];
  /** 'node' rows create/merge nodes, 'rel' rows create/merge relationships. */
  kind: 'node' | 'rel';
}

/**
 * Project an `Ontology` into Neo4j. Graceful: returns `{ mirrored: false }`
 * (never throws) when Neo4j is disabled or unreachable; otherwise runs the
 * LOCKED idempotent pass order and returns the count of MERGEd nodes/rels.
 */
export async function importOntology(o: Ontology): Promise<ImportResult> {
  const driver = getDriver();
  if (!driver) {
    return { mirrored: false };
  }

  // verifyConnectivity catches ALL errors → false; never throws.
  const healthy = await neo4jHealthy();
  if (!healthy) {
    return { mirrored: false };
  }

  const ontologyId = o.id;
  const version = o.version;

  let session: ReturnType<typeof driver.session> | null = null;
  try {
    const nodeOps = buildNodeOps(o, ontologyId, version);
    const relOps = buildRelOps(o, ontologyId, version);

    session = driver.session();

    let nodes = 0;
    let rels = 0;

    // Nodes first (in LOCKED label order), then relationships — so every
    // MATCH on either endpoint resolves. Each op runs as its own auto-commit
    // transaction of a single batched UNWIND ... MERGE.
    for (const op of nodeOps) {
      if (op.rows.length === 0) continue;
      for (const batch of chunk(op.rows, BATCH)) {
        await session.run(op.cypher, { rows: batch });
        nodes += batch.length;
      }
    }
    for (const op of relOps) {
      if (op.rows.length === 0) continue;
      for (const batch of chunk(op.rows, BATCH)) {
        await session.run(op.cypher, { rows: batch });
        rels += batch.length;
      }
    }

    return { mirrored: true, nodes, rels };
  } catch (err) {
    // Graceful: a write/connection failure mid-import must NOT 500 the caller.
    return { mirrored: false, error: errMessage(err) };
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        // teardown must never throw
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  NODE PASSES — LOCKED order:
//  Sources → ObjectTypes → Attributes → EventTypes → Rules → ActionTypes →
//  Processes → WorkflowSteps.  (EventTypes before ActionTypes so action↔event
//  MATCHes resolve in the relationship passes.)
// ---------------------------------------------------------------------------

function buildNodeOps(o: Ontology, ontologyId: string, version: number): Op[] {
  const ops: Op[] = [];

  // --- :Source ---
  ops.push({
    kind: 'node',
    cypher:
      'UNWIND $rows AS r ' +
      'MERGE (n:Source { key: r.key }) ' +
      'SET n.ontologyId = r.ontologyId, n.ontologyVersion = r.ontologyVersion, ' +
      'n.id = r.id, n.name = r.name, n.kind = r.kind',
    rows: o.sourceDocuments.map((s) => ({
      key: nodeKey(ontologyId, version, s.id),
      ontologyId,
      ontologyVersion: version,
      id: s.id,
      name: s.name,
      kind: s.kind,
    })),
  });

  // --- :ObjectType ---
  ops.push({
    kind: 'node',
    cypher:
      'UNWIND $rows AS r ' +
      'MERGE (n:ObjectType { key: r.key }) ' +
      'SET n.ontologyId = r.ontologyId, n.ontologyVersion = r.ontologyVersion, ' +
      'n.id = r.id, n.name = r.name, n.nameZh = r.nameZh, n.confidence = r.confidence, ' +
      'n.descriptionEn = r.descriptionEn, n.descriptionZh = r.descriptionZh',
    rows: o.objects.map((obj: ObjectType) => ({
      key: nodeKey(ontologyId, version, obj.id),
      ontologyId,
      ontologyVersion: version,
      id: obj.id,
      name: obj.name,
      nameZh: obj.nameZh,
      confidence: obj.confidence,
      descriptionEn: obj.description ?? null,
      descriptionZh: obj.descriptionZh ?? null,
    })),
  });

  // --- :Attribute (id = "<objId>#<name>") ---
  const attrRows: Record<string, unknown>[] = [];
  for (const obj of o.objects) {
    for (const a of obj.attributes ?? ([] as ObjectAttribute[])) {
      const id = attrId(obj.id, a.name);
      attrRows.push({
        key: nodeKey(ontologyId, version, id),
        ontologyId,
        ontologyVersion: version,
        id,
        name: a.name,
        type: a.type,
        required: a.required,
        keyRole: a.keyRole,
        // Neo4j has no nested maps on properties; store enum values as a string[].
        enumValues: a.enumValues ?? null,
      });
    }
  }
  ops.push({
    kind: 'node',
    cypher:
      'UNWIND $rows AS r ' +
      'MERGE (n:Attribute { key: r.key }) ' +
      'SET n.ontologyId = r.ontologyId, n.ontologyVersion = r.ontologyVersion, ' +
      'n.id = r.id, n.name = r.name, n.type = r.type, n.required = r.required, ' +
      'n.keyRole = r.keyRole, n.enumValues = r.enumValues',
    rows: attrRows,
  });

  // --- :EventType (before ActionType) ---
  ops.push({
    kind: 'node',
    cypher:
      'UNWIND $rows AS r ' +
      'MERGE (n:EventType { key: r.key }) ' +
      'SET n.ontologyId = r.ontologyId, n.ontologyVersion = r.ontologyVersion, ' +
      'n.id = r.id, n.name = r.name, n.nameZh = r.nameZh, n.confidence = r.confidence',
    rows: o.events.map((e: EventType) => ({
      key: nodeKey(ontologyId, version, e.id),
      ontologyId,
      ontologyVersion: version,
      id: e.id,
      name: e.name,
      nameZh: e.nameZh,
      confidence: e.confidence,
    })),
  });

  // --- :Rule ---
  ops.push({
    kind: 'node',
    cypher:
      'UNWIND $rows AS r ' +
      'MERGE (n:Rule { key: r.key }) ' +
      'SET n.ontologyId = r.ontologyId, n.ontologyVersion = r.ontologyVersion, ' +
      'n.id = r.id, n.statementEn = r.statementEn, n.statementZh = r.statementZh, ' +
      'n.formal = r.formal, n.kind = r.kind, n.severity = r.severity, ' +
      'n.trigger = r.trigger, n.confidence = r.confidence',
    rows: o.rules.map((rule: Rule) => ({
      key: nodeKey(ontologyId, version, rule.id),
      ontologyId,
      ontologyVersion: version,
      id: rule.id,
      statementEn: rule.statement.en,
      statementZh: rule.statement.zh,
      formal: rule.formal,
      kind: rule.kind,
      severity: rule.severity,
      trigger: rule.trigger?.description ?? null,
      confidence: rule.confidence,
    })),
  });

  // --- :ActionType ---
  ops.push({
    kind: 'node',
    cypher:
      'UNWIND $rows AS r ' +
      'MERGE (n:ActionType { key: r.key }) ' +
      'SET n.ontologyId = r.ontologyId, n.ontologyVersion = r.ontologyVersion, ' +
      'n.id = r.id, n.name = r.name, n.nameZh = r.nameZh, n.toolName = r.toolName, ' +
      'n.actor = r.actor, n.confidence = r.confidence',
    rows: o.actions.map((act: ActionType) => ({
      key: nodeKey(ontologyId, version, act.id),
      ontologyId,
      ontologyVersion: version,
      id: act.id,
      name: act.name,
      nameZh: act.nameZh ?? null,
      toolName: act.agent?.toolName ?? null,
      actor: act.actor?.role ?? null,
      confidence: act.confidence,
    })),
  });

  // --- :Process ---
  ops.push({
    kind: 'node',
    cypher:
      'UNWIND $rows AS r ' +
      'MERGE (n:Process { key: r.key }) ' +
      'SET n.ontologyId = r.ontologyId, n.ontologyVersion = r.ontologyVersion, ' +
      'n.id = r.id, n.nameEn = r.nameEn, n.nameZh = r.nameZh',
    rows: o.processes.map((p: Process) => ({
      key: nodeKey(ontologyId, version, p.id),
      ontologyId,
      ontologyVersion: version,
      id: p.id,
      nameEn: p.name.en,
      nameZh: p.name.zh,
    })),
  });

  // --- :WorkflowStep (process-scoped id; key embeds process id) ---
  const stepRows: Record<string, unknown>[] = [];
  for (const p of o.processes) {
    for (const step of p.steps ?? []) {
      // Step ids are only unique within their process; scope by process id.
      const scopedId = `${p.id}/${step.id}`;
      stepRows.push({
        key: nodeKey(ontologyId, version, scopedId),
        ontologyId,
        ontologyVersion: version,
        id: scopedId,
        order: step.order,
      });
    }
  }
  ops.push({
    kind: 'node',
    cypher:
      'UNWIND $rows AS r ' +
      'MERGE (n:WorkflowStep { key: r.key }) ' +
      'SET n.ontologyId = r.ontologyId, n.ontologyVersion = r.ontologyVersion, ' +
      'n.id = r.id, n.order = r.order',
    rows: stepRows,
  });

  return ops;
}

// ---------------------------------------------------------------------------
//  RELATIONSHIP PASSES — every endpoint already MERGEd as a node above, so all
//  MATCHes resolve. Each op MATCHes both endpoints by composite `key` then
//  MERGEs the typed relationship (idempotent).
// ---------------------------------------------------------------------------

function buildRelOps(o: Ontology, ontologyId: string, version: number): Op[] {
  const ops: Op[] = [];
  const key = (id: string) => nodeKey(ontologyId, version, id);

  // --- HAS_ATTRIBUTE: ObjectType → Attribute ---
  const hasAttr: Record<string, unknown>[] = [];
  for (const obj of o.objects) {
    for (const a of obj.attributes ?? []) {
      hasAttr.push({ from: key(obj.id), to: key(attrId(obj.id, a.name)) });
    }
  }
  ops.push(
    relOp(
      hasAttr,
      'MATCH (a:ObjectType { key: r.from }) MATCH (b:Attribute { key: r.to }) ' +
        'MERGE (a)-[:HAS_ATTRIBUTE]->(b)',
    ),
  );

  // --- RELATES_TO {label,cardinality,relId}: ObjectType → ObjectType ---
  ops.push(
    relOp(
      o.relationships.map((rel: Relationship) => ({
        from: key(rel.sourceObjectTypeId),
        to: key(rel.targetObjectTypeId),
        relId: rel.id,
        label: rel.label?.en ?? rel.name,
        cardinality: rel.cardinality,
      })),
      'MATCH (a:ObjectType { key: r.from }) MATCH (b:ObjectType { key: r.to }) ' +
        'MERGE (a)-[x:RELATES_TO { relId: r.relId }]->(b) ' +
        'SET x.label = r.label, x.cardinality = r.cardinality',
    ),
  );

  // --- APPLIES_TO: Rule → ObjectType ---
  const appliesTo: Record<string, unknown>[] = [];
  for (const rule of o.rules) {
    for (const objId of rule.appliesToObjectTypeIds ?? []) {
      appliesTo.push({ from: key(rule.id), to: key(objId) });
    }
  }
  ops.push(
    relOp(
      appliesTo,
      'MATCH (a:Rule { key: r.from }) MATCH (b:ObjectType { key: r.to }) ' +
        'MERGE (a)-[:APPLIES_TO]->(b)',
    ),
  );

  // --- HAS_INPUT / HAS_OUTPUT {name,cardinality}: ActionType → ObjectType ---
  const hasInput: Record<string, unknown>[] = [];
  const hasOutput: Record<string, unknown>[] = [];
  for (const act of o.actions) {
    for (const io of act.inputs ?? []) {
      if (!io.objectTypeId) continue; // scalar IO has no ObjectType node
      hasInput.push({
        from: key(act.id),
        to: key(io.objectTypeId),
        name: io.name,
        cardinality: io.cardinality ?? null,
      });
    }
    for (const io of act.outputs ?? []) {
      if (!io.objectTypeId) continue;
      hasOutput.push({
        from: key(act.id),
        to: key(io.objectTypeId),
        name: io.name,
        cardinality: io.cardinality ?? null,
      });
    }
  }
  ops.push(
    relOp(
      hasInput,
      'MATCH (a:ActionType { key: r.from }) MATCH (b:ObjectType { key: r.to }) ' +
        'MERGE (a)-[x:HAS_INPUT { name: r.name }]->(b) SET x.cardinality = r.cardinality',
    ),
  );
  ops.push(
    relOp(
      hasOutput,
      'MATCH (a:ActionType { key: r.from }) MATCH (b:ObjectType { key: r.to }) ' +
        'MERGE (a)-[x:HAS_OUTPUT { name: r.name }]->(b) SET x.cardinality = r.cardinality',
    ),
  );

  // --- PRECONDITION: ActionType → Rule ---
  const precond: Record<string, unknown>[] = [];
  for (const act of o.actions) {
    for (const pre of act.preconditions ?? []) {
      precond.push({ from: key(act.id), to: key(pre.ruleId) });
    }
  }
  ops.push(
    relOp(
      precond,
      'MATCH (a:ActionType { key: r.from }) MATCH (b:Rule { key: r.to }) ' +
        'MERGE (a)-[:PRECONDITION]->(b)',
    ),
  );

  // --- TRIGGERED_BY / CONSUMES (Action.triggeredByEventIds + inverse) ---
  // Action TRIGGERED_BY Event ; Event CONSUMES Action (inverse, derived here
  // so they can never disagree).
  const triggeredBy: Record<string, unknown>[] = [];
  const consumes: Record<string, unknown>[] = [];
  for (const act of o.actions) {
    for (const evId of act.triggeredByEventIds ?? []) {
      triggeredBy.push({ from: key(act.id), to: key(evId) });
      consumes.push({ from: key(evId), to: key(act.id) });
    }
  }
  ops.push(
    relOp(
      triggeredBy,
      'MATCH (a:ActionType { key: r.from }) MATCH (b:EventType { key: r.to }) ' +
        'MERGE (a)-[:TRIGGERED_BY]->(b)',
    ),
  );
  ops.push(
    relOp(
      consumes,
      'MATCH (a:EventType { key: r.from }) MATCH (b:ActionType { key: r.to }) ' +
        'MERGE (a)-[:CONSUMES]->(b)',
    ),
  );

  // --- EMITS / PRODUCED_BY (Action.emitsEvents + inverse) ---
  // Action EMITS Event ; Event PRODUCED_BY Action (inverse).
  const emits: Record<string, unknown>[] = [];
  const producedBy: Record<string, unknown>[] = [];
  for (const act of o.actions) {
    for (const em of act.emitsEvents ?? []) {
      emits.push({ from: key(act.id), to: key(em.eventTypeId), on: em.on });
      producedBy.push({ from: key(em.eventTypeId), to: key(act.id), on: em.on });
    }
  }
  ops.push(
    relOp(
      emits,
      'MATCH (a:ActionType { key: r.from }) MATCH (b:EventType { key: r.to }) ' +
        'MERGE (a)-[x:EMITS]->(b) SET x.on = r.on',
    ),
  );
  ops.push(
    relOp(
      producedBy,
      'MATCH (a:EventType { key: r.from }) MATCH (b:ActionType { key: r.to }) ' +
        'MERGE (a)-[x:PRODUCED_BY]->(b) SET x.on = r.on',
    ),
  );

  // --- STEP_OF {order}: WorkflowStep → Process ---
  // --- NEXT {processId,viaEventId?,condition?}: WorkflowStep → WorkflowStep ---
  // --- INVOLVES: Process → ObjectType ---
  const stepOf: Record<string, unknown>[] = [];
  const next: Record<string, unknown>[] = [];
  const involves: Record<string, unknown>[] = [];
  for (const p of o.processes) {
    for (const objId of p.objectTypeIds ?? []) {
      involves.push({ from: key(p.id), to: key(objId) });
    }
    for (const step of p.steps ?? []) {
      const fromScoped = `${p.id}/${step.id}`;
      stepOf.push({ from: key(fromScoped), to: key(p.id), order: step.order });
      for (const edge of step.next ?? []) {
        const toScoped = `${p.id}/${edge.toStepId}`;
        next.push({
          from: key(fromScoped),
          to: key(toScoped),
          processId: p.id,
          viaEventId: edge.onEventTypeId ?? null,
          condition: edge.condition ?? null,
        });
      }
    }
  }
  ops.push(
    relOp(
      stepOf,
      'MATCH (a:WorkflowStep { key: r.from }) MATCH (b:Process { key: r.to }) ' +
        'MERGE (a)-[x:STEP_OF]->(b) SET x.order = r.order',
    ),
  );
  ops.push(
    relOp(
      next,
      'MATCH (a:WorkflowStep { key: r.from }) MATCH (b:WorkflowStep { key: r.to }) ' +
        'MERGE (a)-[x:NEXT { processId: r.processId, toKey: r.to }]->(b) ' +
        'SET x.viaEventId = r.viaEventId, x.condition = r.condition',
    ),
  );
  ops.push(
    relOp(
      involves,
      'MATCH (a:Process { key: r.from }) MATCH (b:ObjectType { key: r.to }) ' +
        'MERGE (a)-[:INVOLVES]->(b)',
    ),
  );

  // --- CITES {page,snippet,charStart,charEnd}: (any node) → Source ---
  // One labeled pass per node kind (no APOC). The citation rel is keyed by the
  // (documentId, snippet) pair so re-runs are idempotent deltas.
  ops.push(citeOp(citeRows(o.objects, ontologyId, version), 'ObjectType'));
  ops.push(citeOp(citeRows(o.relationships, ontologyId, version), 'Relationship_SKIP'));
  ops.push(citeOp(citeRows(o.rules, ontologyId, version), 'Rule'));
  ops.push(citeOp(citeRows(o.actions, ontologyId, version), 'ActionType'));
  ops.push(citeOp(citeRows(o.events, ontologyId, version), 'EventType'));
  ops.push(citeOp(citeRows(o.processes, ontologyId, version), 'Process'));

  return ops.filter((op) => op.rows.length > 0);
}

/** A node that carries the universal `id` + `sources[]` provenance fields. */
interface Cited {
  id: string;
  sources: SourceRef[];
}

/** Flatten a node array's citations into CITES relationship rows. */
function citeRows(
  nodes: Cited[],
  ontologyId: string,
  version: number,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const n of nodes) {
    for (const s of n.sources ?? []) {
      rows.push({
        from: nodeKey(ontologyId, version, n.id),
        to: nodeKey(ontologyId, version, s.documentId),
        documentId: s.documentId,
        snippet: s.snippet,
        page: s.page ?? null,
        charStart: s.charStart ?? null,
        charEnd: s.charEnd ?? null,
      });
    }
  }
  return rows;
}

/**
 * Build a CITES op for a specific source-node label. `Relationship` has no
 * node label of its own in the LOCKED schema (edges are projected as
 * `RELATES_TO` relationships, not nodes), so its citations are skipped.
 */
function citeOp(rows: Record<string, unknown>[], fromLabel: string): Op {
  if (fromLabel === 'Relationship_SKIP') {
    return { kind: 'rel', cypher: '', rows: [] };
  }
  return {
    kind: 'rel',
    cypher:
      'UNWIND $rows AS r ' +
      `MATCH (a:${fromLabel} { key: r.from }) MATCH (b:Source { key: r.to }) ` +
      'MERGE (a)-[x:CITES { snippet: r.snippet }]->(b) ' +
      'SET x.page = r.page, x.charStart = r.charStart, x.charEnd = r.charEnd',
    rows,
  };
}

/** Helper to construct a relationship op from rows + a MATCH/MERGE body. */
function relOp(rows: Record<string, unknown>[], body: string): Op {
  return { kind: 'rel', cypher: `UNWIND $rows AS r ${body}`, rows };
}

/** Extract a stable string message from an unknown thrown value. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}
