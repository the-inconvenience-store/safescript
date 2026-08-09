/**
 * Host-facing TypeScript integration interface for contracts, source checking, execution, and deterministic tests.
 *
 * @packageDocumentation
 */
export { ContractDefinitionError, defineContract } from './contract.js';
export { AUTHORING_BUNDLE_VERSION, createAuthoringBundle, createRegistryAuthoringBundle } from './authoring.js';
export type { AuthoringBundle, AuthoringFile } from './authoring.js';
export type { Codec, Contract, ContractDefinition, ContractType, Operation, Slot } from './contract.js';
export { createSafeScript } from './facade.js';
export {
  DEFAULT_PROCESS_WORKER_HELLO,
  ProcessRuntimeBridge,
  SupervisedProcessRuntimeBridge,
} from './process-bridge.js';
export { createNodeProcessRuntimeBridge } from './node-process-bridge.js';
export type { NodeProcessRuntimeBridgeOptions, NodeWorkerOverride } from './node-process-bridge.js';
export type {
  ProcessRuntimeBridgeOptions,
  ProcessWorkerTransport,
  SupervisedProcessRuntimeBridgeOptions,
} from './process-bridge.js';
export { SdkConfigurationError } from './types.js';
export type {
  AbortSignal,
  ActionContext,
  ActionHookContext,
  BeforeActionDecision,
  BeforeExecuteDecision,
  CheckRequest,
  CreateSafeScriptOptions,
  ExecuteRequest,
  ExecutionResult,
  ExecutionHookContext,
  HandlerFailure,
  InspectRequest,
  OperationHandler,
  Program,
  SafeScript,
  SafeScriptHooks,
  SafeScriptOptions,
  ScriptedAction,
  ScriptedExecutionRejection,
  SdkExecutionFacts,
  SourceProgram,
  TestExpectation,
  TestMismatch,
  TestReport,
  TestRequest,
} from './types.js';
export type {
  CompileLimits,
  ExecutionLimits,
  InstantValue,
  InvocationId,
  ModuleId,
  Result,
  RuntimeBridge,
  Schema,
  SemVer,
  TraceMode,
} from '@safescript/contracts';
