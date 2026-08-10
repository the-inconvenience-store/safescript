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
export { measureReferenceResourceLedgers, REFERENCE_EXECUTION_LIMITS } from './resources.js';
export type { ReferenceResourceLedger } from './resources.js';
export { evaluateAuthoringGate, AUTHORING_THRESHOLDS } from './authoring.js';
export type {
  AgentAuthoringEvidence,
  AuthoringFailureOwner,
  AuthoringGateResult,
  AuthoringGateThresholds,
  AuthoringScenario,
} from './authoring.js';

/**
 * Runs a conformance case against a bridge created through the public adapter seam.
 *
 * @remarks Tests must not import compiler, interpreter, gateway, or transport implementation details.
 */
export function withRuntimeBridge<T>(createBridge: RuntimeBridgeFactory, run: (bridge: RuntimeBridge) => T): T {
  return run(createBridge());
}
