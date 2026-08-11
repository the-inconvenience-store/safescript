import { describe, expect, it } from 'bun:test';

import {
  COMPILER_DIAGNOSTIC_CODES,
  DIAGNOSTIC_CATALOG,
  EXECUTION_ERROR_CODES,
  HOST_FAILURE_CODES,
  JSON_VALUE_REGISTRY,
  JSON_VALUE_TYPE,
  MAX_FAILURE_DETAIL_LENGTH,
  MAX_FAILURE_PATH_SEGMENTS,
  SEMANTIC_GRAPH_SCHEMA,
  SEMANTIC_EDIT_KINDS,
  SEMANTIC_EDIT_SCHEMA,
  STANDARD_COMPILE_LIMITS,
  STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
  STANDARD_SEMANTIC_EDIT_LIMITS,
  canonicalJson,
  canonicalize,
  decodeCanonical,
  defineSchemaRegistry,
  encodeCanonical,
  hash,
  ids,
  isActionOutcome,
  isApplySemanticEditsRequest,
  isSemanticEdit,
  isSemanticEditCapabilityViewRequest,
  optionSchema,
  resultSchema,
  type ContractFailureCode,
  type Schema,
  type TypeDefinition,
} from './index.js';

describe('semantic edit contracts', () => {
  it('publishes schema 1.0, conservative independent limits, and a closed operation catalog', () => {
    expect(SEMANTIC_EDIT_SCHEMA).toEqual({ major: 1, minor: 0 });
    expect(STANDARD_SEMANTIC_EDIT_LIMITS).toEqual({
      operations: 1_024,
      fragmentBytes: 1024 * 1024,
      transformedRegions: 4_096,
      work: 2_000_000,
      provenanceEntries: 500_000,
      diffBytes: 4 * 1024 * 1024,
      sourceBytes: 1024 * 1024,
    });
    expect(STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS).toEqual({
      targets: 500_000,
      capabilities: 2_000_000,
      bytes: 8 * 1024 * 1024,
    });
    expect(SEMANTIC_EDIT_KINDS).toHaveLength(30);
  });

  it('validates one closed primitive and rejects unknown kinds or fields', () => {
    const edit = {
      kind: 'rename_symbol',
      editId: 'edit:rename_1',
      target: `semantic-node:${'a'.repeat(64)}`,
      newName: 'renamed',
      preconditions: [
        { kind: 'target_semantic_kind', value: 'symbol' },
        { kind: 'old_name', value: 'before' },
      ],
    };
    expect(isSemanticEdit(edit)).toBe(true);
    expect(isSemanticEdit({ ...edit, surprise: true })).toBe(false);
    expect(isSemanticEdit({ ...edit, kind: 'rewrite_everything' })).toBe(false);
  });

  it('validates every primitive and gesture as a closed serialisable record', () => {
    const node = `semantic-node:${'b'.repeat(64)}`;
    const other = `semantic-node:${'c'.repeat(64)}`;
    const anchor = { container: node, index: 0 };
    const expression = { category: 'expression', source: [0x31] };
    const statementList = { category: 'statement_list', source: [] };
    const bindingPattern = { category: 'binding_pattern', source: [0x78] };
    const common = { editId: 'edit:catalog', preconditions: [] };
    const samples: Readonly<Record<string, unknown>> = {
      rename_symbol: { ...common, kind: 'rename_symbol', target: node, newName: 'next' },
      replace_target: { ...common, kind: 'replace_target', target: node, replacement: expression },
      insert_at_anchor: { ...common, kind: 'insert_at_anchor', anchor, fragment: statementList },
      delete_target: {
        ...common,
        kind: 'delete_target',
        target: node,
        commentPolicy: 'preserve_owned_comments',
      },
      move_target: { ...common, kind: 'move_target', target: node, destination: anchor },
      reorder_children: { ...common, kind: 'reorder_children', container: node, children: [other] },
      wrap_statement_range: {
        ...common,
        kind: 'wrap_statement_range',
        range: { container: node, first: other, last: other },
        control: { kind: 'if', condition: expression, branch: 'true' },
      },
      move_statement_range: {
        ...common,
        kind: 'move_statement_range',
        range: { container: node, first: other, last: other },
        destination: anchor,
      },
      unwrap_control: { ...common, kind: 'unwrap_control', target: node, retainedContainer: other },
      add_branch: { ...common, kind: 'add_branch', target: node, branch: { kind: 'else', body: statementList } },
      remove_branch: {
        ...common,
        kind: 'remove_branch',
        target: node,
        commentPolicy: 'delete_owned_comments',
      },
      convert_control: {
        ...common,
        kind: 'convert_control',
        target: node,
        control: { kind: 'while', condition: expression },
        retainedContainers: [{ from: other, role: 'body' }],
      },
      extract_local: {
        ...common,
        kind: 'extract_local',
        target: node,
        name: 'value',
        declaration: anchor,
        replaceTargets: [node],
      },
      inline_local: {
        ...common,
        kind: 'inline_local',
        binding: node,
        references: [other],
        removeDeclaration: true,
        commentPolicy: 'preserve_owned_comments',
      },
      extract_function: {
        ...common,
        kind: 'extract_function',
        range: { container: node, first: other, last: other },
        name: 'helper',
        declaration: anchor,
        parameters: [{ symbol: `symbol:${'d'.repeat(64)}`, name: 'input' }],
        outputs: [],
      },
      inline_function_call: {
        ...common,
        kind: 'inline_function_call',
        call: node,
        function: other,
        parameterArguments: [{ parameter: node, argument: other }],
        removeDeclaration: false,
        commentPolicy: 'preserve_owned_comments',
      },
      change_binding_pattern: { ...common, kind: 'change_binding_pattern', target: node, pattern: bindingPattern },
      change_binding_mutability: { ...common, kind: 'change_binding_mutability', target: node, mutability: 'let' },
      change_action_operation: {
        ...common,
        kind: 'change_action_operation',
        target: node,
        operation: 'operation:tasks.create',
        fieldMappings: [{ from: ['title'], to: ['name'] }],
        requiredInputs: [{ path: ['workspaceId'], value: expression }],
      },
      set_action_input_field: {
        ...common,
        kind: 'set_action_input_field',
        target: node,
        path: ['title'],
        value: expression,
      },
      remove_action_input_field: { ...common, kind: 'remove_action_input_field', target: node, path: ['title'] },
      bind_action_result: { ...common, kind: 'bind_action_result', target: node, pattern: bindingPattern },
      add_action_result_branch: {
        ...common,
        kind: 'add_action_result_branch',
        target: node,
        variant: 'error',
        body: statementList,
      },
      set_literal_value: { ...common, kind: 'set_literal_value', target: node, value: 'changed' },
      change_operator: { ...common, kind: 'change_operator', target: node, operator: '===' },
      change_member_name: { ...common, kind: 'change_member_name', target: node, name: 'title' },
      toggle_optional_access: { ...common, kind: 'toggle_optional_access', target: node, optional: true },
      change_call_callee: { ...common, kind: 'change_call_callee', target: node, callee: expression },
      change_object_field_name: { ...common, kind: 'change_object_field_name', target: node, name: 'title' },
      change_result_variant: { ...common, kind: 'change_result_variant', target: node, variant: 'ok' },
    };
    expect(Object.keys(samples)).toEqual([...SEMANTIC_EDIT_KINDS]);
    for (const kind of SEMANTIC_EDIT_KINDS) {
      expect(isSemanticEdit(samples[kind]), kind).toBe(true);
      expect(isSemanticEdit({ ...(samples[kind] as object), unexpected: true }), `${kind} extras`).toBe(false);
    }
  });

  it('validates schema-bound capability views and atomic edit request envelopes', () => {
    const target = `semantic-node:${'e'.repeat(64)}`;
    const capability = {
      kind: 'semantic_edit_capabilities',
      schema: SEMANTIC_EDIT_SCHEMA,
      scope: { targets: [target] },
      limits: STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS,
    };
    expect(isSemanticEditCapabilityViewRequest(capability)).toBe(true);
    expect(isSemanticEditCapabilityViewRequest({ ...capability, scope: { targets: [target, target] } })).toBe(false);
    expect(isSemanticEditCapabilityViewRequest({ ...capability, schema: { major: 2, minor: 0 } })).toBe(false);

    const edit = {
      kind: 'rename_symbol',
      editId: 'edit:rename',
      target,
      newName: 'renamed',
      preconditions: [{ kind: 'old_name', value: 'before' }],
    };
    const request = {
      registry: {},
      slotId: 'slot:test',
      source: { module: 'module:test', source: [] },
      limits: STANDARD_COMPILE_LIMITS,
      editSchema: SEMANTIC_EDIT_SCHEMA,
      graphSchema: SEMANTIC_GRAPH_SCHEMA,
      baseRevision: `semantic-revision:${'f'.repeat(64)}`,
      edits: [edit],
      editLimits: STANDARD_SEMANTIC_EDIT_LIMITS,
      views: [capability],
    };
    expect(isApplySemanticEditsRequest(request)).toBe(true);
    expect(isApplySemanticEditsRequest({ ...request, edits: [] })).toBe(false);
    expect(isApplySemanticEditsRequest({ ...request, edits: [edit, edit] })).toBe(false);
    expect(isApplySemanticEditsRequest({ ...request, editSchema: { major: 1, minor: 1 } })).toBe(false);
    expect(isApplySemanticEditsRequest({ ...request, extra: true })).toBe(false);
  });

  it('fails closed on hostile records, enforces fragment categories, and counts repeated fragments by value', () => {
    const target = `semantic-node:${'a'.repeat(64)}`;
    const hostile = Object.defineProperty({}, 'kind', {
      enumerable: true,
      get: () => {
        throw new Error('must not run');
      },
    });
    expect(() => isSemanticEdit(hostile)).not.toThrow();
    expect(isSemanticEdit(hostile)).toBe(false);
    const hostileProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('must not escape');
        },
      },
    );
    expect(() => isSemanticEdit(hostileProxy)).not.toThrow();
    expect(isSemanticEdit(hostileProxy)).toBe(false);
    expect(
      isSemanticEdit({
        kind: 'replace_target',
        editId: 'edit:invalid-utf8',
        target,
        replacement: { category: 'expression', source: [0xff] },
        preconditions: [],
      }),
    ).toBe(false);

    expect(
      isSemanticEdit({
        kind: 'wrap_statement_range',
        editId: 'edit:wrong-category',
        range: { container: target, first: target, last: target },
        control: { kind: 'if', condition: { category: 'statement', source: [] }, branch: 'true' },
        preconditions: [],
      }),
    ).toBe(false);

    const sharedExpression = { category: 'expression', source: [0x31] };
    const request = {
      registry: {},
      slotId: 'slot:test',
      source: { module: 'module:test', source: [] },
      limits: STANDARD_COMPILE_LIMITS,
      editSchema: SEMANTIC_EDIT_SCHEMA,
      graphSchema: SEMANTIC_GRAPH_SCHEMA,
      baseRevision: `semantic-revision:${'f'.repeat(64)}`,
      edits: [
        {
          kind: 'change_action_operation',
          editId: 'edit:shared-fragment',
          target,
          operation: 'operation:tasks.create',
          fieldMappings: [],
          requiredInputs: [
            { path: ['first'], value: sharedExpression },
            { path: ['second'], value: sharedExpression },
          ],
          preconditions: [],
        },
      ],
      editLimits: { ...STANDARD_SEMANTIC_EDIT_LIMITS, fragmentBytes: 1 },
    };
    expect(isApplySemanticEditsRequest(request)).toBe(false);
  });
});

