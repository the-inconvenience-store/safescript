import { describe, expect, it } from 'bun:test';

import {
  decodeWorkerProtocolPayload,
  encodeWorkerProtocolPayload,
  isValidWorkerProtocolSessionIncompatible,
  negotiateWorkerProtocolHandshake,
  validateWorkerProtocolWelcome,
  WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD,
  WORKER_PROTOCOL_SESSION_INCOMPATIBLE_PAYLOAD,
  WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD,
  type WorkerProtocolPayload,
} from './index.js';

const version = (major: bigint, minor: bigint) => ({ major, minor });
const semver = (major: bigint, minor: bigint, patch: bigint) => ({ major, minor, patch });

const versions = {
  abi: [version(2n, 0n)],
  language: [version(1n, 0n), version(1n, 1n)],
  ir: [version(1n, 0n)],
  diagnostic_catalog: [semver(1n, 0n, 0n)],
  artifact: [version(1n, 0n)],
  authoring_bundle: [semver(1n, 0n, 0n)],
} as const;

const limits = {
  max_frame_bytes: 16_777_216n,
  max_payload_bytes: 16_700_000n,
  max_decoded_depth: 128n,
  max_decoded_nodes: 1_000_000n,
  max_in_flight: 64n,
  max_pending_replies: 128n,
  max_queued_bytes: 33_554_432n,
  partial_frame_ms: 10_000n,
  worker_start_ms: 30_000n,
  handshake_ms: 5_000n,
  graceful_close_ms: 5_000n,
  max_stderr_bytes: 65_536n,
  restart_attempts: 3n,
  restart_window_ms: 60_000n,
} as const;

const digest = 'a'.repeat(64);

function expectPayloadRoundTrip<T>(contract: WorkerProtocolPayload<T>, value: T): void {
  const encoded = encodeWorkerProtocolPayload(contract, value);
  expect(encoded.ok).toBe(true);
  if (encoded.ok) expect(decodeWorkerProtocolPayload(contract, encoded.value)).toEqual({ ok: true, value });
}

const hello = {
  protocol: { major: 1n, min_minor: 0n, max_minor: 2n },
  sdk: { version: semver(2n, 0n, 0n), build: 'sdk-build-1' },
  expected_worker: { package_version: semver(2n, 0n, 0n), build_digest: digest, override: false },
  required_features: ['feature.required'],
  optional_features: ['feature.optional'],
  versions,
  limits,
} as const;

const worker = {
  protocol: { major: 1n, min_minor: 0n, max_minor: 1n },
  features: ['feature.optional', 'feature.required', 'worker.extra'],
  worker: {
    package_version: semver(2n, 0n, 0n),
    compiler: { version: semver(1n, 1n, 0n), build: 'compiler-build-1' },
    build_digest: digest,
  },
  versions,
  limits: { ...limits, max_in_flight: 32n },
  implementation: 'safescript-js',
} as const;

