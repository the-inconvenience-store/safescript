/** Compiler-owned lossless source transformation planning and provenance. @internal */
import * as ts from 'typescript';

import type {
  CanonicalBytes,
  ModuleId,
  SemanticChangedRegion,
  SemanticCommentPolicy,
  SemanticEditDiagnosticLocation,
  SemanticEditId,
  SemanticEditLimitError,
  SemanticEditLimits,
  SemanticEditUsage,
  SemanticNodeId,
  SemanticTransformationProvenance,
  SourceFragment,
  SourceLocation,
  SourceProgram,
} from '@safescript/contracts';

export const SOURCE_TRANSFORMATION_CONFLICT_MATRIX_VERSION = 1 as const;

export interface SourceByteRange {
  readonly start: number;
  readonly end: number;
}

export interface SourceTransformationContent {
  readonly bytes: Uint8Array | readonly number[];
  readonly origin: 'fragment' | 'generated';
}

interface TransformationBase {
  readonly editId: SemanticEditId;
  readonly targets: readonly SemanticNodeId[];
}

export type SourceTransformation =
  | (TransformationBase & Readonly<{ kind: 'replace'; range: SourceByteRange; content: SourceTransformationContent }>)
  | (TransformationBase & Readonly<{ kind: 'insert'; at: number; content: SourceTransformationContent }>)
  | (TransformationBase & Readonly<{ kind: 'delete'; range: SourceByteRange; commentPolicy: SemanticCommentPolicy }>)
  | (TransformationBase & Readonly<{ kind: 'move'; range: SourceByteRange; destination: number }>);

export interface SourceTransformationConflict {
  readonly editIds: readonly SemanticEditId[];
  readonly targets: readonly SemanticNodeId[];
}

export interface CandidateDiagnostic {
  readonly message: string;
  readonly start: number;
  readonly end: number;
}

export interface MappedCandidateDiagnostic {
  readonly message: string;
  readonly location?: SemanticEditDiagnosticLocation;
}

export type CandidateValidator = (
  source: SourceProgram,
) => Readonly<{ ok: true }> | Readonly<{ ok: false; diagnostics: readonly CandidateDiagnostic[] }>;

export type ApplySourceTransformationsResult =
  | Readonly<{
      status: 'accepted';
      source: SourceProgram;
      changedRegions: readonly SemanticChangedRegion[];
      provenance: readonly SemanticTransformationProvenance[];
      usage: SemanticEditUsage;
    }>
  | Readonly<{
      status: 'rejected';
      reason: 'invalid_transformation' | 'conflicting_transformations' | 'candidate_rejected' | 'limit_exceeded';
      conflicts?: readonly SourceTransformationConflict[];
      diagnostics?: readonly MappedCandidateDiagnostic[];
      limit?: SemanticEditLimitError;
      usage: SemanticEditUsage;
    }>;

type CommentRange = SourceByteRange;

interface NormalizedTransformation {
  readonly ordinal: number;
  readonly source: SourceTransformation;
  readonly removal?: SourceByteRange;
  readonly insertion?: Readonly<{
    at: number;
    bytes: Uint8Array;
    origin: 'fragment' | 'generated' | 'moved';
    original?: SourceByteRange;
  }>;
}

