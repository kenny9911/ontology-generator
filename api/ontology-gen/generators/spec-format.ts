// ============================================================================
//  generators/spec-format.ts — target "spec".
// ----------------------------------------------------------------------------
//  Projects a (validated) ontology into the EXPORT/PRESENTATION "spec format"
//  (see api/ontology-gen/spec-format/) and packages it as a GeneratedBundle of
//  five JSON files — one per layer, each mirroring the reference samples under
//  fixtures/spec-samples/:
//    objects_sample.json / rules_sample.json / actions_sample.json /
//    events_sample.json / workflow_sample.json
//
//  Pure + synchronous (no LLM, no I/O), like the other generators. The actual
//  field mapping lives in spec-format/project.ts; this file only serializes.
// ============================================================================

import type { GeneratedBundle, Ontology } from '../../_shared/ontology-schema.js';
import {
  ontologyToSpecObjectsFile,
  ontologyToSpecRulesFile,
  ontologyToSpecActionsFile,
  ontologyToSpecEventsFile,
  ontologyToSpecWorkflowsFile,
} from '../spec-format/project.js';
import { validateSpecBundle } from '../spec-format/validate.js';
import { ontologyToSpec } from '../spec-format/project.js';

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** Project an ontology into the spec-format bundle (five per-layer JSON files). */
export function generateSpecFormat(o: Ontology): GeneratedBundle {
  const files = [
    { path: 'spec/objects_sample.json', language: 'json', content: json(ontologyToSpecObjectsFile(o)) },
    { path: 'spec/rules_sample.json', language: 'json', content: json(ontologyToSpecRulesFile(o)) },
    { path: 'spec/actions_sample.json', language: 'json', content: json(ontologyToSpecActionsFile(o)) },
    { path: 'spec/events_sample.json', language: 'json', content: json(ontologyToSpecEventsFile(o)) },
    { path: 'spec/workflow_sample.json', language: 'json', content: json(ontologyToSpecWorkflowsFile(o)) },
  ];

  // Surface any internal inconsistencies as warnings (never fatal).
  const warnings = validateSpecBundle(ontologyToSpec(o)).map((w) => `spec-format: ${w}`);

  return { target: 'spec', files, warnings };
}
