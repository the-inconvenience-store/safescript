import { describe, expect, it } from 'bun:test';

import {
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  derivedActionSiteId,
  encodeCanonical,
  hash,
  ids,
  type ActionOutcome,
  type ActionRequest,
  type CancelResult,
  type CheckResult,
  type CloseResult,
  type ExecuteRequest as BridgeExecuteRequest,
  type ExecutionFacts,
  type ExecutionResult,
  type InspectResult,
  type IrDigest,
  type RuntimeBridge,
  type RuntimeBridgeHost,
} from '@safescript/contracts';

import {
  ContractDefinitionError,
  SdkConfigurationError,
  createSafeScript,
  defineContract,
  type ContractType,
} from './index.js';

const inputType: ContractType<{ readonly value: bigint }> = {
  id: ids.type('type:test.input'),
  schema: { kind: 'record', fields: [{ name: 'value', schema: { kind: 'int64' } }] },
};
const outputType: ContractType<string> = { id: ids.type('type:test.output'), schema: { kind: 'string' } };
const errorType: ContractType<string> = { id: ids.type('type:test.error'), schema: { kind: 'string' } };
const effect = ids.effect('effect:test.read');
const capability = ids.capability('capability:test.read');
const operationId = ids.operation('operation:test.read');
const slotId = ids.slot('slot:test.main');
const invocationId = ids.invocation('invocation:0123456789abcdef0123456789abcdef');

const contract = defineContract({
  id: ids.contract('contract:test.host'),
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
      idempotency: 'none',
      resourceScope: (input: { readonly value: bigint }) => ({ value: String(input.value) }),
    },
  },
  slots: {
    main: {
      id: slotId,
      input: inputType,
      output: outputType,
      languageVersion: { major: 1, minor: 0 },
      effects: [effect],
      capabilities: [capability],
      compileLimits: { sourceBytes: 1000 },
      executionLimits: { fuel: 1000 },
    },
  },
});

const facts: ExecutionFacts = Object.freeze({
  actions: Object.freeze([]),
  trace: Object.freeze({ records: Object.freeze([]), truncated: false }),
  usage: Object.freeze({ fuel: 1, allocations: 0, allocatedBytes: 0, peakRetainedBytes: 0, hostCalls: 1, traceBytes: 0, outputBytes: 2 }),
});

class FakeBridge implements RuntimeBridge {
  readonly actions: ActionOutcome[] = [];
  closed = false;
  executeResult?: (request: BridgeExecuteRequest, host: RuntimeBridgeHost) => Promise<ExecutionResult>;

  async check(): Promise<CheckResult> { return { status: 'rejected', diagnostics: [], usage: { sourceBytes: 0, syntaxNodes: 0, typeWork: 0 } }; }
  async inspect(): Promise<InspectResult> { return { status: 'rejected', diagnostics: [], usage: { sourceBytes: 0, syntaxNodes: 0, typeWork: 0 } }; }
  async execute(request: BridgeExecuteRequest, host: RuntimeBridgeHost): Promise<ExecutionResult> {
    if (this.executeResult) return this.executeResult(request, host);
    const output = encodeCanonical({ kind: 'string' }, 'done');
    if (!output.ok) throw new Error('fixture encoding failed');
    return { status: 'completed', output: [...output.value], facts };
  }
  async cancel(): Promise<CancelResult> { return { status: 'not_active' }; }
  async close(): Promise<CloseResult> { this.closed = true; return { status: 'closed' }; }
}

function action(request: BridgeExecuteRequest): ActionRequest {
  return {
    abiVersion: { major: 1, minor: 0 },
    contractId: contract.id,
    requiredContractVersion: contract.version,
    irDigest: hash('ir', Uint8Array.of(1)) as unknown as IrDigest,
    invocationId: request.invocationId,
    requestId: ids.request(request.invocationId, 0),
    slotId,
    operationId,
    effectId: effect,
    capabilityId: capability,
    actionSiteId: derivedActionSiteId(Uint8Array.of(1)),
    source: { module: ids.module('module:main'), start: 0, end: 1 },
    input: request.input,
  };
}

