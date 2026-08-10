import {
  decodeWorkerProtocolPayload,
  encodeWorkerProtocolPayload,
  type ActionOutcome,
  type ActionRequest,
  type CancelRequest,
  type CancelResult,
  type CheckRequest,
  type CheckResult,
  type CloseResult,
  type ExecuteRequest,
  type ExecutionResult,
  type InspectRequest,
  type InspectResult,
  type WorkerProtocolCodecResult,
  type WorkerProtocolCodecLimits,
  type WorkerProtocolMessageKind,
  type WorkerProtocolPayload,
  type WorkerProtocolSchema,
} from '@safescript/contracts';

const MAX_TEXT = 4096;
const MAX_ITEMS = 1_000_000;
const MAX_BYTES = 16_700_000;

const boolean = (): WorkerProtocolSchema => ({ kind: 'boolean' });
const uint = (): WorkerProtocolSchema => ({ kind: 'uint' });
const float64 = (): WorkerProtocolSchema => ({ kind: 'float64' });
const text = (maxBytes = MAX_TEXT): WorkerProtocolSchema => ({ kind: 'text', maxBytes });
const bytes = (): WorkerProtocolSchema => ({ kind: 'bytes', maxBytes: MAX_BYTES });
const literal = (value: null | boolean | bigint | string): WorkerProtocolSchema => ({ kind: 'literal', value });
const array = (item: WorkerProtocolSchema, maxItems = MAX_ITEMS): WorkerProtocolSchema => ({
  kind: 'array',
  item,
  maxItems,
});
const record = (
  fields: readonly Readonly<{ name: string; schema: WorkerProtocolSchema; optional?: boolean }>[],
): WorkerProtocolSchema => ({ kind: 'record', fields });
const oneOf = (...choices: WorkerProtocolSchema[]): WorkerProtocolSchema => ({ kind: 'oneOf', choices });
const messageId: WorkerProtocolSchema = { kind: 'uint', minimum: 1n };
const epochSeconds: WorkerProtocolSchema = { kind: 'int' };
const schemaInt: WorkerProtocolSchema = { kind: 'int' };

const instant = record([
  { name: 'epoch_seconds', schema: epochSeconds },
  { name: 'nanoseconds', schema: { kind: 'uint', maximum: 999_999_999n } },
]);
const sourceLocation = record([
  { name: 'module', schema: text() },
  { name: 'start', schema: uint() },
  { name: 'end', schema: uint() },
]);
const compilerVersion = record([{ name: 'build', schema: text() }]);
const compileLimits = record(
  ['source_bytes', 'imports', 'declarations', 'syntax_nodes', 'syntax_depth', 'type_depth', 'derived_template_bytes']
    .map((name) => ({ name, schema: uint() }))
    .concat({ name: 'include_diagnostics', schema: boolean() }),
);
const executionLimits = record(
  [
    'max_depth',
    'max_nodes',
    'max_bytes',
    'fuel',
    'allocations',
    'allocated_bytes',
    'collection_items',
    'call_depth',
    'host_calls',
    'trace_bytes',
    'output_bytes',
  ].map((name) => ({ name, schema: uint() })),
);

function contractSchema(maximumDepth = 64): WorkerProtocolSchema {
  const primitive = oneOf(
    record([{ name: 'kind', schema: literal('unit') }]),
    record([{ name: 'kind', schema: literal('boolean') }]),
    record([
      { name: 'kind', schema: literal('int64') },
      { name: 'minimum', schema: schemaInt, optional: true },
      { name: 'maximum', schema: schemaInt, optional: true },
    ]),
    record([
      { name: 'kind', schema: literal('float64') },
      { name: 'minimum', schema: float64(), optional: true },
      { name: 'maximum', schema: float64(), optional: true },
    ]),
    record([
      { name: 'kind', schema: literal('string') },
      { name: 'max_bytes', schema: uint(), optional: true },
    ]),
    record([
      { name: 'kind', schema: literal('bytes') },
      { name: 'max_bytes', schema: uint(), optional: true },
    ]),
    record([
      { name: 'kind', schema: literal('instant') },
      { name: 'minimum', schema: instant, optional: true },
      { name: 'maximum', schema: instant, optional: true },
    ]),
    record([
      { name: 'kind', schema: literal('ref') },
      { name: 'type', schema: text() },
    ]),
  );
  let nested = primitive;
  for (let depth = 0; depth < maximumDepth; depth++) {
    const child = nested;
    nested = oneOf(
      primitive,
      record([
        { name: 'kind', schema: literal('list') },
        { name: 'item', schema: child },
        { name: 'max_items', schema: uint(), optional: true },
      ]),
      record([
        { name: 'kind', schema: literal('tuple') },
        { name: 'items', schema: array(child) },
      ]),
      record([
        { name: 'kind', schema: literal('record') },
        {
          name: 'fields',
          schema: array(
            record([
              { name: 'name', schema: text() },
              { name: 'schema', schema: child },
            ]),
          ),
        },
      ]),
      record([
        { name: 'kind', schema: literal('variant') },
        {
          name: 'variants',
          schema: array(
            record([
              { name: 'tag', schema: text() },
              { name: 'schema', schema: child },
            ]),
          ),
        },
      ]),
      record([
        { name: 'kind', schema: literal('brand') },
        { name: 'type', schema: text() },
        { name: 'base', schema: child },
      ]),
    );
  }
  return nested;
}

