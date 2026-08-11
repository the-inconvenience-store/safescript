import { useEffect, useState } from 'react';

import type { OperationId } from '@safescript/contracts';

import { moveBuildingStep } from '../../editor/composer.js';
import type { SemanticIntent } from '../../editor/operations.js';
import type { AcceptedBuildingDocument } from '../../runtime.js';

const literalInput = (value: string, source: string): null | boolean | number | string => {
  if (source === 'null') return null;
  if (source === 'true') return true;
  if (source === 'false') return false;
  if (/^-?\d+(?:\.\d+)?n?$/.test(source) && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
};

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
  const control = (kind: string) => node?.controls.find(({ operation }) => operation === kind);
  const literal = control('set_literal_value');
  const rename = control('rename_symbol');
  const replace = control('replace_target');
  const operators = control('change_operator');
  const action = control('change_action_operation');
  const actionInput = control('set_action_input_field');
  const remove = control('delete_target');
  const graphNode = (target: string | undefined) => document.graph.nodes.find(({ id }) => id === target);
  const literalNode = graphNode(literal?.target);
  const renameNode = graphNode(rename?.target);
  const operatorNode = graphNode(operators?.target);
  const sourceFor = (target: typeof literalNode): string => {
    if (!target?.source) return '';
    const bytes = new TextEncoder().encode(document.acceptedSource.source);
    return new TextDecoder().decode(bytes.slice(target.source.start, target.source.end));
  };
  const [conditionValue, setConditionValue] = useState('');
  const [literalValue, setLiteralValue] = useState('');
  const [nameValue, setNameValue] = useState('');
  const [actionValue, setActionValue] = useState('');
  useEffect(() => {
    setConditionValue(node?.detail.replace(/^When\s*/, '') ?? '');
    setLiteralValue(literalNode?.constant === undefined ? '' : String(literalNode.constant));
    setNameValue(renameNode?.label ?? '');
    setActionValue(node?.detail.replace(/^Value ·\s*/, '') ?? '');
  }, [document.graph.semanticRevision, literalNode?.id, node?.id, renameNode?.id]);
  if (!node)
    return (
      <aside className="inspector empty-state" aria-label="Edit inspector">
        <span className="eyebrow">Capability inspector</span>
        <h2>Select a node</h2>
        <p>Every control shown here comes from the current semantic edit capability manifest.</p>
      </aside>
    );

  const submit = (intent: SemanticIntent) => onEdit(intent);
  const moveEarlier = moveBuildingStep(document, node, 'earlier');
  const moveLater = moveBuildingStep(document, node, 'later');

  return (
    <aside className="inspector" aria-label={`Edit ${node.title}`}>
      <span className="eyebrow">
        {node.type} · {node.controls.length} advertised edits
      </span>
      <h2>{node.title}</h2>
      <p className="semantic-id" title={node.semanticId}>
        {node.semanticId.slice(0, 30)}…
      </p>
      {replace?.capability.fragmentCategories.includes('expression') && (
        <fieldset>
          <legend>Condition</legend>
          <label htmlFor="condition-value">Condition expression</label>
          <input
            id="condition-value"
            value={conditionValue}
            onChange={(event) => setConditionValue(event.target.value)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => submit({ kind: 'replace_condition', target: replace.target, source: conditionValue })}
          >
            Update condition
          </button>
        </fieldset>
      )}
      {literal && literalNode && (
        <fieldset>
          <legend>Literal</legend>
          <label htmlFor="literal-value">Literal value</label>
          <input id="literal-value" value={literalValue} onChange={(event) => setLiteralValue(event.target.value)} />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              submit({
                kind: 'set_literal',
                target: literal.target,
                value: literalInput(literalValue, sourceFor(literalNode)),
              })
            }
          >
            Update literal
          </button>
        </fieldset>
      )}
      {rename && (
        <fieldset>
          <legend>Symbol</legend>
          <label htmlFor="symbol-name">Symbol name</label>
          <input id="symbol-name" value={nameValue} onChange={(event) => setNameValue(event.target.value)} />
          <button
            type="button"
            disabled={busy}
            onClick={() => submit({ kind: 'rename_symbol', target: rename.target, name: nameValue })}
          >
            Rename symbol
          </button>
        </fieldset>
      )}
      {operators && operators.capability.operators.length > 0 && (
        <fieldset>
          <legend>Operator</legend>
          <select
            aria-label="Replacement operator"
            defaultValue={operatorNode?.operator}
            onChange={(event) =>
              submit({ kind: 'change_operator', target: operators.target, operator: event.target.value })
            }
            disabled={busy}
          >
            {operators.capability.operators.map((operator) => (
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
            defaultValue={document.graph.nodes.find(({ id }) => id === action.target)?.operationId}
            disabled={busy}
            onChange={(event) =>
              submit({ kind: 'change_action', target: action.target, operation: event.target.value as OperationId })
            }
          >
            {action.capability.operations.map((operation) => (
              <option key={operation} value={operation}>
                {operation.replace('operation:', '')}
              </option>
            ))}
          </select>
          {actionInput && (
            <>
              <label htmlFor="action-value">Action value expression</label>
              <input id="action-value" value={actionValue} onChange={(event) => setActionValue(event.target.value)} />
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  submit({
                    kind: 'set_action_input',
                    target: actionInput.target,
                    path: ['value'],
                    source: actionValue,
                  })
                }
              >
                Set action value
              </button>
            </>
          )}
        </fieldset>
      )}
      {(moveEarlier || moveLater) && (
        <fieldset>
          <legend>Position</legend>
          <div className="button-row">
            <button type="button" disabled={busy || !moveEarlier} onClick={() => moveEarlier && submit(moveEarlier)}>
              Move earlier
            </button>
            <button type="button" disabled={busy || !moveLater} onClick={() => moveLater && submit(moveLater)}>
              Move later
            </button>
          </div>
        </fieldset>
      )}
      {remove && (
        <button
          className="button button--danger"
          type="button"
          disabled={busy}
          onClick={() => submit({ kind: 'delete_statement', target: remove.target })}
        >
          Delete step
        </button>
      )}
    </aside>
  );
}
