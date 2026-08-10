import { describe, expect, it } from 'bun:test';

import { createSafeScript, defineContract, type ContractType, type ModuleId } from '@safescript/sdk';

import { EXIT, runCli } from './index.js';

const contractJson = {
  id: 'contract:cli.test',
  types: [
    { id: 'type:cli.input', schema: { kind: 'string', maxBytes: 100 } },
    { id: 'type:cli.output', schema: { kind: 'string', maxBytes: 100 } },
  ],
  operations: {},
  slots: {
    main: {
      id: 'slot:cli.main',
      input: 'type:cli.input',
      output: 'type:cli.output',
      operations: [],
    },
  },
} as const;

const requestJson = {
  slot: 'main',
  source: {
    entryModule: 'module:main',
    modules: [{ id: 'module:main', source: 'this is not TypeScript {' }],
  },
} as const;

function memoryIo(files: Readonly<Record<string, unknown>>, stdin = '') {
  let stdout = '';
  let stderr = '';
  const written = new Map<string, string>();
  return {
    io: {
      readStdin: async () => stdin,
      readFile: async (path: string) => JSON.stringify(files[path]),
      writeStdout: async (value: string) => {
        stdout += value;
      },
      writeStderr: async (value: string) => {
        stderr += value;
      },
      writeFile: async (path: string, value: string) => {
        written.set(path, value);
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
    written,
  };
}

function directContract() {
  const input: ContractType<string> = {
    id: 'type:cli.input' as ContractType<string>['id'],
    schema: { kind: 'string', maxBytes: 100 },
  };
  const output: ContractType<string> = {
    id: 'type:cli.output' as ContractType<string>['id'],
    schema: { kind: 'string', maxBytes: 100 },
  };
  return defineContract({
    id: 'contract:cli.test' as never,
    types: [input, output],
    operations: {},
    slots: {
      main: {
        id: 'slot:cli.main' as never,
        input,
        output,
        operations: [],
      },
    },
  });
}

describe('SafeScript CLI', () => {
  it('uses only the SDK public entry point', async () => {
    const source = await Bun.file(new URL('index.ts', import.meta.url)).text();
    const projectImports = [...source.matchAll(/from ['"](@safescript\/[^'"]+)/g)].map((match) => match[1]);
    expect(projectImports).toEqual(['@safescript/sdk']);
  });

  it('returns the same machine record as a direct SDK check', async () => {
    const memory = memoryIo({ 'contract.json': contractJson }, JSON.stringify(requestJson));
    const exit = await runCli(['check', '--contract', 'contract.json'], memory.io);

    const contract = directContract();
    const safe = createSafeScript({ contract, handlers: {} });
    const direct = await safe.check({
      slot: 'main',
      source: {
        entryModule: requestJson.source.entryModule as ModuleId,
        modules: requestJson.source.modules.map((module) => ({
          id: module.id as ModuleId,
          source: module.source,
        })),
      },
    });
    await safe.close();

    expect(exit).toBe(EXIT.program);
    expect(JSON.parse(memory.stdout())).toEqual(JSON.parse(JSON.stringify(direct)));
  });

  it('distinguishes CLI misuse and supports explicit output files', async () => {
    const misuse = memoryIo({});
    expect(await runCli(['check'], misuse.io)).toBe(EXIT.usage);
    expect(JSON.parse(misuse.stdout())).toMatchObject({ status: 'cli_error', error: { code: 'usage' } });

    const files = memoryIo({ 'contract.json': contractJson, 'request.json': requestJson });
    expect(
      await runCli(
        ['check', '--contract', 'contract.json', '--input', 'request.json', '--output', 'result.json'],
        files.io,
      ),
    ).toBe(EXIT.program);
    expect(JSON.parse(files.written.get('result.json') ?? '')).toMatchObject({ status: 'rejected' });
  });

  it('exposes inspect, execute, and deterministic test operations', async () => {
    const files = { 'contract.json': contractJson };
    const inspectIo = memoryIo(files, JSON.stringify({ ...requestJson, views: [] }));
    expect(await runCli(['inspect', '--contract', 'contract.json'], inspectIo.io)).toBe(EXIT.program);
    expect(JSON.parse(inspectIo.stdout())).toMatchObject({ status: 'rejected' });

    const executeIo = memoryIo(
      files,
      JSON.stringify({
        slot: 'main',
        program: { kind: 'source', source: requestJson.source },
        input: 'hello',
        invocationId: 'invocation:0123456789abcdef0123456789abcdef',
        randomSeed: { $bytes: 'AwQ=' },
        fixedInstant: { epochSeconds: { $bigint: '1' }, nanoseconds: 0 },
        limits: { fuel: 100 },
        trace: true,
      }),
    );
    expect(await runCli(['execute', '--contract', 'contract.json'], executeIo.io)).toBe(EXIT.program);
    const cliExecution = JSON.parse(executeIo.stdout());
    expect(cliExecution).toMatchObject({ status: 'not_started' });

    const contract = directContract();
    const safe = createSafeScript({ contract, handlers: {} });
    const directExecution = await safe.execute({
      slot: 'main',
      program: {
        kind: 'source',
        source: {
          entryModule: 'module:main' as ModuleId,
          modules: [{ id: 'module:main' as ModuleId, source: 'this is not TypeScript {' }],
        },
      },
      input: 'hello',
      context: undefined,
      invocationId: 'invocation:0123456789abcdef0123456789abcdef' as never,
      randomSeed: Uint8Array.of(3, 4),
      fixedInstant: { epochSeconds: 1n, nanoseconds: 0 },
      limits: { fuel: 100 },
      trace: true,
    });
    await safe.close();
    expect(cliExecution).toEqual(JSON.parse(JSON.stringify(directExecution)));

    const testIo = memoryIo(
      files,
      JSON.stringify({
        name: 'expected rejection',
        slot: 'main',
        program: { kind: 'source', source: requestJson.source },
        input: 'hello',
        actions: [],
        expect: { status: 'not_started' },
      }),
    );
    expect(await runCli(['test', '--contract', 'contract.json'], testIo.io)).toBe(EXIT.ok);
    expect(JSON.parse(testIo.stdout())).toMatchObject({ passed: true, execution: { status: 'not_started' } });
  });

  it('runs as a process over standard streams with stable exit codes', async () => {
    const directory = `${process.env.TMPDIR ?? '/tmp'}/safescript-cli-${crypto.randomUUID()}`;
    const contractPath = `${directory}/contract.json`;
    await Bun.write(contractPath, JSON.stringify(contractJson));
    const child = Bun.spawn(
      [process.execPath, new URL('index.ts', import.meta.url).pathname, 'check', '--contract', contractPath],
      {
        stdin: new Blob([JSON.stringify(requestJson)]),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {},
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(EXIT.program);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'rejected' });
    expect(stderr).toBe('');
  });
});
