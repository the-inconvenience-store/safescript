import {
  decodeWorkerProtocolPayload,
  encodeWorkerProtocolPayload,
  type ActionOutcome,
  type ActionRequest,
  type CancelRequest,
  type CancelResult,
  type CheckRequest,
  type CheckResult,
  type CloseResult,
  type ExecuteRequest,
  type ExecutionResult,
  type InspectRequest,
  type InspectResult,
  type ApplySemanticEditsRequest,
  type ApplySemanticEditsResult,
  type WorkerProtocolCodecResult,
  type WorkerProtocolCodecLimits,
  type WorkerProtocolMessageKind,
  type WorkerProtocolPayload,
  type WorkerProtocolSchema,
} from '@safescript/contracts';

const MAX_TEXT = 4096;
const MAX_ITEMS = 1_000_000;
const MAX_BYTES = 16_700_000;

const boolean = (): WorkerProtocolSchema => ({ kind: 'boolean' });
const uint = (): WorkerProtocolSchema => ({ kind: 'uint' });
const float64 = (): WorkerProtocolSchema => ({ kind: 'float64' });
const text = (maxBytes = MAX_TEXT): WorkerProtocolSchema => ({ kind: 'text', maxBytes });
const bytes = (maxBytes = MAX_BYTES): WorkerProtocolSchema => ({ kind: 'bytes', maxBytes });
const literal = (value: null | boolean | bigint | string): WorkerProtocolSchema => ({ kind: 'literal', value });
const array = (item: WorkerProtocolSchema, maxItems = MAX_ITEMS): WorkerProtocolSchema => ({
  kind: 'array',
  item,
  maxItems,
});
const record = (
  fields: readonly Readonly<{ name: string; schema: WorkerProtocolSchema; optional?: boolean }>[],
): WorkerProtocolSchema => ({ kind: 'record', fields });
const oneOf = (...choices: WorkerProtocolSchema[]): WorkerProtocolSchema => ({ kind: 'oneOf', choices });
const messageId: WorkerProtocolSchema = { kind: 'uint', minimum: 1n };
const epochSeconds: WorkerProtocolSchema = { kind: 'int' };
const schemaInt: WorkerProtocolSchema = { kind: 'int' };

const instant = record([
  { name: 'epoch_seconds', schema: epochSeconds },
  { name: 'nanoseconds', schema: { kind: 'uint', maximum: 999_999_999n } },
]);
const sourceLocation = record([
  { name: 'module', schema: text() },
  { name: 'start', schema: uint() },
  { name: 'end', schema: uint() },
]);
const compilerVersion = record([{ name: 'build', schema: text() }]);
const version = record([
  { name: 'major', schema: uint() },
  { name: 'minor', schema: uint() },
]);
const compileLimits = record(
  ['source_bytes', 'imports', 'declarations', 'syntax_nodes', 'syntax_depth', 'type_depth', 'derived_template_bytes']
    .map((name) => ({ name, schema: uint() }))
    .concat({ name: 'include_diagnostics', schema: boolean() }),
);
const executionLimits = record(
  [
    'max_depth',
    'max_nodes',
    'max_bytes',
    'fuel',
    'allocations',
    'allocated_bytes',
    'collection_items',
    'call_depth',
    'host_calls',
    'trace_bytes',
    'output_bytes',
  ].map((name) => ({ name, schema: uint() })),
);

function contractSchema(maximumDepth = 64): WorkerProtocolSchema {
  const primitive = oneOf(
    record([{ name: 'kind', schema: literal('unit') }]),
    record([{ name: 'kind', schema: literal('boolean') }]),
    record([
      { name: 'kind', schema: literal('int64') },
      { name: 'minimum', schema: schemaInt, optional: true },
      { name: 'maximum', schema: schemaInt, optional: true },
    ]),
    record([
      { name: 'kind', schema: literal('float64') },
      { name: 'minimum', schema: float64(), optional: true },
      { name: 'maximum', schema: float64(), optional: true },
    ]),
    record([
      { name: 'kind', schema: literal('string') },
      { name: 'max_bytes', schema: uint(), optional: true },
    ]),
    record([
      { name: 'kind', schema: literal('bytes') },
      { name: 'max_bytes', schema: uint(), optional: true },
    ]),
    record([
      { name: 'kind', schema: literal('instant') },
      { name: 'minimum', schema: instant, optional: true },
      { name: 'maximum', schema: instant, optional: true },
    ]),
    record([
      { name: 'kind', schema: literal('ref') },
      { name: 'type', schema: text() },
    ]),
  );
  let nested = primitive;
  for (let depth = 0; depth < maximumDepth; depth++) {
    const child = nested;
    nested = oneOf(
      primitive,
      record([
        { name: 'kind', schema: literal('list') },
        { name: 'item', schema: child },
        { name: 'max_items', schema: uint(), optional: true },
      ]),
      record([
        { name: 'kind', schema: literal('tuple') },
        { name: 'items', schema: array(child) },
      ]),
      record([
        { name: 'kind', schema: literal('record') },
        {
          name: 'fields',
          schema: array(
            record([
              { name: 'name', schema: text() },
              { name: 'schema', schema: child },
            ]),
          ),
        },
      ]),
      record([
        { name: 'kind', schema: literal('variant') },
        {
          name: 'variants',
          schema: array(
            record([
              { name: 'tag', schema: text() },
              { name: 'schema', schema: child },
            ]),
          ),
        },
      ]),
      record([
        { name: 'kind', schema: literal('brand') },
        { name: 'type', schema: text() },
        { name: 'base', schema: child },
      ]),
    );
  }
  return nested;
}

