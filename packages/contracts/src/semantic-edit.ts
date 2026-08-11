/**
 * Closed, transport-neutral contracts for compiler-owned semantic source editing.
 *
 * @remarks This module contains records only. It grants no runtime authority and carries no compiler objects,
 * callbacks, host handles, or executable graph representation.
 */
import type {
  BridgeError,
  CanonicalBytes,
  CheckRequest,
  CheckResult,
  CompileUsage,
  CompilerVersion,
  ContractId,
  Diagnostic,
  InspectViewRequest,
  InspectViewResult,
  LanguageProfile,
  ModuleId,
  OperationId,
  ProgramHash,
  Schema,
  SemanticGraphAnchor,
  SemanticNodeId,
  SemanticNodeKind,
  SemanticNodeSemanticKind,
  Sha256Digest,
  SlotId,
  SourceHash,
  SourceLocation,
  SourceProgram,
  SymbolId,
  Version,
} from './index.js';

declare const semanticEditBrand: unique symbol;

/** Caller-chosen correlation identity unique within one edit request. */
export type SemanticEditId = string & { readonly [semanticEditBrand]: 'SemanticEditId' };

/** First public semantic-edit and capability schema. */
export const SEMANTIC_EDIT_SCHEMA: Version = Object.freeze({ major: 1, minor: 0 });

/** Independent deterministic ceilings for one atomic semantic edit request. */
export interface SemanticEditLimits {
  readonly operations: number;
  readonly fragmentBytes: number;
  readonly transformedRegions: number;
  readonly work: number;
  readonly provenanceEntries: number;
  readonly diffBytes: number;
  readonly sourceBytes: number;
}

export const STANDARD_SEMANTIC_EDIT_LIMITS: SemanticEditLimits = Object.freeze({
  operations: 1_024,
  fragmentBytes: 1024 * 1024,
  transformedRegions: 4_096,
  work: 2_000_000,
  provenanceEntries: 500_000,
  diffBytes: 4 * 1024 * 1024,
  sourceBytes: 1024 * 1024,
});

/** Independent deterministic ceilings for capability-manifest projection. */
export interface SemanticEditCapabilityLimits {
  readonly targets: number;
  readonly capabilities: number;
  readonly bytes: number;
}

export const STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS: SemanticEditCapabilityLimits = Object.freeze({
  targets: 500_000,
  capabilities: 2_000_000,
  bytes: 8 * 1024 * 1024,
});

/** Closed syntactic category for a caller-supplied UTF-8 source fragment. */
export type SourceFragmentCategory =
  | 'expression'
  | 'statement'
  | 'statement_list'
  | 'declaration'
  | 'declaration_list'
  | 'type'
  | 'binding_pattern'
  | 'parameter'
  | 'argument'
  | 'object_member'
  | 'array_element'
  | 'switch_case'
  | 'import_specifier';

/** One category-bound fragment; the compiler never infers its category from text. */
export interface SourceFragment {
  readonly category: SourceFragmentCategory;
  readonly source: CanonicalBytes;
}

/** Explicit policy for comments owned by a construct being deleted. */
export type SemanticCommentPolicy = 'delete_owned_comments' | 'preserve_owned_comments';

/** Materialized expectations evaluated against the exact base semantic revision. */
export type SemanticEditPrecondition =
  | Readonly<{ kind: 'target_kind'; value: SemanticNodeKind }>
  | Readonly<{ kind: 'target_semantic_kind'; value: SemanticNodeSemanticKind }>
  | Readonly<{ kind: 'old_name'; value: string }>
  | Readonly<{ kind: 'old_literal'; value: null | boolean | number | string }>
  | Readonly<{ kind: 'old_operator'; value: string }>
  | Readonly<{ kind: 'old_operation'; value: OperationId }>
  | Readonly<{ kind: 'expected_parent'; value: SemanticNodeId }>
  | Readonly<{ kind: 'expected_anchor'; value: SemanticGraphAnchor }>
  | Readonly<{ kind: 'expected_type'; value: Sha256Digest }>
  | Readonly<{ kind: 'expected_bindings'; value: readonly SymbolId[] }>
  | Readonly<{ kind: 'expected_captures'; value: readonly SymbolId[] }>
  | Readonly<{ kind: 'owned_comments'; value: boolean }>;

interface SemanticEditBase {
  readonly editId: SemanticEditId;
  readonly preconditions: readonly SemanticEditPrecondition[];
}

export interface RenameSymbolEdit extends SemanticEditBase {
  readonly kind: 'rename_symbol';
  readonly target: SemanticNodeId;
  readonly newName: string;
}

export interface ReplaceTargetEdit extends SemanticEditBase {
  readonly kind: 'replace_target';
  readonly target: SemanticNodeId;
  readonly replacement: SourceFragment;
}

export interface InsertAtAnchorEdit extends SemanticEditBase {
  readonly kind: 'insert_at_anchor';
  readonly anchor: SemanticGraphAnchor;
  readonly fragment: SourceFragment;
}

export interface DeleteTargetEdit extends SemanticEditBase {
  readonly kind: 'delete_target';
  readonly target: SemanticNodeId;
  readonly commentPolicy: SemanticCommentPolicy;
}

export interface MoveTargetEdit extends SemanticEditBase {
  readonly kind: 'move_target';
  readonly target: SemanticNodeId;
  readonly destination: SemanticGraphAnchor;
}

export interface ReorderChildrenEdit extends SemanticEditBase {
  readonly kind: 'reorder_children';
  readonly container: SemanticNodeId;
  readonly children: readonly SemanticNodeId[];
}

/** Inclusive contiguous sibling range in one ordered statement container. */
export interface SemanticStatementRange {
  readonly container: SemanticNodeId;
  readonly first: SemanticNodeId;
  readonly last: SemanticNodeId;
}

/** Path through a declared operation input schema. */
export type SemanticSchemaPath = readonly (string | number)[];

