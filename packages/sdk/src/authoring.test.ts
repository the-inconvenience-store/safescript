import { describe, expect, it } from 'bun:test';

import { COMPILER_DIAGNOSTIC_CODES, ids } from '@safescript/contracts';

import { createAuthoringBundle } from './authoring.js';
import { defineContract, type ContractType } from './contract.js';

type Value = Readonly<{ value: string }>;
type Failure =
  Readonly<{ tag: 'policy'; value: Readonly<{ code: string }> }> | Readonly<{ tag: 'domain'; value: string }>;

const valueType: ContractType<Value> = {
  id: ids.type('type:authoring.value'),
  schema: { kind: 'record', fields: [{ name: 'value', schema: { kind: 'string', maxBytes: 64 } }] },
};
const failureType: ContractType<Failure> = {
  id: ids.type('type:authoring.failure'),
  schema: {
    kind: 'variant',
    variants: [
      { tag: 'policy', schema: { kind: 'record', fields: [{ name: 'code', schema: { kind: 'string' } }] } },
      { tag: 'domain', schema: { kind: 'string' } },
    ],
  },
};
const allowedOperation = ids.operation('operation:authoring.allowed');
const deniedOperation = ids.operation('operation:authoring.denied');

const contract = defineContract({
  id: ids.contract('contract:authoring.test'),
  operations: {
    allowed: {
      id: allowedOperation,
      input: valueType,
      output: valueType,
      error: failureType,
      effectCost: 1,
      idempotency: 'none' as const,
    },
    denied: {
      id: deniedOperation,
      input: valueType,
      output: valueType,
      error: failureType,
      effectCost: 1,
      idempotency: 'none' as const,
    },
  },
  slots: {
    run: {
      id: ids.slot('slot:authoring.run'),
      input: valueType,
      output: valueType,
      operations: [allowedOperation],
    },
  },
});

describe('agent authoring bundle', () => {
  it('generates a deterministic, frozen bundle from the exact slot authority', () => {
    const first = createAuthoringBundle(contract, 'run');
    const second = createAuthoringBundle(contract, 'run');
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.contract.fingerprint).toBe(contract.fingerprint);
    expect(first.profile.name).toBe('SafeScript restricted TypeScript');
    expect(first.slot.operations).toEqual([allowedOperation]);
    const declarations = first.files.find((file) => file.name === 'host-api.d.ts')?.content ?? '';
    expect(declarations).toContain('readonly allowed:');
    expect(declarations).not.toContain('readonly denied:');
  });

  it('supplies declarations, slot context, restrictions, examples, and repair guidance without private details', () => {
    const bundle = createAuthoringBundle(contract, 'run');
    expect(bundle.files.map(({ name }) => name)).toEqual([
      'host-api.d.ts',
      'safescript-prelude.d.ts',
      'safescript-globals.d.ts',
      'slot.json',
      'restrictions.md',
      'example.ts',
      'patterns.ts',
    ]);
    expect(bundle.diagnostics.map(({ code }) => code)).toEqual(
      COMPILER_DIAGNOSTIC_CODES.filter((code) => code !== 'SS_INTERNAL_IR_INVALID'),
    );
    for (const entry of bundle.diagnostics) {
      expect(entry.repair.category.length).toBeGreaterThan(0);
      expect(entry.repair.action.length).toBeGreaterThan(0);
      expect(/\bir\b/i.test(entry.repair.action)).toBe(false);
      expect(entry.repair.action.toLowerCase()).not.toContain('semantic graph');
    }
    expect(bundle.files.find(({ name }) => name === 'example.ts')?.content).toContain('export async function');
  });
});
