# SafeScript v2 specification

SafeScript v2 makes the supervised local [runtime worker](../../CONTEXT.md#runtime-worker) the default execution path for the TypeScript SDK. SafeScript source remains canonical, every host action crosses the validated host gateway, and process failure never causes implicit replay. Host policy is optional and remains host-owned through the SDK's [execution and action hooks](../proposals/action-hooks.md); no hook or host context crosses the worker boundary.

## Normative protocol 1.0

- [Wire protocol](wire-protocol.md)
- [Handshake and compatibility](handshake-and-compatibility.md)
- [State machine and lifecycle](state-machine-and-lifecycle.md)
- [Security boundary](security.md)
- [Limits and failures](limits-and-failures.md)
- [Runtime worker distribution and SDK behavior](distribution-and-sdk.md)
- [Compatibility and migration](migration.md)
- [Conformance](conformance.md)
- [CDDL schema](worker-protocol-1.0.cddl)
- [Fixture manifest](../../conformance/worker-protocol/v1/manifest.json)
- [Golden and hostile fixtures](../../conformance/worker-protocol/v1/fixtures.json)

These documents, the CDDL, and the fixtures are normative. Existing language, IR, ABI, canonical-value, diagnostic, and semantic-resource specifications remain independently versioned and are incorporated by reference where named.

## Guidance

The existing [SDK guide](../sdk.md), [security model](../security.md), and [testing guide](../testing.md) remain explanatory integration guidance until updated for the v2 release. Examples and deployment recipes are non-normative.
