#!/usr/bin/env node
/**
 * Thin offline command adapter for the public SafeScript TypeScript SDK.
 * @packageDocumentation
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ContractDefinitionError,
  SdkConfigurationError,
  createSafeScript,
  defineContract,
  type CompileLimits,
  type ContractDefinition,
  type ContractType,
  type ExecutionLimits,
  type InstantValue,
  type InvocationId,
  type ModuleId,
  type Program,
  type Schema,
  type ScriptedAction,
  type SourceProgram,
  type TestExpectation,
} from '@safescript/sdk';

/** Successful command, program failure, and CLI/bridge misuse exit statuses. */
export const EXIT = Object.freeze({ ok: 0, program: 1, usage: 2 } as const);

type Command = 'check' | 'inspect' | 'execute' | 'test';
type JsonObject = Record<string, unknown>;

interface CliIo {
  readStdin(): Promise<string>;
  readFile(path: string): Promise<string>;
  writeStdout(text: string): Promise<void>;
  writeStderr(text: string): Promise<void>;
  writeFile(path: string, text: string): Promise<void>;
}

interface ParsedArguments {
  readonly command: Command;
  readonly contract: string;
  readonly input: string;
  readonly output: string;
}

interface CliContractOperation {
  readonly id: string;
  readonly input: string;
  readonly output: string;
  readonly error: string;
  readonly effectCost: number;
}

interface CliContractSlot {
  readonly id: string;
  readonly input: string;
  readonly output: string;
  readonly operations: readonly string[];
  readonly compileLimits?: Partial<CompileLimits>;
  readonly executionLimits?: Partial<ExecutionLimits>;
}

interface CliContract {
  readonly id: string;
  readonly version: Readonly<{ major: number; minor: number; patch: number; prerelease?: string }>;
  readonly types: readonly Readonly<{ id: string; schema: Schema }>[];
  readonly operations: Readonly<Record<string, CliContractOperation>>;
  readonly slots: Readonly<Record<string, CliContractSlot>>;
}

const usage =
  'usage: safescript <check|inspect|execute|test> --contract <file|-> [--input <file|->] [--output <file|->]';

const defaultIo: CliIo = {
  readStdin: async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    return Buffer.concat(chunks).toString('utf8');
  },
  readFile: (path) => readFile(path, 'utf8'),
  writeStdout: (text) =>
    new Promise((resolveWrite, reject) =>
      process.stdout.write(text, (error) => (error ? reject(error) : resolveWrite())),
    ),
  writeStderr: (text) =>
    new Promise((resolveWrite, reject) =>
      process.stderr.write(text, (error) => (error ? reject(error) : resolveWrite())),
    ),
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
};

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

function object(value: unknown, name: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new CliError('invalid_input', `${name} must be an object`);
  return value as JsonObject;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new CliError('invalid_input', `${name} must be a non-empty string`);
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new CliError('invalid_input', `${name} must be a string`);
  return value;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const command = args[0];
  if (command !== 'check' && command !== 'inspect' && command !== 'execute' && command !== 'test') {
    throw new CliError('usage', usage);
  }
  let contract: string | undefined;
  let input = '-';
  let output = '-';
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new CliError('usage', usage);
    if (flag === '--contract') contract = value;
    else if (flag === '--input') input = value;
    else if (flag === '--output') output = value;
    else throw new CliError('usage', `unknown option ${flag ?? ''}; ${usage}`);
  }
  if (!contract) throw new CliError('usage', `--contract is required; ${usage}`);
  if (contract === '-' && input === '-') {
    throw new CliError('usage', 'contract and request cannot both use standard input');
  }
  return { command, contract, input, output };
}

function decodeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeJsonValue);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as JsonObject;
  if (Object.keys(record).length === 1 && typeof record.$bigint === 'string') return BigInt(record.$bigint);
  if (Object.keys(record).length === 1 && typeof record.$bytes === 'string') {
    return Uint8Array.from(Buffer.from(record.$bytes, 'base64'));
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodeJsonValue(item)]));
}

function encodeJsonValue(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return { $bigint: String(value) };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  return value;
}

