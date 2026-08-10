import {
  defineWorkerProtocolPayload,
  type WorkerProtocolMessageKind,
  type WorkerProtocolSchema,
} from './worker-protocol.js';

const MAX_UINT64 = (1n << 64n) - 1n;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_TEXT_BYTES = 256;

/** The single public contract shared by every SafeScript component. */
export const SAFESCRIPT_VERSION = '0.6.0' as const;

export interface WorkerProtocolExpectedWorker {
  readonly version: string;
  readonly build_digest: string;
  readonly override: boolean;
}

export interface WorkerProtocolWorkerIdentity {
  readonly version: string;
  readonly compiler_build: string;
  readonly build_digest: string;
}

export interface WorkerProtocolOperationalLimits {
  readonly max_frame_bytes: bigint;
  readonly max_payload_bytes: bigint;
  readonly max_decoded_depth: bigint;
  readonly max_decoded_nodes: bigint;
  readonly max_in_flight: bigint;
  readonly max_pending_replies: bigint;
  readonly max_queued_bytes: bigint;
  readonly partial_frame_ms: bigint;
  readonly worker_start_ms: bigint;
  readonly handshake_ms: bigint;
  readonly graceful_close_ms: bigint;
  readonly max_stderr_bytes: bigint;
  readonly restart_attempts: bigint;
  readonly restart_window_ms: bigint;
}

export interface WorkerProtocolSessionHello {
  readonly version: string;
  readonly sdk_build: string;
  readonly expected_worker: WorkerProtocolExpectedWorker;
  readonly limits: WorkerProtocolOperationalLimits;
}

export interface WorkerProtocolHandshakeSupport {
  readonly version: string;
  readonly worker: WorkerProtocolWorkerIdentity;
  readonly limits: WorkerProtocolOperationalLimits;
  readonly implementation: string;
}

export interface WorkerProtocolSessionWelcome {
  readonly version: string;
  readonly worker: WorkerProtocolWorkerIdentity;
  readonly limits: WorkerProtocolOperationalLimits;
  readonly implementation: string;
}

export const WORKER_PROTOCOL_INCOMPATIBILITY_DIMENSIONS = Object.freeze([
  'version',
  'worker_build_digest',
  'operational_limit',
] as const);

export type WorkerProtocolIncompatibilityDimension = (typeof WORKER_PROTOCOL_INCOMPATIBILITY_DIMENSIONS)[number];

export interface WorkerProtocolSessionIncompatible {
  readonly code: 'incompatible_session';
  readonly dimensions: readonly WorkerProtocolIncompatibilityDimension[];
  readonly detail?: string;
}

export type WorkerProtocolHandshakeResult =
  | Readonly<{ compatible: true; welcome: WorkerProtocolSessionWelcome }>
  | Readonly<{ compatible: false; incompatible: WorkerProtocolSessionIncompatible }>;

const TEXT_SCHEMA = Object.freeze({ kind: 'text' as const, maxBytes: MAX_TEXT_BYTES });
const SHA256_SCHEMA = Object.freeze({ kind: 'text' as const, maxBytes: 64 });
const EXPECTED_WORKER_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'version', schema: TEXT_SCHEMA }),
    Object.freeze({ name: 'build_digest', schema: SHA256_SCHEMA }),
    Object.freeze({ name: 'override', schema: Object.freeze({ kind: 'boolean' as const }) }),
  ]),
});

const WORKER_IDENTITY_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'version', schema: TEXT_SCHEMA }),
    Object.freeze({ name: 'compiler_build', schema: TEXT_SCHEMA }),
    Object.freeze({ name: 'build_digest', schema: SHA256_SCHEMA }),
  ]),
});

const OPERATIONAL_LIMITS_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze(
    [
      'max_frame_bytes',
      'max_payload_bytes',
      'max_decoded_depth',
      'max_decoded_nodes',
      'max_in_flight',
      'max_pending_replies',
      'max_queued_bytes',
      'partial_frame_ms',
      'worker_start_ms',
      'handshake_ms',
      'graceful_close_ms',
      'max_stderr_bytes',
      'restart_attempts',
      'restart_window_ms',
    ].map((name) => Object.freeze({ name, schema: Object.freeze({ kind: 'uint' as const, minimum: 1n }) })),
  ),
});

