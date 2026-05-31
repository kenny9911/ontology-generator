/**
 * ============================================================================
 *  ONTOLOGY GENERATOR — `prompts` GENERATOR (T18)
 * ============================================================================
 *
 *  Pure, DETERMINISTIC transform:  Ontology -> GeneratedBundle (target 'prompts').
 *
 *  Emits one Markdown system prompt per distinct `ActorRef.role` found across
 *  `actions[].actor` and `processes[].actors`, plus a single global
 *  `prompts/system.md`. Each role prompt lists:
 *    - mission (derived from the role + the processes/actions it participates in)
 *    - the `AgentBinding` tools the role OWNS (an action's actor.role owns its
 *      `agent.toolName`): toolName + toolDescription + parameters (from
 *      `parameterSchema`)
 *    - the constraining `Rule`s (EN/zh `statement` + `formal` + a `sources[0]`
 *      citation): `severity:'block'` -> "MUST NOT" guardrails, `'warn'` -> caution
 *    - the events the role reacts to (its actions' `triggeredByEventIds`) and the
 *      events it emits (its actions' `emitsEvents`)
 *  Bilingual blocks are emitted whenever the zh field is present.
 *
 *  HARD RULES for THIS file (T18):
 *  --------------------------------------------------------------------------
 *  - NO LLM calls. This is a pure read of the `Ontology` JSON; it ADDS no
 *    information not already present (the LLM-assisted variant lives in
 *    `api/ontology-gen/prompts.ts::buildPromptsPrompt`, kept separate).
 *  - The exported function is named `generateAgentPrompts` to avoid clashing
 *    with the prompt-BUILDER names in `api/ontology-gen/prompts.ts`.
 *  - Deterministic: every iteration walks ontology arrays in a stable, sorted
 *    order so re-runs are byte-identical.
 *  - NodeNext strict TS: schema types imported from the generated backend
 *    mirror with the '.js' suffix.
 * ============================================================================
 */

import type {
  Ontology,
  ObjectType,
  ActionType,
  Rule,
  EventType,
  Process,
  JsonSchema,
  JsonSchemaProp,
  Severity,
  GeneratedBundle,
  GeneratedFile,
} from '../../_shared/ontology-schema.js';

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

/** Stable string compare (locale-independent) for deterministic ordering. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A filesystem-safe slug for a role name, e.g. "Fulfillment Lead" -> "fulfillment-lead". */
function roleSlug(role: string): string {
  const slug = role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unspecified';
}

/** Escape a value so it renders cleanly inside a Markdown table cell. */
function mdCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** First non-empty line of a (possibly multi-line) description. */
function firstLine(text: string | undefined): string {
  if (!text) return '';
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  return (line ?? '').trim();
}

// ---------------------------------------------------------------------------
// JSON-Schema -> a readable parameter list (deterministic)
// ---------------------------------------------------------------------------

function propTypeLabel(prop: JsonSchemaProp): string {
  if (prop.type === 'array') {
    const itemLabel = prop.items ? propTypeLabel(prop.items) : 'any';
    return `${itemLabel}[]`;
  }
  if (prop.enum && prop.enum.length > 0) {
    return prop.enum.map((v) => JSON.stringify(v)).join(' | ');
  }
  return prop.type;
}

function renderParameterRows(schema: JsonSchema): string[] {
  const required = new Set(schema.required ?? []);
  const names = Object.keys(schema.properties ?? {}).sort(byString);
  if (names.length === 0) {
    return ['| _(none)_ | — | — | — |'];
  }
  return names.map((name) => {
    const prop = schema.properties[name];
    const type = propTypeLabel(prop);
    const req = required.has(name) ? 'yes' : 'no';
    const desc = mdCell(prop.description ?? '');
    return `| \`${mdCell(name)}\` | \`${mdCell(type)}\` | ${req} | ${desc} |`;
  });
}

// ---------------------------------------------------------------------------
// Role discovery + ownership mapping
// ---------------------------------------------------------------------------

