#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { DEFAULT_WORKER_HANDSHAKE_SUPPORT, RuntimeWorkerServer } from './server.js';

interface WorkerBuildManifest {
  readonly packageVersion: string;
  readonly buildDigest: string;
}

const manifest = JSON.parse(
  readFileSync(new URL('./build-manifest.json', import.meta.url), 'utf8'),
) as WorkerBuildManifest;
const [major, minor, patch] = manifest.packageVersion.split('.').map((value) => BigInt(value));
if (major === undefined || minor === undefined || patch === undefined) throw new Error('invalid worker build manifest');
const handshake = Object.freeze({
  ...DEFAULT_WORKER_HANDSHAKE_SUPPORT,
  worker: Object.freeze({
    ...DEFAULT_WORKER_HANDSHAKE_SUPPORT.worker,
    package_version: Object.freeze({ major, minor, patch }),
    build_digest: manifest.buildDigest,
  }),
});

const server = new RuntimeWorkerServer({
  handshake,
  write: (frame) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(frame, (error) => (error ? reject(error) : resolve()));
    }),
  close: () => {
    process.stdout.end();
  },
});

process.stdin.on('data', (chunk: Buffer) => {
  void server.receive(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
});
process.stdin.on('end', () => {
  void server.finish();
});
process.stdin.on('error', () => {
  void server.finish();
});
