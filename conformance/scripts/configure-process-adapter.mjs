import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const githubEnvironment = process.env.GITHUB_ENV;
if (!githubEnvironment) throw new Error('GITHUB_ENV is required');

const installedRoot = process.env.SAFESCRIPT_RELEASE_INSTALL_ROOT;
const manifestUrl = installedRoot
  ? pathToFileURL(resolve(installedRoot, 'node_modules/@safescript/worker/dist/build-manifest.json'))
  : new URL('../../packages/worker/dist/build-manifest.json', import.meta.url);
const entryUrl = installedRoot
  ? pathToFileURL(resolve(installedRoot, 'node_modules/@safescript/worker/dist/entry.js'))
  : new URL('../../packages/worker/dist/entry.js', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
const entry = await readFile(entryUrl);
const buildDigest = createHash('sha256').update(entry).digest('hex');
if (manifest.buildDigest !== buildDigest) {
  manifest.buildDigest = buildDigest;
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
const entryPath = fileURLToPath(entryUrl);
const values = [
  ['SAFESCRIPT_CONFORMANCE_NODE_PATH', process.execPath],
  ['SAFESCRIPT_CONFORMANCE_WORKER_ENTRY', entryPath],
  ['SAFESCRIPT_CONFORMANCE_WORKER_DIGEST', buildDigest],
];
await appendFile(githubEnvironment, `${values.map(([name, value]) => `${name}=${value}`).join('\n')}\n`, 'utf8');
