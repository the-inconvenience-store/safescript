/**
 * Typed SafeScript IR records, schema helpers, and structural verifier.
 * @packageDocumentation
 */
import {
  encodeCanonical,
  ids,
  resultSchema,
  type ActionSiteId,
  type CanonicalValue,
  type ContractRegistry,
  type OperationDefinition,
  type ProgramSummary,
  type Schema,
  type SlotDefinition,
  type SourceLocation,
} from '@safescript/contracts';

/**
 * Private single-assignment register identity within one IR program.
 * @internal
 */
export type RegisterId = string;
/**
 * Private basic-block identity within one IR program.
 * @internal
 */
export type BlockId = string;

/**
 * Closed instruction set for pure value computation. Host effects are terminators, never instructions.
 * @internal
 */
export type IrInstruction =
  | Readonly<{
      tag: 'constant';
      destination: RegisterId;
      type: Schema;
      value: null | boolean | number | string;
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'project-field';
      destination: RegisterId;
      type: Schema;
      from: RegisterId;
      field: string;
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'compare';
      destination: RegisterId;
      type: Readonly<{ kind: 'boolean' }>;
      operator: 'equal' | 'not-equal' | 'less' | 'less-equal' | 'greater' | 'greater-equal';
      left: RegisterId;
      right: RegisterId;
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'construct-record';
      destination: RegisterId;
      type: Schema;
      fields: readonly (readonly [string, RegisterId])[];
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'construct-variant';
      destination: RegisterId;
      type: Schema;
      variant: string;
      payload: RegisterId;
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'build-template';
      destination: RegisterId;
      type: Schema;
      parts: readonly (string | Readonly<{ register: RegisterId }>)[];
      source: SourceLocation;
    }>;

/**
 * Closed control-flow operations, including the sole host-action suspension point.
 * @internal
 */
export type IrTerminator =
  | Readonly<{ tag: 'jump'; target: BlockId; arguments: readonly RegisterId[]; source: SourceLocation }>
  | Readonly<{ tag: 'branch'; condition: RegisterId; whenTrue: BlockId; whenFalse: BlockId; source: SourceLocation }>
  | Readonly<{
      tag: 'switch';
      value: RegisterId;
      cases: readonly Readonly<{ variant: string; target: BlockId }>[];
      source: SourceLocation;
    }>
  | Readonly<{
      tag: 'action';
      operationId: OperationDefinition['id'];
      effectId: OperationDefinition['effect'];
      capabilityId: OperationDefinition['capability'];
      actionSiteId: ActionSiteId;
      input: RegisterId;
      inputType: Schema;
      resultType: Schema;
      resume: BlockId;
      source: SourceLocation;
    }>
  | Readonly<{ tag: 'return'; value: RegisterId; source: SourceLocation }>;

/**
 * Basic block with typed parameters, straight-line instructions, and exactly one terminator.
 * @internal
 */
export interface IrBlock {
  readonly id: BlockId;
  readonly parameters: readonly Readonly<{ register: RegisterId; type: Schema }>[];
  readonly instructions: readonly IrInstruction[];
  readonly terminator: IrTerminator;
}

/**
 * Serialisable typed control-flow program emitted by the restricted compiler.
 * @internal
 */
export interface IrProgram {
  readonly version: readonly [1, 0];
  readonly entry: BlockId;
  readonly input: Readonly<{ register: RegisterId; type: Schema }>;
  readonly resultType: Schema;
  readonly blocks: readonly IrBlock[];
  readonly summary: ProgramSummary;
}

/**
 * IR plus lookup maps proven consistent with the current contract and slot.
 * @internal
 */
export interface VerifiedProgram {
  readonly program: IrProgram;
  readonly blocks: ReadonlyMap<BlockId, IrBlock>;
  readonly operations: ReadonlyMap<OperationDefinition['id'], OperationDefinition>;
}

