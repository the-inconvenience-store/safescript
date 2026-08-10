import { describe, expect, it } from 'bun:test';

import { CompilationCache } from './compilation-cache.js';

describe('bounded compilation cache', () => {
  it('shares concurrent misses and does not retain rejected loads', async () => {
    const cache = new CompilationCache<Readonly<{ accepted: boolean; value: number }>>({
      maxEntries: 2,
      maxWeight: 2,
    });
    let loads = 0;
    const load = async (accepted: boolean) => {
      loads++;
      await Promise.resolve();
      return { accepted, value: loads };
    };
    const weight = (value: Readonly<{ accepted: boolean }>) => (value.accepted ? 1 : undefined);
    const [first, second] = await Promise.all([
      cache.getOrLoad('accepted', () => load(true), weight),
      cache.getOrLoad('accepted', () => load(true), weight),
    ]);
    expect(first).toBe(second);
    expect(loads).toBe(1);
    await cache.getOrLoad('accepted', () => load(true), weight);
    expect(loads).toBe(1);
    await cache.getOrLoad('rejected', () => load(false), weight);
    await cache.getOrLoad('rejected', () => load(false), weight);
    expect(loads).toBe(3);
  });

  it('evicts least-recently-used entries by count and weight and clears retained values', async () => {
    const cache = new CompilationCache<number>({ maxEntries: 2, maxWeight: 2 });
    let loads = 0;
    const load = (value: number) => () => {
      loads++;
      return value;
    };
    await cache.getOrLoad('a', load(1), () => 1);
    await cache.getOrLoad('b', load(2), () => 1);
    await cache.getOrLoad('a', load(1), () => 1);
    await cache.getOrLoad('c', load(3), () => 1);
    await cache.getOrLoad('b', load(2), () => 1);
    expect(loads).toBe(4);
    cache.clear();
    await cache.getOrLoad('a', load(1), () => 1);
    expect(loads).toBe(5);
    await cache.getOrLoad('oversized', load(4), () => 3);
    await cache.getOrLoad('oversized', load(4), () => 3);
    expect(loads).toBe(7);
  });
});
