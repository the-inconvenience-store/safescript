/** Resolution of schema-1.0 primitive semantic edits into the private lossless rewriter. @internal */
import * as ts from 'typescript';

import {
  hash,
  type CanonicalBytes,
  type SemanticChangedRegion,
  type SemanticDiff,
  type SemanticEdit,
  type SemanticEditDiagnostic,
  type SemanticEditId,
  type SemanticEditLimits,
  type SemanticEditLimitError,
  type SemanticEditOutcome,
  type SemanticEditPrecondition,
  type SemanticEditUsage,
  type SemanticGraph,
  type SemanticGraphAnchor,
  type SemanticGraphNode,
  type SemanticNodeId,
  type SemanticRevisionId,
  type SemanticTransformationProvenance,
  type SourceFragment,
  type SourceFragmentCategory,
  type SourceProgram,
  type SymbolId,
} from '@safescript/contracts';

import {
  EditableSourceDocument,
  applySourceTransformations,
  printSourceFragment,
  type CandidateValidator,
  type SourceByteRange,
  type SourceTransformation,
} from './source-transform.js';

const encoder = new TextEncoder();

export const PRIMITIVE_OPERATIONS = Object.freeze([
  'rename_symbol',
  'replace_target',
  'insert_at_anchor',
  'delete_target',
  'move_target',
  'reorder_children',
] as const);

type PrimitiveEdit = Extract<SemanticEdit, { kind: (typeof PRIMITIVE_OPERATIONS)[number] }>;

export interface PrimitiveEditCoverage {
  readonly operations: readonly (typeof PRIMITIVE_OPERATIONS)[number][];
  readonly uncoveredNodes: readonly SemanticNodeId[];
  readonly uncoveredAnchors: readonly SemanticGraphAnchor[];
}

export type ApplyPrimitiveSemanticEditsResult =
  | Readonly<{
      status: 'accepted';
      source: SourceProgram;
      outcomes: readonly SemanticEditOutcome[];
      changedRegions: readonly SemanticChangedRegion[];
      provenance: readonly SemanticTransformationProvenance[];
      diff: SemanticDiff;
      usage: SemanticEditUsage;
    }>
  | Readonly<{
      status: 'rejected';
      reason:
        | 'stale_revision'
        | 'target_not_found'
        | 'target_kind_mismatch'
        | 'precondition_failed'
        | 'conflicting_edits'
        | 'fragment_rejected'
        | 'transformed_source_rejected'
        | 'edit_limit_exceeded';
      editDiagnostics: readonly SemanticEditDiagnostic[];
      editIds: readonly SemanticEditId[];
      targets: readonly SemanticNodeId[];
      usage: SemanticEditUsage;
      limit?: SemanticEditLimitError;
    }>;

export type PrimitiveRejectionReason = Extract<ApplyPrimitiveSemanticEditsResult, { status: 'rejected' }>['reason'];

interface ModelIndex {
  readonly nodes: ReadonlyMap<SemanticNodeId, SemanticGraphNode>;
  readonly parents: ReadonlyMap<SemanticNodeId, SemanticNodeId>;
  readonly children: ReadonlyMap<SemanticNodeId, readonly SemanticNodeId[]>;
  readonly references: ReadonlyMap<SemanticNodeId, readonly SemanticNodeId[]>;
}

function indexGraph(graph: SemanticGraph): ModelIndex {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const parents = new Map<SemanticNodeId, SemanticNodeId>();
  const mutableChildren = new Map<SemanticNodeId, Array<Readonly<{ id: SemanticNodeId; index: number }>>>();
  const mutableReferences = new Map<SemanticNodeId, SemanticNodeId[]>();
  for (const edge of graph.edges) {
    if (edge.kind === 'contains') {
      parents.set(edge.to, edge.from);
      const selected = mutableChildren.get(edge.from) ?? [];
      selected.push({ id: edge.to, index: edge.index ?? selected.length });
      mutableChildren.set(edge.from, selected);
    } else if (edge.kind === 'references') {
      const selected = mutableReferences.get(edge.to) ?? [];
      selected.push(edge.from);
      mutableReferences.set(edge.to, selected);
    }
  }
  const children = new Map<SemanticNodeId, readonly SemanticNodeId[]>();
  for (const [parent, values] of mutableChildren)
    children.set(
      parent,
      Object.freeze(values.sort((left, right) => left.index - right.index).map((value) => value.id)),
    );
  const references = new Map<SemanticNodeId, readonly SemanticNodeId[]>();
  for (const [binding, values] of mutableReferences) references.set(binding, Object.freeze(values));
  return { nodes, parents, children, references };
}

