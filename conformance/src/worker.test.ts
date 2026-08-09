import { describe, expect, it } from 'bun:test';

import {
  decodeWorkerProtocolEnvelope,
  decodeWorkerProtocolFrame,
  encodeCanonical,
  encodeWorkerProtocolEnvelope,
  encodeWorkerProtocolFrame,
  encodeWorkerProtocolPayload,
  ids,
  resultSchema,
  STANDARD_EXECUTION_LIMITS,
  STANDARD_WORKER_OPERATIONAL_LIMITS,
  WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD,
  type ActionOutcome,
  type ActionRequest,
  type CheckRequest,
  type CheckResult,
  type ExecuteRequest,
  type ExecutionResult,
  type RuntimeBridgeHost,
  type Schema,
  type WorkerProtocolEnvelope,
  type WorkerProtocolMessageKind,
  type WorkerProtocolSessionHello,
} from '@safescript/contracts';
import { createDirectRuntimeBridge } from '@safescript/engine';
import { decodeWorkerBridgePayload, encodeWorkerBridgePayload, RuntimeWorkerServer } from '@safescript/worker';

import {
  applicationExtensionReference,
  codeModeReference,
  deviceRuleReference,
  referenceCheckRequest,
  referenceInput,
  referenceRegistry,
  referenceTypes,
  walkingSkeletonReference,
  type ReferenceIntegration,
} from './references.js';

const digest = '0'.repeat(64);
const hello: WorkerProtocolSessionHello = Object.freeze({
  protocol: Object.freeze({ major: 1n, min_minor: 0n, max_minor: 0n }),
  sdk: Object.freeze({ version: Object.freeze({ major: 1n, minor: 0n, patch: 0n }), build: 'conformance' }),
  expected_worker: Object.freeze({
    package_version: Object.freeze({ major: 1n, minor: 0n, patch: 0n }),
    build_digest: digest,
    override: false,
  }),
  required_features: Object.freeze([]),
  optional_features: Object.freeze([]),
  versions: Object.freeze({
    abi: Object.freeze([Object.freeze({ major: 2n, minor: 0n })]),
    language: Object.freeze([Object.freeze({ major: 1n, minor: 0n }), Object.freeze({ major: 1n, minor: 1n })]),
    ir: Object.freeze([Object.freeze({ major: 1n, minor: 0n }), Object.freeze({ major: 1n, minor: 1n })]),
    diagnostic_catalog: Object.freeze([Object.freeze({ major: 1n, minor: 3n, patch: 0n })]),
    artifact: Object.freeze([Object.freeze({ major: 1n, minor: 0n })]),
    authoring_bundle: Object.freeze([Object.freeze({ major: 1n, minor: 0n, patch: 0n })]),
  }),
  limits: STANDARD_WORKER_OPERATIONAL_LIMITS,
});

function encode(schema: Schema, value: unknown): readonly number[] {
  const encoded = encodeCanonical(schema, value, { registry: referenceRegistry.schemas });
  if (!encoded.ok) throw new Error(`${encoded.failure.code}:${encoded.failure.path.join('.')}`);
  return Object.freeze(Array.from(encoded.value));
}

function executionRequest(reference: ReferenceIntegration, digit: string): ExecuteRequest {
  return {
    abiVersion: { major: 2, minor: 0 },
    registry: referenceRegistry,
    slotId: referenceTypes.slotId,
    invocationId: ids.invocation(`invocation:${digit.repeat(32)}`),
    program: { kind: 'source', source: referenceCheckRequest(reference) },
    input: encode({ kind: 'ref', type: referenceTypes.event }, referenceInput),
    limits: STANDARD_EXECUTION_LIMITS,
    idempotencySeed: [1, 2, 3],
    fixedInstant: { epochSeconds: 1_786_060_800n, nanoseconds: 0 },
    randomSeed: [1, 2, 3, 4],
    trace: 'semantic',
  };
}

function completedAction(request: ActionRequest): ActionOutcome {
  const id =
    request.operationId === ids.operation('operation:http.fetch')
      ? '{"ids":["sam","alex"],"next":"page-2"}'
      : String(request.operationId);
  return {
    abiVersion: { major: 2, minor: 0 },
    requestId: request.requestId,
    result: {
      tag: 'completed',
      value: encode(
        resultSchema(
          { kind: 'ref', type: referenceTypes.actionOutput },
          { kind: 'ref', type: referenceTypes.actionError },
        ),
        {
          tag: 'ok',
          value: { id },
        },
      ),
    },
  };
}

function frame(kind: WorkerProtocolMessageKind, id: bigint, payload: Uint8Array, replyTo: bigint | null = null) {
  const envelope = encodeWorkerProtocolEnvelope({ version: 1, kind, id, replyTo, payload });
  if (!envelope.ok) throw new Error(envelope.failure.code);
  const framed = encodeWorkerProtocolFrame(envelope.value);
  if (!framed.ok) throw new Error(framed.failure.code);
  return framed.value;
}

