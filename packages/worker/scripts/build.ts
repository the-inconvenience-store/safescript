import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  readonly version: string;
}

const root = new URL('../', import.meta.url);
process.chdir(fileURLToPath(root));
const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL('src/entry.ts', root))],
  outdir: fileURLToPath(new URL('dist/', root)),
  naming: 'entry.js',
  target: 'node',
  packages: 'bundle',
});
if (!result.success) throw new AggregateError(result.logs, 'worker bundle failed');

const entry = new URL('dist/entry.js', root);
const packageManifest = (await Bun.file(new URL('package.json', root)).json()) as PackageManifest;
const normalizedBundle = (await Bun.file(entry).text()).replace(
  /^\/\/ (?:\.\.\/)+node_modules\//gm,
  '// node_modules/',
);
await Bun.write(entry, normalizedBundle);
const buildDigest = createHash('sha256')
  .update(new Uint8Array(await Bun.file(entry).arrayBuffer()))
  .digest('hex');
const manifest = {
  schema: 1,
  packageVersion: packageManifest.version,
  protocol: { major: 1, minMinor: 0, maxMinor: 0 },
  compiler: { version: '0.2.0', build: 'typed-ir-language-1-1' },
  entry: 'entry.js',
  buildDigest,
};
await Bun.write(new URL('dist/build-manifest.json', root), `${JSON.stringify(manifest, null, 2)}\n`);