function parseJson(text: string, name: string): unknown {
  try {
    return decodeJsonValue(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('invalid_json', `${name} is not valid SafeScript JSON`);
  }
}

async function readInput(path: string, name: string, io: CliIo): Promise<unknown> {
  try {
    return parseJson(path === '-' ? await io.readStdin() : await io.readFile(path), name);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('read_failed', `could not read ${name}`);
  }
}

function asContract(value: unknown): CliContract {
  const input = object(value, 'contract');
  if (!Array.isArray(input.types)) throw new CliError('invalid_contract', 'contract.types must be an array');
  object(input.operations, 'contract.operations');
  object(input.slots, 'contract.slots');
  return input as unknown as CliContract;
}

function buildContract(input: CliContract) {
  const types = new Map<string, ContractType<unknown>>(
    input.types.map((type) => [type.id, { id: type.id as ContractType<unknown>['id'], schema: type.schema }]),
  );
  const type = (id: string): ContractType<unknown> => {
    const found = types.get(id);
    if (!found) throw new CliError('invalid_contract', `unknown contract type ${id}`);
    return found;
  };
  const operations = Object.fromEntries(
    Object.entries(input.operations).map(([name, operation]) => [
      name,
      {
        ...operation,
        input: type(operation.input),
        output: type(operation.output),
        error: type(operation.error),
      },
    ]),
  );
  const slots = Object.fromEntries(
    Object.entries(input.slots).map(([name, slot]) => [
      name,
      { ...slot, input: type(slot.input), output: type(slot.output) },
    ]),
  );
  return defineContract({
    id: input.id,
    version: input.version,
    types: [...types.values()],
    operations,
    slots,
  } as unknown as ContractDefinition<never, never>);
}

function source(value: unknown): SourceProgram {
  const input = object(value, 'request.source');
  const modules = input.modules;
  if (!Array.isArray(modules)) throw new CliError('invalid_input', 'request.source.modules must be an array');
  return {
    entryModule: string(input.entryModule, 'request.source.entryModule') as ModuleId,
    modules: modules.map((item, index) => {
      const module = object(item, `request.source.modules[${index}]`);
      return {
        id: string(module.id, `request.source.modules[${index}].id`) as ModuleId,
        source: text(module.source, `request.source.modules[${index}].source`),
      };
    }),
  };
}

function program(value: unknown): Program {
  const input = object(value, 'request.program');
  if (input.kind === 'source') return { kind: 'source', source: source(input.source) };
  if (input.kind === 'artifact' && (input.bytes instanceof Uint8Array || Array.isArray(input.bytes))) {
    return { kind: 'artifact', bytes: Uint8Array.from(input.bytes as ArrayLike<number>) };
  }
  throw new CliError('invalid_input', 'request.program must be a source or artifact program');
}

function scripts(value: unknown): readonly ScriptedAction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CliError('invalid_input', 'request.actions must be an array');
  return value as readonly ScriptedAction[];
}

function comparable(value: unknown): string {
  return JSON.stringify(value, encodeJsonValue);
}

function createFacade(contract: ReturnType<typeof buildContract>, actionScripts: readonly ScriptedAction[] = []) {
  let actionIndex = 0;
  const operations = contract.operations as unknown as Readonly<Record<string, Readonly<{ id: string }>>>;
  const handlers = Object.fromEntries(
    Object.keys(operations).map((name) => [
      name,
      (input: unknown) => {
        const script = actionScripts[actionIndex++];
        const operation = operations[name];
        if (
          !script ||
          !operation ||
          (script.operation !== name && script.operation !== operation.id) ||
          comparable(script.input) !== comparable(input)
        ) {
          return { status: 'failed', effectState: 'not_performed', failure: { code: 'gateway_fault' } } as const;
        }
        return script.outcome;
      },
    ]),
  );
  return createSafeScript({
    contract,
    handlers: handlers as never,
  });
}

function statusFor(command: Command, result: unknown): number {
  const record = object(result, 'result');
  if (record.status === 'bridge_error') return EXIT.usage;
  if (command === 'check' || command === 'inspect') return record.status === 'accepted' ? EXIT.ok : EXIT.program;
  if (command === 'execute') return record.status === 'completed' ? EXIT.ok : EXIT.program;
  return record.passed === true ? EXIT.ok : EXIT.program;
}

