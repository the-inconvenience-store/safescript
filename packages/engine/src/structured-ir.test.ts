import { describe, expect, it } from 'bun:test';

import {
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  derivedActionSiteId,
  defineSchemaRegistry,
  hash,
  ids,
  resultSchema,
  type ContractRegistry,
  type SlotDefinition,
  type TypeDefinition,
} from '@safescript/contracts';

import { fieldType, resolveSchema, verifyProgram, type StructuredProgram } from './structured-ir.js';

const inputId = ids.type('type:test.input');
const outputId = ids.type('type:test.output');
const cyclicId = ids.type('type:test.cyclic');
const slotId = ids.slot('slot:test.run');
const moduleId = ids.module('module:test/handler');
const location = { module: moduleId, start: 0, end: 1 };
const fingerprint = (value: number) => hash('type', Uint8Array.of(value));
const definitions: TypeDefinition[] = [
  {
    id: inputId,
    schema: { kind: 'record', fields: [{ name: 'enabled', schema: { kind: 'boolean' } }] },
    fingerprint: fingerprint(1),
  },
  {
    id: outputId,
    schema: {
      kind: 'variant',
      variants: [
        { tag: 'ok', schema: { kind: 'unit' } },
        { tag: 'error', schema: { kind: 'string', maxBytes: 20 } },
      ],
    },
    fingerprint: fingerprint(2),
  },
];
const slot: SlotDefinition = {
  id: slotId,
  input: inputId,
  output: outputId,
  effects: [],
  capabilities: [],
  compileLimits: STANDARD_COMPILE_LIMITS,
  executionLimits: STANDARD_EXECUTION_LIMITS,
  fingerprint: hash('contract', Uint8Array.of(4)),
};
const registry: ContractRegistry = {
  id: ids.contract('contract:test'),
  digest: hash('contract', Uint8Array.of(5)),
  schemas: defineSchemaRegistry(definitions),
  effects: [],
  capabilities: [],
  operations: [],
  slots: [slot],
  definitions: [
    ...definitions.map((definition) => ({ id: definition.id, fingerprint: definition.fingerprint })),
    { id: slotId, fingerprint: slot.fingerprint },
  ],
};

function validProgram(): StructuredProgram {
  return {
    version: [1, 1],
    inputType: { kind: 'ref', type: inputId },
    resultType: { kind: 'ref', type: outputId },
    source: location,
    handler: 'run',
    eventParameter: 'event',
    contextParameter: 'context',
    functions: [
      {
        name: 'run',
        parameters: ['event', 'context'],
        body: [
          {
            tag: 'return',
            value: {
              tag: 'result',
              variant: 'ok',
              value: { tag: 'literal', kind: 'unit', value: null, source: location },
              source: location,
            },
            source: location,
          },
        ],
        source: location,
      },
    ],
    summary: { effects: [], capabilities: [] },
  };
}

// Verifier tests intentionally construct untrusted values outside the StructuredProgram type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function changed(mutator: (program: Record<string, any>) => void): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = structuredClone(validProgram()) as unknown as Record<string, any>;
  mutator(program);
  return program;
}

