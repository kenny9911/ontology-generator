// One-off: make all spec-format DESCRIPTIVE fields Chinese-first across fixtures.
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'fixtures', 'ontology-golden');

const specObjId = (id) => {
  const bare = (id || '').replace(/^objectType:/, '');
  const w = bare.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return w.map((x) => x[0].toUpperCase() + x.slice(1)).join('_') || bare;
};
const evtSpec = (id) => (id || '').replace(/^event:/, '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
const humanize = (s) => (s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const zh = (a, b) => (typeof a === 'string' && a.trim() ? a.trim() : typeof b === 'string' ? b.trim() : '');
const hasCJK = (s) => typeof s === 'string' && /[一-鿿]/.test(s);
/** Keep a single-language value only if it is Chinese; else use the zh fallback. */
const cjkOr = (s, fallback) => (hasCJK(s) ? s.trim() : fallback);
const KIND_ZH = { validation: '数据校验', constraint: '业务约束', derivation: '指标推导', state_transition: '状态流转', authorization: '权限授权', temporal: '时限控制' };
const ACTOR_ZH = { human: '人工操作员', system: '系统', agent: '智能体' };

const files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.json')).sort();
for (const file of files) {
  const p = path.join(DIR, file);
  const o = JSON.parse(await fs.readFile(p, 'utf8'));
  const objById = new Map((o.objects ?? []).map((x) => [x.id, x]));
  const nameZh = (id) => objById.get(id)?.nameZh || objById.get(id)?.name || specObjId(id);
  const ruleById = new Map((o.rules ?? []).map((r) => [r.id, r]));
  const actionById = new Map((o.actions ?? []).map((a) => [a.id, a]));
  const relById = o.relationships ?? [];

  // ---- objects ----
  for (const ob of o.objects ?? []) {
    ob.description = zh(ob.descriptionZh, ob.description);
    const parts = [];
    for (const rel of relById) {
      const verb = rel.nameZh || zh(undefined, rel.description) || humanize(rel.name) || '关联';
      if (rel.sourceObjectTypeId === ob.id && objById.has(rel.targetObjectTypeId)) parts.push(`【${ob.nameZh || ob.name}】${verb}【${nameZh(rel.targetObjectTypeId)}】。`);
      else if (rel.targetObjectTypeId === ob.id && objById.has(rel.sourceObjectTypeId)) parts.push(`【${nameZh(rel.sourceObjectTypeId)}】${verb}【${ob.nameZh || ob.name}】。`);
    }
    for (const pr of ob.properties ?? []) {
      if (pr.is_foreign_key && pr.references && [...objById.values()].some((x) => specObjId(x.id) === pr.references)) {
        const tgt = [...objById.values()].find((x) => specObjId(x.id) === pr.references);
        parts.push(`【${ob.nameZh || ob.name}】通过 ${pr.name} 引用【${tgt?.nameZh || pr.references}】。`);
      }
    }
    ob.relationship_description = parts.length ? [...new Set(parts)].join('') : `【${ob.nameZh || ob.name}】暂无与其他对象的关联关系。`;
    for (const pr of ob.properties ?? []) {
      pr.description = (pr.descriptionZh && pr.descriptionZh.trim()) || cjkOr(pr.description, pr.nameZh || humanize(pr.name));
    }
  }

  // ---- rules ----
  for (const r of o.rules ?? []) {
    r.specificScenarioStage = cjkOr(r.trigger?.description, KIND_ZH[r.kind] || '业务约束');
    r.businessLogicRuleName = zh(r.titleZh, r.title) || r.id.replace(/^rule:/, '');
    r.standardizedLogicRule = zh(r.statement?.zh, r.statement?.en) || zh(undefined, r.formal);
    r.submissionCriteria = cjkOr(r.trigger?.description, cjkOr(r.expression?.predicate, ''));
    r.relatedEntities = (r.appliesToObjectTypeIds ?? []).filter((id) => objById.has(id)).map((id) => `${nameZh(id)} (${specObjId(id)})`);
  }

  // ---- actions ----
  for (const a of o.actions ?? []) {
    a.description = zh(a.descriptionZh, a.description);
    a.category = a.nameZh || humanize(a.name);
    const lines = []; let n = 1;
    for (const eid of a.triggeredByEventIds ?? []) lines.push(`${n++}. 事件 ${evtSpec(eid)} 已送达`);
    for (const pc of a.preconditions ?? []) { const r = ruleById.get(pc.ruleId); if (r) lines.push(`${n++}. 规则「${zh(r.titleZh, r.title) || pc.ruleId}」已满足`); }
    a.submission_criteria = lines.join('\n');
    a.action_steps = (a.steps ?? []).map((s) => {
      const out = { order: String(s.order), name: (a.action_steps?.find((x) => x.order === String(s.order))?.name) || `step${s.order}`, description: zh(s.text?.zh, s.text?.en), object_type: 'logic', submission_criteria: '' };
      if (s.guardRuleId && ruleById.has(s.guardRuleId)) {
        const r = ruleById.get(s.guardRuleId);
        out.submission_criteria = cjkOr(r.trigger?.description, '');
        out.rules = [{ id: r.id.replace(/^rule:/, ''), name: zh(r.titleZh, r.title) || '', submission_criteria: cjkOr(r.trigger?.description, ''), description: zh(r.statement?.zh, r.statement?.en) || zh(undefined, r.formal) }];
      }
      return out;
    });
    const actorKind = a.actorRef?.kind;
    a.system_prompt = `作为负责「${a.name}」动作的自动化${ACTOR_ZH[actorKind] || '智能体'}，${a.description} 请从本体读取所需对象，校验所有前置条件，并按顺序执行各步骤。`;
    const inNames = (a.inputs ?? []).map((i) => i.name).join('、') || '所提供的输入';
    const outNames = (a.outputs ?? []).map((i) => i.name).join('、') || '相应记录';
    a.user_prompt = `根据输入（${inNames}）执行「${a.name}」。${a.description} 产出（${outNames}）并发出相应事件。`;
    if (typeof a.typescript_code !== 'string') a.typescript_code = '';
  }

  // ---- events ----
  for (const e of o.events ?? []) e.description = zh(e.descriptionZh, e.description);

  // ---- workflows (processes) ----
  for (const proc of o.processes ?? []) {
    proc.actions = (proc.actions ?? []).map((step, i) => {
      const sId = proc.steps?.[i]?.actionTypeId;
      const a = sId ? actionById.get(sId) : undefined;
      return { ...step, description: a ? zh(a.descriptionZh, a.description) : step.description };
    });
    proc.description = cjkOr(proc.description, proc.name?.zh || '');
  }

  await fs.writeFile(p, JSON.stringify(o, null, 2) + '\n', 'utf8');
  console.log(`zh-migrated ${file}`);
}
