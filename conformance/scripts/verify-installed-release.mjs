import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const installRoot =
  process.env.SAFESCRIPT_RELEASE_INSTALL_ROOT ??
  resolve(fileURLToPath(new URL('../../.release/install', import.meta.url)));
const moduleRoot = resolve(installRoot, 'node_modules/@safescript');
const packageNames = ['contracts', 'engine', 'worker', 'sdk', 'cli', 'conformance'];
for (const name of packageNames) {
  const manifest = JSON.parse(await readFile(resolve(moduleRoot, name, 'package.json'), 'utf8'));
  if (manifest.version !== '0.6.0') throw new Error(`${manifest.name} is ${manifest.version}, expected 0.6.0`);
}

const contracts = await import(pathToFileURL(resolve(moduleRoot, 'contracts/dist/index.js')).href);
const sdk = await import(pathToFileURL(resolve(moduleRoot, 'sdk/dist/index.js')).href);
const unit = { id: contracts.ids.type('type:release.unit'), schema: { kind: 'unit' } };
const contract = sdk.defineContract({
  id: contracts.ids.contract('contract:release.installed'),
  operations: {},
  slots: {
    run: {
      id: contracts.ids.slot('slot:release.run'),
      input: unit,
      output: unit,
      effects: [],
      capabilities: [],
    },
  },
});
const safe = sdk.createSafeScript({ contract, handlers: {} });
try {
  const checked = await safe.check({
    slot: 'run',
    source: {
      entryModule: contracts.ids.module('module:release/installed'),
      modules: [{ id: contracts.ids.module('module:release/installed'), source: 'this is not TypeScript {' }],
    },
  });
  if (checked.status !== 'rejected') throw new Error(`installed worker returned ${checked.status}`);
} finally {
  const closed = await safe.close();
  if (closed.status !== 'closed') throw new Error(`installed worker close returned ${closed.status}`);
}
const cli = spawnSync(process.execPath, [resolve(moduleRoot, 'cli/dist/index.js')], { encoding: 'utf8', shell: false });
if (cli.status !== 2 || !cli.stdout.includes('"status":"cli_error"'))
  throw new Error(`installed CLI smoke failed: ${cli.status}\n${cli.stdout}\n${cli.stderr}`);
console.log('installed SafeScript 0.6.0 package set passed');
