# SafeScript language guide

SafeScript source looks like TypeScript but has SafeScript semantics. TypeScript supplies parsing and source locations; the SafeScript compiler owns the accepted syntax, type behavior, effects, lowering, and execution model. Code that `tsc` accepts may still be invalid SafeScript.

The language version is selected by the host slot. This repository supports language 1.0 and the additive 1.1 profile.

## Program shape

An extension has one named exported async handler with typed input and `Context` parameters. Its result is `Promise<Result<void, E>>`, where `E` is the slot's declared error type.

```ts
import { Err, Ok, type Result } from 'safescript:prelude';
import { type Context, type CrmEvent, type CrmActionError } from 'host:api';

export async function handle(event: CrmEvent, ctx: Context): Promise<Result<void, CrmActionError>> {
  const result = await ctx.tasks.create({
    workspaceId: event.workspaceId,
    entityId: event.dealId,
    value: `Review ${event.name}`,
  });
  if (result.tag === 'error') return Err(result.value);
  return Ok();
}
```

Imports are static and can only refer to:

- generated `host:api` declarations;
- `Ok`, `Err`, and `Result` from `safescript:prelude`;
- modules included in the submitted source program (language 1.1).

There is no package resolver or filesystem module lookup. Dynamic imports are rejected.

## Language 1.0

Language 1.0 is the small core profile. It supports:

- readonly records and closed tagged unions;
- `const` local bindings;
- `if`, exhaustive `switch`, short-circuit boolean logic, and `return`;
- same-type equality and ordered numeric comparisons;
- checked integer and floating-point arithmetic;
- bounded string templates over supported scalar values;
- exact record construction and field projection;
- one direct, sequential host action awaited exactly once;
- `Ok(...)` and `Err(...)` construction.

The 1.0 module contains imports and exactly one handler. It rejects helper functions, loops, recursion, mutable bindings, arrays as a general collection surface, and concurrent actions.

## Language 1.1

Language 1.1 adds structured control and deterministic library features while retaining the same security boundary:

- typed helper functions, arrow functions, closures, recursion, and higher-order callbacks;
- finite interfaces, aliases, intersections, recursive types, tuples, and monomorphic constrained generics;
- local `let` variables and reassignment, without mutation of canonical object or array values;
- classic `for`, `for..of`, `for..in`, `while`, and `do..while`, including `break` and `continue`;
- readonly arrays and tuples, indexing, object/array spread, and object/tuple destructuring;
- optional fields, optional access, `undefined` checks, and `??`, lowered to canonical option absence;
- conditional expressions and the broader checked arithmetic/comparison surface;
- multiple sequential host actions;
- `Promise.all` over a statically known, bounded action group;
- registered multi-module source programs;
- deterministic collection, string, object, math, bytes, time, JSON, numeric parsing, and trace intrinsics.

All loops, recursion, allocations, collection work, calls, and action groups are bounded at runtime. Source does not need a statically known loop count, but it cannot exceed the invocation's fuel, call-depth, collection, or allocation ceilings.

## Host actions and `Result`

Host operations appear as methods under `ctx`, arranged from operation IDs. A call is an effectful action, not an ordinary JavaScript promise:

- call it through a direct declared `ctx` path;
- await it exactly once;
- handle the returned `Result`;
- do not float, duplicate, race, or hide the action in unsupported control flow.

`Promise.all([actionA, actionB])` is the only concurrent action form. The inputs must be statically known. Capacity and fuel for the whole group are reserved before any request is exposed; results preserve input order even when host completions arrive out of order. `Promise.race` and related competition are rejected.

A host may stop a validated action in `beforeAction` with any value from that operation's declared error schema. The interpreter resumes extension code with that ordinary `Result`. A malformed outcome or host failure terminates execution instead. The language does not expose hooks or define a universal authorization-error shape.

## Deterministic values and intrinsics