/** Explicit control shape used by wrapping and conversion gestures. */
export type SemanticControlSpec =
  | Readonly<{ kind: 'if'; condition: SourceFragment; branch: 'true' | 'false' }>
  | Readonly<{ kind: 'for_of'; binding: SourceFragment; iterable: SourceFragment }>
  | Readonly<{ kind: 'for_in'; binding: SourceFragment; value: SourceFragment }>
  | Readonly<{ kind: 'while'; condition: SourceFragment }>
  | Readonly<{ kind: 'do'; condition: SourceFragment }>
  | Readonly<{
      kind: 'for';
      initializer?: SourceFragment;
      condition?: SourceFragment;
      increment?: SourceFragment;
    }>
  | Readonly<{ kind: 'switch'; value: SourceFragment }>;

export interface WrapStatementRangeEdit extends SemanticEditBase {
  readonly kind: 'wrap_statement_range';
  readonly range: SemanticStatementRange;
  readonly control: SemanticControlSpec;
}

export interface MoveStatementRangeEdit extends SemanticEditBase {
  readonly kind: 'move_statement_range';
  readonly range: SemanticStatementRange;
  readonly destination: SemanticGraphAnchor;
}

export interface UnwrapControlEdit extends SemanticEditBase {
  readonly kind: 'unwrap_control';
  readonly target: SemanticNodeId;
  readonly retainedContainer: SemanticNodeId;
}

export interface AddBranchEdit extends SemanticEditBase {
  readonly kind: 'add_branch';
  readonly target: SemanticNodeId;
  readonly branch:
    | Readonly<{ kind: 'else'; body: SourceFragment }>
    | Readonly<{ kind: 'switch_case'; value: SourceFragment; body: SourceFragment }>;
}

export interface RemoveBranchEdit extends SemanticEditBase {
  readonly kind: 'remove_branch';
  readonly target: SemanticNodeId;
  readonly commentPolicy: SemanticCommentPolicy;
}

export interface ConvertControlEdit extends SemanticEditBase {
  readonly kind: 'convert_control';
  readonly target: SemanticNodeId;
  readonly control: SemanticControlSpec;
  readonly retainedContainers: readonly Readonly<{ from: SemanticNodeId; role: string }>[];
}

export interface ExtractLocalEdit extends SemanticEditBase {
  readonly kind: 'extract_local';
  readonly target: SemanticNodeId;
  readonly name: string;
  readonly declaration: SemanticGraphAnchor;
  readonly replaceTargets: readonly SemanticNodeId[];
}

export interface InlineLocalEdit extends SemanticEditBase {
  readonly kind: 'inline_local';
  readonly binding: SemanticNodeId;
  readonly references: readonly SemanticNodeId[];
  readonly removeDeclaration: boolean;
  readonly commentPolicy: SemanticCommentPolicy;
}

export interface SemanticFunctionParameterMapping {
  readonly symbol: SymbolId;
  readonly name: string;
}

export interface ExtractFunctionEdit extends SemanticEditBase {
  readonly kind: 'extract_function';
  readonly range: SemanticStatementRange;
  readonly name: string;
  readonly declaration: SemanticGraphAnchor;
  readonly parameters: readonly SemanticFunctionParameterMapping[];
  readonly outputs: readonly SymbolId[];
}

export interface InlineFunctionCallEdit extends SemanticEditBase {
  readonly kind: 'inline_function_call';
  readonly call: SemanticNodeId;
  readonly function: SemanticNodeId;
  readonly parameterArguments: readonly Readonly<{
    parameter: SemanticNodeId;
    argument: SemanticNodeId;
  }>[];
  readonly removeDeclaration: boolean;
  readonly commentPolicy: SemanticCommentPolicy;
}

export interface ChangeBindingPatternEdit extends SemanticEditBase {
  readonly kind: 'change_binding_pattern';
  readonly target: SemanticNodeId;
  readonly pattern: SourceFragment;
}

export interface ChangeBindingMutabilityEdit extends SemanticEditBase {
  readonly kind: 'change_binding_mutability';
  readonly target: SemanticNodeId;
  readonly mutability: 'const' | 'let';
}

export interface SemanticActionFieldMapping {
  readonly from: SemanticSchemaPath;
  readonly to: SemanticSchemaPath;
}

export interface ChangeActionOperationEdit extends SemanticEditBase {
  readonly kind: 'change_action_operation';
  readonly target: SemanticNodeId;
  readonly operation: OperationId;
  readonly fieldMappings: readonly SemanticActionFieldMapping[];
  readonly requiredInputs: readonly Readonly<{ path: SemanticSchemaPath; value: SourceFragment }>[];
}

export interface SetActionInputFieldEdit extends SemanticEditBase {
  readonly kind: 'set_action_input_field';
  readonly target: SemanticNodeId;
  readonly path: SemanticSchemaPath;
  readonly value: SourceFragment;
}

export interface RemoveActionInputFieldEdit extends SemanticEditBase {
  readonly kind: 'remove_action_input_field';
  readonly target: SemanticNodeId;
  readonly path: SemanticSchemaPath;
}

export interface BindActionResultEdit extends SemanticEditBase {
  readonly kind: 'bind_action_result';
  readonly target: SemanticNodeId;
  readonly pattern: SourceFragment;
}

export interface AddActionResultBranchEdit extends SemanticEditBase {
  readonly kind: 'add_action_result_branch';
  readonly target: SemanticNodeId;
  readonly variant: 'ok' | 'error';
  readonly body: SourceFragment;
}

export interface SetLiteralValueEdit extends SemanticEditBase {
  readonly kind: 'set_literal_value';
  readonly target: SemanticNodeId;
  readonly value: null | boolean | number | string;
}

export interface ChangeOperatorEdit extends SemanticEditBase {
  readonly kind: 'change_operator';
  readonly target: SemanticNodeId;
  readonly operator: string;
}