interface ProvenanceSegment {
  readonly kind: 'original' | 'fragment' | 'generated' | 'moved';
  readonly updated: SourceByteRange;
  readonly original?: SourceByteRange;
  readonly editId?: SemanticEditId;
  readonly target?: SemanticNodeId;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function canonicalBytes(value: Uint8Array | readonly number[]): Uint8Array | undefined {
  if (
    !(value instanceof Uint8Array) &&
    (!Array.isArray(value) ||
      value.some((byte) => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255))
  )
    return undefined;
  return Uint8Array.from(value);
}

function location(module: ModuleId, range: SourceByteRange): SourceLocation {
  return Object.freeze({ module, start: range.start, end: range.end });
}

function usage(overrides: Partial<SemanticEditUsage> = {}): SemanticEditUsage {
  return Object.freeze({
    operations: 0,
    fragmentBytes: 0,
    transformedRegions: 0,
    work: 0,
    provenanceEntries: 0,
    diffBytes: 0,
    sourceBytes: 0,
    ...overrides,
  });
}

function limitName(limit: keyof SemanticEditLimits): SemanticEditLimitError['limit'] {
  const names: Readonly<Record<keyof SemanticEditLimits, SemanticEditLimitError['limit']>> = {
    operations: 'operations',
    fragmentBytes: 'fragment_bytes',
    transformedRegions: 'transformed_regions',
    work: 'work',
    provenanceEntries: 'provenance_entries',
    diffBytes: 'diff_bytes',
    sourceBytes: 'source_bytes',
  };
  return names[limit];
}

function limitError(
  limit: keyof SemanticEditLimits,
  maximum: number,
  actual: number,
  measured: SemanticEditUsage,
): ApplySourceTransformationsResult | undefined {
  if (actual <= maximum) return undefined;
  return Object.freeze({
    status: 'rejected',
    reason: 'limit_exceeded',
    limit: Object.freeze({ limit: limitName(limit), maximum, actual }),
    usage: measured,
  });
}

function validRange(range: SourceByteRange, length: number): boolean {
  return (
    Number.isSafeInteger(range.start) &&
    Number.isSafeInteger(range.end) &&
    range.start >= 0 &&
    range.end > range.start &&
    range.end <= length
  );
}

function blankLine(value: string): boolean {
  return /(?:\r\n|\n|\r)[\t ]*(?:\r\n|\n|\r)/.test(value);
}

/** Immutable source, UTF-8 boundary, and comment-ownership index for one accepted module. */
export class EditableSourceDocument {
  readonly source: SourceProgram;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly newline: '\n' | '\r\n';
  readonly #byteAtCodeUnit: Uint32Array;
  readonly #codeUnitAtByte = new Map<number, number>();
  readonly #comments: readonly CommentRange[];

  constructor(source: SourceProgram) {
    const bytes = canonicalBytes(source.source);
    if (!bytes) throw new TypeError('editable source requires canonical bytes');
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw new TypeError('editable source requires canonical UTF-8');
    }
    if (encoder.encode(text).length !== bytes.length) throw new TypeError('editable source is not canonical UTF-8');
    this.source = Object.freeze({ module: source.module, source: Object.freeze(Array.from(bytes)) });
    this.text = text;
    this.bytes = bytes;
    this.newline = text.includes('\r\n') ? '\r\n' : '\n';
    this.#byteAtCodeUnit = new Uint32Array(text.length + 1);
    let codeUnit = 0;
    let byte = 0;
    this.#codeUnitAtByte.set(0, 0);
    for (const character of text) {
      this.#byteAtCodeUnit[codeUnit] = byte;
      codeUnit += character.length;
      byte += encoder.encode(character).length;
      this.#byteAtCodeUnit[codeUnit] = byte;
      this.#codeUnitAtByte.set(byte, codeUnit);
    }
    this.#comments = this.#scanComments();
    Object.freeze(this);
  }

