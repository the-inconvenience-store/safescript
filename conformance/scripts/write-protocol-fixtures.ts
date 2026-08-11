import { readFile, writeFile } from 'node:fs/promises';

import {
  STANDARD_COMPILE_LIMITS,
  STANDARD_EXECUTION_LIMITS,
  STANDARD_SEMANTIC_EDIT_LIMITS,
  SEMANTIC_EDIT_SCHEMA,
  SEMANTIC_GRAPH_SCHEMA,
  encodeWorkerProtocolEnvelope,
  encodeWorkerProtocolFrame,
  encodeWorkerProtocolPayload,
  hash,
  ids,
  negotiateWorkerProtocolHandshake,
  WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD,
  WORKER_PROTOCOL_SESSION_INCOMPATIBLE_PAYLOAD,
  WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD,
  type WorkerProtocolEnvelope,
  type WorkerProtocolMessageKind,
} from '@safescript/contracts';
import { DEFAULT_PROCESS_WORKER_HELLO } from '@safescript/sdk';
import {
  DEFAULT_WORKER_HANDSHAKE_SUPPORT,
  encodeWorkerBridgePayload,
  type WorkerProtocolErrorPayload,
} from '@safescript/worker';

const fixtureUrl = new URL('../worker-protocol/fixtures.json', import.meta.url);
const existing = JSON.parse(await readFile(fixtureUrl, 'utf8')) as Readonly<{ hostile: readonly unknown[] }>;
const digest = '0'.repeat(64);
const invocationId = ids.invocation(`invocation:${'1'.repeat(32)}`);
const requestId = ids.request(invocationId, 0);
const compileUsage = { sourceBytes: 0, syntaxNodes: 0 };
const registry = {
  id: ids.contract('contract:fixture'),
  digest,
  schemas: { types: [] },
  operations: [],
  slots: [],
  definitions: [],
};
const checkRequest = {
  registry,
  slotId: ids.slot('slot:fixture'),
  source: {
    module: ids.module('module:fixture'),
    source: [],
  },
  limits: STANDARD_COMPILE_LIMITS,
};
const editRequest = {
  ...checkRequest,
  editSchema: SEMANTIC_EDIT_SCHEMA,
  graphSchema: SEMANTIC_GRAPH_SCHEMA,
  baseRevision: `semantic-revision:${digest}`,
  edits: [
    {
      kind: 'rename_symbol',
      editId: 'edit:fixture-rename',
      target: `semantic-node:${digest}`,
      newName: 'renamed',
      preconditions: [{ kind: 'old_name', value: 'original' }],
    },
  ],
  editLimits: STANDARD_SEMANTIC_EDIT_LIMITS,
  views: [],
};
const editUsage = {
  operations: 0,
  fragmentBytes: 0,
  transformedRegions: 0,
  work: 0,
  provenanceEntries: 0,
  diffBytes: 0,
  sourceBytes: 0,
};
const actionRequest = {
  contractId: registry.id,
  irDigest: hash('ir', Uint8Array.of(1)),
  invocationId,
  requestId,
  slotId: checkRequest.slotId,
  operationId: ids.operation('operation:fixture'),
  actionSiteId: ids.actionSite(`action-site:${digest}`),
  source: { module: ids.module('module:fixture'), start: 0, end: 0 },
  input: [],
};
const actionOutcome = {
  requestId,
  result: { tag: 'completed' as const, value: [] },
};
const negotiated = negotiateWorkerProtocolHandshake(DEFAULT_PROCESS_WORKER_HELLO, DEFAULT_WORKER_HANDSHAKE_SUPPORT);
if (!negotiated.compatible) throw new Error('default handshake fixture must negotiate');

type FixtureInput = Readonly<{
  kind: WorkerProtocolMessageKind;
  replyTo: bigint | null;
  payload: Uint8Array;
}>;

function bridgePayload<K extends Parameters<typeof encodeWorkerBridgePayload>[0]>(kind: K, value: unknown): Uint8Array {
  const encoded = encodeWorkerBridgePayload(kind, value as never);
  if (!encoded.ok) throw new Error(`${kind}: ${encoded.failure.code}`);
  return encoded.value;
}

function handshakePayload<T>(contract: Parameters<typeof encodeWorkerProtocolPayload<T>>[0], value: T): Uint8Array {
  const encoded = encodeWorkerProtocolPayload(contract, value);
  if (!encoded.ok) throw new Error(`${contract.kind}: ${encoded.failure.code}`);
  return encoded.value;
}

