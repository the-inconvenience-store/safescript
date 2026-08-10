/** Slot-scoped authoring context generated from the same contract registry and language profile used by checking. */
import {
  COMPILER_DIAGNOSTIC_CODES,
  diagnosticRepair,
  languageProfile,
  type ContractRegistry,
  type CompilerDiagnosticCode,
  type CompileLimits,
  type DiagnosticRepair,
  type ExecutionLimits,
  type LanguageProfile,
  type OperationId,
  type Schema,
  type SchemaRegistry,
  type SlotId,
  type TypeId,
} from '@safescript/contracts';

import type { Contract, Operations, Slots } from './contract.js';
import { declarationTypeName, generateDeclarations } from './declarations.js';

export interface AuthoringFile {
  readonly name: string;
  readonly mediaType: 'application/json' | 'text/markdown' | 'text/typescript';
  readonly content: string;
}

export interface AuthoringBundle {
  readonly contract: Readonly<{ id: string; fingerprint: string }>;
  readonly slot: Readonly<{
    name: string;
    id: SlotId;
    input: TypeId;
    output: TypeId;
    operations: readonly OperationId[];
    compileLimits: CompileLimits;
    executionLimits: ExecutionLimits;
  }>;
  readonly profile: LanguageProfile;
  readonly diagnostics: readonly Readonly<{ code: CompilerDiagnosticCode; repair: DiagnosticRepair }>[];
  readonly files: readonly AuthoringFile[];
}

function restrictions(profile: LanguageProfile): string {
  return [
    `# ${profile.name}`,
    '',
    'Write ordinary TypeScript using the supplied declarations. The compiler accepts an explicit deterministic subset.',
    '',
    '## Rules',
    '',
    ...profile.authoringRules.map((rule) => `- ${rule}`),
    '',
    '## Supported patterns',
    '',
    ...profile.accepted.map((rule) => `- ${rule}`),
    '',
    '## Not available',
    '',
    ...profile.rejected.map((rule) => `- ${rule}`),
    '',
    'Compiler diagnostics contain a stable category and repair action. Do not request or depend on private compiler data.',
  ].join('\n');
}

const PRELUDE = `declare module "safescript:prelude" {
  export type Result<T, E> = Readonly<{ tag: "ok"; value: T }> | Readonly<{ tag: "error"; value: E }>;
  export function Ok(): Result<void, never>;
  export function Ok<T>(value: T): Result<T, never>;
  export function Err<E>(error: E): Result<never, E>;
}`;

const GLOBALS = `type SafeScriptJsonError = Readonly<{ code: string }>;
interface JSON {
  parse<T>(text: string): Readonly<{ tag: "ok"; value: T }> | Readonly<{ tag: "error"; value: SafeScriptJsonError }>;
}
declare const JSON: JSON;
interface SafeScriptBytes extends ReadonlyArray<number> {}
declare const Bytes: { fromHex(text: string): SafeScriptBytes };
declare namespace Temporal {
  interface Instant { toString(): string }
  namespace Now { function instant(): Instant }
}`;

const PATTERNS = `// Checked JSON: parsing never returns an unchecked T.
interface ExamplePage { readonly ids: readonly string[] }
function parsePage(text: string): ExamplePage {
  const parsed = JSON.parse<ExamplePage>(text)
  switch (parsed.tag) {
    case "ok": return parsed.value
    case "error": return { ids: [] }
  }
}

// Immutable recursion and deterministic intrinsics.
interface ExampleNode { readonly id: string; readonly children: readonly ExampleNode[] }
function contains(node: ExampleNode, wanted: string): boolean {
  return node.id === wanted || node.children.some((child) => contains(child, wanted))
}
function observeDevice(): void {
  const packet = Bytes.fromHex("0307")
  const header = packet[0]
  const now = Temporal.Now.instant()
  const sample = Math.random()
  console.info("device", { header: header, now: now, sample: sample })
}`;

function resolve(schema: Schema, registry: SchemaRegistry, seen = new Set<TypeId>()): Schema {
  if (schema.kind !== 'ref') return schema;
  if (seen.has(schema.type)) return schema;
  const target = registry.types.find((candidate) => candidate.id === schema.type)?.schema;
  return target ? resolve(target, registry, new Set(seen).add(schema.type)) : schema;
}