SafeScript values are immutable canonical data, not JavaScript objects with identity or prototypes. Supported schema values include unit, booleans, signed 64-bit integers, finite float64 values, strings, bytes, instants, lists, tuples, records, tagged variants, and primitive brands.

Language 1.1 provides these checked deterministic intrinsics:

| Area    | Current surface                                                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arrays  | `Array.isArray`, `Array.from`, `join`, `with`, `toReversed`, `toSpliced`, stable `toSorted`, `map`, `filter`, `flatMap`, `find`, `some`, `every`, `reduce`, `includes`, `slice`, `concat` |
| Objects | `Object.keys`, `Object.values`, `Object.entries`, `Object.hasOwn`, `Object.fromEntries`                                                                                                   |
| Strings | `includes`, `startsWith`, `endsWith`, Unicode-scalar `slice`, `trim`, `toUpperCase`, `toLowerCase`                                                                                        |
| Math    | `abs`, `ceil`, `floor`, `round`, `trunc`, `sqrt`, `cbrt`, `pow`, `exp`, `log`, `log2`, `log10`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `min`, `max`, seeded `random`       |
| Parsing | `parseInt64`, `parseFloat64`, checked `JSON.parse<T>`, deterministic `JSON.stringify`                                                                                                     |
| Bytes   | `Bytes.fromUtf8`, checked `Bytes.toUtf8`, `Bytes.fromHex`                                                                                                                                 |
| Time    | `Temporal.Instant.from`, `Temporal.Instant.compare`, instant `toString`, `Temporal.Now.instant`                                                                                           |
| Trace   | `console.log`, `console.info`, `console.warn`, `console.error`                                                                                                                            |

`JSON.parse<T>()` returns `Result<T, SafeScriptJsonError>` rather than unchecked `T`. Checked numeric, UTF-8, and instant parsing similarly report the declared error form where the authoring declarations specify one. Console methods create bounded semantic trace records rather than writing to the host console.

The slot-scoped host declarations and a compact deterministic-global declaration set are available through an [authoring bundle](artifacts-and-inspection.md#authoring-bundles). The compiler remains the authority for accepted source; this guide records the complete current intrinsic surface.

## Time and randomness

SafeScript has no ambient clock or entropy source. If the program calls `Temporal.Now.instant()`, execution must provide `fixedInstant`; otherwise execution fails with `fixed_instant_required`. If it calls `Math.random()`, execution must provide `randomSeed`; otherwise it fails with `random_seed_required`.

The same inputs produce repeatable values. This supports deterministic tests, but a host must choose production seeds appropriately for its domain.

## Important TypeScript differences

- `any`, unchecked assertions, and unsafe types are rejected. `as const` is accepted where it preserves checked finite structure.
- `null` is not the optional-value model. Optional fields and `undefined` checks lower to a canonical `none | some` representation.
- Objects and arrays are immutable values. Mutating methods such as `reverse()` and property assignment are rejected; use non-mutating replacements such as `toReversed()` and `with()`.
- Classes, prototypes, reflection, regular expressions, generators, exceptions, and generated code are unavailable.
- Locale-sensitive behavior is unavailable because it can vary by runtime or deployment.
- JavaScript numeric accidents are not inherited: int64 overflow, non-finite floats, and invalid arithmetic fail explicitly.
- `console` is trace collection, not ambient I/O.
- Static module names do not cause package or file loading; every non-built-in module must be supplied in the request.
- A contract `int64` is a `bigint` in host SDK values and canonical encoding, but generated extension declarations expose it as checked `number` syntax. The compiler and runtime preserve the signed 64-bit range and reject overflow.

## Always prohibited

Programs cannot access files, sockets, HTTP clients, processes, environment variables, packages, credentials, timers, or host objects unless a host exposes a specific typed operation. They also cannot use exceptions, `eval`, `Function`, dynamic imports, regex, classes, mutable module state, `Map`, `Set`, promise races, or arbitrary callbacks.

For the boundary around those rules, read the [security model](security.md). For resource behavior, read [limits and diagnostics](limits-and-diagnostics.md).
