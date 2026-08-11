import { describe, expect, it } from 'bun:test';

import {
  STANDARD_SEMANTIC_EDIT_LIMITS,
  type ModuleId,
  type SemanticEditId,
  type SemanticNodeId,
  type SourceFragment,
  type SourceProgram,
} from '@safescript/contracts';

import {
  SOURCE_TRANSFORMATION_CONFLICT_MATRIX_VERSION,
  EditableSourceDocument,
  applySourceTransformations,
  printSourceFragment,
  type SourceTransformation,
} from './source-transform.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const moduleId = 'module:transform.test' as ModuleId;
const node = `semantic-node:${'1'.repeat(64)}` as SemanticNodeId;
const edit = (value: string) => value as SemanticEditId;

function program(source: string): SourceProgram {
  return { module: moduleId, source: Object.freeze(Array.from(encoder.encode(source))) };
}

function text(source: SourceProgram): string {
  return decoder.decode(Uint8Array.from(source.source));
}

function span(source: string, selected: string, occurrence = 0): Readonly<{ start: number; end: number }> {
  let utf16 = -1;
  for (let index = 0; index <= occurrence; index++) utf16 = source.indexOf(selected, utf16 + 1);
  if (utf16 < 0) throw new Error(`missing test selection ${selected}`);
  const start = encoder.encode(source.slice(0, utf16)).length;
  return { start, end: start + encoder.encode(selected).length };
}