const HELLO_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'version', schema: TEXT_SCHEMA }),
    Object.freeze({ name: 'sdk_build', schema: TEXT_SCHEMA }),
    Object.freeze({ name: 'expected_worker', schema: EXPECTED_WORKER_SCHEMA }),
    Object.freeze({ name: 'limits', schema: OPERATIONAL_LIMITS_SCHEMA }),
  ]),
});

const WELCOME_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'version', schema: TEXT_SCHEMA }),
    Object.freeze({ name: 'worker', schema: WORKER_IDENTITY_SCHEMA }),
    Object.freeze({ name: 'limits', schema: OPERATIONAL_LIMITS_SCHEMA }),
    Object.freeze({ name: 'implementation', schema: TEXT_SCHEMA }),
  ]),
});

const INCOMPATIBLE_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'code', schema: Object.freeze({ kind: 'literal' as const, value: 'incompatible_session' }) }),
    Object.freeze({
      name: 'dimensions',
      schema: Object.freeze({
        kind: 'array' as const,
        item: Object.freeze({
          kind: 'oneOf' as const,
          choices: Object.freeze(
            WORKER_PROTOCOL_INCOMPATIBILITY_DIMENSIONS.map((value) =>
              Object.freeze({ kind: 'literal' as const, value }),
            ),
          ),
        }),
        maxItems: WORKER_PROTOCOL_INCOMPATIBILITY_DIMENSIONS.length,
      }),
    }),
    Object.freeze({ name: 'detail', schema: TEXT_SCHEMA, optional: true }),
  ]),
});

export const WORKER_PROTOCOL_SESSION_HELLO_PAYLOAD = defineWorkerProtocolPayload<WorkerProtocolSessionHello>(
  'session.hello',
  HELLO_SCHEMA,
);
export const WORKER_PROTOCOL_SESSION_WELCOME_PAYLOAD = defineWorkerProtocolPayload<WorkerProtocolSessionWelcome>(
  'session.welcome',
  WELCOME_SCHEMA,
);
export const WORKER_PROTOCOL_SESSION_INCOMPATIBLE_PAYLOAD =
  defineWorkerProtocolPayload<WorkerProtocolSessionIncompatible>('session.incompatible', INCOMPATIBLE_SCHEMA);

export const STANDARD_WORKER_OPERATIONAL_LIMITS: WorkerProtocolOperationalLimits = Object.freeze({
  max_frame_bytes: 16_777_216n,
  max_payload_bytes: 16_700_000n,
  max_decoded_depth: 128n,
  max_decoded_nodes: 1_000_000n,
  max_in_flight: 64n,
  max_pending_replies: 128n,
  max_queued_bytes: 33_554_432n,
  partial_frame_ms: 10_000n,
  worker_start_ms: 30_000n,
  handshake_ms: 5_000n,
  graceful_close_ms: 5_000n,
  max_stderr_bytes: 65_536n,
  restart_attempts: 3n,
  restart_window_ms: 60_000n,
});

const LIMIT_KEYS = Object.freeze(
  Object.keys(STANDARD_WORKER_OPERATIONAL_LIMITS) as Array<keyof WorkerProtocolOperationalLimits>,
);

function uint(value: unknown, allowZero = true): value is bigint {
  return typeof value === 'bigint' && value >= (allowZero ? 0n : 1n) && value <= MAX_UINT64;
}

function validText(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    new TextEncoder().encode(value).length <= MAX_TEXT_BYTES &&
    !/[\uD800-\uDFFF]/u.test(value)
  );
}

function validVersion(value: unknown): value is string {
  return value === SAFESCRIPT_VERSION;
}

function validLimits(limits: WorkerProtocolOperationalLimits): boolean {
  return (
    LIMIT_KEYS.every((key) => uint(limits[key], false)) &&
    limits.max_payload_bytes < limits.max_frame_bytes &&
    limits.max_pending_replies > limits.max_in_flight &&
    limits.max_queued_bytes >= limits.max_frame_bytes * 2n
  );
}