  #scanComments(): readonly CommentRange[] {
    const scanner = ts.createScanner(ts.ScriptTarget.ESNext, false, ts.LanguageVariant.Standard, this.text);
    const comments: CommentRange[] = [];
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
      comments.push(
        Object.freeze({
          start: this.#byteAtCodeUnit[scanner.getTokenPos()] as number,
          end: this.#byteAtCodeUnit[scanner.getTextPos()] as number,
        }),
      );
    }
    return Object.freeze(comments);
  }

  #sliceText(start: number, end: number): string {
    const first = this.#codeUnitAtByte.get(start);
    const last = this.#codeUnitAtByte.get(end);
    if (first === undefined || last === undefined) throw new RangeError('source range splits a UTF-8 code point');
    return this.text.slice(first, last);
  }

  isBoundary(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && value <= this.bytes.length && this.#codeUnitAtByte.has(value);
  }

  /** Expands an editable token range to deterministic leading and same-line trailing comment ownership. */
  ownedRange(range: SourceByteRange): SourceByteRange {
    if (!validRange(range, this.bytes.length) || !this.isBoundary(range.start) || !this.isBoundary(range.end))
      throw new RangeError('invalid editable source range');
    let start = range.start;
    let cursor = range.start;
    for (let index = this.#comments.length - 1; index >= 0; index--) {
      const comment = this.#comments[index] as CommentRange;
      if (comment.end > cursor) continue;
      const gap = this.#sliceText(comment.end, cursor);
      if (!/^\s*$/.test(gap) || blankLine(gap)) break;
      start = comment.start;
      cursor = comment.start;
    }
    const startCodeUnit = this.#codeUnitAtByte.get(start) as number;
    const lineStart = Math.max(this.text.lastIndexOf('\n', Math.max(0, startCodeUnit - 1)) + 1, 0);
    if (/^[\t ]*$/.test(this.text.slice(lineStart, startCodeUnit))) start = this.#byteAtCodeUnit[lineStart] as number;

    let end = range.end;
    for (const comment of this.#comments) {
      if (comment.start < end) continue;
      const gap = this.#sliceText(end, comment.start);
      if (!/^[\t ]*$/.test(gap)) break;
      end = comment.end;
    }
    return Object.freeze({ start, end });
  }

  indentationAt(byteOffset: number): string {
    if (!this.isBoundary(byteOffset)) throw new RangeError('invalid source boundary');
    const codeUnit = this.#codeUnitAtByte.get(byteOffset) as number;
    const lineStart = this.text.lastIndexOf('\n', Math.max(0, codeUnit - 1)) + 1;
    const indentation = this.text.slice(lineStart, codeUnit).match(/^[\t ]*/)?.[0] ?? '';
    return indentation;
  }

  lineStart(byteOffset: number): number {
    if (!this.isBoundary(byteOffset)) throw new RangeError('invalid source boundary');
    const codeUnit = this.#codeUnitAtByte.get(byteOffset) as number;
    const lineStart = this.text.lastIndexOf('\n', Math.max(0, codeUnit - 1)) + 1;
    return this.#byteAtCodeUnit[lineStart] as number;
  }

  lineEnd(byteOffset: number): number {
    if (!this.isBoundary(byteOffset)) throw new RangeError('invalid source boundary');
    const codeUnit = this.#codeUnitAtByte.get(byteOffset) as number;
    const newline = this.text.indexOf('\n', codeUnit);
    return newline < 0 ? this.bytes.length : (this.#byteAtCodeUnit[newline + 1] as number);
  }

  lineRange(range: SourceByteRange): SourceByteRange {
    if (!validRange(range, this.bytes.length)) throw new RangeError('invalid source range');
    return Object.freeze({ start: this.lineStart(range.start), end: this.lineEnd(range.end) });
  }
}

function normalize(
  document: EditableSourceDocument,
  value: SourceTransformation,
  ordinal: number,
): NormalizedTransformation | undefined {
  if (!value.editId || !Array.isArray(value.targets)) return undefined;
  if (value.kind === 'insert') {
    if (!document.isBoundary(value.at)) return undefined;
    const bytes = canonicalBytes(value.content.bytes);
    if (!bytes) return undefined;
    return { ordinal, source: value, insertion: { at: value.at, bytes, origin: value.content.origin } };
  }
  if (
    !validRange(value.range, document.bytes.length) ||
    !document.isBoundary(value.range.start) ||
    !document.isBoundary(value.range.end)
  )
    return undefined;
  if (value.kind === 'replace') {
    const bytes = canonicalBytes(value.content.bytes);
    if (!bytes) return undefined;
    return {
      ordinal,
      source: value,
      removal: value.range,
      insertion: { at: value.range.start, bytes, origin: value.content.origin },
    };
  }
  if (value.kind === 'delete') {
    const removal = value.commentPolicy === 'delete_owned_comments' ? document.ownedRange(value.range) : value.range;
    return { ordinal, source: value, removal };
  }
  if (!document.isBoundary(value.destination)) return undefined;
  const removal = document.ownedRange(value.range);
  if (value.destination >= removal.start && value.destination <= removal.end) return undefined;
  return {
    ordinal,
    source: value,
    removal,
    insertion: {
      at: value.destination,
      bytes: document.bytes.slice(removal.start, removal.end),
      origin: 'moved',
      original: removal,
    },
  };
}

function conflictRecord(left: SourceTransformation, right: SourceTransformation): SourceTransformationConflict {
  return Object.freeze({
    editIds: Object.freeze([...new Set([left.editId, right.editId])].sort()),
    targets: Object.freeze([...new Set([...left.targets, ...right.targets])].sort()),
  });
}