function nodeRange(node: SemanticGraphNode | undefined): SourceByteRange | undefined {
  return node?.editable ? { start: node.editable.start, end: node.editable.end } : undefined;
}

export function replacementCategories(node: SemanticGraphNode): readonly SourceFragmentCategory[] {
  if (node.semanticKind === 'parameter') return ['parameter'];
  if (node.semanticKind === 'object-member' || node.semanticKind === 'type-member') return ['object_member'];
  if (node.semanticKind === 'array-element') return ['array_element'];
  if (node.semanticKind === 'import-specifier') return ['import_specifier'];
  if (node.semanticKind === 'switch-case') return ['switch_case'];
  if (node.semanticKind === 'return-value') return ['expression'];
  if (node.semanticKind === 'binding-pattern' || node.semanticKind === 'symbol') return ['binding_pattern'];
  if (node.kind === 'module') return ['declaration_list'];
  if (node.kind === 'declaration') return ['declaration'];
  if (node.kind === 'statement' || node.kind === 'branch') return ['statement', 'statement_list'];
  if (node.kind === 'case') return ['switch_case'];
  if (node.kind === 'expression' || node.kind === 'constant' || node.kind === 'action') return ['expression'];
  if (node.kind === 'type' || node.kind === 'input' || node.kind === 'output') return ['type'];
  return [];
}

export function insertionCategories(container: SemanticGraphNode | undefined): readonly SourceFragmentCategory[] {
  switch (container?.semanticKind) {
    case 'module-container':
      return ['declaration', 'declaration_list'];
    case 'declaration-container':
      return ['declaration'];
    case 'statement-container':
      return ['statement', 'statement_list'];
    case 'argument-container':
      return ['argument'];
    case 'parameter-container':
      return ['parameter'];
    case 'element-container':
      return ['array_element'];
    case 'member-container':
      return ['object_member'];
    case 'type-member-container':
      return ['object_member'];
    case 'case-container':
      return ['switch_case'];
    case 'import-container':
      return ['import_specifier'];
    case 'initializer-container':
    case 'increment-container':
    case 'template-container':
      return ['expression'];
    case 'type-parameter-container':
      return ['type'];
    default:
      return [];
  }
}

function anchorEqual(left: SemanticGraphAnchor, right: SemanticGraphAnchor): boolean {
  return (
    left.container === right.container &&
    left.index === right.index &&
    left.before === right.before &&
    left.after === right.after
  );
}

function editTarget(edit: PrimitiveEdit): SemanticNodeId | undefined {
  if ('target' in edit) return edit.target;
  if (edit.kind === 'reorder_children') return edit.container;
  return edit.anchor.container;
}

function rejected(
  reason: PrimitiveRejectionReason,
  edit: Pick<SemanticEdit, 'editId'> | undefined,
  targets: readonly SemanticNodeId[],
  usage: SemanticEditUsage,
  message: string,
  limit?: SemanticEditLimitError,
): ApplyPrimitiveSemanticEditsResult {
  const code =
    reason === 'stale_revision'
      ? 'SE_STALE_REVISION'
      : reason === 'target_not_found'
        ? 'SE_TARGET_NOT_FOUND'
        : reason === 'target_kind_mismatch'
          ? 'SE_TARGET_KIND_MISMATCH'
          : reason === 'precondition_failed'
            ? 'SE_PRECONDITION_FAILED'
            : reason === 'conflicting_edits'
              ? 'SE_CONFLICTING_EDITS'
              : reason === 'fragment_rejected'
                ? 'SE_FRAGMENT_REJECTED'
                : reason === 'transformed_source_rejected'
                  ? 'SE_TRANSFORMED_SOURCE_REJECTED'
                  : 'SE_EDIT_LIMIT_EXCEEDED';
  const editIds = edit ? [edit.editId] : [];
  return Object.freeze({
    status: 'rejected',
    reason,
    editDiagnostics: Object.freeze([
      Object.freeze({
        code,
        message,
        editIds: Object.freeze(editIds),
        targets: Object.freeze([...targets]),
        related: Object.freeze([]),
      }),
    ]),
    editIds: Object.freeze(editIds),
    targets: Object.freeze([...targets]),
    usage,
    ...(limit ? { limit } : {}),
  });
}