const schema = contractSchema();
const typeDefinition = record([
  { name: 'id', schema: text() },
  { name: 'schema', schema },
  { name: 'fingerprint', schema: text(64) },
]);
const fingerprintDefinition = record([
  { name: 'id', schema: text() },
  { name: 'fingerprint', schema: text(64) },
]);
const operationDefinition = record([
  { name: 'id', schema: text() },
  { name: 'input', schema: text() },
  { name: 'output', schema: text() },
  { name: 'error', schema: text() },
  { name: 'effect_cost', schema: uint() },
  { name: 'fingerprint', schema: text(64) },
]);
const slotDefinition = record([
  { name: 'id', schema: text() },
  { name: 'input', schema: text() },
  { name: 'output', schema: text() },
  { name: 'operations', schema: array(text()) },
  { name: 'compile_limits', schema: compileLimits },
  { name: 'execution_limits', schema: executionLimits },
  { name: 'fingerprint', schema: text(64) },
]);
const registry = record([
  { name: 'id', schema: text() },
  { name: 'digest', schema: text(64) },
  { name: 'schemas', schema: record([{ name: 'types', schema: array(typeDefinition) }]) },
  { name: 'operations', schema: array(operationDefinition) },
  { name: 'slots', schema: array(slotDefinition) },
  { name: 'definitions', schema: array(fingerprintDefinition) },
]);
const sourceProgram = record([
  { name: 'module', schema: text() },
  { name: 'source', schema: bytes() },
]);
const checkRequest = record([
  { name: 'registry', schema: registry },
  { name: 'slot_id', schema: text() },
  { name: 'source', schema: sourceProgram },
  { name: 'limits', schema: compileLimits },
  { name: 'include_artifact', schema: boolean(), optional: true },
  { name: 'cached_artifact', schema: bytes(), optional: true },
]);
const graphLimits = record([
  { name: 'nodes', schema: uint() },
  { name: 'edges', schema: uint() },
  { name: 'bytes', schema: uint() },
]);
const semanticEditCapabilityLimits = record([
  { name: 'targets', schema: uint() },
  { name: 'capabilities', schema: uint() },
  { name: 'bytes', schema: uint() },
]);
const semanticGraphViewRequest = record([
  { name: 'kind', schema: literal('semantic_graph') },
  { name: 'schema', schema: version },
  { name: 'limits', schema: graphLimits },
]);
const semanticEditCapabilityViewRequest = record([
  { name: 'kind', schema: literal('semantic_edit_capabilities') },
  { name: 'schema', schema: version },
  {
    name: 'scope',
    schema: oneOf(literal('all'), record([{ name: 'targets', schema: array(text(), 500_000) }])),
  },
  { name: 'limits', schema: semanticEditCapabilityLimits },
]);
const inspectViewRequest = oneOf(semanticGraphViewRequest, semanticEditCapabilityViewRequest);
const inspectRequest = record([
  ...(checkRequest.kind === 'record' ? checkRequest.fields : []),
  { name: 'views', schema: array(inspectViewRequest, 2) },
]);
const semanticGraphAnchor = record([
  { name: 'container', schema: text() },
  { name: 'index', schema: uint() },
  { name: 'before', schema: text(), optional: true },
  { name: 'after', schema: text(), optional: true },
]);
const sourceFragmentCategory = oneOf(
  ...[
    'expression',
    'statement',
    'statement_list',
    'declaration',
    'declaration_list',
    'type',
    'binding_pattern',
    'parameter',
    'argument',
    'object_member',
    'array_element',
    'switch_case',
    'import_specifier',
  ].map(literal),
);
const sourceFragment = record([
  { name: 'category', schema: sourceFragmentCategory },
  { name: 'source', schema: bytes(1024 * 1024) },
]);
const semanticLiteral = oneOf(literal(null), boolean(), float64(), text(1024 * 1024));
const semanticEditPrecondition = oneOf(
  record([
    { name: 'kind', schema: literal('target_kind') },
    { name: 'value', schema: text() },
  ]),
  record([
    { name: 'kind', schema: literal('target_semantic_kind') },
    { name: 'value', schema: text() },
  ]),
  record([
    { name: 'kind', schema: literal('old_name') },
    { name: 'value', schema: text() },
  ]),
  record([
    { name: 'kind', schema: literal('old_literal') },
    { name: 'value', schema: semanticLiteral },
  ]),
  record([
    { name: 'kind', schema: literal('old_operator') },
    { name: 'value', schema: text() },
  ]),
  record([
    { name: 'kind', schema: literal('old_operation') },
    { name: 'value', schema: text() },
  ]),
  record([
    { name: 'kind', schema: literal('expected_parent') },
    { name: 'value', schema: text() },
  ]),
  record([
    { name: 'kind', schema: literal('expected_anchor') },
    { name: 'value', schema: semanticGraphAnchor },
  ]),
  record([
    { name: 'kind', schema: literal('expected_type') },
    { name: 'value', schema: text(64) },
  ]),
  record([
    { name: 'kind', schema: literal('expected_bindings') },
    { name: 'value', schema: array(text(), 1_024) },
  ]),
  record([
    { name: 'kind', schema: literal('expected_captures') },
    { name: 'value', schema: array(text(), 1_024) },
  ]),
  record([
    { name: 'kind', schema: literal('owned_comments') },
    { name: 'value', schema: boolean() },
  ]),
);
const statementRange = record([
  { name: 'container', schema: text() },
  { name: 'first', schema: text() },
  { name: 'last', schema: text() },
]);
const schemaPath = array(oneOf(text(), uint()), 64);
const commentPolicy = oneOf(literal('delete_owned_comments'), literal('preserve_owned_comments'));
const controlSpec = oneOf(
  record([
    { name: 'kind', schema: literal('if') },
    { name: 'condition', schema: sourceFragment },
    { name: 'branch', schema: oneOf(literal('true'), literal('false')) },
  ]),
  record([
    { name: 'kind', schema: literal('for_of') },
    { name: 'binding', schema: sourceFragment },
    { name: 'iterable', schema: sourceFragment },
  ]),
  record([
    { name: 'kind', schema: literal('for_in') },
    { name: 'binding', schema: sourceFragment },
    { name: 'value', schema: sourceFragment },
  ]),
  record([
    { name: 'kind', schema: literal('while') },
    { name: 'condition', schema: sourceFragment },
  ]),
  record([
    { name: 'kind', schema: literal('do') },
    { name: 'condition', schema: sourceFragment },
  ]),
  record([
    { name: 'kind', schema: literal('for') },
    { name: 'initializer', schema: sourceFragment, optional: true },
    { name: 'condition', schema: sourceFragment, optional: true },
    { name: 'increment', schema: sourceFragment, optional: true },
  ]),
  record([
    { name: 'kind', schema: literal('switch') },
    { name: 'value', schema: sourceFragment },
  ]),
);
const editRecord = (
  kind: string,
  fields: readonly Readonly<{ name: string; schema: WorkerProtocolSchema; optional?: boolean }>[],
): WorkerProtocolSchema =>
  record([
    { name: 'kind', schema: literal(kind) },
    { name: 'edit_id', schema: text() },
    { name: 'preconditions', schema: array(semanticEditPrecondition, 64) },
    ...fields,
  ]);
