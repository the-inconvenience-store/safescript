import { describe, expect, it } from 'bun:test';
import ts from 'typescript';

import {
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  derivedActionSiteId,
  decodeCanonical,
  encodeCanonical,
  hash,
  ids,
  resultSchema,
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
type TestError =
  Readonly<{ tag: 'policy'; value: Readonly<{ code: string }> }> | Readonly<{ tag: 'domain'; value: string }>;
const errorType: ContractType<TestError> = {
  id: ids.type('type:test.error'),
  schema: {
    kind: 'variant',
    variants: [
      { tag: 'policy', schema: { kind: 'record', fields: [{ name: 'code', schema: { kind: 'string' } }] } },
      { tag: 'domain', schema: { kind: 'string' } },
    ],
  },
};
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
  preparation: Object.freeze({ kind: 'artifact', irDigest: hash('ir', Uint8Array.of(1)) as unknown as IrDigest }),
  actions: Object.freeze([]),
  trace: Object.freeze({ records: Object.freeze([]), truncated: false }),
  usage: Object.freeze({
    fuel: 1,
    allocations: 0,
    allocatedBytes: 0,
    peakRetainedBytes: 0,
    peakCollectionItems: 0,
    peakValueDepth: 0,
    peakValueNodes: 0,
    peakValueBytes: 0,
    peakCallDepth: 0,
    hostCalls: 1,
    peakConcurrentActions: 1,
    traceBytes: 0,
    outputBytes: 2,
  }),
});

class FakeBridge implements RuntimeBridge {
  readonly actions: ActionOutcome[] = [];
  closed = false;
  executeResult?: (request: BridgeExecuteRequest, host: RuntimeBridgeHost) => Promise<ExecutionResult>;

  async check(): Promise<CheckResult> {
    return { status: 'rejected', diagnostics: [], usage: { sourceBytes: 0, syntaxNodes: 0, typeWork: 0 } };
  }
  async inspect(): Promise<InspectResult> {
    return { status: 'rejected', diagnostics: [], usage: { sourceBytes: 0, syntaxNodes: 0, typeWork: 0 } };
  }
  async execute(request: BridgeExecuteRequest, host: RuntimeBridgeHost): Promise<ExecutionResult> {
    if (this.executeResult) return this.executeResult(request, host);
    const output = encodeCanonical({ kind: 'string' }, 'done');
    if (!output.ok) throw new Error('fixture encoding failed');
    return { status: 'completed', output: [...output.value], facts };
  }
  async cancel(): Promise<CancelResult> {
    return { status: 'not_active' };
  }
  async close(): Promise<CloseResult> {
    this.closed = true;
    return { status: 'closed' };
  }
}

