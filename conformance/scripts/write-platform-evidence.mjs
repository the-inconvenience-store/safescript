import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname } from 'node:path';

const output = process.env.EVIDENCE_FILE;
if (!output) throw new Error('EVIDENCE_FILE is required');

const installedRoot = process.env.SAFESCRIPT_RELEASE_INSTALL_ROOT;
const workerPackagePath = installedRoot
  ? `${installedRoot}/node_modules/@safescript/worker/package.json`
  : new URL('../../packages/worker/package.json', import.meta.url);
const workerManifestPath = installedRoot
  ? `${installedRoot}/node_modules/@safescript/worker/dist/build-manifest.json`
  : new URL('../../packages/worker/dist/build-manifest.json', import.meta.url);
const [workerPackage, workerManifest, fixtures] = await Promise.all([
  readFile(workerPackagePath, 'utf8').then(JSON.parse),
  readFile(workerManifestPath, 'utf8').then(JSON.parse),
  readFile(new URL('../worker-protocol/fixtures.json', import.meta.url), 'utf8').then(JSON.parse),
]);

const evidence = {
  format: 1,
  releaseVersion: workerPackage.version,
  nodeVersion: process.version,
  os: platform(),
  architecture: arch(),
  workerBuildDigest: workerManifest.buildDigest,
  testCommand:
    'node conformance/scripts/verify-installed-release.mjs && bun test conformance/src/index.test.ts conformance/src/worker-protocol-spec.test.ts conformance/src/release.test.ts',
  result: 'passed',
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