const target = { name: 'target', schema: text() } as const;
const semanticEdit = oneOf(
  editRecord('rename_symbol', [target, { name: 'new_name', schema: text() }]),
  editRecord('replace_target', [target, { name: 'replacement', schema: sourceFragment }]),
  editRecord('insert_at_anchor', [
    { name: 'anchor', schema: semanticGraphAnchor },
    { name: 'fragment', schema: sourceFragment },
  ]),
  editRecord('delete_target', [target, { name: 'comment_policy', schema: commentPolicy }]),
  editRecord('move_target', [target, { name: 'destination', schema: semanticGraphAnchor }]),
  editRecord('reorder_children', [
    { name: 'container', schema: text() },
    { name: 'children', schema: array(text(), 1_024) },
  ]),
  editRecord('wrap_statement_range', [
    { name: 'range', schema: statementRange },
    { name: 'control', schema: controlSpec },
  ]),
  editRecord('move_statement_range', [
    { name: 'range', schema: statementRange },
    { name: 'destination', schema: semanticGraphAnchor },
  ]),
  editRecord('unwrap_control', [target, { name: 'retained_container', schema: text() }]),
  editRecord('add_branch', [
    target,
    {
      name: 'branch',
      schema: oneOf(
        record([
          { name: 'kind', schema: literal('else') },
          { name: 'body', schema: sourceFragment },
        ]),
        record([
          { name: 'kind', schema: literal('switch_case') },
          { name: 'value', schema: sourceFragment },
          { name: 'body', schema: sourceFragment },
        ]),
      ),
    },
  ]),
  editRecord('remove_branch', [target, { name: 'comment_policy', schema: commentPolicy }]),
  editRecord('convert_control', [
    target,
    { name: 'control', schema: controlSpec },
    {
      name: 'retained_containers',
      schema: array(
        record([
          { name: 'from', schema: text() },
          { name: 'role', schema: text() },
        ]),
        1_024,
      ),
    },
  ]),
  editRecord('extract_local', [
    target,
    { name: 'name', schema: text() },
    { name: 'declaration', schema: semanticGraphAnchor },
    { name: 'replace_targets', schema: array(text(), 1_024) },
  ]),
  editRecord('inline_local', [
    { name: 'binding', schema: text() },
    { name: 'references', schema: array(text(), 1_024) },
    { name: 'remove_declaration', schema: boolean() },
    { name: 'comment_policy', schema: commentPolicy },
  ]),
  editRecord('extract_function', [
    { name: 'range', schema: statementRange },
    { name: 'name', schema: text() },
    { name: 'declaration', schema: semanticGraphAnchor },
    {
      name: 'parameters',
      schema: array(
        record([
          { name: 'symbol', schema: text() },
          { name: 'name', schema: text() },
        ]),
        1_024,
      ),
    },
    { name: 'outputs', schema: array(text(), 1_024) },
  ]),
  editRecord('inline_function_call', [
    { name: 'call', schema: text() },
    { name: 'function', schema: text() },
    {
      name: 'parameter_arguments',
      schema: array(
        record([
          { name: 'parameter', schema: text() },
          { name: 'argument', schema: text() },
        ]),
        1_024,
      ),
    },
    { name: 'remove_declaration', schema: boolean() },
    { name: 'comment_policy', schema: commentPolicy },
  ]),
  editRecord('change_binding_pattern', [target, { name: 'pattern', schema: sourceFragment }]),
  editRecord('change_binding_mutability', [
    target,
    { name: 'mutability', schema: oneOf(literal('const'), literal('let')) },
  ]),
  editRecord('change_action_operation', [
    target,
    { name: 'operation', schema: text() },
    {
      name: 'field_mappings',
      schema: array(
        record([
          { name: 'from', schema: schemaPath },
          { name: 'to', schema: schemaPath },
        ]),
        1_024,
      ),
    },
    {
      name: 'required_inputs',
      schema: array(
        record([
          { name: 'path', schema: schemaPath },
          { name: 'value', schema: sourceFragment },
        ]),
        1_024,
      ),
    },
  ]),
  editRecord('set_action_input_field', [
    target,
    { name: 'path', schema: schemaPath },
    { name: 'value', schema: sourceFragment },
  ]),
  editRecord('remove_action_input_field', [target, { name: 'path', schema: schemaPath }]),
  editRecord('bind_action_result', [target, { name: 'pattern', schema: sourceFragment }]),
  editRecord('add_action_result_branch', [
    target,
    { name: 'variant', schema: oneOf(literal('ok'), literal('error')) },
    { name: 'body', schema: sourceFragment },
  ]),
  editRecord('set_literal_value', [target, { name: 'value', schema: semanticLiteral }]),
  editRecord('change_operator', [target, { name: 'operator', schema: text() }]),
  editRecord('change_member_name', [target, { name: 'name', schema: text() }]),
  editRecord('toggle_optional_access', [target, { name: 'optional', schema: boolean() }]),
  editRecord('change_call_callee', [target, { name: 'callee', schema: sourceFragment }]),
  editRecord('change_object_field_name', [target, { name: 'name', schema: text() }]),
  editRecord('change_result_variant', [target, { name: 'variant', schema: oneOf(literal('ok'), literal('error')) }]),
);
const semanticEditLimits = record([
  { name: 'operations', schema: uint() },
  { name: 'fragment_bytes', schema: uint() },
  { name: 'transformed_regions', schema: uint() },
  { name: 'work', schema: uint() },
  { name: 'provenance_entries', schema: uint() },
  { name: 'diff_bytes', schema: uint() },
  { name: 'source_bytes', schema: uint() },
]);
const applySemanticEditsRequest = record([
  ...(checkRequest.kind === 'record' ? checkRequest.fields : []),
  { name: 'edit_schema', schema: version },
  { name: 'graph_schema', schema: version },
  { name: 'base_revision', schema: text() },
  { name: 'edits', schema: array(semanticEdit, 1_024) },
  { name: 'edit_limits', schema: semanticEditLimits },
  { name: 'views', schema: array(inspectViewRequest, 2), optional: true },
]);
const executeRequest = record([
  { name: 'registry', schema: registry },
  { name: 'slot_id', schema: text() },
  { name: 'invocation_id', schema: text() },
  {
    name: 'program',
    schema: oneOf(
      record([
        { name: 'kind', schema: literal('source') },
        { name: 'source', schema: checkRequest },
      ]),
      record([
        { name: 'kind', schema: literal('artifact') },
        { name: 'bytes', schema: bytes() },
      ]),
    ),
  },
  { name: 'input', schema: bytes() },
  { name: 'limits', schema: executionLimits },
  { name: 'fixed_instant', schema: instant, optional: true },
  { name: 'random_seed', schema: bytes(), optional: true },
  { name: 'trace', schema: boolean() },
]);
const cancelRequest = record([{ name: 'invocation_id', schema: text() }]);