function firstConflict(values: readonly NormalizedTransformation[]): SourceTransformationConflict | undefined {
  const events = values
    .flatMap((value) => [
      ...(value.insertion ? [{ kind: 'insertion' as const, position: value.insertion.at, value }] : []),
      ...(value.removal ? [{ kind: 'removal' as const, position: value.removal.start, value }] : []),
    ])
    .sort((left, right) => {
      const byPosition = left.position - right.position;
      if (byPosition) return byPosition;
      const byKind = left.kind === right.kind ? 0 : left.kind === 'insertion' ? -1 : 1;
      return byKind || left.value.ordinal - right.value.ordinal;
    });
  let activeRemoval: NormalizedTransformation | undefined;
  let insertionAtPosition: NormalizedTransformation | undefined;
  let insertionPosition = -1;
  for (const event of events) {
    if (event.kind === 'insertion') {
      if (activeRemoval?.removal && activeRemoval.removal.end < event.position) activeRemoval = undefined;
      if (activeRemoval && activeRemoval !== event.value)
        return conflictRecord(activeRemoval.source, event.value.source);
      if (insertionPosition === event.position && insertionAtPosition && insertionAtPosition !== event.value)
        return conflictRecord(insertionAtPosition.source, event.value.source);
      insertionPosition = event.position;
      insertionAtPosition = event.value;
      continue;
    }
    if (activeRemoval?.removal && activeRemoval.removal.end <= event.position) activeRemoval = undefined;
    if (activeRemoval && activeRemoval !== event.value) return conflictRecord(activeRemoval.source, event.value.source);
    if (insertionPosition === event.position && insertionAtPosition && insertionAtPosition !== event.value)
      return conflictRecord(insertionAtPosition.source, event.value.source);
    activeRemoval = event.value;
  }
  return undefined;
}

function transformedUsage(
  transformations: readonly SourceTransformation[],
  fragmentBytes: number,
  transformedRegions: number,
  work: number,
  provenanceEntries: number,
  sourceBytes: number,
): SemanticEditUsage {
  return usage({
    operations: new Set(transformations.map((value) => value.editId)).size,
    fragmentBytes,
    transformedRegions,
    work,
    provenanceEntries,
    sourceBytes,
  });
}

function mapDiagnostic(
  diagnostic: CandidateDiagnostic,
  segments: readonly ProvenanceSegment[],
  module: ModuleId,
): MappedCandidateDiagnostic {
  const segment = segments.find(
    (candidate) => diagnostic.start >= candidate.updated.start && diagnostic.start < candidate.updated.end,
  );
  if (!segment) return Object.freeze({ message: diagnostic.message });
  if ((segment.kind === 'original' || segment.kind === 'moved') && segment.original) {
    const offset = Math.min(diagnostic.start - segment.updated.start, segment.original.end - segment.original.start);
    const length = Math.min(
      Math.max(0, diagnostic.end - diagnostic.start),
      segment.original.end - segment.original.start - offset,
    );
    return Object.freeze({
      message: diagnostic.message,
      location: Object.freeze({
        kind: 'original_source' as const,
        location: location(module, {
          start: segment.original.start + offset,
          end: segment.original.start + offset + length,
        }),
      }),
    });
  }
  if (segment.kind === 'fragment' && segment.editId) {
    const start = Math.max(0, diagnostic.start - segment.updated.start);
    const end = Math.min(
      segment.updated.end - segment.updated.start,
      Math.max(start, diagnostic.end - segment.updated.start),
    );
    return Object.freeze({
      message: diagnostic.message,
      location: Object.freeze({ kind: 'fragment' as const, editId: segment.editId, start, end }),
    });
  }
  if (segment.editId && segment.target)
    return Object.freeze({
      message: diagnostic.message,
      location: Object.freeze({ kind: 'generated' as const, editId: segment.editId, target: segment.target }),
    });
  return Object.freeze({ message: diagnostic.message });
}