async function perform(command: Command, contractValue: unknown, requestValue: unknown): Promise<unknown> {
  const contract = buildContract(asContract(contractValue));
  const request = object(requestValue, 'request');
  const actionScripts = command === 'execute' ? scripts(request.actions) : [];
  const safe = createFacade(contract, actionScripts);
  try {
    if (command === 'check') {
      return await safe.check({
        slot: string(request.slot, 'request.slot') as never,
        source: source(request.source),
        ...(request.limits === undefined ? {} : { limits: object(request.limits, 'request.limits') }),
      });
    }
    if (command === 'inspect') {
      if (!Array.isArray(request.views)) throw new CliError('invalid_input', 'request.views must be an array');
      return await safe.inspect({
        slot: string(request.slot, 'request.slot') as never,
        source: source(request.source),
        views: request.views as never,
        ...(request.limits === undefined ? {} : { limits: object(request.limits, 'request.limits') }),
        ...(request.graphLimits === undefined
          ? {}
          : { graphLimits: object(request.graphLimits, 'request.graphLimits') as never }),
      });
    }
    const executionProgram = program(request.program);
    const fixed = {
      ...(request.fixedInstant === undefined ? {} : { instant: request.fixedInstant as InstantValue }),
      ...(request.randomSeed === undefined ? {} : { randomSeed: request.randomSeed as Uint8Array }),
      ...(request.invocationId === undefined ? {} : { invocationId: request.invocationId as InvocationId }),
    };
    if (command === 'test') {
      return await safe.test({
        name: string(request.name, 'request.name'),
        slot: string(request.slot, 'request.slot') as never,
        program: executionProgram,
        input: request.input as never,
        actions: scripts(request.actions) as never,
        fixed,
        ...(request.expect === undefined ? {} : { expect: request.expect as TestExpectation<unknown> }),
      });
    }
    return await safe.execute({
      slot: string(request.slot, 'request.slot') as never,
      program: executionProgram,
      input: request.input as never,
      context: undefined as never,
      ...(request.invocationId === undefined ? {} : { invocationId: request.invocationId as InvocationId }),
      ...(request.fixedInstant === undefined ? {} : { fixedInstant: request.fixedInstant as InstantValue }),
      ...(request.randomSeed === undefined ? {} : { randomSeed: request.randomSeed as Uint8Array }),
      ...(request.limits === undefined ? {} : { limits: object(request.limits, 'request.limits') }),
      ...(request.trace === undefined ? {} : { trace: request.trace as boolean }),
    });
  } finally {
    await safe.close();
  }
}

function errorRecord(error: unknown): Readonly<{ status: 'cli_error'; error: { code: string; message: string } }> {
  if (error instanceof CliError) return { status: 'cli_error', error: { code: error.code, message: error.message } };
  if (error instanceof ContractDefinitionError) {
    return { status: 'cli_error', error: { code: 'invalid_contract', message: error.message } };
  }
  if (error instanceof SdkConfigurationError) {
    return { status: 'cli_error', error: { code: 'invalid_configuration', message: error.message } };
  }
  return { status: 'cli_error', error: { code: 'internal_error', message: 'CLI operation failed' } };
}

async function writeResult(output: string, result: unknown, io: CliIo): Promise<void> {
  const text = `${JSON.stringify(result, encodeJsonValue)}\n`;
  if (output === '-') await io.writeStdout(text);
  else await io.writeFile(output, text);
}

/** Runs one CLI invocation and returns its stable process exit status. */
export async function runCli(args: readonly string[], io: CliIo = defaultIo): Promise<number> {
  let output = '-';
  try {
    const parsed = parseArguments(args);
    output = parsed.output;
    const contract = await readInput(parsed.contract, 'contract', io);
    const request = await readInput(parsed.input, 'request', io);
    const result = await perform(parsed.command, contract, request);
    await writeResult(output, result, io);
    return statusFor(parsed.command, result);
  } catch (error) {
    const result = errorRecord(error);
    try {
      await writeResult(output, result, io);
    } catch {
      await io.writeStderr(`${JSON.stringify(result)}\n`);
    }
    return EXIT.usage;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url)
  process.exitCode = await runCli(process.argv.slice(2));