const bridgeError = record([
  {
    name: 'code',
    schema: oneOf(
      literal('adapter_failure'),
      literal('artifact_verification_failed'),
      literal('bridge_closed'),
      literal('capacity_exceeded'),
      literal('invalid_request'),
      literal('unsupported_version'),
      literal('worker_close_timeout'),
      literal('worker_identity_mismatch'),
      literal('worker_lost'),
      literal('worker_start_failed'),
      literal('worker_start_timeout'),
    ),
  },
  {
    name: 'phase',
    schema: oneOf(
      literal('check'),
      literal('inspect'),
      literal('apply_semantic_edits'),
      literal('execute'),
      literal('cancel'),
      literal('close'),
      literal('action'),
    ),
  },
  { name: 'detail', schema: text(), optional: true },
]);
const compileUsage = record([
  { name: 'source_bytes', schema: uint() },
  { name: 'syntax_nodes', schema: uint() },
]);
const programSummary = record([{ name: 'operations', schema: array(text()) }]);
const compilerProvenance = record([{ name: 'compiler', schema: compilerVersion }]);
const diagnostic = record([
  { name: 'code', schema: text() },
  { name: 'severity', schema: oneOf(literal('error'), literal('warning'), literal('info')) },
  { name: 'message', schema: text() },
  {
    name: 'repair',
    schema: record([
      { name: 'category', schema: text() },
      { name: 'action', schema: text() },
    ]),
  },
  { name: 'location', schema: sourceLocation, optional: true },
  { name: 'related', schema: array(sourceLocation), optional: true },
]);
const checkAccepted = record([
  { name: 'status', schema: literal('accepted') },
  { name: 'artifact', schema: bytes(), optional: true },
  { name: 'summary', schema: programSummary },
  { name: 'provenance', schema: compilerProvenance },
  { name: 'usage', schema: compileUsage },
  { name: 'diagnostics', schema: array(diagnostic) },
]);
const checkResult = oneOf(
  checkAccepted,
  record([
    { name: 'status', schema: literal('rejected') },
    { name: 'diagnostics', schema: array(diagnostic) },
    { name: 'usage', schema: compileUsage },
  ]),
  record([
    { name: 'status', schema: literal('bridge_error') },
    { name: 'error', schema: bridgeError },
  ]),
);
const graphError = record([
  { name: 'code', schema: literal('graph_limit_exceeded') },
  { name: 'limit', schema: oneOf(literal('nodes'), literal('edges'), literal('bytes')) },
  { name: 'maximum', schema: uint() },
  { name: 'actual', schema: uint() },
]);
const capabilityError = record([
  { name: 'code', schema: literal('capability_limit_exceeded') },
  { name: 'limit', schema: oneOf(literal('targets'), literal('capabilities'), literal('bytes')) },
  { name: 'maximum', schema: uint() },
  { name: 'actual', schema: uint() },
]);
const inspectViewResult = oneOf(
  record([
    { name: 'kind', schema: literal('semantic_graph') },
    { name: 'status', schema: literal('accepted') },
    { name: 'bytes', schema: bytes() },
  ]),
  record([
    { name: 'kind', schema: literal('semantic_graph') },
    { name: 'status', schema: literal('rejected') },
    { name: 'error', schema: graphError },
  ]),
  record([
    { name: 'kind', schema: literal('semantic_edit_capabilities') },
    { name: 'status', schema: literal('accepted') },
    { name: 'bytes', schema: bytes() },
  ]),
  record([
    { name: 'kind', schema: literal('semantic_edit_capabilities') },
    { name: 'status', schema: literal('rejected') },
    { name: 'error', schema: capabilityError },
  ]),
);
const inspectResult = oneOf(
  record([
    { name: 'status', schema: literal('accepted') },
    { name: 'check', schema: checkAccepted },
    {
      name: 'views',
      schema: array(inspectViewResult, 2),
    },
  ]),
  ...(checkResult.kind === 'oneOf' ? checkResult.choices.slice(1) : []),
);
const semanticEditUsage = record([
  { name: 'operations', schema: uint() },
  { name: 'fragment_bytes', schema: uint() },
  { name: 'transformed_regions', schema: uint() },
  { name: 'work', schema: uint() },
  { name: 'provenance_entries', schema: uint() },
  { name: 'diff_bytes', schema: uint() },
  { name: 'source_bytes', schema: uint() },
]);
const semanticEditLimitError = record([
  {
    name: 'limit',
    schema: oneOf(
      literal('operations'),
      literal('fragment_bytes'),
      literal('transformed_regions'),
      literal('work'),
      literal('provenance_entries'),
      literal('diff_bytes'),
      literal('source_bytes'),
    ),
  },
  { name: 'maximum', schema: uint() },
  { name: 'actual', schema: uint() },
]);
const semanticChangedRegion = record([
  { name: 'original', schema: sourceLocation, optional: true },
  { name: 'updated', schema: sourceLocation, optional: true },
  { name: 'edit_ids', schema: array(text(), 1_024) },
]);
const semanticEditOutcome = record([
  { name: 'edit_id', schema: text() },
  { name: 'targets', schema: array(text(), 1_024) },
  { name: 'changed_regions', schema: array(uint(), 4_096) },
]);
const semanticTransformationProvenance = record([
  {
    name: 'kind',
    schema: oneOf(literal('original'), literal('generated'), literal('copied'), literal('moved'), literal('removed')),
  },
  { name: 'original', schema: sourceLocation, optional: true },
  { name: 'updated', schema: sourceLocation, optional: true },
  { name: 'edit_ids', schema: array(text(), 1_024) },
  { name: 'targets', schema: array(text(), 1_024) },
]);
const semanticDiffEntry = record([
  {
    name: 'kind',
    schema: oneOf(
      literal('preserved'),
      literal('updated'),
      literal('renamed'),
      literal('moved'),
      literal('added'),
      literal('removed'),
      literal('split'),
      literal('merged'),
    ),
  },
  { name: 'before', schema: array(text(), 1_024) },
  { name: 'after', schema: array(text(), 1_024) },
  { name: 'edit_ids', schema: array(text(), 1_024) },
]);
const semanticEditDiagnosticLocation = oneOf(
  record([
    { name: 'kind', schema: literal('original_source') },
    { name: 'location', schema: sourceLocation },
  ]),
  record([
    { name: 'kind', schema: literal('fragment') },
    { name: 'edit_id', schema: text() },
    { name: 'start', schema: uint() },
    { name: 'end', schema: uint() },
  ]),
  record([
    { name: 'kind', schema: literal('generated') },
    { name: 'edit_id', schema: text() },
    { name: 'target', schema: text() },
  ]),
);
const semanticEditDiagnostic = record([
  {
    name: 'code',
    schema: oneOf(
      literal('SE_STALE_REVISION'),
      literal('SE_TARGET_NOT_FOUND'),
      literal('SE_TARGET_KIND_MISMATCH'),
      literal('SE_PRECONDITION_FAILED'),
      literal('SE_CONFLICTING_EDITS'),
      literal('SE_FRAGMENT_REJECTED'),
      literal('SE_TRANSFORMED_SOURCE_REJECTED'),
      literal('SE_EDIT_LIMIT_EXCEEDED'),
    ),
  },
  { name: 'message', schema: text() },
  { name: 'edit_ids', schema: array(text(), 1_024) },
  { name: 'targets', schema: array(text(), 1_024) },
  { name: 'location', schema: semanticEditDiagnosticLocation, optional: true },
  { name: 'related', schema: array(semanticEditDiagnosticLocation, 64) },
]);
const applySemanticEditsResult = oneOf(
  record([
    { name: 'status', schema: literal('accepted') },
    { name: 'source', schema: sourceProgram },
    { name: 'source_hash', schema: text(64) },
    { name: 'program_hash', schema: text(64) },
    { name: 'semantic_revision', schema: text() },
    { name: 'check', schema: checkAccepted },
    { name: 'outcomes', schema: array(semanticEditOutcome, 1_024) },
    { name: 'changed_regions', schema: array(semanticChangedRegion, 4_096) },
    { name: 'provenance', schema: array(semanticTransformationProvenance, 500_000) },
    { name: 'diff', schema: record([{ name: 'entries', schema: array(semanticDiffEntry, 500_000) }]) },
    { name: 'usage', schema: semanticEditUsage },
    { name: 'views', schema: array(inspectViewResult, 2) },
  ]),
  record([
    { name: 'status', schema: literal('rejected') },
    {
      name: 'reason',
      schema: oneOf(
        literal('source_rejected'),
        literal('stale_revision'),
        literal('target_not_found'),
        literal('target_kind_mismatch'),
        literal('precondition_failed'),
        literal('conflicting_edits'),
        literal('fragment_rejected'),
        literal('transformed_source_rejected'),
        literal('edit_limit_exceeded'),
      ),
    },
    { name: 'diagnostics', schema: array(diagnostic) },
    { name: 'edit_diagnostics', schema: array(semanticEditDiagnostic, 1_024) },
    { name: 'edit_ids', schema: array(text(), 1_024) },
    { name: 'targets', schema: array(text(), 1_024) },
    { name: 'usage', schema: semanticEditUsage },
    { name: 'limit', schema: semanticEditLimitError, optional: true },
    { name: 'compile_usage', schema: compileUsage, optional: true },
  ]),
  record([
    { name: 'status', schema: literal('bridge_error') },
    { name: 'error', schema: bridgeError },
  ]),
);