describe('defineContract', () => {
  it('derives one frozen registry, declarations, fingerprints, and codecs', () => {
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.registry)).toBe(true);
    expect(contract.registry.digest).toBe(contract.fingerprint);
    expect(contract.declarations).toContain('export type TestInput');
    const codec = contract.codecs[inputType.id];
    expect(codec?.decode(codec.encode({ value: 7n }))).toEqual({ value: 7n });
    expect(() => defineContract({ ...contract, operations: {}, slots: { ...contract.slots, bad: { ...contract.slots.main, effects: [ids.effect('effect:test.missing')] } } })).toThrow(ContractDefinitionError);
  });
});

describe('createSafeScript', () => {
  it('validates configuration and runs current authorisation before one typed handler dispatch', async () => {
    expect(() => createSafeScript({ contract, handlers: {} as never, authorise: () => ({ status: 'allowed' }), bridge: new FakeBridge() })).toThrow(SdkConfigurationError);
    const direct = createSafeScript({ contract, handlers: { read: () => ({ tag: 'error', value: 'unused' } as const) }, authorise: () => ({ status: 'allowed' }) });
    expect(await direct.close()).toEqual({ status: 'closed' });
    const bridge = new FakeBridge();
    const order: string[] = [];
    bridge.executeResult = async (request, host) => {
      const outcome = await host.handleAction(action(request));
      bridge.actions.push(outcome);
      const output = encodeCanonical({ kind: 'string' }, 'done');
      if (!output.ok) throw new Error('fixture encoding failed');
      return { status: 'completed', output: [...output.value], facts: { ...facts, actions: [{ phase: 'requested', request: action(request) }, { phase: 'resolved', requestId: action(request).requestId, outcome }] } };
    };
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: async (input, context) => { order.push(`handler:${context.resourceScope.value}`); return { tag: 'ok', value: `value:${input.value}` }; } },
      authorise: (context: { readonly resourceScope: Readonly<Record<string, string>> }) => { order.push(`authorise:${context.resourceScope.value}`); return { status: 'allowed' }; },
      createInvocationId: () => invocationId,
    });
    const result = await safe.execute({ slot: 'main', program: { kind: 'artifact', bytes: [] }, input: { value: 3n }, context: { actor: 'a' } });
    expect(result.status).toBe('completed');
    expect(result.status === 'completed' && result.output).toBe('done');
    expect(result.status === 'completed' && result.facts.invocationId).toBe(invocationId);
    expect(order).toEqual(['authorise:3', 'handler:3']);
    expect(bridge.actions[0]?.result.tag).toBe('completed');
  });

  it('maps handler throws to failed/unknown and deterministic tests never use production adapters', async () => {
    const bridge = new FakeBridge();
    let productionCalls = 0;
    bridge.executeResult = async (request, host) => {
      const outcome = await host.handleAction(action(request));
      bridge.actions.push(outcome);
      const output = encodeCanonical({ kind: 'string' }, 'done');
      if (!output.ok) throw new Error('fixture encoding failed');
      return { status: 'completed', output: [...output.value], facts };
    };
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => { productionCalls++; throw new Error('secret'); } },
      authorise: () => { productionCalls++; return { status: 'allowed' }; },
    });
    await safe.execute({ slot: 'main', program: { kind: 'artifact', bytes: [] }, input: { value: 1n }, context: {} });
    expect(bridge.actions[0]?.result).toEqual({ tag: 'failed', value: { effectState: 'unknown', failure: { code: 'handler_fault' } } });
    const report = await safe.test({
      name: 'scripted read',
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 2n },
      actions: [{ operation: 'read', input: { value: 2n }, outcome: { tag: 'ok', value: 'scripted' } }],
      expect: { status: 'completed', output: 'done' },
    });
    expect(report.passed).toBe(true);
    expect(productionCalls).toBe(2);
    expect(await safe.close()).toEqual({ status: 'closed' });
    expect((await safe.check({ slot: 'main', source: { entryModule: ids.module('module:main'), modules: [{ id: ids.module('module:main'), source: '' }] } })).status).toBe('bridge_error');
    expect(STANDARD_COMPILE_LIMITS.sourceBytes).toBeGreaterThan(contract.registry.slots[0]?.compileLimits.sourceBytes ?? Infinity);
    expect(STANDARD_EXECUTION_LIMITS.fuel).toBeGreaterThan(contract.registry.slots[0]?.executionLimits.fuel ?? Infinity);
  });
});