describe('action outcome validation', () => {
  it('accepts only the current closed action outcome shape', () => {
    const invocationId = ids.invocation('invocation:0123456789abcdef0123456789abcdef');
    const requestId = ids.request(invocationId, 0);
    expect(
      isActionOutcome({
        requestId,
        result: { tag: 'completed', value: [0x82, 0x62, 0x6f, 0x6b, 0xf6] },
      }),
    ).toBe(true);
    expect(
      isActionOutcome({
        requestId,
        result: { tag: 'rejected', value: { code: 'denied' } },
      }),
    ).toBe(false);
  });
});

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const encodedHex = (schema: Schema, value: unknown): string => {
  const result = encodeCanonical(schema, value);
  if (!result.ok) throw new Error(result.failure.code);
  return hex(result.value);
};

describe('deterministic CBOR profile', () => {
  it('has stable scalar and positional fixture vectors', () => {
    expect(encodedHex({ kind: 'unit' }, null)).toBe('f6');
    expect(encodedHex({ kind: 'boolean' }, true)).toBe('f5');
    expect(encodedHex({ kind: 'int64' }, -(1n << 63n))).toBe('3b7fffffffffffffff');
    expect(encodedHex({ kind: 'float64' }, 1.5)).toBe('fb3ff8000000000000');
    expect(encodedHex({ kind: 'string' }, '😀')).toBe('64f09f9880');
    expect(encodedHex({ kind: 'bytes' }, [0, 255])).toBe('4200ff');
    expect(encodedHex({ kind: 'instant' }, { epochSeconds: 0n, nanoseconds: 1 })).toBe('820001');
    expect(
      encodedHex(
        {
          kind: 'record',
          fields: [
            { name: 'name', schema: { kind: 'string' } },
            { name: 'count', schema: { kind: 'int64' } },
          ],
        },
        { count: 1n, name: 'x' },
      ),
    ).toBe('82617801');
    expect(encodedHex(optionSchema({ kind: 'int64' }), { tag: 'some', value: 1n })).toBe('8264736f6d6501');
    expect(encodedHex({ kind: 'tuple', items: [{ kind: 'boolean' }, { kind: 'string' }] }, [false, 'x'])).toBe(
      '82f46178',
    );
  });

  it('round-trips immutable schema-directed values', () => {
    const schema: Schema = {
      kind: 'record',
      fields: [
        { name: 'choice', schema: resultSchema({ kind: 'string' }, { kind: 'int64' }) },
        { name: 'payload', schema: { kind: 'bytes', maxBytes: 4 } },
      ],
    };
    const result = canonicalize(schema, { payload: [1, 2], choice: { tag: 'ok', value: 'yes' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ choice: { tag: 'ok', value: 'yes' }, payload: [1, 2] });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen((result.value as { payload: readonly number[] }).payload)).toBe(true);
  });

  it('rejects every alternate or malformed representative before use', () => {
    const failures: readonly [Schema, Uint8Array, ContractFailureCode][] = [
      [{ kind: 'int64' }, Uint8Array.of(0x18, 0x00), 'noncanonical_cbor'],
      [{ kind: 'int64' }, Uint8Array.of(0x00, 0x00), 'trailing_bytes'],
      [{ kind: 'string' }, Uint8Array.of(0x61, 0x80), 'malformed_cbor'],
      [{ kind: 'float64' }, Uint8Array.of(0xfb, 0x80, 0, 0, 0, 0, 0, 0, 0), 'noncanonical_cbor'],
      [{ kind: 'float64' }, Uint8Array.of(0xfb, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0), 'noncanonical_cbor'],
      [{ kind: 'list', item: { kind: 'unit' } }, Uint8Array.of(0x9f, 0xff), 'malformed_cbor'],
      [{ kind: 'tuple', items: [] }, Uint8Array.of(0x81, 0xf6), 'schema_mismatch'],
      [{ kind: 'record', fields: [] }, Uint8Array.of(0xa0), 'schema_mismatch'],
      [{ kind: 'string', maxBytes: 1 }, Uint8Array.of(0x62, 0x61, 0x62), 'limit_exceeded'],
    ];
    for (const [schema, bytes, code] of failures) {
      const result = decodeCanonical(schema, bytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe(code);
    }
    expect(encodeCanonical({ kind: 'string' }, '\ud800').ok).toBe(false);
    expect(encodeCanonical({ kind: 'record', fields: [] }, { surprise: true }).ok).toBe(false);
    let getterRan = false;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        getterRan = true;
        return 1n;
      },
    });
    expect(
      encodeCanonical({ kind: 'record', fields: [{ name: 'value', schema: { kind: 'int64' } }] }, accessor).ok,
    ).toBe(false);
    expect(getterRan).toBe(false);
  });
});

