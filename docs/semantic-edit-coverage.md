# Semantic edit language coverage

SafeScript 0.7.0 treats semantic edit coverage as a language-release invariant. Every accepted source construct is
represented in graph schema 1.0 at an editable grammar boundary, participates in an ordered structural container where
one exists, and is reachable through the six primitive edits. High-level gestures are additional conveniences; they do
not replace primitive coverage.

## Coverage matrix

| Accepted source family                                                                                                                          | Graph facts and structural anchors                                                                                                           | Primitive and gesture coverage                                                                        | Release evidence                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Module, static imports, and import specifiers                                                                                                   | `module`, `import-declaration`, `import-specifier`, module/import/declaration containers, ordered gaps                                       | replace, insert, delete, move, reorder; rename for imported bindings                                  | engine graph 1.0 source-only declaration test; primitive contextual-anchor tests                  |
| Interfaces, aliases, intersections, unions, recursive types, tuples, arrays, function types, type operators, literals, and constrained generics | declaration/type nodes, `type-*` facts, type-member and type-parameter containers                                                            | contextual replacement/insertion, delete, move, reorder                                               | compiler finite-type test; graph source-only declaration test                                     |
| Handler, helper functions, parameters, closures, arrows, recursion, and higher-order callbacks                                                  | `handler`, `function`, `parameter`, `symbol`, binding/reference/type edges, parameter and statement containers                               | rename plus all structural primitives; extract/inline function and local gestures                     | recursive higher-order compiler test; binding/extraction gesture suite                            |
| `const`, `let`, object/tuple destructuring, and reassignment                                                                                    | `variable`, `destructure`, `binding-pattern`, `assign`, symbol/reference edges, declaration and initializer containers                       | rename, replacement, insertion, delete, move, reorder; binding-pattern and mutability gestures        | reassignment and immutable destructuring compiler tests; primitive and binding gesture suites     |
| `if`, exhaustive `switch`, classic `for`, `for..of`, `for..in`, `while`, `do..while`, `break`, `continue`, and `return`                         | `if`, `switch`, `switch-case`, `for-of`, `for-in`, `loop`, branch/case facts, initializer/increment/case/statement containers, control edges | all structural primitives; wrap/move/unwrap range, add/remove branch, and explicit control conversion | all-loop compiler test; control gesture suite; ordered-anchor graph tests                         |
| Literals, names, members, optional access, indexing, unary/binary expressions, conditionals, calls, `await`, `satisfies`, and `as const`        | expression/constant nodes with literal/operator/type facts, argument and increment containers, data edges                                    | contextual replacement plus structural primitives; seven expression gestures                          | expression gesture suite; typed, optional, action, and intrinsic compiler tests                   |
| Arrays, tuples, objects, spreads, templates, object members, and array elements                                                                 | `array`, `array-element`, `object`, `object-member`, `template`, element/member/template containers with ordered gaps                        | replace, insert, delete, move, reorder; object-field gesture                                          | graph source-only declaration test; immutable spread/destructuring test; expression gesture suite |
| Sequential host actions and declared `Result` handling                                                                                          | `host-action`, `result`, action-site/operation/schema facts, input/output/data/control edges                                                 | all applicable primitives; change operation, input-field, result-binding, and result-branch gestures  | host-action gesture suite; direct/process semantic edit conformance                               |
| Slot input/output and return values                                                                                                             | `slot-input`, `slot-output`, `return-value`, type/input/output edges                                                                         | replacement at the source-owned return boundary; no editing of synthetic slot facts                   | graph and adapter conformance corpus                                                              |
| Deterministic intrinsics and collections                                                                                                        | ordinary checked call/member/name/argument facts; no privileged intrinsic edit representation                                                | expression and structural primitives; call/member/operator gestures where applicable                  | Object/string/math, JSON/bytes/time/trace, and immutable collection compiler tests                |

Syntax that is deliberately rejected—ambient modules, dynamic imports, `any`, mutation of canonical values, exceptions,
generated code, regular expressions, classes, generators, promise races, and arbitrary packages—does not receive graph or
edit coverage because it never becomes an accepted SafeScript program.

## Enforced invariants

The release tests enforce these properties together:

- every source-backed public node has an editable UTF-8 boundary;
- every ordered container has contiguous child indices and exactly one anchor at each of its `n + 1` gaps, including
  empty containers;
- binding, reference, type, control, data, input, output, and containment relationships are explicit where applicable;
- `primitiveEditCoverage` reports no uncovered editable node or anchor for both focused and compiler-produced graphs;
- all six primitives and all 24 gestures have success and closed-rejection coverage;
- capability inspection, edit application, malformed requests, exact-revision preconditions, final checking, limits,
  semantic diff relations, repeated determinism, and direct/process parity pass through public boundaries.

The principal executable evidence is in
[`packages/engine/src/index.test.ts`](../packages/engine/src/index.test.ts),
[`packages/engine/src/semantic-primitives.test.ts`](../packages/engine/src/semantic-primitives.test.ts),
[`packages/engine/src/semantic-gestures.test.ts`](../packages/engine/src/semantic-gestures.test.ts),
[`packages/engine/src/semantic-capabilities.test.ts`](../packages/engine/src/semantic-capabilities.test.ts), and
[`conformance/src/index.test.ts`](../conformance/src/index.test.ts). The release-local latency and limit-boundary guard is
defined by [`conformance/evidence/semantic-edit-benchmarks.json`](../conformance/evidence/semantic-edit-benchmarks.json)
and run with `bun run benchmark:semantic-edits`.
