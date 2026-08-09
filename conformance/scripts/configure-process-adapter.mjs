import { appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const githubEnvironment = process.env.GITHUB_ENV;
if (!githubEnvironment) throw new Error('GITHUB_ENV is required');

const manifest = JSON.parse(
  await readFile(new URL('../../packages/worker/dist/build-manifest.json', import.meta.url), 'utf8'),
);
const entryPath = fileURLToPath(new URL('../../packages/worker/dist/entry.js', import.meta.url));
const values = [
  ['SAFESCRIPT_CONFORMANCE_NODE_PATH', process.execPath],
  ['SAFESCRIPT_CONFORMANCE_WORKER_ENTRY', entryPath],
  ['SAFESCRIPT_CONFORMANCE_WORKER_DIGEST', manifest.buildDigest],
];
await appendFile(githubEnvironment, `${values.map(([name, value]) => `${name}=${value}`).join('\n')}\n`, 'utf8');
