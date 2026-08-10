/**
 * Direct in-process adapter for the reference SafeScript compiler and interpreter.
 * @packageDocumentation
 */
import type { RuntimeBridge, RuntimeBridgeFactory } from '@safescript/contracts';

import { DirectRuntimeBridge, type DirectRuntimeBridgeOptions } from './bridge.js';

export { STANDARD_COMPILATION_CACHE_LIMITS } from './compilation-cache.js';
export type { CompilationCacheLimits } from './compilation-cache.js';
export type { DirectRuntimeBridgeOptions } from './bridge.js';

/** Creates an independently closable in-process adapter over the reference compiler and interpreter. */
export function createDirectRuntimeBridge(options?: DirectRuntimeBridgeOptions): RuntimeBridge {
  return new DirectRuntimeBridge(options);
}

/** Dependency-injection shape used by hosts that choose a runtime bridge factory. */
export interface EngineOptions {
  readonly bridgeFactory: RuntimeBridgeFactory;
}
