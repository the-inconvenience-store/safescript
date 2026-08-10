/** Default deterministic bounds for one bridge-local verified-compilation cache. */
export const STANDARD_COMPILATION_CACHE_LIMITS = Object.freeze({
  maxEntries: 64,
  maxWeight: 16 * 1024 * 1024,
});

/** Deterministic entry-count and approximate retained-weight bounds. */
export interface CompilationCacheLimits {
  readonly maxEntries: number;
  readonly maxWeight: number;
}

interface Entry<T> {
  readonly value: T;
  readonly weight: number;
}

/** Private bounded LRU with one shared compilation promise per key. */
export class CompilationCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly pending = new Map<string, Promise<T>>();
  private weight = 0;
  private generation = 0;

  constructor(private readonly limits: CompilationCacheLimits) {
    if (
      !Number.isSafeInteger(limits.maxEntries) ||
      limits.maxEntries < 0 ||
      !Number.isSafeInteger(limits.maxWeight) ||
      limits.maxWeight < 0
    )
      throw new TypeError('invalid compilation cache limits');
  }

  getOrLoad(key: string, load: () => Promise<T> | T, weightOf: (value: T) => number | undefined): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return Promise.resolve(cached.value);
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const pending = Promise.resolve()
      .then(load)
      .then((value) => {
        const weight = weightOf(value);
        if (generation === this.generation && weight !== undefined) this.store(key, value, weight);
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      });
    this.pending.set(key, pending);
    return pending;
  }

  clear(): void {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
    this.weight = 0;
  }

  private store(key: string, value: T, weight: number): void {
    if (
      this.limits.maxEntries === 0 ||
      this.limits.maxWeight === 0 ||
      !Number.isSafeInteger(weight) ||
      weight < 0 ||
      weight > this.limits.maxWeight
    )
      return;
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.weight -= previous.weight;
    }
    this.entries.set(key, { value, weight });
    this.weight += weight;
    while (this.entries.size > this.limits.maxEntries || this.weight > this.limits.maxWeight) {
      const oldest = this.entries.entries().next().value as [string, Entry<T>] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.weight -= oldest[1].weight;
    }
  }
}