/** Plans, applies, accounts, validates, and provenance-maps one atomic original-coordinate batch. */
export function applySourceTransformations(
  document: EditableSourceDocument,
  transformations: readonly SourceTransformation[],
  limits: SemanticEditLimits,
  validate?: CandidateValidator,
): ApplySourceTransformationsResult {
  const operationCount = new Set(transformations.map((value) => value.editId)).size;
  let measured = usage({
    operations: operationCount,
    transformedRegions: transformations.length,
    sourceBytes: document.bytes.length,
  });
  const earlyLimits: readonly [keyof SemanticEditLimits, number][] = [
    ['operations', operationCount],
    ['transformedRegions', transformations.length],
  ];
  for (const [name, actual] of earlyLimits) {
    const failed = limitError(name, limits[name], actual, measured);
    if (failed) return failed;
  }
  const normalized: NormalizedTransformation[] = [];
  for (const [ordinal, transformation] of transformations.entries()) {
    const selected = normalize(document, transformation, ordinal);
    if (!selected) return Object.freeze({ status: 'rejected', reason: 'invalid_transformation', usage: measured });
    normalized.push(selected);
  }
  const fragmentBytes = normalized.reduce(
    (total, value) =>
      total + (value.insertion && value.insertion.origin !== 'moved' ? value.insertion.bytes.length : 0),
    0,
  );
  const work =
    document.bytes.length +
    normalized.reduce(
      (total, value) =>
        total +
        (value.removal ? value.removal.end - value.removal.start : 0) +
        (value.insertion ? value.insertion.bytes.length : 0) +
        1,
      0,
    );
  measured = transformedUsage(transformations, fragmentBytes, transformations.length, work, 0, document.bytes.length);
  for (const [name, actual] of [
    ['fragmentBytes', fragmentBytes],
    ['work', work],
  ] as const) {
    const failed = limitError(name, limits[name], actual, measured);
    if (failed) return failed;
  }
  const foundConflict = firstConflict(normalized);
  if (foundConflict)
    return Object.freeze({
      status: 'rejected',
      reason: 'conflicting_transformations',
      conflicts: Object.freeze([foundConflict]),
      usage: measured,
    });

  const removals = normalized
    .filter((value) => value.removal)
    .sort((left, right) => {
      const byStart = (left.removal as SourceByteRange).start - (right.removal as SourceByteRange).start;
      return byStart || left.ordinal - right.ordinal;
    });
  const insertions = normalized
    .filter((value) => value.insertion)
    .sort((left, right) => {
      const byPosition =
        (left.insertion as NonNullable<NormalizedTransformation['insertion']>).at -
        (right.insertion as NonNullable<NormalizedTransformation['insertion']>).at;
      return byPosition || left.ordinal - right.ordinal;
    });
  const positions = [
    ...new Set([
      ...removals.map((value) => (value.removal as SourceByteRange).start),
      ...insertions.map((value) => (value.insertion as NonNullable<NormalizedTransformation['insertion']>).at),
      document.bytes.length,
    ]),
  ].sort((left, right) => left - right);
  const insertionsAt = new Map<number, NormalizedTransformation[]>();
  const removalsAt = new Map<number, NormalizedTransformation[]>();
  for (const value of insertions) {
    const position = (value.insertion as NonNullable<NormalizedTransformation['insertion']>).at;
    const selected = insertionsAt.get(position);
    if (selected) selected.push(value);
    else insertionsAt.set(position, [value]);
  }
  for (const value of removals) {
    const position = (value.removal as SourceByteRange).start;
    const selected = removalsAt.get(position);
    if (selected) selected.push(value);
    else removalsAt.set(position, [value]);
  }
  const output: number[] = [];
  const segments: ProvenanceSegment[] = [];
  const publicProvenance: SemanticTransformationProvenance[] = [];
  const updatedByOrdinal = new Map<number, SourceByteRange>();
  let cursor = 0;
  const appendOriginal = (start: number, end: number): void => {
    if (end <= start) return;
    const updated = { start: output.length, end: output.length + end - start };
    output.push(...document.bytes.slice(start, end));
    const original = { start, end };
    segments.push({ kind: 'original', original, updated });
    publicProvenance.push(
      Object.freeze({
        kind: 'original',
        original: location(document.source.module, original),
        updated: location(document.source.module, updated),
        editIds: Object.freeze([]),
        targets: Object.freeze([]),
      }),
    );
  };
  for (const position of positions) {
    if (position > cursor) {
      appendOriginal(cursor, position);
      cursor = position;
    }
    for (const value of insertionsAt.get(position) ?? []) {
      const insertion = value.insertion as NonNullable<NormalizedTransformation['insertion']>;
      const updated = { start: output.length, end: output.length + insertion.bytes.length };
      output.push(...insertion.bytes);
      updatedByOrdinal.set(value.ordinal, updated);
      const target = value.source.targets[0];
      segments.push({
        kind: insertion.origin,
        updated,
        ...(insertion.original ? { original: insertion.original } : {}),
        editId: value.source.editId,
        ...(target ? { target } : {}),
      });
      publicProvenance.push(
        Object.freeze({
          kind: insertion.origin === 'moved' ? 'moved' : 'generated',
          ...(insertion.original ? { original: location(document.source.module, insertion.original) } : {}),
          updated: location(document.source.module, updated),
          editIds: Object.freeze([value.source.editId]),
          targets: Object.freeze([...value.source.targets]),
        }),
      );
    }
    for (const value of removalsAt.get(position) ?? []) {
      const removal = value.removal as SourceByteRange;
      cursor = Math.max(cursor, removal.end);
      publicProvenance.push(
        Object.freeze({
          kind: 'removed',
          original: location(document.source.module, removal),
          editIds: Object.freeze([value.source.editId]),
          targets: Object.freeze([...value.source.targets]),
        }),
      );
    }
  }
  const candidateBytes = Uint8Array.from(output);
  measured = transformedUsage(
    transformations,
    fragmentBytes,
    transformations.length,
    work,
    publicProvenance.length,
    candidateBytes.length,
  );
  for (const [name, actual] of [
    ['provenanceEntries', publicProvenance.length],
    ['sourceBytes', candidateBytes.length],
  ] as const) {
    const failed = limitError(name, limits[name], actual, measured);
    if (failed) return failed;
  }
  const source: SourceProgram = Object.freeze({
    module: document.source.module,
    source: Object.freeze(Array.from(candidateBytes)) as CanonicalBytes,
  });
  if (validate) {
    const checked = validate(source);
    if (!checked.ok)
      return Object.freeze({
        status: 'rejected',
        reason: 'candidate_rejected',
        diagnostics: Object.freeze(
          checked.diagnostics.map((diagnostic) => mapDiagnostic(diagnostic, segments, source.module)),
        ),
        usage: measured,
      });
  }
  const changedRegions = normalized.map((value): SemanticChangedRegion => {
    const updated = updatedByOrdinal.get(value.ordinal);
    return Object.freeze({
      ...(value.removal ? { original: location(source.module, value.removal) } : {}),
      ...(updated ? { updated: location(source.module, updated) } : {}),
      editIds: Object.freeze([value.source.editId]),
    });
  });
  return Object.freeze({
    status: 'accepted',
    source,
    changedRegions: Object.freeze(changedRegions),
    provenance: Object.freeze(publicProvenance),
    usage: measured,
  });
}