const schema = contractSchema();
const typeDefinition = record([
  { name: 'id', schema: text() },
  { name: 'schema', schema },
  { name: 'fingerprint', schema: text(64) },
]);
const fingerprintDefinition = record([
  { name: 'id', schema: text() },
  { name: 'fingerprint', schema: text(64) },
]);
const operationDefinition = record([
  { name: 'id', schema: text() },
  { name: 'input', schema: text() },
  { name: 'output', schema: text() },
  { name: 'error', schema: text() },
  { name: 'effect_cost', schema: uint() },
  { name: 'fingerprint', schema: text(64) },
]);
const slotDefinition = record([
  { name: 'id', schema: text() },
  { name: 'input', schema: text() },
  { name: 'output', schema: text() },
  { name: 'operations', schema: array(text()) },
  { name: 'compile_limits', schema: compileLimits },
  { name: 'execution_limits', schema: executionLimits },
  { name: 'fingerprint', schema: text(64) },
]);
const registry = record([
  { name: 'id', schema: text() },
  { name: 'digest', schema: text(64) },
  { name: 'schemas', schema: record([{ name: 'types', schema: array(typeDefinition) }]) },
  { name: 'operations', schema: array(operationDefinition) },
  { name: 'slots', schema: array(slotDefinition) },
  { name: 'definitions', schema: array(fingerprintDefinition) },
]);
const sourceProgram = record([
  { name: 'module', schema: text() },
  { name: 'source', schema: bytes() },
]);
const checkRequest = record([
  { name: 'registry', schema: registry },
  { name: 'slot_id', schema: text() },
  { name: 'source', schema: sourceProgram },
  { name: 'limits', schema: compileLimits },
  { name: 'include_artifact', schema: boolean(), optional: true },
  { name: 'cached_artifact', schema: bytes(), optional: true },
]);
const graphLimits = record([
  { name: 'nodes', schema: uint() },
  { name: 'edges', schema: uint() },
  { name: 'bytes', schema: uint() },
]);
const inspectRequest = record([
  ...(checkRequest.kind === 'record' ? checkRequest.fields : []),
  { name: 'views', schema: array(literal('semantic_graph'), 1) },
  { name: 'graph_limits', schema: graphLimits, optional: true },
]);
const executeRequest = record([
  { name: 'registry', schema: registry },
  { name: 'slot_id', schema: text() },
  { name: 'invocation_id', schema: text() },
  {
    name: 'program',
    schema: oneOf(
      record([
        { name: 'kind', schema: literal('source') },
        { name: 'source', schema: checkRequest },
      ]),
      record([
        { name: 'kind', schema: literal('artifact') },
        { name: 'bytes', schema: bytes() },
      ]),
    ),
  },
  { name: 'input', schema: bytes() },
  { name: 'limits', schema: executionLimits },
  { name: 'fixed_instant', schema: instant, optional: true },
  { name: 'random_seed', schema: bytes(), optional: true },
  { name: 'trace', schema: boolean() },
]);
const cancelRequest = record([{ name: 'invocation_id', schema: text() }]);

