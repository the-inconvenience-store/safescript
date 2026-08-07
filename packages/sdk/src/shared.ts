import { type BridgeError, type CompileLimits, type ExecutionLimits, type Version } from '@safescript/contracts';

export const ABI_VERSION: Version = Object.freeze({ major: 1, minor: 0 });

export const encodeUtf8 = (value: string): Uint8Array => Buffer.from(value, 'utf8');

export function stable(value: unknown): string {
  if (typeof value === 'bigint') return `{"$bigint":"${value}"}`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('unsupported contract value');
  return encoded;
}

export function completeLimits<T extends CompileLimits | ExecutionLimits>(
  standard: T,
  ...overrides: readonly (Partial<T> | undefined)[]
): T {
  const limits = { ...standard };
  const standardRecord = standard as unknown as Readonly<Record<string, number>>;
  for (const override of overrides) {
    if (!override) continue;
    for (const [name, value] of Object.entries(override)) {
      if (
        typeof value !== 'number' ||
        !(name in standard) ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > (standardRecord[name] as number)
      ) {
        throw new TypeError(`invalid ${name} limit`);
      }
      (limits as unknown as Record<string, number>)[name] = value;
    }
  }
  return Object.freeze(limits) as T;
}

export function freeze<T>(root: T): T {
  const pending: object[] =
    root !== null && (typeof root === 'object' || typeof root === 'function') ? [root as object] : [];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop() as object;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(value);
  }
  return root;
}

export function bridgeError(phase: BridgeError['phase'], code: BridgeError['code'] = 'adapter_failure'): BridgeError {
  return Object.freeze({ code, phase });
}