function action(request: BridgeExecuteRequest, sequence = 0): ActionRequest {
  return {
    abiVersion: { major: 2, minor: 0 },
    contractId: contract.id,
    requiredContractVersion: contract.version,
    irDigest: hash('ir', Uint8Array.of(1)) as unknown as IrDigest,
    invocationId: request.invocationId,
    requestId: ids.request(request.invocationId, sequence),
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
    expect(contract.abiVersion).toEqual({ major: 2, minor: 0 });
    expect(contract.registry.abiVersion).toEqual(contract.abiVersion);
    expect(contract.registry.digest).toBe(contract.fingerprint);
    expect(contract.declarations).toContain('export type TestInput');
    expect(contract.declarations).toContain('readonly test: Readonly<{ readonly read:');
    expect(contract.declarations).toContain('Effect<"effect:test.read", Result<TestOutput, TestError>>');
    expect(
      ts.transpileModule(contract.declarations, {
        compilerOptions: { target: ts.ScriptTarget.ESNext },
        reportDiagnostics: true,
      }).diagnostics,
    ).toEqual([]);
    const codec = contract.codecs[inputType.id];
    expect(codec?.decode(codec.encode({ value: 7n }))).toEqual({ value: 7n });
    expect(() =>
      defineContract({
        ...contract,
        operations: {},
        slots: { ...contract.slots, bad: { ...contract.slots.main, effects: [ids.effect('effect:test.missing')] } },
      }),
    ).toThrow(ContractDefinitionError);
  });

  it('rejects colliding generated names while accepting arbitrary declared error schemas', () => {
    expect(() =>
      defineContract({
        id: ids.contract('contract:test.colliding'),
        version: { major: 1, minor: 0, patch: 0 },
        types: [
          { id: ids.type('type:a-b'), schema: { kind: 'string' } },
          { id: ids.type('type:a.b'), schema: { kind: 'string' } },
        ],
        operations: {},
        slots: {},
      }),
    ).toThrow(ContractDefinitionError);
    expect(() =>
      defineContract({
        id: ids.contract('contract:test.operation-conflict'),
        version: { major: 1, minor: 0, patch: 0 },
        operations: {
          root: { ...contract.operations.read, id: ids.operation('operation:test') },
          nested: { ...contract.operations.read, id: ids.operation('operation:test.read') },
        },
        slots: {},
      }),
    ).toThrow(ContractDefinitionError);
    expect(
      defineContract({
        id: ids.contract('contract:test.no-policy'),
        version: { major: 1, minor: 0, patch: 0 },
        operations: {
          read: {
            ...contract.operations.read,
            error: { id: ids.type('type:test.plain-error'), schema: { kind: 'string' } },
          },
        },
        slots: contract.slots,
      }).registry.operations[0]?.error,
    ).toBe(ids.type('type:test.plain-error'));
  });

  it.each([
    ['invalid semantic version', () => defineContract({ ...contract, version: { major: -1, minor: 0, patch: 0 } })],
    [
      'invalid prerelease',
      () => defineContract({ ...contract, version: { major: 1, minor: 0, patch: 0, prerelease: 'bad!' } }),
    ],
    [
      'conflicting schemas',
      () =>
        defineContract({
          ...contract,
          types: [{ id: inputType.id, schema: { kind: 'string' } }],
        }),
    ],
    [
      'invalid effect cost',
      () =>
        defineContract({
          ...contract,
          operations: { read: { ...contract.operations.read, effectCost: -1 } },
        }),
    ],
    [
      'invalid idempotency',
      () =>
        defineContract({
          ...contract,
          operations: { read: { ...contract.operations.read, idempotency: 'sometimes' as 'none' } },
        }),
    ],
    [
      'duplicate operation id',
      () =>
        defineContract({
          ...contract,
          operations: { read: contract.operations.read, again: contract.operations.read },
        }),
    ],
    [
      'invalid language version',
      () =>
        defineContract({
          ...contract,
          slots: { main: { ...contract.slots.main, languageVersion: { major: -1, minor: 0 } } },
        }),
    ],
    [
      'unknown capability',
      () =>
        defineContract({
          ...contract,
          slots: { main: { ...contract.slots.main, capabilities: [ids.capability('capability:test.missing')] } },
        }),
    ],
    [
      'duplicate permissions',
      () =>
        defineContract({
          ...contract,
          slots: { main: { ...contract.slots.main, effects: [effect, effect] } },
        }),
    ],
    [
      'duplicate slot id',
      () =>
        defineContract({
          ...contract,
          slots: { main: contract.slots.main, again: contract.slots.main },
        }),
    ],
  ])('rejects %s', (_name, define) => {
    expect(define).toThrow(ContractDefinitionError);
  });

  it('rejects non-canonical codec inputs and bytes', () => {
    const codec = contract.codecs[inputType.id];
    expect(() => codec?.encode({ value: 'not-an-int' })).toThrow(TypeError);
    expect(() => codec?.decode(Uint8Array.of(0xff))).toThrow(TypeError);
  });

  it('generates declarations for every supported schema form', () => {
    const stringId = ids.type('type:forms.string');
    const forms = defineContract({
      id: ids.contract('contract:test.forms'),
      version: { major: 1, minor: 0, patch: 0 },
      types: [
        { id: ids.type('type:forms.unit'), schema: { kind: 'unit' } },
        { id: ids.type('type:forms.boolean'), schema: { kind: 'boolean' } },
        { id: ids.type('type:forms.float'), schema: { kind: 'float64' } },
        { id: ids.type('type:forms.bytes'), schema: { kind: 'bytes' } },
        { id: ids.type('type:forms.instant'), schema: { kind: 'instant' } },
        { id: ids.type('type:forms.list'), schema: { kind: 'list', item: { kind: 'boolean' } } },
        { id: ids.type('type:forms.tuple'), schema: { kind: 'tuple', items: [{ kind: 'int64' }] } },
        { id: stringId, schema: { kind: 'string' } },
        { id: ids.type('type:forms.brand'), schema: { kind: 'brand', type: stringId, base: { kind: 'string' } } },
        { id: ids.type('type:forms.alias'), schema: { kind: 'ref', type: stringId } },
      ],
      operations: {},
      slots: {},
    });
    expect(forms.declarations).toContain('readonly number[]');
    expect(forms.declarations).toContain('epochSeconds: bigint');
    expect(forms.declarations).toContain('readonly (boolean)[]');
    expect(forms.declarations).toContain('readonly [bigint]');
    expect(forms.declarations).toContain('__brand');
    expect(forms.declarations).toContain('FormsString');
  });
});