function selectLimits(
  host: WorkerProtocolOperationalLimits,
  worker: WorkerProtocolOperationalLimits,
): WorkerProtocolOperationalLimits {
  const selected = {} as Record<keyof WorkerProtocolOperationalLimits, bigint>;
  for (const key of LIMIT_KEYS) {
    const ceiling = STANDARD_WORKER_OPERATIONAL_LIMITS[key];
    selected[key] =
      host[key] < worker[key]
        ? host[key] < ceiling
          ? host[key]
          : ceiling
        : worker[key] < ceiling
          ? worker[key]
          : ceiling;
  }
  return Object.freeze(selected);
}

function validWorker(identity: WorkerProtocolWorkerIdentity): boolean {
  return (
    validVersion(identity.version) &&
    validText(identity.compiler_build) &&
    typeof identity.build_digest === 'string' &&
    SHA256.test(identity.build_digest)
  );
}

function incompatible(failures: Set<WorkerProtocolIncompatibilityDimension>): WorkerProtocolHandshakeResult {
  return Object.freeze({
    compatible: false,
    incompatible: Object.freeze({
      code: 'incompatible_session' as const,
      dimensions: Object.freeze([...failures].sort()),
    }),
  });
}

const INCOMPATIBILITY_DIMENSIONS = new Set<string>(WORKER_PROTOCOL_INCOMPATIBILITY_DIMENSIONS);

export function isValidWorkerProtocolSessionIncompatible(value: WorkerProtocolSessionIncompatible): boolean {
  if (
    value.code !== 'incompatible_session' ||
    !Array.isArray(value.dimensions) ||
    value.dimensions.length === 0 ||
    value.dimensions.length > WORKER_PROTOCOL_INCOMPATIBILITY_DIMENSIONS.length ||
    (value.detail !== undefined && !validText(value.detail, true))
  )
    return false;
  return value.dimensions.every(
    (dimension, index) =>
      INCOMPATIBILITY_DIMENSIONS.has(dimension) && (index === 0 || (value.dimensions[index - 1] as string) < dimension),
  );
}

export function negotiateWorkerProtocolHandshake(
  hello: WorkerProtocolSessionHello,
  support: WorkerProtocolHandshakeSupport,
): WorkerProtocolHandshakeResult {
  const failures = new Set<WorkerProtocolIncompatibilityDimension>();
  if (!validVersion(hello.version) || !validVersion(support.version) || hello.version !== support.version)
    failures.add('version');
  if (!validText(hello.sdk_build) || !validText(support.implementation) || !validWorker(support.worker))
    failures.add('worker_build_digest');
  if (
    !validVersion(hello.expected_worker.version) ||
    typeof hello.expected_worker.build_digest !== 'string' ||
    !SHA256.test(hello.expected_worker.build_digest)
  )
    failures.add('worker_build_digest');
  if (!hello.expected_worker.override && hello.expected_worker.build_digest !== support.worker.build_digest)
    failures.add('worker_build_digest');
  if (!validLimits(hello.limits) || !validLimits(support.limits)) failures.add('operational_limit');
  if (failures.size > 0) return incompatible(failures);
  return Object.freeze({
    compatible: true,
    welcome: Object.freeze({
      version: SAFESCRIPT_VERSION,
      worker: Object.freeze({ ...support.worker }),
      limits: selectLimits(hello.limits, support.limits),
      implementation: support.implementation,
    }),
  });
}

export function validateWorkerProtocolWelcome(
  hello: WorkerProtocolSessionHello,
  welcome: WorkerProtocolSessionWelcome,
): WorkerProtocolHandshakeResult {
  const failures = new Set<WorkerProtocolIncompatibilityDimension>();
  if (!validVersion(hello.version) || !validVersion(welcome.version) || hello.version !== welcome.version)
    failures.add('version');
  if (!validWorker(welcome.worker) || !validText(welcome.implementation)) failures.add('worker_build_digest');
  if (!hello.expected_worker.override && welcome.worker.build_digest !== hello.expected_worker.build_digest)
    failures.add('worker_build_digest');
  if (!validLimits(welcome.limits) || LIMIT_KEYS.some((key) => welcome.limits[key] > hello.limits[key]))
    failures.add('operational_limit');
  if (failures.size > 0) return incompatible(failures);
  return Object.freeze({ compatible: true, welcome });
}

export const WORKER_PROTOCOL_HANDSHAKE_KINDS: readonly WorkerProtocolMessageKind[] = Object.freeze([
  'session.hello',
  'session.welcome',
  'session.incompatible',
]);
