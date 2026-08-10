/** Closed structured control-flow IR used by the additive SafeScript 1.1 language minor. */
import type {
  ActionSiteId,
  ContractRegistry,
  OperationId,
  ProgramSummary,
  Schema,
  SlotDefinition,
  SourceLocation,
} from '@safescript/contracts';
import { ids, resultSchema } from '@safescript/contracts';

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
  | Readonly<{
      tag: 'array';
      items: readonly (StructuredExpression | Readonly<{ spread: StructuredExpression }>)[];
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'object';
      fields: readonly (
        Readonly<{ name: string; value: StructuredExpression }> | Readonly<{ spread: StructuredExpression }>
      )[];
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
      actionSiteId: ActionSiteId;
      inputType: Schema;
      resultType: Schema;
      input: StructuredExpression;
      source: SourceLocation;
    }>;

export type StructuredStatement =
  | Readonly<{ tag: 'variable'; name: string; mutable: boolean; value: StructuredExpression; source: SourceLocation }>
  | Readonly<{
      tag: 'destructure';
      pattern: StructuredPattern;
      mutable: boolean;
      value: StructuredExpression;
      source: SourceLocation;
    }>
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

export type StructuredPattern =
  | Readonly<{ tag: 'name'; name: string }>
  | Readonly<{ tag: 'array'; items: readonly (StructuredPattern | null)[] }>
  | Readonly<{ tag: 'object'; fields: readonly Readonly<{ name: string; pattern: StructuredPattern }>[] }>;

export interface StructuredFunction {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly body: readonly StructuredStatement[];
  readonly source: SourceLocation;
}

export interface StructuredProgram {
  readonly version: readonly [1, 1];
  readonly inputType: Schema;
  readonly resultType: Schema;
  readonly source: SourceLocation;
  readonly handler: string;
  readonly eventParameter: string;
  readonly contextParameter: string;
  readonly functions: readonly StructuredFunction[];
  readonly summary: ProgramSummary;
}

export type StructuredAction = Extract<StructuredExpression, { tag: 'action' }>;

