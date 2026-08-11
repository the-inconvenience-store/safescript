import { useEffect, useMemo, useState } from 'react';

import type { OperationId, SemanticGraphAnchor, SemanticNodeId } from '@safescript/contracts';

import type { SemanticIntent } from '../../editor/operations.js';
import type { AcceptedBuildingDocument } from '../../runtime.js';

export function Inspector({
  document,
  selected,
  busy,
  onEdit,
}: Readonly<{
  document: AcceptedBuildingDocument;
  selected: string | undefined;
  busy: boolean;
  onEdit: (intent: SemanticIntent) => void;
}>) {
  const node = document.flow.nodes.find(({ id }) => id === selected);
  const [value, setValue] = useState('');
  useEffect(() => setValue(node?.detail ?? ''), [node?.id]);
  const capability = (kind: string) => node?.controls.find(({ operation }) => operation === kind)?.capability;
  const children = useMemo(
    () =>
      node
        ? document.graph.edges
            .filter(({ kind, from, index }) => kind === 'contains' && from === node.semanticId && index !== undefined)
            .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
            .map(({ to }) => to)
        : [],
    [document.graph.edges, node],
  );
  if (!node)
    return (
      <aside className="inspector empty-state" aria-label="Edit inspector">
        <span className="eyebrow">Capability inspector</span>
        <h2>Select a node</h2>
        <p>Every control shown here comes from the current semantic edit capability manifest.</p>
      </aside>
    );

  const submit = (intent: SemanticIntent) => onEdit(intent);
  const literal = capability('set_literal_value');
  const rename = capability('rename_symbol');
  const replace = capability('replace_target');
  const operators = capability('change_operator');
  const action = capability('change_action_operation');
  const actionInput = capability('set_action_input_field');
  const insert = capability('insert_at_anchor');
  const reorder = capability('reorder_children');
  const moveRange = capability('move_statement_range');
  const remove = capability('delete_target');

  return (
    <aside className="inspector" aria-label={`Edit ${node.title}`}>
      <span className="eyebrow">
        {node.type} · {node.controls.length} advertised edits
      </span>
      <h2>{node.title}</h2>
      <p className="semantic-id" title={node.semanticId}>
        {node.semanticId.slice(0, 30)}…
      </p>
      {(literal || rename || replace) && (
        <fieldset>
          <legend>Meaning</legend>
          <label htmlFor="edit-value">New value or source fragment</label>
          <input id="edit-value" value={value} onChange={(event) => setValue(event.target.value)} />
          <div className="button-row">
            {literal && (
              <button
                type="button"
                disabled={busy}
                onClick={() => submit({ kind: 'set_literal', target: node.semanticId, value })}
              >
                Set literal
              </button>
            )}
            {rename && (
              <button
                type="button"
                disabled={busy}
                onClick={() => submit({ kind: 'rename_symbol', target: node.semanticId, name: value })}
              >
                Rename symbol
              </button>
            )}
            {replace?.fragmentCategories.includes('expression') && (
              <button
                type="button"
                disabled={busy}
                onClick={() => submit({ kind: 'replace_condition', target: node.semanticId, source: value })}
              >
                Replace expression
              </button>
            )}
          </div>
        </fieldset>
      )}
      {operators && operators.operators.length > 0 && (
        <fieldset>
          <legend>Operator</legend>
          <select
            aria-label="Replacement operator"
            defaultValue={node.detail.replace('operator ', '')}
            onChange={(event) =>
              submit({ kind: 'change_operator', target: node.semanticId, operator: event.target.value })
            }
            disabled={busy}
          >
            {operators.operators.map((operator) => (
              <option key={operator}>{operator}</option>
            ))}
          </select>
        </fieldset>
      )}
      {action && (
        <fieldset>
          <legend>Host action</legend>
          <label htmlFor="operation">Compatible operation</label>
          <select
            id="operation"
            defaultValue={document.graph.nodes.find(({ id }) => id === node.semanticId)?.operationId}
            disabled={busy}
            onChange={(event) =>
              submit({ kind: 'change_action', target: node.semanticId, operation: event.target.value as OperationId })
            }
          >
            {action.operations.map((operation) => (
              <option key={operation} value={operation}>
                {operation.replace('operation:', '')}
              </option>
            ))}
          </select>
          {actionInput && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                submit({
                  kind: 'set_action_input',
                  target: node.semanticId,
                  path: ['value'],
                  source: value,
                })
              }
            >
              Set action value
            </button>
          )}
        </fieldset>
      )}
      {insert && (
        <fieldset>
          <legend>Statements</legend>
          <label htmlFor="statement">Statement fragment</label>
          <input
            id="statement"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="const sample = 1n"
          />
          <button
            type="button"
            disabled={busy || insert.anchors.length === 0}
            onClick={() => {
              const anchor = insert.anchors.at(-1);
              if (anchor)
                submit({ kind: 'insert_statement', container: node.semanticId, index: anchor.index, source: value });
            }}
          >
            Add at end
          </button>
          {reorder && children.length > 1 && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                submit({ kind: 'reorder_statements', container: node.semanticId, children: [...children].reverse() })
              }
            >
              Reverse statement order
            </button>
          )}
          {moveRange && children[0] && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const destination = moveRange.anchors.find(
                  (anchor: SemanticGraphAnchor) =>
                    anchor.container === node.semanticId && anchor.index === children.length,
                );
                if (destination)
                  submit({
                    kind: 'move_statement_range',
                    container: node.semanticId,
                    first: children[0] as SemanticNodeId,
                    last: children[0] as SemanticNodeId,
                    destination,
                  });
              }}
            >
              Move first statement to end
            </button>
          )}
        </fieldset>
      )}
      {remove && (
        <button
          className="button button--danger"
          type="button"
          disabled={busy}
          onClick={() => submit({ kind: 'delete_statement', target: node.semanticId })}
        >
          Remove selected construct
        </button>
      )}
    </aside>
  );
}