const fixtures: readonly FixtureInput[] = [
  {
    kind: 'session.hello',
    replyTo: null,
    payload: handshakePayload(WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD, DEFAULT_PROCESS_WORKER_HELLO),
  },
  {
    kind: 'session.welcome',
    replyTo: 1n,
    payload: handshakePayload(WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD, negotiated.welcome),
  },
  {
    kind: 'session.incompatible',
    replyTo: 1n,
    payload: handshakePayload(WORKER_PROTOCOL_SESSION_INCOMPATIBLE_PAYLOAD, {
      code: 'incompatible_session',
      dimensions: ['version'],
    }),
  },
  { kind: 'bridge.check.request', replyTo: null, payload: bridgePayload('bridge.check.request', checkRequest) },
  {
    kind: 'bridge.check.result',
    replyTo: 1n,
    payload: bridgePayload('bridge.check.result', { status: 'rejected', diagnostics: [], usage: compileUsage }),
  },
  {
    kind: 'bridge.inspect.request',
    replyTo: null,
    payload: bridgePayload('bridge.inspect.request', { ...checkRequest, views: [] }),
  },
  {
    kind: 'bridge.inspect.result',
    replyTo: 1n,
    payload: bridgePayload('bridge.inspect.result', { status: 'rejected', diagnostics: [], usage: compileUsage }),
  },
  {
    kind: 'bridge.apply_semantic_edits.request',
    replyTo: null,
    payload: bridgePayload('bridge.apply_semantic_edits.request', editRequest),
  },
  {
    kind: 'bridge.apply_semantic_edits.result',
    replyTo: 1n,
    payload: bridgePayload('bridge.apply_semantic_edits.result', {
      status: 'rejected',
      reason: 'stale_revision',
      diagnostics: [],
      editDiagnostics: [],
      editIds: ['edit:fixture-rename'],
      targets: [`semantic-node:${digest}`],
      usage: editUsage,
    }),
  },
  {
    kind: 'bridge.execute.request',
    replyTo: null,
    payload: bridgePayload('bridge.execute.request', {
      registry,
      slotId: checkRequest.slotId,
      invocationId,
      program: { kind: 'source', source: checkRequest },
      input: [],
      limits: STANDARD_EXECUTION_LIMITS,
      trace: false,
    }),
  },
  {
    kind: 'bridge.execute.result',
    replyTo: 1n,
    payload: bridgePayload('bridge.execute.result', { status: 'not_started' }),
  },
  {
    kind: 'bridge.cancel.request',
    replyTo: null,
    payload: bridgePayload('bridge.cancel.request', {
      invocationId,
    }),
  },
  {
    kind: 'bridge.cancel.result',
    replyTo: 1n,
    payload: bridgePayload('bridge.cancel.result', { status: 'not_active' }),
  },
  { kind: 'session.close.request', replyTo: null, payload: bridgePayload('session.close.request', {}) },
  {
    kind: 'session.close.result',
    replyTo: 1n,
    payload: bridgePayload('session.close.result', { status: 'closed' }),
  },
  {
    kind: 'action.request',
    replyTo: null,
    payload: bridgePayload('action.request', { executeId: 1n, request: actionRequest }),
  },
  {
    kind: 'action.outcome',
    replyTo: 1n,
    payload: bridgePayload('action.outcome', { request: 1n, outcome: actionOutcome }),
  },
  {
    kind: 'protocol.error',
    replyTo: 1n,
    payload: bridgePayload('protocol.error', {
      code: 'unexpected_message',
      scope: 'request',
    } satisfies WorkerProtocolErrorPayload),
  },
];

const hex = (value: Uint8Array): string => [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const valid = fixtures.map((fixture) => {
  const envelope: WorkerProtocolEnvelope = {
    version: 1,
    kind: fixture.kind,
    id: fixture.replyTo === null ? 1n : 2n,
    replyTo: fixture.replyTo,
    payload: fixture.payload,
  };
  const encodedEnvelope = encodeWorkerProtocolEnvelope(envelope);
  if (!encodedEnvelope.ok) throw new Error(`${fixture.kind}: ${encodedEnvelope.failure.code}`);
  const frame = encodeWorkerProtocolFrame(encodedEnvelope.value);
  if (!frame.ok) throw new Error(`${fixture.kind}: ${frame.failure.code}`);
  return {
    name: fixture.kind.replaceAll('.', ' '),
    kind: fixture.kind,
    frameHex: hex(frame.value),
    envelopeHex: hex(encodedEnvelope.value),
    payloadHex: hex(fixture.payload),
  };
});

await writeFile(
  fixtureUrl,
  `${JSON.stringify({ format: 1, releaseVersion: '0.7.0', valid, hostile: existing.hostile }, null, 2)}\n`,
  'utf8',
);
