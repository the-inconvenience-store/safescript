/**
 * Runtime-bridge conformance helpers shared by direct and future process adapters.
 * @packageDocumentation
 */
import type { RuntimeBridge, RuntimeBridgeFactory } from '@safescript/contracts';

export {
  applicationExtensionReference,
  codeModeReference,
  deviceRuleReference,
  walkingSkeletonReference,
} from './references.js';
export type { ReferenceIntegration } from './references.js';

/**
 * Runs a conformance case against a bridge created through the public adapter seam.
 *
 * @remarks Tests must not import compiler, interpreter, gateway, or transport implementation details.
 */
export function withRuntimeBridge<T>(createBridge: RuntimeBridgeFactory, run: (bridge: RuntimeBridge) => T): T {
  return run(createBridge());
}
