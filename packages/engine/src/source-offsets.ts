/** UTF-8 source coordinates derived from TypeScript's UTF-16 code-unit positions. */
import type { ModuleId, SourceLocation } from '@safescript/contracts';

/**
 * Immutable conversion index for one source string.
 *
 * TypeScript reports offsets in UTF-16 code units, while SafeScript transports canonical UTF-8 bytes. Building the
 * prefix table once keeps every later conversion constant-time and gives all compiler projections one coordinate
 * convention. TypeScript node boundaries never split a surrogate pair; an interior offset is defensively mapped to
 * the beginning of that code point.
 *
 * @internal
 */
export class Utf8SourceIndex {
  readonly #bytesAtCodeUnit: Uint32Array;

  constructor(source: string) {
    this.#bytesAtCodeUnit = new Uint32Array(source.length + 1);
    let codeUnit = 0;
    let bytes = 0;
    for (const character of source) {
      this.#bytesAtCodeUnit[codeUnit] = bytes;
      if (character.length === 2) this.#bytesAtCodeUnit[codeUnit + 1] = bytes;
      codeUnit += character.length;
      const point = character.codePointAt(0) as number;
      bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      this.#bytesAtCodeUnit[codeUnit] = bytes;
    }
  }

  /** Converts one half-open TypeScript span to UTF-8 byte offsets. */
  span(start: number, end: number): Readonly<{ start: number; end: number }> {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= this.#bytesAtCodeUnit.length
    )
      throw new RangeError('invalid TypeScript source span');
    return Object.freeze({ start: this.#bytesAtCodeUnit[start] as number, end: this.#bytesAtCodeUnit[end] as number });
  }

  /** Converts one TypeScript span into the public module-qualified source location. */
  location(module: ModuleId, start: number, end: number): SourceLocation {
    return Object.freeze({ module, ...this.span(start, end) });
  }
}
