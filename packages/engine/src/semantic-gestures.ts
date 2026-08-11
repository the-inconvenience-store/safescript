/** High-level semantic gestures normalized through the six-operation primitive kernel. @internal */
import * as ts from 'typescript';

import {
  type SemanticCommentPolicy,
  type SemanticEdit,
  type SemanticEditId,
  type SemanticEditLimits,
  type SemanticGraph,
  type SemanticGraphAnchor,
  type SemanticNodeId,
  type SemanticRevisionId,
  type SourceFragment,
  type SourceFragmentCategory,
  type SourceProgram,
} from '@safescript/contracts';

import {
  PRIMITIVE_OPERATIONS,
  applyPrimitiveSemanticEdits,
  checkSemanticEditPreconditions,
  rejectSemanticEdit,
  type ApplyPrimitiveSemanticEditsResult,
} from './semantic-primitives.js';
import type { CandidateValidator } from './source-transform.js';
import { EditableSourceDocument } from './source-transform.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
type Gesture = Exclude<SemanticEdit, { kind: (typeof PRIMITIVE_OPERATIONS)[number] }>;

interface GestureIndex {
  readonly nodes: ReadonlyMap<SemanticNodeId, SemanticGraph['nodes'][number]>;
  readonly parents: ReadonlyMap<SemanticNodeId, SemanticNodeId>;
  readonly children: ReadonlyMap<SemanticNodeId, readonly SemanticNodeId[]>;
}

function indexGraph(graph: SemanticGraph): GestureIndex {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const parents = new Map<SemanticNodeId, SemanticNodeId>();
  const mutableChildren = new Map<SemanticNodeId, Array<Readonly<{ id: SemanticNodeId; index: number }>>>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'contains') continue;
    parents.set(edge.to, edge.from);
    const selected = mutableChildren.get(edge.from) ?? [];
    selected.push({ id: edge.to, index: edge.index ?? selected.length });
    mutableChildren.set(edge.from, selected);
  }
  const children = new Map<SemanticNodeId, readonly SemanticNodeId[]>();
  for (const [parent, selected] of mutableChildren)
    children.set(
      parent,
      Object.freeze(selected.sort((left, right) => left.index - right.index).map((item) => item.id)),
    );
  return { nodes, parents, children };
}

function bytes(category: SourceFragmentCategory, text: string): SourceFragment {
  return Object.freeze({ category, source: Object.freeze(Array.from(encoder.encode(text))) });
}

function fragmentText(fragment: SourceFragment): string {
  return decoder.decode(Uint8Array.from(fragment.source));
}

function nodeText(source: SourceProgram, index: GestureIndex, nodeId: SemanticNodeId): string | undefined {
  const range = index.nodes.get(nodeId)?.editable;
  if (!range) return undefined;
  return decoder.decode(Uint8Array.from(source.source.slice(range.start, range.end)));
}

function ancestor(
  index: GestureIndex,
  nodeId: SemanticNodeId,
  predicate: (node: SemanticGraph['nodes'][number]) => boolean,
): SemanticNodeId | undefined {
  let selected: SemanticNodeId | undefined = nodeId;
  while (selected) {
    const node = index.nodes.get(selected);
    if (node && predicate(node)) return selected;
    selected = index.parents.get(selected);
  }
  return undefined;
}

function anchorAfter(
  graph: SemanticGraph,
  container: SemanticNodeId,
  child: SemanticNodeId,
): SemanticGraphAnchor | undefined {
  return graph.anchors.find((anchor) => anchor.container === container && anchor.after === child);
}

function statementRange(
  source: SourceProgram,
  index: GestureIndex,
  range: Readonly<{ container: SemanticNodeId; first: SemanticNodeId; last: SemanticNodeId }>,
): Readonly<{ children: readonly SemanticNodeId[]; text: string; start: number; end: number }> | undefined {
  const all = index.children.get(range.container) ?? [];
  const first = all.indexOf(range.first);
  const last = all.indexOf(range.last);
  if (first < 0 || last < first) return undefined;
  const children = all.slice(first, last + 1);
  const firstRange = index.nodes.get(children[0] as SemanticNodeId)?.editable;
  const lastRange = index.nodes.get(children.at(-1) as SemanticNodeId)?.editable;
  if (!firstRange || !lastRange) return undefined;
  const text = decoder.decode(Uint8Array.from(source.source.slice(firstRange.start, lastRange.end)));
  return Object.freeze({ children: Object.freeze(children), text, start: firstRange.start, end: lastRange.end });
}