describe('recursive schemas and JSON', () => {
  it('accepts finite named recursion and rejects recursion without an inhabitant', () => {
    const tree = ids.type('type:test.tree');
    const fingerprint = hash('type', Uint8Array.of(1));
    const definition: TypeDefinition = {
      id: tree,
      fingerprint,
      schema: {
        kind: 'variant',
        variants: [
          { tag: 'leaf', schema: { kind: 'unit' } },
          { tag: 'branch', schema: { kind: 'list', item: { kind: 'ref', type: tree }, maxItems: 1 } },
        ],
      },
    };
    const registry = defineSchemaRegistry([definition]);
    let value: unknown = { tag: 'leaf', value: null };
    for (let index = 0; index < 20; index++) value = { tag: 'branch', value: [value] };
    expect(encodeCanonical({ kind: 'ref', type: tree }, value, { registry }).ok).toBe(true);
    expect(
      encodeCanonical({ kind: 'ref', type: tree }, value, {
        registry,
        limits: { maxBytes: 4096, maxDepth: 8, maxNodes: 100 },
      }).ok,
    ).toBe(false);

    const impossible = ids.type('type:test.impossible');
    expect(() =>
      defineSchemaRegistry([
        {
          id: impossible,
          fingerprint,
          schema: { kind: 'record', fields: [{ name: 'next', schema: { kind: 'ref', type: impossible } }] },
        },
      ]),
    ).toThrow('no finite inhabitant');
  });

  it('uses the accepted sorted tagged JsonValue representation', () => {
    const result = canonicalJson({ z: null, a: [true, -0] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      tag: 'object',
      value: [
        [
          'a',
          {
            tag: 'array',
            value: [
              { tag: 'boolean', value: true },
              { tag: 'number', value: 0 },
            ],
          },
        ],
        ['z', { tag: 'null', value: null }],
      ],
    });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(
      encodeCanonical({ kind: 'ref', type: JSON_VALUE_TYPE }, result.value, { registry: JSON_VALUE_REGISTRY }).ok,
    ).toBe(true);
    expect(
      encodeCanonical(
        { kind: 'ref', type: JSON_VALUE_TYPE },
        {
          tag: 'object',
          value: [
            ['z', { tag: 'null', value: null }],
            ['a', { tag: 'null', value: null }],
          ],
        },
        { registry: JSON_VALUE_REGISTRY },
      ).ok,
    ).toBe(false);
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(canonicalJson(cycle).ok).toBe(false);
  });
});

