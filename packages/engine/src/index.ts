import type { RuntimeBridge, RuntimeBridgeFactory } from '@safescript/contracts';

import { DirectRuntimeBridge } from './bridge.js';

export function createDirectRuntimeBridge(): RuntimeBridge {
  return new DirectRuntimeBridge();
}

export interface EngineOptions {
  readonly bridgeFactory: RuntimeBridgeFactory;
}
