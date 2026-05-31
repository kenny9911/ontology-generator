/**
 * ============================================================================
 *  ONTOLOGY GENERATOR — AGENT CODE GENERATOR (target: "agent-code")
 * ============================================================================
 *
 *  Pure, DETERMINISTIC projection of an `Ontology` into compilable TypeScript
 *  agent scaffolding. NO LLM, NO I/O, NO randomness — same ontology in, byte-
 *  identical bundle out. Reads ONLY the `Ontology` JSON; adds NO information
 *  that is not present in it (DESIGN_SPEC §3.7, SCHEMA.md §11).
 *
 *  Mapping (DESIGN_SPEC §3.7 "agent-code.ts"):
 *    - ObjectType  -> a TS `interface` (DataType -> TS type map below).
 *    - ActionType  -> one `async` function stub named after `agent.toolName`,
 *                     params typed from `inputs`, a typed result from `outputs`,
 *                     `preconditions` emitted as guarded `assert…` calls
 *                     (rule EN statement as comment, `formal` in a // FORMAL:
 *                     comment), `emitsEvents` + `sideEffects` listed in a
 *                     `// TODO: implement` body, JSDoc citing `sources[0]`.
 *    - Process     -> one runtime orchestrator function walking `steps` in
 *                     `order`, branching on `ProcessEdge.condition` /
 *                     `onEventTypeId`, wrapping guarded steps in asserts.
 *    - tools/index.ts -> a `{ toolName -> fn }` registry exporting all tools.
 *
 *  HARD RULES for THIS file:
 *  --------------------------------------------------------------------------
 *  - Strict NodeNext TS: the only project import is the backend schema mirror,
 *    via the '../_shared/ontology-schema.js' specifier (`.js` suffix required).
 *  - The GENERATED code is emitted as strings; it is NOT compiled here. It is
 *    written to be valid, self-contained TypeScript on its own.
 * ============================================================================
 */

import type {
  Ontology,
  ObjectType,
  ObjectAttribute,
  ActionType,
  ActionIO,
  Process,
  WorkflowStep,
  Rule,
  DataType,
  GeneratedBundle,
  GeneratedFile,
} from '../../_shared/ontology-schema.js';

// ---------------------------------------------------------------------------
// Small deterministic string helpers (no project deps).
// ---------------------------------------------------------------------------

/** Convert an arbitrary token to a safe PascalCase TS identifier. */
function toPascalCase(input: string): string {
  const parts = input
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'Unnamed';
  const pascal = parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
  return /^[A-Za-z_]/.test(pascal) ? pascal : `_${pascal}`;
}

/** Convert an arbitrary token to a safe snake_case TS identifier. */
function toSnakeCase(input: string): string {
  const snake = input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!snake) return 'unnamed';
  return /^[A-Za-z_]/.test(snake) ? snake : `_${snake}`;
}

/** Safe camelCase identifier for params / locals. */
function toCamelCase(input: string): string {
  const pascal = toPascalCase(input);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Escape a string so it sits safely inside a single-line `// comment`. */
function commentSafe(text: string | undefined): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim();
}