const actionRequest = record([
  { name: 'contract_id', schema: text() },
  { name: 'ir_digest', schema: text(64) },
  { name: 'invocation_id', schema: text() },
  { name: 'request_id', schema: text() },
  { name: 'slot_id', schema: text() },
  { name: 'operation_id', schema: text() },
  { name: 'action_site_id', schema: text() },
  { name: 'source', schema: sourceLocation },
  { name: 'input', schema: bytes() },
]);
const hostFailure = record([
  {
    name: 'code',
    schema: oneOf(
      literal('cancelled'),
      literal('gateway_fault'),
      literal('handler_fault'),
      literal('invalid_result'),
      literal('timeout'),
      literal('transport_lost'),
      literal('unavailable'),
    ),
  },
  { name: 'detail', schema: text(160), optional: true },
]);
const actionOutcome = record([
  { name: 'request_id', schema: text() },
  {
    name: 'result',
    schema: oneOf(
      record([
        { name: 'tag', schema: literal('completed') },
        { name: 'value', schema: bytes() },
      ]),
      record([
        { name: 'tag', schema: literal('failed') },
        {
          name: 'value',
          schema: record([
            { name: 'effect_state', schema: oneOf(literal('not_performed'), literal('unknown')) },
            { name: 'failure', schema: hostFailure },
          ]),
        },
      ]),
    ),
  },
]);
const actionRecord = oneOf(
  record([
    { name: 'phase', schema: literal('requested') },
    { name: 'request', schema: actionRequest },
  ]),
  record([
    { name: 'phase', schema: literal('resolved') },
    { name: 'request_id', schema: text() },
    { name: 'outcome', schema: actionOutcome },
  ]),
);
const executionUsage = record(
  [
    'fuel',
    'allocations',
    'allocated_bytes',
    'peak_collection_items',
    'peak_value_depth',
    'peak_value_nodes',
    'peak_value_bytes',
    'peak_call_depth',
    'host_calls',
    'trace_bytes',
    'output_bytes',
  ].map((name) => ({ name, schema: uint() })),
);
const executionPreparation = oneOf(
  record([
    { name: 'kind', schema: literal('source') },
    { name: 'artifact', schema: bytes(), optional: true },
    { name: 'summary', schema: programSummary },
    { name: 'provenance', schema: compilerProvenance },
    { name: 'usage', schema: compileUsage },
    { name: 'diagnostics', schema: array(diagnostic) },
  ]),
  record([
    { name: 'kind', schema: literal('artifact') },
    { name: 'ir_digest', schema: text(64) },
  ]),
);
const executionFacts = record([
  { name: 'preparation', schema: executionPreparation },
  { name: 'actions', schema: array(actionRecord) },
  {
    name: 'trace',
    schema: record([
      { name: 'records', schema: array(bytes()) },
      { name: 'truncated', schema: boolean() },
    ]),
  },
  { name: 'usage', schema: executionUsage },
]);
const executionError = record([
  { name: 'code', schema: text() },
  { name: 'detail', schema: text(), optional: true },
  { name: 'source', schema: sourceLocation, optional: true },
]);
const executionResult = oneOf(
  record([
    { name: 'status', schema: literal('not_started') },
    { name: 'diagnostics', schema: array(diagnostic), optional: true },
    { name: 'error', schema: bridgeError, optional: true },
    { name: 'usage', schema: compileUsage, optional: true },
  ]),
  record([
    { name: 'status', schema: literal('completed') },
    { name: 'output', schema: bytes() },
    { name: 'facts', schema: executionFacts },
  ]),
  record([
    { name: 'status', schema: literal('failed') },
    { name: 'error', schema: executionError },
    { name: 'facts', schema: executionFacts },
  ]),
  record([
    { name: 'status', schema: literal('cancelled') },
    { name: 'error', schema: executionError },
    { name: 'facts', schema: executionFacts },
  ]),
  record([
    { name: 'status', schema: literal('bridge_error') },
    { name: 'error', schema: bridgeError },
  ]),
);
const cancelResult = oneOf(
  record([{ name: 'status', schema: literal('accepted') }]),
  record([{ name: 'status', schema: literal('not_active') }]),
  record([
    { name: 'status', schema: literal('bridge_error') },
    { name: 'error', schema: bridgeError },
  ]),
);
const closeRequest = record([]);
const closeResult = oneOf(
  record([{ name: 'status', schema: literal('closed') }]),
  record([
    { name: 'status', schema: literal('bridge_error') },
    { name: 'error', schema: bridgeError },
  ]),
);
const actionRequestPayload = record([
  { name: 'execute_id', schema: messageId },
  { name: 'request', schema: actionRequest },
]);
const actionOutcomePayload = record([
  { name: 'request', schema: messageId },
  { name: 'outcome', schema: actionOutcome },
]);
const protocolError = record([
  { name: 'code', schema: text() },
  { name: 'scope', schema: oneOf(literal('request'), literal('connection')) },
  { name: 'detail', schema: text(), optional: true },
]);

