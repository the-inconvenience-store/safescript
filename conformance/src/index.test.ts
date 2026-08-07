import { describe, expect, it } from 'bun:test';

import { withRuntimeBridge } from './index.js';

describe('conformance boundary', () => {
  it('exercises an injected runtime bridge', () => {
    expect(
      withRuntimeBridge(
        () => ({ protocolVersion: '1' }),
        (bridge) => bridge.protocolVersion,
      ),
    ).toBe('1');
  });
});
