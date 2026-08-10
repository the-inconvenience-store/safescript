# Contracts and canonical values

The host contract is the single source of truth for what an extension can receive, return, and request. `defineContract` validates and freezes that definition, then derives the registry, generated TypeScript declarations, schema codecs, and structural fingerprint used by the SDK and engine.

## Stable identities

SafeScript uses explicit prefixed IDs for contracts, types, operations, slots, and modules. For example:

```ts
ids.contract('contract:crm');
ids.type('type:crm.deal');
ids.operation('operation:tasks.create');
ids.slot('slot:crm.automation');
ids.module('module:main');
```

Names are validated, ASCII, bounded, and serialized as strings. Source declarations, action sites, source programs, IR, and artifacts receive domain-separated SHA-256 identities derived from canonical bytes. An invocation ID is opaque and unique for active execution; a request ID adds an action sequence. These identities provide correlation and provenance, not deduplication.

## Schema language

Every value crossing a contract boundary has a closed schema:

| Schema    | Host representation                             | Notes                                    |
| --------- | ----------------------------------------------- | ---------------------------------------- |
| `unit`    | `null`                                          | Used for `void` payloads                 |
| `boolean` | `boolean`                                       | Canonical true/false                     |
| `int64`   | `bigint`                                        | Signed 64-bit, optional bounds           |
| `float64` | `number`                                        | Finite only, optional bounds             |
| `string`  | `string`                                        | Valid Unicode, optional UTF-8 byte bound |
| `bytes`   | readonly bytes                                  | Optional length bound                    |
| `instant` | `{ epochSeconds: bigint, nanoseconds: number }` | Optional inclusive bounds                |
| `list`    | readonly homogeneous array                      | Optional item bound                      |
| `tuple`   | readonly fixed-length array                     | Heterogeneous positions                  |
| `record`  | readonly plain record                           | Exact named fields; no extras            |
| `variant` | `{ tag, value }`                                | Closed discriminated union               |
| `brand`   | primitive value                                 | Nominal type with no wrapper             |
| `ref`     | referenced named type                           | Supports validated finite recursion      |

`optionSchema(value)` creates `none | some`; `resultSchema(value, error)` creates `ok | error`. Named recursive schemas are allowed only when they have a finite inhabitant. Reference-only cycles and object recursion not routed through named references are rejected.

Generated extension declarations render `int64` as checked TypeScript `number` syntax for authoring, while host values and canonical encoding use `bigint`. The compiler and interpreter enforce the signed 64-bit range. Unit similarly appears as `void` in authoring declarations and `null` in host/canonical values.

## Canonical encoding

The contracts package encodes and decodes values with a deterministic, schema-directed CBOR profile. It rejects malformed bytes, alternate non-canonical encodings, trailing data, unknown fields, missing fields, invalid Unicode, non-finite numbers, sparse arrays, accessor properties, and values outside configured depth/node/byte bounds.

Canonical encoding provides stable cross-language bytes and prevents JavaScript object identity or insertion order from entering the typed boundary. The SDK codecs exposed on `contract.codecs` wrap the same validation for host types and throw a `TypeError` on misuse; the lower-level contract functions return a structured success/failure union.

JSON without a closed target schema uses a bounded tagged `JsonValue`. JSON objects are represented as sorted key/value pairs, not arbitrary host objects. In extension code, `JSON.parse<T>` performs checked conversion and returns `Result`.

## Operations

An operation declares:

- a stable operation ID;
- input, successful output, and error types;
- non-negative semantic effect cost.

Operation error types are entirely contract-owned. They do not require a `policy` variant or any other universal wrapper. A configured `beforeAction` hook that stops dispatch must provide a value from the matched operation's declared error schema, so extension code receives an ordinary typed `Err`.

## Slots

A slot is a host-owned extension entry point. It fixes:

- input and output types;
- allowed operation IDs;
- optional compile and execution ceilings.

An operation is statically eligible only when its operation ID occurs in the slot. Slot, deployment, and invocation limits are combined by taking the minimum for every dimension, so a caller can lower but never raise a host ceiling.

Effect and capability IDs are not part of the current contract. Reachable operations provide the implemented static summary, and the host reauthorizes each concrete operation at runtime. Hosts migrating from the old shape must replace operation `effect` and `capability` fields plus slot `effects` and `capabilities` lists with one slot `operations` list. Derived registries, worker messages, and artifacts must be regenerated; SafeScript does not translate the old shape.

## Derived contract products

`defineContract` produces:

- a deeply frozen language-neutral registry;
- a structural contract fingerprint and definition fingerprints;
- TypeScript declarations for `host:api`;
- one canonical codec per named type;
- the original typed operation and slot tables.

The registry contains metadata and schemas, not live handlers, hooks, credentials, host context, or cached policy decisions. It is safe to send through the runtime bridge, but it is still validated at every trust seam.

The [SDK guide](sdk.md) shows how the derived products are used. The [artifacts guide](artifacts-and-inspection.md) explains exact registry and source-compilation binding.
