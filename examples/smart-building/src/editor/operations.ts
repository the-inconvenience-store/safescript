import type {
  OperationId,
  SemanticEdit,
  SemanticEditCapability,
  SemanticEditCapabilityManifest,
  SemanticEditId,
  SemanticEditKind,
  SemanticGraph,
  SemanticGraphAnchor,
  SemanticNodeId,
  SemanticSchemaPath,
} from '@safescript/contracts';

export type SemanticIntent =
  | Readonly<{ kind: 'set_literal'; target: SemanticNodeId; value: null | boolean | number | string }>
  | Readonly<{ kind: 'rename_symbol'; target: SemanticNodeId; name: string }>
  | Readonly<{ kind: 'replace_condition'; target: SemanticNodeId; source: string }>
  | Readonly<{ kind: 'change_operator'; target: SemanticNodeId; operator: string }>
  | Readonly<{ kind: 'insert_statement'; container: SemanticNodeId; index: number; source: string }>
  | Readonly<{ kind: 'delete_statement'; target: SemanticNodeId }>
  | Readonly<{ kind: 'reorder_statements'; container: SemanticNodeId; children: readonly SemanticNodeId[] }>
  | Readonly<{
      kind: 'move_statement_range';
      container: SemanticNodeId;
      first: SemanticNodeId;
      last: SemanticNodeId;
      destination: SemanticGraphAnchor;
    }>
  | Readonly<{ kind: 'change_action'; target: SemanticNodeId; operation: OperationId }>
  | Readonly<{ kind: 'set_action_input'; target: SemanticNodeId; path: SemanticSchemaPath; source: string }>;

export class UnsupportedSemanticIntentError extends TypeError {
  override readonly name = 'UnsupportedSemanticIntentError';
}

const bytes = (source: string): readonly number[] => Array.from(new TextEncoder().encode(source));
const samePath = (left: SemanticSchemaPath, right: SemanticSchemaPath): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);
const sameAnchor = (left: SemanticGraphAnchor, right: SemanticGraphAnchor): boolean =>
  left.container === right.container &&
  left.index === right.index &&
  left.before === right.before &&
  left.after === right.after;

function advertised(
  manifest: SemanticEditCapabilityManifest,
  targetId: SemanticNodeId,
  kind: SemanticEditKind,
): SemanticEditCapability {
  const target = manifest.targets.find((candidate) => candidate.target === targetId);
  const capability = target?.capabilities.find((candidate) => candidate.kind === kind);
  if (!capability) throw new UnsupportedSemanticIntentError(`${kind} is not advertised for this target`);
  return capability;
}

export function translateSemanticIntent(
  graph: SemanticGraph,
  manifest: SemanticEditCapabilityManifest,
  intent: SemanticIntent,
  editId: SemanticEditId,
): SemanticEdit {
  if (graph.semanticRevision !== manifest.semanticRevision)
    throw new UnsupportedSemanticIntentError('graph and capability manifest revisions differ');
  switch (intent.kind) {
    case 'set_literal': {
      const capability = advertised(manifest, intent.target, 'set_literal_value');
      return {
        kind: 'set_literal_value',
        editId,
        target: intent.target,
        value: intent.value,
        preconditions: capability.preconditions,
      };
    }
    case 'rename_symbol': {
      const capability = advertised(manifest, intent.target, 'rename_symbol');
      return {
        kind: 'rename_symbol',
        editId,
        target: intent.target,
        newName: intent.name,
        preconditions: capability.preconditions,
      };
    }
    case 'replace_condition': {
      const capability = advertised(manifest, intent.target, 'replace_target');
      if (!capability.fragmentCategories.includes('expression'))
        throw new UnsupportedSemanticIntentError('target does not accept an expression fragment');
      return {
        kind: 'replace_target',
        editId,
        target: intent.target,
        replacement: { category: 'expression', source: bytes(intent.source) },
        preconditions: capability.preconditions,
      };
    }
    case 'change_operator': {
      const capability = advertised(manifest, intent.target, 'change_operator');
      if (!capability.operators.includes(intent.operator))
        throw new UnsupportedSemanticIntentError('operator is not advertised');
      return {
        kind: 'change_operator',
        editId,
        target: intent.target,
        operator: intent.operator,
        preconditions: capability.preconditions,
      };
    }
    case 'insert_statement': {
      const capability = advertised(manifest, intent.container, 'insert_at_anchor');
      const anchor = capability.anchors.find(
        (candidate) => candidate.container === intent.container && candidate.index === intent.index,
      );
      if (!anchor || !capability.fragmentCategories.includes('statement'))
        throw new UnsupportedSemanticIntentError('statement insertion anchor is not advertised');
      return {
        kind: 'insert_at_anchor',
        editId,
        anchor,
        fragment: { category: 'statement', source: bytes(intent.source) },
        preconditions: capability.preconditions,
      };
    }
    case 'delete_statement': {
      const capability = advertised(manifest, intent.target, 'delete_target');
      return {
        kind: 'delete_target',
        editId,
        target: intent.target,
        commentPolicy: capability.ownedComments ? 'preserve_owned_comments' : 'delete_owned_comments',
        preconditions: capability.preconditions,
      };
    }
    case 'reorder_statements': {
      const capability = advertised(manifest, intent.container, 'reorder_children');
      return {
        kind: 'reorder_children',
        editId,
        container: intent.container,
        children: intent.children,
        preconditions: capability.preconditions,
      };
    }
    case 'move_statement_range': {
      const capability = advertised(manifest, intent.container, 'move_statement_range');
      if (!capability.anchors.some((candidate) => sameAnchor(candidate, intent.destination)))
        throw new UnsupportedSemanticIntentError('statement range destination is not advertised');
      return {
        kind: 'move_statement_range',
        editId,
        range: { container: intent.container, first: intent.first, last: intent.last },
        destination: intent.destination,
        preconditions: capability.preconditions,
      };
    }
    case 'change_action': {
      const capability = advertised(manifest, intent.target, 'change_action_operation');
      if (!capability.operations.includes(intent.operation))
        throw new UnsupportedSemanticIntentError('host operation is not advertised');
      return {
        kind: 'change_action_operation',
        editId,
        target: intent.target,
        operation: intent.operation,
        fieldMappings: capability.schemaPaths.map((path) => ({ from: path, to: path })),
        requiredInputs: [],
        preconditions: capability.preconditions,
      };
    }
    case 'set_action_input': {
      const capability = advertised(manifest, intent.target, 'set_action_input_field');
      if (!capability.schemaPaths.some((candidate) => samePath(candidate, intent.path)))
        throw new UnsupportedSemanticIntentError('action input path is not advertised');
      return {
        kind: 'set_action_input_field',
        editId,
        target: intent.target,
        path: intent.path,
        value: { category: 'expression', source: bytes(intent.source) },
        preconditions: capability.preconditions,
      };
    }
  }
}