function resultError(output: TypeId, registry: SchemaRegistry): TypeId | undefined {
  const schema = resolve({ kind: 'ref', type: output }, registry);
  if (schema.kind !== 'variant') return undefined;
  const ok = schema.variants.find((variant) => variant.tag === 'ok');
  const error = schema.variants.find((variant) => variant.tag === 'error');
  if (!ok || resolve(ok.schema, registry).kind !== 'unit' || error?.schema.kind !== 'ref') return undefined;
  return error.schema.type;
}

function example(input: TypeId, output: TypeId, registry: SchemaRegistry): string {
  const error = resultError(output, registry);
  if (error)
    return `import { Ok, type Result } from "safescript:prelude"
import { type Context, type ${declarationTypeName(input)}, type ${declarationTypeName(error)} } from "host:api"

export async function handle(
  event: ${declarationTypeName(input)},
  ctx: Context,
): Promise<Result<void, ${declarationTypeName(error)}>> {
  console.info("received", event)
  // Call only operations declared on ctx, await each action, and exhaustively handle its Result.
  return Ok()
}`;
  if (input === output)
    return `import { type Context, type ${declarationTypeName(input)} } from "host:api"

export async function handle(event: ${declarationTypeName(input)}, ctx: Context): Promise<${declarationTypeName(output)}> {
  console.info("received", event)
  return event
}`;
  return `import { type ${declarationTypeName(input)}, type ${declarationTypeName(output)} } from "host:api"

// Hosts with a non-Result output supply a scenario-specific handler example.
// Produce ${declarationTypeName(output)} only from typed input or an exhaustively handled host Result.
export function inspectInput(event: ${declarationTypeName(input)}): ${declarationTypeName(input)} {
  return event
}`;
}

function freeze<T>(root: T): T {
  if (root === null || typeof root !== 'object') return root;
  for (const value of Object.values(root)) freeze(value);
  return Object.freeze(root);
}

/** Generates one deterministic bundle for a named slot on an already validated contract. */
export function createAuthoringBundle<O extends Operations, S extends Slots, K extends keyof S>(
  contract: Contract<O, S>,
  slotName: K,
): AuthoringBundle {
  const configuredSlot = contract.slots[slotName];
  if (!configuredSlot) throw new TypeError(`unknown slot ${String(slotName)}`);
  return createRegistryAuthoringBundle(contract.registry, configuredSlot.id, String(slotName));
}

/** Generates the same bundle directly from a transport-neutral validated registry. */
export function createRegistryAuthoringBundle(
  registry: ContractRegistry,
  slotId: SlotId,
  slotName = String(slotId).slice('slot:'.length),
): AuthoringBundle {
  const slot = registry.slots.find((candidate) => candidate.id === slotId);
  if (!slot) throw new TypeError(`unknown slot ${slotId}`);
  const profile = languageProfile();
  const allowedOperations = new Set(slot.operations);
  const operations = registry.operations.filter((operation) => allowedOperations.has(operation.id));
  const declarations = generateDeclarations(registry.schemas.types, operations, true);
  const context = {
    contract: { id: registry.id, fingerprint: registry.digest },
    slot: {
      name: slotName,
      id: slot.id,
      input: slot.input,
      output: slot.output,
      operations: slot.operations,
      compileLimits: slot.compileLimits,
      executionLimits: slot.executionLimits,
    },
  };
  const diagnostics = COMPILER_DIAGNOSTIC_CODES.filter((code) => code !== 'SS_INTERNAL_IR_INVALID').map((code) => ({
    code,
    repair: diagnosticRepair(code),
  }));
  return freeze({
    contract: context.contract,
    slot: context.slot,
    profile,
    diagnostics,
    files: [
      {
        name: 'host-api.d.ts',
        mediaType: 'text/typescript',
        content: `declare module "host:api" {\n${declarations}\n}`,
      },
      { name: 'safescript-prelude.d.ts', mediaType: 'text/typescript', content: PRELUDE },
      { name: 'safescript-globals.d.ts', mediaType: 'text/typescript', content: GLOBALS },
      { name: 'slot.json', mediaType: 'application/json', content: JSON.stringify(context, null, 2) },
      { name: 'restrictions.md', mediaType: 'text/markdown', content: restrictions(profile) },
      {
        name: 'example.ts',
        mediaType: 'text/typescript',
        content: example(slot.input, slot.output, registry.schemas),
      },
      { name: 'patterns.ts', mediaType: 'text/typescript', content: PATTERNS },
    ],
  });
}
