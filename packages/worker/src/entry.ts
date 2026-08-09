#!/usr/bin/env node
import { RuntimeWorkerServer } from './server.js';

const server = new RuntimeWorkerServer({
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
