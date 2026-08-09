import { describe, expect, it } from 'bun:test';

import {
  derivedActionSiteId,
  deriveIdempotencyKey,
  encodeCanonical,
  hash,
  ids,
  type ActionRequest,
  type ExecutionFacts,
  type IrDigest,
  type RuntimeBridge,
} from '@safescript/contracts';
import {
  ProcessRuntimeBridge,
  createSafeScript,
  defineContract,
  type ContractType,
  type ProcessWorkerTransport,
} from '@safescript/sdk';
import { RuntimeWorkerServer } from '@safescript/worker';

interface Input {
  readonly value: bigint;
}
type HostError = string;

const inputType: ContractType<Input> = {
  id: ids.type('type:conformance.input'),
  schema: { kind: 'record', fields: [{ name: 'value', schema: { kind: 'int64' } }] },
};
const outputType: ContractType<string> = {
  id: ids.type('type:conformance.output'),
  schema: { kind: 'string', maxBytes: 128 },
};
const errorType: ContractType<HostError> = {
  id: ids.type('type:conformance.error'),
  schema: { kind: 'string' },
};
const effect = ids.effect('effect:conformance.read');
const capability = ids.capability('capability:conformance.read');
const operationId = ids.operation('operation:conformance.read');
const slotId = ids.slot('slot:conformance.run');
const moduleId = ids.module('module:conformance/sdk');
const invocationId = ids.invocation('invocation:abcdefabcdefabcdefabcdefabcdefab');
const irDigest = hash('ir', Uint8Array.of(1)) as unknown as IrDigest;

const contract = defineContract({
  id: ids.contract('contract:conformance.sdk'),
  version: { major: 1, minor: 0, patch: 0 },
  operations: {
    read: {
      id: operationId,
      input: inputType,
      output: outputType,
      error: errorType,
      effect,
      capability,
      effectCost: 1,
      idempotency: 'required' as const,
    },
  },
  slots: {
    run: {
      id: slotId,
      input: inputType,
      output: outputType,
      languageVersion: { major: 1, minor: 1 },
      effects: [effect],
      capabilities: [capability],
    },
  },
});

const usage = Object.freeze({
  fuel: 1,
  allocations: 0,
  allocatedBytes: 0,
  peakRetainedBytes: 0,
  peakCollectionItems: 0,
  peakValueDepth: 1,
  peakValueNodes: 1,
  peakValueBytes: 1,
  peakCallDepth: 1,
  hostCalls: 1,
  peakConcurrentActions: 1,
  traceBytes: 0,
  outputBytes: 5,
});

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  readonly #values: Uint8Array[] = [];
  readonly #waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  #ended = false;

  push(value: Uint8Array): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.#ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function throughWorker(bridge: RuntimeBridge): RuntimeBridge {
  const incoming = new AsyncByteQueue();
  const connection: { server?: RuntimeWorkerServer } = {};
  const transport: ProcessWorkerTransport = {
    incoming,
    write: (frame) => connection.server?.receive(frame),
    close: () => connection.server?.finish(),
  };
  connection.server = new RuntimeWorkerServer({
    bridge,
    write: (frame) => incoming.push(frame),
    close: () => incoming.end(),
  });
  return new ProcessRuntimeBridge({ transport });
}

const adapters: Array<[string, (bridge: RuntimeBridge) => RuntimeBridge]> = [
  ['in-process', (bridge) => bridge],
  ['worker', throughWorker],
];

describe('public SDK conformance', () => {
  it.each(adapters)('%s adapter preserves SDK hook boundaries around a typed action', async (_name, adapt) => {
    let bridgeRequestInput: readonly number[] = [];
    let observedAction: ActionRequest | undefined;
    const facts: ExecutionFacts = {
      preparation: { kind: 'artifact', irDigest },
      actions: [],
      trace: { records: [], truncated: false },
      usage,
    };
    const bridge: RuntimeBridge = {
      check: async () => ({
        status: 'rejected',
        diagnostics: [],
        usage: { sourceBytes: 0, syntaxNodes: 0, typeWork: 0 },
      }),
      inspect: async () => ({
        status: 'rejected',
        diagnostics: [],
        usage: { sourceBytes: 0, syntaxNodes: 0, typeWork: 0 },
      }),
      execute: async (request, host) => {
        bridgeRequestInput = request.input;
        const actionSiteId = derivedActionSiteId(Uint8Array.of(1));
        const key = deriveIdempotencyKey({
          seed: request.idempotencySeed ?? [],
          contractId: contract.id,
          operationId,
          actionSiteId,
          sequence: 0,
          actionInput: request.input,
        });
        if (!key.ok) throw new Error(key.failure.code);
        const action: ActionRequest = {
          abiVersion: { major: 2, minor: 0 },
          contractId: contract.id,
          requiredContractVersion: contract.version,
          irDigest,
          invocationId: request.invocationId,
          requestId: ids.request(request.invocationId, 0),
          slotId,
          operationId,
          effectId: effect,
          capabilityId: capability,
          actionSiteId,
          source: { module: moduleId, start: 0, end: 1 },
          input: request.input,
          idempotencyKey: key.value,
        };
        observedAction = action;
        const outcome = await host.handleAction(action);
        const output = encodeCanonical({ kind: 'string' }, 'done');
        if (!output.ok) throw new Error(output.failure.code);
        return {
          status: 'completed',
          output: [...output.value],
          facts: {
            ...facts,
            actions: [
              { phase: 'requested', request: action },
              { phase: 'resolved', requestId: action.requestId, outcome },
            ],
          },
        };
      },
      cancel: async () => ({ status: 'not_active' }),
      close: async () => ({ status: 'closed' }),
    };
    const events: string[] = [];
    const safe = createSafeScript<{ tenant: string }, typeof contract.operations, typeof contract.slots>({
      contract,
      bridge: adapt(bridge),
      createInvocationId: () => invocationId,
      handlers: {
        read: (input, context) => {
          events.push(`handle:${context.context.tenant}:${input.value}`);
          return { tag: 'ok', value: 'host-value' };
        },
      },
      hooks: {
        beforeExecute: () => {
          events.push('before-execute');
          return { status: 'continue' };
        },
        beforeAction: () => {
          events.push('before-action');
          return { status: 'continue' };
        },
        afterAction: () => events.push('after-action'),
        afterExecute: () => events.push('after-execute'),
      },
    });
    const result = await safe.execute({
      slot: 'run',
      program: {
        kind: 'source',
        source: { entryModule: moduleId, modules: [{ id: moduleId, source: 'export async function ignored() {}' }] },
      },
      input: { value: 7n },
      context: { tenant: 'acme' },
      idempotencySeed: Uint8Array.of(1),
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.output).toBe('done');
    expect(events).toEqual(['before-execute', 'before-action', 'handle:acme:7', 'after-action', 'after-execute']);
    expect(observedAction?.invocationId).toBe(invocationId);
    const encodedInput = encodeCanonical(inputType.schema, { value: 7n });
    expect(encodedInput.ok).toBe(true);
    if (encodedInput.ok) expect(bridgeRequestInput).toEqual([...encodedInput.value]);
    expect(result.status === 'completed' ? result.facts.actions.map(({ phase }) => phase) : []).toEqual([
      'requested',
      'resolved',
    ]);
    await safe.close();
  });
});
