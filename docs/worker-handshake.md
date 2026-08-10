# Worker handshake

Every worker connection begins with an exact SafeScript 0.6.0 handshake over the [worker protocol](worker-protocol.md). No bridge, action, or close request is accepted before the session reaches `ready`.

## Host hello

The host sends one `session.hello` containing:

- `version`: exactly `0.6.0`;
- `sdk_build`: a bounded implementation identity;
- `expected_worker`: exact version, SHA-256 build digest, and whether an explicit override is in use;
- sorted, unique required and optional feature names;
- requested operational limits.

The bundled worker digest must match exactly. An explicitly configured override may use its operator-approved digest while retaining every other check.

## Worker response

The worker compares the hello with its exact release, feature set, worker/compiler identity, and limits. A compatible worker replies once with `session.welcome`, containing `version`, the selected feature intersection, worker identity, selected limits, and implementation name. Each selected limit is the minimum of the host request, worker maximum, and built-in ceiling.

The host validates the complete welcome and its correlation before entering `ready`. Unknown fields, malformed values, non-canonical encoding, an unexpected reply, or a value outside the hello closes the connection.

## Incompatibility

An incompatible worker replies once with `session.incompatible` and closes normally. Its sorted dimensions are limited to:

- `version` — either peer is not exactly SafeScript 0.6.0;
- `required_feature` — a required feature is unavailable or feature lists are invalid;
- `worker_build_digest` — the bundled worker identity does not match;
- `operational_limit` — operational limits are invalid.

These are diagnostics for the one SafeScript release contract, not independently negotiable compatibility contracts. There is no downgrade, translation, fallback to a different worker, or automatic switch to the in-process bridge.

## Security meaning

A successful handshake selects a bounded transport peer; it does not grant application authority. Every request and outcome remains untrusted, and every effect is revalidated and reauthorised at the host action gateway. See the [security model](security.md) and [worker lifecycle](worker-lifecycle.md).
