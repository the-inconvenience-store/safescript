/** Correlates one transformation batch with rebuilt semantic identities. @internal */
import type {
  SemanticChangedRegion,
  SemanticDiff,
  SemanticDiffEntry,
  SemanticEdit,
  SemanticEditId,
  SemanticGraph,
  SemanticGraphNode,
  SemanticNodeId,
} from '@safescript/contracts';

function contained(node: SemanticGraphNode, range: NonNullable<SemanticChangedRegion['original']>): boolean {
  return Boolean(
    node.editable &&
    node.editable.module === range.module &&
    node.editable.start >= range.start &&
    node.editable.end <= range.end,
  );
}

function ordered(nodes: readonly SemanticGraphNode[]): readonly SemanticGraphNode[] {
  return [...nodes].sort(
    (left, right) =>
      (left.editable?.start ?? 0) - (right.editable?.start ?? 0) ||
      (left.editable?.end ?? 0) - (right.editable?.end ?? 0) ||
      left.id.localeCompare(right.id),
  );
}

function semanticShape(node: SemanticGraphNode): string {
  return `${node.kind}:${node.semanticKind}`;
}

function relationKind(
  editIds: readonly SemanticEditId[],
  edits: ReadonlyMap<SemanticEditId, SemanticEdit>,
): SemanticDiffEntry['kind'] {
  const kinds = editIds.flatMap((id) => edits.get(id)?.kind ?? []);
  if (kinds.some((kind) => kind === 'rename_symbol')) return 'renamed';
  if (kinds.some((kind) => kind === 'move_target' || kind === 'move_statement_range' || kind === 'reorder_children'))
    return 'moved';
  return 'updated';
}

function entry(
  kind: SemanticDiffEntry['kind'],
  before: readonly SemanticNodeId[],
  after: readonly SemanticNodeId[],
  editIds: readonly SemanticEditId[],
): SemanticDiffEntry {
  return Object.freeze({
    kind,
    before: Object.freeze([...before]),
    after: Object.freeze([...after]),
    editIds: Object.freeze([...editIds]),
  });
}

/** Produces deterministic old/new identity relations from exact changed regions and rebuilt graphs. */
export function buildSemanticDiff(
  before: SemanticGraph,
  after: SemanticGraph,
  edits: readonly SemanticEdit[],
  changedRegions: readonly SemanticChangedRegion[],
): SemanticDiff {
  const editById = new Map(edits.map((edit) => [edit.editId, edit]));
  const matchedBefore = new Set<SemanticNodeId>();
  const matchedAfter = new Set<SemanticNodeId>();
  const entries: SemanticDiffEntry[] = [];
  const afterById = new Map(after.nodes.map((node) => [node.id, node]));
  const preserved: SemanticNodeId[] = [];

  for (const node of [...before.nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const selected = afterById.get(node.id);
    if (!selected) continue;
    matchedBefore.add(node.id);
    matchedAfter.add(selected.id);
    preserved.push(node.id);
  }

  for (const region of changedRegions) {
    if (!region.original && !region.updated) continue;
    const original = region.original;
    const updated = region.updated;
    const oldNodes = original ? ordered(before.nodes.filter((node) => contained(node, original))) : [];
    const newNodes = updated ? ordered(after.nodes.filter((node) => contained(node, updated))) : [];
    const shapes = new Set([...oldNodes, ...newNodes].map(semanticShape));
    const kind = relationKind(region.editIds, editById);
    for (const shape of [...shapes].sort()) {
      const oldGroup = oldNodes.filter((node) => semanticShape(node) === shape && !matchedBefore.has(node.id));
      const newGroup = newNodes.filter((node) => semanticShape(node) === shape && !matchedAfter.has(node.id));
      if (oldGroup.length === 0 || newGroup.length === 0) continue;
      oldGroup.forEach((node) => matchedBefore.add(node.id));
      newGroup.forEach((node) => matchedAfter.add(node.id));
      entries.push(
        entry(
          oldGroup.length === 1 && newGroup.length > 1
            ? 'split'
            : oldGroup.length > 1 && newGroup.length === 1
              ? 'merged'
              : kind,
          oldGroup.map((node) => node.id),
          newGroup.map((node) => node.id),
          region.editIds,
        ),
      );
    }
  }

  for (const nodeId of preserved) entries.push(entry('preserved', [nodeId], [nodeId], []));

  const allEditIds = Object.freeze(edits.map((edit) => edit.editId));
  for (const node of [...before.nodes].sort((left, right) => left.id.localeCompare(right.id)))
    if (!matchedBefore.has(node.id)) entries.push(entry('removed', [node.id], [], allEditIds));
  for (const node of [...after.nodes].sort((left, right) => left.id.localeCompare(right.id)))
    if (!matchedAfter.has(node.id)) entries.push(entry('added', [], [node.id], allEditIds));

  return Object.freeze({ entries: Object.freeze(entries) });
}
