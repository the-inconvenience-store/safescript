/** Closed structured control-flow IR used by the additive SafeScript 1.1 language minor. */
import type {
  ActionSiteId,
  CapabilityId,
  ContractRegistry,
  EffectId,
  OperationId,
  ProgramSummary,
  Schema,
  SlotDefinition,
  SourceLocation,
} from '@safescript/contracts';

export type StructuredExpression =
  | Readonly<{
      tag: 'literal';
      kind: 'unit' | 'boolean' | 'int64' | 'float64' | 'string';
      value: null | boolean | number | string;
      source: SourceLocation;
    }>
  | Readonly<{ tag: 'name'; name: string; source: SourceLocation }>
  | Readonly<{ tag: 'member'; value: StructuredExpression; name: string; optional: boolean; source: SourceLocation }>
  | Readonly<{
      tag: 'index';
      value: StructuredExpression;
      index: StructuredExpression;
      optional: boolean;
      source: SourceLocation;
    }>
  | Readonly<{ tag: 'array'; items: readonly StructuredExpression[]; source: SourceLocation }>
  | Readonly<{
      tag: 'object';
      fields: readonly Readonly<{ name: string; value: StructuredExpression }>[];
      source: SourceLocation;
    }>
  | Readonly<{ tag: 'template'; parts: readonly (string | StructuredExpression)[]; source: SourceLocation }>
  | Readonly<{
      tag: 'unary';
      operator: 'not' | 'negate' | 'bit-not';
      value: StructuredExpression;
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'binary';
      operator:
        | 'add'
        | 'subtract'
        | 'multiply'
        | 'divide'
        | 'remainder'
        | 'bit-and'
        | 'bit-or'
        | 'bit-xor'
        | 'shift-left'
        | 'shift-right'
        | 'equal'
        | 'not-equal'
        | 'less'
        | 'less-equal'
        | 'greater'
        | 'greater-equal'
        | 'and'
        | 'or'
        | 'nullish'
        | 'in';
      left: StructuredExpression;
      right: StructuredExpression;
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'conditional';
      condition: StructuredExpression;
      whenTrue: StructuredExpression;
      whenFalse: StructuredExpression;
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'call';
      callee: StructuredExpression;
      arguments: readonly StructuredExpression[];
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'function';
      parameters: readonly string[];
      body: readonly StructuredStatement[];
      source: SourceLocation;
    }>
  | Readonly<{ tag: 'result'; variant: 'ok' | 'error'; value: StructuredExpression; source: SourceLocation }>
  | Readonly<{
      tag: 'action';
      operationId: OperationId;
      effectId: EffectId;
      capabilityId: CapabilityId;
      actionSiteId: ActionSiteId;
      inputType: Schema;
      resultType: Schema;
      input: StructuredExpression;
      source: SourceLocation;
    }>;

export type StructuredStatement =
  | Readonly<{ tag: 'variable'; name: string; mutable: boolean; value: StructuredExpression; source: SourceLocation }>
  | Readonly<{
      tag: 'assign';
      name: string;
      operator:
        | 'set'
        | 'add'
        | 'subtract'
        | 'multiply'
        | 'divide'
        | 'remainder'
        | 'bit-and'
        | 'bit-or'
        | 'bit-xor'
        | 'shift-left'
        | 'shift-right';
      value: StructuredExpression;
      source: SourceLocation;
    }>
  | Readonly<{ tag: 'expression'; expression: StructuredExpression; source: SourceLocation }>
  | Readonly<{
      tag: 'if';
      condition: StructuredExpression;
      whenTrue: readonly StructuredStatement[];
      whenFalse: readonly StructuredStatement[];
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'for-of';
      name: string;
      mutable: boolean;
      values: StructuredExpression;
      body: readonly StructuredStatement[];
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'for-in';
      name: string;
      mutable: boolean;
      value: StructuredExpression;
      body: readonly StructuredStatement[];
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'loop';
      initializer: readonly StructuredStatement[];
      condition: StructuredExpression;
      increment: readonly StructuredStatement[];
      body: readonly StructuredStatement[];
      checkAfter: boolean;
      source: SourceLocation;
    }>
  | Readonly<{ tag: 'break' | 'continue'; source: SourceLocation }>
  | Readonly<{ tag: 'return'; value: StructuredExpression; source: SourceLocation }>
  | Readonly<{
      tag: 'switch';
      value: StructuredExpression;
      cases: readonly Readonly<{ value: string; body: readonly StructuredStatement[] }>[];
      source: SourceLocation;
    }>;