function stable(value: unknown): string {
  if (typeof value === 'bigint') return `{"$bigint":${JSON.stringify(String(value))}}`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compares schema identity structurally without JavaScript object identity.
 * @internal
 */
export function sameType(left: Schema, right: Schema): boolean {
  return stable(left) === stable(right);
}

/**
 * Resolves named schema references while rejecting missing or cyclic alias chains.
 * @internal
 */
export function resolveSchema(
  schema: Schema,
  registry: ContractRegistry,
  seen = new Set<string>(),
): Schema | undefined {
  if (schema.kind !== 'ref') return schema;
  if (seen.has(schema.type)) return undefined;
  const definition = registry.schemas.types.find((candidate) => candidate.id === schema.type);
  return definition ? resolveSchema(definition.schema, registry, new Set(seen).add(schema.type)) : undefined;
}

/**
 * Returns a closed record field's schema after reference resolution.
 * @internal
 */
export function fieldType(schema: Schema, field: string, registry: ContractRegistry): Schema | undefined {
  const resolved = resolveSchema(schema, registry);
  if (resolved?.kind === 'record') return resolved.fields.find((candidate) => candidate.name === field)?.schema;
  if (resolved?.kind === 'variant' && field === 'tag') return { kind: 'string' };
  return undefined;
}

/**
 * Returns a closed variant payload schema after reference resolution.
 * @internal
 */
export function variantType(schema: Schema, tag: string, registry: ContractRegistry): Schema | undefined {
  const resolved = resolveSchema(schema, registry);
  return resolved?.kind === 'variant'
    ? resolved.variants.find((candidate) => candidate.tag === tag)?.schema
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaIsValid(schema: unknown, registry: ContractRegistry, depth = 0): schema is Schema {
  if (!isObject(schema) || typeof schema.kind !== 'string' || depth > 128) return false;
  switch (schema.kind) {
    case 'unit':
    case 'boolean':
      return Object.keys(schema).length === 1;
    case 'int64':
      return (
        (schema.minimum === undefined || typeof schema.minimum === 'bigint') &&
        (schema.maximum === undefined || typeof schema.maximum === 'bigint')
      );
    case 'float64':
      return (
        (schema.minimum === undefined || typeof schema.minimum === 'number') &&
        (schema.maximum === undefined || typeof schema.maximum === 'number')
      );
    case 'string':
    case 'bytes':
      return schema.maxBytes === undefined || (Number.isSafeInteger(schema.maxBytes) && Number(schema.maxBytes) >= 0);
    case 'instant':
      return true;
    case 'list':
      return (
        schemaIsValid(schema.item, registry, depth + 1) &&
        (schema.maxItems === undefined || (Number.isSafeInteger(schema.maxItems) && Number(schema.maxItems) >= 0))
      );
    case 'tuple':
      return Array.isArray(schema.items) && schema.items.every((item) => schemaIsValid(item, registry, depth + 1));
    case 'record':
      return (
        Array.isArray(schema.fields) &&
        new Set(schema.fields.map((field) => (isObject(field) ? field.name : undefined))).size ===
          schema.fields.length &&
        schema.fields.every(
          (field) =>
            isObject(field) && typeof field.name === 'string' && schemaIsValid(field.schema, registry, depth + 1),
        )
      );
    case 'variant':
      return (
        Array.isArray(schema.variants) &&
        new Set(schema.variants.map((variant) => (isObject(variant) ? variant.tag : undefined))).size ===
          schema.variants.length &&
        schema.variants.every(
          (variant) =>
            isObject(variant) && typeof variant.tag === 'string' && schemaIsValid(variant.schema, registry, depth + 1),
        )
      );
    case 'brand':
      return (
        typeof schema.type === 'string' &&
        registry.schemas.types.some((definition) => definition.id === schema.type) &&
        schemaIsValid(schema.base, registry, depth + 1)
      );
    case 'ref':
      return (
        typeof schema.type === 'string' && registry.schemas.types.some((definition) => definition.id === schema.type)
      );
    default:
      return false;
  }
}

function isLocation(value: unknown): value is SourceLocation {
  return (
    isObject(value) &&
    typeof value.module === 'string' &&
    Number.isSafeInteger(value.start) &&
    Number.isSafeInteger(value.end) &&
    Number(value.start) >= 0 &&
    Number(value.end) >= Number(value.start)
  );
}

function registersUsed(instruction: IrInstruction | IrTerminator): readonly RegisterId[] {
  switch (instruction.tag) {
    case 'constant':
      return [];
    case 'project-field':
      return [instruction.from];
    case 'compare':
      return [instruction.left, instruction.right];
    case 'construct-record':
      return instruction.fields.map(([, register]) => register);
    case 'construct-variant':
      return [instruction.payload];
    case 'build-template':
      return instruction.parts.flatMap((part) => (typeof part === 'string' ? [] : [part.register]));
    case 'jump':
      return instruction.arguments;
    case 'branch':
      return [instruction.condition];
    case 'switch':
      return [instruction.value];
    case 'action':
      return [instruction.input];
    case 'return':
      return [instruction.value];
  }
}

function instructionShape(value: unknown): value is IrInstruction {
  if (
    !isObject(value) ||
    typeof value.tag !== 'string' ||
    typeof value.destination !== 'string' ||
    !isObject(value.type) ||
    !isLocation(value.source)
  )
    return false;
  switch (value.tag) {
    case 'constant':
      return value.value === null || ['boolean', 'number', 'string'].includes(typeof value.value);
    case 'project-field':
      return typeof value.from === 'string' && typeof value.field === 'string';
    case 'compare':
      return (
        typeof value.left === 'string' &&
        typeof value.right === 'string' &&
        ['equal', 'not-equal', 'less', 'less-equal', 'greater', 'greater-equal'].includes(String(value.operator))
      );
    case 'construct-record':
      return (
        Array.isArray(value.fields) &&
        value.fields.every(
          (field) =>
            Array.isArray(field) && field.length === 2 && typeof field[0] === 'string' && typeof field[1] === 'string',
        )
      );
    case 'construct-variant':
      return typeof value.variant === 'string' && typeof value.payload === 'string';
    case 'build-template':
      return (
        Array.isArray(value.parts) &&
        value.parts.every((part) => typeof part === 'string' || (isObject(part) && typeof part.register === 'string'))
      );
    default:
      return false;
  }
}

function terminatorShape(value: unknown): value is IrTerminator {
  if (!isObject(value) || typeof value.tag !== 'string' || !isLocation(value.source)) return false;
  switch (value.tag) {
    case 'jump':
      return (
        typeof value.target === 'string' &&
        Array.isArray(value.arguments) &&
        value.arguments.every((item) => typeof item === 'string')
      );
    case 'branch':
      return (
        typeof value.condition === 'string' && typeof value.whenTrue === 'string' && typeof value.whenFalse === 'string'
      );
    case 'switch':
      return (
        typeof value.value === 'string' &&
        Array.isArray(value.cases) &&
        value.cases.every(
          (item) => isObject(item) && typeof item.variant === 'string' && typeof item.target === 'string',
        )
      );
    case 'action':
      return (
        typeof value.operationId === 'string' &&
        typeof value.effectId === 'string' &&
        typeof value.capabilityId === 'string' &&
        typeof value.actionSiteId === 'string' &&
        typeof value.input === 'string' &&
        isObject(value.inputType) &&
        isObject(value.resultType) &&
        typeof value.resume === 'string'
      );
    case 'return':
      return typeof value.value === 'string';
    default:
      return false;
  }
}

function programShape(value: unknown): value is IrProgram {
  return (
    isObject(value) &&
    Array.isArray(value.version) &&
    value.version[0] === 1 &&
    value.version[1] === 0 &&
    value.version.length === 2 &&
    typeof value.entry === 'string' &&
    isObject(value.input) &&
    typeof value.input.register === 'string' &&
    isObject(value.input.type) &&
    isObject(value.resultType) &&
    Array.isArray(value.blocks) &&
    isObject(value.summary) &&
    Array.isArray(value.summary.effects) &&
    Array.isArray(value.summary.capabilities) &&
    value.blocks.every(
      (block) =>
        isObject(block) &&
        typeof block.id === 'string' &&
        Array.isArray(block.parameters) &&
        block.parameters.every(
          (parameter) => isObject(parameter) && typeof parameter.register === 'string' && isObject(parameter.type),
        ) &&
        Array.isArray(block.instructions) &&
        block.instructions.every(instructionShape) &&
        terminatorShape(block.terminator),
    )
  );
}

function successors(terminator: IrTerminator): readonly BlockId[] {
  switch (terminator.tag) {
    case 'jump':
      return [terminator.target];
    case 'branch':
      return [terminator.whenTrue, terminator.whenFalse];
    case 'switch':
      return terminator.cases.map((item) => item.target);
    case 'action':
      return [terminator.resume];
    case 'return':
      return [];
  }
}

/**
 * Verifies untrusted decoded IR before it can be interpreted.
 *
 * @remarks Verification checks IDs, schema references, register definitions, control-flow arity and types, action
 * permissions, and reachable block structure. The interpreter accepts only the resulting {@link VerifiedProgram}.
 * @internal
 */
export function verifyProgram(
  value: unknown,
  registry: ContractRegistry,
  slot: SlotDefinition,
): VerifiedProgram | undefined {
  if (!programShape(value) || value.blocks.length === 0) return undefined;
  const blocks = new Map(value.blocks.map((block) => [block.id, block] as const));
  if (
    blocks.size !== value.blocks.length ||
    !blocks.has(value.entry) ||
    value.summary.effects.some((effect) => typeof effect !== 'string') ||
    value.summary.capabilities.some((capability) => typeof capability !== 'string') ||
    !schemaIsValid(value.input.type, registry) ||
    !schemaIsValid(value.resultType, registry) ||
    !sameType(value.input.type, { kind: 'ref', type: slot.input }) ||
    !sameType(value.resultType, { kind: 'ref', type: slot.output }) ||
    blocks.get(value.entry)?.parameters.length !== 0
  )
    return undefined;
  const operations = new Map(registry.operations.map((operation) => [operation.id, operation] as const));
  const definitions = new Map<RegisterId, Readonly<{ block: BlockId; index: number; type: Schema }>>();
  definitions.set(value.input.register, { block: value.entry, index: -2, type: value.input.type });
  for (const block of value.blocks) {
    for (const parameter of block.parameters) {
      if (definitions.has(parameter.register) || !schemaIsValid(parameter.type, registry)) return undefined;
      definitions.set(parameter.register, { block: block.id, index: -1, type: parameter.type });
    }
    for (const [index, instruction] of block.instructions.entries()) {
      if (definitions.has(instruction.destination) || !schemaIsValid(instruction.type, registry)) return undefined;
      definitions.set(instruction.destination, { block: block.id, index, type: instruction.type });
    }
    if (successors(block.terminator).some((target) => !blocks.has(target))) return undefined;
  }

  const visiting = new Set<BlockId>();
  const visited = new Set<BlockId>();
  const visit = (id: BlockId): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    const block = blocks.get(id);
    if (!block || successors(block.terminator).some((target) => !visit(target))) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  if (!visit(value.entry) || visited.size !== blocks.size) return undefined;

  const predecessors = new Map<BlockId, Set<BlockId>>(value.blocks.map((block) => [block.id, new Set()]));
  for (const block of value.blocks)
    for (const target of successors(block.terminator)) predecessors.get(target)?.add(block.id);
  const all = new Set(blocks.keys());
  const dominators = new Map<BlockId, Set<BlockId>>(
    value.blocks.map((block) => [block.id, block.id === value.entry ? new Set([block.id]) : new Set(all)]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of value.blocks) {
      if (block.id === value.entry) continue;
      const incoming = [...(predecessors.get(block.id) ?? [])];
      const intersection =
        incoming.length === 0
          ? new Set<BlockId>()
          : new Set([...all].filter((id) => incoming.every((parent) => dominators.get(parent)?.has(id))));
      intersection.add(block.id);
      const prior = dominators.get(block.id) as Set<BlockId>;
      if (prior.size !== intersection.size || [...prior].some((id) => !intersection.has(id))) {
        dominators.set(block.id, intersection);
        changed = true;
      }
    }
  }

  const useIsValid = (register: RegisterId, block: IrBlock, index: number): boolean => {
    const definition = definitions.get(register);
    return (
      !!definition &&
      (definition.block === block.id
        ? definition.index < index
        : dominators.get(block.id)?.has(definition.block) === true)
    );
  };
  const typeOf = (register: RegisterId): Schema | undefined => definitions.get(register)?.type;
  const effects = new Set<string>();
  const capabilities = new Set<string>();
  for (const block of value.blocks) {
    for (const [index, instruction] of block.instructions.entries()) {
      if (registersUsed(instruction).some((register) => !useIsValid(register, block, index))) return undefined;
      if (instruction.tag === 'project-field') {
        const projected = fieldType(typeOf(instruction.from) as Schema, instruction.field, registry);
        if (!projected || !sameType(projected, instruction.type)) return undefined;
      } else if (instruction.tag === 'compare') {
        const left = typeOf(instruction.left);
        const right = typeOf(instruction.right);
        const resolved = left && resolveSchema(left, registry);
        if (
          !left ||
          !right ||
          !sameType(left, right) ||
          (!['equal', 'not-equal'].includes(instruction.operator) &&
            resolved?.kind !== 'int64' &&
            resolved?.kind !== 'float64')
        )
          return undefined;
      } else if (instruction.tag === 'constant') {
        let constant: CanonicalValue;
        try {
          constant = constantValue(instruction);
        } catch {
          return undefined;
        }
        if (!encodeCanonical(instruction.type, constant, { registry: registry.schemas }).ok) return undefined;
      } else if (instruction.tag === 'construct-record') {
        const resolved = resolveSchema(instruction.type, registry);
        if (
          resolved?.kind !== 'record' ||
          resolved.fields.length !== instruction.fields.length ||
          resolved.fields.some(
            (field, fieldIndex) =>
              field.name !== instruction.fields[fieldIndex]?.[0] ||
              !sameType(field.schema, typeOf(instruction.fields[fieldIndex]?.[1] ?? '') as Schema),
          )
        )
          return undefined;
      } else if (instruction.tag === 'construct-variant') {
        const payload = variantType(instruction.type, instruction.variant, registry);
        if (!payload || !sameType(payload, typeOf(instruction.payload) as Schema)) return undefined;
      } else if (instruction.tag === 'build-template' && resolveSchema(instruction.type, registry)?.kind !== 'string')
        return undefined;
    }
    if (registersUsed(block.terminator).some((register) => !useIsValid(register, block, block.instructions.length)))
      return undefined;
    if (
      block.terminator.tag === 'branch' &&
      resolveSchema(typeOf(block.terminator.condition) as Schema, registry)?.kind !== 'boolean'
    )
      return undefined;
    if (
      block.terminator.tag === 'branch' &&
      ((blocks.get(block.terminator.whenTrue)?.parameters.length ?? -1) !== 0 ||
        (blocks.get(block.terminator.whenFalse)?.parameters.length ?? -1) !== 0)
    )
      return undefined;
    if (block.terminator.tag === 'jump') {
      const terminator = block.terminator;
      const target = blocks.get(terminator.target) as IrBlock;
      if (
        target.parameters.length !== terminator.arguments.length ||
        target.parameters.some(
          (parameter, index) => !sameType(parameter.type, typeOf(terminator.arguments[index] ?? '') as Schema),
        )
      )
        return undefined;
    }
    if (block.terminator.tag === 'switch') {
      const terminator = block.terminator;
      const union = resolveSchema(typeOf(terminator.value) as Schema, registry);
      if (
        union?.kind !== 'variant' ||
        new Set(terminator.cases.map((item) => item.variant)).size !== union.variants.length ||
        union.variants.some((variant) => !terminator.cases.some((item) => item.variant === variant.tag))
      )
        return undefined;
      for (const item of terminator.cases) {
        const target = blocks.get(item.target) as IrBlock;
        const payload = union.variants.find((variant) => variant.tag === item.variant)?.schema;
        if (!payload || target.parameters.length !== 1 || !sameType(target.parameters[0]?.type as Schema, payload))
          return undefined;
      }
    }
    if (block.terminator.tag === 'action') {
      const action = block.terminator;
      const operation = operations.get(action.operationId);
      const resume = blocks.get(action.resume) as IrBlock;
      if (
        !operation ||
        operation.effect !== action.effectId ||
        operation.capability !== action.capabilityId ||
        !slot.effects.includes(action.effectId) ||
        !slot.capabilities.includes(action.capabilityId) ||
        !sameType(action.inputType, { kind: 'ref', type: operation.input }) ||
        !sameType(
          action.resultType,
          resultSchema({ kind: 'ref', type: operation.output }, { kind: 'ref', type: operation.error }),
        ) ||
        !sameType(typeOf(action.input) as Schema, action.inputType) ||
        resume.parameters.length !== 1 ||
        !sameType(resume.parameters[0]?.type as Schema, action.resultType)
      )
        return undefined;
      try {
        ids.actionSite(action.actionSiteId);
      } catch {
        return undefined;
      }
      effects.add(action.effectId);
      capabilities.add(action.capabilityId);
    }
    if (block.terminator.tag === 'return' && !sameType(typeOf(block.terminator.value) as Schema, value.resultType))
      return undefined;
  }
  if (
    stable([...effects].sort()) !== stable([...value.summary.effects].sort()) ||
    stable([...capabilities].sort()) !== stable([...value.summary.capabilities].sort())
  )
    return undefined;
  return Object.freeze({ program: value, blocks, operations });
}

/**
 * Materialises a verifier-approved IR constant in its canonical runtime representation.
 * @internal
 */
export function constantValue(instruction: Extract<IrInstruction, { tag: 'constant' }>): CanonicalValue {
  const resolved = instruction.type.kind === 'brand' ? instruction.type.base : instruction.type;
  return resolved.kind === 'int64' ? BigInt(instruction.value as string) : instruction.value;
}
