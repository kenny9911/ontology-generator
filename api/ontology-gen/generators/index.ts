// ============================================================================
//  T20 — Generator dispatcher (public facade)
// ----------------------------------------------------------------------------
//  A thin, pure routing layer over the three deterministic generators:
//    - generateAgentCode   (./agent-code.js)  -> target "agent-code"
//    - generateAgentPrompts (./prompts.js)    -> target "prompts"
//    - generateManifests   (./manifest.js)    -> target "manifest"
//
//  Contract (DESIGN_SPEC §3.7 / TASK_PLAN T20):
//    generate(o, target) -> GeneratedBundle           for a single target
//    generate(o, "all")  -> GeneratedBundle[]         (all three, fixed order)
//
//  The facade is `async` per the locked signature even though every underlying
//  generator is synchronous & side-effect-free (no LLM, no I/O). For "all" the
//  bundles are returned in a stable order: agent-code, prompts, manifest.
// ============================================================================

import type { GeneratedBundle, Ontology } from '../../_shared/ontology-schema.js';
import { generateAgentCode } from './agent-code.js';
import { generateAgentPrompts } from './prompts.js';
import { generateManifests } from './manifest.js';

/** The selectable single-target generators. */
export type GeneratorTarget = 'agent-code' | 'prompts' | 'manifest';

/**
 * Project an {@link Ontology} into one or more {@link GeneratedBundle}s.
 *
 * @param o      the (validated) ontology snapshot to compile
 * @param target a single target, or `"all"` for every bundle
 * @returns a single bundle for a single target; an array of all three bundles
 *          (in order: agent-code, prompts, manifest) for `"all"`
 */
export async function generate(
  o: Ontology,
  target: GeneratorTarget | 'all',
): Promise<GeneratedBundle | GeneratedBundle[]> {
  switch (target) {
    case 'agent-code':
      return generateAgentCode(o);
    case 'prompts':
      return generateAgentPrompts(o);
    case 'manifest':
      return generateManifests(o);
    case 'all':
      return [
        generateAgentCode(o),
        generateAgentPrompts(o),
        generateManifests(o),
      ];
    default: {
      // Exhaustiveness guard: a new target must be wired in above.
      const exhaustive: never = target;
      throw new Error(`Unknown generator target: ${String(exhaustive)}`);
    }
  }
}