describe('worker protocol handshake', () => {
  it('selects the highest common minor, feature intersection, and minimum limits', () => {
    const result = negotiateWorkerProtocolHandshake(hello, worker);
    expect(result.compatible).toBe(true);
    if (!result.compatible) return;
    expect(result.welcome.protocol).toEqual({ major: 1n, minor: 1n });
    expect(result.welcome.features).toEqual(['feature.optional', 'feature.required']);
    expect(result.welcome.limits.max_in_flight).toBe(32n);
    expect(result.welcome.worker).toEqual(worker.worker);
    expect(result.welcome.implementation).toBe('safescript-js');
  });

  it('round-trips all three closed handshake payload contracts', () => {
    const negotiated = negotiateWorkerProtocolHandshake(hello, worker);
    expect(negotiated.compatible).toBe(true);
    if (!negotiated.compatible) return;
    expectPayloadRoundTrip(WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD, hello);
    expectPayloadRoundTrip(WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD, negotiated.welcome);
    expectPayloadRoundTrip(WORKER_PROTOCOL_SESSION_INCOMPATIBLE_PAYLOAD, {
      code: 'incompatible_session',
      dimensions: ['protocol_major'],
    });
  });

  it.each([
    [{ ...worker, protocol: { major: 2n, min_minor: 0n, max_minor: 1n } }, ['protocol_major']],
    [{ ...worker, protocol: { major: 1n, min_minor: 3n, max_minor: 4n } }, ['protocol_minor']],
    [{ ...worker, protocol: { major: 1n, min_minor: 2n, max_minor: 1n } }, ['protocol_minor']],
    [{ ...worker, features: ['feature.optional', 'worker.extra'] }, ['required_feature']],
    [{ ...worker, worker: { ...worker.worker, package_version: semver(3n, 0n, 0n) } }, ['bundled_worker_version']],
    [{ ...worker, worker: { ...worker.worker, build_digest: 'invalid' } }, ['worker_build_digest']],
    [{ ...worker, versions: { ...versions, abi: [version(1n, 0n)] } }, ['abi']],
    [{ ...worker, versions: { ...versions, language: [version(2n, 0n)] } }, ['language']],
    [{ ...worker, versions: { ...versions, ir: [version(2n, 0n)] } }, ['ir']],
    [{ ...worker, versions: { ...versions, diagnostic_catalog: [semver(2n, 0n, 0n)] } }, ['diagnostic_catalog']],
    [{ ...worker, versions: { ...versions, artifact: [version(2n, 0n)] } }, ['artifact']],
    [{ ...worker, versions: { ...versions, authoring_bundle: [semver(2n, 0n, 0n)] } }, ['authoring_bundle']],
    [
      { ...worker, worker: { ...worker.worker, compiler: { ...worker.worker.compiler, build: '' } } },
      ['worker_build_digest'],
    ],
    [{ ...worker, limits: { ...limits, max_in_flight: 0n } }, ['operational_limit']],
    [{ ...worker, limits: { ...limits, max_pending_replies: limits.max_in_flight } }, ['operational_limit']],
    [{ ...worker, limits: { ...limits, max_queued_bytes: limits.max_frame_bytes } }, ['operational_limit']],
    [{ ...worker, limits: { ...limits, max_queued_bytes: limits.max_frame_bytes * 2n - 1n } }, ['operational_limit']],
  ] as const)('fails closed before bridge work for an incompatible dimension', (support, expected) => {
    const result = negotiateWorkerProtocolHandshake(hello, support);
    expect(result.compatible).toBe(false);
    if (result.compatible) return;
    expect(result.incompatible).toEqual({ code: 'incompatible_session', dimensions: expected });
  });

  it('requires syntactically valid identities even for an explicitly permitted override', () => {
    const overridden = {
      ...hello,
      expected_worker: { package_version: semver(9n, 0n, 0n), build_digest: 'invalid', override: true },
    } as const;
    const result = negotiateWorkerProtocolHandshake(overridden, worker);
    expect(result.compatible).toBe(false);
    if (!result.compatible) expect(result.incompatible.dimensions).toEqual(['worker_build_digest']);
  });

  it('does not permit one feature to be both required and optional', () => {
    const result = negotiateWorkerProtocolHandshake({ ...hello, optional_features: ['feature.required'] }, worker);
    expect(result.compatible).toBe(false);
    if (!result.compatible) expect(result.incompatible.dimensions).toEqual(['required_feature']);
  });

  it('rejects a syntactically valid welcome that selects unadvertised or excessive values', () => {
    const negotiated = negotiateWorkerProtocolHandshake(hello, worker);
    expect(negotiated.compatible).toBe(true);
    if (!negotiated.compatible) return;
    expect(validateWorkerProtocolWelcome(hello, negotiated.welcome).compatible).toBe(true);

    const extraFeature = validateWorkerProtocolWelcome(hello, {
      ...negotiated.welcome,
      features: [...negotiated.welcome.features, 'worker.extra'],
    });
    expect(extraFeature.compatible).toBe(false);
    if (!extraFeature.compatible) expect(extraFeature.incompatible.dimensions).toEqual(['required_feature']);

    const excessiveLimit = validateWorkerProtocolWelcome(hello, {
      ...negotiated.welcome,
      limits: { ...negotiated.welcome.limits, max_in_flight: 65n },
    });
    expect(excessiveLimit.compatible).toBe(false);
    if (!excessiveLimit.compatible) expect(excessiveLimit.incompatible.dimensions).toEqual(['operational_limit']);
  });

  it('requires incompatibility dimensions to be non-empty, sorted, and unique', () => {
    expect(
      isValidWorkerProtocolSessionIncompatible({
        code: 'incompatible_session',
        dimensions: ['abi', 'protocol_major'],
      }),
    ).toBe(true);
    for (const dimensions of [[], ['abi', 'abi'], ['protocol_major', 'abi']] as const)
      expect(isValidWorkerProtocolSessionIncompatible({ code: 'incompatible_session', dimensions })).toBe(false);
  });
});
