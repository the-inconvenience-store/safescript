// Throwaway prototype for safescript-buy.6.
// Run: node packages/contracts/prototype-encoding.mjs
// Check: node packages/contracts/prototype-encoding.mjs --check

import assert from "node:assert/strict";
import readline from "node:readline";

const utf8 = new TextEncoder();
const text = new TextDecoder("utf-8", { fatal: true });
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

const schemas = {
  int64: { kind: "int64" },
  request: {
    kind: "record",
    fields: [
      ["requestId", { kind: "string" }],
      ["operation", { kind: "string" }],
      ["customerId", { kind: "int64" }],
      ["at", { kind: "instant" }],
      ["payload", { kind: "bytes" }],
    ],
  },
  tree: {
    kind: "variant",
    variants: [
      ["leaf", { kind: "int64" }],
      ["branch", { kind: "list", item: null }],
    ],
  },
};
schemas.tree.variants[1][1].item = schemas.tree;

const examples = {
  "1": [
    "action request",
    schemas.request,
    {
      requestId: "inv_018f:7",
      operation: "crm:create-contact",
      customerId: I64_MAX,
      at: { seconds: 1_775_171_696n, nanos: 123_456_789 },
      payload: Uint8Array.from([0, 1, 254, 255]),
    },
  ],
  "2": ["int64 minimum", schemas.int64, I64_MIN],
  "3": [
    "recursive tree",
    schemas.tree,
    {
      tag: "branch",
      value: [
        { tag: "leaf", value: 1n },
        { tag: "branch", value: [{ tag: "leaf", value: -2n }] },
      ],
    },
  ],
};

function validString(value) {
  if (typeof value !== "string") throw new Error("expected string");
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("lone surrogate");
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("lone surrogate");
    }
  }
  return value;
}

function head(major, value) {
  const n = BigInt(value);
  if (n < 24n) return [Number((BigInt(major) << 5n) | n)];
  if (n <= 0xffn) return [(major << 5) | 24, Number(n)];
  if (n <= 0xffffn) return [(major << 5) | 25, Number(n >> 8n), Number(n & 255n)];
  const width = n <= 0xffff_ffffn ? 4 : 8;
  const out = [(major << 5) | (width === 4 ? 26 : 27)];
  for (let shift = width * 8 - 8; shift >= 0; shift -= 8) out.push(Number((n >> BigInt(shift)) & 255n));
  return out;
}

function encodeValue(schema, value, depth = 0) {
  if (depth > 64) throw new Error("maximum depth exceeded");
  switch (schema.kind) {
    case "int64": {
      if (typeof value !== "bigint" || value < I64_MIN || value > I64_MAX) throw new Error("invalid int64");
      return value >= 0n ? head(0, value) : head(1, -1n - value);
    }
    case "float64": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid float64");
      const bytes = new Uint8Array(9);
      bytes[0] = 0xfb;
      new DataView(bytes.buffer).setFloat64(1, Object.is(value, -0) ? 0 : value);
      return [...bytes];
    }
    case "string": {
      const bytes = utf8.encode(validString(value));
      return [...head(3, bytes.length), ...bytes];
    }
    case "bytes": {
      if (!(value instanceof Uint8Array)) throw new Error("expected bytes");
      return [...head(2, value.length), ...value];
    }
    case "instant":
      if (!value || !Number.isInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999) throw new Error("invalid instant");
      return [...head(4, 2), ...encodeValue(schemas.int64, value.seconds, depth + 1), ...encodeValue(schemas.int64, BigInt(value.nanos), depth + 1)];
    case "list":
      if (!Array.isArray(value)) throw new Error("expected list");
      return [...head(4, value.length), ...value.flatMap((item) => encodeValue(schema.item, item, depth + 1))];
    case "record":
      if (!value || typeof value !== "object") throw new Error("expected record");
      return [...head(4, schema.fields.length), ...schema.fields.flatMap(([name, field]) => encodeValue(field, value[name], depth + 1))];
    case "variant": {
      const index = schema.variants.findIndex(([tag]) => tag === value?.tag);
      if (index < 0) throw new Error("unknown variant");
      return [...head(4, 2), ...encodeValue({ kind: "string" }, value.tag, depth + 1), ...encodeValue(schema.variants[index][1], value.value, depth + 1)];
    }
    default:
      throw new Error(`unsupported schema ${schema.kind}`);
  }
}

function encode(schema, value) {
  return Uint8Array.from(encodeValue(schema, value));
}

class Decoder {
  constructor(bytes, limits = {}) {
    this.bytes = bytes;
    this.offset = 0;
    this.nodes = 0;
    this.maxDepth = limits.maxDepth ?? 64;
    this.maxNodes = limits.maxNodes ?? 10_000;
    if (!(bytes instanceof Uint8Array)) throw new Error("input must be bytes");
    if (bytes.length > (limits.maxBytes ?? 1_000_000)) throw new Error("maximum bytes exceeded");
  }

  byte() {
    if (this.offset >= this.bytes.length) throw new Error("truncated input");
    return this.bytes[this.offset++];
  }

  argument(additional) {
    if (additional < 24) return BigInt(additional);
    const widths = { 24: 1, 25: 2, 26: 4, 27: 8 };
    const width = widths[additional];
    if (!width) throw new Error("indefinite or reserved encoding");
    let value = 0n;
    for (let i = 0; i < width; i++) value = (value << 8n) | BigInt(this.byte());
    const minimum = { 1: 24n, 2: 256n, 4: 65_536n, 8: 4_294_967_296n }[width];
    if (value < minimum) throw new Error("non-preferred integer or length encoding");
    return value;
  }

