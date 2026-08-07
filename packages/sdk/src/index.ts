/**
 * Host-facing TypeScript integration interface for contracts, source checking, execution, and deterministic tests.
 *
 * @packageDocumentation
 */
export { ContractDefinitionError, defineContract } from './contract.js';
export type { Codec, Contract, ContractDefinition, ContractType, Operation, Slot } from './contract.js';
export { createSafeScript } from './facade.js';
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