/** Structured IR plus operation lookups proven consistent with the current contract and slot. */
export interface VerifiedStructuredProgram {
  readonly program: StructuredProgram;
  readonly operations: ReadonlyMap<OperationId, ContractRegistry['operations'][number]>;
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

function stable(value: unknown): string {
  if (typeof value === 'bigint') return `{"$bigint":${JSON.stringify(String(value))}}`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function sameSchema(left: Schema, right: Schema): boolean {
  return stable(left) === stable(right);
}

/** Resolves named schema references while rejecting missing or cyclic alias chains. */
export function resolveSchema(value: Schema, registry: ContractRegistry, seen = new Set<string>()): Schema | undefined {
  if (value.kind !== 'ref') return value;
  if (seen.has(value.type)) return undefined;
  const definition = registry.schemas.types.find((candidate) => candidate.id === value.type);
  return definition ? resolveSchema(definition.schema, registry, new Set(seen).add(value.type)) : undefined;
}

/** Returns a closed record field schema after reference resolution. */
export function fieldType(value: Schema, field: string, registry: ContractRegistry): Schema | undefined {
  const resolved = resolveSchema(value, registry);
  if (resolved?.kind === 'record') return resolved.fields.find((candidate) => candidate.name === field)?.schema;
  if (resolved?.kind === 'variant' && field === 'tag') return { kind: 'string' };
  return undefined;
}

function schema(value: unknown, registry: ContractRegistry, depth = 0): value is Schema {
  if (!object(value) || typeof value.kind !== 'string' || depth > 128) return false;
  const child = (item: unknown) => schema(item, registry, depth + 1);
  switch (value.kind) {
    case 'unit':
    case 'boolean':
      return Object.keys(value).length === 1;
    case 'int64':
      return (
        (value.minimum === undefined || typeof value.minimum === 'bigint') &&
        (value.maximum === undefined || typeof value.maximum === 'bigint')
      );
    case 'float64':
      return (
        (value.minimum === undefined || typeof value.minimum === 'number') &&
        (value.maximum === undefined || typeof value.maximum === 'number')
      );
    case 'string':
    case 'bytes':
      return value.maxBytes === undefined || (Number.isSafeInteger(value.maxBytes) && Number(value.maxBytes) >= 0);
    case 'instant':
      return true;
    case 'list':
      return (
        child(value.item) &&
        (value.maxItems === undefined || (Number.isSafeInteger(value.maxItems) && Number(value.maxItems) >= 0))
      );
    case 'tuple':
      return Array.isArray(value.items) && value.items.every(child);
    case 'record':
      return (
        Array.isArray(value.fields) &&
        new Set(value.fields.map((field) => (object(field) ? field.name : undefined))).size === value.fields.length &&
        value.fields.every((field) => object(field) && typeof field.name === 'string' && child(field.schema))
      );
    case 'variant':
      return (
        Array.isArray(value.variants) &&
        new Set(value.variants.map((variant) => (object(variant) ? variant.tag : undefined))).size ===
          value.variants.length &&
        value.variants.every((variant) => object(variant) && typeof variant.tag === 'string' && child(variant.schema))
      );
    case 'brand':
      return (
        typeof value.type === 'string' &&
        registry.schemas.types.some((definition) => definition.id === value.type) &&
        child(value.base)
      );
    case 'ref':
      return (
        typeof value.type === 'string' && registry.schemas.types.some((definition) => definition.id === value.type)
      );
    default:
      return false;
  }
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
      return (
        Array.isArray(value.items) && value.items.every((item) => child(item) || (object(item) && child(item.spread)))
      );
    case 'object':
      return (
        Array.isArray(value.fields) &&
        value.fields.every(
          (field) => object(field) && ((typeof field.name === 'string' && child(field.value)) || child(field.spread)),
        )
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
      if (
        !!operation &&
        slot.operations.includes(operation.id) &&
        typeof value.actionSiteId === 'string' &&
        schema(value.inputType, registry) &&
        schema(value.resultType, registry) &&
        sameSchema(value.inputType, { kind: 'ref', type: operation.input }) &&
        sameSchema(
          value.resultType,
          resultSchema({ kind: 'ref', type: operation.output }, { kind: 'ref', type: operation.error }),
        ) &&
        child(value.input)
      ) {
        try {
          ids.actionSite(value.actionSiteId);
          return true;
        } catch {
          return false;
        }
      }
      return false;
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
    const pattern = (item: unknown, nested = 0): boolean => {
      if (!object(item) || typeof item.tag !== 'string' || nested > 128) return false;
      if (item.tag === 'name') return typeof item.name === 'string';
      if (item.tag === 'array')
        return Array.isArray(item.items) && item.items.every((entry) => entry === null || pattern(entry, nested + 1));
      return (
        item.tag === 'object' &&
        Array.isArray(item.fields) &&
        item.fields.every(
          (field) => object(field) && typeof field.name === 'string' && pattern(field.pattern, nested + 1),
        )
      );
    };
    switch (statement.tag) {
      case 'variable':
        return typeof statement.name === 'string' && typeof statement.mutable === 'boolean' && expr(statement.value);
      case 'destructure':
        return pattern(statement.pattern) && typeof statement.mutable === 'boolean' && expr(statement.value);
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
    !schema(value.inputType, registry) ||
    !schema(value.resultType, registry) ||
    !sameSchema(value.inputType, { kind: 'ref', type: slot.input }) ||
    !sameSchema(value.resultType, { kind: 'ref', type: slot.output }) ||
    !location(value.source) ||
    typeof value.handler !== 'string' ||
    typeof value.eventParameter !== 'string' ||
    typeof value.contextParameter !== 'string' ||
    !Array.isArray(value.functions) ||
    !object(value.summary) ||
    !Array.isArray(value.summary.operations) ||
    !value.summary.operations.every((operation) => typeof operation === 'string')
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
  if (!names.has(value.handler)) return false;
  const program = value as unknown as StructuredProgram;
  const actions = structuredActions(program);
  return (
    stable([...new Set(actions.map((action) => action.operationId))].sort()) ===
    stable([...program.summary.operations].sort())
  );
}

/** Rejects untrusted artifact IR unless all structured, schema, slot, action, and summary invariants hold. */
export function verifyProgram(
  value: unknown,
  registry: ContractRegistry,
  slot: SlotDefinition,
): VerifiedStructuredProgram | undefined {
  if (!verifyStructuredProgram(value, registry, slot)) return undefined;
  const operationIds = new Set(structuredActions(value as StructuredProgram).map((action) => action.operationId));
  return Object.freeze({
    program: value,
    operations: new Map(
      registry.operations
        .filter((operation) => operationIds.has(operation.id))
        .map((operation) => [operation.id, operation] as const),
    ),
  });
}

export function structuredActions(program: StructuredProgram): readonly StructuredAction[] {
  const actions: StructuredAction[] = [];
  const visitExpression = (item: StructuredExpression): void => {
    if (item.tag === 'action') {
      actions.push(item);
      visitExpression(item.input);
    } else if (item.tag === 'member') visitExpression(item.value);
    else if (item.tag === 'index') {
      visitExpression(item.value);
      visitExpression(item.index);
    } else if (item.tag === 'array')
      item.items.forEach((entry) => visitExpression('spread' in entry ? entry.spread : entry));
    else if (item.tag === 'object')
      item.fields.forEach((field) => visitExpression('spread' in field ? field.spread : field.value));
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
      if (item.tag === 'variable' || item.tag === 'destructure' || item.tag === 'assign') visitExpression(item.value);
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
