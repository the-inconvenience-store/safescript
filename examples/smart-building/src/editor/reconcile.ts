import type { SemanticDiff } from '@safescript/contracts';

import type { BuildingFlow } from './projection.js';

/** Preserves layout through stable identities and compiler-provided before/after correspondence. */
export function reconcileSemanticFlow(previous: BuildingFlow, next: BuildingFlow, diff?: SemanticDiff): BuildingFlow {
  const prior = new Map(previous.nodes.map((node) => [node.semanticId, node.position]));
  if (diff) {
    for (const entry of diff.entries) {
      const before = entry.before.find((id) => prior.has(id));
      if (!before) continue;
      const position = prior.get(before);
      if (!position) continue;
      for (const after of entry.after) if (!prior.has(after)) prior.set(after, position);
    }
  }
  return {
    nodes: next.nodes.map((node) => ({ ...node, position: prior.get(node.semanticId) ?? node.position })),
    edges: next.edges,
  };
}
