import {
  defineWorkerProtocolPayload,
  type WorkerProtocolMessageKind,
  type WorkerProtocolSchema,
} from './worker-protocol.js';

const MAX_UINT64 = (1n << 64n) - 1n;
const FEATURE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_TEXT_BYTES = 256;

export interface WorkerProtocolVersion {
  readonly major: bigint;
  readonly minor: bigint;
}

export interface WorkerProtocolSemVer extends WorkerProtocolVersion {
  readonly patch: bigint;
  readonly prerelease?: string;
}

export interface WorkerProtocolRange {
  readonly major: bigint;
  readonly min_minor: bigint;
  readonly max_minor: bigint;
}

export interface WorkerProtocolBuildIdentity {
  readonly version: WorkerProtocolSemVer;
  readonly build: string;
}

export interface WorkerProtocolExpectedWorker {
  readonly package_version: WorkerProtocolSemVer;
  readonly build_digest: string;
  readonly override: boolean;
}

export interface WorkerProtocolWorkerIdentity {
  readonly package_version: WorkerProtocolSemVer;
  readonly compiler: WorkerProtocolBuildIdentity;
  readonly build_digest: string;
}

export interface WorkerProtocolSupportedVersionSets {
  readonly abi: readonly WorkerProtocolVersion[];
  readonly language: readonly WorkerProtocolVersion[];
  readonly ir: readonly WorkerProtocolVersion[];
  readonly diagnostic_catalog: readonly WorkerProtocolSemVer[];
  readonly artifact: readonly WorkerProtocolVersion[];
  readonly authoring_bundle: readonly WorkerProtocolSemVer[];
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
  readonly protocol: WorkerProtocolRange;
  readonly sdk: WorkerProtocolBuildIdentity;
  readonly expected_worker: WorkerProtocolExpectedWorker;
  readonly required_features: readonly string[];
  readonly optional_features: readonly string[];
  readonly versions: WorkerProtocolSupportedVersionSets;
  readonly limits: WorkerProtocolOperationalLimits;
}

export interface WorkerProtocolHandshakeSupport {
  readonly protocol: WorkerProtocolRange;
  readonly features: readonly string[];
  readonly worker: WorkerProtocolWorkerIdentity;
  readonly versions: WorkerProtocolSupportedVersionSets;
  readonly limits: WorkerProtocolOperationalLimits;
  readonly implementation: string;
}

export interface WorkerProtocolSessionWelcome {
  readonly protocol: WorkerProtocolVersion;
  readonly features: readonly string[];
  readonly worker: WorkerProtocolWorkerIdentity;
  readonly versions: WorkerProtocolSupportedVersionSets;
  readonly limits: WorkerProtocolOperationalLimits;
  readonly implementation: string;
}

export const WORKER_PROTOCOL_INCOMPATIBILITY_DIMENSIONS = Object.freeze([
  'abi',
  'artifact',
  'authoring_bundle',
  'bundled_worker_version',
  'diagnostic_catalog',
  'ir',
  'language',
  'operational_limit',
  'protocol_major',
  'protocol_minor',
  'required_feature',
  'worker_build_digest',
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

const UINT_SCHEMA = Object.freeze({ kind: 'uint' as const });
const TEXT_SCHEMA = Object.freeze({ kind: 'text' as const, maxBytes: MAX_TEXT_BYTES });
const SHA256_SCHEMA = Object.freeze({ kind: 'text' as const, maxBytes: 64 });

const VERSION_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'major', schema: UINT_SCHEMA }),
    Object.freeze({ name: 'minor', schema: UINT_SCHEMA }),
  ]),
});

const SEMVER_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'major', schema: UINT_SCHEMA }),
    Object.freeze({ name: 'minor', schema: UINT_SCHEMA }),
    Object.freeze({ name: 'patch', schema: UINT_SCHEMA }),
    Object.freeze({ name: 'prerelease', schema: TEXT_SCHEMA, optional: true }),
  ]),
});

const PROTOCOL_RANGE_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'major', schema: UINT_SCHEMA }),
    Object.freeze({ name: 'min_minor', schema: UINT_SCHEMA }),
    Object.freeze({ name: 'max_minor', schema: UINT_SCHEMA }),
  ]),
});

const BUILD_IDENTITY_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'version', schema: SEMVER_SCHEMA }),
    Object.freeze({ name: 'build', schema: TEXT_SCHEMA }),
  ]),
});

