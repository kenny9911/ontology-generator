// ============================================================================
//  DATABASE INGESTION — deterministic constraint-rule seed
// ----------------------------------------------------------------------------
//  docs/DATABASE_INGESTION_DESIGN.md §2.4.
//
//  PURE + DETERMINISTIC (no LLM, no I/O). A database constraint IS a business
//  rule, so we map the structural ones straight onto the rules layer:
//
//    CHECK            -> Rule kind='validation', severity='block'  (field invariant)
//    multi-col UNIQUE -> Rule kind='constraint', severity='block'  (uniqueness invariant)
//    NOT NULL / PK / single-col UNIQUE -> stay structural on the property (NO rule),
//      to avoid a rule explosion of trivial constraints.
//
//  Each rule cites the VERBATIM constraint line from the schema evidence
//  document (textualize.ts) so it survives grounding, attaches to its table's
//  ObjectType, and fills every spec-format field deterministically (Chinese-first
//  statements, matching the spec projection's zh-first convention). The
//  orchestrator's applyRules re-grounds, re-scores and validates as usual.
//
//  HARD RULES (NodeNext / strict TS): relative imports carry `.js`; schema types
//  are TYPE-ONLY; `makeId` + the shared line renderers are the runtime imports.
// ============================================================================

import { makeId } from '../../_shared/ids.js';
import type { ObjectType, Rule, SourceRef } from '../../_shared/ontology-schema.js';
import type { DbModel, DbTable, DbCheck, DbUnique } from './types.js';
import { SCHEMA_DOC_ID, SCHEMA_DOC_NAME, checkLine, uniqueLine } from './textualize.js';
import { tableObjectId } from './seed-objects.js';

const SEED_CONFIDENCE = 0.95;

/** "objectType:public-orders" -> "Public_Orders" (spec-format object id for relatedEntities). */
function specObjectIdOf(id: string): string {
  const bare = id.replace(/^objectType:/, '');
  const words = bare.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('_') || bare;
}

function source(snippet: string): SourceRef {
  return { documentId: SCHEMA_DOC_ID, documentName: SCHEMA_DOC_NAME, snippet };
}

/**
 * Fill the spec-format + engine fields shared by every constraint rule. Mirrors
 * the deterministic defaults that stages/rules.ts#buildRule applies when the
 * model omits a field, so DB-seeded rules are shape-identical to extracted ones.
 */
function buildConstraintRule(args: {
  taken: Set<string>;
  ontologyId: string;
  obj: ObjectType;
  kind: 'validation' | 'constraint';
  titleEn: string;
  titleZh: string;
  statementEn: string;
  statementZh: string;
  formal: string;
  snippet: string;
  columns?: string[];
}): Rule {
  const { taken, ontologyId, obj, kind, titleEn, titleZh, statementEn, statementZh, formal, snippet, columns } = args;

  const id = makeId('rule', titleEn, taken);
  const objNameZh = obj.nameZh?.trim() || obj.name;
  const appliesToAttributes = (columns ?? [])
    .filter((c) => obj.properties.some((p) => p.name === c))
    .map((c) => `${obj.id}.${c}`);

  const rule: Rule = {
    id,
    uuid: `${id}#${ontologyId}`,
    // --- spec-format fields (Chinese-first, matching the spec projection) ---
    specificScenarioStage: kind === 'validation' ? '数据校验' : '业务约束',
    businessLogicRuleName: titleZh,
    applicableClient: '通用',
    applicableDepartment: 'N/A',
    submissionCriteria: '',
    standardizedLogicRule: statementZh,
    relatedEntities: [`${objNameZh} (${specObjectIdOf(obj.id)})`],
    businessBackgroundReason: '源自数据库约束，保证数据完整性与一致性。',
    ruleSource: SCHEMA_DOC_NAME,
    executor: 'Agent',
    enforcementLevel: 'mandatory',
    failurePolicy: 'block',
    // --- retained engine + bilingual structure ---
    title: titleEn,
    titleZh,
    statement: { en: statementEn, zh: statementZh },
    formal,
    kind,
    severity: 'block',
    appliesToObjectTypeIds: [obj.id],
    ...(appliesToAttributes.length > 0 ? { appliesToAttributes } : {}),
    sources: [source(snippet)],
    confidence: SEED_CONFIDENCE,
    provenance: 'extracted',
    reviewState: 'pending',
  };
  return rule;
}

function ruleForCheck(
  taken: Set<string>,
  ontologyId: string,
  obj: ObjectType,
  t: DbTable,
  chk: DbCheck,
): Rule {
  const cols = chk.columns && chk.columns.length > 0 ? chk.columns.join(', ') : '';
  const where = cols ? `字段 ${cols}` : '该记录';
  const whereEn = cols ? `column(s) ${cols}` : 'the record';
  return buildConstraintRule({
    taken,
    ontologyId,
    obj,
    kind: 'validation',
    titleEn: `Check on ${t.name}: ${chk.expression}`,
    titleZh: `${obj.nameZh?.trim() || obj.name} 校验：${chk.expression}`,
    statementEn: `In ${t.name}, ${whereEn} must satisfy: ${chk.expression}.`,
    statementZh: `${obj.nameZh?.trim() || obj.name} 中，${where} 必须满足约束：${chk.expression}。`,
    formal: chk.expression,
    snippet: checkLine(chk),
    columns: chk.columns,
  });
}

function ruleForUnique(
  taken: Set<string>,
  ontologyId: string,
  obj: ObjectType,
  t: DbTable,
  u: DbUnique,
): Rule {
  const cols = u.columns.join(', ');
  return buildConstraintRule({
    taken,
    ontologyId,
    obj,
    kind: 'constraint',
    titleEn: `Unique on ${t.name}: (${cols})`,
    titleZh: `${obj.nameZh?.trim() || obj.name} 唯一性约束：(${cols})`,
    statementEn: `In ${t.name}, the combination of (${cols}) must be unique.`,
    statementZh: `${obj.nameZh?.trim() || obj.name} 中，(${cols}) 的组合必须唯一。`,
    formal: `UNIQUE (${cols})`,
    snippet: uniqueLine(u),
    columns: u.columns,
  });
}

/**
 * Build the constraint-rule layer from a `DbModel`. `objects` is the already
 * seeded stage-1 layer (rules attach to those object ids by recomputing the
 * deterministic `tableObjectId`). Single-column UNIQUE constraints are skipped
 * (they stay structural on the property); only MULTI-column uniques become rules.
 */
export function seedRules(model: DbModel, objects: ObjectType[], taken: Set<string>, ontologyId: string): Rule[] {
  const objById = new Map(objects.map((o) => [o.id, o] as const));
  const rules: Rule[] = [];

  for (const t of model.tables) {
    const obj = objById.get(tableObjectId(t.schema, t.name));
    if (!obj) continue; // table without a seeded object (shouldn't happen) — skip gracefully
    for (const chk of t.checks) rules.push(ruleForCheck(taken, ontologyId, obj, t, chk));
    for (const u of t.uniques) {
      if (u.columns.length < 2) continue; // single-column unique stays structural
      rules.push(ruleForUnique(taken, ontologyId, obj, t, u));
    }
  }

  return rules;
}