/** Escape a string for a single-quoted TS string literal. */
function strLit(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ')}'`;
}

// ---------------------------------------------------------------------------
// DataType -> TS type mapping (DESIGN_SPEC §3.7).
// ---------------------------------------------------------------------------

/**
 * Map a scalar {@link DataType} to a TS type literal. `enum` is resolved by the
 * caller (it needs `enumValues`); `reference` is resolved by the caller (needs
 * the referenced ObjectType's interface name). Both fall back to `string`.
 */
function scalarDataTypeToTs(type: DataType): string {
  switch (type) {
    case 'money':
    case 'decimal':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'uuid':
    case 'string':
    case 'date':
    case 'datetime':
      return 'string';
    case 'json':
      return 'unknown';
    case 'array':
      return 'unknown[]';
    case 'enum':
      // Resolved by caller when enumValues are present.
      return 'string';
    case 'reference':
      // Resolved by caller when refObjectTypeId is present.
      return 'string';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Index builders — resolve cross-references by id deterministically.
// ---------------------------------------------------------------------------

interface CodeIndex {
  objectInterfaceById: Map<string, string>;
  objectById: Map<string, ObjectType>;
  ruleById: Map<string, Rule>;
  actionById: Map<string, ActionType>;
  toolNameByActionId: Map<string, string>;
  fnNameByProcessId: Map<string, string>;
}

function buildIndex(o: Ontology, warnings: string[]): CodeIndex {
  const objectInterfaceById = new Map<string, string>();
  const objectById = new Map<string, ObjectType>();
  const usedInterfaceNames = new Set<string>();
  for (const obj of o.objects) {
    objectById.set(obj.id, obj);
    let name = toPascalCase(obj.name || obj.id.replace(/^objectType:/, ''));
    // De-duplicate interface names deterministically.
    if (usedInterfaceNames.has(name)) {
      let n = 2;
      while (usedInterfaceNames.has(`${name}${n}`)) n += 1;
      name = `${name}${n}`;
    }
    usedInterfaceNames.add(name);
    objectInterfaceById.set(obj.id, name);
  }

  const ruleById = new Map<string, Rule>();
  for (const r of o.rules) ruleById.set(r.id, r);

  const actionById = new Map<string, ActionType>();
  const toolNameByActionId = new Map<string, string>();
  const usedToolNames = new Set<string>();
  for (const a of o.actions) {
    actionById.set(a.id, a);
    let tool = toSnakeCase(a.agent?.toolName || a.name || a.id.replace(/^action:/, ''));
    if (usedToolNames.has(tool)) {
      let n = 2;
      while (usedToolNames.has(`${tool}_${n}`)) n += 1;
      tool = `${tool}_${n}`;
      warnings.push(`Duplicate tool name for action ${a.id}; renamed to ${tool}.`);
    }
    usedToolNames.add(tool);
    toolNameByActionId.set(a.id, tool);
  }

  const fnNameByProcessId = new Map<string, string>();
  const usedFnNames = new Set<string>();
  for (const p of o.processes) {
    const base = toSnakeCase(p.name?.en || p.id.replace(/^process:/, ''));
    let fn = `run_${base}`;
    if (usedFnNames.has(fn)) {
      let n = 2;
      while (usedFnNames.has(`${fn}_${n}`)) n += 1;
      fn = `${fn}_${n}`;
    }
    usedFnNames.add(fn);
    fnNameByProcessId.set(p.id, fn);
  }

  return { objectInterfaceById, objectById, ruleById, actionById, toolNameByActionId, fnNameByProcessId };
}

/** Resolve a single attribute's TS type, honoring enum/reference/array. */
function attributeTsType(attr: ObjectAttribute, idx: CodeIndex): string {
  // Reference / FK -> referenced interface (or its id literal if missing).
  if (attr.type === 'reference' || attr.keyRole === 'fk') {
    if (attr.refObjectTypeId) {
      const iface = idx.objectInterfaceById.get(attr.refObjectTypeId);
      if (iface) return iface;
    }
    return 'string';
  }
  if (attr.type === 'enum') {
    if (attr.enumValues && attr.enumValues.length > 0) {
      return attr.enumValues.map((v: string) => strLit(v)).join(' | ');
    }
    return 'string';
  }
  return scalarDataTypeToTs(attr.type);
}

// ---------------------------------------------------------------------------
// types.ts — one interface per ObjectType.
// ---------------------------------------------------------------------------

function generateTypesFile(o: Ontology, idx: CodeIndex): GeneratedFile {
  const lines: string[] = [];
  lines.push('// AUTO-GENERATED from ontology ' + o.id + ' v' + o.version + ' — do not edit by hand.');
  lines.push('// Domain object types projected from the ontology schema.');
  lines.push('');

  if (o.objects.length === 0) {
    lines.push('// (No object types were extracted for this ontology.)');
    lines.push('export {};');
  }

  for (const obj of o.objects) {
    const iface = idx.objectInterfaceById.get(obj.id) as string;
    const desc = commentSafe(obj.description);
    lines.push('/**');
    lines.push(` * ${iface}${obj.nameZh ? ` (${commentSafe(obj.nameZh)})` : ''}`);
    if (desc) lines.push(` * ${desc}`);
    lines.push(` * @ontologyId ${obj.id}`);
    lines.push(' */');
    lines.push(`export interface ${iface} {`);
    if (obj.attributes.length === 0) {
      lines.push('  [key: string]: unknown;');
    }
    for (const attr of obj.attributes) {
      const tsType = attributeTsType(attr, idx);
      const optional = attr.required ? '' : '?';
      const propName = toSnakeCase(attr.name);
      const tags: string[] = [];
      if (attr.keyRole && attr.keyRole !== 'none') tags.push(attr.keyRole.toUpperCase());
      if (attr.type === 'reference' && attr.refObjectTypeId) tags.push(`-> ${attr.refObjectTypeId}`);
      const inline = tags.length ? ` // ${tags.join(' ')}` : '';
      const attrDesc = commentSafe(attr.description);
      if (attrDesc) lines.push(`  /** ${attrDesc} */`);
      lines.push(`  ${propName}${optional}: ${tsType};${inline}`);
    }
    lines.push('}');
    lines.push('');
  }

  return { path: 'src/agents/types.ts', language: 'typescript', content: lines.join('\n').replace(/\n+$/, '\n') };
}

