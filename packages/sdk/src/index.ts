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
export { DEFAULT_PROCESS_WORKER_HELLO, ProcessRuntimeBridge } from './process-bridge.js';
export type { ProcessRuntimeBridgeOptions, ProcessWorkerTransport } from './process-bridge.js';
export { SdkConfigurationError } from './types.js';
export type {
  AbortSignal,
  ActionContext,
  AuthorisationDecision,
  CheckRequest,
  CreateSafeScriptOptions,
  ExecuteRequest,
  ExecutionResult,
  HandlerFailure,
  InspectRequest,
  OperationHandler,
  Program,
  SafeScript,
  SafeScriptOptions,
  ScriptedAction,
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
  PolicyError,
  Result,
  RuntimeBridge,
  Schema,
  SemVer,
  TraceMode,
} from '@safescript/contracts';
