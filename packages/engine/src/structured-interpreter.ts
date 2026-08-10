/** Bounded evaluator for verifier-approved SafeScript 1.1 structured IR. */
import type { CanonicalValue } from '@safescript/contracts';
import { InterpreterFault, type InterpreterHooks } from './interpreter.js';
import { byteFuel, linearFuel, SEMANTIC_STEP_FUEL } from './resource-schedule.js';
import type {
  StructuredAction,
  StructuredExpression,
  StructuredFunction,
  StructuredPattern,
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

function isNone(value: RuntimeValue): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isClosure(value) &&
    !isBuiltin(value) &&
    (value as Readonly<Record<string, RuntimeValue>>).tag === 'none'
  );
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
  if (
    ((typeof left === 'bigint' && typeof right === 'number') ||
      (typeof left === 'number' && typeof right === 'bigint')) &&
    ['add', 'subtract', 'multiply', 'divide', 'remainder'].includes(operator)
  ) {
    const promotedLeft = Number(left);
    const promotedRight = Number(right);
    if ((operator === 'divide' || operator === 'remainder') && promotedRight === 0)
      throw new InterpreterFault('invalid_arithmetic', 'division by zero');
    const result =
      operator === 'add'
        ? promotedLeft + promotedRight
        : operator === 'subtract'
          ? promotedLeft - promotedRight
          : operator === 'multiply'
            ? promotedLeft * promotedRight
            : operator === 'divide'
              ? promotedLeft / promotedRight
              : promotedLeft % promotedRight;
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
  for (const name of [
    'Object',
    'Array',
    'Math',
    'JSON',
    'Bytes',
    'Temporal',
    'Promise',
    'console',
    'parseInt64',
    'parseFloat64',
  ])
    root.define(name, { kind: 'builtin', name });
  root.define('undefined', Object.freeze({ tag: 'none', value: null }));
  const functions = new Map(program.functions.map((fn) => [fn.name, fn]));
  for (const fn of program.functions) root.define(fn.name, { kind: 'closure', fn, environment: root });
  const call = async (closure: Closure, arguments_: RuntimeValue[]): Promise<RuntimeValue> => {
    const leave = hooks.enterCall();
    hooks.charge(SEMANTIC_STEP_FUEL);
    if (arguments_.length < closure.fn.parameters.length)
      throw new InterpreterFault('invalid_ir', 'call arity mismatch');
    const environment = new Environment(closure.environment);
    closure.fn.parameters.forEach((name, index) => environment.define(name, arguments_[index] as RuntimeValue));
    try {
      try {
        await executeStatements(closure.fn.body, environment);
      } catch (signal) {
        if (signal instanceof ReturnSignal) return signal.value;
        throw signal;
      }
      throw new InterpreterFault('invalid_ir', `function ${closure.fn.name} did not return`);
    } finally {
      leave();
    }
  };
  const evaluate = async (expression: StructuredExpression, environment: Environment): Promise<RuntimeValue> => {
    hooks.charge(SEMANTIC_STEP_FUEL);
    switch (expression.tag) {
      case 'literal':
        return expression.kind === 'int64' ? BigInt(expression.value as string) : (expression.value as CanonicalValue);
      case 'name':
        return environment.get(expression.name);
      case 'member': {
        const value = await evaluate(expression.value, environment);
        if (expression.optional && (value === null || isNone(value)))
          return Object.freeze({ tag: 'none', value: null });
        if (isBuiltin(value)) return { kind: 'builtin', name: `${value.name}.${expression.name}` };
        if (Array.isArray(value) || typeof value === 'string') {
          if (expression.name === 'length') return BigInt(value.length);
          return { kind: 'builtin', name: expression.name, receiver: value };
        }
        const valueRecord = record(value);
        if (
          expression.name === 'toString' &&
          typeof valueRecord.epochSeconds === 'bigint' &&
          typeof valueRecord.nanoseconds === 'number'
        )
          return { kind: 'builtin', name: 'Temporal.Instant.toString', receiver: value };
        if (!Object.hasOwn(valueRecord, expression.name)) return Object.freeze({ tag: 'none', value: null });
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
        for (const item of expression.items) {
          if (typeof item === 'object' && 'spread' in item) {
            const spread = await evaluate(item.spread, environment);
            if (!Array.isArray(spread)) throw new InterpreterFault('invalid_ir', 'array spread requires a list');
            values.push(...spread);
          } else values.push(canonical(await evaluate(item, environment)));
        }
        hooks.collection(values.length);
        const result = Object.freeze(values);
        hooks.allocate(result);
        return result;
      }
      case 'object': {
        const entries: [string, CanonicalValue][] = [];
        for (const field of expression.fields) {
          if ('spread' in field) {
            const spread = record(await evaluate(field.spread, environment));
            entries.push(
              ...Object.entries(spread).map(([name, value]) => [name, canonical(value)] as [string, CanonicalValue]),
            );
          } else entries.push([field.name, canonical(await evaluate(field.value, environment))]);
        }
        const result = Object.freeze(Object.fromEntries(entries)) as CanonicalValue;
        hooks.allocate(result);
        return result;
      }
      case 'template': {
        let result = '';
        for (const part of expression.parts)
          result += typeof part === 'string' ? part : String(await evaluate(part, environment));
        hooks.allocate(result);
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
        if (expression.operator === 'nullish')
          return left === null || isNone(left) ? evaluate(expression.right, environment) : left;
        const right = await evaluate(expression.right, environment);
        if (expression.operator === 'equal' || expression.operator === 'not-equal') {
          hooks.scan([canonical(left), canonical(right)]);
          const mixedNumericEqual =
            typeof left === 'bigint' && typeof right === 'number'
              ? Number.isInteger(right) && BigInt(right) === left
              : typeof left === 'number' && typeof right === 'bigint'
                ? Number.isInteger(left) && BigInt(left) === right
                : undefined;
          const equal =
            mixedNumericEqual === undefined ? stable(canonical(left)) === stable(canonical(right)) : mixedNumericEqual;
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
      case 'result': {
        const result = Object.freeze({
          tag: expression.variant,
          value: canonical(await evaluate(expression.value, environment)),
        });
        hooks.allocate(result);
        return result;
      }
      case 'action': {
        return hooks.action(expression, canonical(await evaluate(expression.input, environment)));
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
        // Promise.all is syntax in SafeScript rather than the ambient JavaScript
        // Promise implementation. Keep the action expressions unevaluated until
        // the complete group has been validated and reserved by the bridge.
        if (
          expression.callee.tag === 'member' &&
          expression.callee.name === 'all' &&
          expression.callee.value.tag === 'name' &&
          expression.callee.value.name === 'Promise' &&
          expression.arguments.length === 1 &&
          expression.arguments[0]?.tag === 'array' &&
          expression.arguments[0].items.every((item) => !('spread' in item) && item.tag === 'action')
        ) {
          const actions: { instruction: StructuredAction; input: CanonicalValue }[] = [];
          for (const item of expression.arguments[0].items) {
            if ('spread' in item || item.tag !== 'action')
              throw new InterpreterFault('invalid_ir', 'invalid concurrent action group');
            actions.push({
              instruction: item,
              input: canonical(await evaluate(item.input, environment)),
            });
          }
          hooks.collection(actions.length);
          const results = Object.freeze([...(await hooks.actionGroup(actions))]);
          hooks.allocate(results);
          return results;
        }
        const callee = await evaluate(expression.callee, environment);
        const arguments_: RuntimeValue[] = [];
        for (const argument of expression.arguments) arguments_.push(await evaluate(argument, environment));
        if (isClosure(callee)) return call(callee, arguments_);
        if (isBuiltin(callee)) return invokeBuiltin(callee, arguments_, hooks, call, expression.source);
        throw new InterpreterFault('invalid_ir', 'call target is not statically known');
      }
    }
  };
  const executeStatements = async (
    statements: readonly StructuredStatement[],
    environment: Environment,
  ): Promise<void> => {
    const bind = (pattern: StructuredPattern, value: RuntimeValue, mutable: boolean): void => {
      if (pattern.tag === 'name') environment.define(pattern.name, value, mutable);
      else if (pattern.tag === 'array') {
        if (!Array.isArray(value)) throw new InterpreterFault('invalid_ir', 'array destructuring requires a list');
        pattern.items.forEach((item, index) => {
          if (item) bind(item, value[index] ?? Object.freeze({ tag: 'none', value: null }), mutable);
        });
      } else {
        const source = record(value);
        pattern.fields.forEach((field) =>
          bind(field.pattern, source[field.name] ?? Object.freeze({ tag: 'none', value: null }), mutable),
        );
      }
    };
    for (const statement of statements) {
      hooks.charge(SEMANTIC_STEP_FUEL);
      hooks.trace(statement.tag, statement.source);
      if (hooks.cancelled()) throw new InterpreterFault('cancelled');
      switch (statement.tag) {
        case 'variable':
          environment.define(statement.name, await evaluate(statement.value, environment), statement.mutable);
          break;
        case 'destructure':
          bind(statement.pattern, await evaluate(statement.value, environment), statement.mutable);
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
          hooks.collection(values.length);
          for (const value of values) {
            hooks.charge(SEMANTIC_STEP_FUEL);
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
          hooks.collection(keys.length);
          for (const key of keys) {
            hooks.charge(SEMANTIC_STEP_FUEL);
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
            hooks.charge(SEMANTIC_STEP_FUEL);
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
          try {
            await executeStatements(selected.body, new Environment(environment));
          } catch (signal) {
            if (!(signal instanceof BreakSignal)) throw signal;
          }
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
  source: StructuredExpression['source'],
): Promise<RuntimeValue> {
  const receiver = builtin.receiver;
  const created = <T extends CanonicalValue>(value: T): T => {
    hooks.allocate(value);
    return value;
  };
  if (builtin.name.startsWith('Object.')) {
    const value = arguments_[0] as RuntimeValue;
    const entries = Object.entries(record(value));
    if (builtin.name !== 'Object.hasOwn') hooks.charge(linearFuel(entries.length));
    if (builtin.name === 'Object.keys') return created(Object.freeze(entries.map(([key]) => key)));
    if (builtin.name === 'Object.values') return created(Object.freeze(entries.map(([, item]) => canonical(item))));
    if (builtin.name === 'Object.entries')
      return created(Object.freeze(entries.map(([key, item]) => Object.freeze([key, canonical(item)]))));
    if (builtin.name === 'Object.hasOwn') return Object.hasOwn(record(value), String(arguments_[1]));
    if (builtin.name === 'Object.fromEntries') {
      if (!Array.isArray(value)) throw new InterpreterFault('invalid_ir', 'Object.fromEntries requires tuples');
      return created(
        Object.freeze(
          Object.fromEntries(
            value.map((item) => {
              if (!Array.isArray(item) || item.length !== 2)
                throw new InterpreterFault('invalid_ir', 'entry must be a pair');
              return [String(item[0]), item[1]];
            }),
          ),
        ) as CanonicalValue,
      );
    }
  }
  if (builtin.name.startsWith('Array.')) {
    if (builtin.name === 'Array.isArray') return Array.isArray(arguments_[0]);
    if (builtin.name === 'Array.from') {
      const value = arguments_[0];
      if (Array.isArray(value)) {
        hooks.collection(value.length);
        hooks.charge(linearFuel(value.length));
        return created(Object.freeze([...value]));
      }
      if (typeof value === 'string') {
        const values = [...value];
        hooks.collection(values.length);
        hooks.charge(linearFuel(values.length));
        return created(Object.freeze(values));
      }
      throw new InterpreterFault('invalid_ir', 'Array.from requires a bounded list or string');
    }
  }
  if (builtin.name === 'Promise.all') {
    const values = arguments_[0];
    if (!Array.isArray(values)) throw new InterpreterFault('invalid_ir', 'Promise.all requires a bounded list');
    return created(Object.freeze([...values]));
  }
  if (builtin.name.startsWith('Math.')) {
    const values = arguments_.map((value) => Number(value));
    const name = builtin.name.slice('Math.'.length);
    if (name === 'random') {
      hooks.charge(SEMANTIC_STEP_FUEL);
      return hooks.random();
    }
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
    if (!operation) throw new InterpreterFault('invalid_ir', `unsupported Math intrinsic ${name}`);
    hooks.charge(SEMANTIC_STEP_FUEL);
    const result = operation(...values);
    if (!Number.isFinite(result)) throw new InterpreterFault('non_finite_number');
    return Number.isSafeInteger(result) ? BigInt(result) : result;
  }
  if (builtin.name === 'parseInt64') {
    const text = arguments_[0];
    if (typeof text !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(text))
      return created(Object.freeze({ tag: 'error', value: Object.freeze({ code: 'invalid_integer' }) }));
    const value = BigInt(text);
    if (value < INT64_MIN || value > INT64_MAX)
      return created(Object.freeze({ tag: 'error', value: Object.freeze({ code: 'integer_overflow' }) }));
    return created(Object.freeze({ tag: 'ok', value }));
  }
  if (builtin.name === 'parseFloat64') {
    const text = arguments_[0];
    const value = typeof text === 'string' && text.trim() === text && text !== '' ? Number(text) : Number.NaN;
    return created(
      Number.isFinite(value)
        ? Object.freeze({ tag: 'ok', value })
        : Object.freeze({ tag: 'error', value: Object.freeze({ code: 'invalid_float' }) }),
    );
  }
  if (builtin.name === 'JSON.parse') {
    const text = arguments_[0];
    if (typeof text !== 'string') throw new InterpreterFault('invalid_ir', 'JSON.parse requires text');
    let converted: CanonicalValue;
    try {
      const convert = (value: unknown): CanonicalValue => {
        if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
        if (typeof value === 'number') {
          if (!Number.isFinite(value)) throw new Error('non-finite');
          return Number.isSafeInteger(value) ? BigInt(value) : value;
        }
        if (Array.isArray(value)) return Object.freeze(value.map(convert));
        if (typeof value === 'object')
          return Object.freeze(
            Object.fromEntries(
              Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, convert(item)]),
            ),
          );
        throw new Error('unsupported');
      };
      converted = convert(JSON.parse(text));
    } catch {
      return created(Object.freeze({ tag: 'error', value: Object.freeze({ code: 'invalid_json' }) }));
    }
    hooks.charge(byteFuel(new TextEncoder().encode(text).length));
    const result = Object.freeze({ tag: 'ok', value: converted });
    hooks.scan([result]);
    return created(result);
  }
  if (builtin.name === 'JSON.stringify') {
    const encode = (value: RuntimeValue): string => {
      if (typeof value === 'bigint') return String(value);
      if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
      if (value !== null && typeof value === 'object')
        return `{${Object.entries(record(value))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`)
          .join(',')}}`;
      return JSON.stringify(value);
    };
    return created(encode(arguments_[0] as RuntimeValue));
  }
  if (builtin.name === 'Bytes.fromUtf8')
    return created(Object.freeze([...new TextEncoder().encode(String(arguments_[0]))]));
  if (builtin.name === 'Bytes.toUtf8') {
    const value = arguments_[0];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'number'))
      throw new InterpreterFault('invalid_ir', 'Bytes.toUtf8 requires bytes');
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value as number[]));
    } catch {
      return created(Object.freeze({ tag: 'error', value: Object.freeze({ code: 'invalid_utf8' }) }));
    }
    return created(decoded);
  }
  if (builtin.name === 'Bytes.fromHex') {
    const text = arguments_[0];
    if (typeof text !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(text))
      throw new InterpreterFault('invalid_ir', 'Bytes.fromHex requires valid hexadecimal text');
    const value = Object.freeze(text.match(/../g)?.map((item) => Number.parseInt(item, 16)) ?? []);
    // Conversion retains its locked semantic charge even though the public
    // authoring surface returns the byte sequence directly.
    hooks.allocate(Object.freeze({ tag: 'ok', value }));
    return value;
  }
  if (builtin.name === 'Temporal.Instant.from') {
    const text = arguments_[0];
    if (
      typeof text !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text) ||
      !Number.isFinite(Date.parse(text))
    )
      return created(Object.freeze({ tag: 'error', value: Object.freeze({ code: 'invalid_instant' }) }));
    const milliseconds = Date.parse(text);
    return created(
      Object.freeze({
        epochSeconds: BigInt(Math.floor(milliseconds / 1000)),
        nanoseconds: Math.trunc((milliseconds % 1000) * 1_000_000),
      }),
    );
  }
  if (builtin.name === 'Temporal.Instant.compare') {
    const instant = (value: RuntimeValue): readonly [bigint, number] => {
      const item = record(value);
      if (typeof item.epochSeconds !== 'bigint' || typeof item.nanoseconds !== 'number')
        throw new InterpreterFault('invalid_ir', 'invalid instant');
      return [item.epochSeconds, item.nanoseconds];
    };
    const left = instant(arguments_[0] as RuntimeValue);
    const right = instant(arguments_[1] as RuntimeValue);
    return left[0] < right[0] || (left[0] === right[0] && left[1] < right[1])
      ? -1n
      : left[0] === right[0] && left[1] === right[1]
        ? 0n
        : 1n;
  }
  if (builtin.name === 'Temporal.Instant.toString') {
    const item = record(receiver as RuntimeValue);
    if (typeof item.epochSeconds !== 'bigint' || typeof item.nanoseconds !== 'number')
      throw new InterpreterFault('invalid_ir', 'invalid instant');
    const milliseconds = Number(item.epochSeconds) * 1000 + Math.trunc(item.nanoseconds / 1_000_000);
    if (!Number.isFinite(milliseconds)) throw new InterpreterFault('invalid_ir', 'instant is outside SafeScript range');
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) throw new InterpreterFault('invalid_ir', 'instant is outside SafeScript range');
    const base = date.toISOString();
    if (item.nanoseconds === 0) return created(base.replace('.000Z', 'Z'));
    const fraction = String(item.nanoseconds).padStart(9, '0').replace(/0+$/, '');
    return created(`${base.slice(0, 19)}.${fraction}Z`);
  }
  if (builtin.name === 'Temporal.Now.instant') {
    const value = hooks.fixedInstant();
    if (value === undefined) throw new InterpreterFault('fixed_instant_required');
    hooks.charge(SEMANTIC_STEP_FUEL);
    return value;
  }
  if (builtin.name.startsWith('console.')) {
    if (!['console.log', 'console.info', 'console.warn', 'console.error'].includes(builtin.name))
      throw new InterpreterFault('invalid_ir', 'unsupported console operation');
    arguments_.forEach(canonical);
    hooks.charge(SEMANTIC_STEP_FUEL);
    hooks.trace(builtin.name, source);
    return null;
  }
  if (Array.isArray(receiver)) {
    hooks.collection(receiver.length);
    const callback = arguments_[0];
    if (builtin.name === 'join') {
      if (receiver.some((item) => typeof item !== 'string'))
        throw new InterpreterFault('invalid_ir', 'join requires a bounded string list');
      const separator = arguments_[0] === undefined ? ',' : arguments_[0];
      if (typeof separator !== 'string') throw new InterpreterFault('invalid_ir', 'join separator must be text');
      hooks.charge(linearFuel(receiver.length));
      return created((receiver as readonly string[]).join(separator));
    }
    if (builtin.name === 'with') {
      const index = Number(arguments_[0]);
      if (!Number.isSafeInteger(index) || index < 0 || index >= receiver.length)
        throw new InterpreterFault('invalid_arithmetic', 'replacement index out of range');
      const result = [...receiver];
      result[index] = canonical(arguments_[1] as RuntimeValue);
      hooks.charge(linearFuel(receiver.length));
      return created(Object.freeze(result));
    }
    if (builtin.name === 'toReversed') {
      hooks.charge(linearFuel(receiver.length));
      return created(Object.freeze([...receiver].reverse()));
    }
    if (builtin.name === 'toSpliced') {
      const start = Number(arguments_[0]);
      const remove = Number(arguments_[1]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(remove) || remove < 0)
        throw new InterpreterFault('invalid_arithmetic', 'invalid immutable splice range');
      const result = [...receiver];
      result.splice(start, remove, ...arguments_.slice(2).map(canonical));
      hooks.collection(result.length);
      hooks.charge(linearFuel(receiver.length));
      return created(Object.freeze(result));
    }
    if (builtin.name === 'toSorted') {
      const result = [...receiver];
      const comparator = arguments_[0];
      for (let index = 1; index < result.length; index++) {
        const value = result[index] as CanonicalValue;
        let position = index;
        while (position > 0) {
          hooks.charge(SEMANTIC_STEP_FUEL);
          const prior = result[position - 1] as CanonicalValue;
          const comparison =
            comparator && isClosure(comparator)
              ? await call(comparator, [prior, value])
              : stable(prior).localeCompare(stable(value));
          const order = typeof comparison === 'bigint' ? Number(comparison) : Number(comparison);
          if (order <= 0) break;
          result[position] = prior;
          position--;
        }
        result[position] = value;
      }
      return created(Object.freeze(result));
    }
    if (['map', 'filter', 'flatMap', 'find', 'some', 'every'].includes(builtin.name)) {
      if (!callback || !isClosure(callback))
        throw new InterpreterFault('invalid_ir', `${builtin.name} requires a checked callback`);
      const produced: CanonicalValue[] = [];
      for (const [index, item] of receiver.entries()) {
        hooks.charge(SEMANTIC_STEP_FUEL);
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
      return created(Object.freeze(produced));
    }
    if (builtin.name === 'reduce') {
      if (!callback || !isClosure(callback) || arguments_.length < 2)
        throw new InterpreterFault('invalid_ir', 'reduce requires a callback and initial value');
      let accumulator = arguments_[1] as RuntimeValue;
      for (const [index, item] of receiver.entries()) {
        hooks.charge(SEMANTIC_STEP_FUEL);
        accumulator = await call(callback, [accumulator, item, BigInt(index), receiver]);
      }
      return accumulator;
    }
    if (builtin.name === 'includes')
      return receiver.some((item) => stable(item) === stable(canonical(arguments_[0] as RuntimeValue)));
    if (builtin.name === 'slice') {
      hooks.charge(linearFuel(receiver.length));
      return created(
        Object.freeze(
          receiver.slice(Number(arguments_[0] ?? 0), arguments_[1] === undefined ? undefined : Number(arguments_[1])),
        ),
      );
    }
    if (builtin.name === 'concat') {
      hooks.charge(linearFuel(receiver.length));
      return created(Object.freeze(receiver.concat(...arguments_.map(canonical))));
    }
  }
  if (typeof receiver === 'string') {
    if (builtin.name === 'includes') return receiver.includes(String(arguments_[0]));
    if (builtin.name === 'startsWith') return receiver.startsWith(String(arguments_[0]));
    if (builtin.name === 'endsWith') return receiver.endsWith(String(arguments_[0]));
    if (builtin.name === 'slice')
      return created(
        [...receiver]
          .slice(Number(arguments_[0] ?? 0), arguments_[1] === undefined ? undefined : Number(arguments_[1]))
          .join(''),
      );
    if (builtin.name === 'trim') return created(receiver.trim());
    if (builtin.name === 'toUpperCase') return created(receiver.toUpperCase());
    if (builtin.name === 'toLowerCase') return created(receiver.toLowerCase());
  }
  hooks.charge(SEMANTIC_STEP_FUEL);
  throw new InterpreterFault('invalid_ir', `unsupported pure intrinsic ${builtin.name}`);
}
