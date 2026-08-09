import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const releaseRoot = resolve(root, '.release');
const packRoot = resolve(releaseRoot, 'packages');
const installRoot = resolve(releaseRoot, 'install');
const npm =
  process.platform === 'win32'
    ? { command: process.execPath, prefix: [resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] }
    : { command: 'npm', prefix: [] };
const packages = [
  'packages/contracts',
  'packages/engine',
  'packages/worker',
  'packages/sdk',
  'apps/cli',
  'conformance',
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function runNpm(args) {
  return run(npm.command, [...npm.prefix, ...args]);
}

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(packRoot, { recursive: true });
const packed = [];
for (const packageRoot of packages) {
  const output = JSON.parse(runNpm(['pack', resolve(root, packageRoot), '--json', '--pack-destination', packRoot]));
  const result = output[0];
  if (!result?.filename || !result?.integrity)
    throw new Error(`npm pack returned incomplete metadata for ${packageRoot}`);
  const forbidden = result.files.filter(({ path }) =>
    /(?:^|\/)(?:src|test|tests)(?:\/|$)|\.test\.|tsbuildinfo$/.test(path),
  );
  if (forbidden.length > 0)
    throw new Error(`${result.id} publishes forbidden files: ${forbidden.map(({ path }) => path).join(', ')}`);
  packed.push({
    name: result.name,
    version: result.version,
    filename: result.filename,
    integrity: result.integrity,
    shasum: result.shasum,
    fileCount: result.files.length,
  });
}
await mkdir(installRoot, { recursive: true });
runNpm([
  'install',
  '--prefix',
  installRoot,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--package-lock=false',
  ...packed.map(({ filename }) => resolve(packRoot, filename)),
]);
await writeFile(
  resolve(releaseRoot, 'package-set.json'),
  `${JSON.stringify({ schemaVersion: 1, releaseVersion: '2.0.0', packages: packed, result: 'passed' }, null, 2)}\n`,
  'utf8',
);
if (process.env.GITHUB_ENV)
  await appendFile(process.env.GITHUB_ENV, `SAFESCRIPT_RELEASE_INSTALL_ROOT=${installRoot}\n`, 'utf8');
console.log(installRoot);
