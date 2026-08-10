/** Bounded interpreter entry point and host hooks for verified structured SafeScript IR. */
import type { CanonicalValue, ExecutionErrorCode, Schema, SourceLocation } from '@safescript/contracts';

import type { StructuredAction, VerifiedStructuredProgram } from './structured-ir.js';
import { interpretStructured } from './structured-interpreter.js';
import { SEMANTIC_STEP_FUEL } from './resource-schedule.js';

/** Host hooks that keep limits, actions, cancellation, and traces outside pure IR evaluation. */
export interface InterpreterHooks {
  readonly charge: (fuel: number, allocation?: Readonly<{ value: CanonicalValue; type: Schema }>) => void;
  readonly allocate: (value: CanonicalValue) => void;
  readonly scan: (values: readonly CanonicalValue[]) => void;
  readonly action: (instruction: StructuredAction, input: CanonicalValue) => Promise<CanonicalValue>;
  readonly cancelled: () => boolean;
  readonly trace: (event: string, source: SourceLocation) => void;
  readonly random: () => number;
  readonly fixedInstant: () => CanonicalValue | undefined;
  readonly enterCall: () => () => void;
  readonly collection: (items: number) => void;
}

/** Structured private fault converted to a public execution result by the runtime bridge. */
export class InterpreterFault extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    readonly detail?: string,
  ) {
    super(detail ?? code);
  }
}

/** Executes verifier-approved structured IR with no ambient host authority. */
export function interpret(
  program: VerifiedStructuredProgram,
  input: CanonicalValue,
  hooks: InterpreterHooks,
): Promise<CanonicalValue> {
  // Program entry remains one stable semantic operation even though it no longer needs a wrapper terminator.
  hooks.charge(SEMANTIC_STEP_FUEL);
  hooks.trace('structured', program.program.source);
  return interpretStructured(program.program, input, hooks);
}
