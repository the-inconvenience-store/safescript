/**
 * Generates editor-facing TypeScript declarations from a validated host contract.
 * @packageDocumentation
 */
import type { OperationDefinition, Schema, TypeDefinition, TypeId } from '@safescript/contracts';

interface DeclarationNode {
  operation?: OperationDefinition;
  readonly children: Map<string, DeclarationNode>;
}

export function declarationTypeName(id: TypeId): string {
  return String(id)
    .slice(5)
    .split(/[.-]/)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join('');
}

function typeNames(types: readonly TypeDefinition[]): ReadonlyMap<TypeId, string> {
  const names = new Map<TypeId, string>();
  const idsByName = new Map<string, TypeId>();
  for (const type of types) {
    const name = declarationTypeName(type.id);
    if (['Context', 'Effect', 'Result'].includes(name) || idsByName.has(name)) {
      throw new TypeError(`conflicting declaration name ${name}`);
    }
    names.set(type.id, name);
    idsByName.set(name, type.id);
  }
  return names;
}

function typeScriptType(schema: Schema, sourceAuthoring: boolean): string {
  switch (schema.kind) {
    case 'unit':
      return sourceAuthoring ? 'void' : 'null';
    case 'boolean':
      return 'boolean';
    case 'int64':
      return sourceAuthoring ? 'number' : 'bigint';
    case 'float64':
      return 'number';
    case 'string':
      return 'string';
    case 'bytes':
      return 'readonly number[]';
    case 'instant':
      return 'Readonly<{ epochSeconds: bigint; nanoseconds: number }>';
    case 'list':
      return `readonly (${typeScriptType(schema.item, sourceAuthoring)})[]`;
    case 'tuple':
      return `readonly [${schema.items.map((item) => typeScriptType(item, sourceAuthoring)).join(', ')}]`;
    case 'record':
      return `Readonly<{ ${schema.fields.map((field) => `${field.name}: ${typeScriptType(field.schema, sourceAuthoring)}`).join('; ')} }>`;
    case 'variant':
      return schema.variants
        .map(
          (variant) =>
            `Readonly<{ tag: ${JSON.stringify(variant.tag)}; value: ${typeScriptType(variant.schema, sourceAuthoring)} }>`,
        )
        .join(' | ');
    case 'brand':
      return `${typeScriptType(schema.base, sourceAuthoring)} & { readonly __brand: ${JSON.stringify(String(schema.type))} }`;
    case 'ref':
      return declarationTypeName(schema.type);
  }
}

function propertyName(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function hostDeclarations(operations: readonly OperationDefinition[], names: ReadonlyMap<TypeId, string>): string {
  const root: DeclarationNode = { children: new Map() };
  for (const operation of operations) {
    let node = root;
    for (const segment of String(operation.id).slice('operation:'.length).split('.')) {
      if (node.operation) throw new TypeError(`conflicting operation declaration ${operation.id}`);
      const child = node.children.get(segment) ?? { children: new Map() };
      node.children.set(segment, child);
      node = child;
    }
    if (node.operation || node.children.size > 0)
      throw new TypeError(`conflicting operation declaration ${operation.id}`);
    node.operation = operation;
  }
  const render = (node: DeclarationNode): string =>
    [...node.children.entries()]
      .map(([segment, child]) => {
        if (child.operation) {
          const operation = child.operation;
          return `readonly ${propertyName(segment)}: (input: ${names.get(operation.input)}) => Effect<${JSON.stringify(String(operation.effect))}, Result<${names.get(operation.output)}, ${names.get(operation.error)}>>`;
        }
        return `readonly ${propertyName(segment)}: Readonly<{ ${render(child)} }>`;
      })
      .join('; ');
  return [
    'export type Result<T, E> = Readonly<{ tag: "ok"; value: T }> | Readonly<{ tag: "error"; value: E }>;',
    'export type Effect<E extends string, T> = Promise<T> & Readonly<{ readonly __effect?: E }>;',
    `export interface Context { ${render(root)} }`,
  ].join('\n');
}

/**
 * Renders a self-contained editor declaration surface from validated registry definitions.
 *
 * @remarks Name and operation-path collisions fail here rather than producing ambiguous TypeScript for callers.
 * @internal
 */
export function generateDeclarations(
  types: readonly TypeDefinition[],
  operations: readonly OperationDefinition[],
  sourceAuthoring = false,
): string {
  const names = typeNames(types);
  return [
    ...types.map((type) => `export type ${names.get(type.id)} = ${typeScriptType(type.schema, sourceAuthoring)};`),
    hostDeclarations(operations, names),
  ].join('\n');
}