const bridgeError = record([
  { name: 'code', schema: text() },
  { name: 'phase', schema: text() },
  { name: 'detail', schema: text(), optional: true },
]);
const compileUsage = record([
  { name: 'source_bytes', schema: uint() },
  { name: 'syntax_nodes', schema: uint() },
]);
const programSummary = record([{ name: 'operations', schema: array(text()) }]);
const compilerProvenance = record([{ name: 'compiler', schema: compilerVersion }]);
const diagnostic = record([
  { name: 'code', schema: text() },
  { name: 'severity', schema: oneOf(literal('error'), literal('warning'), literal('info')) },
  { name: 'message', schema: text() },
  {
    name: 'repair',
    schema: record([
      { name: 'category', schema: text() },
      { name: 'action', schema: text() },
    ]),
  },
  { name: 'location', schema: sourceLocation, optional: true },
  { name: 'related', schema: array(sourceLocation), optional: true },
]);
const checkAccepted = record([
  { name: 'status', schema: literal('accepted') },
  { name: 'artifact', schema: bytes(), optional: true },
  { name: 'summary', schema: programSummary },
  { name: 'provenance', schema: compilerProvenance },
  { name: 'usage', schema: compileUsage },
  { name: 'diagnostics', schema: array(diagnostic) },
]);
const checkResult = oneOf(
  checkAccepted,
  record([
    { name: 'status', schema: literal('rejected') },
    { name: 'diagnostics', schema: array(diagnostic) },
    { name: 'usage', schema: compileUsage },
  ]),
  record([
    { name: 'status', schema: literal('bridge_error') },
    { name: 'error', schema: bridgeError },
  ]),
);
const graphError = record([
  { name: 'code', schema: literal('graph_limit_exceeded') },
  { name: 'limit', schema: oneOf(literal('nodes'), literal('edges'), literal('bytes')) },
  { name: 'maximum', schema: uint() },
  { name: 'actual', schema: uint() },
]);
const inspectResult = oneOf(
  record([
    { name: 'status', schema: literal('accepted') },
    { name: 'check', schema: checkAccepted },
    { name: 'views', schema: record([{ name: 'semantic_graph', schema: bytes(), optional: true }]) },
    { name: 'view_errors', schema: record([{ name: 'semantic_graph', schema: graphError, optional: true }]) },
  ]),
  ...(checkResult.kind === 'oneOf' ? checkResult.choices.slice(1) : []),
);

const actionRequest = record([
  { name: 'contract_id', schema: text() },
  { name: 'ir_digest', schema: text(64) },
  { name: 'invocation_id', schema: text() },
  { name: 'request_id', schema: text() },
  { name: 'slot_id', schema: text() },
  { name: 'operation_id', schema: text() },
  { name: 'action_site_id', schema: text() },
  { name: 'source', schema: sourceLocation },
  { name: 'input', schema: bytes() },
]);
const hostFailure = record([
  {
    name: 'code',
    schema: oneOf(
      literal('cancelled'),
      literal('gateway_fault'),
      literal('handler_fault'),
      literal('invalid_result'),
      literal('timeout'),
      literal('transport_lost'),
      literal('unavailable'),
    ),
  },
  { name: 'detail', schema: text(160), optional: true },
]);
const actionOutcome = record([
  { name: 'request_id', schema: text() },
  {
    name: 'result',
    schema: oneOf(
      record([
        { name: 'tag', schema: literal('completed') },
        { name: 'value', schema: bytes() },
      ]),
      record([
        { name: 'tag', schema: literal('failed') },
        {
          name: 'value',
          schema: record([
            { name: 'effect_state', schema: oneOf(literal('not_performed'), literal('unknown')) },
            { name: 'failure', schema: hostFailure },
          ]),
        },
      ]),
    ),
  },
]);
const actionRecord = oneOf(
  record([
    { name: 'phase', schema: literal('requested') },
    { name: 'request', schema: actionRequest },
  ]),
  record([
    { name: 'phase', schema: literal('resolved') },
    { name: 'request_id', schema: text() },
    { name: 'outcome', schema: actionOutcome },
  ]),
);
const executionUsage = record(
  [
    'fuel',
    'allocations',
    'allocated_bytes',
    'peak_collection_items',
    'peak_value_depth',
    'peak_value_nodes',
    'peak_value_bytes',
    'peak_call_depth',
    'host_calls',
    'trace_bytes',
    'output_bytes',
  ].map((name) => ({ name, schema: uint() })),
);
const executionPreparation = oneOf(
  record([
    { name: 'kind', schema: literal('source') },
    { name: 'artifact', schema: bytes(), optional: true },
    { name: 'summary', schema: programSummary },
    { name: 'provenance', schema: compilerProvenance },
    { name: 'usage', schema: compileUsage },
    { name: 'diagnostics', schema: array(diagnostic) },
  ]),
  record([
    { name: 'kind', schema: literal('artifact') },
    { name: 'ir_digest', schema: text(64) },
  ]),
);
const executionFacts = record([
  { name: 'preparation', schema: executionPreparation },
  { name: 'actions', schema: array(actionRecord) },
  {
    name: 'trace',
    schema: record([
      { name: 'records', schema: array(bytes()) },
      { name: 'truncated', schema: boolean() },
    ]),
  },
  { name: 'usage', schema: executionUsage },
]);
const executionError = record([
  { name: 'code', schema: text() },
  { name: 'detail', schema: text(), optional: true },
  { name: 'source', schema: sourceLocation, optional: true },
]);
const executionResult = oneOf(
  record([
    { name: 'status', schema: literal('not_started') },
    { name: 'diagnostics', schema: array(diagnostic), optional: true },
    { name: 'error', schema: bridgeError, optional: true },
    { name: 'usage', schema: compileUsage, optional: true },
  ]),
  record([
    { name: 'status', schema: literal('completed') },
    { name: 'output', schema: bytes() },
    { name: 'facts', schema: executionFacts },
  ]),
  record([
    { name: 'status', schema: literal('failed') },
    { name: 'error', schema: executionError },
    { name: 'facts', schema: executionFacts },
  ]),
  record([
    { name: 'status', schema: literal('cancelled') },
    { name: 'error', schema: executionError },
    { name: 'facts', schema: executionFacts },
  ]),
  record([
    { name: 'status', schema: literal('bridge_error') },
    { name: 'error', schema: bridgeError },
  ]),
);
const cancelResult = oneOf(
  record([{ name: 'status', schema: literal('accepted') }]),
  record([{ name: 'status', schema: literal('not_active') }]),
  record([
    { name: 'status', schema: literal('bridge_error') },
    { name: 'error', schema: bridgeError },
  ]),
);
const closeRequest = record([]);
const closeResult = oneOf(
  record([{ name: 'status', schema: literal('closed') }]),
  record([
    { name: 'status', schema: literal('bridge_error') },
    { name: 'error', schema: bridgeError },
  ]),
);
const actionRequestPayload = record([
  { name: 'execute_id', schema: messageId },
  { name: 'request', schema: actionRequest },
]);
const actionOutcomePayload = record([
  { name: 'request', schema: messageId },
  { name: 'outcome', schema: actionOutcome },
]);
const protocolError = record([
  { name: 'code', schema: text() },
  { name: 'scope', schema: oneOf(literal('request'), literal('connection')) },
  { name: 'detail', schema: text(), optional: true },
]);

