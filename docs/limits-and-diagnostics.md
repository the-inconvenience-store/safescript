# Limits, diagnostics, and execution facts

SafeScript bounds compiler and runtime work with deterministic dimensions that can be serialized and tested across adapters. The standard profiles are ceilings, not targets: contracts, deployments, and individual invocations may lower every value.

## How limits combine

Slot limits are completed against the standard profile. SDK deployment defaults and request-specific limits are then combined by taking the minimum for each dimension. A request cannot raise a slot or deployment ceiling.

Malformed, negative, non-integer, or over-ceiling limits are rejected before the relevant work starts.

## Compile limits

The standard compile profile bounds:

| Dimension               | Standard ceiling |
| ----------------------- | ---------------: |
| Total source bytes      |            1 MiB |
| Bytes per module        |          256 KiB |
| Modules                 |              128 |
| Imports                 |            1,024 |
| Declarations            |           25,000 |
| Syntax nodes            |          500,000 |
| Syntax depth            |              256 |
| Type depth              |              128 |
| Type-instantiation work |          500,000 |
| Diagnostics             |              100 |
| Derived template bytes  |            1 MiB |

Check results report deterministic source bytes, syntax nodes, and type-work usage. Compiler limits apply before or during parsing/checking and return stable source diagnostics where appropriate.

## Execution limits

The standard execution profile bounds:

| Dimension                  | Standard ceiling |
| -------------------------- | ---------------: |
| Fuel                       |          100,000 |
| Allocations                |           10,000 |
| Cumulative allocated bytes |            4 MiB |
| Retained bytes             |            4 MiB |
| Collection items           |           10,000 |
| Call depth                 |               64 |
| Host calls                 |               32 |
| Concurrent actions         |                8 |
| Trace bytes                |          128 KiB |
| Output bytes               |            1 MiB |
| One value depth            |               64 |
| One value nodes            |           32,768 |
| One value bytes            |            1 MiB |

Fuel represents specified language work rather than elapsed time. Charges commit before their protected operation. The normative charges and compatibility rule are in the [V1 semantic resource schedule](v1-resource-schedule.md).

Execution facts report actual fuel, allocations, allocated bytes, peak retained/value/collection/call/concurrency measures, host calls, trace bytes, and output bytes. Resource exhaustion returns the exact exhausted dimension in bounded detail and never causes an implicit retry.

## Semantic graph limits

Graph export is separately bounded to 100,000 nodes, 250,000 edges, and 4 MiB by default. Callers may lower those values. Graph failure does not turn accepted source into rejected source and returns no partial graph.

## Diagnostics

Compiler diagnostics have a stable `SS_...` code, source location, bounded message, optional bounded related locations, and structured repair guidance. Codes describe public source semantics—for example ambient authority, handler shape, unsafe type, floating action, mutation, non-exhaustive switch, or compiler resource exhaustion.

Code and source provenance are the compatibility surface. Rendered message text is intentionally non-normative and capped, so integrations should branch on code rather than matching strings. `diagnosticRepair(code)` supplies a category and safe remediation action without exposing compiler internals.

The closed diagnostic catalog also gives stable meanings and owners to validation, compatibility, artifact, inspection, execution, action, cancellation, hook, and bridge failure codes. Host-defined declared error codes remain contract-owned and are not part of that catalog.

## Result layers

Keep these result layers distinct:

- A **contract-codec failure** means bytes or a host value did not match a schema or value bound.
- A **rejected check** means source did not satisfy the selected contract/language/compile limits.
- A **bridge error** means an invalid or incompatible request, closed adapter, or adapter failure prevented the requested bridge operation.
- A **not-started execution** means source preparation failed before interpretation.
- A **failed execution** means interpretation started and ended with a stable runtime, action, or resource error.
- A **cancelled execution** means cancellation reached started work; facts describe work observed up to termination.
- A typed **declared `Result`** is ordinary extension-level control flow and can still lead to a completed invocation, including an error supplied by `beforeAction`.

Raw implementation exceptions are never part of these records.

## Execution facts

Every started execution returns:

- preparation details for source or artifact mode;
- ordered action records, distinguishing request from resolution;
- bounded trace records and an explicit truncation flag;
- deterministic execution usage;
- through the SDK, the invocation ID.

Facts are in-memory return data. The host may persist them, but SafeScript does not claim they are a durable audit trail. For action semantics, see the [security model](security.md).
