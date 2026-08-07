/** Bounded evaluator for verifier-approved SafeScript 1.1 structured IR. */
import type { CanonicalValue } from '@safescript/contracts';
import type { ActionInstruction } from './ir.js';
import { InterpreterFault, type InterpreterHooks } from './interpreter.js';
import type {
  StructuredExpression,
  StructuredFunction,
  StructuredProgram,
  StructuredStatement,
} from './structured-ir.js';

type RuntimeValue = CanonicalValue | Closure | Builtin;
interface Cell {
  value: RuntimeValue;
  readonly mutable: boolean;
}
interface Closure {
  readonly kind: 'closure';
  readonly fn: StructuredFunction;
  readonly environment: Environment;
}
interface Builtin {
  readonly kind: 'builtin';
  readonly name: string;
  readonly receiver?: RuntimeValue;
}

function isClosure(value: RuntimeValue): value is Closure {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'closure' && 'fn' in value;
}

function isBuiltin(value: RuntimeValue): value is Builtin {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'builtin' && 'name' in value;
}

class Environment {
  readonly values = new Map<string, Cell>();
  constructor(readonly parent?: Environment) {}
  define(name: string, value: RuntimeValue, mutable = false): void {
    if (this.values.has(name)) throw new InterpreterFault('invalid_ir', `duplicate binding ${name}`);
    this.values.set(name, { value, mutable });
  }
  cell(name: string): Cell | undefined {
    return this.values.get(name) ?? this.parent?.cell(name);
  }
  get(name: string): RuntimeValue {
    const cell = this.cell(name);
    if (!cell) throw new InterpreterFault('invalid_ir', `unknown binding ${name}`);
    return cell.value;
  }
  set(name: string, value: RuntimeValue): void {
    const cell = this.cell(name);
    if (!cell?.mutable) throw new InterpreterFault('invalid_ir', `immutable binding ${name}`);
    cell.value = value;
  }
}