export interface ChangeMemberNameEdit extends SemanticEditBase {
  readonly kind: 'change_member_name';
  readonly target: SemanticNodeId;
  readonly name: string;
}

export interface ToggleOptionalAccessEdit extends SemanticEditBase {
  readonly kind: 'toggle_optional_access';
  readonly target: SemanticNodeId;
  readonly optional: boolean;
}

export interface ChangeCallCalleeEdit extends SemanticEditBase {
  readonly kind: 'change_call_callee';
  readonly target: SemanticNodeId;
  readonly callee: SourceFragment;
}

export interface ChangeObjectFieldNameEdit extends SemanticEditBase {
  readonly kind: 'change_object_field_name';
  readonly target: SemanticNodeId;
  readonly name: string;
}

export interface ChangeResultVariantEdit extends SemanticEditBase {
  readonly kind: 'change_result_variant';
  readonly target: SemanticNodeId;
  readonly variant: 'ok' | 'error';
}

/** Closed edit-operation discriminants in schema 1.0. */
export const SEMANTIC_EDIT_KINDS = Object.freeze([
  'rename_symbol',
  'replace_target',
  'insert_at_anchor',
  'delete_target',
  'move_target',
  'reorder_children',
  'wrap_statement_range',
  'move_statement_range',
  'unwrap_control',
  'add_branch',
  'remove_branch',
  'convert_control',
  'extract_local',
  'inline_local',
  'extract_function',
  'inline_function_call',
  'change_binding_pattern',
  'change_binding_mutability',
  'change_action_operation',
  'set_action_input_field',
  'remove_action_input_field',
  'bind_action_result',
  'add_action_result_branch',
  'set_literal_value',
  'change_operator',
  'change_member_name',
  'toggle_optional_access',
  'change_call_callee',
  'change_object_field_name',
  'change_result_variant',
] as const);

export type SemanticEditKind = (typeof SEMANTIC_EDIT_KINDS)[number];

/** Complete closed primitive and high-level gesture algebra for schema 1.0. */
export type SemanticEdit =
  | RenameSymbolEdit
  | ReplaceTargetEdit
  | InsertAtAnchorEdit
  | DeleteTargetEdit
  | MoveTargetEdit
  | ReorderChildrenEdit
  | WrapStatementRangeEdit
  | MoveStatementRangeEdit
  | UnwrapControlEdit
  | AddBranchEdit
  | RemoveBranchEdit
  | ConvertControlEdit
  | ExtractLocalEdit
  | InlineLocalEdit
  | ExtractFunctionEdit
  | InlineFunctionCallEdit
  | ChangeBindingPatternEdit
  | ChangeBindingMutabilityEdit
  | ChangeActionOperationEdit
  | SetActionInputFieldEdit
  | RemoveActionInputFieldEdit
  | BindActionResultEdit
  | AddActionResultBranchEdit
  | SetLiteralValueEdit
  | ChangeOperatorEdit
  | ChangeMemberNameEdit
  | ToggleOptionalAccessEdit
  | ChangeCallCalleeEdit
  | ChangeObjectFieldNameEdit
  | ChangeResultVariantEdit;

/** Whole-program or explicitly target-filtered capability projection. */
export type SemanticEditCapabilityScope = 'all' | Readonly<{ targets: readonly SemanticNodeId[] }>;

/** Tagged request for the independently bounded semantic-edit capability manifest. */
export interface SemanticEditCapabilityViewRequest {
  readonly kind: 'semantic_edit_capabilities';
  readonly schema: Version;
  readonly scope: SemanticEditCapabilityScope;
  readonly limits: SemanticEditCapabilityLimits;
}

export interface SemanticEditCapabilityError {
  readonly code: 'capability_limit_exceeded';
  readonly limit: keyof SemanticEditCapabilityLimits;
  readonly maximum: number;
  readonly actual: number;
}

export type SemanticEditCapabilityViewResult =
  | Readonly<{ kind: 'semantic_edit_capabilities'; status: 'accepted'; bytes: CanonicalBytes }>
  | Readonly<{ kind: 'semantic_edit_capabilities'; status: 'rejected'; error: SemanticEditCapabilityError }>;

/** One compiler-advertised operation with all materialized inputs a generic editor must echo or choose. */
export interface SemanticEditCapability {
  readonly kind: SemanticEditKind;
  readonly preconditions: readonly SemanticEditPrecondition[];
  readonly fragmentCategories: readonly SourceFragmentCategory[];
  readonly anchors: readonly SemanticGraphAnchor[];
  readonly operators: readonly string[];
  readonly operations: readonly OperationId[];
  readonly expectedSchemas: readonly SemanticEditExpectedSchema[];
  readonly schemaPaths: readonly SemanticSchemaPath[];
  readonly bindings: readonly SymbolId[];
  readonly controlKinds: readonly SemanticControlSpec['kind'][];
  readonly branchKinds: readonly ('true' | 'false' | 'else' | 'switch_case')[];
  readonly resultVariants: readonly ('ok' | 'error')[];
  readonly mutabilities: readonly ('const' | 'let')[];
  readonly suggestedNames: readonly string[];
  readonly ownedComments: boolean;
}

export interface SemanticEditExpectedSchema {
  readonly role: 'target' | 'fragment' | 'operation_input' | 'operation_output' | 'operation_error';
  readonly schema: Schema;
  readonly operation?: OperationId;
  readonly path?: SemanticSchemaPath;
}

export interface SemanticEditTargetCapabilities {
  readonly target: SemanticNodeId;
  readonly kind: SemanticNodeKind;
  readonly semanticKind: SemanticNodeSemanticKind;
  readonly parent?: SemanticNodeId;
  readonly container?: SemanticNodeId;
  readonly capabilities: readonly SemanticEditCapability[];
}

