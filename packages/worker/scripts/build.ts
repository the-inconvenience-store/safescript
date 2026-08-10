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
const bundled = await Bun.file(entry).text();
const normalizedVendorPath =
  '  var __dirname = "/safescript/vendor/typescript/lib", __filename = "/safescript/vendor/typescript/lib/typescript.js";';
const normalizedBundle = bundled
  .replace(/^\/\/ (?:\.\.\/)+node_modules\//gm, '// node_modules/')
  .replace(/^  var __dirname = .*__filename = .*typescript\.js";$/m, normalizedVendorPath);
if (!normalizedBundle.includes(normalizedVendorPath))
  throw new Error('worker bundle did not contain the TypeScript vendor path');
await Bun.write(entry, normalizedBundle);
const buildDigest = createHash('sha256')
  .update(new Uint8Array(await Bun.file(entry).arrayBuffer()))
  .digest('hex');
const manifest = {
  schema: 1,
  packageVersion: packageManifest.version,
  compilerBuild: 'typed-ir-current',
  entry: 'entry.js',
  buildDigest,
};
await Bun.write(new URL('dist/build-manifest.json', root), `${JSON.stringify(manifest, null, 2)}\n`);