class ReturnSignal {
  constructor(readonly value: RuntimeValue) {}
}
class BreakSignal {}
class ContinueSignal {}
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
function canonical(value: RuntimeValue): CanonicalValue {
  if (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    ((value as Closure).kind === 'closure' || (value as Builtin).kind === 'builtin')
  )
    throw new InterpreterFault('invalid_output', 'functions cannot become canonical data');
  return value as CanonicalValue;
}
function truth(value: RuntimeValue): boolean {
  if (typeof value !== 'boolean') throw new InterpreterFault('invalid_ir', 'condition requires boolean');
  return value;
}
function record(value: RuntimeValue): Readonly<Record<string, RuntimeValue>> {
  if (value === null || Array.isArray(value) || typeof value !== 'object' || 'kind' in value)
    throw new InterpreterFault('invalid_ir', 'record required');
  return value as Readonly<Record<string, RuntimeValue>>;
}
function stable(value: CanonicalValue): string {
  if (typeof value === 'bigint') return `i:${value}`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${key}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function arithmetic(operator: string, left: RuntimeValue, right: RuntimeValue): RuntimeValue {
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    if ((operator === 'divide' || operator === 'remainder') && right === 0n)
      throw new InterpreterFault('invalid_arithmetic', 'division by zero');
    const shift = Number(right);
    if (
      (operator === 'shift-left' || operator === 'shift-right') &&
      (!Number.isSafeInteger(shift) || shift < 0 || shift > 63)
    )
      throw new InterpreterFault('invalid_arithmetic', 'invalid shift');
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
  if (
    typeof left === 'number' &&
    typeof right === 'number' &&
    ['add', 'subtract', 'multiply', 'divide', 'remainder'].includes(operator)
  ) {
    if ((operator === 'divide' || operator === 'remainder') && right === 0)
      throw new InterpreterFault('invalid_arithmetic', 'division by zero');
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
  if (operator === 'add' && typeof left === 'string' && typeof right === 'string') return left + right;
  throw new InterpreterFault('invalid_ir', 'incompatible binary operands');
}

function ordered(operator: string, left: RuntimeValue, right: RuntimeValue): boolean {
  if (typeof left === 'bigint' && typeof right === 'bigint')
    return operator === 'less'
      ? left < right
      : operator === 'less-equal'
        ? left <= right
        : operator === 'greater'
          ? left > right
          : left >= right;
  if (typeof left === 'number' && typeof right === 'number')
    return operator === 'less'
      ? left < right
      : operator === 'less-equal'
        ? left <= right
        : operator === 'greater'
          ? left > right
          : left >= right;
  if (typeof left === 'string' && typeof right === 'string')
    return operator === 'less'
      ? left < right
      : operator === 'less-equal'
        ? left <= right
        : operator === 'greater'
          ? left > right
          : left >= right;
  throw new InterpreterFault('invalid_ir', 'ordered operands mismatch');
}

export async function interpretStructured(
  program: StructuredProgram,
  input: CanonicalValue,
  hooks: InterpreterHooks,
): Promise<CanonicalValue> {
  const root = new Environment();
  for (const name of ['Object', 'Array', 'Math', 'JSON', 'Bytes', 'Temporal', 'console'])
    root.define(name, { kind: 'builtin', name });
  const functions = new Map(program.functions.map((fn) => [fn.name, fn]));
  for (const fn of program.functions) root.define(fn.name, { kind: 'closure', fn, environment: root });
  const call = async (closure: Closure, arguments_: RuntimeValue[]): Promise<RuntimeValue> => {
    hooks.charge(5);
    if (arguments_.length < closure.fn.parameters.length)
      throw new InterpreterFault('invalid_ir', 'call arity mismatch');
    const environment = new Environment(closure.environment);
    closure.fn.parameters.forEach((name, index) => environment.define(name, arguments_[index] as RuntimeValue));
    try {
      await executeStatements(closure.fn.body, environment);
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.value;
      throw signal;
    }
    throw new InterpreterFault('invalid_ir', `function ${closure.fn.name} did not return`);
  };
  const evaluate = async (expression: StructuredExpression, environment: Environment): Promise<RuntimeValue> => {
    hooks.charge(1);
    switch (expression.tag) {
      case 'literal':
        return expression.kind === 'int64' ? BigInt(expression.value as string) : (expression.value as CanonicalValue);
      case 'name':
        return environment.get(expression.name);
      case 'member': {
        const value = await evaluate(expression.value, environment);
        if (expression.optional && (value === null || value === undefined))
          return Object.freeze({ tag: 'none', value: null });
        if (isBuiltin(value)) return { kind: 'builtin', name: `${value.name}.${expression.name}` };
        if (Array.isArray(value) || typeof value === 'string') {
          if (expression.name === 'length') return BigInt(value.length);
          return { kind: 'builtin', name: expression.name, receiver: value };
        }
        const valueRecord = record(value);
        if (!Object.hasOwn(valueRecord, expression.name))
          return { kind: 'builtin', name: expression.name, receiver: value };
        return valueRecord[expression.name] as RuntimeValue;
      }
      case 'index': {
        const value = await evaluate(expression.value, environment);
        const index = await evaluate(expression.index, environment);
        if (expression.optional && value === null) return Object.freeze({ tag: 'none', value: null });
        if (Array.isArray(value)) return value[Number(index)] as RuntimeValue;
        if (typeof value === 'string') return [...value][Number(index)] ?? '';
        return record(value)[String(index)] as RuntimeValue;
      }
      case 'array': {
        const values: CanonicalValue[] = [];
        for (const item of expression.items) values.push(canonical(await evaluate(item, environment)));
        hooks.charge(4);
        return Object.freeze(values);
      }
      case 'object': {
        const entries: [string, CanonicalValue][] = [];
        for (const field of expression.fields)
          entries.push([field.name, canonical(await evaluate(field.value, environment))]);
        return Object.freeze(Object.fromEntries(entries)) as CanonicalValue;
      }
      case 'template': {
        let result = '';
        for (const part of expression.parts)
          result += typeof part === 'string' ? part : String(await evaluate(part, environment));
        return result;
      }
      case 'unary': {
        const value = await evaluate(expression.value, environment);
        if (expression.operator === 'not') return !truth(value);
        if (typeof value !== 'bigint' && typeof value !== 'number')
          throw new InterpreterFault('invalid_ir', 'numeric unary operand required');
        return expression.operator === 'negate'
          ? typeof value === 'bigint'
            ? -value
            : -value
          : typeof value === 'bigint'
            ? ~value
            : (() => {
                throw new InterpreterFault('invalid_ir', 'bitwise float operation');
              })();
      }
      case 'binary': {
        const left = await evaluate(expression.left, environment);
        if (expression.operator === 'and') return truth(left) ? evaluate(expression.right, environment) : false;
        if (expression.operator === 'or') return truth(left) ? true : evaluate(expression.right, environment);
        if (expression.operator === 'nullish') return left === null ? evaluate(expression.right, environment) : left;
        const right = await evaluate(expression.right, environment);
        if (expression.operator === 'equal' || expression.operator === 'not-equal') {
          const equal = stable(canonical(left)) === stable(canonical(right));
          return expression.operator === 'equal' ? equal : !equal;
        }
        if (['less', 'less-equal', 'greater', 'greater-equal'].includes(expression.operator)) {
          if (
            (typeof left !== 'bigint' && typeof left !== 'number' && typeof left !== 'string') ||
            typeof left !== typeof right
          )
            throw new InterpreterFault('invalid_ir', 'ordered operands mismatch');
          return ordered(expression.operator, left, right);
        }
        if (expression.operator === 'in') return Object.hasOwn(record(right), String(left));
        return arithmetic(expression.operator, left, right);
      }
      case 'conditional':
        return truth(await evaluate(expression.condition, environment))
          ? evaluate(expression.whenTrue, environment)
          : evaluate(expression.whenFalse, environment);
      case 'result':
        return Object.freeze({
          tag: expression.variant,
          value: canonical(await evaluate(expression.value, environment)),
        });
      case 'action': {
        const action: ActionInstruction = {
          tag: 'action',
          operationId: expression.operationId,
          effectId: expression.effectId,
          capabilityId: expression.capabilityId,
          actionSiteId: expression.actionSiteId,
          input: '',
          inputType: expression.inputType,
          resultType: expression.resultType,
          resume: '',
          source: expression.source,
        };
        return hooks.action(action, canonical(await evaluate(expression.input, environment)));
      }
      case 'function':
        return {
          kind: 'closure',
          fn: {
            name: `<closure:${expression.source.start}>`,
            parameters: expression.parameters,
            body: expression.body,
            source: expression.source,
          },
          environment,
        };
      case 'call': {
        const callee = await evaluate(expression.callee, environment);
        const arguments_: RuntimeValue[] = [];
        for (const argument of expression.arguments) arguments_.push(await evaluate(argument, environment));
        if (isClosure(callee)) return call(callee, arguments_);
        if (isBuiltin(callee)) return invokeBuiltin(callee, arguments_, hooks, call);
        throw new InterpreterFault('invalid_ir', 'call target is not statically known');
      }
    }
  };
  const executeStatements = async (
    statements: readonly StructuredStatement[],
    environment: Environment,
  ): Promise<void> => {
    for (const statement of statements) {
      hooks.charge(1);
      hooks.trace(statement.tag, statement.source);
      if (hooks.cancelled()) throw new InterpreterFault('cancelled');
      switch (statement.tag) {
        case 'variable':
          environment.define(statement.name, await evaluate(statement.value, environment), statement.mutable);
          break;
        case 'assign': {
          const right = await evaluate(statement.value, environment);
          environment.set(
            statement.name,
            statement.operator === 'set'
              ? right
              : arithmetic(statement.operator, environment.get(statement.name), right),
          );
          break;
        }
        case 'expression':
          await evaluate(statement.expression, environment);
          break;
        case 'if':
          await executeStatements(
            truth(await evaluate(statement.condition, environment)) ? statement.whenTrue : statement.whenFalse,
            new Environment(environment),
          );
          break;
        case 'for-of': {
          const values = await evaluate(statement.values, environment);
          if (!Array.isArray(values)) throw new InterpreterFault('invalid_ir', 'for-of requires a bounded list');
          for (const value of values) {
            hooks.charge(3);
            const iteration = new Environment(environment);
            iteration.define(statement.name, value, statement.mutable);
            try {
              await executeStatements(statement.body, iteration);
            } catch (signal) {
              if (signal instanceof BreakSignal) break;
              if (signal instanceof ContinueSignal) continue;
              throw signal;
            }
          }
          break;
        }
        case 'for-in': {
          const value = await evaluate(statement.value, environment);
          const keys = Array.isArray(value) ? value.map((_item, index) => String(index)) : Object.keys(record(value));
          for (const key of keys) {
            hooks.charge(3);
            const iteration = new Environment(environment);
            iteration.define(statement.name, key, statement.mutable);
            try {
              await executeStatements(statement.body, iteration);
            } catch (signal) {
              if (signal instanceof BreakSignal) break;
              if (signal instanceof ContinueSignal) continue;
              throw signal;
            }
          }
          break;
        }
        case 'loop': {
          const loopEnvironment = new Environment(environment);
          await executeStatements(statement.initializer, loopEnvironment);
          let first = true;
          while ((statement.checkAfter && first) || truth(await evaluate(statement.condition, loopEnvironment))) {
            first = false;
            hooks.charge(2);
            try {
              await executeStatements(statement.body, new Environment(loopEnvironment));
            } catch (signal) {
              if (signal instanceof BreakSignal) break;
              if (!(signal instanceof ContinueSignal)) throw signal;
            }
            await executeStatements(statement.increment, loopEnvironment);
          }
          break;
        }
        case 'break':
          throw new BreakSignal();
        case 'continue':
          throw new ContinueSignal();
        case 'return':
          throw new ReturnSignal(await evaluate(statement.value, environment));
        case 'switch': {
          const value = await evaluate(statement.value, environment);
          const tag = typeof value === 'object' && value !== null && !Array.isArray(value) ? record(value).tag : value;
          const selected = statement.cases.find((item) => item.value === tag);
          if (!selected) throw new InterpreterFault('invalid_ir', 'non-exhaustive switch');
          await executeStatements(selected.body, new Environment(environment));
          break;
        }
      }
    }
  };
  const handler = functions.get(program.handler);
  if (!handler) throw new InterpreterFault('invalid_ir', 'missing handler');
  return canonical(await call({ kind: 'closure', fn: handler, environment: root }, [input, Object.freeze({})]));
}

async function invokeBuiltin(
  builtin: Builtin,
  arguments_: RuntimeValue[],
  hooks: InterpreterHooks,
  call: (closure: Closure, arguments_: RuntimeValue[]) => Promise<RuntimeValue>,
): Promise<RuntimeValue> {
  const receiver = builtin.receiver;
  if (builtin.name.startsWith('Object.')) {
    const value = arguments_[0] as RuntimeValue;
    if (builtin.name === 'Object.keys') return Object.freeze(Object.keys(record(value)));
    if (builtin.name === 'Object.values') return Object.freeze(Object.values(record(value)).map(canonical));
    if (builtin.name === 'Object.entries')
      return Object.freeze(Object.entries(record(value)).map(([key, item]) => Object.freeze([key, canonical(item)])));
    if (builtin.name === 'Object.hasOwn') return Object.hasOwn(record(value), String(arguments_[1]));
    if (builtin.name === 'Object.fromEntries') {
      if (!Array.isArray(value)) throw new InterpreterFault('invalid_ir', 'Object.fromEntries requires tuples');
      return Object.freeze(
        Object.fromEntries(
          value.map((item) => {
            if (!Array.isArray(item) || item.length !== 2)
              throw new InterpreterFault('invalid_ir', 'entry must be a pair');
            return [String(item[0]), item[1]];
          }),
        ),
      ) as CanonicalValue;
    }
  }
  if (builtin.name.startsWith('Array.')) {
    if (builtin.name === 'Array.isArray') return Array.isArray(arguments_[0]);
    if (builtin.name === 'Array.from') {
      const value = arguments_[0];
      if (Array.isArray(value)) return Object.freeze([...value]);
      if (typeof value === 'string') return Object.freeze([...value]);
      throw new InterpreterFault('invalid_ir', 'Array.from requires a bounded list or string');
    }
  }
  if (builtin.name.startsWith('Math.')) {
    const values = arguments_.map((value) => Number(value));
    const name = builtin.name.slice('Math.'.length);
    const functions: Readonly<Record<string, (...items: number[]) => number>> = {
      abs: Math.abs,
      ceil: Math.ceil,
      floor: Math.floor,
      round: Math.round,
      trunc: Math.trunc,
      sqrt: Math.sqrt,
      cbrt: Math.cbrt,
      pow: Math.pow,
      exp: Math.exp,
      log: Math.log,
      log2: Math.log2,
      log10: Math.log10,
      sin: Math.sin,
      cos: Math.cos,
      tan: Math.tan,
      asin: Math.asin,
      acos: Math.acos,
      atan: Math.atan,
      atan2: Math.atan2,
      min: Math.min,
      max: Math.max,
    };
    const operation = functions[name];
    if (!operation || name === 'random') throw new InterpreterFault('invalid_ir', `unsupported Math intrinsic ${name}`);
    hooks.charge(
      ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'log', 'log2', 'log10', 'exp', 'pow'].includes(name)
        ? 32
        : 4,
    );
    const result = operation(...values);
    if (!Number.isFinite(result)) throw new InterpreterFault('non_finite_number');
    return Number.isSafeInteger(result) ? BigInt(result) : result;
  }
  if (Array.isArray(receiver)) {
    const callback = arguments_[0];
    if (['map', 'filter', 'flatMap', 'find', 'some', 'every'].includes(builtin.name)) {
      if (!callback || !isClosure(callback))
        throw new InterpreterFault('invalid_ir', `${builtin.name} requires a checked callback`);
      const produced: CanonicalValue[] = [];
      for (const [index, item] of receiver.entries()) {
        hooks.charge(2);
        const value = await call(callback, [item, BigInt(index), receiver]);
        if (builtin.name === 'map') produced.push(canonical(value));
        else if (builtin.name === 'flatMap') {
          if (!Array.isArray(value)) throw new InterpreterFault('invalid_ir', 'flatMap callback must return a list');
          produced.push(...value);
        } else if (builtin.name === 'filter') {
          if (truth(value)) produced.push(item);
        } else if (builtin.name === 'find' && truth(value)) return item;
        else if (builtin.name === 'some' && truth(value)) return true;
        else if (builtin.name === 'every' && !truth(value)) return false;
      }
      if (builtin.name === 'find') return Object.freeze({ tag: 'none', value: null });
      if (builtin.name === 'some') return false;
      if (builtin.name === 'every') return true;
      return Object.freeze(produced);
    }
    if (builtin.name === 'reduce') {
      if (!callback || !isClosure(callback) || arguments_.length < 2)
        throw new InterpreterFault('invalid_ir', 'reduce requires a callback and initial value');
      let accumulator = arguments_[1] as RuntimeValue;
      for (const [index, item] of receiver.entries()) {
        hooks.charge(2);
        accumulator = await call(callback, [accumulator, item, BigInt(index), receiver]);
      }
      return accumulator;
    }
    if (builtin.name === 'includes')
      return receiver.some((item) => stable(item) === stable(canonical(arguments_[0] as RuntimeValue)));
    if (builtin.name === 'slice')
      return Object.freeze(
        receiver.slice(Number(arguments_[0] ?? 0), arguments_[1] === undefined ? undefined : Number(arguments_[1])),
      );
    if (builtin.name === 'concat') return Object.freeze(receiver.concat(...arguments_.map(canonical)));
  }
  if (typeof receiver === 'string') {
    if (builtin.name === 'includes') return receiver.includes(String(arguments_[0]));
    if (builtin.name === 'startsWith') return receiver.startsWith(String(arguments_[0]));
    if (builtin.name === 'endsWith') return receiver.endsWith(String(arguments_[0]));
    if (builtin.name === 'slice')
      return [...receiver]
        .slice(Number(arguments_[0] ?? 0), arguments_[1] === undefined ? undefined : Number(arguments_[1]))
        .join('');
    if (builtin.name === 'trim') return receiver.trim();
    if (builtin.name === 'toUpperCase') return receiver.toUpperCase();
    if (builtin.name === 'toLowerCase') return receiver.toLowerCase();
  }
  hooks.charge(1);
  throw new InterpreterFault('invalid_ir', `unsupported pure intrinsic ${builtin.name}`);
}