describe('identities', () => {
  it('validates typed identifiers and full domain-separated hashes', () => {
    const invocation = ids.invocation('invocation:0123456789abcdef0123456789abcdef');
    expect(String(ids.request(invocation, 7))).toBe('request:0123456789abcdef0123456789abcdef:7');
    expect(String(ids.module('module:@host/api'))).toBe('module:@host/api');
    expect(() => ids.operation('effect:tasks.create')).toThrow();
    expect(String(hash('source', Uint8Array.of(1)))).toBe(
      'd8e0671485299b0d850838d8b99972fa4c6d404061f3ea340761e1e6a3fdb5c1',
    );
    expect(hash('source', Uint8Array.of(1))).not.toBe(hash('ir', Uint8Array.of(1)));
  });
});

describe('stable failure catalog', () => {
  it('has one deterministic owner and meaning for every closed public code', () => {
    const expectedCodes = new Set<string>([
      ...COMPILER_DIAGNOSTIC_CODES,
      ...EXECUTION_ERROR_CODES,
      ...HOST_FAILURE_CODES,
      'adapter_failure',
      'artifact_verification_failed',
      'bridge_closed',
      'capacity_exceeded',
      'fingerprint_mismatch',
      'graph_limit_exceeded',
      'invalid_contract_digest',
      'invalid_definition_id',
      'invalid_request',
      'invalid_schema',
      'invalid_value',
      'limit_exceeded',
      'malformed_cbor',
      'missing_definition',
      'noncanonical_cbor',
      'schema_mismatch',
      'trailing_bytes',
      'unknown_type',
      'unsupported_version',
      'worker_close_timeout',
      'worker_identity_mismatch',
      'worker_lost',
      'worker_start_failed',
      'worker_start_timeout',
    ]);
    const codes: string[] = DIAGNOSTIC_CATALOG.map((entry) => entry.code);
    const meanings = DIAGNOSTIC_CATALOG.map((entry) => entry.meaning);
    expect(codes).toEqual([...codes].sort((left, right) => left.localeCompare(right)));
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(meanings).size).toBe(meanings.length);
    expect(new Set(codes)).toEqual(expectedCodes);
    expect(COMPILER_DIAGNOSTIC_CODES.every((code) => code.startsWith('SS_'))).toBe(true);
    expect([...COMPILER_DIAGNOSTIC_CODES]).toEqual(
      [...COMPILER_DIAGNOSTIC_CODES].sort((left, right) => left.localeCompare(right)),
    );
    for (const entry of DIAGNOSTIC_CATALOG) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.fields)).toBe(true);
      expect(entry.owner).not.toContain('pass');
      expect(entry.meaning.length).toBeLessThanOrEqual(MAX_FAILURE_DETAIL_LENGTH);
      expect(new Set(entry.fields).size).toBe(entry.fields.length);
    }
  });

  it('bounds validation paths and safe detail without exposing the rejected value', () => {
    let schema: Schema = { kind: 'int64' };
    let value: unknown = 'SUPER_SECRET_VALUE';
    for (let index = 0; index < MAX_FAILURE_PATH_SEGMENTS + 16; index++) {
      schema = { kind: 'record', fields: [{ name: `field${index}`, schema }] };
      value = { [`field${index}`]: value };
    }
    const result = encodeCanonical(schema, value, {
      limits: { maxBytes: 1024 * 1024, maxDepth: 1024, maxNodes: 1024 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.path.length).toBe(MAX_FAILURE_PATH_SEGMENTS);
      expect(result.failure.detail?.length ?? 0).toBeLessThanOrEqual(MAX_FAILURE_DETAIL_LENGTH);
      expect(JSON.stringify(result.failure)).not.toContain('SUPER_SECRET_VALUE');
    }
  });
});
