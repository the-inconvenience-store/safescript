import type { RuntimeBridge, RuntimeBridgeFactory } from '@safescript/contracts';

export function withRuntimeBridge<T>(createBridge: RuntimeBridgeFactory, run: (bridge: RuntimeBridge) => T): T {
  return run(createBridge());
}