export interface WorkerActionRequestPayload {
  readonly executeId: bigint;
  readonly request: ActionRequest;
}

export interface WorkerActionOutcomePayload {
  readonly request: bigint;
  readonly outcome: ActionOutcome;
}

export interface WorkerProtocolErrorPayload {
  readonly code: string;
  readonly scope: 'request' | 'connection';
  readonly detail?: string;
}

type WorkerPayloadTypes = {
  'bridge.check.request': CheckRequest;
  'bridge.check.result': CheckResult;
  'bridge.inspect.request': InspectRequest;
  'bridge.inspect.result': InspectResult;
  'bridge.apply_semantic_edits.request': ApplySemanticEditsRequest;
  'bridge.apply_semantic_edits.result': ApplySemanticEditsResult;
  'bridge.execute.request': ExecuteRequest;
  'bridge.execute.result': ExecutionResult;
  'bridge.cancel.request': CancelRequest;
  'bridge.cancel.result': CancelResult;
  'session.close.request': Readonly<Record<string, never>>;
  'session.close.result': CloseResult;
  'action.request': WorkerActionRequestPayload;
  'action.outcome': WorkerActionOutcomePayload;
  'protocol.error': WorkerProtocolErrorPayload;
};

const payloads: Readonly<Record<keyof WorkerPayloadTypes, WorkerProtocolSchema>> = Object.freeze({
  'bridge.check.request': checkRequest,
  'bridge.check.result': checkResult,
  'bridge.inspect.request': inspectRequest,
  'bridge.inspect.result': inspectResult,
  'bridge.apply_semantic_edits.request': applySemanticEditsRequest,
  'bridge.apply_semantic_edits.result': applySemanticEditsResult,
  'bridge.execute.request': executeRequest,
  'bridge.execute.result': executionResult,
  'bridge.cancel.request': cancelRequest,
  'bridge.cancel.result': cancelResult,
  'session.close.request': closeRequest,
  'session.close.result': closeResult,
  'action.request': actionRequestPayload,
  'action.outcome': actionOutcomePayload,
  'protocol.error': protocolError,
});