describe('structured IR verification', () => {
  it('accepts a complete program and returns current operation lookups', () => {
    const verified = verifyProgram(validProgram(), registry, slot);
    expect(verified?.program).toEqual(validProgram());
    expect(verified?.operations.size).toBe(0);
  });

  it.each([
    ['non-object', null],
    ['legacy flat IR', { version: [1, 0], entry: 'entry', input: {}, resultType: {}, blocks: [], summary: {} }],
    ['wrong version', changed((program) => (program.version = [1, 0]))],
    ['wrong input type', changed((program) => (program.inputType = { kind: 'unit' }))],
    ['wrong output type', changed((program) => (program.resultType = { kind: 'unit' }))],
    ['missing handler', changed((program) => (program.handler = 'missing'))],
    ['duplicate function', changed((program) => program.functions.push(structuredClone(program.functions[0])))],
    ['malformed source', changed((program) => (program.functions[0].body[0].source.start = -1))],
    ['summary mismatch', changed((program) => program.summary.effects.push('effect:not-used'))],
    ['malformed schema', changed((program) => (program.inputType = { kind: 'list', item: null }))],
  ])('rejects %s', (_name, candidate) => {
    expect(verifyProgram(candidate, registry, slot)).toBeUndefined();
  });

  it('binds every action to a permitted current operation and its exact schemas', () => {
    const effect = ids.effect('effect:test.write');
    const capability = ids.capability('capability:test.write');
    const operationId = ids.operation('operation:test.write');
    const permittedSlot = { ...slot, effects: [effect], capabilities: [capability] };
    const operation = {
      id: operationId,
      input: inputId,
      output: outputId,
      error: outputId,
      effect,
      capability,
      effectCost: 1,
      idempotency: 'none' as const,
      fingerprint: fingerprint(8),
    };
    const permittedRegistry = {
      ...registry,
      effects: [{ id: effect, fingerprint: fingerprint(6) }],
      capabilities: [{ id: capability, fingerprint: fingerprint(7) }],
      operations: [operation],
      slots: [permittedSlot],
    };
    const action = {
      tag: 'action' as const,
      operationId,
      effectId: effect,
      capabilityId: capability,
      actionSiteId: derivedActionSiteId(Uint8Array.of(9)),
      inputType: { kind: 'ref' as const, type: inputId },
      resultType: resultSchema({ kind: 'ref', type: outputId }, { kind: 'ref', type: outputId }),
      input: { tag: 'name' as const, name: 'event', source: location },
      source: location,
    };
    const base = validProgram();
    const handler = base.functions[0];
    if (!handler) throw new Error('bad fixture');
    const program = {
      ...base,
      functions: [
        { ...handler, body: [{ tag: 'expression' as const, expression: action, source: location }, ...handler.body] },
      ],
      summary: { effects: [effect], capabilities: [capability] },
    };
    expect(verifyProgram(program, permittedRegistry, permittedSlot)).toBeDefined();

    for (const mutate of [
      (candidate: typeof action) => Object.assign(candidate, { operationId: ids.operation('operation:missing') }),
      (candidate: typeof action) => Object.assign(candidate, { effectId: ids.effect('effect:wrong') }),
      (candidate: typeof action) => Object.assign(candidate, { capabilityId: ids.capability('capability:wrong') }),
      (candidate: typeof action) => Object.assign(candidate, { inputType: { kind: 'unit' } }),
      (candidate: typeof action) => Object.assign(candidate, { resultType: { kind: 'unit' } }),
      (candidate: typeof action) => Object.assign(candidate, { actionSiteId: 'invalid' }),
    ]) {
      const candidate = structuredClone(program);
      const expression = candidate.functions[0]?.body[0];
      if (expression?.tag !== 'expression' || expression.expression.tag !== 'action') throw new Error('bad fixture');
      mutate(expression.expression as typeof action);
      expect(verifyProgram(candidate, permittedRegistry, permittedSlot)).toBeUndefined();
    }
    expect(verifyProgram(program, permittedRegistry, slot)).toBeUndefined();
  });
});

describe('structured schema helpers', () => {
  it('resolves references and projects fields', () => {
    expect(resolveSchema({ kind: 'ref', type: inputId }, registry)?.kind).toBe('record');
    expect(resolveSchema({ kind: 'ref', type: cyclicId }, registry, new Set([cyclicId]))).toBeUndefined();
    expect(resolveSchema({ kind: 'ref', type: ids.type('type:test.missing') }, registry)).toBeUndefined();
    expect(fieldType({ kind: 'ref', type: inputId }, 'enabled', registry)).toEqual({ kind: 'boolean' });
    expect(fieldType({ kind: 'ref', type: outputId }, 'tag', registry)).toEqual({ kind: 'string' });
    expect(fieldType({ kind: 'ref', type: inputId }, 'missing', registry)).toBeUndefined();
  });
});
