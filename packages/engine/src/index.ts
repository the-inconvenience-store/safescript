/**
 * Direct in-process adapter for the reference SafeScript compiler and interpreter.
 * @packageDocumentation
 */
import type { RuntimeBridge, RuntimeBridgeFactory } from '@safescript/contracts';

import { DirectRuntimeBridge } from './bridge.js';

/** Creates an independently closable in-process adapter over the reference compiler and interpreter. */
export function createDirectRuntimeBridge(): RuntimeBridge {
  return new DirectRuntimeBridge();
}

/** Dependency-injection shape used by hosts that choose a runtime bridge factory. */
export interface EngineOptions {
  readonly bridgeFactory: RuntimeBridgeFactory;
}
