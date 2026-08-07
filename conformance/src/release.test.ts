import { describe, expect, it } from 'bun:test';

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly exports?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

async function manifest(path: string): Promise<PackageManifest> {
  return Bun.file(new URL(path, import.meta.url)).json() as Promise<PackageManifest>;
}

describe('V1 release metadata and public package surface', () => {
  it('publishes the four public packages at SemVer 1.0.0 with one deep entry point', async () => {
    const [contracts, engine, sdk, cli] = await Promise.all([
      manifest('../../packages/contracts/package.json'),
      manifest('../../packages/engine/package.json'),
      manifest('../../packages/sdk/package.json'),
      manifest('../../apps/cli/package.json'),
    ]);
    for (const packageManifest of [contracts, engine, sdk, cli]) {
      expect(packageManifest.version).toBe('1.0.0');
      expect(packageManifest.private).not.toBe(true);
      expect(Object.keys(packageManifest.exports ?? {})).toEqual(['.']);
    }
    expect(engine.dependencies?.['@safescript/contracts']).toBe('^1.0.0');
    expect(sdk.dependencies).toMatchObject({
      '@safescript/contracts': '^1.0.0',
      '@safescript/engine': '^1.0.0',
    });
    expect(cli.dependencies?.['@safescript/sdk']).toBe('^1.0.0');
  });

  it('records the independent V1 versions and explicit deferred scope', async () => {
    const notes = await Bun.file(new URL('../../CHANGELOG.md', import.meta.url)).text();
    for (const required of [
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
});