describe('createSafeScript', () => {
  it('validates configuration and performs one typed handler dispatch', async () => {
    expect(() =>
      createSafeScript({
        contract,
        handlers: {} as never,
        bridge: new FakeBridge(),
      }),
    ).toThrow(SdkConfigurationError);
    const direct = createSafeScript({
      contract,
      handlers: { read: () => ({ tag: 'error', value: { tag: 'domain', value: 'unused' } }) as const },
    });
    expect(await direct.close()).toEqual({ status: 'closed' });
    const bridge = new FakeBridge();
    const order: string[] = [];
    bridge.executeResult = async (request, host) => {
      const outcome = await host.handleAction(action(request));
      bridge.actions.push(outcome);
      const output = encodeCanonical({ kind: 'string' }, 'done');
      if (!output.ok) throw new Error('fixture encoding failed');
      return {
        status: 'completed',
        output: [...output.value],
        facts: {
          ...facts,
          actions: [
            { phase: 'requested', request: action(request) },
            { phase: 'resolved', requestId: action(request).requestId, outcome },
          ],
        },
      };
    };
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: {
        read: async (input) => {
          order.push(`handler:${input.value}`);
          return { tag: 'ok', value: `value:${input.value}` };
        },
      },
      createInvocationId: () => invocationId,
    });
    const result = await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 3n },
      context: { actor: 'a' },
    });
    expect(result.status).toBe('completed');
    expect(result.status === 'completed' && result.output).toBe('done');
    expect(result.status === 'completed' && result.facts.invocationId).toBe(invocationId);
    expect(result.status === 'completed' && result.facts.preparation).toEqual(facts.preparation);
    expect(order).toEqual(['handler:3']);
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
      handlers: {
        read: () => {
          productionCalls++;
          throw new Error('secret');
        },
      },
    });
    await safe.execute({ slot: 'main', program: { kind: 'artifact', bytes: [] }, input: { value: 1n }, context: {} });
    expect(bridge.actions[0]?.result).toEqual({
      tag: 'failed',
      value: { effectState: 'unknown', failure: { code: 'handler_fault' } },
    });
    const report = await safe.test({
      name: 'scripted read',
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 2n },
      actions: [{ operation: 'read', input: { value: 2n }, outcome: { tag: 'ok', value: 'scripted' } }],
      expect: { status: 'completed', output: 'done' },
    });
    expect(report.passed).toBe(true);
    expect(productionCalls).toBe(1);
    expect(await safe.close()).toEqual({ status: 'closed' });
    expect(
      (
        await safe.check({
          slot: 'main',
          source: { entryModule: ids.module('module:main'), modules: [{ id: ids.module('module:main'), source: '' }] },
        })
      ).status,
    ).toBe('bridge_error');
    expect(STANDARD_COMPILE_LIMITS.sourceBytes).toBeGreaterThan(
      contract.registry.slots[0]?.compileLimits.sourceBytes ?? Infinity,
    );
    expect(STANDARD_EXECUTION_LIMITS.fuel).toBeGreaterThan(
      contract.registry.slots[0]?.executionLimits.fuel ?? Infinity,
    );
  });

  it('rejects uncorrelated bridge actions and accepts compatible contract requirements', async () => {
    const bridge = new FakeBridge();
    let handlers = 0;
    bridge.executeResult = async (request, host) => {
      bridge.actions.push(await host.handleAction(action(request)));
      const output = encodeCanonical({ kind: 'string' }, 'done');
      if (!output.ok) throw new Error('fixture encoding failed');
      return { status: 'completed', output: [...output.value], facts };
    };
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: {
        read: () => {
          handlers++;
          return { tag: 'ok', value: 'handled' } as const;
        },
      },
      createInvocationId: () => invocationId,
    });
    const otherInvocation = ids.invocation('invocation:ffffffffffffffffffffffffffffffff');
    const mutations: readonly ((request: ActionRequest) => ActionRequest)[] = [
      (request) => ({
        ...request,
        invocationId: otherInvocation,
        requestId: ids.request(otherInvocation, 0),
      }),
      (request) => ({ ...request, requestId: ids.request(request.invocationId, 1) }),
      (request) => ({
        ...request,
        idempotencyKey: 'invalid' as NonNullable<ActionRequest['idempotencyKey']>,
      }),
      (request) => ({ ...request, requiredContractVersion: { major: 2, minor: 0, patch: 0 } }),
    ];
    for (const mutate of mutations) {
      bridge.executeResult = async (request, host) => {
        bridge.actions.push(await host.handleAction(mutate(action(request))));
        const output = encodeCanonical({ kind: 'string' }, 'done');
        if (!output.ok) throw new Error('fixture encoding failed');
        return { status: 'completed', output: [...output.value], facts };
      };
      await safe.execute({ slot: 'main', program: { kind: 'artifact', bytes: [] }, input: { value: 1n }, context: {} });
    }
    expect(bridge.actions.map((outcome) => outcome.result.tag)).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(handlers).toBe(0);

    bridge.executeResult = async (request, host) => {
      const compatible = {
        ...action(request),
        requiredContractVersion: { major: 1, minor: 0, patch: 0, prerelease: 'beta' },
      } as const;
      bridge.actions.push(await host.handleAction(compatible), await host.handleAction(compatible));
      const output = encodeCanonical({ kind: 'string' }, 'done');
      if (!output.ok) throw new Error('fixture encoding failed');
      return { status: 'completed', output: [...output.value], facts };
    };
    await safe.execute({ slot: 'main', program: { kind: 'artifact', bytes: [] }, input: { value: 1n }, context: {} });
    expect(bridge.actions.slice(-2).map((outcome) => outcome.result.tag)).toEqual(['completed', 'failed']);
    expect(handlers).toBe(1);
  });

  it('stops validated actions with declared errors and records afterAction faults without rewriting outcomes', async () => {
    const bridge = new FakeBridge();
    let handlers = 0;
    let fixedOutcome: ActionOutcome | undefined;
    bridge.executeResult = async (request, host) => {
      fixedOutcome = await host.handleAction(action(request));
      const output = encodeCanonical({ kind: 'string' }, 'done');
      if (!output.ok) throw new Error('fixture encoding failed');
      return { status: 'completed', output: [...output.value], facts };
    };
    const hostContext = { actor: 'a' };
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: {
        read: () => {
          handlers++;
          return { tag: 'ok', value: 'must not run' } as const;
        },
      },
      createInvocationId: () => invocationId,
      hooks: {
        beforeAction: (context) => {
          expect(context.operation).toBe('read');
          expect(context.operationId).toBe(operationId);
          expect(context.input).toEqual({ value: 1n });
          expect(context.context).toBe(hostContext);
          expect(Object.isFrozen(context)).toBe(true);
          expect(Object.isFrozen(context.input)).toBe(true);
          expect(Object.isFrozen(hostContext)).toBe(false);
          return { status: 'stop', error: { tag: 'policy', value: { code: 'denied' } } } as const;
        },
        afterAction: ({ outcome }) => {
          expect(outcome.result.tag).toBe('completed');
          throw new Error('secret after action');
        },
      },
    });
    const result = await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: hostContext,
    });
    expect(handlers).toBe(0);
    expect(fixedOutcome?.result.tag).toBe('completed');
    if (fixedOutcome?.result.tag === 'completed') {
      const decoded = decodeCanonical(
        resultSchema({ kind: 'string' }, errorType.schema),
        Uint8Array.from(fixedOutcome.result.value),
      );
      expect(decoded.ok && decoded.value).toEqual({
        tag: 'error',
        value: { tag: 'policy', value: { code: 'denied' } },
      });
    }
    expect(result.status).toBe('completed');
    expect(result.hookDiagnostics).toEqual([
      {
        code: 'hook_fault',
        point: 'after_action',
        invocationId,
        requestId: ids.request(invocationId, 0),
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret after action');
  });

  it('fails malformed action hooks closed and observes cancellation and handler failures', async () => {
    for (const mode of ['malformed', 'cancelled', 'handler_fault'] as const) {
      const controller = new AbortController();
      const observed: ActionOutcome['result'][] = [];
      const expected: ActionOutcome['result'] =
        mode === 'handler_fault'
          ? { tag: 'failed', value: { effectState: 'unknown', failure: { code: 'handler_fault' } } }
          : {
              tag: 'failed',
              value: {
                effectState: 'not_performed',
                failure: { code: mode === 'cancelled' ? 'cancelled' : 'gateway_fault' },
              },
            };
      const bridge = new FakeBridge();
      bridge.executeResult = async (request, host) => {
        const outcome = await host.handleAction(action(request));
        observed.push(outcome.result);
        const output = encodeCanonical({ kind: 'string' }, 'done');
        if (!output.ok) throw new Error('fixture encoding failed');
        return { status: 'completed', output: [...output.value], facts };
      };
      const beforeAction =
        mode === 'malformed'
          ? () => ({ bad: true }) as never
          : mode === 'cancelled'
            ? () => {
                controller.abort();
                return { status: 'continue' } as const;
              }
            : undefined;
      const safe = createSafeScript({
        contract,
        bridge,
        handlers: {
          read: () => {
            if (mode === 'handler_fault') throw new Error('handler secret');
            return { tag: 'ok', value: 'unused' } as const;
          },
        },
        createInvocationId: () => invocationId,
        hooks: {
          ...(beforeAction === undefined ? {} : { beforeAction }),
          afterAction: ({ outcome }) => expect(outcome.result).toEqual(expected),
        },
      });
      await safe.execute({
        slot: 'main',
        program: { kind: 'artifact', bytes: [] },
        input: { value: 1n },
        context: {},
        signal: controller.signal,
      });
      expect(observed).toEqual([expected]);
    }
  });

  it('keeps invalid and over-capacity actions away from hooks and handlers', async () => {
    const bridge = new FakeBridge();
    let hooks = 0;
    let handlers = 0;
    bridge.executeResult = async (request, host) => {
      const invalid = { ...action(request), requestId: ids.request(request.invocationId, 3) };
      const invalidOutcome = await host.handleAction(invalid);
      const [first, second] = await Promise.all([
        host.handleAction(action(request, 0)),
        host.handleAction(action(request, 1)),
      ]);
      bridge.actions.push(invalidOutcome, first, second);
      const output = encodeCanonical({ kind: 'string' }, 'done');
      if (!output.ok) throw new Error('fixture encoding failed');
      return { status: 'completed', output: [...output.value], facts };
    };
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: {
        read: async () => {
          handlers++;
          await Promise.resolve();
          return { tag: 'ok', value: 'ok' } as const;
        },
      },
      createInvocationId: () => invocationId,
      hooks: {
        beforeAction: async () => {
          hooks++;
          await Promise.resolve();
          return { status: 'continue' } as const;
        },
        afterAction: () => {
          hooks++;
        },
      },
    });
    await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
      limits: { concurrentActions: 1 },
    });
    expect(handlers).toBe(1);
    expect(hooks).toBe(2);
    expect(bridge.actions.map((outcome) => outcome.result.tag)).toEqual(['failed', 'completed', 'failed']);
  });

  it('validates default limit configuration', () => {
    expect(() =>
      createSafeScript({
        contract,
        bridge: new FakeBridge(),
        handlers: { read: () => ({ tag: 'ok', value: 'ok' }) as const },
        defaultCompileLimits: { sourceBytes: STANDARD_COMPILE_LIMITS.sourceBytes + 1 },
      }),
    ).toThrow(SdkConfigurationError);
  });

  it('runs immutable execution hooks and rejects before bridge execution', async () => {
    const bridge = new FakeBridge();
    let bridgeCalls = 0;
    bridge.executeResult = async () => {
      bridgeCalls++;
      throw new Error('must not execute');
    };
    const observed: string[] = [];
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({ tag: 'ok', value: 'unused' }) as const },
      createInvocationId: () => invocationId,
      hooks: {
        beforeExecute: (context) => {
          expect(Object.isFrozen(context)).toBe(true);
          expect(Object.isFrozen(context.input)).toBe(true);
          expect(context.context).toEqual({ actor: 'a' });
          expect(context.slot).toBe('main');
          expect(context.slotId).toBe(slotId);
          expect(context.input).toEqual({ value: 3n });
          observed.push('before');
          return { status: 'rejected', code: 'maintenance', detail: 'scheduled' } as const;
        },
        afterExecute: (event) => {
          expect(Object.isFrozen(event)).toBe(true);
          expect(Object.isFrozen(event.result)).toBe(true);
          observed.push(`after:${event.result.status}`);
        },
      },
    });
    const result = await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 3n },
      context: { actor: 'a' },
    });
    expect(result).toMatchObject({
      status: 'not_started',
      error: { code: 'execution_rejected', hostCode: 'maintenance', detail: 'scheduled' },
    });
    expect(observed).toEqual(['before', 'after:not_started']);
    expect(bridgeCalls).toBe(0);
  });

  it('accepts character-bounded rejection details and gives post-hook cancellation precedence', async () => {
    const rejectionCode = '😀'.repeat(64);
    const rejectionDetail = '界'.repeat(160);
    const rejected = createSafeScript({
      contract,
      bridge: new FakeBridge(),
      handlers: { read: () => ({ tag: 'ok', value: 'unused' }) as const },
      createInvocationId: () => invocationId,
      hooks: {
        beforeExecute: () => ({ status: 'rejected', code: rejectionCode, detail: rejectionDetail }),
      },
    });
    const rejectedResult = await rejected.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
    });
    expect(rejectedResult).toMatchObject({
      status: 'not_started',
      error: { code: 'execution_rejected', hostCode: rejectionCode, detail: rejectionDetail },
    });

    const controller = new AbortController();
    const cancelled = createSafeScript({
      contract,
      bridge: new FakeBridge(),
      handlers: { read: () => ({ tag: 'ok', value: 'unused' }) as const },
      createInvocationId: () => invocationId,
      hooks: {
        beforeExecute: () => {
          controller.abort();
          return { status: 'rejected', code: 'too-late' } as const;
        },
      },
    });
    const cancelledResult = await cancelled.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
      signal: controller.signal,
    });
    expect(cancelledResult).toMatchObject({ status: 'not_started', error: { code: 'cancelled' } });
  });

  it('fails closed for malformed beforeExecute hooks and still observes the fixed result', async () => {
    for (const beforeExecute of [
      () => ({}),
      () => {
        throw new Error('secret');
      },
    ]) {
      const bridge = new FakeBridge();
      let bridgeCalls = 0;
      bridge.executeResult = async () => {
        bridgeCalls++;
        throw new Error('must not execute');
      };
      const observed: string[] = [];
      const safe = createSafeScript({
        contract,
        bridge,
        handlers: { read: () => ({ tag: 'ok', value: 'unused' }) as const },
        createInvocationId: () => invocationId,
        hooks: {
          beforeExecute: beforeExecute as never,
          afterExecute: ({ result }) =>
            observed.push(`${result.status}:${'error' in result ? result.error?.code : undefined}`),
        },
      });
      const result = await safe.execute({
        slot: 'main',
        program: { kind: 'artifact', bytes: [] },
        input: { value: 1n },
        context: {},
      });
      expect(result).toMatchObject({ status: 'not_started', error: { code: 'hook_fault' } });
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(observed).toEqual(['not_started:hook_fault']);
      expect(bridgeCalls).toBe(0);
    }
  });

  it('afterExecute observes every bridge terminal path without changing it', async () => {
    const cases: readonly ExecutionResult[] = [
      { status: 'bridge_error', error: { code: 'adapter_failure', phase: 'execute' } },
      { status: 'not_started', error: { code: 'invalid_request', phase: 'execute' } },
      { status: 'failed', error: { code: 'resource_exhausted' }, facts },
      { status: 'cancelled', error: { code: 'cancelled' }, facts },
      { status: 'completed', output: [100, 100, 111, 110, 101], facts },
    ];
    for (const fixed of cases) {
      const bridge = new FakeBridge();
      bridge.executeResult = async () => fixed;
      const observed: string[] = [];
      const safe = createSafeScript({
        contract,
        bridge,
        handlers: { read: () => ({ tag: 'ok', value: 'unused' }) as const },
        createInvocationId: () => invocationId,
        hooks: { afterExecute: ({ result }) => observed.push(result.status) },
      });
      const result = await safe.execute({
        slot: 'main',
        program: { kind: 'artifact', bytes: [] },
        input: { value: 1n },
        context: {},
      });
      expect(result.status).toBe(fixed.status);
      expect(observed).toEqual([fixed.status]);
    }
  });

  it('records a bounded afterExecute hook fault without replacing the fixed result', async () => {
    const safe = createSafeScript({
      contract,
      bridge: new FakeBridge(),
      handlers: { read: () => ({ tag: 'ok', value: 'unused' }) as const },
      createInvocationId: () => invocationId,
      hooks: {
        afterExecute: () => {
          throw new Error('SUPER_SECRET_AFTER_HOOK');
        },
      },
    });
    const result = await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.output).toBe('done');
    expect(result.hookDiagnostics).toEqual([{ code: 'hook_fault', point: 'after_execute', invocationId }]);
    expect(JSON.stringify(result)).not.toContain('SUPER_SECRET_AFTER_HOOK');
  });

  it('does not invoke execution hooks for invalid public requests', async () => {
    let hookCalls = 0;
    const safe = createSafeScript({
      contract,
      bridge: new FakeBridge(),
      handlers: { read: () => ({ tag: 'ok', value: 'unused' }) as const },
      hooks: {
        beforeExecute: () => {
          hookCalls++;
          return { status: 'continue' } as const;
        },
        afterExecute: () => {
          hookCalls++;
        },
      },
    });
    await safe.execute({
      slot: 'missing' as 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
    });
    const invalidInput = await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 'bad' as unknown as bigint },
      context: {},
    });
    const invalidSeed = await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
      randomSeed: [256],
    });
    const invalidTrace = await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
      trace: 'verbose' as 'none',
    });
    const invalidSignal = await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
      signal: { aborted: false } as never,
    });
    const overLimitInput = await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
      limits: { maxBytes: 0 },
    });
    expect(hookCalls).toBe(0);
    for (const result of [invalidInput, invalidSeed, invalidTrace, invalidSignal, overLimitInput]) {
      expect(result).toMatchObject({ status: 'bridge_error', error: { code: 'invalid_request' } });
    }
  });

  it('resolves deployment, slot, and invocation limits by minimum', async () => {
    const bridge = new FakeBridge();
    bridge.executeResult = async (request) => {
      expect(request.limits.fuel).toBe(700);
      const output = encodeCanonical({ kind: 'string' }, 'done');
      if (!output.ok) throw new Error('fixture encoding failed');
      return { status: 'completed', output: [...output.value], facts };
    };
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({ tag: 'ok', value: 'ok' }) as const },
      defaultExecutionLimits: { fuel: 700 },
    });
    const result = await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
      limits: { fuel: 900 },
    });
    expect(result.status).toBe('completed');
  });

  it('validates slots and maps bridge throws for check and inspect', async () => {
    const bridge = new FakeBridge();
    bridge.check = async () => {
      throw new Error('transport');
    };
    bridge.inspect = async () => {
      throw new Error('transport');
    };
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({ tag: 'ok', value: 'ok' }) as const },
    });
    const source = {
      entryModule: ids.module('module:main'),
      modules: [{ id: ids.module('module:main'), source: 'export {}' }],
    };
    expect((await safe.check({ slot: 'missing' as 'main', source })).status).toBe('bridge_error');
    expect((await safe.inspect({ slot: 'missing' as 'main', source, views: [] })).status).toBe('bridge_error');
    expect((await safe.check({ slot: 'main', source })).status).toBe('bridge_error');
    expect((await safe.inspect({ slot: 'main', source, views: [] })).status).toBe('bridge_error');
  });

  it('fails invalid execution assembly without calling the bridge', async () => {
    const bridge = new FakeBridge();
    let calls = 0;
    bridge.executeResult = async () => {
      calls++;
      throw new Error('must not execute');
    };
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({ tag: 'ok', value: 'ok' }) as const },
      createInvocationId: () => 'invocation:invalid' as typeof invocationId,
    });
    expect(
      (
        await safe.execute({
          slot: 'missing' as 'main',
          program: { kind: 'artifact', bytes: [] },
          input: { value: 1n },
          context: {},
        })
      ).status,
    ).toBe('bridge_error');
    expect(
      (
        await safe.execute({
          slot: 'main',
          program: { kind: 'artifact', bytes: [] },
          input: { value: 1n },
          context: {},
        })
      ).status,
    ).toBe('bridge_error');
    const explicit = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({ tag: 'ok', value: 'ok' }) as const },
      createInvocationId: () => invocationId,
    });
    expect(
      (
        await explicit.execute({
          slot: 'main',
          program: { kind: 'artifact', bytes: [] },
          input: { value: 'bad' as unknown as bigint },
          context: {},
        })
      ).status,
    ).toBe('bridge_error');
    expect(
      (
        await explicit.execute({
          slot: 'main',
          program: { kind: 'artifact', bytes: [] },
          input: { value: 1n },
          context: {},
          limits: { fuel: 1001 },
        })
      ).status,
    ).toBe('bridge_error');
    expect(calls).toBe(0);
  });

  it.each([
    ['failed', { status: 'failed' as const, error: { code: 'resource_exhausted' }, facts }],
    ['cancelled', { status: 'cancelled' as const, error: { code: 'cancelled' as const }, facts }],
  ] as const)('preserves invocation facts for %s bridge executions', async (_name, execution) => {
    const bridge = new FakeBridge();
    bridge.executeResult = async () => execution;
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({ tag: 'ok', value: 'ok' }) as const },
      createInvocationId: () => invocationId,
    });
    const result = await safe.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
    });
    expect(result.status).toBe(execution.status);
    if (result.status === 'failed' || result.status === 'cancelled')
      expect(result.facts.invocationId).toBe(invocationId);
  });

  it('maps malformed output and bridge rejection to stable results', async () => {
    const bridge = new FakeBridge();
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({ tag: 'ok', value: 'ok' }) as const },
      createInvocationId: () => invocationId,
    });
    bridge.executeResult = async () => ({ status: 'completed', output: [0xff], facts });
    expect(
      (
        await safe.execute({
          slot: 'main',
          program: { kind: 'artifact', bytes: [] },
          input: { value: 1n },
          context: {},
        })
      ).status,
    ).toBe('bridge_error');
    bridge.executeResult = async () => ({
      status: 'not_started',
      error: { phase: 'execute', code: 'invalid_request' },
    });
    expect(
      (
        await safe.execute({
          slot: 'main',
          program: { kind: 'artifact', bytes: [] },
          input: { value: 1n },
          context: {},
        })
      ).status,
    ).toBe('not_started');
    bridge.executeResult = async () => {
      throw new Error('transport');
    };
    expect(
      (
        await safe.execute({
          slot: 'main',
          program: { kind: 'artifact', bytes: [] },
          input: { value: 1n },
          context: {},
        })
      ).status,
    ).toBe('bridge_error');
  });

  it('maps invalid handler results without leaking throws', async () => {
    const bridge = new FakeBridge();
    bridge.executeResult = async (request, host) => {
      bridge.actions.push(await host.handleAction(action(request)));
      return { status: 'completed', output: [100, 111, 110, 101], facts };
    };
    const invalidHandler = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({}) as never },
      createInvocationId: () => invocationId,
    });
    await invalidHandler.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
    });
    expect(bridge.actions.at(-1)?.result).toMatchObject({
      tag: 'failed',
      value: { failure: { code: 'invalid_result' } },
    });
  });

  it('preserves valid declared handler failures and rejects malformed ones', async () => {
    const bridge = new FakeBridge();
    bridge.executeResult = async (request, host) => {
      bridge.actions.push(await host.handleAction(action(request)));
      const output = encodeCanonical({ kind: 'string' }, 'done');
      if (!output.ok) throw new Error('fixture encoding failed');
      return { status: 'completed', output: [...output.value], facts };
    };
    const declared = createSafeScript({
      contract,
      bridge,
      handlers: {
        read: () =>
          ({
            status: 'failed',
            effectState: 'not_performed',
            failure: { code: 'unavailable', detail: 'bounded' },
          }) as const,
      },
      createInvocationId: () => invocationId,
    });
    await declared.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
    });
    expect(bridge.actions.at(-1)?.result).toEqual({
      tag: 'failed',
      value: { effectState: 'not_performed', failure: { code: 'unavailable', detail: 'bounded' } },
    });
    const malformed = createSafeScript({
      contract,
      bridge,
      handlers: {
        read: () => ({ status: 'failed', effectState: 'performed', failure: {} }) as never,
      },
      createInvocationId: () => invocationId,
    });
    await malformed.execute({
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      context: {},
    });
    expect(bridge.actions.at(-1)?.result).toMatchObject({
      tag: 'failed',
      value: { effectState: 'unknown', failure: { code: 'invalid_result' } },
    });
  });

  it('reports deterministic expectation and unused-script mismatches', async () => {
    const bridge = new FakeBridge();
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({ tag: 'ok', value: 'production' }) as const },
    });
    const report = await safe.test({
      name: 'mismatches',
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      actions: [{ operation: 'read', input: { value: 1n }, outcome: { tag: 'ok', value: 'unused' } }],
      expect: {
        status: 'failed',
        output: 'wrong',
        effects: [effect],
        actions: [],
        resources: { fuel: 999 },
      },
    });
    expect(report.passed).toBe(false);
    expect(report.mismatches.map((item) => item.path)).toEqual([
      'actions.length',
      'status',
      'output',
      'effects',
      'resources.fuel',
    ]);
  });

  it('compares expected diagnostics for not-started deterministic executions', async () => {
    const bridge = new FakeBridge();
    bridge.executeResult = async () => ({
      status: 'not_started',
      diagnostics: [
        {
          code: 'SS_SYNTAX',
          severity: 'error',
          message: 'actual',
          repair: { category: 'syntax', action: 'Rewrite with supported syntax.' },
          location: { module: ids.module('module:main'), start: 0, end: 1 },
        },
      ],
      usage: { sourceBytes: 1, syntaxNodes: 1, typeWork: 1 },
    });
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({ tag: 'ok', value: 'production' }) as const },
    });
    const report = await safe.test({
      name: 'diagnostics',
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      expect: { diagnostics: [] },
    });
    expect(report.mismatches.map((item) => item.path)).toEqual(['diagnostics']);
  });

  it.each([
    ['missing script', [], (request: BridgeExecuteRequest) => action(request), 'actions[0]'],
    [
      'wrong operation',
      [{ operation: 'missing' as 'read', input: { value: 1n }, outcome: { tag: 'ok' as const, value: 'x' } }],
      (request: BridgeExecuteRequest) => action(request),
      'actions[0].operation',
    ],
    [
      'wrong input',
      [{ operation: 'read' as const, input: { value: 2n }, outcome: { tag: 'ok' as const, value: 'x' } }],
      (request: BridgeExecuteRequest) => action(request),
      'actions[0].input',
    ],
  ])('reports scripted-host %s mismatches', async (_name, actions, makeAction, path) => {
    const bridge = new FakeBridge();
    bridge.executeResult = async (request, host) => {
      await host.handleAction(makeAction(request));
      const output = encodeCanonical({ kind: 'string' }, 'done');
      if (!output.ok) throw new Error('fixture encoding failed');
      return { status: 'completed', output: [...output.value], facts };
    };
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({ tag: 'ok', value: 'production' }) as const },
    });
    const report = await safe.test({
      name: String(_name),
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      actions,
    });
    expect(report.mismatches.some((item) => item.path === path)).toBe(true);
  });

  it('detects duplicate scripted requests and maps scripted failed outcomes', async () => {
    const bridge = new FakeBridge();
    const observed: ActionOutcome[] = [];
    bridge.executeResult = async (request, host) => {
      const first = action(request);
      observed.push(await host.handleAction(first), await host.handleAction(first));
      const output = encodeCanonical({ kind: 'string' }, 'done');
      if (!output.ok) throw new Error('fixture encoding failed');
      return { status: 'completed', output: [...output.value], facts };
    };
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({ tag: 'ok', value: 'production' }) as const },
    });
    const duplicate = await safe.test({
      name: 'duplicate',
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      actions: [
        { operation: 'read', input: { value: 1n }, outcome: { tag: 'ok', value: 'first' } },
        { operation: 'read', input: { value: 1n }, outcome: { tag: 'ok', value: 'second' } },
      ],
    });
    expect(duplicate.mismatches.some((item) => item.path === 'actions[1].requestId')).toBe(true);

    bridge.executeResult = async (request, host) => {
      observed.push(await host.handleAction(action(request)));
      const output = encodeCanonical({ kind: 'string' }, 'done');
      if (!output.ok) throw new Error('fixture encoding failed');
      return { status: 'completed', output: [...output.value], facts };
    };
    await safe.test({
      name: 'failed',
      slot: 'main',
      program: { kind: 'artifact', bytes: [] },
      input: { value: 1n },
      actions: [
        {
          operation: 'read',
          input: { value: 1n },
          outcome: { status: 'failed', effectState: 'unknown', failure: { code: 'unavailable' } },
        },
      ],
    });
    expect(observed.at(-1)?.result.tag).toBe('failed');
  });

  it('closes and cancels idempotently even when the bridge throws', async () => {
    const bridge = new FakeBridge();
    bridge.cancel = async () => {
      throw new Error('cancel');
    };
    bridge.close = async () => {
      throw new Error('close');
    };
    const safe = createSafeScript({
      contract,
      bridge,
      handlers: { read: () => ({ tag: 'ok', value: 'ok' }) as const },
    });
    expect((await safe.cancel(invocationId)).status).toBe('bridge_error');
    const first = safe.close();
    expect(safe.close()).toBe(first);
    expect((await first).status).toBe('bridge_error');
    expect((await safe.cancel(invocationId)).status).toBe('bridge_error');
  });
});