export interface StructuredFunction {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly body: readonly StructuredStatement[];
  readonly source: SourceLocation;
}

export interface StructuredProgram {
  readonly version: readonly [1, 1];
  readonly handler: string;
  readonly eventParameter: string;
  readonly contextParameter: string;
  readonly functions: readonly StructuredFunction[];
  readonly summary: ProgramSummary;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function location(value: unknown): value is SourceLocation {
  return (
    object(value) &&
    typeof value.module === 'string' &&
    Number.isSafeInteger(value.start) &&
    Number.isSafeInteger(value.end) &&
    Number(value.start) >= 0 &&
    Number(value.end) >= Number(value.start)
  );
}

function expression(
  value: unknown,
  registry: ContractRegistry,
  slot: SlotDefinition,
  depth = 0,
): value is StructuredExpression {
  if (!object(value) || typeof value.tag !== 'string' || !location(value.source) || depth > 256) return false;
  const child = (item: unknown) => expression(item, registry, slot, depth + 1);
  switch (value.tag) {
    case 'literal':
      return (
        ['unit', 'boolean', 'int64', 'float64', 'string'].includes(String(value.kind)) &&
        (value.value === null || ['boolean', 'number', 'string'].includes(typeof value.value))
      );
    case 'name':
      return typeof value.name === 'string';
    case 'member':
      return child(value.value) && typeof value.name === 'string' && typeof value.optional === 'boolean';
    case 'index':
      return child(value.value) && child(value.index) && typeof value.optional === 'boolean';
    case 'array':
      return Array.isArray(value.items) && value.items.every(child);
    case 'object':
      return (
        Array.isArray(value.fields) &&
        value.fields.every((field) => object(field) && typeof field.name === 'string' && child(field.value))
      );
    case 'template':
      return Array.isArray(value.parts) && value.parts.every((part) => typeof part === 'string' || child(part));
    case 'unary':
      return ['not', 'negate', 'bit-not'].includes(String(value.operator)) && child(value.value);
    case 'binary':
      return (
        [
          'add',
          'subtract',
          'multiply',
          'divide',
          'remainder',
          'bit-and',
          'bit-or',
          'bit-xor',
          'shift-left',
          'shift-right',
          'equal',
          'not-equal',
          'less',
          'less-equal',
          'greater',
          'greater-equal',
          'and',
          'or',
          'nullish',
          'in',
        ].includes(String(value.operator)) &&
        child(value.left) &&
        child(value.right)
      );
    case 'conditional':
      return child(value.condition) && child(value.whenTrue) && child(value.whenFalse);
    case 'call':
      return child(value.callee) && Array.isArray(value.arguments) && value.arguments.every(child);
    case 'function':
      return (
        Array.isArray(value.parameters) &&
        value.parameters.every((item) => typeof item === 'string') &&
        statements(value.body, registry, slot, depth + 1)
      );
    case 'result':
      return ['ok', 'error'].includes(String(value.variant)) && child(value.value);
    case 'action': {
      const operation = registry.operations.find((candidate) => candidate.id === value.operationId);
      return (
        !!operation &&
        operation.effect === value.effectId &&
        operation.capability === value.capabilityId &&
        slot.effects.includes(operation.effect) &&
        slot.capabilities.includes(operation.capability) &&
        typeof value.actionSiteId === 'string' &&
        object(value.inputType) &&
        object(value.resultType) &&
        child(value.input)
      );
    }
    default:
      return false;
  }
}

function statements(
  value: unknown,
  registry: ContractRegistry,
  slot: SlotDefinition,
  depth = 0,
): value is readonly StructuredStatement[] {
  if (!Array.isArray(value) || depth > 256) return false;
  return value.every((statement) => {
    if (!object(statement) || typeof statement.tag !== 'string' || !location(statement.source)) return false;
    const expr = (item: unknown) => expression(item, registry, slot, depth + 1);
    const body = (item: unknown) => statements(item, registry, slot, depth + 1);
    switch (statement.tag) {
      case 'variable':
        return typeof statement.name === 'string' && typeof statement.mutable === 'boolean' && expr(statement.value);
      case 'assign':
        return (
          typeof statement.name === 'string' &&
          [
            'set',
            'add',
            'subtract',
            'multiply',
            'divide',
            'remainder',
            'bit-and',
            'bit-or',
            'bit-xor',
            'shift-left',
            'shift-right',
          ].includes(String(statement.operator)) &&
          expr(statement.value)
        );
      case 'expression':
        return expr(statement.expression);
      case 'if':
        return expr(statement.condition) && body(statement.whenTrue) && body(statement.whenFalse);
      case 'for-of':
        return (
          typeof statement.name === 'string' &&
          typeof statement.mutable === 'boolean' &&
          expr(statement.values) &&
          body(statement.body)
        );
      case 'for-in':
        return (
          typeof statement.name === 'string' &&
          typeof statement.mutable === 'boolean' &&
          expr(statement.value) &&
          body(statement.body)
        );
      case 'loop':
        return (
          body(statement.initializer) &&
          expr(statement.condition) &&
          body(statement.increment) &&
          body(statement.body) &&
          typeof statement.checkAfter === 'boolean'
        );
      case 'break':
      case 'continue':
        return true;
      case 'return':
        return expr(statement.value);
      case 'switch':
        return (
          expr(statement.value) &&
          Array.isArray(statement.cases) &&
          statement.cases.every((item) => object(item) && typeof item.value === 'string' && body(item.body))
        );
      default:
        return false;
    }
  });
}

export function verifyStructuredProgram(
  value: unknown,
  registry: ContractRegistry,
  slot: SlotDefinition,
): value is StructuredProgram {
  if (
    !object(value) ||
    !Array.isArray(value.version) ||
    value.version[0] !== 1 ||
    value.version[1] !== 1 ||
    typeof value.handler !== 'string' ||
    typeof value.eventParameter !== 'string' ||
    typeof value.contextParameter !== 'string' ||
    !Array.isArray(value.functions) ||
    !object(value.summary) ||
    !Array.isArray(value.summary.effects) ||
    !Array.isArray(value.summary.capabilities)
  )
    return false;
  const names = new Set<string>();
  if (
    !value.functions.every(
      (fn) =>
        object(fn) &&
        typeof fn.name === 'string' &&
        !names.has(fn.name) &&
        !!names.add(fn.name) &&
        Array.isArray(fn.parameters) &&
        fn.parameters.every((parameter) => typeof parameter === 'string') &&
        location(fn.source) &&
        statements(fn.body, registry, slot),
    )
  )
    return false;
  return names.has(value.handler);
}

export function structuredActions(
  program: StructuredProgram,
): readonly Extract<StructuredExpression, { tag: 'action' }>[] {
  const actions: Extract<StructuredExpression, { tag: 'action' }>[] = [];
  const visitExpression = (item: StructuredExpression): void => {
    if (item.tag === 'action') {
      actions.push(item);
      visitExpression(item.input);
    } else if (item.tag === 'member') visitExpression(item.value);
    else if (item.tag === 'index') {
      visitExpression(item.value);
      visitExpression(item.index);
    } else if (item.tag === 'array') item.items.forEach(visitExpression);
    else if (item.tag === 'object') item.fields.forEach((field) => visitExpression(field.value));
    else if (item.tag === 'template')
      item.parts.forEach((part) => {
        if (typeof part !== 'string') visitExpression(part);
      });
    else if (item.tag === 'unary') visitExpression(item.value);
    else if (item.tag === 'binary') {
      visitExpression(item.left);
      visitExpression(item.right);
    } else if (item.tag === 'conditional') {
      visitExpression(item.condition);
      visitExpression(item.whenTrue);
      visitExpression(item.whenFalse);
    } else if (item.tag === 'call') {
      visitExpression(item.callee);
      item.arguments.forEach(visitExpression);
    } else if (item.tag === 'function') {
      visitStatements(item.body);
    } else if (item.tag === 'result') visitExpression(item.value);
  };
  const visitStatements = (items: readonly StructuredStatement[]): void =>
    items.forEach((item) => {
      if (item.tag === 'variable' || item.tag === 'assign') visitExpression(item.value);
      else if (item.tag === 'expression') visitExpression(item.expression);
      else if (item.tag === 'if') {
        visitExpression(item.condition);
        visitStatements(item.whenTrue);
        visitStatements(item.whenFalse);
      } else if (item.tag === 'for-of') {
        visitExpression(item.values);
        visitStatements(item.body);
      } else if (item.tag === 'for-in') {
        visitExpression(item.value);
        visitStatements(item.body);
      } else if (item.tag === 'loop') {
        visitStatements(item.initializer);
        visitExpression(item.condition);
        visitStatements(item.increment);
        visitStatements(item.body);
      } else if (item.tag === 'return') visitExpression(item.value);
      else if (item.tag === 'switch') {
        visitExpression(item.value);
        item.cases.forEach((entry) => visitStatements(entry.body));
      }
    });
  program.functions.forEach((fn) => visitStatements(fn.body));
  return actions;
}
