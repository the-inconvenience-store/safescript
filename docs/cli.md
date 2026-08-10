# Command-line interface

`@safescript/cli` is an offline JSON adapter over the public TypeScript SDK. It exposes `check`, `inspect`, `execute`, and deterministic `test` without package loading, configuration discovery, handler modules, credentials, or ambient authority.

The CLI follows the SDK's worker-backed default, verifies the pinned worker before use, and closes it before exit. Worker lifecycle failures produce the ordinary stable bridge-error JSON record and exit status `2`; the CLI never retries or switches to direct mode.

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
- operation allow-lists, costs, idempotency, and limits remain declarative JSON values.

The CLI cannot load executable policy or handlers. Execution and tests therefore use the deterministic scripted-action shape from the SDK. This makes the CLI useful for offline checking, inspection, corpus tests, and machine integration, not production host dispatch or host-policy testing.

## Lossless JSON conventions

Source modules contain `{ id, source }`. Values that JSON cannot represent directly use tagged objects:

- bytes, artifacts, and seeds: `{ "$bytes": "<base64>" }`;
- integers outside JSON's safe number model: `{ "$bigint": "<decimal>" }`.

Results use the same conventions so canonical values and SDK records remain lossless.

For the host-native integration, use the [SDK guide](sdk.md). For deterministic action scripts, see [testing](testing.md).
