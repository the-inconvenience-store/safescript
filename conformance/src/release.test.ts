import { describe, expect, it } from 'bun:test';

import {
  STANDARD_EXECUTION_LIMITS,
  decodeCanonical,
  encodeCanonical,
  ids,
  type RuntimeBridge,
  type Schema,
} from '@safescript/contracts';
import { createDirectRuntimeBridge } from '@safescript/engine';
import { createNodeProcessRuntimeBridge } from '@safescript/sdk';

import {
  referenceCheckRequest,
  referenceInput,
  referenceRegistry,
  referenceTypes,
  walkingSkeletonReference,
} from './references.js';

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly exports?: Readonly<Record<string, string | Readonly<Record<string, string>>>>;
  readonly files?: readonly string[];
  readonly engines?: Readonly<Record<string, string>>;
  readonly publishConfig?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

async function manifest(path: string): Promise<PackageManifest> {
  return Bun.file(new URL(path, import.meta.url)).json() as Promise<PackageManifest>;
}

describe('V2 release metadata and public package surface', () => {
  it('publishes one coordinated Node 22/24 package set at SemVer 2.0.0', async () => {
    const [contracts, engine, worker, sdk, cli, conformance] = await Promise.all([
      manifest('../../packages/contracts/package.json'),
      manifest('../../packages/engine/package.json'),
      manifest('../../packages/worker/package.json'),
      manifest('../../packages/sdk/package.json'),
      manifest('../../apps/cli/package.json'),
      manifest('../package.json'),
    ]);
    for (const packageManifest of [contracts, engine, worker, sdk, cli, conformance]) {
      expect(packageManifest.version, packageManifest.name).toBe('2.0.0');
      expect(packageManifest.private).not.toBe(true);
      expect(packageManifest.files?.length, packageManifest.name).toBeGreaterThan(0);
      expect(packageManifest.engines?.node, packageManifest.name).toBe('>=22 <25');
      expect(packageManifest.publishConfig?.access, packageManifest.name).toBe('public');
      const rootExport = packageManifest.exports?.['.'];
      expect(rootExport, packageManifest.name).toMatchObject({
        types: './dist/index.d.ts',
        import: './dist/index.js',
      });
    }
    expect(engine.dependencies?.['@safescript/contracts']).toBe('^2.0.0');
    expect(worker.dependencies).toMatchObject({
      '@safescript/contracts': '2.0.0',
      '@safescript/engine': '2.0.0',
    });
    expect(sdk.dependencies).toMatchObject({
      '@safescript/contracts': '^2.0.0',
      '@safescript/engine': '^2.0.0',
      '@safescript/worker': '2.0.0',
    });
    expect(cli.dependencies?.['@safescript/sdk']).toBe('^2.0.0');
    expect(conformance.dependencies?.['@safescript/contracts']).toBe('^2.0.0');
  });

  it('records the v2 compatibility dimensions, migration, and explicit deferred scope', async () => {
    const notes = await Bun.file(new URL('../../CHANGELOG.md', import.meta.url)).text();
    for (const required of [
      '## 2.0.0',
      'worker protocol 1.0',
      'action ABI 2.0',
      'worker-backed default',
      'artifact regeneration',
      '## 1.0.0',
      'language 1.0',
      'additive 1.1',
      'IR 1.0 and 1.1',
      'ABI 1.0',
      'diagnostic catalog 1.0.0',
      'authoring bundle 1.0.0',
      'storage',
      'caching',
      'audit',
      'retries',
      'workflows',
      'Python, Go, and Rust SDKs',
    ])
      expect(notes).toContain(required);
  });

  it('publishes auditable upgrade and stable-release evidence with no open critical finding', async () => {
    const [upgrade, release] = await Promise.all([
      Bun.file(new URL('../evidence/release/v1-to-v2-upgrade.json', import.meta.url)).json(),
      Bun.file(new URL('../evidence/release/2.0.0.json', import.meta.url)).json(),
    ]);
    expect(upgrade).toMatchObject({ schemaVersion: 1, releaseVersion: '2.0.0', result: 'passed' });
    expect(release).toMatchObject({
      schemaVersion: 1,
      releaseVersion: '2.0.0',
      protocolVersion: '1.0',
      fixtureSchemaVersion: '1.0.0',
      securityReview: { criticalFindings: 0, openCriticalFindings: 0 },
      platformEvidence: { jobs: 10, result: 'passed' },
      result: 'passed',
    });
  });

  it('runs unchanged v1 source after regenerating its artifact and rejects the legacy ABI artifact', async () => {
    const sourceRequest = referenceCheckRequest(walkingSkeletonReference);
    const ref = (type: typeof referenceTypes.event): Schema => ({ kind: 'ref', type });
    const input = encodeCanonical(
      ref(referenceTypes.event),
      { ...referenceInput, after: { ...referenceInput.after, stage: 'open' } },
      { registry: referenceRegistry.schemas },
    );
    if (!input.ok) throw new Error(input.failure.code);
    const execute = (
      program:
        | Readonly<{ kind: 'source'; source: typeof sourceRequest }>
        | Readonly<{ kind: 'artifact'; bytes: readonly number[] }>,
    ) => ({
      abiVersion: { major: 2, minor: 0 } as const,
      registry: referenceRegistry,
      slotId: referenceTypes.slotId,
      invocationId: ids.invocation(`invocation:${(program.kind === 'source' ? '7' : '8').repeat(32)}`),
      program,
      input: [...input.value],
      limits: STANDARD_EXECUTION_LIMITS,
      idempotencySeed: [1, 2, 3],
      trace: 'none' as const,
    });
    const adapters: readonly RuntimeBridge[] = [createDirectRuntimeBridge(), createNodeProcessRuntimeBridge()];
    try {
      for (const bridge of adapters) {
        const checked = await bridge.check(sourceRequest);
        expect(checked.status).toBe('accepted');
        if (checked.status !== 'accepted') continue;
        const host = { handleAction: async () => Promise.reject(new Error('no-action upgrade path dispatched')) };
        const sourceResult = await bridge.execute(execute({ kind: 'source', source: sourceRequest }), host);
        expect(sourceResult.status, JSON.stringify(sourceResult)).toBe('completed');
        const artifactResult = await bridge.execute(execute({ kind: 'artifact', bytes: checked.artifact }), host);
        expect(artifactResult.status, JSON.stringify(artifactResult)).toBe('completed');

        const artifact = decodeCanonical({ kind: 'string' }, Uint8Array.from(checked.artifact));
        if (!artifact.ok || typeof artifact.value !== 'string') throw new Error('artifact envelope is not canonical');
        const legacy = encodeCanonical({ kind: 'string' }, artifact.value.replace('"abi":[2,0]', '"abi":[1,0]'));
        if (!legacy.ok) throw new Error('legacy artifact encoding failed');
        const rejected = await bridge.execute(execute({ kind: 'artifact', bytes: [...legacy.value] }), host);
        expect(rejected.status).toBe('not_started');
        if (rejected.status === 'not_started') expect(rejected.error?.code).toBe('artifact_verification_failed');
      }
    } finally {
      await Promise.all(adapters.map((bridge) => bridge.close()));
    }
  });
});