function descendants(index: GestureIndex, roots: readonly SemanticNodeId[]): ReadonlySet<SemanticNodeId> {
  const output = new Set<SemanticNodeId>();
  const visit = (nodeId: SemanticNodeId): void => {
    if (output.has(nodeId)) return;
    output.add(nodeId);
    for (const child of index.children.get(nodeId) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return output;
}

function declaredType(source: SourceProgram, index: GestureIndex, binding: SemanticNodeId): string | undefined {
  let selected: SemanticNodeId | undefined = binding;
  while (selected) {
    const type = (index.children.get(selected) ?? []).find((child) => index.nodes.get(child)?.kind === 'type');
    if (type) return nodeText(source, index, type);
    selected = index.parents.get(selected);
  }
  return undefined;
}

function wrapControl(
  control: Extract<Gesture, { kind: 'wrap_statement_range' | 'convert_control' }>['control'],
  body: string,
): string {
  const indented = body
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join('\n');
  switch (control.kind) {
    case 'if':
      return `if (${fragmentText(control.condition)}) {\n${indented}\n}`;
    case 'for_of':
      return `for (const ${fragmentText(control.binding)} of ${fragmentText(control.iterable)}) {\n${indented}\n}`;
    case 'for_in':
      return `for (const ${fragmentText(control.binding)} in ${fragmentText(control.value)}) {\n${indented}\n}`;
    case 'while':
      return `while (${fragmentText(control.condition)}) {\n${indented}\n}`;
    case 'do':
      return `do {\n${indented}\n} while (${fragmentText(control.condition)});`;
    case 'for':
      return `for (${control.initializer ? fragmentText(control.initializer) : ''}; ${control.condition ? fragmentText(control.condition) : ''}; ${control.increment ? fragmentText(control.increment) : ''}) {\n${indented}\n}`;
    case 'switch':
      return `switch (${fragmentText(control.value)}) {\n  default:\n${indented
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')}\n}`;
  }
}

function replace(
  editId: SemanticEditId,
  target: SemanticNodeId,
  category: SourceFragmentCategory,
  text: string,
): SemanticEdit {
  return { kind: 'replace_target', editId, target, replacement: bytes(category, text), preconditions: [] };
}

function remove(
  editId: SemanticEditId,
  target: SemanticNodeId,
  policy: SemanticCommentPolicy = 'preserve_owned_comments',
): SemanticEdit {
  return { kind: 'delete_target', editId, target, commentPolicy: policy, preconditions: [] };
}

function parseExpression(text: string): ts.Expression | undefined {
  const file = ts.createSourceFile(
    'gesture.ts',
    `const __value = (${text});`,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const statement = file.statements[0];
  const initializer =
    statement && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.initializer : undefined;
  return initializer && ts.isParenthesizedExpression(initializer) ? initializer.expression : initializer;
}

function printExpression(expression: ts.Expression): string {
  let original = expression.getSourceFile();
  if (!original || original.text.length === 0) {
    const visit = (node: ts.Node): void => {
      if (original?.text.length) return;
      const candidate = node.getSourceFile();
      if (candidate?.text.length) original = candidate;
      else ts.forEachChild(node, visit);
    };
    ts.forEachChild(expression, visit);
  }
  const file =
    original && original.text.length > 0
      ? original
      : ts.createSourceFile('gesture.ts', '', ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printNode(ts.EmitHint.Expression, expression, file);
}

function callExpression(text: string): ts.CallExpression | undefined {
  const expression = parseExpression(text);
  return expression && ts.isCallExpression(expression) ? expression : undefined;
}

function propertyName(name: string): ts.PropertyName {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? ts.factory.createIdentifier(name)
    : ts.factory.createStringLiteral(name);
}

function propertyKey(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (!name) return undefined;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

function objectValue(
  object: ts.ObjectLiteralExpression,
  path: readonly (string | number)[],
): ts.Expression | undefined {
  const [head, ...tail] = path;
  if (typeof head !== 'string') return undefined;
  const property = object.properties.find((candidate) => propertyKey(candidate) === head);
  if (!property || !ts.isPropertyAssignment(property)) return undefined;
  if (tail.length === 0) return property.initializer;
  return ts.isObjectLiteralExpression(property.initializer) ? objectValue(property.initializer, tail) : undefined;
}

function setObjectValue(
  object: ts.ObjectLiteralExpression,
  path: readonly (string | number)[],
  value: ts.Expression | undefined,
): ts.ObjectLiteralExpression | undefined {
  const [head, ...tail] = path;
  if (typeof head !== 'string') return undefined;
  const position = object.properties.findIndex((candidate) => propertyKey(candidate) === head);
  const properties = [...object.properties];
  if (tail.length === 0) {
    if (!value) {
      if (position < 0) return undefined;
      properties.splice(position, 1);
    } else {
      const property = ts.factory.createPropertyAssignment(propertyName(head), value);
      if (position < 0) properties.push(property);
      else properties[position] = property;
    }
    return ts.factory.updateObjectLiteralExpression(object, properties);
  }
  const selected = position >= 0 ? properties[position] : undefined;
  const nested =
    selected && ts.isPropertyAssignment(selected) && ts.isObjectLiteralExpression(selected.initializer)
      ? selected.initializer
      : ts.factory.createObjectLiteralExpression();
  const updated = setObjectValue(nested, tail, value);
  if (!updated) return undefined;
  const property = ts.factory.createPropertyAssignment(propertyName(head), updated);
  if (position < 0) properties.push(property);
  else properties[position] = property;
  return ts.factory.updateObjectLiteralExpression(object, properties);
}

function updateCallInput(
  text: string,
  update: (object: ts.ObjectLiteralExpression) => ts.ObjectLiteralExpression | undefined,
): string | undefined {
  const call = callExpression(text);
  const input = call?.arguments[0];
  if (!call || !input || !ts.isObjectLiteralExpression(input)) return undefined;
  const selected = update(input);
  if (!selected) return undefined;
  return printExpression(
    ts.factory.updateCallExpression(call, call.expression, call.typeArguments, [selected, ...call.arguments.slice(1)]),
  );
}

function operationCallee(current: ts.Expression, operation: string): ts.Expression | undefined {
  const suffix = operation
    .replace(/^operation:/, '')
    .split('.')
    .filter(Boolean);
  if (suffix.length === 0) return undefined;
  let root: ts.Expression = current;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  for (const segment of suffix) root = ts.factory.createPropertyAccessExpression(root, segment);
  return root;
}

function mutateExpression(edit: Gesture, sourceText: string): string | undefined {
  const expression = parseExpression(sourceText);
  if (!expression) return undefined;
  switch (edit.kind) {
    case 'set_literal_value':
      return edit.value === null
        ? 'null'
        : typeof edit.value === 'string'
          ? JSON.stringify(edit.value)
          : String(edit.value);
    case 'change_operator': {
      const scanner = ts.createScanner(ts.ScriptTarget.ESNext, false, ts.LanguageVariant.Standard, sourceText);
      for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
        if (scanner.getTokenText() !== (expression as ts.BinaryExpression).operatorToken?.getText()) continue;
        return sourceText.slice(0, scanner.getTokenPos()) + edit.operator + sourceText.slice(scanner.getTextPos());
      }
      return undefined;
    }
    case 'change_member_name':
      return ts.isPropertyAccessExpression(expression)
        ? printExpression(
            ts.factory.updatePropertyAccessExpression(
              expression,
              expression.expression,
              propertyName(edit.name) as ts.MemberName,
            ),
          )
        : undefined;
    case 'toggle_optional_access':
      if (ts.isPropertyAccessExpression(expression))
        return printExpression(
          edit.optional
            ? ts.factory.createPropertyAccessChain(
                expression.expression,
                ts.factory.createToken(ts.SyntaxKind.QuestionDotToken),
                expression.name,
              )
            : ts.factory.createPropertyAccessExpression(expression.expression, expression.name),
        );
      if (ts.isElementAccessExpression(expression))
        return printExpression(
          edit.optional
            ? ts.factory.createElementAccessChain(
                expression.expression,
                ts.factory.createToken(ts.SyntaxKind.QuestionDotToken),
                expression.argumentExpression,
              )
            : ts.factory.createElementAccessExpression(expression.expression, expression.argumentExpression),
        );
      return undefined;
    case 'change_call_callee': {
      if (!ts.isCallExpression(expression)) return undefined;
      const callee = parseExpression(fragmentText(edit.callee));
      return callee
        ? printExpression(
            ts.factory.updateCallExpression(expression, callee, expression.typeArguments, expression.arguments),
          )
        : undefined;
    }
    case 'change_object_field_name': {
      const file = ts.createSourceFile(
        'gesture.ts',
        `const __value = ({${sourceText}});`,
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TS,
      );
      const statement = file.statements[0];
      const initializer =
        statement && ts.isVariableStatement(statement)
          ? statement.declarationList.declarations[0]?.initializer
          : undefined;
      const object = initializer && ts.isParenthesizedExpression(initializer) ? initializer.expression : initializer;
      const property = object && ts.isObjectLiteralExpression(object) ? object.properties[0] : undefined;
      if (!property || !ts.isPropertyAssignment(property)) return undefined;
      return ts
        .createPrinter()
        .printNode(
          ts.EmitHint.Unspecified,
          ts.factory.updatePropertyAssignment(property, propertyName(edit.name), property.initializer),
          file,
        );
    }
    case 'change_result_variant': {
      if (!ts.isCallExpression(expression)) return undefined;
      return printExpression(
        ts.factory.updateCallExpression(
          expression,
          ts.factory.createIdentifier(edit.variant === 'ok' ? 'Ok' : 'Err'),
          expression.typeArguments,
          expression.arguments,
        ),
      );
    }
    default:
      return undefined;
  }
}

function normalizeGesture(
  source: SourceProgram,
  graph: SemanticGraph,
  index: GestureIndex,
  edit: Gesture,
): readonly SemanticEdit[] | undefined {
  if (edit.kind === 'wrap_statement_range') {
    const range = statementRange(source, index, edit.range);
    if (!range) return undefined;
    return Object.freeze([
      replace(edit.editId, range.children[0] as SemanticNodeId, 'statement', wrapControl(edit.control, range.text)),
      ...range.children.slice(1).map((target) => remove(edit.editId, target)),
    ]);
  }
  if (edit.kind === 'move_statement_range') {
    const range = statementRange(source, index, edit.range);
    if (!range) return undefined;
    if (range.children.length === 1)
      return Object.freeze([
        {
          kind: 'move_target',
          editId: edit.editId,
          target: range.children[0] as SemanticNodeId,
          destination: edit.destination,
          preconditions: [],
        },
      ]);
    if (edit.destination.container !== edit.range.container) {
      const document = new EditableSourceDocument(source);
      const first = index.nodes.get(range.children[0] as SemanticNodeId)?.editable;
      const last = index.nodes.get(range.children.at(-1) as SemanticNodeId)?.editable;
      if (!first || !last) return undefined;
      const ownedFirst = document.ownedRange({ start: first.start, end: first.end });
      const ownedLast = document.ownedRange({ start: last.start, end: last.end });
      const text = decoder.decode(Uint8Array.from(source.source.slice(ownedFirst.start, ownedLast.end)));
      return Object.freeze([
        {
          kind: 'insert_at_anchor',
          editId: edit.editId,
          anchor: edit.destination,
          fragment: bytes('statement_list', text),
          preconditions: [],
        },
        ...range.children.map((target) => remove(edit.editId, target, 'delete_owned_comments')),
      ]);
    }
    const current = index.children.get(edit.range.container) ?? [];
    const remaining = current.filter((child) => !range.children.includes(child));
    const before = edit.destination.before ? remaining.indexOf(edit.destination.before) : remaining.length;
    const at = before < 0 ? remaining.length : before;
    return Object.freeze([
      {
        kind: 'reorder_children',
        editId: edit.editId,
        container: edit.range.container,
        children: Object.freeze([...remaining.slice(0, at), ...range.children, ...remaining.slice(at)]),
        preconditions: [],
      },
    ]);
  }
  if (edit.kind === 'unwrap_control') {
    const children = index.children.get(edit.retainedContainer) ?? [];
    const body = children.map((child) => nodeText(source, index, child)).filter((value) => value !== undefined);
    if (body.length !== children.length) return undefined;
    return Object.freeze([replace(edit.editId, edit.target, 'statement_list', body.join('\n'))]);
  }
  if (edit.kind === 'add_branch') {
    const target = nodeText(source, index, edit.target);
    if (!target) return undefined;
    if (edit.branch.kind === 'else')
      return Object.freeze([
        replace(edit.editId, edit.target, 'statement', `${target} else {\n${fragmentText(edit.branch.body)}\n}`),
      ]);
    const closing = target.lastIndexOf('}');
    if (closing < 0) return undefined;
    const clause = `case ${fragmentText(edit.branch.value)}:\n${fragmentText(edit.branch.body)}\n`;
    return Object.freeze([
      replace(edit.editId, edit.target, 'statement', target.slice(0, closing) + clause + target.slice(closing)),
    ]);
  }
  if (edit.kind === 'remove_branch') {
    const targetNode = index.nodes.get(edit.target);
    if (targetNode?.semanticKind === 'switch-case')
      return Object.freeze([remove(edit.editId, edit.target, edit.commentPolicy)]);
    if (targetNode?.semanticKind !== 'branch-case' || targetNode.label !== 'false') return undefined;
    const parent = index.parents.get(edit.target);
    if (!parent) return undefined;
    const parentText = nodeText(source, index, parent);
    const branchText = nodeText(source, index, edit.target);
    if (!parentText || !branchText) return undefined;
    const marker = parentText.lastIndexOf('else');
    return marker < 0
      ? undefined
      : Object.freeze([replace(edit.editId, parent, 'statement', parentText.slice(0, marker).trimEnd())]);
  }
  if (edit.kind === 'convert_control') {
    const bodies = edit.retainedContainers.flatMap(({ from }) =>
      (index.children.get(from) ?? []).flatMap((child) => nodeText(source, index, child) ?? []),
    );
    return bodies.length === 0
      ? undefined
      : Object.freeze([replace(edit.editId, edit.target, 'statement', wrapControl(edit.control, bodies.join('\n')))]);
  }
  if (edit.kind === 'extract_local') {
    const selected = nodeText(source, index, edit.target);
    if (!selected) return undefined;
    return Object.freeze([
      ...edit.replaceTargets.map((target) => replace(edit.editId, target, 'expression', edit.name)),
      {
        kind: 'insert_at_anchor',
        editId: edit.editId,
        anchor: edit.declaration,
        fragment: bytes('statement', `const ${edit.name} = ${selected};`),
        preconditions: [],
      },
    ]);
  }
  if (edit.kind === 'inline_local') {
    const declaration = nodeText(source, index, edit.binding);
    const equals = declaration?.indexOf('=') ?? -1;
    if (!declaration || equals < 0) return undefined;
    const initializer = declaration
      .slice(equals + 1)
      .replace(/;\s*$/, '')
      .trim();
    const replacements = edit.references.map((target) => replace(edit.editId, target, 'expression', initializer));
    if (!edit.removeDeclaration) return Object.freeze(replacements);
    const statement = ancestor(index, edit.binding, (node) => node.kind === 'statement');
    return statement ? Object.freeze([...replacements, remove(edit.editId, statement, edit.commentPolicy)]) : undefined;
  }
  if (edit.kind === 'extract_function') {
    const range = statementRange(source, index, edit.range);
    if (!range) return undefined;
    const selected = descendants(index, range.children);
    const parameters: string[] = [];
    const arguments_: string[] = [];
    const substitutions: Array<Readonly<{ start: number; end: number; name: string }>> = [];
    for (const parameter of edit.parameters) {
      const binding = graph.nodes.find((node) => node.symbolId === parameter.symbol);
      if (!binding?.label || selected.has(binding.id)) return undefined;
      const referenced = graph.edges.some(
        (edge) => edge.kind === 'references' && edge.to === binding.id && selected.has(edge.from),
      );
      if (!referenced) return undefined;
      const type = declaredType(source, index, binding.id);
      if (!type && parameter.name === binding.label) return undefined;
      parameters.push(`${parameter.name}: ${type ?? `typeof ${binding.label}`}`);
      arguments_.push(binding.label);
      for (const edge of graph.edges) {
        if (edge.kind !== 'references' || edge.to !== binding.id || !selected.has(edge.from)) continue;
        const reference = index.nodes.get(edge.from)?.editable;
        if (!reference || reference.start < range.start || reference.end > range.end) return undefined;
        substitutions.push({
          start: reference.start - range.start,
          end: reference.end - range.start,
          name: parameter.name,
        });
      }
    }
    const outputNames: string[] = [];
    for (const symbol of edit.outputs) {
      const binding = graph.nodes.find((node) => node.symbolId === symbol);
      if (!binding?.label || !selected.has(binding.id)) return undefined;
      const usedAfter = graph.edges.some(
        (edge) => edge.kind === 'references' && edge.to === binding.id && !selected.has(edge.from),
      );
      if (!usedAfter) return undefined;
      outputNames.push(binding.label);
    }
    const body = [...source.source.slice(range.start, range.end)];
    for (const substitution of substitutions.sort((left, right) => right.start - left.start))
      body.splice(substitution.start, substitution.end - substitution.start, ...encoder.encode(substitution.name));
    const bodyText = decoder.decode(Uint8Array.from(body));
    const returns =
      outputNames.length === 0
        ? ''
        : outputNames.length === 1
          ? `\nreturn ${outputNames[0] as string};`
          : `\nreturn { ${outputNames.join(', ')} };`;
    const asynchronous = /\bawait\b/.test(bodyText);
    const invocation = `${asynchronous ? 'await ' : ''}${edit.name}(${arguments_.join(', ')})`;
    const call =
      outputNames.length === 0
        ? `${invocation};`
        : outputNames.length === 1
          ? `const ${outputNames[0] as string} = ${invocation};`
          : `const { ${outputNames.join(', ')} } = ${invocation};`;
    return Object.freeze([
      replace(edit.editId, range.children[0] as SemanticNodeId, 'statement', call),
      ...range.children.slice(1).map((target) => remove(edit.editId, target)),
      {
        kind: 'insert_at_anchor',
        editId: edit.editId,
        anchor: edit.declaration,
        fragment: bytes(
          'declaration',
          `${asynchronous ? 'async ' : ''}function ${edit.name}(${parameters.join(', ')}) {\n${bodyText}${returns}\n}`,
        ),
        preconditions: [],
      },
    ]);
  }
  if (edit.kind === 'inline_function_call') {
    const declaration = nodeText(source, index, edit.function);
    const call = callExpression(nodeText(source, index, edit.call) ?? '');
    if (!declaration || !call) return undefined;
    const match = declaration.match(/\{\s*return\s+([\s\S]*?);?\s*\}$/);
    if (!match?.[1]) return undefined;
    let expression = match[1].trim();
    for (const mapping of edit.parameterArguments) {
      const parameter = index.nodes.get(mapping.parameter)?.label;
      const argument = nodeText(source, index, mapping.argument);
      if (!parameter || !argument) return undefined;
      expression = expression.replace(new RegExp(`\\b${parameter.replace(/[$]/g, '\\$&')}\\b`, 'g'), `(${argument})`);
    }
    return Object.freeze([
      replace(edit.editId, edit.call, 'expression', expression),
      ...(edit.removeDeclaration ? [remove(edit.editId, edit.function, edit.commentPolicy)] : []),
    ]);
  }
  if (edit.kind === 'change_binding_pattern') {
    const nested = (index.children.get(edit.target) ?? []).find((child) => index.nodes.get(child)?.kind === 'binding');
    return Object.freeze([replace(edit.editId, nested ?? edit.target, 'binding_pattern', fragmentText(edit.pattern))]);
  }
  if (edit.kind === 'change_binding_mutability') {
    const statement = ancestor(index, edit.target, (node) => node.kind === 'statement');
    const selected = statement ? nodeText(source, index, statement) : undefined;
    return statement && selected
      ? Object.freeze([
          replace(edit.editId, statement, 'statement', selected.replace(/\b(?:const|let)\b/, edit.mutability)),
        ])
      : undefined;
  }
  if (edit.kind === 'change_action_operation') {
    const selected = nodeText(source, index, edit.target);
    const call = selected ? callExpression(selected) : undefined;
    const input = call?.arguments[0];
    const callee = call ? operationCallee(call.expression, edit.operation) : undefined;
    if (!call || !callee || !input || !ts.isObjectLiteralExpression(input)) return undefined;
    let output = ts.factory.createObjectLiteralExpression();
    for (const mapping of edit.fieldMappings) {
      const value = objectValue(input, mapping.from);
      if (!value) return undefined;
      const updated = setObjectValue(output, mapping.to, value);
      if (!updated) return undefined;
      output = updated;
    }
    for (const required of edit.requiredInputs) {
      const value = parseExpression(fragmentText(required.value));
      const updated = value ? setObjectValue(output, required.path, value) : undefined;
      if (!updated) return undefined;
      output = updated;
    }
    const updated = ts.factory.updateCallExpression(call, callee, call.typeArguments, [
      output,
      ...call.arguments.slice(1),
    ]);
    return Object.freeze([replace(edit.editId, edit.target, 'expression', printExpression(updated))]);
  }
  if (edit.kind === 'set_action_input_field' || edit.kind === 'remove_action_input_field') {
    const selected = nodeText(source, index, edit.target);
    if (!selected) return undefined;
    const updated = updateCallInput(selected, (object) => {
      const value = edit.kind === 'set_action_input_field' ? parseExpression(fragmentText(edit.value)) : undefined;
      return edit.kind === 'set_action_input_field' && !value ? undefined : setObjectValue(object, edit.path, value);
    });
    return updated ? Object.freeze([replace(edit.editId, edit.target, 'expression', updated)]) : undefined;
  }
  if (edit.kind === 'bind_action_result') {
    const selected = nodeText(source, index, edit.target);
    const statement = ancestor(index, edit.target, (node) => node.kind === 'statement');
    return selected && statement
      ? Object.freeze([
          replace(edit.editId, statement, 'statement', `const ${fragmentText(edit.pattern)} = await ${selected};`),
        ])
      : undefined;
  }
  if (edit.kind === 'add_action_result_branch') {
    const statement = ancestor(index, edit.target, (node) => node.kind === 'statement');
    const container = statement ? index.parents.get(statement) : undefined;
    const binding = statement
      ? [...index.nodes.values()].find(
          (node) => node.kind === 'binding' && ancestor(index, node.id, (candidate) => candidate.id === statement),
        )?.label
      : undefined;
    const destination = statement && container ? anchorAfter(graph, container, statement) : undefined;
    if (!binding || !destination) return undefined;
    return Object.freeze([
      {
        kind: 'insert_at_anchor',
        editId: edit.editId,
        anchor: destination,
        fragment: bytes(
          'statement',
          `if (${binding}.tag === ${JSON.stringify(edit.variant)}) {\n${fragmentText(edit.body)}\n}`,
        ),
        preconditions: [],
      },
    ]);
  }
  const selected = 'target' in edit ? nodeText(source, index, edit.target) : undefined;
  if (!selected || !('target' in edit)) return undefined;
  const mutated = mutateExpression(edit, selected);
  return mutated
    ? Object.freeze([
        replace(
          edit.editId,
          edit.target,
          edit.kind === 'change_object_field_name' ? 'object_member' : 'expression',
          mutated,
        ),
      ])
    : undefined;
}

function editTarget(edit: SemanticEdit): SemanticNodeId {
  switch (edit.kind) {
    case 'insert_at_anchor':
      return edit.anchor.container;
    case 'reorder_children':
      return edit.container;
    case 'wrap_statement_range':
    case 'move_statement_range':
    case 'extract_function':
      return edit.range.container;
    case 'inline_local':
      return edit.binding;
    case 'inline_function_call':
      return edit.call;
    default:
      return edit.target;
  }
}

function editAnchors(edit: SemanticEdit): readonly SemanticGraphAnchor[] {
  switch (edit.kind) {
    case 'insert_at_anchor':
      return [edit.anchor];
    case 'move_target':
    case 'move_statement_range':
      return [edit.destination];
    case 'extract_local':
    case 'extract_function':
      return [edit.declaration];
    default:
      return [];
  }
}

/** Deterministically lowers every supported gesture to primitive operations over the same base revision. */
export function normalizeSemanticEdits(
  source: SourceProgram,
  graph: SemanticGraph,
  edits: readonly SemanticEdit[],
): readonly SemanticEdit[] | undefined {
  const index = indexGraph(graph);
  const output: SemanticEdit[] = [];
  for (const edit of edits) {
    if (PRIMITIVE_OPERATIONS.includes(edit.kind as (typeof PRIMITIVE_OPERATIONS)[number])) {
      output.push(edit);
      continue;
    }
    const normalized = normalizeGesture(source, graph, index, edit as Gesture);
    if (!normalized) return undefined;
    output.push(...normalized);
  }
  return Object.freeze(output);
}

/** Applies a mixed primitive/gesture batch atomically through one primitive transformation plan. */
export function applySemanticEditKernel(
  source: SourceProgram,
  graph: SemanticGraph,
  baseRevision: SemanticRevisionId,
  edits: readonly SemanticEdit[],
  limits: SemanticEditLimits,
  validate?: CandidateValidator,
): ApplyPrimitiveSemanticEditsResult {
  if (baseRevision !== graph.semanticRevision)
    return rejectSemanticEdit(
      'stale_revision',
      edits[0],
      [],
      source.source.length,
      'base semantic revision does not match current revision',
    );
  for (const edit of edits) {
    if (PRIMITIVE_OPERATIONS.includes(edit.kind as (typeof PRIMITIVE_OPERATIONS)[number])) continue;
    const target = editTarget(edit);
    const preconditions = checkSemanticEditPreconditions(source, graph, target, edit.preconditions, editAnchors(edit));
    if (preconditions !== 'matched')
      return rejectSemanticEdit(
        preconditions,
        edit,
        [target],
        source.source.length,
        preconditions === 'target_not_found'
          ? 'semantic gesture target was not found'
          : 'semantic gesture precondition failed',
      );
  }
  const normalized = normalizeSemanticEdits(source, graph, edits);
  if (!normalized) {
    const first = edits[0];
    return rejectSemanticEdit(
      'target_kind_mismatch',
      first,
      first ? [editTarget(first)] : [],
      source.source.length,
      'semantic gesture does not match the selected target shape',
    );
  }
  const result = applyPrimitiveSemanticEdits(source, graph, baseRevision, normalized, limits, validate);
  if (result.status !== 'accepted') return result;
  const outcomes = edits.map((edit) => {
    const selected = result.outcomes.filter((outcome) => outcome.editId === edit.editId);
    return Object.freeze({
      editId: edit.editId,
      targets: Object.freeze([...new Set(selected.flatMap((outcome) => outcome.targets))]),
      changedRegions: Object.freeze([...new Set(selected.flatMap((outcome) => outcome.changedRegions))].sort()),
    });
  });
  return Object.freeze({ ...result, outcomes: Object.freeze(outcomes) });
}
