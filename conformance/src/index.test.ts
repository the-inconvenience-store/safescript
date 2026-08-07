import { describe, expect, it } from 'bun:test';

import { withRuntimeBridge } from './index.js';

describe('conformance boundary', () => {
  it('exercises an injected runtime bridge', () => {
    const bridge = {
      check: async () => ({
        status: 'bridge_error' as const,
        error: { code: 'unavailable' as const, phase: 'check' as const },
      }),
      inspect: async () => ({
        status: 'bridge_error' as const,
        error: { code: 'unavailable' as const, phase: 'inspect' as const },
      }),
      execute: async () => ({
        status: 'bridge_error' as const,
        error: { code: 'unavailable' as const, phase: 'execute' as const },
      }),
      cancel: async () => ({ status: 'not_active' as const }),
      close: async () => ({ status: 'closed' as const }),
    };
    expect(
      withRuntimeBridge(
        () => bridge,
        (runtime) => runtime,
      ),
    ).toBe(bridge);
  });
});