const EXPECTED_WORKER_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'package_version', schema: SEMVER_SCHEMA }),
    Object.freeze({ name: 'build_digest', schema: SHA256_SCHEMA }),
    Object.freeze({ name: 'override', schema: Object.freeze({ kind: 'boolean' as const }) }),
  ]),
});

const WORKER_IDENTITY_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'package_version', schema: SEMVER_SCHEMA }),
    Object.freeze({ name: 'compiler', schema: BUILD_IDENTITY_SCHEMA }),
    Object.freeze({ name: 'build_digest', schema: SHA256_SCHEMA }),
  ]),
});

const VERSION_LIST_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'array',
  item: VERSION_SCHEMA,
  maxItems: 64,
});
const SEMVER_LIST_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'array',
  item: SEMVER_SCHEMA,
  maxItems: 64,
});
const FEATURE_LIST_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'array',
  item: Object.freeze({ kind: 'text', maxBytes: 64 }),
  maxItems: 256,
});

const VERSION_SETS_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'abi', schema: VERSION_LIST_SCHEMA }),
    Object.freeze({ name: 'language', schema: VERSION_LIST_SCHEMA }),
    Object.freeze({ name: 'ir', schema: VERSION_LIST_SCHEMA }),
    Object.freeze({ name: 'diagnostic_catalog', schema: SEMVER_LIST_SCHEMA }),
    Object.freeze({ name: 'artifact', schema: VERSION_LIST_SCHEMA }),
    Object.freeze({ name: 'authoring_bundle', schema: SEMVER_LIST_SCHEMA }),
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
    Object.freeze({ name: 'protocol', schema: PROTOCOL_RANGE_SCHEMA }),
    Object.freeze({ name: 'sdk', schema: BUILD_IDENTITY_SCHEMA }),
    Object.freeze({ name: 'expected_worker', schema: EXPECTED_WORKER_SCHEMA }),
    Object.freeze({ name: 'required_features', schema: FEATURE_LIST_SCHEMA }),
    Object.freeze({ name: 'optional_features', schema: FEATURE_LIST_SCHEMA }),
    Object.freeze({ name: 'versions', schema: VERSION_SETS_SCHEMA }),
    Object.freeze({ name: 'limits', schema: OPERATIONAL_LIMITS_SCHEMA }),
  ]),
});

