/**
 * Deterministic scripted host adapter and test-result comparison helpers.
 * @packageDocumentation
 */
import {
  encodeCanonical,
  resultSchema,
  type ActionOutcome,
  type ActionRequest,
  type OperationId,
  type RuntimeBridgeHost,
} from '@safescript/contracts';

import type { Contract, Operations, Slots } from './contract.js';
import type { OperationEntry } from './gateway.js';
import { freeze, stable } from './shared.js';
import type { ExecutionResult, ScriptedAction, TestExpectation, TestMismatch } from './types.js';

function mismatch(path: string, expected: unknown, actual: unknown): TestMismatch {
  return Object.freeze({ path, expected, actual });
}

/**
 * Mutable bookkeeping retained by one deterministic test-host adapter.
 * @internal
 */
export interface ScriptedHost {
  readonly host: RuntimeBridgeHost;
  readonly mismatches: TestMismatch[];
  finish(): void;
}

/**
 * Creates a host adapter that consumes one exact ordered action script without production authority or handlers.
 * @internal
 */
export function createScriptedHost<O extends Operations, S extends Slots>(
  contract: Contract<O, S>,
  operationsById: ReadonlyMap<OperationId, OperationEntry<O>>,
  scripts: readonly ScriptedAction<O>[],
): ScriptedHost {
  const mismatches: TestMismatch[] = [];
  const seenRequests = new Set<string>();
  let index = 0;
  const host: RuntimeBridgeHost = {
    async handleAction(action: ActionRequest): Promise<ActionOutcome> {
      const script = scripts[index++];
      const fail = (): ActionOutcome =>
        freeze({
          requestId: action.requestId,
          result: {
            tag: 'failed',
            value: { effectState: 'not_performed', failure: { code: 'gateway_fault' } },
          },
        });
      if (seenRequests.has(action.requestId)) {
        mismatches.push(mismatch(`actions[${index - 1}].requestId`, 'unique request', action.requestId));
        return fail();
      }
      seenRequests.add(action.requestId);
      if (!script) {
        mismatches.push(mismatch(`actions[${index - 1}]`, 'scripted action', undefined));
        return fail();
      }
      const entry =
        typeof script.operation === 'string' && script.operation in contract.operations
          ? contract.operations[script.operation]
          : operationsById.get(script.operation as OperationId)?.operation;
      if (!entry || entry.id !== action.operationId) {
        mismatches.push(mismatch(`actions[${index - 1}].operation`, script.operation, action.operationId));
        return fail();
      }
      const expected = encodeCanonical({ kind: 'ref', type: entry.input.id }, script.input, {
        registry: contract.registry.schemas,
      });
      if (
        !expected.ok ||
        expected.value.length !== action.input.length ||
        !expected.value.every((byte, byteIndex) => byte === action.input[byteIndex])
      ) {
        mismatches.push(mismatch(`actions[${index - 1}].input`, script.input, action.input));
        return fail();
      }
      if ('status' in script.outcome && script.outcome.status === 'failed') {
        return freeze({
          requestId: action.requestId,
          result: {
            tag: 'failed',
            value: { effectState: script.outcome.effectState, failure: script.outcome.failure },
          },
        });
      }
      const encoded = encodeCanonical(
        resultSchema({ kind: 'ref', type: entry.output.id }, { kind: 'ref', type: entry.error.id }),
        script.outcome,
        { registry: contract.registry.schemas },
      );
      return encoded.ok
        ? freeze({
            requestId: action.requestId,
            result: { tag: 'completed', value: [...encoded.value] },
          })
        : fail();
    },
  };
  return {
    host,
    mismatches,
    finish(): void {
      if (index < scripts.length) mismatches.push(mismatch('actions.length', scripts.length, index));
    },
  };
}

/**
 * Appends stable mismatches for every explicitly requested observable expectation.
 * @internal
 */
export function compareExpectations<O>(
  expected: TestExpectation<O> | undefined,
  execution: ExecutionResult<O>,
  mismatches: TestMismatch[],
): void {
  if (expected?.status !== undefined && expected.status !== execution.status) {
    mismatches.push(mismatch('status', expected.status, execution.status));
  }
  if (
    expected?.output !== undefined &&
    (execution.status !== 'completed' || stable(expected.output) !== stable(execution.output))
  ) {
    mismatches.push(
      mismatch('output', expected.output, execution.status === 'completed' ? execution.output : undefined),
    );
  }
  if (expected?.operations !== undefined) {
    const actual =
      execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled'
        ? execution.facts.actions
            .filter((record) => record.phase === 'requested')
            .map((record) => record.request.operationId)
        : [];
    if (stable(expected.operations) !== stable(actual))
      mismatches.push(mismatch('operations', expected.operations, actual));
  }
  if (expected?.actions !== undefined) {
    const actual =
      execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled'
        ? execution.facts.actions
        : [];
    if (stable(expected.actions) !== stable(actual)) mismatches.push(mismatch('actions', expected.actions, actual));
  }
  if (expected?.diagnostics !== undefined) {
    const actual = execution.status === 'not_started' ? (execution.diagnostics ?? []) : [];
    if (stable(expected.diagnostics) !== stable(actual)) {
      mismatches.push(mismatch('diagnostics', expected.diagnostics, actual));
    }
  }
  if (expected?.resources !== undefined) {
    const actual =
      execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled'
        ? execution.facts.usage
        : undefined;
    for (const [key, value] of Object.entries(expected.resources)) {
      if (actual?.[key as keyof typeof actual] !== value) {
        mismatches.push(mismatch(`resources.${key}`, value, actual?.[key as keyof typeof actual]));
      }
    }
  }
}

/**
 * Creates one immutable path-addressed mismatch.
 * @internal
 */
export function testMismatch(path: string, expected: unknown, actual: unknown): TestMismatch {
  return mismatch(path, expected, actual);
}