describe('lossless source transformation engine', () => {
  it('preserves every byte outside minimal UTF-8 replacement and insertion regions', () => {
    const source = 'const café = "🙂";\r\nreturn Ok(café);\r\n';
    const document = new EditableSourceDocument(program(source));
    const literal = span(source, '"🙂"');
    const insertion = encoder.encode('// kept CRLF\r\n');
    const transformations: readonly SourceTransformation[] = [
      {
        kind: 'replace',
        editId: edit('edit:literal'),
        targets: [node],
        range: literal,
        content: { bytes: encoder.encode('"changed"'), origin: 'fragment' },
      },
      {
        kind: 'insert',
        editId: edit('edit:header'),
        targets: [],
        at: 0,
        content: { bytes: insertion, origin: 'generated' },
      },
    ];

    const result = applySourceTransformations(document, transformations, STANDARD_SEMANTIC_EDIT_LIMITS);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(text(result.source)).toBe('// kept CRLF\r\nconst café = "changed";\r\nreturn Ok(café);\r\n');
    expect(result.changedRegions).toHaveLength(2);
    expect(result.provenance.some((entry) => entry.kind === 'generated')).toBe(true);
    expect(result.provenance.some((entry) => entry.kind === 'original')).toBe(true);
  });

  it('moves original slices with owned comments and applies explicit destructive comment policy', () => {
    const source = [
      'const a = 1;',
      '// owned by b',
      'const b = 2; // trailing b',
      '',
      '// detached by blank line',
      'const c = 3;',
      '',
    ].join('\n');
    const target = span(source, 'const b = 2;');
    const moved = applySourceTransformations(
      new EditableSourceDocument(program(source)),
      [
        {
          kind: 'move',
          editId: edit('edit:move-b'),
          targets: [node],
          range: target,
          destination: encoder.encode(source).length,
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
    );
    expect(moved.status).toBe('accepted');
    if (moved.status === 'accepted') {
      const output = text(moved.source);
      expect(output.endsWith('// owned by b\nconst b = 2; // trailing b')).toBe(true);
      expect(output.includes('// detached by blank line\nconst c = 3;')).toBe(true);
      expect(moved.provenance.some((entry) => entry.kind === 'moved')).toBe(true);
    }

    const preserved = applySourceTransformations(
      new EditableSourceDocument(program(source)),
      [
        {
          kind: 'delete',
          editId: edit('edit:preserve-comments'),
          targets: [node],
          range: target,
          commentPolicy: 'preserve_owned_comments',
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
    );
    expect(preserved.status).toBe('accepted');
    if (preserved.status === 'accepted') {
      expect(text(preserved.source)).toContain('// owned by b');
      expect(text(preserved.source)).toContain('// trailing b');
    }

    const deleted = applySourceTransformations(
      new EditableSourceDocument(program(source)),
      [
        {
          kind: 'delete',
          editId: edit('edit:delete-comments'),
          targets: [node],
          range: target,
          commentPolicy: 'delete_owned_comments',
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
    );
    expect(deleted.status).toBe('accepted');
    if (deleted.status === 'accepted') {
      expect(text(deleted.source)).not.toContain('// owned by b');
      expect(text(deleted.source)).not.toContain('// trailing b');
      expect(text(deleted.source)).toContain('// detached by blank line');
    }
  });

  it('rejects overlaps through a deterministic versioned conflict matrix', () => {
    expect(SOURCE_TRANSFORMATION_CONFLICT_MATRIX_VERSION).toBe(1);
    const source = 'const value = first + second;';
    const outer = span(source, 'first + second');
    const inner = span(source, 'second');
    const result = applySourceTransformations(
      new EditableSourceDocument(program(source)),
      [
        {
          kind: 'replace',
          editId: edit('edit:outer'),
          targets: [node],
          range: outer,
          content: { bytes: encoder.encode('third'), origin: 'fragment' },
        },
        {
          kind: 'delete',
          editId: edit('edit:inner'),
          targets: [node],
          range: inner,
          commentPolicy: 'preserve_owned_comments',
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
    );
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'conflicting_transformations',
      conflicts: [{ editIds: ['edit:inner', 'edit:outer'] }],
    });
    expect('source' in result).toBe(false);

    const sameEdit = applySourceTransformations(
      new EditableSourceDocument(program(source)),
      [
        {
          kind: 'delete',
          editId: edit('edit:one-gesture'),
          targets: [node],
          range: outer,
          commentPolicy: 'preserve_owned_comments',
        },
        {
          kind: 'delete',
          editId: edit('edit:one-gesture'),
          targets: [node],
          range: inner,
          commentPolicy: 'preserve_owned_comments',
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
    );
    expect(sameEdit).toMatchObject({
      status: 'rejected',
      reason: 'conflicting_transformations',
      conflicts: [{ editIds: ['edit:one-gesture'] }],
    });
  });

  it('maps invalid final-source diagnostics to fragment provenance without returning candidate source', () => {
    const source = 'const value = 1;';
    const target = span(source, '1');
    const result = applySourceTransformations(
      new EditableSourceDocument(program(source)),
      [
        {
          kind: 'replace',
          editId: edit('edit:bad-fragment'),
          targets: [node],
          range: target,
          content: { bytes: encoder.encode('invalid('), origin: 'fragment' },
        },
      ],
      STANDARD_SEMANTIC_EDIT_LIMITS,
      (candidate) => ({
        ok: false,
        diagnostics: [{ message: 'syntax error', start: target.start, end: candidate.source.length }],
      }),
    );
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'candidate_rejected',
      diagnostics: [
        {
          message: 'syntax error',
          location: { kind: 'fragment', editId: 'edit:bad-fragment', start: 0, end: 8 },
        },
      ],
    });
    expect('source' in result).toBe(false);
  });

  it('parses category-bound fragments and prints only synthesized syntax with local newline and indentation', () => {
    const expression: SourceFragment = { category: 'expression', source: Array.from(encoder.encode('left+right')) };
    const printed = printSourceFragment(expression, { newline: '\r\n', indentation: '  ' });
    expect(printed).toEqual({ ok: true, bytes: Array.from(encoder.encode('left + right')) });
    expect(
      printSourceFragment(
        { category: 'statement_list', source: Array.from(encoder.encode('if (ready) {\nreturn Ok(value);\n}')) },
        { newline: '\r\n', indentation: '  ' },
      ),
    ).toEqual({ ok: true, bytes: Array.from(encoder.encode('if (ready) {\r\n    return Ok(value);\r\n  }')) });
    expect(
      printSourceFragment(
        { category: 'expression', source: Array.from(encoder.encode('const nope = 1')) },
        { newline: '\n', indentation: '' },
      ).ok,
    ).toBe(false);

    const categories: readonly SourceFragment[] = [
      { category: 'statement', source: Array.from(encoder.encode('return Ok(value);')) },
      { category: 'statement_list', source: Array.from(encoder.encode('const value = 1;\nreturn Ok(value);')) },
      { category: 'declaration', source: Array.from(encoder.encode('const value = 1;')) },
      { category: 'declaration_list', source: Array.from(encoder.encode('type Value = string;\nconst value = 1;')) },
      { category: 'type', source: Array.from(encoder.encode('{ readonly value: string }')) },
      { category: 'binding_pattern', source: Array.from(encoder.encode('{ value }')) },
      { category: 'parameter', source: Array.from(encoder.encode('value: string')) },
      { category: 'argument', source: Array.from(encoder.encode('value')) },
      { category: 'object_member', source: Array.from(encoder.encode('value: 1')) },
      { category: 'array_element', source: Array.from(encoder.encode('...values')) },
      { category: 'switch_case', source: Array.from(encoder.encode('case 1: return Ok(value);')) },
      { category: 'import_specifier', source: Array.from(encoder.encode('Thing as Alias')) },
    ];
    for (const fragment of categories)
      expect(printSourceFragment(fragment, { newline: '\n', indentation: '' }).ok, fragment.category).toBe(true);
  });

  it('reports exact measured transformation limits without exposing a partial candidate', () => {
    const source = 'const value = 1;';
    const result = applySourceTransformations(
      new EditableSourceDocument(program(source)),
      [
        {
          kind: 'insert',
          editId: edit('edit:limit'),
          targets: [],
          at: encoder.encode(source).length,
          content: { bytes: encoder.encode('more'), origin: 'generated' },
        },
      ],
      { ...STANDARD_SEMANTIC_EDIT_LIMITS, sourceBytes: encoder.encode(source).length },
    );
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'limit_exceeded',
      limit: { limit: 'source_bytes', maximum: 16, actual: 20 },
      usage: { sourceBytes: 20 },
    });
    expect('source' in result).toBe(false);
  });
});
