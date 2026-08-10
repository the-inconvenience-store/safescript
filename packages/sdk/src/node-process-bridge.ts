import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SAFESCRIPT_VERSION, type WorkerProtocolSessionHello } from '@safescript/contracts';

import {
  DEFAULT_PROCESS_WORKER_HELLO,
  SupervisedProcessRuntimeBridge,
  WorkerStartError,
  type ProcessWorkerTransport,
  type SupervisedProcessRuntimeBridgeOptions,
} from './process-bridge.js';

const SHA256 = /^[0-9a-f]{64}$/;
const FEATURE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;
const ZERO_DIGEST = '0'.repeat(64);
const BUNDLED_PACKAGE_VERSION = '0.6.0';
const BUNDLED_WORKER_BUILD_DIGEST = 'bb81d3d204ee36a31c4f6f9f466ad1aaa9829679454a64fbd62ccdb1c2427c15';

interface WorkerBuildManifest {
  readonly schema: 1;
  readonly packageVersion: string;
  readonly compilerBuild: string;
  readonly entry: string;
  readonly buildDigest: string;
}

interface WorkerPackageManifest {
  readonly name: string;
  readonly version: string;
}

export interface NodeWorkerOverride {
  readonly entryPath: string;
  readonly nodePath?: string;
  readonly digestAllowlist?: readonly string[];
  readonly requiredFeatures?: readonly string[];
}

export interface NodeProcessRuntimeBridgeOptions {
  readonly override?: NodeWorkerOverride;
  /** Explicit supported Node executable for a non-Node host runtime. */
  readonly nodePath?: string;
  readonly startupTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly restartAttempts?: number;
  readonly restartWindowMs?: number;
  readonly now?: () => number;
}

interface ResolvedWorker {
  readonly entryPath: string;
  readonly nodePath: string;
}

class NodeWorkerTransport implements ProcessWorkerTransport {
  readonly incoming: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.incoming = child.stdout;
    this.stderr = child.stderr;
    child.once('error', () => undefined);
  }

  write(completeFrame: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(completeFrame, (error) => (error ? reject(error) : resolve()));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return resolve();
      this.child.stdin.end(resolve);
    });
  }
}

async function digest(path: string): Promise<string> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch {
    throw new WorkerStartError('worker_start_failed');
  }
}

function validateOverride(override: NodeWorkerOverride): void {
  if (
    !isAbsolute(override.entryPath) ||
    (override.nodePath !== undefined && !isAbsolute(override.nodePath)) ||
    (override.digestAllowlist !== undefined &&
      (!Array.isArray(override.digestAllowlist) ||
        override.digestAllowlist.length === 0 ||
        !override.digestAllowlist.every((value) => SHA256.test(value)))) ||
    (override.requiredFeatures !== undefined &&
      (!Array.isArray(override.requiredFeatures) ||
        !override.requiredFeatures.every(
          (value, index) =>
            FEATURE.test(value) && (index === 0 || (override.requiredFeatures?.[index - 1] as string) < value),
        )))
  )
    throw new TypeError('worker override requires absolute paths and valid digest allow-list values');
}

async function bundledWorker(nodePath: string): Promise<ResolvedWorker> {
  try {
    const manifestUrl = import.meta.resolve('@safescript/worker/manifest');
    const packageUrl = import.meta.resolve('@safescript/worker/package.json');
    const manifest = JSON.parse(await readFile(fileURLToPath(manifestUrl), 'utf8')) as WorkerBuildManifest;
    const packageManifest = JSON.parse(await readFile(fileURLToPath(packageUrl), 'utf8')) as WorkerPackageManifest;
    const entryPath = fileURLToPath(new URL(manifest.entry, manifestUrl));
    const actual = await digest(entryPath);
    if (
      manifest.schema !== 1 ||
      packageManifest.name !== '@safescript/worker' ||
      packageManifest.version !== BUNDLED_PACKAGE_VERSION ||
      manifest.packageVersion !== BUNDLED_PACKAGE_VERSION ||
      manifest.compilerBuild !== 'structured-ir-current' ||
      manifest.entry !== 'entry.js' ||
      !SHA256.test(manifest.buildDigest) ||
      manifest.buildDigest !== BUNDLED_WORKER_BUILD_DIGEST ||
      actual !== manifest.buildDigest
    )
      throw new WorkerStartError('worker_identity_mismatch');
    return Object.freeze({ entryPath, nodePath });
  } catch (error) {
    if (error instanceof WorkerStartError) throw error;
    throw new WorkerStartError('worker_start_failed');
  }
}

async function overriddenWorker(override: NodeWorkerOverride): Promise<ResolvedWorker> {
  const actual = await digest(override.entryPath);
  if (override.digestAllowlist && !override.digestAllowlist.includes(actual))
    throw new WorkerStartError('worker_identity_mismatch');
  return Object.freeze({ entryPath: override.entryPath, nodePath: override.nodePath ?? process.execPath });
}

function hello(options: NodeProcessRuntimeBridgeOptions): WorkerProtocolSessionHello {
  return Object.freeze({
    ...DEFAULT_PROCESS_WORKER_HELLO,
    required_features: Object.freeze(
      options.override?.requiredFeatures?.slice() ?? DEFAULT_PROCESS_WORKER_HELLO.required_features,
    ),
    expected_worker: Object.freeze({
      version: SAFESCRIPT_VERSION,
      build_digest:
        options.override?.digestAllowlist?.[0] ?? (options.override ? ZERO_DIGEST : BUNDLED_WORKER_BUILD_DIGEST),
      override: options.override !== undefined,
    }),
  });
}

async function startWorker(options: NodeProcessRuntimeBridgeOptions): Promise<ProcessWorkerTransport> {
  const worker = options.override
    ? await overriddenWorker(options.override)
    : await bundledWorker(options.nodePath ?? process.execPath);
  const child = spawn(worker.nodePath, [worker.entryPath], {
    cwd: dirname(worker.entryPath),
    env: {},
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return new NodeWorkerTransport(child);
}

/** Creates a lazy supervised bridge backed by the pinned local Node worker package or one explicit override. */
export function createNodeProcessRuntimeBridge(
  options: NodeProcessRuntimeBridgeOptions = {},
): SupervisedProcessRuntimeBridge {
  if (options.override) validateOverride(options.override);
  if (options.nodePath !== undefined && !isAbsolute(options.nodePath))
    throw new TypeError('worker Node executable must be an absolute path');
  const supervisorOptions: SupervisedProcessRuntimeBridgeOptions = {
    start: () => startWorker(options),
    hello: hello(options),
    ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
    ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
    ...(options.restartAttempts === undefined ? {} : { restartAttempts: options.restartAttempts }),
    ...(options.restartWindowMs === undefined ? {} : { restartWindowMs: options.restartWindowMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return new SupervisedProcessRuntimeBridge(supervisorOptions);
}
