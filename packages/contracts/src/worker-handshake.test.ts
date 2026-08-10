import { describe, expect, it } from 'bun:test';

import {
  SAFESCRIPT_VERSION,
  STANDARD_WORKER_OPERATIONAL_LIMITS,
  isValidWorkerProtocolSessionIncompatible,
  negotiateWorkerProtocolHandshake,
  validateWorkerProtocolWelcome,
  type WorkerProtocolHandshakeSupport,
  type WorkerProtocolSessionHello,
} from './index.js';

const digest = '1'.repeat(64);

const hello: WorkerProtocolSessionHello = Object.freeze({
  version: SAFESCRIPT_VERSION,
  sdk_build: 'sdk-build',
  expected_worker: Object.freeze({ version: SAFESCRIPT_VERSION, build_digest: digest, override: false }),
  limits: STANDARD_WORKER_OPERATIONAL_LIMITS,
});

const support: WorkerProtocolHandshakeSupport = Object.freeze({
  version: SAFESCRIPT_VERSION,
  worker: Object.freeze({ version: SAFESCRIPT_VERSION, compiler_build: 'compiler-build', build_digest: digest }),
  limits: STANDARD_WORKER_OPERATIONAL_LIMITS,
  implementation: 'test-worker',
});

describe('single-contract worker handshake', () => {
  it('accepts one exact SafeScript contract and selects bounded limits', () => {
    const result = negotiateWorkerProtocolHandshake(hello, support);
    expect(result.compatible).toBe(true);
    if (!result.compatible) return;
    expect(result.welcome.version).toBe('0.7.0');
    expect(result.welcome.limits).toEqual(STANDARD_WORKER_OPERATIONAL_LIMITS);
    expect(validateWorkerProtocolWelcome(hello, result.welcome).compatible).toBe(true);
  });

  it('rejects every release mismatch as one version incompatibility', () => {
    const result = negotiateWorkerProtocolHandshake({ ...hello, version: '0.5.0' }, support);
    expect(result).toEqual({
      compatible: false,
      incompatible: { code: 'incompatible_session', dimensions: ['version'] },
    });
  });

  it('requires exact bundled-worker identity', () => {
    const result = negotiateWorkerProtocolHandshake(
      { ...hello, expected_worker: { ...hello.expected_worker, build_digest: '2'.repeat(64) } },
      support,
    );
    expect(result.compatible).toBe(false);
    if (!result.compatible) expect(result.incompatible.dimensions).toContain('worker_build_digest');
  });

  it('fails closed on invalid limits', () => {
    const limits = negotiateWorkerProtocolHandshake(
      { ...hello, limits: { ...hello.limits, max_frame_bytes: 0n } },
      support,
    );
    expect(limits.compatible).toBe(false);
  });

  it('validates closed sorted incompatibility facts', () => {
    expect(isValidWorkerProtocolSessionIncompatible({ code: 'incompatible_session', dimensions: ['version'] })).toBe(
      true,
    );
    expect(
      isValidWorkerProtocolSessionIncompatible({
        code: 'incompatible_session',
        dimensions: ['version', 'version'],
      }),
    ).toBe(false);
  });
});