export interface SemanticEditCapabilityUsage {
  readonly targets: number;
  readonly capabilities: number;
  readonly bytes: number;
}

/** Disposable, non-executable capability projection for one exact semantic revision. */
export interface SemanticEditCapabilityManifest {
  readonly schema: Version;
  readonly graphSchema: Version;
  readonly semanticRevision: import('./index.js').SemanticRevisionId;
  readonly sourceHash: SourceHash;
  readonly programHash: ProgramHash;
  readonly compiler: CompilerVersion;
  readonly language: LanguageProfile;
  readonly contract: Readonly<{ id: ContractId; digest: Sha256Digest }>;
  readonly slotId: SlotId;
  readonly moduleId: ModuleId;
  readonly targets: readonly SemanticEditTargetCapabilities[];
  readonly usage: SemanticEditCapabilityUsage;
}

/** Atomic compiler-only edit request over one exact canonical source revision. */
export interface ApplySemanticEditsRequest extends CheckRequest {
  readonly editSchema: Version;
  readonly graphSchema: Version;
  readonly baseRevision: import('./index.js').SemanticRevisionId;
  readonly edits: readonly SemanticEdit[];
  readonly editLimits: SemanticEditLimits;
  readonly views?: readonly InspectViewRequest[];
}

export interface SemanticEditUsage {
  readonly operations: number;
  readonly fragmentBytes: number;
  readonly transformedRegions: number;
  readonly work: number;
  readonly provenanceEntries: number;
  readonly diffBytes: number;
  readonly sourceBytes: number;
}

export interface SemanticChangedRegion {
  readonly original?: SourceLocation;
  readonly updated?: SourceLocation;
  readonly editIds: readonly SemanticEditId[];
}

export interface SemanticEditOutcome {
  readonly editId: SemanticEditId;
  readonly targets: readonly SemanticNodeId[];
  readonly changedRegions: readonly number[];
}

export type SemanticTransformationKind = 'original' | 'generated' | 'copied' | 'moved' | 'removed';

export interface SemanticTransformationProvenance {
  readonly kind: SemanticTransformationKind;
  readonly original?: SourceLocation;
  readonly updated?: SourceLocation;
  readonly editIds: readonly SemanticEditId[];
  readonly targets: readonly SemanticNodeId[];
}

export type SemanticDiffKind = 'preserved' | 'updated' | 'renamed' | 'moved' | 'added' | 'removed' | 'split' | 'merged';

export interface SemanticDiffEntry {
  readonly kind: SemanticDiffKind;
  readonly before: readonly SemanticNodeId[];
  readonly after: readonly SemanticNodeId[];
  readonly editIds: readonly SemanticEditId[];
}

export interface SemanticDiff {
  readonly entries: readonly SemanticDiffEntry[];
}

export type SemanticEditDiagnosticLocation =
  | Readonly<{ kind: 'original_source'; location: SourceLocation }>
  | Readonly<{ kind: 'fragment'; editId: SemanticEditId; start: number; end: number }>
  | Readonly<{ kind: 'generated'; editId: SemanticEditId; target: SemanticNodeId }>;

export const SEMANTIC_EDIT_DIAGNOSTIC_CODES = Object.freeze([
  'SE_STALE_REVISION',
  'SE_TARGET_NOT_FOUND',
  'SE_TARGET_KIND_MISMATCH',
  'SE_PRECONDITION_FAILED',
  'SE_CONFLICTING_EDITS',
  'SE_FRAGMENT_REJECTED',
  'SE_TRANSFORMED_SOURCE_REJECTED',
  'SE_EDIT_LIMIT_EXCEEDED',
] as const);

export type SemanticEditDiagnosticCode = (typeof SEMANTIC_EDIT_DIAGNOSTIC_CODES)[number];

export interface SemanticEditDiagnostic {
  readonly code: SemanticEditDiagnosticCode;
  readonly message: string;
  readonly editIds: readonly SemanticEditId[];
  readonly targets: readonly SemanticNodeId[];
  readonly location?: SemanticEditDiagnosticLocation;
  readonly related: readonly SemanticEditDiagnosticLocation[];
}

export type SemanticEditRejectionReason =
  | 'source_rejected'
  | 'stale_revision'
  | 'target_not_found'
  | 'target_kind_mismatch'
  | 'precondition_failed'
  | 'conflicting_edits'
  | 'fragment_rejected'
  | 'transformed_source_rejected'
  | 'edit_limit_exceeded';

/** Exact measured limit failure; callers never have to parse a diagnostic message. */
export type SemanticEditLimitName =
  | 'operations'
  | 'fragment_bytes'
  | 'transformed_regions'
  | 'work'
  | 'provenance_entries'
  | 'diff_bytes'
  | 'source_bytes';

export interface SemanticEditLimitError {
  readonly limit: SemanticEditLimitName;
  readonly maximum: number;
  readonly actual: number;
}

export type ApplySemanticEditsResult =
  | Readonly<{
      status: 'accepted';
      source: SourceProgram;
      sourceHash: SourceHash;
      programHash: ProgramHash;
      semanticRevision: import('./index.js').SemanticRevisionId;
      check: Extract<CheckResult, { status: 'accepted' }>;
      outcomes: readonly SemanticEditOutcome[];
      changedRegions: readonly SemanticChangedRegion[];
      provenance: readonly SemanticTransformationProvenance[];
      diff: SemanticDiff;
      usage: SemanticEditUsage;
      views: readonly InspectViewResult[];
    }>
  | Readonly<{
      status: 'rejected';
      reason: SemanticEditRejectionReason;
      diagnostics: readonly Diagnostic[];
      editDiagnostics: readonly SemanticEditDiagnostic[];
      editIds: readonly SemanticEditId[];
      targets: readonly SemanticNodeId[];
      usage: SemanticEditUsage;
      limit?: SemanticEditLimitError;
      compileUsage?: CompileUsage;
    }>
  | Readonly<{ status: 'bridge_error'; error: BridgeError }>;

