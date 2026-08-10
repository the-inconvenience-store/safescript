import { describe, expect, it } from 'bun:test';

import {
  allocationFuel,
  byteFuel,
  hostActionFuel,
  linearFuel,
  scanFuel,
  SEMANTIC_STEP_FUEL,
} from './resource-schedule.js';

describe('release-local additive fuel schedule', () => {
  it('composes semantic, linear, and 16-byte work without operation-specific weights', () => {
    expect(SEMANTIC_STEP_FUEL).toBe(1);
    expect(linearFuel(7)).toBe(7);
    expect([byteFuel(0), byteFuel(1), byteFuel(16), byteFuel(17)]).toEqual([0, 1, 1, 2]);
    expect(allocationFuel(17)).toBe(3);
    expect(scanFuel(7, 17)).toBe(9);
    expect(hostActionFuel(3, 17)).toBe(6);
  });
});
