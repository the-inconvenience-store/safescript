/** Release-local additive semantic fuel rules. */
export const SEMANTIC_STEP_FUEL = 1;

/** Charges bounded linear work once per visited item or canonical node. */
export const linearFuel = (items: number): number => items;

/** Charges bounded byte work in deterministic 16-byte units. */
export const byteFuel = (bytes: number): number => Math.ceil(bytes / 16);

/** Charges one allocation step plus its canonical byte work. */
export const allocationFuel = (bytes: number): number => SEMANTIC_STEP_FUEL + byteFuel(bytes);

/** Charges one canonical-node visit plus canonical byte work. */
export const scanFuel = (nodes: number, bytes: number): number => linearFuel(nodes) + byteFuel(bytes);

/** Charges one action step, its declared effect cost, and encoded input byte work. */
export const hostActionFuel = (effectCost: number, inputBytes: number): number =>
  SEMANTIC_STEP_FUEL + effectCost + byteFuel(inputBytes);