const WELCOME_SCHEMA: WorkerProtocolSchema = Object.freeze({
  kind: 'record',
  fields: Object.freeze([
    Object.freeze({ name: 'protocol', schema: VERSION_SCHEMA }),
    Object.freeze({ name: 'features', schema: FEATURE_LIST_SCHEMA }),
    Object.freeze({ name: 'worker', schema: WORKER_IDENTITY_SCHEMA }),
    Object.freeze({ name: 'versions', schema: VERSION_SETS_SCHEMA }),
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

/** Closed protocol 1.0 payload contracts used before a session becomes ready. */
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

function validSemVer(value: WorkerProtocolSemVer): boolean {
  return (
    uint(value.major) &&
    uint(value.minor) &&
    uint(value.patch) &&
    (value.prerelease === undefined ||
      (validText(value.prerelease) &&
        /^(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*$/.test(
          value.prerelease,
        )))
  );
}

function compareVersion(left: WorkerProtocolVersion, right: WorkerProtocolVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  return 0;
}

function compareSemVer(left: WorkerProtocolSemVer, right: WorkerProtocolSemVer): number {
  const versionOrder = compareVersion(left, right);
  if (versionOrder !== 0) return versionOrder;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

function sortedUnique<T>(values: readonly T[], compare: (left: T, right: T) => number): boolean {
  if (values.length === 0 || values.length > 64) return false;
  for (let index = 1; index < values.length; index++)
    if (compare(values[index - 1] as T, values[index] as T) >= 0) return false;
  return true;
}

function validFeatures(features: readonly string[], allowEmpty: boolean): boolean {
  if (
    (!allowEmpty && features.length === 0) ||
    features.length > 256 ||
    !features.every((feature) => feature.length <= 64 && FEATURE.test(feature))
  )
    return false;
  return features.every((feature, index) => index === 0 || (features[index - 1] as string) < feature);
}

function sameSemVer(left: WorkerProtocolSemVer, right: WorkerProtocolSemVer): boolean {
  return compareSemVer(left, right) === 0 && left.prerelease === right.prerelease;
}

function versionsIntersect<T extends WorkerProtocolVersion>(
  left: readonly T[],
  right: readonly T[],
  compare: (a: T, b: T) => number,
): boolean {
  return left.some((item) => right.some((candidate) => compare(item, candidate) === 0));
}

function validateVersionSets(
  host: WorkerProtocolSupportedVersionSets,
  worker: WorkerProtocolSupportedVersionSets,
  failures: Set<WorkerProtocolIncompatibilityDimension>,
): void {
  for (const dimension of ['abi', 'language', 'ir', 'artifact'] as const) {
    const hostValues = host[dimension];
    const workerValues = worker[dimension];
    if (
      !hostValues.every((item) => uint(item.major) && uint(item.minor)) ||
      !workerValues.every((item) => uint(item.major) && uint(item.minor)) ||
      !sortedUnique(hostValues, compareVersion) ||
      !sortedUnique(workerValues, compareVersion) ||
      !versionsIntersect(hostValues, workerValues, compareVersion)
    )
      failures.add(dimension);
  }
  for (const dimension of ['diagnostic_catalog', 'authoring_bundle'] as const) {
    const hostValues = host[dimension];
    const workerValues = worker[dimension];
    if (
      !hostValues.every(validSemVer) ||
      !workerValues.every(validSemVer) ||
      !sortedUnique(hostValues, compareSemVer) ||
      !sortedUnique(workerValues, compareSemVer) ||
      !versionsIntersect(hostValues, workerValues, compareSemVer)
    )
      failures.add(dimension);
  }
}

function validLimits(limits: WorkerProtocolOperationalLimits): boolean {
  return LIMIT_KEYS.every((key) => uint(limits[key], false)) && limits.max_payload_bytes < limits.max_frame_bytes;
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

function cloneSemVer(value: WorkerProtocolSemVer): WorkerProtocolSemVer {
  return Object.freeze({
    major: value.major,
    minor: value.minor,
    patch: value.patch,
    ...(value.prerelease ? { prerelease: value.prerelease } : {}),
  });
}

function cloneVersionSets(value: WorkerProtocolSupportedVersionSets): WorkerProtocolSupportedVersionSets {
  const versions = (items: readonly WorkerProtocolVersion[]) =>
    Object.freeze(items.map((item) => Object.freeze({ major: item.major, minor: item.minor })));
  const semvers = (items: readonly WorkerProtocolSemVer[]) => Object.freeze(items.map(cloneSemVer));
  return Object.freeze({
    abi: versions(value.abi),
    language: versions(value.language),
    ir: versions(value.ir),
    diagnostic_catalog: semvers(value.diagnostic_catalog),
    artifact: versions(value.artifact),
    authoring_bundle: semvers(value.authoring_bundle),
  });
}

function incompatible(failures: Set<WorkerProtocolIncompatibilityDimension>): WorkerProtocolHandshakeResult {
  const dimensions = Object.freeze([...failures].sort());
  return Object.freeze({
    compatible: false,
    incompatible: Object.freeze({ code: 'incompatible_session' as const, dimensions }),
  });
}

const INCOMPATIBILITY_DIMENSIONS = new Set<string>(WORKER_PROTOCOL_INCOMPATIBILITY_DIMENSIONS);

/** Applies the semantic constraints not expressible by the closed incompatibility payload schema. */
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

/** Selects a session without starting compiler, interpreter, registry, or bridge work. */
export function negotiateWorkerProtocolHandshake(
  hello: WorkerProtocolSessionHello,
  support: WorkerProtocolHandshakeSupport,
): WorkerProtocolHandshakeResult {
  const failures = new Set<WorkerProtocolIncompatibilityDimension>();
  if (!uint(hello.protocol.major) || !uint(support.protocol.major) || hello.protocol.major !== support.protocol.major)
    failures.add('protocol_major');
  const validHostMinors =
    uint(hello.protocol.min_minor) &&
    uint(hello.protocol.max_minor) &&
    hello.protocol.min_minor <= hello.protocol.max_minor;
  const validWorkerMinors =
    uint(support.protocol.min_minor) &&
    uint(support.protocol.max_minor) &&
    support.protocol.min_minor <= support.protocol.max_minor;
  const minimum =
    hello.protocol.min_minor > support.protocol.min_minor ? hello.protocol.min_minor : support.protocol.min_minor;
  const maximum =
    hello.protocol.max_minor < support.protocol.max_minor ? hello.protocol.max_minor : support.protocol.max_minor;
  if (!validHostMinors || !validWorkerMinors || minimum > maximum) failures.add('protocol_minor');

  if (
    !validFeatures(hello.required_features, true) ||
    !validFeatures(hello.optional_features, true) ||
    !validFeatures(support.features, true)
  )
    failures.add('required_feature');
  const supported = new Set(support.features);
  const required = new Set(hello.required_features);
  if (hello.optional_features.some((feature) => required.has(feature))) failures.add('required_feature');
  const requested = new Set([...hello.required_features, ...hello.optional_features]);
  const selectedFeatures = Object.freeze([...requested].filter((feature) => supported.has(feature)).sort());
  if (hello.required_features.some((feature) => !supported.has(feature))) failures.add('required_feature');

  if (!validSemVer(support.worker.package_version)) failures.add('bundled_worker_version');
  if (!validSemVer(support.worker.compiler.version) || !validText(support.worker.compiler.build))
    failures.add('worker_build_digest');
  if (!SHA256.test(support.worker.build_digest) || !validText(support.implementation))
    failures.add('worker_build_digest');
  if (!validSemVer(hello.sdk.version) || !validText(hello.sdk.build)) failures.add('bundled_worker_version');
  if (!validSemVer(hello.expected_worker.package_version)) failures.add('bundled_worker_version');
  if (!SHA256.test(hello.expected_worker.build_digest)) failures.add('worker_build_digest');
  if (!hello.expected_worker.override) {
    if (!sameSemVer(hello.expected_worker.package_version, support.worker.package_version))
      failures.add('bundled_worker_version');
    if (hello.expected_worker.build_digest !== support.worker.build_digest) failures.add('worker_build_digest');
  }

  validateVersionSets(hello.versions, support.versions, failures);
  if (!validLimits(hello.limits) || !validLimits(support.limits)) failures.add('operational_limit');
  const selectedLimits = selectLimits(hello.limits, support.limits);
  if (!validLimits(selectedLimits)) failures.add('operational_limit');
  if (failures.size > 0) return incompatible(failures);

  const welcome: WorkerProtocolSessionWelcome = Object.freeze({
    protocol: Object.freeze({ major: hello.protocol.major, minor: maximum }),
    features: selectedFeatures,
    worker: Object.freeze({
      package_version: cloneSemVer(support.worker.package_version),
      compiler: Object.freeze({
        version: cloneSemVer(support.worker.compiler.version),
        build: support.worker.compiler.build,
      }),
      build_digest: support.worker.build_digest,
    }),
    versions: cloneVersionSets(support.versions),
    limits: selectedLimits,
    implementation: support.implementation,
  });
  return Object.freeze({ compatible: true, welcome });
}

/** Recomputes and validates every worker-selected welcome value against the initiating hello. */
export function validateWorkerProtocolWelcome(
  hello: WorkerProtocolSessionHello,
  welcome: WorkerProtocolSessionWelcome,
): WorkerProtocolHandshakeResult {
  const negotiated = negotiateWorkerProtocolHandshake(hello, {
    protocol: {
      major: welcome.protocol.major,
      min_minor: welcome.protocol.minor,
      max_minor: welcome.protocol.minor,
    },
    features: welcome.features,
    worker: welcome.worker,
    versions: welcome.versions,
    limits: welcome.limits,
    implementation: welcome.implementation,
  });
  if (!negotiated.compatible) return negotiated;

  const failures = new Set<WorkerProtocolIncompatibilityDimension>();
  if (
    negotiated.welcome.protocol.major !== welcome.protocol.major ||
    negotiated.welcome.protocol.minor !== welcome.protocol.minor
  )
    failures.add('protocol_minor');
  if (
    negotiated.welcome.features.length !== welcome.features.length ||
    negotiated.welcome.features.some((feature, index) => feature !== welcome.features[index])
  )
    failures.add('required_feature');
  if (LIMIT_KEYS.some((key) => negotiated.welcome.limits[key] !== welcome.limits[key]))
    failures.add('operational_limit');
  return failures.size === 0 ? negotiated : incompatible(failures);
}

/** Published handshake message kinds, useful to state-machine implementations. */
export const WORKER_PROTOCOL_HANDSHAKE_KINDS: readonly WorkerProtocolMessageKind[] = Object.freeze([
  'session.hello',
  'session.welcome',
  'session.incompatible',
]);
