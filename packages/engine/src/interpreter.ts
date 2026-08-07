/**
 * Bounded interpreter for verified SafeScript IR.
 * @packageDocumentation
 */
import type { CanonicalValue, ExecutionErrorCode, Schema } from '@safescript/contracts';

import {
  constantValue,
  type ActionInstruction,
  type IrInstruction,
  type IrTerminator,
  type VerifiedProgram,
} from './ir.js';
import { interpretStructured } from './structured-interpreter.js';

/**
 * Host hooks that keep limits, actions, cancellation, and traces outside pure IR evaluation.
 * @internal
 */
export interface InterpreterHooks {
  readonly charge: (fuel: number, allocation?: Readonly<{ value: CanonicalValue; type: Schema }>) => void;
  readonly allocate: (value: CanonicalValue) => void;
  readonly scan: (values: readonly CanonicalValue[]) => void;
  readonly action: (instruction: ActionInstruction, input: CanonicalValue) => Promise<CanonicalValue>;
  readonly actionGroup: (
    actions: readonly Readonly<{ instruction: ActionInstruction; input: CanonicalValue }>[],
  ) => Promise<readonly CanonicalValue[]>;
  readonly cancelled: () => boolean;
  readonly trace: (event: string, source: IrTerminator['source']) => void;
  readonly random: () => number;
  readonly fixedInstant: () => CanonicalValue | undefined;
  readonly enterCall: () => () => void;
  readonly collection: (items: number) => void;
}

/**
 * Structured private fault converted to a public execution result by the runtime bridge.
 * @internal
 */
export class InterpreterFault extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    readonly detail?: string,
  ) {
    super(detail ?? code);
  }
}

function record(value: CanonicalValue): Readonly<Record<string, CanonicalValue>> {
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new InterpreterFault('invalid_ir', 'record value required');
  return value as Readonly<Record<string, CanonicalValue>>;
}

function stable(value: CanonicalValue): string {
  if (typeof value === 'bigint') return `{"$bigint":${JSON.stringify(String(value))}}`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function compare(
  operator: Extract<IrInstruction, { tag: 'compare' }>['operator'],
  left: CanonicalValue,
  right: CanonicalValue,
): boolean {
  if (operator === 'equal') return stable(left) === stable(right);
  if (operator === 'not-equal') return stable(left) !== stable(right);
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    if (operator === 'less') return left < right;
    if (operator === 'less-equal') return left <= right;
    if (operator === 'greater') return left > right;
    return left >= right;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    if (operator === 'less') return left < right;
    if (operator === 'less-equal') return left <= right;
    if (operator === 'greater') return left > right;
    return left >= right;
  }
  throw new InterpreterFault('invalid_ir', 'ordered comparison requires matching numbers');
}

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function binary(
  operator: Extract<IrInstruction, { tag: 'binary' }>['operator'],
  left: CanonicalValue,
  right: CanonicalValue,
): CanonicalValue {
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    if ((operator === 'divide' || operator === 'remainder') && right === 0n)
      throw new InterpreterFault('invalid_arithmetic', 'division by zero');
    const shift = Number(right);
    if (
      (operator === 'shift-left' || operator === 'shift-right') &&
      (!Number.isSafeInteger(shift) || shift < 0 || shift > 63)
    )
      throw new InterpreterFault('invalid_arithmetic', 'shift count is outside 0..63');
    const result =
      operator === 'add'
        ? left + right
        : operator === 'subtract'
          ? left - right
          : operator === 'multiply'
            ? left * right
            : operator === 'divide'
              ? left / right
              : operator === 'remainder'
                ? left % right
                : operator === 'bit-and'
                  ? left & right
                  : operator === 'bit-or'
                    ? left | right
                    : operator === 'bit-xor'
                      ? left ^ right
                      : operator === 'shift-left'
                        ? left << BigInt(shift)
                        : left >> BigInt(shift);
    if (result < INT64_MIN || result > INT64_MAX) throw new InterpreterFault('integer_overflow');
    return result;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    if ((operator === 'divide' || operator === 'remainder') && right === 0)
      throw new InterpreterFault('invalid_arithmetic', 'division by zero');
    if (operator.startsWith('bit-') || operator.startsWith('shift-'))
      throw new InterpreterFault('invalid_ir', 'bitwise float operation');
    const result =
      operator === 'add'
        ? left + right
        : operator === 'subtract'
          ? left - right
          : operator === 'multiply'
            ? left * right
            : operator === 'divide'
              ? left / right
              : left % right;
    if (!Number.isFinite(result)) throw new InterpreterFault('non_finite_number');
    return result;
  }
  throw new InterpreterFault('invalid_ir', 'numeric operands required');
}