const emptyUsage = (sourceBytes = 0): SemanticEditUsage =>
  Object.freeze({
    operations: 0,
    fragmentBytes: 0,
    transformedRegions: 0,
    work: 0,
    provenanceEntries: 0,
    diffBytes: 0,
    sourceBytes,
  });

/** Produces the closed rejection envelope shared by primitive and high-level edits. @internal */
export function rejectSemanticEdit(
  reason: PrimitiveRejectionReason,
  edit: Pick<SemanticEdit, 'editId'> | undefined,
  targets: readonly SemanticNodeId[],
  sourceBytes: number,
  message: string,
): ApplyPrimitiveSemanticEditsResult {
  return rejected(reason, edit, targets, emptyUsage(sourceBytes), message);
}

function typeDigest(node: SemanticGraphNode): string | undefined {
  if (!node.type) return undefined;
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object')
      return `{${Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(',')}}`;
    return JSON.stringify(value);
  };
  return hash('type', encoder.encode(canonical(node.type)));
}

function descendantSymbols(index: ModelIndex, root: SemanticNodeId): readonly SymbolId[] {
  const output: SymbolId[] = [];
  const visit = (nodeId: SemanticNodeId): void => {
    const selected = index.nodes.get(nodeId);
    if (selected?.symbolId) output.push(selected.symbolId);
    for (const child of index.children.get(nodeId) ?? []) visit(child);
  };
  visit(root);
  return Object.freeze([...new Set(output)].sort());
}

function preconditionMatches(
  condition: SemanticEditPrecondition,
  node: SemanticGraphNode,
  index: ModelIndex,
  document: EditableSourceDocument,
  anchors: readonly SemanticGraphAnchor[],
): boolean {
  switch (condition.kind) {
    case 'target_kind':
      return node.kind === condition.value;
    case 'target_semantic_kind':
      return node.semanticKind === condition.value;
    case 'old_name':
      return node.label === condition.value;
    case 'old_literal':
      return node.constant === condition.value;
    case 'old_operator':
      return node.operator === condition.value;
    case 'old_operation':
      return node.operationId === condition.value;
    case 'expected_parent':
      return index.parents.get(node.id) === condition.value;
    case 'expected_anchor':
      return anchors.some((anchor) => anchorEqual(anchor, condition.value));
    case 'expected_type':
      return typeDigest(node) === condition.value;
    case 'expected_bindings':
    case 'expected_captures':
      return JSON.stringify(descendantSymbols(index, node.id)) === JSON.stringify([...condition.value].sort());
    case 'owned_comments': {
      const range = nodeRange(node);
      if (!range) return false;
      const owned = document.ownedRange(range);
      return (owned.start !== range.start || owned.end !== range.end) === condition.value;
    }
    default:
      return false;
  }
}

export type SemanticEditPreconditionResult = 'matched' | 'target_not_found' | 'precondition_failed';

/** Checks materialized capability preconditions against one exact graph target. @internal */
export function checkSemanticEditPreconditions(
  source: SourceProgram,
  graph: SemanticGraph,
  targetId: SemanticNodeId,
  conditions: readonly SemanticEditPrecondition[],
  anchors: readonly SemanticGraphAnchor[] = [],
): SemanticEditPreconditionResult {
  const index = indexGraph(graph);
  const node = index.nodes.get(targetId);
  if (!node) return 'target_not_found';
  const document = new EditableSourceDocument(source);
  return conditions.every((condition) => preconditionMatches(condition, node, index, document, anchors))
    ? 'matched'
    : 'precondition_failed';
}