export interface SourceFragmentPrintContext {
  readonly newline: '\n' | '\r\n';
  readonly indentation: string;
}

export type PrintSourceFragmentResult =
  Readonly<{ ok: true; bytes: CanonicalBytes }> | Readonly<{ ok: false; reason: 'encoding' | 'syntax' | 'category' }>;

function parseDiagnostics(file: ts.SourceFile): readonly ts.DiagnosticWithLocation[] {
  return (
    (file as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ??
    []
  );
}

function declarationStatement(value: ts.Statement): boolean {
  return (
    ts.isVariableStatement(value) ||
    ts.isFunctionDeclaration(value) ||
    ts.isInterfaceDeclaration(value) ||
    ts.isTypeAliasDeclaration(value) ||
    ts.isEnumDeclaration(value) ||
    ts.isClassDeclaration(value) ||
    ts.isImportDeclaration(value)
  );
}

function localIndentation(value: string, context: SourceFragmentPrintContext): string {
  const normalized = value
    .split('\n')
    .map((line, index) => {
      const leading = line.match(/^( +)/)?.[1];
      const match = leading?.length ?? 0;
      const local = match > 0 ? '  '.repeat(Math.floor(match / 4)) + ' '.repeat(match % 4) : '';
      return `${index === 0 ? '' : context.indentation}${local}${line.slice(match)}`;
    })
    .join(context.newline);
  return normalized;
}

/** Parses one explicit fragment category and prints only that synthesized syntax deterministically. */
export function printSourceFragment(
  fragment: SourceFragment,
  context: SourceFragmentPrintContext,
): PrintSourceFragmentResult {
  let source: string;
  try {
    source = decoder.decode(Uint8Array.from(fragment.source));
  } catch {
    return Object.freeze({ ok: false, reason: 'encoding' });
  }
  const parse = (text: string): ts.SourceFile =>
    ts.createSourceFile('fragment.ts', text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  let file: ts.SourceFile;
  let nodes: readonly ts.Node[];
  switch (fragment.category) {
    case 'expression': {
      file = parse(`const __fragment = (${source});`);
      const declaration = (file.statements[0] as ts.VariableStatement | undefined)?.declarationList.declarations[0];
      const initializer = declaration?.initializer;
      nodes = initializer && ts.isParenthesizedExpression(initializer) ? [initializer.expression] : [];
      break;
    }
    case 'statement':
    case 'statement_list':
    case 'declaration':
    case 'declaration_list':
      file = parse(source);
      nodes = file.statements;
      if (fragment.category === 'statement' && nodes.length !== 1) nodes = [];
      if (
        fragment.category === 'declaration' &&
        (nodes.length !== 1 || !declarationStatement(nodes[0] as ts.Statement))
      )
        nodes = [];
      if (
        fragment.category === 'declaration_list' &&
        !nodes.every((node) => declarationStatement(node as ts.Statement))
      )
        nodes = [];
      break;
    case 'type': {
      file = parse(`type __Fragment = ${source};`);
      const statement = file.statements[0];
      nodes = statement && ts.isTypeAliasDeclaration(statement) ? [statement.type] : [];
      break;
    }
    case 'binding_pattern': {
      file = parse(`const ${source} = undefined;`);
      const statement = file.statements[0];
      const name =
        statement && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.name : undefined;
      nodes = name ? [name] : [];
      break;
    }
    case 'parameter': {
      file = parse(`function __fragment(${source}) {}`);
      const statement = file.statements[0];
      nodes =
        statement && ts.isFunctionDeclaration(statement) && statement.parameters.length === 1
          ? [statement.parameters[0] as ts.Node]
          : [];
      break;
    }
    case 'argument': {
      file = parse(`__fragment(${source});`);
      const statement = file.statements[0];
      const expression = statement && ts.isExpressionStatement(statement) ? statement.expression : undefined;
      nodes =
        expression && ts.isCallExpression(expression) && expression.arguments.length === 1
          ? [expression.arguments[0] as ts.Node]
          : [];
      break;
    }
    case 'object_member': {
      file = parse(`const __fragment = ({ ${source} });`);
      const statement = file.statements[0];
      const initializer =
        statement && ts.isVariableStatement(statement)
          ? statement.declarationList.declarations[0]?.initializer
          : undefined;
      const object = initializer && ts.isParenthesizedExpression(initializer) ? initializer.expression : initializer;
      nodes =
        object && ts.isObjectLiteralExpression(object) && object.properties.length === 1
          ? [object.properties[0] as ts.Node]
          : [];
      break;
    }
    case 'array_element': {
      file = parse(`const __fragment = [${source}];`);
      const statement = file.statements[0];
      const value =
        statement && ts.isVariableStatement(statement)
          ? statement.declarationList.declarations[0]?.initializer
          : undefined;
      nodes =
        value && ts.isArrayLiteralExpression(value) && value.elements.length === 1
          ? [value.elements[0] as ts.Node]
          : [];
      break;
    }
    case 'switch_case': {
      file = parse(`switch (__fragment) { ${source} }`);
      const statement = file.statements[0];
      nodes =
        statement && ts.isSwitchStatement(statement) && statement.caseBlock.clauses.length === 1
          ? [statement.caseBlock.clauses[0] as ts.Node]
          : [];
      break;
    }
    case 'import_specifier': {
      file = parse(`import { ${source} } from "host:api";`);
      const statement = file.statements[0];
      const bindings =
        statement && ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
      nodes =
        bindings && ts.isNamedImports(bindings) && bindings.elements.length === 1
          ? [bindings.elements[0] as ts.Node]
          : [];
      break;
    }
    default:
      return Object.freeze({ ok: false, reason: 'category' });
  }
  if (parseDiagnostics(file).length > 0 || (nodes.length === 0 && fragment.category !== 'statement_list'))
    return Object.freeze({ ok: false, reason: 'syntax' });
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  const printed = nodes
    .map((node) =>
      printer.printNode(ts.isExpression(node) ? ts.EmitHint.Expression : ts.EmitHint.Unspecified, node, file),
    )
    .join('\n');
  return Object.freeze({
    ok: true,
    bytes: Object.freeze(Array.from(encoder.encode(localIndentation(printed, context)))) as CanonicalBytes,
  });
}