// ---------------------------------------------------------------------------
// Per-action tool stub.
// ---------------------------------------------------------------------------

/** Resolve an ActionIO's TS type (object interface, scalar, or array thereof). */
function actionIoTsType(io: ActionIO, idx: CodeIndex): string {
  let base: string;
  if (io.objectTypeId) {
    base = idx.objectInterfaceById.get(io.objectTypeId) ?? 'unknown';
  } else if (io.type) {
    base = scalarDataTypeToTs(io.type);
  } else {
    base = 'unknown';
  }
  const isArray = io.isArray === true || io.cardinality === 'many';
  if (isArray && !base.endsWith('[]')) base = `${base}[]`;
  return base;
}

/** Compute the set of object interface names an action references. */
function actionImportedInterfaces(action: ActionType, idx: CodeIndex): Set<string> {
  const set = new Set<string>();
  const collect = (io: ActionIO) => {
    if (io.objectTypeId) {
      const iface = idx.objectInterfaceById.get(io.objectTypeId);
      if (iface) set.add(iface);
    }
  };
  action.inputs.forEach(collect);
  action.outputs.forEach(collect);
  return set;
}

function generateToolFile(action: ActionType, idx: CodeIndex, warnings: string[]): GeneratedFile {
  const toolName = idx.toolNameByActionId.get(action.id) as string;
  const lines: string[] = [];

  // Imports (object interfaces used by inputs/outputs + assert helper).
  const ifaces = Array.from(actionImportedInterfaces(action, idx)).sort();
  lines.push('// AUTO-GENERATED tool stub — do not edit by hand.');
  if (ifaces.length > 0) {
    lines.push(`import type { ${ifaces.join(', ')} } from '../types.js';`);
  }
  lines.push(`import { assertPrecondition } from '../runtime.js';`);
  lines.push('');

  // Params interface from inputs.
  const ParamsName = `${toPascalCase(toolName)}Input`;
  lines.push(`export interface ${ParamsName} {`);
  if (action.inputs.length === 0) {
    lines.push('  // (no declared inputs)');
  }
  const paramNames: { local: string; field: string }[] = [];
  for (const io of action.inputs) {
    const field = toSnakeCase(io.name);
    paramNames.push({ local: toCamelCase(io.name), field });
    const optional = io.required ? '' : '?';
    const desc = commentSafe(io.description);
    if (desc) lines.push(`  /** ${desc} */`);
    lines.push(`  ${field}${optional}: ${actionIoTsType(io, idx)};`);
  }
  lines.push('}');
  lines.push('');

  // Result type from outputs.
  let resultType: string;
  if (action.outputs.length === 0) {
    resultType = 'void';
  } else if (action.outputs.length === 1) {
    resultType = actionIoTsType(action.outputs[0], idx);
  } else {
    const ResultName = `${toPascalCase(toolName)}Output`;
    lines.push(`export interface ${ResultName} {`);
    for (const io of action.outputs) {
      const field = toSnakeCase(io.name);
      const optional = io.required ? '' : '?';
      lines.push(`  ${field}${optional}: ${actionIoTsType(io, idx)};`);
    }
    lines.push('}');
    lines.push('');
    resultType = ResultName;
  }

  // JSDoc citing sources[0].
  lines.push('/**');
  lines.push(` * ${action.name}${action.nameZh ? ` (${commentSafe(action.nameZh)})` : ''}`);
  const adesc = commentSafe(action.description);
  if (adesc) lines.push(` * ${adesc}`);
  lines.push(` * @actionId ${action.id}`);
  lines.push(` * @actor ${commentSafe(action.actor?.role) || 'unknown'} (${action.actor?.kind ?? 'system'})`);
  lines.push(` * @execution ${action.agent?.execution ?? 'function'}`);
  const cite = action.sources && action.sources.length > 0 ? action.sources[0] : undefined;
  if (cite) {
    lines.push(` * @source ${commentSafe(cite.documentName)}${cite.page ? ` p.${cite.page}` : ''}${cite.section ? ` ${commentSafe(cite.section)}` : ''}`);
    if (cite.snippet) lines.push(` * @quote "${commentSafe(cite.snippet)}"`);
  }
  lines.push(' */');

  // Async function signature.
  const sig = action.inputs.length > 0 ? `input: ${ParamsName}` : '';
  lines.push(`export async function ${toolName}(${sig}): Promise<${resultType}> {`);

  // Precondition assertions.
  if (action.preconditions.length === 0) {
    lines.push('  // (no preconditions)');
  }
  for (const pre of action.preconditions) {
    const rule = idx.ruleById.get(pre.ruleId);
    const sev = pre.severity ?? rule?.severity ?? 'info';
    if (rule) {
      lines.push(`  // PRECONDITION [${sev}] ${commentSafe(rule.statement?.en) || rule.title}`);
      if (rule.formal) lines.push(`  // FORMAL: ${commentSafe(rule.formal)}`);
      const predicate = rule.expression?.predicate;
      const predArg = predicate ? `, ${strLit(predicate)}` : '';
      lines.push(`  assertPrecondition(${strLit(rule.id)}, ${strLit(sev)}, /* TODO: evaluate */ true${predArg});`);
    } else {
      warnings.push(`Action ${action.id} references missing precondition rule ${pre.ruleId}.`);
      lines.push(`  // PRECONDITION references missing rule ${pre.ruleId}`);
      lines.push(`  assertPrecondition(${strLit(pre.ruleId)}, ${strLit(sev)}, /* TODO: evaluate */ true);`);
    }
  }
  if (action.inputs.length > 0 && paramNames.length > 0) {
    lines.push('  // Inputs: ' + paramNames.map((p) => p.field).join(', '));
  }

  // Emits + side-effects + TODO body.
  if (action.emitsEvents.length > 0) {
    lines.push('  // Emits events:');
    for (const emit of action.emitsEvents) {
      lines.push(`  //   - ${emit.eventTypeId} on:${emit.on}${emit.condition ? ` when ${commentSafe(emit.condition)}` : ''}`);
    }
  }
  if (action.sideEffects && action.sideEffects.length > 0) {
    lines.push('  // Side effects:');
    for (const se of action.sideEffects) {
      lines.push(`  //   - [${se.kind}] ${commentSafe(se.description)}${se.objectTypeId ? ` (${se.objectTypeId})` : ''}`);
    }
  }
  lines.push('  // TODO: implement the action body.');
  lines.push(`  throw new Error('Not implemented: ${toolName}');`);
  lines.push('}');
  lines.push('');

  return {
    path: `src/agents/tools/${toolName}.ts`,
    language: 'typescript',
    content: lines.join('\n').replace(/\n+$/, '\n'),
  };
}