const EDIT_ID = /^edit:[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;
const NODE_ID = /^semantic-node:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SEMANTIC_KINDS = new Set<string>([
  'module',
  'import-declaration',
  'import-specifier',
  'interface',
  'type-alias',
  'type-parameter',
  'type-member',
  'type-reference',
  'type-literal',
  'type-union',
  'type-intersection',
  'type-tuple',
  'type-array',
  'type-function',
  'type-operator',
  'type-literal-value',
  'parameter',
  'symbol',
  'return-type',
  'module-container',
  'import-container',
  'type-parameter-container',
  'type-member-container',
  'parameter-container',
  'statement-container',
  'declaration-container',
  'argument-container',
  'element-container',
  'member-container',
  'case-container',
  'initializer-container',
  'increment-container',
  'template-container',
  'branch-case',
  'switch-case',
  'object-member',
  'array-element',
  'binding-pattern',
  'await',
  'satisfies',
  'const-assertion',
  'handler',
  'function',
  'variable',
  'destructure',
  'assign',
  'expression',
  'if',
  'for-of',
  'for-in',
  'loop',
  'break',
  'continue',
  'return',
  'switch',
  'slot-input',
  'slot-output',
  'binary',
  'structured',
  'host-action',
  'return-value',
  'literal',
  'name',
  'member',
  'index',
  'array',
  'object',
  'template',
  'unary',
  'conditional',
  'call',
  'result',
]);
const NODE_KINDS = new Set<string>([
  'module',
  'declaration',
  'binding',
  'statement',
  'expression',
  'type',
  'container',
  'branch',
  'case',
  'input',
  'output',
  'constant',
  'action',
]);
const FRAGMENT_CATEGORIES = new Set<string>([
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
]);
const OPERATORS = new Set<string>([
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '&',
  '|',
  '^',
  '<<',
  '>>',
  '===',
  '!==',
  '<',
  '<=',
  '>',
  '>=',
  '&&',
  '||',
  '??',
  'in',
  '!',
  '~',
]);
const SYMBOL_ID = /^symbol:[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const OPERATION_ID = /^operation:[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function plainDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.enumerable === true && Object.hasOwn(descriptor, 'value'),
  );
}

function denseDataArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  return (
    plainDataRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function closedRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Readonly<Record<string, unknown>> {
  if (!plainDataRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function boundedText(value: unknown, maximum = 128): value is string {
  return typeof value === 'string' && value.length > 0 && textEncoder.encode(value).length <= maximum;
}

function identifier(value: unknown): value is string {
  return boundedText(value) && IDENTIFIER.test(value);
}

function nodeId(value: unknown): value is SemanticNodeId {
  return typeof value === 'string' && NODE_ID.test(value);
}

function symbolId(value: unknown): value is SymbolId {
  return typeof value === 'string' && SYMBOL_ID.test(value);
}

function uniqueArray(
  value: unknown,
  item: (candidate: unknown) => boolean,
  maximum = 1_024,
): value is readonly unknown[] {
  if (!denseDataArray(value) || value.length > maximum || !value.every(item)) return false;
  try {
    return new Set(value.map((candidate) => JSON.stringify(candidate))).size === value.length;
  } catch {
    return false;
  }
}

function anchor(value: unknown): value is SemanticGraphAnchor {
  if (!closedRecord(value, ['container', 'index'], ['before', 'after'])) return false;
  return (
    nodeId(value.container) &&
    typeof value.index === 'number' &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    (value.before === undefined || nodeId(value.before)) &&
    (value.after === undefined || nodeId(value.after))
  );
}

function fragment(value: unknown): value is SourceFragment {
  if (!(
    exactRecord(value, ['category', 'source']) &&
    typeof value.category === 'string' &&
    FRAGMENT_CATEGORIES.has(value.category) &&
    denseDataArray(value.source) &&
    value.source.length <= STANDARD_SEMANTIC_EDIT_LIMITS.fragmentBytes &&
    value.source.every((byte) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ))
    return false;
  try {
    utf8Decoder.decode(Uint8Array.from(value.source));
    return true;
  } catch {
    return false;
  }
}

function statementRange(value: unknown): value is SemanticStatementRange {
  return (
    exactRecord(value, ['container', 'first', 'last']) &&
    nodeId(value.container) &&
    nodeId(value.first) &&
    nodeId(value.last)
  );
}

function schemaPath(value: unknown): value is SemanticSchemaPath {
  return (
    denseDataArray(value) &&
    value.length <= 64 &&
    value.every(
      (segment) =>
        (typeof segment === 'string' && boundedText(segment)) ||
        (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0),
    )
  );
}

function commentPolicy(value: unknown): value is SemanticCommentPolicy {
  return value === 'delete_owned_comments' || value === 'preserve_owned_comments';
}

function literalValue(value: unknown): value is null | boolean | number | string {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && textEncoder.encode(value).length <= STANDARD_SEMANTIC_EDIT_LIMITS.fragmentBytes) ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function controlSpec(value: unknown): value is SemanticControlSpec {
  if (!plainDataRecord(value)) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.kind === 'if')
    return (
      exactRecord(candidate, ['kind', 'condition', 'branch']) &&
      fragment(candidate.condition) &&
      candidate.condition.category === 'expression' &&
      (candidate.branch === 'true' || candidate.branch === 'false')
    );
  if (candidate.kind === 'for_of')
    return (
      exactRecord(candidate, ['kind', 'binding', 'iterable']) &&
      fragment(candidate.binding) &&
      candidate.binding.category === 'binding_pattern' &&
      fragment(candidate.iterable) &&
      candidate.iterable.category === 'expression'
    );
  if (candidate.kind === 'for_in')
    return (
      exactRecord(candidate, ['kind', 'binding', 'value']) &&
      fragment(candidate.binding) &&
      candidate.binding.category === 'binding_pattern' &&
      fragment(candidate.value) &&
      candidate.value.category === 'expression'
    );
  if (candidate.kind === 'while' || candidate.kind === 'do')
    return (
      exactRecord(candidate, ['kind', 'condition']) &&
      fragment(candidate.condition) &&
      candidate.condition.category === 'expression'
    );
  if (candidate.kind === 'for')
    return (
      closedRecord(candidate, ['kind'], ['initializer', 'condition', 'increment']) &&
      (candidate.initializer === undefined ||
        (fragment(candidate.initializer) && candidate.initializer.category === 'statement')) &&
      (candidate.condition === undefined ||
        (fragment(candidate.condition) && candidate.condition.category === 'expression')) &&
      (candidate.increment === undefined ||
        (fragment(candidate.increment) && candidate.increment.category === 'expression'))
    );
  return (
    candidate.kind === 'switch' &&
    exactRecord(candidate, ['kind', 'value']) &&
    fragment(candidate.value) &&
    candidate.value.category === 'expression'
  );
}

function semanticEditPrecondition(value: unknown): value is SemanticEditPrecondition {
  if (!exactRecord(value, ['kind', 'value']) || typeof value.kind !== 'string') return false;
  if (value.kind === 'target_kind') return typeof value.value === 'string' && NODE_KINDS.has(value.value);
  if (value.kind === 'target_semantic_kind') return typeof value.value === 'string' && SEMANTIC_KINDS.has(value.value);
  if (value.kind === 'old_name') return identifier(value.value);
  if (value.kind === 'old_literal') return literalValue(value.value);
  if (value.kind === 'old_operator') return typeof value.value === 'string' && OPERATORS.has(value.value);
  if (value.kind === 'old_operation') return typeof value.value === 'string' && OPERATION_ID.test(value.value);
  if (value.kind === 'expected_parent') return nodeId(value.value);
  if (value.kind === 'expected_anchor') return anchor(value.value);
  if (value.kind === 'expected_type') return typeof value.value === 'string' && DIGEST.test(value.value);
  if (value.kind === 'expected_bindings' || value.kind === 'expected_captures')
    return uniqueArray(value.value, symbolId);
  if (value.kind === 'owned_comments') return typeof value.value === 'boolean';
  return false;
}

function editBase(value: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof value.editId === 'string' &&
    EDIT_ID.test(value.editId) &&
    denseDataArray(value.preconditions) &&
    value.preconditions.length <= 64 &&
    value.preconditions.every(semanticEditPrecondition)
  );
}

function editRecord(
  value: unknown,
  kind: SemanticEditKind,
  fields: readonly string[],
): value is Readonly<Record<string, unknown>> {
  return exactRecord(value, ['kind', 'editId', 'preconditions', ...fields]) && value.kind === kind && editBase(value);
}

function branch(value: unknown): boolean {
  if (exactRecord(value, ['kind', 'body']) && value.kind === 'else')
    return fragment(value.body) && value.body.category === 'statement_list';
  return (
    exactRecord(value, ['kind', 'value', 'body']) &&
    value.kind === 'switch_case' &&
    fragment(value.value) &&
    value.value.category === 'expression' &&
    fragment(value.body) &&
    value.body.category === 'statement_list'
  );
}

function retainedContainers(value: unknown): boolean {
  return uniqueArray(
    value,
    (item) => exactRecord(item, ['from', 'role']) && nodeId(item.from) && boundedText(item.role),
  );
}

function parameterMappings(value: unknown): boolean {
  return uniqueArray(
    value,
    (item) => exactRecord(item, ['symbol', 'name']) && symbolId(item.symbol) && identifier(item.name),
  );
}

function parameterArguments(value: unknown): boolean {
  return uniqueArray(
    value,
    (item) => exactRecord(item, ['parameter', 'argument']) && nodeId(item.parameter) && nodeId(item.argument),
  );
}

function actionFieldMappings(value: unknown): boolean {
  return uniqueArray(
    value,
    (item) => exactRecord(item, ['from', 'to']) && schemaPath(item.from) && schemaPath(item.to),
  );
}

function requiredInputs(value: unknown): boolean {
  return uniqueArray(
    value,
    (item) =>
      exactRecord(item, ['path', 'value']) &&
      schemaPath(item.path) &&
      fragment(item.value) &&
      item.value.category === 'expression',
  );
}

function versionOne(value: unknown): value is Version {
  return exactRecord(value, ['major', 'minor']) && value.major === 1 && value.minor === 0;
}

function limitsRecord<Limits extends object>(value: unknown, standard: Limits): value is Limits {
  const keys = Object.keys(standard) as (keyof Limits & string)[];
  return (
    exactRecord(value, keys) &&
    keys.every((key) => {
      const selected = value[key];
      const maximum = standard[key];
      return (
        typeof selected === 'number' &&
        typeof maximum === 'number' &&
        Number.isSafeInteger(selected) &&
        selected >= 0 &&
        selected <= maximum
      );
    })
  );
}

function semanticEditCapabilityViewRequestValid(value: unknown): value is SemanticEditCapabilityViewRequest {
  if (!exactRecord(value, ['kind', 'schema', 'scope', 'limits'])) return false;
  const scope =
    value.scope === 'all' ||
    (exactRecord(value.scope, ['targets']) && uniqueArray(value.scope.targets, nodeId, 500_000));
  return (
    value.kind === 'semantic_edit_capabilities' &&
    versionOne(value.schema) &&
    scope &&
    limitsRecord(value.limits, STANDARD_SEMANTIC_EDIT_CAPABILITY_LIMITS)
  );
}

/** Strict validation for the tagged capability-view request before compiler work. */
export function isSemanticEditCapabilityViewRequest(value: unknown): value is SemanticEditCapabilityViewRequest {
  try {
    return semanticEditCapabilityViewRequestValid(value);
  } catch {
    return false;
  }
}

function graphViewRequest(value: unknown): boolean {
  return (
    exactRecord(value, ['kind', 'schema', 'limits']) &&
    value.kind === 'semantic_graph' &&
    versionOne(value.schema) &&
    limitsRecord(value.limits, { nodes: 100_000, edges: 250_000, bytes: 4 * 1024 * 1024 })
  );
}

function inspectViewRequest(value: unknown): boolean {
  return graphViewRequest(value) || isSemanticEditCapabilityViewRequest(value);
}

function byteArray(value: unknown, maximum: number): value is CanonicalBytes {
  return (
    denseDataArray(value) &&
    value.length <= maximum &&
    value.every((byte) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
}

function fragmentByteUsage(value: unknown, stack = new Set<unknown>()): number {
  if (value === null || typeof value !== 'object') return 0;
  if (stack.has(value)) return Number.POSITIVE_INFINITY;
  stack.add(value);
  let total: number;
  if (fragment(value)) total = value.source.length;
  else if (denseDataArray(value)) {
    total = 0;
    for (const item of value) total += fragmentByteUsage(item, stack);
  } else if (plainDataRecord(value)) {
    total = 0;
    for (const item of Object.values(value)) total += fragmentByteUsage(item, stack);
  } else total = Number.POSITIVE_INFINITY;
  stack.delete(value);
  return total;
}

/**
 * Validates the closed edit-specific request envelope and bounded operation payloads.
 *
 * @remarks Contract-registry and compile semantics are deliberately left to the ordinary check path; this guard
 * prevents malformed edit records from reaching semantic target resolution.
 */
function applySemanticEditsRequestValid(value: unknown): value is ApplySemanticEditsRequest {
  if (
    !closedRecord(
      value,
      ['registry', 'slotId', 'source', 'limits', 'editSchema', 'graphSchema', 'baseRevision', 'edits', 'editLimits'],
      ['includeArtifact', 'cachedArtifact', 'views'],
    )
  )
    return false;
  if (
    !plainDataRecord(value.registry) ||
    typeof value.slotId !== 'string' ||
    !/^slot:[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(value.slotId) ||
    !exactRecord(value.source, ['module', 'source']) ||
    typeof value.source.module !== 'string' ||
    !/^module:@?[a-z][a-z0-9-]*(?:[/.][a-z][a-z0-9-]*)*$/.test(value.source.module) ||
    !byteArray(value.source.source, STANDARD_SEMANTIC_EDIT_LIMITS.sourceBytes) ||
    !plainDataRecord(value.limits) ||
    !versionOne(value.editSchema) ||
    !versionOne(value.graphSchema) ||
    typeof value.baseRevision !== 'string' ||
    !/^semantic-revision:[0-9a-f]{64}$/.test(value.baseRevision) ||
    (value.includeArtifact !== undefined && typeof value.includeArtifact !== 'boolean') ||
    (value.cachedArtifact !== undefined && !byteArray(value.cachedArtifact, 16 * 1024 * 1024))
  )
    return false;
  if (!limitsRecord(value.editLimits, STANDARD_SEMANTIC_EDIT_LIMITS) || !denseDataArray(value.edits)) return false;
  const editLimits = value.editLimits;
  if (
    value.edits.length === 0 ||
    value.edits.length > editLimits.operations ||
    !value.edits.every(isSemanticEdit) ||
    new Set(value.edits.map((edit) => edit.editId)).size !== value.edits.length ||
    fragmentByteUsage(value.edits) > editLimits.fragmentBytes ||
    value.source.source.length > editLimits.sourceBytes
  )
    return false;
  if (value.views === undefined) return true;
  if (!denseDataArray(value.views) || value.views.length > 2 || !value.views.every(inspectViewRequest)) return false;
  const views = value.views as readonly InspectViewRequest[];
  return new Set(views.map((view) => view.kind)).size === views.length;
}

/** Strict hostile-input-safe validation for an atomic semantic edit request. */
export function isApplySemanticEditsRequest(value: unknown): value is ApplySemanticEditsRequest {
  try {
    return applySemanticEditsRequestValid(value);
  } catch {
    return false;
  }
}

/** Validates and brands one bounded caller correlation identity. */
export function semanticEditId(value: string): SemanticEditId {
  if (!EDIT_ID.test(value)) throw new TypeError('invalid semantic edit identifier');
  return value as SemanticEditId;
}

function semanticEditValid(value: unknown): value is SemanticEdit {
  if (!plainDataRecord(value)) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  switch (candidate.kind) {
    case 'rename_symbol':
      return (
        editRecord(candidate, candidate.kind, ['target', 'newName']) &&
        nodeId(candidate.target) &&
        identifier(candidate.newName)
      );
    case 'replace_target':
      return (
        editRecord(candidate, candidate.kind, ['target', 'replacement']) &&
        nodeId(candidate.target) &&
        fragment(candidate.replacement)
      );
    case 'insert_at_anchor':
      return (
        editRecord(candidate, candidate.kind, ['anchor', 'fragment']) &&
        anchor(candidate.anchor) &&
        fragment(candidate.fragment)
      );
    case 'delete_target':
    case 'remove_branch':
      return (
        editRecord(candidate, candidate.kind, ['target', 'commentPolicy']) &&
        nodeId(candidate.target) &&
        commentPolicy(candidate.commentPolicy)
      );
    case 'move_target':
      return (
        editRecord(candidate, candidate.kind, ['target', 'destination']) &&
        nodeId(candidate.target) &&
        anchor(candidate.destination)
      );
    case 'reorder_children':
      return (
        editRecord(candidate, candidate.kind, ['container', 'children']) &&
        nodeId(candidate.container) &&
        uniqueArray(candidate.children, nodeId)
      );
    case 'wrap_statement_range':
      return (
        editRecord(candidate, candidate.kind, ['range', 'control']) &&
        statementRange(candidate.range) &&
        controlSpec(candidate.control)
      );
    case 'move_statement_range':
      return (
        editRecord(candidate, candidate.kind, ['range', 'destination']) &&
        statementRange(candidate.range) &&
        anchor(candidate.destination)
      );
    case 'unwrap_control':
      return (
        editRecord(candidate, candidate.kind, ['target', 'retainedContainer']) &&
        nodeId(candidate.target) &&
        nodeId(candidate.retainedContainer)
      );
    case 'add_branch':
      return (
        editRecord(candidate, candidate.kind, ['target', 'branch']) &&
        nodeId(candidate.target) &&
        branch(candidate.branch)
      );
    case 'convert_control':
      return (
        editRecord(candidate, candidate.kind, ['target', 'control', 'retainedContainers']) &&
        nodeId(candidate.target) &&
        controlSpec(candidate.control) &&
        retainedContainers(candidate.retainedContainers)
      );
    case 'extract_local':
      return (
        editRecord(candidate, candidate.kind, ['target', 'name', 'declaration', 'replaceTargets']) &&
        nodeId(candidate.target) &&
        identifier(candidate.name) &&
        anchor(candidate.declaration) &&
        uniqueArray(candidate.replaceTargets, nodeId)
      );
    case 'inline_local':
      return (
        editRecord(candidate, candidate.kind, ['binding', 'references', 'removeDeclaration', 'commentPolicy']) &&
        nodeId(candidate.binding) &&
        uniqueArray(candidate.references, nodeId) &&
        typeof candidate.removeDeclaration === 'boolean' &&
        commentPolicy(candidate.commentPolicy)
      );
    case 'extract_function':
      return (
        editRecord(candidate, candidate.kind, ['range', 'name', 'declaration', 'parameters', 'outputs']) &&
        statementRange(candidate.range) &&
        identifier(candidate.name) &&
        anchor(candidate.declaration) &&
        parameterMappings(candidate.parameters) &&
        uniqueArray(candidate.outputs, symbolId)
      );
    case 'inline_function_call':
      return (
        editRecord(candidate, candidate.kind, [
          'call',
          'function',
          'parameterArguments',
          'removeDeclaration',
          'commentPolicy',
        ]) &&
        nodeId(candidate.call) &&
        nodeId(candidate.function) &&
        parameterArguments(candidate.parameterArguments) &&
        typeof candidate.removeDeclaration === 'boolean' &&
        commentPolicy(candidate.commentPolicy)
      );
    case 'change_binding_pattern':
    case 'bind_action_result':
      return (
        editRecord(candidate, candidate.kind, ['target', 'pattern']) &&
        nodeId(candidate.target) &&
        fragment(candidate.pattern) &&
        candidate.pattern.category === 'binding_pattern'
      );
    case 'change_binding_mutability':
      return (
        editRecord(candidate, candidate.kind, ['target', 'mutability']) &&
        nodeId(candidate.target) &&
        (candidate.mutability === 'const' || candidate.mutability === 'let')
      );
    case 'change_action_operation':
      return (
        editRecord(candidate, candidate.kind, ['target', 'operation', 'fieldMappings', 'requiredInputs']) &&
        nodeId(candidate.target) &&
        typeof candidate.operation === 'string' &&
        OPERATION_ID.test(candidate.operation) &&
        actionFieldMappings(candidate.fieldMappings) &&
        requiredInputs(candidate.requiredInputs)
      );
    case 'set_action_input_field':
      return (
        editRecord(candidate, candidate.kind, ['target', 'path', 'value']) &&
        nodeId(candidate.target) &&
        schemaPath(candidate.path) &&
        fragment(candidate.value) &&
        candidate.value.category === 'expression'
      );
    case 'remove_action_input_field':
      return (
        editRecord(candidate, candidate.kind, ['target', 'path']) &&
        nodeId(candidate.target) &&
        schemaPath(candidate.path)
      );
    case 'add_action_result_branch':
      return (
        editRecord(candidate, candidate.kind, ['target', 'variant', 'body']) &&
        nodeId(candidate.target) &&
        (candidate.variant === 'ok' || candidate.variant === 'error') &&
        fragment(candidate.body) &&
        candidate.body.category === 'statement_list'
      );
    case 'set_literal_value':
      return (
        editRecord(candidate, candidate.kind, ['target', 'value']) &&
        nodeId(candidate.target) &&
        literalValue(candidate.value)
      );
    case 'change_operator':
      return (
        editRecord(candidate, candidate.kind, ['target', 'operator']) &&
        nodeId(candidate.target) &&
        typeof candidate.operator === 'string' &&
        OPERATORS.has(candidate.operator)
      );
    case 'change_member_name':
    case 'change_object_field_name':
      return (
        editRecord(candidate, candidate.kind, ['target', 'name']) &&
        nodeId(candidate.target) &&
        identifier(candidate.name)
      );
    case 'toggle_optional_access':
      return (
        editRecord(candidate, candidate.kind, ['target', 'optional']) &&
        nodeId(candidate.target) &&
        typeof candidate.optional === 'boolean'
      );
    case 'change_call_callee':
      return (
        editRecord(candidate, candidate.kind, ['target', 'callee']) &&
        nodeId(candidate.target) &&
        fragment(candidate.callee) &&
        candidate.callee.category === 'expression'
      );
    case 'change_result_variant':
      return (
        editRecord(candidate, candidate.kind, ['target', 'variant']) &&
        nodeId(candidate.target) &&
        (candidate.variant === 'ok' || candidate.variant === 'error')
      );
    default:
      return false;
  }
}

/** Strict closed-record validation used before any semantic target resolution. */
export function isSemanticEdit(value: unknown): value is SemanticEdit {
  try {
    return semanticEditValid(value);
  } catch {
    return false;
  }
}
