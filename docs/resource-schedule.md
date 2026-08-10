# Semantic resource schedule

This document defines the SafeScript semantic resource schedule for the current
release. The conformance suite measures resource use only through
`RuntimeBridge`, so it can check deterministic behavior, bounds, and exhaustion
for direct and process adapters without making exact positive totals a
cross-release compatibility contract.

For an explanation of how hosts configure these ceilings and read resource
facts, see [limits, diagnostics, and execution facts](limits-and-diagnostics.md).

## Fuel schedule

Fuel is semantic work, not elapsed time or JavaScript-engine instruction count.
Charges commit before the operation they protect, so exhaustion cannot expose a
partial allocation or action request.

The schedule uses three additive units:

| Work unit     |      Fuel charge |
| ------------- | ---------------: |
| Semantic step |                1 |
| Linear work   |       1 per item |
| Byte work     | ceil(bytes / 16) |

A semantic step includes a verified expression, statement, function entry,
loop iteration, intrinsic operation, allocation, action, or output commit.
Operations compose the units they use:

| Operation                 |                                         Fuel charge |
| ------------------------- | --------------------------------------------------: |
| Allocation                |                      1 + ceil(canonical bytes / 16) |
| Equality/value scan       |        canonical nodes + ceil(canonical bytes / 16) |
| Host action               | 1 + registered effect cost + ceil(input bytes / 16) |
| Output commit             |                         1 + ceil(output bytes / 16) |
| Collection traversal      |                                  1 per visited item |
| Callback traversal        |              1 per item, plus checked function work |
| Insertion-sort comparison |                                                   1 |
| JSON parse                |    input byte work, plus result scan and allocation |

Canonical allocation bytes are charged cumulatively. The budget never credits
values as released. This deliberately conservative model avoids depending on
garbage-collector behaviour.

## Standard profile rationale

The standard profile is a conservative product maximum, not a calibration of
permanent operation prices. Separate ceilings bound fuel, allocation count and
bytes, collection size, call depth, host calls, concurrency, traces, values,
and output. Hosts and slots should lower individual dimensions to fit their
domain. Reachable-operation summaries do not authorise work. The host
decides whether current policy runs in a hook, handler, downstream service, or
several layers, and reauthorises each operation at the gateway.

## Release rule

Fuel totals and exact exhaustion points are deterministic within one SafeScript
release. The SafeScript release identifies the schedule; there is no separate
schedule version. Exact totals can change in a later release without becoming a
language compatibility break.

Schedule changes must still be intentional. They must preserve fail-before-work
and atomic reservation, update release-local evidence, pass deterministic
exhaustion and hostile-boundary tests, and behave equivalently in every runtime
adapter shipped in that release. Exact cross-release totals become normative
only when an independent backend, artifact-portability requirement, billing
model, or production policy demonstrates that need.
