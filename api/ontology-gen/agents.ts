// ============================================================================
//  HYPER-AUTOMATION — LLM agent registry.
//
//  The literal-const registry of every LLM-calling agent in the system
//  (design §2.1). Each entry is a frontend-visible `AgentDef`: a stable id,
//  bilingual label/description, the agent's `purpose` (which drives the smart
//  router's strength-tier choice in llm-router.ts), and the pipeline `group`
//  it belongs to. Deepen/remediation reuse the five stage extractors, so they
//  route through those agent ids automatically.
// ============================================================================

import type { AgentDef } from '../_shared/ontology-schema.js';

export const AGENT_REGISTRY: readonly AgentDef[] = [
  // --- fast (the classic 5-stage pipeline) ---------------------------------
  {
    id: 'objects_extractor',
    label: { en: 'Objects extractor', zh: '对象提取' },
    description: {
      en: 'Extracts business object types and their attributes from the source documents (stage 1).',
      zh: '从源文档中识别并提取业务对象类型及其属性（第一阶段）。',
    },
    purpose: 'extraction',
    group: 'fast',
  },
  {
    id: 'rules_extractor',
    label: { en: 'Rules extractor', zh: '规则提取' },
    description: {
      en: 'Extracts business rules, constraints and validation conditions from the source documents (stage 2).',
      zh: '从源文档中提取业务规则、约束与校验条件（第二阶段）。',
    },
    purpose: 'extraction',
    group: 'fast',
  },
  {
    id: 'actions_extractor',
    label: { en: 'Actions extractor', zh: '动作提取' },
    description: {
      en: 'Extracts business actions with their inputs, outputs and performing roles (stage 3).',
      zh: '从源文档中提取业务动作及其输入、输出与执行角色（第三阶段）。',
    },
    purpose: 'extraction',
    group: 'fast',
  },
  {
    id: 'events_enricher',
    label: { en: 'Events enricher', zh: '事件补全' },
    description: {
      en: 'Co-discovers and enriches business events, linking them to the actions that emit or consume them (stage 4).',
      zh: '识别并补全业务事件，并将其与产生或消费这些事件的动作关联起来（第四阶段）。',
    },
    purpose: 'enrichment',
    group: 'fast',
  },
  {
    id: 'processes_extractor',
    label: { en: 'Processes extractor', zh: '流程提取' },
    description: {
      en: 'Extracts end-to-end business processes with their steps and triggers (stage 5).',
      zh: '从源文档中提取端到端业务流程及其步骤与触发条件（第五阶段）。',
    },
    purpose: 'extraction',
    group: 'fast',
  },
  {
    id: 'stage_critic',
    label: { en: 'Stage critic', zh: '阶段评审' },
    description: {
      en: 'Reviews each completed stage and writes a non-mutating critique of gaps and quality issues.',
      zh: '对每个已完成阶段进行评审，指出遗漏与质量问题，不修改提取结果。',
    },
    purpose: 'review',
    group: 'fast',
  },

  // --- shared (used by several pipelines) ----------------------------------
  {
    id: 'title_generator',
    label: { en: 'Title generator', zh: '标题生成' },
    description: {
      en: 'Generates a concise bilingual title for the ontology from its content.',
      zh: '根据本体内容生成简洁的中英文标题。',
    },
    purpose: 'classification',
    group: 'shared',
  },

  // --- swarm (deep-swarm mode) ----------------------------------------------
  {
    id: 'sme_swarm',
    label: { en: 'SME swarm', zh: '领域专家群' },
    description: {
      en: 'A swarm of subject-matter-expert agents that builds the business understanding brief, optionally using web search.',
      zh: '由多位领域专家智能体并行构建业务理解简报，可结合网络搜索补充行业知识。',
    },
    purpose: 'reasoning',
    group: 'swarm',
  },
  {
    id: 'ba_reviewer',
    label: { en: 'BA reviewer', zh: '业务分析评审' },
    description: {
      en: 'Reviews the extracted ontology against the business brief and flags coverage gaps.',
      zh: '对照业务理解简报评审提取结果，标记覆盖缺口。',
    },
    purpose: 'review',
    group: 'swarm',
  },
  {
    id: 'link_synthesizer',
    label: { en: 'Link synthesizer', zh: '关联合成' },
    description: {
      en: 'Synthesizes cross-layer links between objects, rules, actions, events and processes.',
      zh: '在对象、规则、动作、事件与流程之间补全跨层关联关系。',
    },
    purpose: 'synthesis',
    group: 'swarm',
  },
  {
    id: 'question_generator',
    label: { en: 'Question generator', zh: '追问生成' },
    description: {
      en: 'Generates follow-up questions for the user where the documents leave the ontology ambiguous or incomplete.',
      zh: '针对文档中含糊或缺失之处，生成需要用户确认的后续问题。',
    },
    purpose: 'synthesis',
    group: 'swarm',
  },

  // --- hyper (hyper-automation mode) ----------------------------------------
  {
    id: 'terminology_extractor',
    label: { en: 'Terminology extractor', zh: '术语提取' },
    description: {
      en: 'Scans every document for business terms, data types, enum sets, abbreviations and roles, with citations.',
      zh: '扫描全部文档，识别业务术语、数据类型、枚举值、缩写与角色，并附带原文出处。',
    },
    purpose: 'extraction',
    group: 'hyper',
  },
  {
    id: 'coverage_evaluator',
    label: { en: 'Coverage evaluator', zh: '覆盖率评估' },
    description: {
      en: 'Judges, sentence by sentence, whether every meaningful statement in the documents is represented in the ontology.',
      zh: '逐句评估文档中的每条有效信息是否已体现在本体中。',
    },
    purpose: 'review',
    group: 'hyper',
  },

  // --- inference -------------------------------------------------------------
  {
    id: 'inference_agent',
    label: { en: 'Inference agent', zh: '推理智能体' },
    description: {
      en: 'Answers multi-hop questions by reasoning over the ontology graph triples.',
      zh: '基于本体图谱三元组进行多跳推理并回答问题。',
    },
    purpose: 'inference',
    group: 'inference',
  },
];

const BY_ID: ReadonlyMap<string, AgentDef> = new Map(AGENT_REGISTRY.map((a) => [a.id, a]));

export function getAgentDef(id: string): AgentDef | undefined {
  return BY_ID.get(id);
}

export function isKnownAgent(id: string): boolean {
  return BY_ID.has(id);
}