function envelope(frameValue: Uint8Array): WorkerProtocolEnvelope {
  const decodedFrame = decodeWorkerProtocolFrame(frameValue);
  if (!decodedFrame.ok) throw new Error(decodedFrame.failure.code);
  const decoded = decodeWorkerProtocolEnvelope(decodedFrame.value);
  if (!decoded.ok) throw new Error(decoded.failure.code);
  return decoded.value;
}

class InMemoryWorkerPeer {
  readonly #outbound: Uint8Array[] = [];
  readonly #server = new RuntimeWorkerServer({
    write: (value) => {
      this.#outbound.push(value);
    },
  });
  #nextId = 1n;

  async start(): Promise<void> {
    const payload = encodeWorkerProtocolPayload(WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD, hello);
    if (!payload.ok)
      throw new Error(`${payload.failure.code}:${payload.failure.path.join('.')}:${payload.failure.detail ?? ''}`);
    const id = this.#allocate();
    await this.#server.receive(frame('session.hello', id, payload.value));
    const response = await this.#next();
    expect(response).toMatchObject({ kind: 'session.welcome', replyTo: id });
  }

  async check(request: CheckRequest): Promise<CheckResult> {
    const payload = encodeWorkerBridgePayload('bridge.check.request', request);
    if (!payload.ok)
      throw new Error(`${payload.failure.code}:${payload.failure.path.join('.')}:${payload.failure.detail ?? ''}`);
    const response = await this.#exchange('bridge.check.request', 'bridge.check.result', payload.value);
    const result = decodeWorkerBridgePayload('bridge.check.result', response.payload);
    if (!result.ok) throw new Error(result.failure.code);
    return result.value;
  }

  async execute(request: ExecuteRequest, host: RuntimeBridgeHost): Promise<ExecutionResult> {
    const payload = encodeWorkerBridgePayload('bridge.execute.request', request);
    if (!payload.ok) throw new Error(payload.failure.code);
    const requestId = this.#allocate();
    await this.#server.receive(frame('bridge.execute.request', requestId, payload.value));
    while (true) {
      const response = await this.#next();
      if (response.kind === 'action.request') {
        const action = decodeWorkerBridgePayload('action.request', response.payload);
        if (!action.ok || action.value.executeId !== requestId) throw new Error('invalid worker action request');
        const outcome = await host.handleAction(action.value.request);
        const encoded = encodeWorkerBridgePayload('action.outcome', { request: response.id, outcome });
        if (!encoded.ok) throw new Error(encoded.failure.code);
        await this.#server.receive(frame('action.outcome', this.#allocate(), encoded.value, response.id));
        continue;
      }
      if (response.kind !== 'bridge.execute.result' || response.replyTo !== requestId)
        throw new Error('unexpected worker response');
      const result = decodeWorkerBridgePayload('bridge.execute.result', response.payload);
      if (!result.ok) throw new Error(result.failure.code);
      return result.value;
    }
  }

  async close(): Promise<void> {
    const payload = encodeWorkerBridgePayload('session.close.request', {});
    if (!payload.ok) throw new Error(payload.failure.code);
    await this.#exchange('session.close.request', 'session.close.result', payload.value);
    await this.#server.drain();
  }

  async #exchange(
    requestKind: WorkerProtocolMessageKind,
    resultKind: WorkerProtocolMessageKind,
    payload: Uint8Array,
  ): Promise<WorkerProtocolEnvelope> {
    const requestId = this.#allocate();
    await this.#server.receive(frame(requestKind, requestId, payload));
    const response = await this.#next();
    if (response.kind !== resultKind || response.replyTo !== requestId) throw new Error('unexpected worker response');
    return response;
  }

  async #next(): Promise<WorkerProtocolEnvelope> {
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const next = this.#outbound.shift();
      if (next) return envelope(next);
      await Bun.sleep(1);
    }
    throw new Error('worker response timeout');
  }

  #allocate(): bigint {
    return this.#nextId++;
  }
}

describe('standalone worker semantic conformance', () => {
  it.each([walkingSkeletonReference, applicationExtensionReference, codeModeReference, deviceRuleReference])(
    'agrees with the direct bridge for the $name reference program',
    async (reference) => {
      const direct = createDirectRuntimeBridge();
      const worker = new InMemoryWorkerPeer();
      await worker.start();
      const checkRequest = referenceCheckRequest(reference);
      const directCheck = await direct.check(checkRequest);
      const workerCheck = await worker.check(checkRequest);
      expect(workerCheck).toEqual(directCheck);

      const request = executionRequest(reference, '1');
      const host = { handleAction: async (action: ActionRequest) => completedAction(action) };
      const directResult = await direct.execute(request, host);
      const workerResult = await worker.execute(request, host);
      expect(workerResult).toEqual(directResult);

      await Promise.all([direct.close(), worker.close()]);
    },
  );
});