function domainName(wireName: string): string {
  if (wireName === 'semantic_graph') return wireName;
  return wireName.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function hasLiteralMatch(schemaValue: WorkerProtocolSchema, value: unknown): boolean {
  if (schemaValue.kind === 'literal') return schemaValue.value === value;
  if (schemaValue.kind === 'oneOf') return schemaValue.choices.some((choice) => hasLiteralMatch(choice, value));
  if (schemaValue.kind !== 'record' || value === null || typeof value !== 'object') return true;
  const candidate = value as Readonly<Record<string, unknown>>;
  return schemaValue.fields.every((field) => {
    if (field.schema.kind !== 'literal') return true;
    return candidate[domainName(field.name)] === field.schema.value || candidate[field.name] === field.schema.value;
  });
}

function select(schemaValue: WorkerProtocolSchema, value: unknown): WorkerProtocolSchema {
  if (schemaValue.kind !== 'oneOf') return schemaValue;
  const selected =
    schemaValue.choices.find((choice) => hasLiteralMatch(choice, value)) ??
    (schemaValue.choices[0] as WorkerProtocolSchema);
  return select(selected, value);
}

function toWire(schemaValue: WorkerProtocolSchema, value: unknown): unknown {
  const selected = select(schemaValue, value);
  if (selected.kind === 'uint' || selected.kind === 'int') {
    if (typeof value === 'bigint') return value;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return value;
    return BigInt(value);
  }
  if (selected.kind === 'bytes')
    return value instanceof Uint8Array ? value : Uint8Array.from(value as readonly number[]);
  if (selected.kind === 'array') return (value as readonly unknown[]).map((item) => toWire(selected.item, item));
  if (selected.kind === 'record') {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError('wire record requires a plain data object');
    const source = value as Readonly<Record<string, unknown>>;
    const descriptors = Object.getOwnPropertyDescriptors(source);
    const expected = new Set(selected.fields.map((field) => domainName(field.name)));
    if (
      !Object.keys(source).every((key) => expected.has(key)) ||
      Object.values(descriptors).some((descriptor) => !('value' in descriptor) || !descriptor.enumerable)
    )
      throw new TypeError('wire record contains an unknown or accessor field');
    const target: Record<string, unknown> = {};
    for (const field of selected.fields) {
      const key = domainName(field.name);
      if (Object.hasOwn(source, key)) target[field.name] = toWire(field.schema, source[key]);
    }
    return target;
  }
  return value;
}

function fromWire(schemaValue: WorkerProtocolSchema, value: unknown): unknown {
  const selected = select(schemaValue, value);
  if (selected === messageId || selected === epochSeconds || selected === schemaInt) return value;
  if (selected.kind === 'uint') {
    if (typeof value !== 'bigint' || value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TypeError('wire integer exceeds JavaScript safe integer range');
    return Number(value);
  }
  if (selected.kind === 'int') {
    if (typeof value !== 'bigint' || value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TypeError('wire integer exceeds JavaScript safe integer range');
    return Number(value);
  }
  if (selected.kind === 'bytes') return Object.freeze(Array.from(value as Uint8Array));
  if (selected.kind === 'array')
    return Object.freeze((value as readonly unknown[]).map((item) => fromWire(selected.item, item)));
  if (selected.kind === 'record') {
    const source = value as Readonly<Record<string, unknown>>;
    const target: Record<string, unknown> = {};
    for (const field of selected.fields) {
      if (Object.hasOwn(source, field.name))
        target[domainName(field.name)] = fromWire(field.schema, source[field.name]);
    }
    return Object.freeze(target);
  }
  return value;
}

function contract<K extends keyof WorkerPayloadTypes>(kind: K): WorkerProtocolPayload<unknown> {
  return Object.freeze({ kind: kind as WorkerProtocolMessageKind, schema: payloads[kind] });
}

export function encodeWorkerBridgePayload<K extends keyof WorkerPayloadTypes>(
  kind: K,
  value: WorkerPayloadTypes[K],
  limits?: WorkerProtocolCodecLimits,
): WorkerProtocolCodecResult<Uint8Array> {
  try {
    return encodeWorkerProtocolPayload(contract(kind), toWire(payloads[kind], value), limits);
  } catch {
    return Object.freeze({
      ok: false,
      failure: Object.freeze({
        code: 'payload_schema' as const,
        path: Object.freeze([]),
        detail: 'payload contains an unknown, accessor, or invalid record field',
      }),
    });
  }
}

export function decodeWorkerBridgePayload<K extends keyof WorkerPayloadTypes>(
  kind: K,
  bytesValue: Uint8Array,
  limits?: WorkerProtocolCodecLimits,
): WorkerProtocolCodecResult<WorkerPayloadTypes[K]> {
  const decoded = decodeWorkerProtocolPayload(contract(kind), bytesValue, limits);
  if (!decoded.ok) return decoded;
  try {
    return Object.freeze({ ok: true, value: fromWire(payloads[kind], decoded.value) as WorkerPayloadTypes[K] });
  } catch {
    return Object.freeze({
      ok: false,
      failure: Object.freeze({
        code: 'payload_schema' as const,
        path: Object.freeze([]),
        detail: 'wire integer exceeds JavaScript safe integer range',
      }),
    });
  }
}
