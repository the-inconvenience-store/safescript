# Semantic resource schedule

This document locks the current SafeScript semantic resource schedule. The
machine-checked reference ledgers live in `conformance/src/resources.ts`; the
conformance suite measures them only through `RuntimeBridge` and therefore
applies unchanged to direct and future process adapters.

For an explanation of how hosts configure these ceilings and read resource
facts, see [limits, diagnostics, and execution facts](limits-and-diagnostics.md).

## Fuel schedule

Fuel is semantic work, not elapsed time or JavaScript-engine instruction count.
Charges commit before the operation they protect, so exhaustion cannot expose a
partial allocation or action group.

| Operation                                 |                                                   Fuel charge |
| ----------------------------------------- | ------------------------------------------------------------: |
| IR instruction or terminator              |                                                             1 |
| Structured expression or statement        |                                                             1 |
| Checked function entry                    |                                                             5 |
| `for..of` or `for..in` iteration          |                                                             3 |
| `while`, `do`, or classic `for` iteration |                                                             2 |
| Allocation                                |                                4 + ceil(canonical bytes / 16) |
| Equality/value scan                       |             2 per canonical node + ceil(canonical bytes / 16) |
| Host action                               | 100 + registered effect cost + ceil(encoded input bytes / 16) |
| Output commit                             |                           1 + ceil(encoded output bytes / 16) |
| Linear collection copy/traversal          |                                                    2 per item |
| Callback collection traversal             |                                2 per item, plus checked calls |
| Insertion-sort comparison                 |                                                             3 |
| Ordinary math intrinsic / random          |                                                             4 |
| Transcendental math intrinsic             |                                                            32 |
| Fixed clock read                          |                                                             8 |
| Console trace event                       |                                                             5 |
| JSON parse                                |         ceil(UTF-8 input bytes / 8), plus scan and allocation |

Canonical allocation bytes are charged cumulatively. The budget never credits
values as released. This deliberately conservative model avoids depending on
garbage-collector behaviour.

## Standard profile rationale

The highest positive reference workload consumes 1,013 fuel, 32 allocations,
758 allocated bytes, four collection items, call depth four, four host calls,
two concurrent actions, 3,187 trace bytes, and five output bytes. The locked
standard profile leaves at least 64x fuel headroom, 16x call-depth headroom, 8x
host-call headroom, and 41x trace headroom. Byte and collection ceilings remain
large enough for realistic extension inputs while bounding hostile work to
1 MiB values/output, 4 MiB cumulative allocation, and 10,000 collection items.

The profile is a maximum: hosts and slots should lower individual dimensions to
fit their domain. Effect/capability summaries do not authorise work. The host
decides whether current policy runs in a hook, handler, downstream service, or
several layers, and reauthorises each operation at the gateway.

## Release rule

Any change to a charge above, the standard profile, or a locked reference ledger
is a semantic compatibility change. It must intentionally update the evidence,
pass the positive ledger comparisons and hostile atomic-boundary cases, and be
verified against every shipped runtime adapter before release.