function anchorPosition(
  document: EditableSourceDocument,
  graph: SemanticGraph,
  index: ModelIndex,
  anchor: SemanticGraphAnchor,
): number | undefined {
  const exact = graph.anchors.find((candidate) => anchorEqual(candidate, anchor));
  if (!exact) return undefined;
  const container = index.nodes.get(anchor.container);
  const lineContainer =
    container?.semanticKind === 'statement-container' ||
    container?.semanticKind === 'module-container' ||
    container?.semanticKind === 'case-container';
  const before = anchor.before ? nodeRange(index.nodes.get(anchor.before)) : undefined;
  if (before) return lineContainer ? document.lineStart(before.start) : before.start;
  const after = anchor.after ? nodeRange(index.nodes.get(anchor.after)) : undefined;
  if (after) return lineContainer ? document.lineEnd(after.end) : after.end;
  const containerRange = nodeRange(container);
  if (!containerRange) return undefined;
  if (container?.semanticKind === 'module-container') return containerRange.end;
  const bytes = document.bytes.slice(containerRange.start, containerRange.end);
  const text = new TextDecoder().decode(bytes);
  const tokens: Array<Readonly<{ kind: ts.SyntaxKind; start: number; end: number }>> = [];
  const scanner = ts.createScanner(ts.ScriptTarget.ESNext, false, ts.LanguageVariant.Standard, text);
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
    tokens.push({ kind, start: scanner.getTokenPos(), end: scanner.getTextPos() });
  const byteAt = (codeUnit: number): number => containerRange.start + encoder.encode(text.slice(0, codeUnit)).length;
  const pairs = (open: ts.SyntaxKind, close: ts.SyntaxKind) => {
    const stack: number[] = [];
    const output: Array<Readonly<{ open: number; close: number }>> = [];
    for (const token of tokens) {
      if (token.kind === open) stack.push(token.end);
      else if (token.kind === close) {
        const selected = stack.pop();
        if (selected !== undefined) output.push({ open: selected, close: token.start });
      }
    }
    return output;
  };
  const pairEnd = (open: ts.SyntaxKind, close: ts.SyntaxKind): number | undefined => {
    const selected = pairs(open, close).sort((left, right) => right.close - left.close)[0];
    return selected ? byteAt(selected.close) : undefined;
  };
  switch (container?.semanticKind) {
    case 'parameter-container': {
      const selected = pairs(ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken).sort(
        (left, right) => left.open - right.open,
      )[0];
      return selected ? byteAt(selected.open) : undefined;
    }
    case 'argument-container':
      return pairEnd(ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken);
    case 'element-container':
      return pairEnd(ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.CloseBracketToken);
    case 'member-container':
    case 'type-member-container':
    case 'case-container':
    case 'statement-container':
    case 'import-container':
      return pairEnd(ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken);
    case 'type-parameter-container': {
      const parameterList = pairs(ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken).sort(
        (left, right) => left.open - right.open,
      )[0];
      return parameterList ? byteAt(parameterList.open - 1) : undefined;
    }
    case 'initializer-container':
    case 'increment-container': {
      const opening = tokens.find((token) => token.kind === ts.SyntaxKind.OpenParenToken);
      if (!opening) return undefined;
      let depth = 0;
      const separators: number[] = [];
      for (const token of tokens) {
        if (token.start < opening.start) continue;
        if (token.kind === ts.SyntaxKind.OpenParenToken) depth++;
        else if (token.kind === ts.SyntaxKind.CloseParenToken) depth--;
        else if (token.kind === ts.SyntaxKind.SemicolonToken && depth === 1) separators.push(token.end);
      }
      const codeUnit = container.semanticKind === 'initializer-container' ? opening.end : separators[1];
      return codeUnit === undefined ? undefined : byteAt(codeUnit);
    }
    case 'template-container': {
      const closing = text.lastIndexOf('`');
      return closing < 0 ? undefined : byteAt(closing);
    }
    default:
      return containerRange.end;
  }
}

function listContainer(node: SemanticGraphNode | undefined): boolean {
  return Boolean(
    node &&
    [
      'argument-container',
      'parameter-container',
      'type-parameter-container',
      'declaration-container',
      'element-container',
      'member-container',
      'type-member-container',
      'import-container',
    ].includes(node.semanticKind),
  );
}

function lineContainer(node: SemanticGraphNode | undefined): boolean {
  return Boolean(node && ['module-container', 'statement-container', 'case-container'].includes(node.semanticKind));
}

function structuralLineNode(node: SemanticGraphNode): boolean {
  return node.kind === 'statement' || node.kind === 'declaration' || node.kind === 'branch' || node.kind === 'case';
}

function printFragment(
  document: EditableSourceDocument,
  fragment: SourceFragment,
  at: number,
): CanonicalBytes | undefined {
  const printed = printSourceFragment(fragment, { newline: document.newline, indentation: document.indentationAt(at) });
  return printed.ok ? printed.bytes : undefined;
}