export interface WorkerActionRequestPayload {
  readonly executeId: bigint;
  readonly request: ActionRequest;
}

export interface WorkerActionOutcomePayload {
  readonly request: bigint;
  readonly outcome: ActionOutcome;
}

export interface WorkerProtocolErrorPayload {
  readonly code: string;
  readonly scope: 'request' | 'connection';
  readonly detail?: string;
}

type WorkerPayloadTypes = {
  'bridge.check.request': CheckRequest;
  'bridge.check.result': CheckResult;
  'bridge.inspect.request': InspectRequest;
  'bridge.inspect.result': InspectResult;
  'bridge.execute.request': ExecuteRequest;
  'bridge.execute.result': ExecutionResult;
  'bridge.cancel.request': CancelRequest;
  'bridge.cancel.result': CancelResult;
  'session.close.request': Readonly<Record<string, never>>;
  'session.close.result': CloseResult;
  'action.request': WorkerActionRequestPayload;
  'action.outcome': WorkerActionOutcomePayload;
  'protocol.error': WorkerProtocolErrorPayload;
};

const payloads: Readonly<Record<keyof WorkerPayloadTypes, WorkerProtocolSchema>> = Object.freeze({
  'bridge.check.request': checkRequest,
  'bridge.check.result': checkResult,
  'bridge.inspect.request': inspectRequest,
  'bridge.inspect.result': inspectResult,
  'bridge.execute.request': executeRequest,
  'bridge.execute.result': executionResult,
  'bridge.cancel.request': cancelRequest,
  'bridge.cancel.result': cancelResult,
  'session.close.request': closeRequest,
  'session.close.result': closeResult,
  'action.request': actionRequestPayload,
  'action.outcome': actionOutcomePayload,
  'protocol.error': protocolError,
});