interface RoleProfile {
  role: string;
  /** zh label if any actor/action surfaced one. */
  roleZh?: string;
  /** Actions whose `actor.role === role` (the role OWNS these tools). */
  ownedActions: ActionType[];
  /** Processes in which this role participates. */
  processes: Process[];
}

/**
 * Collect every distinct `ActorRef.role` across actions + processes, mapping
 * each to the actions it owns and the processes it participates in. Sorted by
 * role name for determinism.
 */
function discoverRoles(o: Ontology): RoleProfile[] {
  const byRole = new Map<string, RoleProfile>();

  const ensure = (role: string, roleZh?: string): RoleProfile => {
    let p = byRole.get(role);
    if (!p) {
      p = { role, ownedActions: [], processes: [] };
      byRole.set(role, p);
    }
    if (roleZh && !p.roleZh) p.roleZh = roleZh;
    return p;
  };

  for (const action of o.actions) {
    const actor = action.actor;
    if (!actor || !actor.role) continue;
    const p = ensure(actor.role, actor.roleZh);
    p.ownedActions.push(action);
  }

  for (const proc of o.processes) {
    for (const actor of proc.actors ?? []) {
      if (!actor || !actor.role) continue;
      const p = ensure(actor.role, actor.roleZh);
      if (!p.processes.includes(proc)) p.processes.push(proc);
    }
  }

  const profiles = Array.from(byRole.values());
  for (const p of profiles) {
    p.ownedActions.sort((a, b) => byString(a.id, b.id));
    p.processes.sort((a, b) => byString(a.id, b.id));
  }
  profiles.sort((a, b) => byString(a.role, b.role));
  return profiles;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

interface Indexes {
  objects: Map<string, ObjectType>;
  rules: Map<string, Rule>;
  events: Map<string, EventType>;
  actionToolNames: Map<string, string>;
}

function buildIndexes(o: Ontology): Indexes {
  const objects = new Map<string, ObjectType>();
  for (const obj of o.objects) objects.set(obj.id, obj);
  const rules = new Map<string, Rule>();
  for (const r of o.rules) rules.set(r.id, r);
  const events = new Map<string, EventType>();
  for (const e of o.events) events.set(e.id, e);
  const actionToolNames = new Map<string, string>();
  for (const a of o.actions) actionToolNames.set(a.id, a.agent?.toolName ?? a.name);
  return { objects, rules, events, actionToolNames };
}

/** ObjectType.id set touched by a role's owned actions (inputs/outputs/steps). */
function objectIdsForRole(profile: RoleProfile): Set<string> {
  const ids = new Set<string>();
  for (const action of profile.ownedActions) {
    for (const io of [...action.inputs, ...action.outputs]) {
      if (io.objectTypeId) ids.add(io.objectTypeId);
    }
    for (const step of action.steps) {
      for (const id of step.readsObjectTypeIds ?? []) ids.add(id);
      for (const id of step.writesObjectTypeIds ?? []) ids.add(id);
    }
    for (const eff of action.sideEffects ?? []) {
      if (eff.objectTypeId) ids.add(eff.objectTypeId);
    }
  }
  return ids;
}

/**
 * Rules constraining a role: every rule referenced as a precondition of one of
 * the role's owned actions, PLUS every rule that applies to an object the role
 * touches. Returned in a deterministic, severity-then-id order.
 */
function rulesForRole(profile: RoleProfile, idx: Indexes): Rule[] {
  const objIds = objectIdsForRole(profile);
  const collected = new Map<string, Rule>();

  for (const action of profile.ownedActions) {
    for (const pre of action.preconditions) {
      const rule = idx.rules.get(pre.ruleId);
      if (rule) collected.set(rule.id, rule);
    }
  }
  for (const rule of idx.rules.values()) {
    if (rule.appliesToObjectTypeIds.some((id) => objIds.has(id))) {
      collected.set(rule.id, rule);
    }
  }

  const severityRank: Record<Severity, number> = { block: 0, warn: 1, info: 2 };
  return Array.from(collected.values()).sort((a, b) => {
    const sr = severityRank[a.severity] - severityRank[b.severity];
    return sr !== 0 ? sr : byString(a.id, b.id);
  });
}

/** Event ids a role reacts to (its actions' triggers), sorted + de-duped. */
function reactsToEventIds(profile: RoleProfile): string[] {
  const ids = new Set<string>();
  for (const action of profile.ownedActions) {
    for (const id of action.triggeredByEventIds) ids.add(id);
  }
  return Array.from(ids).sort(byString);
}

interface EmitRef {
  eventTypeId: string;
  on: string;
  sourceToolName: string;
}

/** Events a role emits (its actions' emitsEvents), sorted deterministically. */
function emitsEventRefs(profile: RoleProfile): EmitRef[] {
  const refs: EmitRef[] = [];
  for (const action of profile.ownedActions) {
    const toolName = action.agent?.toolName ?? action.name;
    for (const spec of action.emitsEvents) {
      refs.push({ eventTypeId: spec.eventTypeId, on: spec.on, sourceToolName: toolName });
    }
  }
  refs.sort((a, b) => {
    const e = byString(a.eventTypeId, b.eventTypeId);
    if (e !== 0) return e;
    const t = byString(a.sourceToolName, b.sourceToolName);
    return t !== 0 ? t : byString(a.on, b.on);
  });
  return refs;
}

// ---------------------------------------------------------------------------
// Citation rendering (sources[0])
// ---------------------------------------------------------------------------

function citation(rule: Rule): string {
  const src = rule.sources[0];
  if (!src) return '';
  const where: string[] = [];
  if (src.section) where.push(src.section);
  if (typeof src.page === 'number' && src.page > 0) where.push(`p.${src.page}`);
  const loc = where.length > 0 ? ` (${where.join(', ')})` : '';
  const verified = src.quoteVerified === false ? ' [UNVERIFIED QUOTE]' : '';
  const snippet = src.snippet ? ` "${src.snippet.trim()}"` : '';
  return `${src.documentName}${loc}${verified}:${snippet}`;
}

// ---------------------------------------------------------------------------
// Markdown section builders (per-role prompt)
// ---------------------------------------------------------------------------

function bilingualName(o: Ontology): string {
  return o.nameZh ? `${o.name} / ${o.nameZh}` : o.name;
}

function renderToolsSection(profile: RoleProfile): string[] {
  const lines: string[] = ['## Tools you own', ''];
  if (profile.ownedActions.length === 0) {
    lines.push('_You own no callable tools; you participate by coordination only._', '');
    return lines;
  }
  for (const action of profile.ownedActions) {
    const agent = action.agent;
    const toolName = agent?.toolName ?? action.name;
    lines.push(`### \`${toolName}\``);
    const titleZh = action.nameZh ? ` / ${action.nameZh}` : '';
    lines.push(`**${action.name}${titleZh}** — execution: \`${agent?.execution ?? 'function'}\`` +
      (agent?.integration ? ` · integration: \`${agent.integration}\`` : ''));
    lines.push('');
    const desc = agent?.toolDescription || action.description;
    if (desc) {
      lines.push(desc.trim());
      lines.push('');
      if (action.descriptionZh) {
        lines.push(`> ${action.descriptionZh.trim()}`);
        lines.push('');
      }
    }
    lines.push('Parameters:');
    lines.push('');
    lines.push('| name | type | required | description |');
    lines.push('| --- | --- | --- | --- |');
    if (agent?.parameterSchema) {
      lines.push(...renderParameterRows(agent.parameterSchema));
    } else {
      lines.push('| _(none)_ | — | — | — |');
    }
    lines.push('');
    for (const hint of agent?.promptHints ?? []) {
      lines.push(`- Hint: ${hint.trim()}`);
    }
    if ((agent?.promptHints ?? []).length > 0) lines.push('');
  }
  return lines;
}

function renderRulesSection(profile: RoleProfile, idx: Indexes): string[] {
  const rules = rulesForRole(profile, idx);
  const lines: string[] = ['## Rules that constrain you', ''];
  if (rules.length === 0) {
    lines.push('_No domain rules constrain your tools._', '');
    return lines;
  }
  for (const rule of rules) {
    const marker =
      rule.severity === 'block'
        ? 'MUST NOT'
        : rule.severity === 'warn'
        ? 'CAUTION'
        : 'NOTE';
    lines.push(`### [${marker}] ${rule.title}` + (rule.titleZh ? ` / ${rule.titleZh}` : ''));
    lines.push('');
    if (rule.severity === 'block') {
      lines.push('**This is a hard guardrail. You MUST NOT proceed if it is violated.**');
    } else if (rule.severity === 'warn') {
      lines.push('**Caution: surface this to the operator before acting.**');
    }
    lines.push('');
    lines.push(`- EN: ${rule.statement.en.trim()}`);
    lines.push(`- ZH: ${rule.statement.zh.trim()}`);
    lines.push(`- Formal: \`${rule.formal.trim()}\``);
    const cite = citation(rule);
    if (cite) lines.push(`- Source: ${cite}`);
    const objs = rule.appliesToObjectTypeIds
      .map((id) => idx.objects.get(id)?.name ?? id)
      .sort(byString);
    if (objs.length > 0) lines.push(`- Applies to: ${objs.join(', ')}`);
    lines.push('');
  }
  return lines;
}

function renderEventsSection(profile: RoleProfile, idx: Indexes): string[] {
  const reacts = reactsToEventIds(profile);
  const emits = emitsEventRefs(profile);
  const lines: string[] = ['## Events', ''];

  lines.push('### You react to');
  if (reacts.length === 0) {
    lines.push('', '_No incoming events; your tools are invoked directly._', '');
  } else {
    lines.push('');
    for (const id of reacts) {
      const ev = idx.events.get(id);
      const name = ev?.name ?? id;
      const nameZh = ev?.nameZh ? ` / ${ev.nameZh}` : '';
      const desc = firstLine(ev?.description);
      lines.push(`- \`${name}\`${nameZh}${desc ? ` — ${desc}` : ''}`);
    }
    lines.push('');
  }

  lines.push('### You emit');
  if (emits.length === 0) {
    lines.push('', '_Your tools emit no events._', '');
  } else {
    lines.push('');
    for (const ref of emits) {
      const ev = idx.events.get(ref.eventTypeId);
      const name = ev?.name ?? ref.eventTypeId;
      const nameZh = ev?.nameZh ? ` / ${ev.nameZh}` : '';
      lines.push(`- \`${name}\`${nameZh} — on \`${ref.on}\` of \`${ref.sourceToolName}\``);
    }
    lines.push('');
  }
  return lines;
}

function renderMissionSection(profile: RoleProfile, o: Ontology): string[] {
  const lines: string[] = ['## Mission', ''];
  const roleLabel = profile.roleZh ? `**${profile.role}** (${profile.roleZh})` : `**${profile.role}**`;
  lines.push(
    `You are the ${roleLabel} agent operating within the ${bilingualName(o)} domain. ` +
      `You execute your owned tools faithfully, honoring every rule below, and you ` +
      `coordinate through events with the rest of the workflow.`,
  );
  lines.push('');
  if (profile.processes.length > 0) {
    lines.push('You participate in these processes:');
    lines.push('');
    for (const proc of profile.processes) {
      const pname = proc.name.zh ? `${proc.name.en} / ${proc.name.zh}` : proc.name.en;
      const pdesc = firstLine(proc.description);
      lines.push(`- **${pname}**${pdesc ? ` — ${pdesc}` : ''}`);
    }
    lines.push('');
  }
  return lines;
}

function buildRolePromptContent(profile: RoleProfile, o: Ontology, idx: Indexes): string {
  const heading = profile.roleZh
    ? `# ${profile.role} / ${profile.roleZh} — Agent System Prompt`
    : `# ${profile.role} — Agent System Prompt`;
  const lines: string[] = [
    heading,
    '',
    `> Generated from ontology \`${o.id}\` version ${o.version}. Do not edit by hand.`,
    '',
    ...renderMissionSection(profile, o),
    ...renderToolsSection(profile),
    ...renderRulesSection(profile, idx),
    ...renderEventsSection(profile, idx),
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------------------
// Global system.md
// ---------------------------------------------------------------------------

function buildGlobalSystemContent(o: Ontology, profiles: RoleProfile[]): string {
  const lines: string[] = [
    `# ${bilingualName(o)} — Global System Prompt`,
    '',
    `> Generated from ontology \`${o.id}\` version ${o.version}. Do not edit by hand.`,
    '',
    '## Domain',
    '',
    `- Ontology: \`${o.id}\``,
    `- Domain: \`${o.domain}\``,
    `- Version: ${o.version}`,
    `- Objects: ${o.objects.length} · Rules: ${o.rules.length} · Actions: ${o.actions.length} · ` +
      `Events: ${o.events.length} · Processes: ${o.processes.length}`,
    '',
    '## Agent roles',
    '',
  ];
  if (profiles.length === 0) {
    lines.push('_No actor roles are defined in this ontology._', '');
  } else {
    lines.push('| role | prompt file | tools owned |', '| --- | --- | --- |');
    for (const p of profiles) {
      const label = p.roleZh ? `${p.role} / ${p.roleZh}` : p.role;
      const file = `${roleSlug(p.role)}.md`;
      const tools = p.ownedActions
        .map((a) => a.agent?.toolName ?? a.name)
        .sort(byString)
        .map((t) => `\`${t}\``)
        .join(', ');
      lines.push(`| ${mdCell(label)} | \`${file}\` | ${tools || '—'} |`);
    }
    lines.push('');
  }
  lines.push('## Operating principles', '');
  lines.push(
    '- Every tool call must satisfy its preconditions. A `block`-severity rule violation aborts the action.',
    '- Cite the governing rule when you decline or escalate.',
    '- Coordinate strictly through the events declared on each role.',
    '- This ontology is the single source of truth; do not invent objects, rules, actions, or events.',
    '',
  );
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the `prompts` GeneratedBundle: a global `prompts/system.md` plus one
 * `prompts/<role-slug>.md` per distinct `ActorRef.role`. Pure + deterministic.
 */
export function generateAgentPrompts(o: Ontology): GeneratedBundle {
  const warnings: string[] = [];
  const idx = buildIndexes(o);
  const profiles = discoverRoles(o);

  const files: GeneratedFile[] = [];

  files.push({
    path: 'prompts/system.md',
    language: 'markdown',
    content: buildGlobalSystemContent(o, profiles),
  });

  // Guard against two distinct role names colliding to the same slug.
  const usedSlugs = new Map<string, string>();
  for (const profile of profiles) {
    let slug = roleSlug(profile.role);
    const owner = usedSlugs.get(slug);
    if (owner && owner !== profile.role) {
      let n = 2;
      while (usedSlugs.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
      warnings.push(
        `Role "${profile.role}" slug collided; emitted as "${slug}.md".`,
      );
    }
    usedSlugs.set(slug, profile.role);

    if (profile.ownedActions.length === 0) {
      warnings.push(`Role "${profile.role}" owns no tools (coordination-only).`);
    }

    files.push({
      path: `prompts/${slug}.md`,
      language: 'markdown',
      content: buildRolePromptContent(profile, o, idx),
    });
  }

  if (profiles.length === 0) {
    warnings.push('Ontology declares no actor roles; only the global system.md was emitted.');
  }

  return { target: 'prompts', files, warnings };
}