function evaluate(instruction: IrInstruction, registers: Map<string, CanonicalValue>): CanonicalValue {
  const get = (register: string): CanonicalValue => {
    if (!registers.has(register)) throw new InterpreterFault('invalid_ir', `undefined register ${register}`);
    return registers.get(register) as CanonicalValue;
  };
  switch (instruction.tag) {
    case 'constant':
      return constantValue(instruction);
    case 'project-field': {
      const value = record(get(instruction.from));
      if (!Object.hasOwn(value, instruction.field))
        throw new InterpreterFault('invalid_input', `missing field ${instruction.field}`);
      return value[instruction.field] as CanonicalValue;
    }
    case 'compare':
      return compare(instruction.operator, get(instruction.left), get(instruction.right));
    case 'binary':
      return binary(instruction.operator, get(instruction.left), get(instruction.right));
    case 'construct-record':
      return Object.freeze(
        Object.fromEntries(instruction.fields.map(([name, register]) => [name, get(register)])),
      ) as CanonicalValue;
    case 'construct-variant':
      return Object.freeze({ tag: instruction.variant, value: get(instruction.payload) });
    case 'build-template':
      return instruction.parts.map((part) => (typeof part === 'string' ? part : String(get(part.register)))).join('');
  }
}

function allocation(
  instruction: IrInstruction,
  value: CanonicalValue,
): Readonly<{ value: CanonicalValue; type: Schema }> | undefined {
  return instruction.tag === 'construct-record' ||
    instruction.tag === 'construct-variant' ||
    instruction.tag === 'build-template'
    ? { value, type: instruction.type }
    : undefined;
}

/**
 * Executes verified IR with explicit semantic charging and no access to JavaScript globals or host services.
 *
 * @remarks The verifier establishes structural safety; runtime checks remain defense in depth against corrupted
 * internal values. Host effects can occur only through `hooks.action` after the bridge records a request.
 * @internal
 */
export async function interpret(
  program: VerifiedProgram,
  input: CanonicalValue,
  hooks: InterpreterHooks,
): Promise<CanonicalValue> {
  const registers = new Map<string, CanonicalValue>([[program.program.input.register, input]]);
  let current = program.program.entry;
  const enter = (target: string, values: readonly CanonicalValue[]): void => {
    const block = program.blocks.get(target);
    if (!block || block.parameters.length !== values.length)
      throw new InterpreterFault('invalid_ir', 'invalid control-flow edge');
    for (const [index, parameter] of block.parameters.entries())
      registers.set(parameter.register, values[index] as CanonicalValue);
    current = target;
  };
  // The IR verifier guarantees reachable terminators, so execution ends only through return, cancellation, or fault.
  while (true) {
    if (hooks.cancelled()) throw new InterpreterFault('cancelled');
    const block = program.blocks.get(current);
    if (!block) throw new InterpreterFault('invalid_ir', `unknown block ${current}`);
    for (const instruction of block.instructions) {
      hooks.charge(1);
      if (instruction.tag === 'compare') {
        const left = registers.get(instruction.left);
        const right = registers.get(instruction.right);
        if (left === undefined || right === undefined)
          throw new InterpreterFault('invalid_ir', 'undefined comparison register');
        hooks.scan([left, right]);
      }
      const value = evaluate(instruction, registers);
      const allocated = allocation(instruction, value);
      if (allocated !== undefined) hooks.charge(4, allocated);
      registers.set(instruction.destination, value);
    }
    const terminator = block.terminator;
    hooks.charge(1);
    hooks.trace(terminator.tag, terminator.source);
    const get = (register: string): CanonicalValue => {
      if (!registers.has(register)) throw new InterpreterFault('invalid_ir', `undefined register ${register}`);
      return registers.get(register) as CanonicalValue;
    };
    switch (terminator.tag) {
      case 'jump':
        enter(terminator.target, terminator.arguments.map(get));
        break;
      case 'branch': {
        const condition = get(terminator.condition);
        if (typeof condition !== 'boolean') throw new InterpreterFault('invalid_ir', 'branch condition is not boolean');
        enter(condition ? terminator.whenTrue : terminator.whenFalse, []);
        break;
      }
      case 'switch': {
        const value = record(get(terminator.value));
        const selected = terminator.cases.find((item) => item.variant === value.tag);
        if (!selected || !Object.hasOwn(value, 'value'))
          throw new InterpreterFault('invalid_ir', 'invalid closed variant');
        enter(selected.target, [value.value as CanonicalValue]);
        break;
      }
      case 'action': {
        const result = await hooks.action(terminator, get(terminator.input));
        enter(terminator.resume, [result]);
        break;
      }
      case 'structured':
        return interpretStructured(terminator.program, get(terminator.input), hooks);
      case 'return':
        return get(terminator.value);
    }
  }
}