function printInsertionFragment(
  document: EditableSourceDocument,
  fragment: SourceFragment,
  at: number,
  container: SemanticGraphNode | undefined,
): CanonicalBytes | undefined {
  const printed = printFragment(document, fragment, at);
  if (!printed || container?.semanticKind !== 'declaration-container') return printed;
  const containerRange = nodeRange(container);
  if (!containerRange) return undefined;
  const existing = new TextDecoder().decode(document.bytes.slice(containerRange.start, containerRange.end));
  const mutability = existing.match(/\b(const|let)\b/)?.[1];
  const candidate = new TextDecoder().decode(Uint8Array.from(printed));
  const declaration = candidate.match(/^\s*(const|let)\s+([\s\S]+);\s*$/);
  if (!mutability || declaration?.[1] !== mutability || !declaration[2] || declaration[2].includes(';'))
    return undefined;
  return Object.freeze(Array.from(encoder.encode(declaration[2]))) as CanonicalBytes;
}

function primitivePlan(
  source: SourceProgram,
  graph: SemanticGraph,
  edits: readonly PrimitiveEdit[],
):
  | Readonly<{ ok: true; transformations: readonly SourceTransformation[] }>
  | Readonly<{ ok: false; result: ApplyPrimitiveSemanticEditsResult }> {
  const document = new EditableSourceDocument(source);
  const index = indexGraph(graph);
  const transformations: SourceTransformation[] = [];
  for (const edit of edits) {
    const targetId = editTarget(edit);
    const target = targetId ? index.nodes.get(targetId) : undefined;
    if (!target)
      return {
        ok: false,
        result: rejected(
          'target_not_found',
          edit,
          targetId ? [targetId] : [],
          emptyUsage(),
          'semantic target was not found',
        ),
      };
    const anchors =
      edit.kind === 'insert_at_anchor' ? [edit.anchor] : edit.kind === 'move_target' ? [edit.destination] : [];
    if (edit.preconditions.some((condition) => !preconditionMatches(condition, target, index, document, anchors)))
      return {
        ok: false,
        result: rejected(
          'precondition_failed',
          edit,
          [target.id],
          emptyUsage(document.bytes.length),
          'semantic edit precondition failed',
        ),
      };

    if (edit.kind === 'rename_symbol') {
      const bindingId =
        target.semanticKind === 'symbol'
          ? target.id
          : graph.edges.find((edge) => edge.kind === 'binds' && edge.from === target.id)?.to;
      const bindingNode = bindingId ? index.nodes.get(bindingId) : undefined;
      if (!bindingNode || bindingNode.label === undefined)
        return {
          ok: false,
          result: rejected('target_kind_mismatch', edit, [target.id], emptyUsage(), 'rename target is not a binding'),
        };
      const targets = [bindingNode.id, ...(index.references.get(bindingNode.id) ?? [])];
      for (const selected of targets) {
        const range = nodeRange(index.nodes.get(selected));
        if (!range)
          return {
            ok: false,
            result: rejected(
              'target_kind_mismatch',
              edit,
              [selected],
              emptyUsage(),
              'rename target has no editable source',
            ),
          };
        transformations.push({
          kind: 'replace',
          editId: edit.editId,
          targets: [selected],
          range,
          content: { bytes: encoder.encode(edit.newName), origin: 'generated' },
        });
      }
      continue;
    }
    if (edit.kind === 'replace_target') {
      const range = nodeRange(target);
      if (!range || !replacementCategories(target).includes(edit.replacement.category))
        return {
          ok: false,
          result: rejected(
            'fragment_rejected',
            edit,
            [target.id],
            emptyUsage(),
            'fragment category does not match target',
          ),
        };
      const bytes = printFragment(document, edit.replacement, range.start);
      if (!bytes)
        return {
          ok: false,
          result: rejected('fragment_rejected', edit, [target.id], emptyUsage(), 'fragment syntax was rejected'),
        };
      transformations.push({
        kind: 'replace',
        editId: edit.editId,
        targets: [target.id],
        range,
        content: { bytes, origin: 'fragment' },
      });
      continue;
    }
    if (edit.kind === 'insert_at_anchor') {
      const at = anchorPosition(document, graph, index, edit.anchor);
      const containerNode = index.nodes.get(edit.anchor.container);
      if (at === undefined)
        return {
          ok: false,
          result: rejected(
            'target_not_found',
            edit,
            [edit.anchor.container],
            emptyUsage(),
            'semantic anchor was not found',
          ),
        };
      if (!insertionCategories(containerNode).includes(edit.fragment.category))
        return {
          ok: false,
          result: rejected(
            'fragment_rejected',
            edit,
            [edit.anchor.container],
            emptyUsage(),
            'fragment category does not match anchor',
          ),
        };
      const printed = printInsertionFragment(document, edit.fragment, at, containerNode);
      if (!printed)
        return {
          ok: false,
          result: rejected(
            'fragment_rejected',
            edit,
            [edit.anchor.container],
            emptyUsage(),
            'fragment syntax was rejected',
          ),
        };
      let bytes = Uint8Array.from(printed);
      const emptyAnchor = !edit.anchor.before && !edit.anchor.after;
      if (containerNode?.semanticKind === 'template-container') {
        bytes = Uint8Array.from([...encoder.encode('${'), ...bytes, ...encoder.encode('}')]);
      } else if (containerNode?.semanticKind === 'type-parameter-container' && emptyAnchor) {
        bytes = Uint8Array.from([...encoder.encode('<'), ...bytes, ...encoder.encode('>')]);
      } else if (listContainer(containerNode)) {
        if (edit.anchor.before) bytes = Uint8Array.from([...bytes, ...encoder.encode(', ')]);
        else if (edit.anchor.after) bytes = Uint8Array.from([...encoder.encode(', '), ...bytes]);
      } else if (lineContainer(containerNode)) {
        const indentation = document.indentationAt(
          edit.anchor.before
            ? (nodeRange(index.nodes.get(edit.anchor.before))?.start ?? at)
            : (nodeRange(index.nodes.get(edit.anchor.after as SemanticNodeId))?.start ?? at),
        );
        const emptyIndentation = emptyAnchor && containerNode?.semanticKind !== 'module-container' ? '  ' : '';
        const needsLeadingNewline = emptyAnchor && at > 0 && document.bytes[at - 1] !== 0x0a;
        bytes = Uint8Array.from([
          ...(needsLeadingNewline ? encoder.encode(document.newline) : []),
          ...encoder.encode(indentation + emptyIndentation),
          ...bytes,
          ...encoder.encode(document.newline),
        ]);
      }
      transformations.push({
        kind: 'insert',
        editId: edit.editId,
        targets: [],
        at,
        content: { bytes, origin: 'fragment' },
      });
      continue;
    }
    if (edit.kind === 'delete_target') {
      const range = nodeRange(target);
      if (!range)
        return {
          ok: false,
          result: rejected('target_kind_mismatch', edit, [target.id], emptyUsage(), 'delete target is not editable'),
        };
      transformations.push({
        kind: 'delete',
        editId: edit.editId,
        targets: [target.id],
        range: structuralLineNode(target) ? document.lineRange(range) : range,
        commentPolicy: edit.commentPolicy,
      });
      continue;
    }
    if (edit.kind === 'move_target') {
      const range = nodeRange(target);
      const destination = anchorPosition(document, graph, index, edit.destination);
      if (!range || destination === undefined)
        return {
          ok: false,
          result: rejected(
            'target_not_found',
            edit,
            [target.id],
            emptyUsage(),
            'move target or destination was not found',
          ),
        };
      transformations.push({
        kind: 'move',
        editId: edit.editId,
        targets: [target.id],
        range: structuralLineNode(target) ? document.lineRange(range) : range,
        destination,
      });
      continue;
    }
    const current = index.children.get(target.id) ?? [];
    if (
      current.length !== edit.children.length ||
      new Set(current).size !== new Set(edit.children).size ||
      edit.children.some((child) => !current.includes(child))
    )
      return {
        ok: false,
        result: rejected(
          'precondition_failed',
          edit,
          [target.id],
          emptyUsage(),
          'reorder must name the complete child set',
        ),
      };
    if (current.every((child, index) => edit.children[index] === child)) continue;
    const rangeByChild = new Map(current.map((child) => [child, nodeRange(index.nodes.get(child))]));
    const orderedRanges = current.map((child) => {
      const selected = index.nodes.get(child);
      const range = rangeByChild.get(child);
      return range && selected && structuralLineNode(selected) ? document.lineRange(document.ownedRange(range)) : range;
    });
    if (orderedRanges.some((range) => range === undefined))
      return {
        ok: false,
        result: rejected('target_kind_mismatch', edit, [target.id], emptyUsage(), 'reorder child is not editable'),
      };
    const typed = orderedRanges as readonly SourceByteRange[];
    const removal = {
      start: typed[0]?.start as number,
      end: typed.at(-1)?.end as number,
    };
    const gaps = typed.slice(0, -1).map((range, index) => {
      const next = typed[index + 1] as SourceByteRange;
      return document.bytes.slice(range.end, next.start);
    });
    const desiredRanges = edit.children.map((child) => {
      const position = current.indexOf(child);
      return typed[position] as SourceByteRange;
    });
    const bytes = desiredRanges.flatMap((range, index) => [
      ...document.bytes.slice(range.start, range.end),
      ...(gaps[index] ?? []),
    ]);
    transformations.push({
      kind: 'replace',
      editId: edit.editId,
      targets: [...edit.children],
      range: removal,
      content: { bytes, origin: 'generated' },
    });
  }
  return { ok: true, transformations: Object.freeze(transformations) };
}

