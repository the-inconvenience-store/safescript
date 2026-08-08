# Command-line interface

`@safescript/cli` is an offline JSON adapter over the public TypeScript SDK. It exposes `check`, `inspect`, `execute`, and deterministic `test` without package loading, configuration discovery, handler modules, credentials, or ambient authority.

## Run it

```sh
bun apps/cli/src/index.ts check --contract contract.json --input request.json
cat request.json | bun apps/cli/src/index.ts execute --contract contract.json
```

`--contract`, `--input`, and `--output` accept a path or `-`. Input and output default to standard input and output; contract and request cannot both consume standard input. Output is exactly one JSON record followed by a newline.

## Exit status

- `0`: accepted check/inspection, completed execution, or passing deterministic test;
- `1`: source rejection, execution failure, or failing deterministic test;
- `2`: invalid CLI input, invalid contract/configuration, or bridge failure.

Always inspect the JSON status as well as the process status when an integration needs the detailed failure domain.

## Contract files

The contract JSON mirrors the SDK definition using serializable references:

- `types` is an array of `{ id, schema }`;
- operation `input`, `output`, and `error` fields contain type IDs;
- slot `input` and `output` fields contain type IDs;
- an operation's `resourceScope` maps output fact names to dot-separated paths within validated input.

The CLI cannot load executable `resourceScope` functions or handlers. Execution and tests therefore use the deterministic scripted-action shape from the SDK. This makes the CLI useful for offline checking, inspection, corpus tests, and machine integration, not production host dispatch.

## Lossless JSON conventions

Source modules contain `{ id, source }`. Values that JSON cannot represent directly use tagged objects:

- bytes, artifacts, and seeds: `{ "$bytes": "<base64>" }`;
- integers outside JSON's safe number model: `{ "$bigint": "<decimal>" }`.

Results use the same conventions so canonical values and SDK records remain lossless.

For the host-native integration, use the [SDK guide](sdk.md). For deterministic action scripts, see [testing](testing.md).