function domainName(wireName: string): string {
  if (wireName === 'semantic_graph') return wireName;
  return wireName.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function hasLiteralMatch(schemaValue: WorkerProtocolSchema, value: unknown): boolean {
  if (schemaValue.kind === 'literal') return schemaValue.value === value;
  if (schemaValue.kind === 'oneOf') return schemaValue.choices.some((choice) => hasLiteralMatch(choice, value));
  if (schemaValue.kind !== 'record' || value === null || typeof value !== 'object') return true;
  const candidate = value as Readonly<Record<string, unknown>>;
  return schemaValue.fields.every((field) => {
    if (field.schema.kind !== 'literal') return true;
    return candidate[domainName(field.name)] === field.schema.value || candidate[field.name] === field.schema.value;
  });
}

function select(schemaValue: WorkerProtocolSchema, value: unknown): WorkerProtocolSchema {
  if (schemaValue.kind !== 'oneOf') return schemaValue;
  const selected =
    schemaValue.choices.find((choice) => hasLiteralMatch(choice, value)) ??
    (schemaValue.choices[0] as WorkerProtocolSchema);
  return select(selected, value);
}

function toWire(schemaValue: WorkerProtocolSchema, value: unknown): unknown {
  const selected = select(schemaValue, value);
  if (selected.kind === 'uint' || selected.kind === 'int') {
    if (typeof value === 'bigint') return value;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return value;
    return BigInt(value);
  }
  if (selected.kind === 'bytes')
    return value instanceof Uint8Array ? value : Uint8Array.from(value as readonly number[]);
  if (selected.kind === 'array') return (value as readonly unknown[]).map((item) => toWire(selected.item, item));
  if (selected.kind === 'record') {
    const source = value as Readonly<Record<string, unknown>>;
    const target: Record<string, unknown> = {};
    for (const field of selected.fields) {
      const key = domainName(field.name);
      if (Object.hasOwn(source, key)) target[field.name] = toWire(field.schema, source[key]);
      else if (Object.hasOwn(source, field.name)) target[field.name] = toWire(field.schema, source[field.name]);
    }
    return target;
  }
  return value;
}

function fromWire(schemaValue: WorkerProtocolSchema, value: unknown): unknown {
  const selected = select(schemaValue, value);
  if (selected === messageId || selected === epochSeconds || selected === schemaInt) return value;
  if (selected.kind === 'uint') {
    if (typeof value !== 'bigint' || value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TypeError('wire integer exceeds JavaScript safe integer range');
    return Number(value);
  }
  if (selected.kind === 'int') {
    if (typeof value !== 'bigint' || value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TypeError('wire integer exceeds JavaScript safe integer range');
    return Number(value);
  }
  if (selected.kind === 'bytes') return Object.freeze(Array.from(value as Uint8Array));
  if (selected.kind === 'array')
    return Object.freeze((value as readonly unknown[]).map((item) => fromWire(selected.item, item)));
  if (selected.kind === 'record') {
    const source = value as Readonly<Record<string, unknown>>;
    const target: Record<string, unknown> = {};
    for (const field of selected.fields) {
      if (Object.hasOwn(source, field.name))
        target[domainName(field.name)] = fromWire(field.schema, source[field.name]);
    }
    return Object.freeze(target);
  }
  return value;
}

function contract<K extends keyof WorkerPayloadTypes>(kind: K): WorkerProtocolPayload<unknown> {
  return Object.freeze({ kind: kind as WorkerProtocolMessageKind, schema: payloads[kind] });
}

export function encodeWorkerBridgePayload<K extends keyof WorkerPayloadTypes>(
  kind: K,
  value: WorkerPayloadTypes[K],
  limits?: WorkerProtocolCodecLimits,
): WorkerProtocolCodecResult<Uint8Array> {
  return encodeWorkerProtocolPayload(contract(kind), toWire(payloads[kind], value), limits);
}

export function decodeWorkerBridgePayload<K extends keyof WorkerPayloadTypes>(
  kind: K,
  bytesValue: Uint8Array,
  limits?: WorkerProtocolCodecLimits,
): WorkerProtocolCodecResult<WorkerPayloadTypes[K]> {
  const decoded = decodeWorkerProtocolPayload(contract(kind), bytesValue, limits);
  if (!decoded.ok) return decoded;
  try {
    return Object.freeze({ ok: true, value: fromWire(payloads[kind], decoded.value) as WorkerPayloadTypes[K] });
  } catch {
    return Object.freeze({
      ok: false,
      failure: Object.freeze({
        code: 'payload_schema' as const,
        path: Object.freeze([]),
        detail: 'wire integer exceeds JavaScript safe integer range',
      }),
    });
  }
}