/** Applies only the six foundational operations; gesture normalization is layered above this seam. */
export function applyPrimitiveSemanticEdits(
  source: SourceProgram,
  graph: SemanticGraph,
  baseRevision: SemanticRevisionId,
  edits: readonly SemanticEdit[],
  limits: SemanticEditLimits,
  validate?: CandidateValidator,
): ApplyPrimitiveSemanticEditsResult {
  if (baseRevision !== graph.semanticRevision)
    return rejected(
      'stale_revision',
      undefined,
      [],
      emptyUsage(source.source.length),
      'base semantic revision is stale',
    );
  const primitive = edits.filter((edit): edit is PrimitiveEdit =>
    PRIMITIVE_OPERATIONS.includes(edit.kind as PrimitiveEdit['kind']),
  );
  if (primitive.length !== edits.length)
    return rejected(
      'target_kind_mismatch',
      undefined,
      [],
      emptyUsage(source.source.length),
      'gesture was not normalized to primitive edits',
    );
  const planned = primitivePlan(source, graph, primitive);
  if (!planned.ok) return planned.result;
  const transformed = applySourceTransformations(
    new EditableSourceDocument(source),
    planned.transformations,
    limits,
    validate,
  );
  if (transformed.status !== 'accepted') {
    const selected =
      primitive.find((edit) => transformed.conflicts?.some((conflict) => conflict.editIds.includes(edit.editId))) ??
      primitive[0];
    const reason =
      transformed.reason === 'conflicting_transformations'
        ? 'conflicting_edits'
        : transformed.reason === 'candidate_rejected'
          ? 'transformed_source_rejected'
          : transformed.reason === 'limit_exceeded'
            ? 'edit_limit_exceeded'
            : 'target_kind_mismatch';
    return rejected(
      reason,
      selected,
      transformed.conflicts?.flatMap((conflict) => conflict.targets) ?? [],
      transformed.usage,
      transformed.reason,
      transformed.limit,
    );
  }
  const outcomes = primitive.map((edit): SemanticEditOutcome => {
    const changedRegions = transformed.changedRegions.flatMap((region, index) =>
      region.editIds.includes(edit.editId) ? [index] : [],
    );
    const targets = planned.transformations
      .filter((item) => item.editId === edit.editId)
      .flatMap((item) => item.targets);
    return Object.freeze({
      editId: edit.editId,
      targets: Object.freeze([...new Set(targets)]),
      changedRegions: Object.freeze(changedRegions),
    });
  });
  return Object.freeze({
    status: 'accepted',
    source: transformed.source,
    outcomes: Object.freeze(outcomes),
    changedRegions: transformed.changedRegions,
    provenance: transformed.provenance,
    diff: Object.freeze({ entries: Object.freeze([]) }),
    usage: transformed.usage,
  });
}

/** Coverage audit used to prevent an accepted syntax node or insertion site from escaping the primitive kernel. */
export function primitiveEditCoverage(graph: SemanticGraph): PrimitiveEditCoverage {
  const index = indexGraph(graph);
  const uncoveredNodes = graph.nodes
    .filter((node) => node.editable)
    .filter((node) => node.kind !== 'container' && replacementCategories(node).length === 0 && node.kind !== 'binding')
    .map((node) => node.id);
  const uncoveredAnchors = graph.anchors.filter(
    (anchor) => insertionCategories(index.nodes.get(anchor.container)).length === 0,
  );
  return Object.freeze({
    operations: PRIMITIVE_OPERATIONS,
    uncoveredNodes: Object.freeze(uncoveredNodes),
    uncoveredAnchors: Object.freeze(uncoveredAnchors),
  });
}