  itemHead(expectedMajor) {
    const initial = this.byte();
    const major = initial >> 5;
    if (major !== expectedMajor) throw new Error(`wrong CBOR major type: expected ${expectedMajor}, got ${major}`);
    return this.argument(initial & 31);
  }

  value(schema, depth = 0) {
    if (depth > this.maxDepth) throw new Error("maximum depth exceeded");
    if (++this.nodes > this.maxNodes) throw new Error("maximum nodes exceeded");
    switch (schema.kind) {
      case "int64": {
        const initial = this.byte();
        const major = initial >> 5;
        if (major !== 0 && major !== 1) throw new Error("expected int64");
        const unsigned = this.argument(initial & 31);
        const value = major === 0 ? unsigned : -1n - unsigned;
        if (value < I64_MIN || value > I64_MAX) throw new Error("int64 out of range");
        return value;
      }
      case "float64": {
        if (this.byte() !== 0xfb) throw new Error("float64 must use 64-bit encoding");
        const start = this.offset;
        this.offset += 8;
        if (this.offset > this.bytes.length) throw new Error("truncated input");
        const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + start, 8).getFloat64(0);
        if (!Number.isFinite(value)) throw new Error("non-finite float64");
        if (Object.is(value, -0)) throw new Error("negative zero is not canonical");
        return value;
      }
      case "string": {
        const length = Number(this.itemHead(3));
        const end = this.offset + length;
        if (end > this.bytes.length) throw new Error("truncated input");
        const value = text.decode(this.bytes.subarray(this.offset, end));
        this.offset = end;
        return validString(value);
      }
      case "bytes": {
        const length = Number(this.itemHead(2));
        const end = this.offset + length;
        if (end > this.bytes.length) throw new Error("truncated input");
        const value = this.bytes.slice(this.offset, end);
        this.offset = end;
        return value;
      }
      case "instant": {
        if (this.itemHead(4) !== 2n) throw new Error("instant must contain two fields");
        const seconds = this.value(schemas.int64, depth + 1);
        const nanos = this.value(schemas.int64, depth + 1);
        if (nanos < 0n || nanos > 999_999_999n) throw new Error("instant nanoseconds out of range");
        return { seconds, nanos: Number(nanos) };
      }
      case "list": {
        const length = Number(this.itemHead(4));
        if (!Number.isSafeInteger(length) || length > this.maxNodes - this.nodes) throw new Error("maximum nodes exceeded");
        return Array.from({ length }, () => this.value(schema.item, depth + 1));
      }
      case "record": {
        if (this.itemHead(4) !== BigInt(schema.fields.length)) throw new Error("wrong record field count");
        return Object.fromEntries(schema.fields.map(([name, field]) => [name, this.value(field, depth + 1)]));
      }
      case "variant": {
        if (this.itemHead(4) !== 2n) throw new Error("variant must contain tag and value");
        const encodedTag = this.value({ kind: "string" }, depth + 1);
        const entry = schema.variants.find(([tag]) => tag === encodedTag);
        if (!entry) throw new Error("unknown variant tag");
        const [tag, payload] = entry;
        return { tag, value: this.value(payload, depth + 1) };
      }
      default:
        throw new Error(`unsupported schema ${schema.kind}`);
    }
  }
}

function decode(schema, bytes, limits) {
  const decoder = new Decoder(bytes, limits);
  const value = decoder.value(schema);
  if (decoder.offset !== bytes.length) throw new Error("trailing bytes");
  return value;
}

function display(value) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? `${item}n` : item instanceof Uint8Array ? `h'${hex(item)}'` : item, 2);
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function showExample(key) {
  const [name, schema, value] = examples[key];
  const bytes = encode(schema, value);
  const decoded = decode(schema, bytes);
  return `${name}\nlogical: ${display(value)}\nCBOR (${bytes.length} bytes): ${hex(bytes)}\ndecoded: ${display(decoded)}\nresult: ACCEPTED`;
}

const malformed = {
  m: ["non-preferred integer 0", schemas.int64, Uint8Array.from([0x18, 0x00])],
  t: ["valid integer plus trailing byte", schemas.int64, Uint8Array.from([0x00, 0x00])],
  u: ["invalid UTF-8", { kind: "string" }, Uint8Array.from([0x61, 0x80])],
};

function showMalformed(key) {
  const [name, schema, bytes] = malformed[key];
  try {
    decode(schema, bytes);
    return `${name}\nCBOR: ${hex(bytes)}\nresult: INCORRECTLY ACCEPTED`;
  } catch (error) {
    return `${name}\nCBOR: ${hex(bytes)}\nresult: REJECTED (${error.message})`;
  }
}

function check() {
  for (const key of Object.keys(examples)) assert.deepEqual(decode(examples[key][1], encode(examples[key][1], examples[key][2])), examples[key][2]);
  for (const [, schema, bytes] of Object.values(malformed)) assert.throws(() => decode(schema, bytes));
  assert.throws(() => encode({ kind: "string" }, "\ud800"), /lone surrogate/);
  assert.throws(() => decode({ kind: "float64" }, Uint8Array.from([0xfb, 0x80, 0, 0, 0, 0, 0, 0, 0])), /negative zero/);
  console.log("prototype checks passed");
}

if (process.argv.includes("--check")) {
  check();
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const menu = "[1] request  [2] int64  [3] tree  [m] non-preferred  [t] trailing  [u] UTF-8  [q] quit";
  console.log(`SafeScript deterministic encoding prototype\n${menu}`);
  rl.on("line", (input) => {
    const key = input.trim().toLowerCase();
    if (key === "q") return rl.close();
    console.log(`\n${examples[key] ? showExample(key) : malformed[key] ? showMalformed(key) : "unknown command"}\n\n${menu}`);
  });
}
