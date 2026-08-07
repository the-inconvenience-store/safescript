# SafeScript CLI

The CLI is an offline JSON adapter over `@safescript/sdk`. It exposes `check`, `inspect`, `execute`, and `test` and
does not load packages, discover configuration, or grant ambient authority to the program being checked.

```sh
bun apps/cli/src/index.ts check --contract contract.json --input request.json
cat request.json | bun apps/cli/src/index.ts execute --contract contract.json
```

`--contract`, `--input`, and `--output` accept a file or `-`; input and output default to standard input and standard
output. The contract and request cannot both use standard input. Output is exactly one JSON record followed by a
newline. Exit status `0` means an accepted check/inspection, completed execution, or passing deterministic test; `1`
means source diagnostics, execution failure, or a failing test; `2` means invalid CLI input, contract/configuration
misuse, or a bridge error.

The contract file mirrors the SDK contract definition using serialisable type references. `types` is an array of
`{ id, schema }`; operation and slot `input`, `output`, and operation `error` fields contain type IDs. An operation may
map resource-scope fact names to dot-separated input paths with `resourceScope`. Execution and test action scripts use
the SDK `ScriptedAction` shape. No handler modules or credentials are loaded.

Requests use the corresponding SDK request fields. Source modules contain `{ id, source }`. Artifact bytes, seeds,
and canonical byte values use `{ "$bytes": "<base64>" }`; integers outside JSON's safe numeric model use
`{ "$bigint": "<decimal>" }`. Results apply the same encoding, so SDK records remain machine-readable and lossless.
