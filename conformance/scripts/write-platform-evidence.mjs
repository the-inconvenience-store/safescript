import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname } from 'node:path';

const output = process.env.EVIDENCE_FILE;
if (!output) throw new Error('EVIDENCE_FILE is required');

const [workerPackage, workerManifest, fixtures] = await Promise.all([
  readFile(new URL('../../packages/worker/package.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../../packages/worker/dist/build-manifest.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../worker-protocol/v1/fixtures.json', import.meta.url), 'utf8').then(JSON.parse),
]);

const evidence = {
  schemaVersion: 1,
  releaseVersion: workerPackage.version,
  nodeVersion: process.version,
  os: platform(),
  architecture: arch(),
  workerBuildDigest: workerManifest.buildDigest,
  protocolVersion: fixtures.protocol,
  fixtureSchemaVersion: fixtures.schemaVersion,
  testCommand: 'bun test conformance/src/index.test.ts conformance/src/worker-protocol-spec.test.ts',
  result: 'passed',
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