// ---------------------------------------------------------------------------
// runtime.ts — shared assert helper used by tool stubs + orchestrators.
// ---------------------------------------------------------------------------

function generateRuntimeFile(): GeneratedFile {
  const lines: string[] = [];
  lines.push('// AUTO-GENERATED runtime helpers shared by generated tools + orchestrators.');
  lines.push('');
  lines.push("export type Severity = 'info' | 'warn' | 'block';");
  lines.push('');
  lines.push('/**');
  lines.push(' * Guard a precondition rule. A failing `block` rule aborts the action;');
  lines.push(' * `warn`/`info` are logged but do not throw. `predicate` is the rule\'s');
  lines.push(' * machine form (CEL) when available, carried for the runtime evaluator.');
  lines.push(' */');
  lines.push('export function assertPrecondition(');
  lines.push('  ruleId: string,');
  lines.push('  severity: Severity,');
  lines.push('  satisfied: boolean,');
  lines.push('  predicate?: string,');
  lines.push('): void {');
  lines.push('  if (satisfied) return;');
  lines.push('  const detail = predicate ? ` (${predicate})` : \'\';');
  lines.push('  const message = `Precondition ${ruleId} not satisfied${detail}`;');
  lines.push("  if (severity === 'block') throw new Error(message);");
  lines.push('  // eslint-disable-next-line no-console');
  lines.push('  console.warn(`[${severity}] ${message}`);');
  lines.push('}');
  lines.push('');
  return { path: 'src/agents/runtime.ts', language: 'typescript', content: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Per-process orchestrator.
// ---------------------------------------------------------------------------

function generateProcessFile(proc: Process, idx: CodeIndex, warnings: string[]): GeneratedFile {
  const fnName = idx.fnNameByProcessId.get(proc.id) as string;
  const lines: string[] = [];

  // Steps sorted by `order` for a deterministic, linear default walk.
  const steps = [...proc.steps].sort((a, b) => a.order - b.order);
  const stepById = new Map<string, WorkflowStep>();
  for (const s of steps) stepById.set(s.id, s);

  // Tool imports referenced by the process's steps.
  const toolImports = new Set<string>();
  for (const s of steps) {
    const tool = idx.toolNameByActionId.get(s.actionTypeId);
    if (tool) toolImports.add(tool);
    else warnings.push(`Process ${proc.id} step ${s.id} references missing action ${s.actionTypeId}.`);
  }

  lines.push('// AUTO-GENERATED process orchestrator — do not edit by hand.');
  for (const tool of Array.from(toolImports).sort()) {
    lines.push(`import { ${tool} } from '../tools/${tool}.js';`);
  }
  lines.push(`import { assertPrecondition } from '../runtime.js';`);
  lines.push('');

  // JSDoc.
  lines.push('/**');
  lines.push(` * ${commentSafe(proc.name?.en) || fnName}${proc.name?.zh ? ` (${commentSafe(proc.name.zh)})` : ''}`);
  if (proc.description) lines.push(` * ${commentSafe(proc.description)}`);
  lines.push(` * @processId ${proc.id}`);
  lines.push(` * @strategy ${proc.orchestration?.strategy ?? 'sequential'}`);
  if (proc.orchestration?.agentOrchestrated) lines.push(' * @agentOrchestrated');
  if (proc.orchestration?.onFailure) lines.push(` * @onFailure ${proc.orchestration.onFailure}`);
  for (const trig of proc.triggers ?? []) {
    lines.push(` * @trigger ${trig.kind}${trig.eventTypeId ? ` ${trig.eventTypeId}` : ''}${trig.schedule ? ` ${commentSafe(trig.schedule)}` : ''}`);
  }
  lines.push(' */');

  lines.push(`export async function ${fnName}(context: Record<string, unknown> = {}): Promise<void> {`);
  if (steps.length === 0) {
    lines.push('  // (process has no steps)');
    lines.push('  return;');
    lines.push('}');
    lines.push('');
    return {
      path: `src/agents/processes/${fnName}.ts`,
      language: 'typescript',
      content: lines.join('\n'),
    };
  }

  lines.push('  // Linear walk over steps in `order`; `next` edges with a condition /');
  lines.push('  // onEventTypeId are branch points to resolve in the runtime.');
  lines.push('  void context;');
  lines.push('');

  for (const step of steps) {
    const action = idx.actionById.get(step.actionTypeId);
    const tool = idx.toolNameByActionId.get(step.actionTypeId);
    lines.push(`  // --- step ${step.id} (order ${step.order})${step.actorRole ? ` actor:${commentSafe(step.actorRole)}` : ''} ---`);

    // Guard the step with each precondition of the underlying action.
    if (action) {
      for (const pre of action.preconditions) {
        const rule = idx.ruleById.get(pre.ruleId);
        const sev = pre.severity ?? rule?.severity ?? 'info';
        const predicate = rule?.expression?.predicate;
        const predArg = predicate ? `, ${strLit(predicate)}` : '';
        if (rule) lines.push(`  // guard [${sev}] ${commentSafe(rule.statement?.en) || rule.title}`);
        lines.push(`  assertPrecondition(${strLit(pre.ruleId)}, ${strLit(sev)}, /* TODO: evaluate */ true${predArg});`);
      }
    }

    if (tool && action) {
      const callArg = action.inputs.length > 0 ? '/* TODO: map inputs */ {} as never' : '';
      lines.push(`  await ${tool}(${callArg});`);
    } else {
      lines.push(`  // TODO: missing tool for action ${step.actionTypeId}`);
    }

    // Outgoing edges -> branch documentation.
    const edges = step.next ?? [];
    if (edges.length === 0) {
      lines.push(`  // terminal step (no outgoing edges)`);
    } else {
      for (const edge of edges) {
        const target = stepById.has(edge.toStepId) ? edge.toStepId : `MISSING:${edge.toStepId}`;
        if (!stepById.has(edge.toStepId)) {
          warnings.push(`Process ${proc.id} step ${step.id} has edge to missing step ${edge.toStepId}.`);
        }
        const cond = edge.condition ? ` when ${commentSafe(edge.condition)}` : '';
        const evt = edge.onEventTypeId ? ` on ${edge.onEventTypeId}` : '';
        lines.push(`  // -> ${target}${cond}${evt}${edge.label?.en ? ` [${commentSafe(edge.label.en)}]` : ''}`);
      }
    }
    lines.push('');
  }

  lines.push('}');
  lines.push('');

  return {
    path: `src/agents/processes/${fnName}.ts`,
    language: 'typescript',
    content: lines.join('\n').replace(/\n+$/, '\n'),
  };
}

// ---------------------------------------------------------------------------
// tools/index.ts — { toolName -> fn } registry.
// ---------------------------------------------------------------------------

function generateToolsIndexFile(o: Ontology, idx: CodeIndex): GeneratedFile {
  const lines: string[] = [];
  lines.push('// AUTO-GENERATED tool registry — do not edit by hand.');

  const entries: { tool: string }[] = [];
  for (const action of o.actions) {
    const tool = idx.toolNameByActionId.get(action.id) as string;
    entries.push({ tool });
  }

  for (const e of entries) {
    lines.push(`import { ${e.tool} } from './${e.tool}.js';`);
  }
  lines.push('');
  lines.push('/** Registry of every generated agent tool, keyed by tool name. */');
  lines.push('export const tools = {');
  for (const e of entries) {
    lines.push(`  ${e.tool},`);
  }
  lines.push('} as const;');
  lines.push('');
  lines.push('export type ToolName = keyof typeof tools;');
  lines.push('');
  return { path: 'src/agents/tools/index.ts', language: 'typescript', content: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Deterministically project an {@link Ontology} into a TypeScript agent-code
 * {@link GeneratedBundle} (target `"agent-code"`). Pure — no LLM, no I/O.
 */
export function generateAgentCode(o: Ontology): GeneratedBundle {
  const warnings: string[] = [];
  const idx = buildIndex(o, warnings);

  const files: GeneratedFile[] = [];
  files.push(generateTypesFile(o, idx));
  files.push(generateRuntimeFile());

  for (const action of o.actions) {
    files.push(generateToolFile(action, idx, warnings));
  }
  files.push(generateToolsIndexFile(o, idx));

  for (const proc of o.processes) {
    files.push(generateProcessFile(proc, idx, warnings));
  }

  if (o.actions.length === 0) {
    warnings.push('Ontology has no actions; tool registry is empty.');
  }

  return { target: 'agent-code', files, warnings };
}
