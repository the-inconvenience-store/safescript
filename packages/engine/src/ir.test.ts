import { describe, expect, it } from 'bun:test';

import {
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  defineSchemaRegistry,
  hash,
  ids,
  type ContractRegistry,
  type SlotDefinition,
  type TypeDefinition,
} from '@safescript/contracts';

import { constantValue, fieldType, resolveSchema, sameType, variantType, verifyProgram, type IrProgram } from './ir.js';

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

function validProgram(): IrProgram {
  return {
    version: [1, 0],
    entry: 'entry',
    input: { register: 'input', type: { kind: 'ref', type: inputId } },
    resultType: { kind: 'ref', type: outputId },
    blocks: [
      {
        id: 'entry',
        parameters: [],
        instructions: [
          { tag: 'constant', destination: 'unit', type: { kind: 'unit' }, value: null, source: location },
          {
            tag: 'construct-variant',
            destination: 'result',
            type: { kind: 'ref', type: outputId },
            variant: 'ok',
            payload: 'unit',
            source: location,
          },
        ],
        terminator: { tag: 'return', value: 'result', source: location },
      },
    ],
    summary: { effects: [], capabilities: [] },
  };
}

// Deliberately loose: verifier tests must construct values outside the trusted IrProgram type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function changed(mutator: (program: Record<string, any>) => void): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = structuredClone(validProgram()) as unknown as Record<string, any>;
  mutator(program);
  return program;
}

describe('IR schema helpers', () => {
  it('compares, resolves, and projects schemas structurally', () => {
    expect(
      sameType({ kind: 'tuple', items: [{ kind: 'boolean' }] }, { kind: 'tuple', items: [{ kind: 'boolean' }] }),
    ).toBe(true);
    expect(sameType({ kind: 'boolean' }, { kind: 'unit' })).toBe(false);
    expect(resolveSchema({ kind: 'ref', type: inputId }, registry)?.kind).toBe('record');
    expect(resolveSchema({ kind: 'ref', type: cyclicId }, registry, new Set([cyclicId]))).toBeUndefined();
    expect(resolveSchema({ kind: 'ref', type: ids.type('type:test.missing') }, registry)).toBeUndefined();
    expect(fieldType({ kind: 'ref', type: inputId }, 'enabled', registry)).toEqual({ kind: 'boolean' });
    expect(fieldType({ kind: 'ref', type: outputId }, 'tag', registry)).toEqual({ kind: 'string' });
    expect(fieldType({ kind: 'ref', type: inputId }, 'missing', registry)).toBeUndefined();
    expect(variantType({ kind: 'ref', type: outputId }, 'error', registry)).toEqual({
      kind: 'string',
      maxBytes: 20,
    });
  });

  it('materialises canonical constants', () => {
    expect(
      constantValue({
        tag: 'constant',
        destination: 'integer',
        type: { kind: 'int64' },
        value: '42',
        source: location,
      }),
    ).toBe(42n);
    expect(
      constantValue({
        tag: 'constant',
        destination: 'text',
        type: { kind: 'string' },
        value: 'safe',
        source: location,
      }),
    ).toBe('safe');
  });
});

describe('IR verification', () => {
  it('returns lookup maps only for a fully verified program', () => {
    const verified = verifyProgram(validProgram(), registry, slot);
    expect(verified?.program).toEqual(validProgram());
    expect(verified?.blocks.get('entry')?.id).toBe('entry');
    expect(verified?.operations.size).toBe(0);
  });

  it.each([
    ['non-object', null],
    ['empty blocks', changed((program) => (program.blocks = []))],
    ['unknown entry', changed((program) => (program.entry = 'missing'))],
    ['duplicate block', changed((program) => program.blocks.push(structuredClone(program.blocks[0])))],
    ['wrong input type', changed((program) => (program.input.type = { kind: 'unit' }))],
    [
      'entry parameters',
      changed((program) => program.blocks[0].parameters.push({ register: 'p', type: { kind: 'unit' } })),
    ],
    ['duplicate register', changed((program) => (program.blocks[0].instructions[1].destination = 'unit'))],
    ['undefined register', changed((program) => (program.blocks[0].instructions[1].payload = 'missing'))],
    ['wrong variant', changed((program) => (program.blocks[0].instructions[1].variant = 'missing'))],
    ['wrong return type', changed((program) => (program.blocks[0].terminator.value = 'unit'))],
    ['summary mismatch', changed((program) => program.summary.effects.push('effect:not-used'))],
    ['malformed source', changed((program) => (program.blocks[0].terminator.source.start = -1))],
  ])('rejects %s', (_name, candidate) => {
    expect(verifyProgram(candidate, registry, slot)).toBeUndefined();
  });

  it('rejects missing successors and control-flow cycles', () => {
    const missing = changed((program) => {
      program.blocks[0].terminator = { tag: 'jump', target: 'missing', arguments: [], source: location };
    });
    expect(verifyProgram(missing, registry, slot)).toBeUndefined();
    const cycle = changed((program) => {
      program.blocks[0].terminator = { tag: 'jump', target: 'entry', arguments: [], source: location };
    });
    expect(verifyProgram(cycle, registry, slot)).toBeUndefined();
  });
});
