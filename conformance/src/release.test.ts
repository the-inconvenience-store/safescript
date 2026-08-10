import { describe, expect, it } from 'bun:test';

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

describe('SafeScript 0.6.0 release metadata and public package surface', () => {
  it('publishes one coordinated Node 22/24 package set', async () => {
    const [contracts, engine, worker, sdk, cli, conformance] = await Promise.all([
      manifest('../../packages/contracts/package.json'),
      manifest('../../packages/engine/package.json'),
      manifest('../../packages/worker/package.json'),
      manifest('../../packages/sdk/package.json'),
      manifest('../../apps/cli/package.json'),
      manifest('../package.json'),
    ]);
    for (const packageManifest of [contracts, engine, worker, sdk, cli, conformance]) {
      expect(packageManifest.version, packageManifest.name).toBe('0.6.0');
      expect(packageManifest.private).not.toBe(true);
      expect(packageManifest.files?.length, packageManifest.name).toBeGreaterThan(0);
      expect(packageManifest.engines?.node, packageManifest.name).toBe('>=22 <25');
      expect(packageManifest.publishConfig?.access, packageManifest.name).toBe('public');
      expect(packageManifest.exports?.['.'], packageManifest.name).toMatchObject({
        types: './dist/index.d.ts',
        import: './dist/index.js',
      });
      for (const [name, version] of Object.entries(packageManifest.dependencies ?? {}))
        if (name.startsWith('@safescript/')) expect(version, `${packageManifest.name} -> ${name}`).toBe('0.6.0');
    }
  });

  it('records current release evidence with no open critical finding', async () => {
    const release = await Bun.file(new URL('../evidence/release/0.6.0.json', import.meta.url)).json();
    expect(release).toMatchObject({
      format: 1,
      releaseVersion: '0.6.0',
      securityReview: { criticalFindings: 0, openCriticalFindings: 0 },
      platformEvidence: { jobs: 10, result: 'passed' },
      result: 'passed',
    });
  });
});
