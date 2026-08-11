/** Private checked semantic model shared by graph projection and semantic editing. */
import * as ts from 'typescript';
import {
  derivedSemanticNodeId,
  derivedSymbolId,
  type CheckRequest,
  type Schema,
  type SemanticGraphAnchor,
  type SemanticGraphEdge,
  type SemanticGraphNode,
  type SemanticNodeId,
  type SemanticNodeKind,
  type SemanticNodeSemanticKind,
  type SlotDefinition,
} from '@safescript/contracts';

import type { VerifiedCompilation } from './artifact.js';
import { createCheckedSource } from './checked-source.js';
import { Utf8SourceIndex } from './source-offsets.js';
import type { StructuredExpression, StructuredStatement } from './structured-ir.js';

const encoder = new TextEncoder();
const assignmentTokens = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
]);

function isAssignmentStatement(value: ts.ExpressionStatement): boolean {
  const expression = value.expression;
  if (ts.isBinaryExpression(expression))
    return ts.isIdentifier(expression.left) && assignmentTokens.has(expression.operatorToken.kind);
  return (
    (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) &&
    ts.isIdentifier(expression.operand) &&
    (expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

export interface CheckedSemanticModel {
  readonly root: SemanticNodeId;
  readonly nodes: readonly SemanticGraphNode[];
  readonly edges: readonly SemanticGraphEdge[];
  readonly anchors: readonly SemanticGraphAnchor[];
}

/** Internal early-exit signal that prevents a graph request from exceeding its node or edge budget. */
export class SemanticModelLimitError extends Error {
  constructor(
    readonly limit: 'nodes' | 'edges',
    readonly maximum: number,
  ) {
    super(`semantic model ${limit} limit exceeded`);
  }

  get actual(): number {
    return this.maximum + 1;
  }
}

interface ActionFact {
  readonly operationId: Extract<StructuredExpression, { tag: 'action' }>['operationId'];
  readonly actionSiteId: Extract<StructuredExpression, { tag: 'action' }>['actionSiteId'];
  readonly type: Schema;
}

function actionFacts(compilation: VerifiedCompilation): ReadonlyMap<string, ActionFact> {
  const facts = new Map<string, ActionFact>();
  const expression = (value: StructuredExpression): void => {
    if (value.tag === 'action')
      facts.set(`${value.source.start}:${value.source.end}`, {
        operationId: value.operationId,
        actionSiteId: value.actionSiteId,
        type: value.resultType,
      });
    switch (value.tag) {
      case 'member':
      case 'unary':
        expression(value.value);
        break;
      case 'index':
        expression(value.value);
        expression(value.index);
        break;
      case 'array':
        value.items.forEach((item) => expression('spread' in item ? item.spread : item));
        break;
      case 'object':
        value.fields.forEach((field) => expression('spread' in field ? field.spread : field.value));
        break;
      case 'template':
        value.parts.forEach((part) => typeof part !== 'string' && expression(part));
        break;
      case 'binary':
        expression(value.left);
        expression(value.right);
        break;
      case 'conditional':
        expression(value.condition);
        expression(value.whenTrue);
        expression(value.whenFalse);
        break;
      case 'call':
        expression(value.callee);
        value.arguments.forEach(expression);
        break;
      case 'function':
        statements(value.body);
        break;
      case 'result':
        expression(value.value);
        break;
      case 'action':
        expression(value.input);
        break;
      case 'literal':
      case 'name':
        break;
    }
  };
  const statements = (values: readonly StructuredStatement[]): void => {
    for (const value of values) {
      if (value.tag === 'variable' || value.tag === 'destructure' || value.tag === 'assign') expression(value.value);
      else if (value.tag === 'expression') expression(value.expression);
      else if (value.tag === 'if') {
        expression(value.condition);
        statements(value.whenTrue);
        statements(value.whenFalse);
      } else if (value.tag === 'for-of') {
        expression(value.values);
        statements(value.body);
      } else if (value.tag === 'for-in') {
        expression(value.value);
        statements(value.body);
      } else if (value.tag === 'loop') {
        statements(value.initializer);
        expression(value.condition);
        statements(value.increment);
        statements(value.body);
      } else if (value.tag === 'return') expression(value.value);
      else if (value.tag === 'switch') {
        expression(value.value);
        value.cases.forEach((item) => statements(item.body));
      }
    }
  };
  compilation.program.program.functions.forEach((fn) => statements(fn.body));
  return facts;
}

class ModelBuilder {
  readonly nodes: SemanticGraphNode[] = [];
  readonly edges: SemanticGraphEdge[] = [];
  readonly anchors: SemanticGraphAnchor[] = [];
  readonly #paths = new Set<string>();
  readonly #nodeKinds = new Map<SemanticNodeId, SemanticNodeKind>();
  readonly #containerChildren = new Map<SemanticNodeId, SemanticNodeId[]>();
  readonly #bindings = new Map<ts.Symbol, SemanticNodeId>();
  readonly #references: Array<Readonly<{ identifier: ts.Identifier; node: SemanticNodeId }>> = [];
  readonly #actions: ReadonlyMap<string, ActionFact>;

  constructor(
    readonly file: ts.SourceFile,
    readonly checker: ts.TypeChecker,
    readonly offsets: Utf8SourceIndex,
    readonly request: CheckRequest,
    readonly slot: SlotDefinition,
    readonly compilation: VerifiedCompilation,
    readonly limits: Readonly<{ nodes: number; edges: number }>,
  ) {
    this.#actions = actionFacts(compilation);
  }

  location(node: ts.Node) {
    return this.offsets.location(this.request.source.module, node.getStart(this.file), node.getEnd());
  }

  node(
    path: string,
    kind: SemanticNodeKind,
    semanticKind: SemanticNodeSemanticKind,
    source?: ts.Node,
    facts: Omit<SemanticGraphNode, 'id' | 'kind' | 'semanticKind' | 'source' | 'editable'> = {},
  ): SemanticNodeId {
    if (this.nodes.length >= this.limits.nodes) throw new SemanticModelLimitError('nodes', this.limits.nodes);
    if (this.#paths.has(path)) throw new Error('duplicate checked semantic model path');
    this.#paths.add(path);
    const id = derivedSemanticNodeId(encoder.encode(path));
    const location = source ? this.location(source) : undefined;
    this.nodes.push(
      Object.freeze({
        id,
        kind,
        semanticKind,
        ...(location ? { source: location, editable: location } : {}),
        ...facts,
      }),
    );
    this.#nodeKinds.set(id, kind);
    return id;
  }

  edge(
    kind: SemanticGraphEdge['kind'],
    from: SemanticNodeId,
    to: SemanticNodeId,
    options: Readonly<{ label?: string; role?: string; index?: number }> = {},
  ): void {
    if (this.edges.length >= this.limits.edges) throw new SemanticModelLimitError('edges', this.limits.edges);
    this.edges.push(Object.freeze({ kind, from, to, ...options }));
  }

  contain(parent: SemanticNodeId, child: SemanticNodeId, role?: string, index?: number): void {
    this.edge('contains', parent, child, {
      ...(role === undefined ? {} : { role }),
      ...(index === undefined ? {} : { index }),
    });
    const children = this.#containerChildren.get(parent);
    if (children) children.push(child);
  }

  container(
    path: string,
    semanticKind: SemanticNodeSemanticKind,
    parent: SemanticNodeId,
    source: ts.Node,
    role: string,
  ): SemanticNodeId {
    const id = this.node(path, 'container', semanticKind, source, { label: role });
    this.#containerChildren.set(id, []);
    this.contain(parent, id, role);
    return id;
  }

  binding(identifier: ts.Identifier, node: SemanticNodeId): void {
    const symbolNode = this.node(`binding:${node}:${identifier.text}`, 'binding', 'symbol', identifier, {
      label: identifier.text,
      symbolId: derivedSymbolId(encoder.encode(`${this.request.source.module}:${node}:${identifier.text}`)),
    });
    this.contain(node, symbolNode, 'binding');
    this.edge('binds', node, symbolNode, { role: 'binding' });
    const symbol = this.checker.getSymbolAtLocation(identifier);
    if (symbol) this.#bindings.set(symbol, symbolNode);
  }

  reference(identifier: ts.Identifier, node: SemanticNodeId): void {
    this.#references.push({ identifier, node });
  }

  type(node: ts.TypeNode, parent: SemanticNodeId, path: string, role = 'type'): SemanticNodeId {
    const semanticKind: SemanticNodeSemanticKind = ts.isTypeReferenceNode(node)
      ? 'type-reference'
      : ts.isTypeLiteralNode(node)
        ? 'type-literal'
        : ts.isUnionTypeNode(node)
          ? 'type-union'
          : ts.isIntersectionTypeNode(node)
            ? 'type-intersection'
            : ts.isTupleTypeNode(node)
              ? 'type-tuple'
              : ts.isArrayTypeNode(node)
                ? 'type-array'
                : ts.isFunctionTypeNode(node)
                  ? 'type-function'
                  : ts.isTypeOperatorNode(node)
                    ? 'type-operator'
                    : ts.isLiteralTypeNode(node)
                      ? 'type-literal-value'
                      : 'structured';
    const value = this.node(path, 'type', semanticKind, node, { label: node.getText(this.file) });
    this.contain(parent, value, role);
    this.edge('type', parent, value, { role });
    let childIndex = 0;
    node.forEachChild((child) => {
      if (ts.isTypeNode(child)) this.type(child, value, `${path}/type/${childIndex++}`, 'component');
    });
    return value;
  }

  typeParameters(
    values: readonly ts.TypeParameterDeclaration[] | undefined,
    parent: SemanticNodeId,
    path: string,
    source: ts.Node,
  ): void {
    const container = this.container(
      `${path}/type-parameters`,
      'type-parameter-container',
      parent,
      source,
      'type-parameters',
    );
    for (const [index, value] of (values ?? []).entries()) {
      const parameter = this.node(`${path}/type-parameter/${index}`, 'type', 'type-parameter', value, {
        label: value.name.text,
        symbolId: derivedSymbolId(encoder.encode(`${this.request.source.module}:${path}:type:${value.name.text}`)),
      });
      this.contain(container, parameter, 'type-parameter', index);
      this.binding(value.name, parameter);
      if (value.constraint)
        this.type(value.constraint, parameter, `${path}/type-parameter/${index}/constraint`, 'constraint');
      if (value.default) this.type(value.default, parameter, `${path}/type-parameter/${index}/default`, 'default');
    }
  }

  parameters(values: readonly ts.ParameterDeclaration[], parent: SemanticNodeId, path: string, source: ts.Node): void {
    const container = this.container(`${path}/parameters`, 'parameter-container', parent, source, 'parameters');
    for (const [index, value] of values.entries()) {
      const label = value.name.getText(this.file);
      const parameter = this.node(`${path}/parameter/${index}`, 'binding', 'parameter', value, {
        label,
        symbolId: derivedSymbolId(encoder.encode(`${this.request.source.module}:${path}:parameter:${label}`)),
      });
      this.contain(container, parameter, 'parameter', index);
      this.bindingName(value.name, parameter, `${path}/parameter/${index}/binding`);
      if (value.type) this.type(value.type, parameter, `${path}/parameter/${index}/type`);
      if (value.initializer)
        this.expression(value.initializer, parameter, `${path}/parameter/${index}/initializer`, 'initializer');
    }
  }

  bindingName(name: ts.BindingName, parent: SemanticNodeId, path: string): void {
    if (ts.isIdentifier(name)) {
      this.binding(name, parent);
      return;
    }
    const pattern = this.node(path, 'binding', 'binding-pattern', name, { label: name.getText(this.file) });
    this.contain(parent, pattern, 'binding');
    name.elements.forEach((element, index) => {
      if (!ts.isOmittedExpression(element)) this.bindingName(element.name, pattern, `${path}/${index}`);
    });
  }

  expression(
    value: ts.Expression,
    parent: SemanticNodeId,
    path: string,
    role = 'expression',
    index?: number,
  ): SemanticNodeId {
    if (ts.isParenthesizedExpression(value)) return this.expression(value.expression, parent, path, role, index);
    const location = this.location(value);
    const action = ts.isCallExpression(value) ? this.#actions.get(`${location.start}:${location.end}`) : undefined;
    const resultCall =
      ts.isCallExpression(value) &&
      ts.isIdentifier(value.expression) &&
      (value.expression.text === 'Ok' || value.expression.text === 'Err')
        ? value.expression.text
        : undefined;
    const effectCost = action
      ? this.request.registry.operations.find((operation) => operation.id === action.operationId)?.effectCost
      : undefined;
    const literal =
      (ts.isStringLiteralLike(value) && !ts.isNoSubstitutionTemplateLiteral(value)) ||
      ts.isNumericLiteral(value) ||
      ts.isBigIntLiteral(value) ||
      value.kind === ts.SyntaxKind.TrueKeyword ||
      value.kind === ts.SyntaxKind.FalseKeyword;
    const semanticKind: SemanticNodeSemanticKind = action
      ? 'host-action'
      : literal
        ? 'literal'
        : ts.isIdentifier(value)
          ? 'name'
          : ts.isPropertyAccessExpression(value)
            ? 'member'
            : ts.isElementAccessExpression(value)
              ? 'index'
              : ts.isArrayLiteralExpression(value)
                ? 'array'
                : ts.isObjectLiteralExpression(value)
                  ? 'object'
                  : ts.isTemplateExpression(value) || ts.isNoSubstitutionTemplateLiteral(value)
                    ? 'template'
                    : ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value)
                      ? 'unary'
                      : ts.isBinaryExpression(value)
                        ? 'binary'
                        : ts.isConditionalExpression(value)
                          ? 'conditional'
                          : ts.isCallExpression(value)
                            ? resultCall
                              ? 'result'
                              : 'call'
                            : ts.isArrowFunction(value) || ts.isFunctionExpression(value)
                              ? 'function'
                              : ts.isAwaitExpression(value)
                                ? 'await'
                                : ts.isSatisfiesExpression(value)
                                  ? 'satisfies'
                                  : ts.isAsExpression(value)
                                    ? 'const-assertion'
                                    : 'expression';
    const kind: SemanticNodeKind = action ? 'action' : literal ? 'constant' : 'expression';
    const operator = ts.isBinaryExpression(value)
      ? value.operatorToken.getText(this.file)
      : ts.isPrefixUnaryExpression(value)
        ? ts.tokenToString(value.operator)
        : ts.isPostfixUnaryExpression(value)
          ? ts.tokenToString(value.operator)
          : undefined;
    const facts: Omit<SemanticGraphNode, 'id' | 'kind' | 'semanticKind' | 'source' | 'editable'> = {
      ...(ts.isIdentifier(value)
        ? { label: value.text }
        : ts.isPropertyAccessExpression(value)
          ? { label: value.name.text }
          : ts.isTemplateExpression(value)
            ? {
                label: [
                  value.head.text,
                  ...value.templateSpans.flatMap((span, index) => [`\${${index}}`, span.literal.text]),
                ].join(''),
              }
            : ts.isNoSubstitutionTemplateLiteral(value)
              ? { label: value.text }
              : resultCall
                ? { label: resultCall === 'Err' ? 'error' : 'ok' }
                : {}),
      ...(literal ? { constant: literalValue(value) } : {}),
      ...(action ?? {}),
      ...(effectCost === undefined ? {} : { effectCost }),
      ...(operator === undefined ? {} : { operator }),
    };
    const node = this.node(path, kind, semanticKind, value, facts);
    this.contain(parent, node, role, index);
    if (this.#nodeKinds.get(parent) !== 'container') this.edge('data', node, parent, { role });
    if (ts.isIdentifier(value)) this.reference(value, node);

    if (ts.isPropertyAccessExpression(value)) this.expression(value.expression, node, `${path}/value`, 'value');
    else if (ts.isElementAccessExpression(value)) {
      this.expression(value.expression, node, `${path}/value`, 'value');
      if (value.argumentExpression) this.expression(value.argumentExpression, node, `${path}/index`, 'index');
    } else if (ts.isArrayLiteralExpression(value)) {
      const container = this.container(`${path}/elements`, 'element-container', node, value, 'elements');
      value.elements.forEach((element, childIndex) => {
        const spread = ts.isSpreadElement(element);
        const item = this.node(`${path}/element/${childIndex}`, 'expression', 'array-element', element, {
          label: spread ? 'spread' : 'element',
        });
        this.contain(container, item, 'element', childIndex);
        this.expression(
          spread ? element.expression : element,
          item,
          `${path}/element/${childIndex}/value`,
          spread ? 'spread' : 'value',
        );
        this.edge('data', item, node, { role: spread ? 'spread' : 'element', index: childIndex });
      });
    } else if (ts.isObjectLiteralExpression(value)) {
      const container = this.container(`${path}/members`, 'member-container', node, value, 'members');
      value.properties.forEach((property, childIndex) => {
        const member = this.node(`${path}/member/${childIndex}`, 'expression', 'object-member', property, {
          label: property.name?.getText(this.file) ?? 'spread',
        });
        this.contain(container, member, 'member', childIndex);
        if (ts.isPropertyAssignment(property)) {
          this.expression(property.initializer, member, `${path}/member/${childIndex}/value`, 'value');
          this.edge('data', member, node, {
            role: property.name.getText(this.file).replace(/^['"]|['"]$/g, ''),
            index: childIndex,
          });
        } else if (ts.isSpreadAssignment(property)) {
          this.expression(property.expression, member, `${path}/member/${childIndex}/spread`, 'spread');
          this.edge('data', member, node, { role: 'spread', index: childIndex });
        }
      });
    } else if (ts.isTemplateExpression(value)) {
      const container = this.container(`${path}/substitutions`, 'template-container', node, value, 'substitutions');
      value.templateSpans.forEach((span, childIndex) => {
        const child = this.expression(
          span.expression,
          container,
          `${path}/substitution/${childIndex}`,
          'substitution',
          childIndex,
        );
        this.edge('data', child, node, { role: String(childIndex), index: childIndex });
      });
    } else if (ts.isNoSubstitutionTemplateLiteral(value)) {
      this.container(`${path}/substitutions`, 'template-container', node, value, 'substitutions');
    } else if (ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value))
      this.expression(value.operand, node, `${path}/operand`, 'operand');
    else if (ts.isBinaryExpression(value)) {
      this.expression(value.left, node, `${path}/left`, 'left');
      this.expression(value.right, node, `${path}/right`, 'right');
    } else if (ts.isConditionalExpression(value)) {
      this.expression(value.condition, node, `${path}/condition`, 'condition');
      this.expression(value.whenTrue, node, `${path}/true`, 'true');
      this.expression(value.whenFalse, node, `${path}/false`, 'false');
    } else if (ts.isCallExpression(value)) {
      if (!action && !resultCall) this.expression(value.expression, node, `${path}/callee`, 'callee');
      const container = this.container(`${path}/arguments`, 'argument-container', node, value, 'arguments');
      value.arguments.forEach((argument, childIndex) => {
        const argumentNode = this.expression(
          ts.isSpreadElement(argument) ? argument.expression : argument,
          container,
          `${path}/argument/${childIndex}`,
          'argument',
          childIndex,
        );
        if (action && childIndex === 0) this.edge('input', argumentNode, node, { role: 'input' });
        else
          this.edge('data', argumentNode, node, {
            role: resultCall ? 'value' : 'argument',
            index: childIndex,
          });
      });
    } else if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      this.typeParameters(value.typeParameters, node, path, value);
      this.parameters(value.parameters, node, path, value);
      if (value.type) this.type(value.type, node, `${path}/return-type`, 'return-type');
      if (ts.isBlock(value.body)) this.statements(value.body.statements, node, `${path}/body`, value.body, 'body');
      else this.expression(value.body, node, `${path}/body-expression`, 'body');
    } else if (ts.isAwaitExpression(value)) this.expression(value.expression, node, `${path}/value`, 'value');
    else if (ts.isSatisfiesExpression(value) || ts.isAsExpression(value)) {
      this.expression(value.expression, node, `${path}/value`, 'value');
      this.type(value.type, node, `${path}/type`);
    }
    return node;
  }

  statements(
    values: readonly ts.Statement[],
    parent: SemanticNodeId,
    path: string,
    source: ts.Node,
    role: string,
  ): SemanticNodeId {
    const container = this.container(path, 'statement-container', parent, source, role);
    let previous: SemanticNodeId | undefined;
    values.forEach((value, index) => {
      const statement = this.statement(value, container, `${path}/statement/${index}`, index);
      if (previous) this.edge('control', previous, statement, { role: 'next' });
      previous = statement;
    });
    return container;
  }

  statement(value: ts.Statement, parent: SemanticNodeId, path: string, index: number): SemanticNodeId {
    const semanticKind: SemanticNodeSemanticKind = ts.isVariableStatement(value)
      ? value.declarationList.declarations.some((item) => !ts.isIdentifier(item.name))
        ? 'destructure'
        : 'variable'
      : ts.isExpressionStatement(value)
        ? isAssignmentStatement(value)
          ? 'assign'
          : 'expression'
        : ts.isIfStatement(value)
          ? 'if'
          : ts.isForOfStatement(value)
            ? 'for-of'
            : ts.isForInStatement(value)
              ? 'for-in'
              : ts.isForStatement(value) || ts.isWhileStatement(value) || ts.isDoStatement(value)
                ? 'loop'
                : ts.isBreakStatement(value)
                  ? 'break'
                  : ts.isContinueStatement(value)
                    ? 'continue'
                    : ts.isReturnStatement(value)
                      ? 'return'
                      : ts.isSwitchStatement(value)
                        ? 'switch'
                        : 'structured';
    const node = this.node(path, 'statement', semanticKind, value);
    this.contain(parent, node, 'statement', index);

    if (ts.isVariableStatement(value)) {
      const declarations = this.container(`${path}/declarations`, 'declaration-container', node, value, 'declarations');
      value.declarationList.declarations.forEach((declaration, childIndex) => {
        const label = declaration.name.getText(this.file);
        const binding = this.node(`${path}/declaration/${childIndex}`, 'binding', 'binding-pattern', declaration, {
          label,
          symbolId: derivedSymbolId(encoder.encode(`${this.request.source.module}:${path}:binding:${label}`)),
        });
        this.contain(declarations, binding, 'declaration', childIndex);
        this.bindingName(declaration.name, binding, `${path}/declaration/${childIndex}/pattern`);
        if (declaration.type) this.type(declaration.type, binding, `${path}/declaration/${childIndex}/type`);
        if (declaration.initializer)
          this.expression(
            declaration.initializer,
            binding,
            `${path}/declaration/${childIndex}/initializer`,
            'initializer',
          );
      });
    } else if (ts.isExpressionStatement(value)) this.expression(value.expression, node, `${path}/expression`);
    else if (ts.isIfStatement(value)) {
      this.expression(value.expression, node, `${path}/condition`, 'condition');
      this.branch(value.thenStatement, node, `${path}/true`, 'true', 0);
      this.branch(value.elseStatement, node, `${path}/false`, 'false', 1, value);
    } else if (ts.isForOfStatement(value) || ts.isForInStatement(value)) {
      if (ts.isVariableDeclarationList(value.initializer)) {
        const declaration = value.initializer.declarations[0];
        if (declaration) this.bindingName(declaration.name, node, `${path}/binding`);
      }
      this.expression(value.expression, node, `${path}/iterable`, 'iterable');
      this.branch(value.statement, node, `${path}/body`, 'body', 0);
    } else if (ts.isForStatement(value)) {
      const initializer = this.container(`${path}/initializer`, 'initializer-container', node, value, 'initializer');
      if (value.initializer) {
        if (ts.isVariableDeclarationList(value.initializer)) {
          const synthetic = ts.factory.createVariableStatement(undefined, value.initializer);
          ts.setTextRange(synthetic, value.initializer);
          this.statement(synthetic, initializer, `${path}/initializer/value`, 0);
        } else this.expression(value.initializer, initializer, `${path}/initializer/value`, 'initializer', 0);
      }
      if (value.condition) this.expression(value.condition, node, `${path}/condition`, 'condition');
      const increment = this.container(`${path}/increment`, 'increment-container', node, value, 'increment');
      if (value.incrementor) this.expression(value.incrementor, increment, `${path}/increment/value`, 'increment', 0);
      this.branch(value.statement, node, `${path}/body`, 'body', 0);
    } else if (ts.isWhileStatement(value) || ts.isDoStatement(value)) {
      this.expression(value.expression, node, `${path}/condition`, 'condition');
      this.branch(value.statement, node, `${path}/body`, 'body', 0);
    } else if (ts.isReturnStatement(value) && value.expression) {
      const result = this.expression(value.expression, node, `${path}/value`, 'value');
      const output = this.node(`${path}/output`, 'output', 'return-value', value, {
        type: { kind: 'ref', type: this.slot.output },
      });
      this.contain(node, output, 'output');
      this.edge('output', result, output, { role: 'value' });
    } else if (ts.isSwitchStatement(value)) {
      this.expression(value.expression, node, `${path}/value`, 'value');
      const cases = this.container(`${path}/cases`, 'case-container', node, value.caseBlock, 'cases');
      value.caseBlock.clauses.forEach((clause, childIndex) => {
        const item = this.node(`${path}/case/${childIndex}`, 'case', 'switch-case', clause, {
          label: ts.isCaseClause(clause) ? clause.expression.getText(this.file) : 'default',
        });
        this.contain(cases, item, 'case', childIndex);
        if (ts.isCaseClause(clause))
          this.expression(clause.expression, item, `${path}/case/${childIndex}/value`, 'value');
        this.statements(clause.statements, item, `${path}/case/${childIndex}/body`, clause, 'body');
      });
    } else if (ts.isBlock(value)) this.statements(value.statements, node, `${path}/body`, value, 'body');
    return node;
  }

  branch(
    statement: ts.Statement | undefined,
    parent: SemanticNodeId,
    path: string,
    role: string,
    index: number,
    fallback?: ts.Node,
  ): void {
    const source = statement ?? fallback ?? this.file;
    const branch = this.node(path, 'branch', 'branch-case', source, { label: role });
    this.contain(parent, branch, role, index);
    const values = statement ? (ts.isBlock(statement) ? statement.statements : [statement]) : [];
    this.statements(values, branch, `${path}/statements`, source, 'statements');
  }

  declaration(value: ts.Statement, parent: SemanticNodeId, path: string, index: number): void {
    if (ts.isImportDeclaration(value)) {
      const node = this.node(path, 'declaration', 'import-declaration', value, {
        label: ts.isStringLiteral(value.moduleSpecifier)
          ? value.moduleSpecifier.text
          : value.moduleSpecifier.getText(this.file),
      });
      this.contain(parent, node, 'declaration', index);
      const imports = this.container(`${path}/imports`, 'import-container', node, value, 'imports');
      const specifiers = value.importClause?.namedBindings;
      if (specifiers && ts.isNamedImports(specifiers))
        specifiers.elements.forEach((specifier, childIndex) => {
          const imported = this.node(`${path}/import/${childIndex}`, 'binding', 'import-specifier', specifier, {
            label: specifier.name.text,
            symbolId: derivedSymbolId(
              encoder.encode(`${this.request.source.module}:${path}:import:${specifier.name.text}`),
            ),
          });
          this.contain(imports, imported, 'import', childIndex);
          this.binding(specifier.name, imported);
        });
      return;
    }
    if (ts.isInterfaceDeclaration(value) || ts.isTypeAliasDeclaration(value)) {
      const semanticKind = ts.isInterfaceDeclaration(value) ? 'interface' : 'type-alias';
      const node = this.node(path, 'declaration', semanticKind, value, {
        label: value.name.text,
        symbolId: derivedSymbolId(encoder.encode(`${this.request.source.module}:${semanticKind}:${value.name.text}`)),
      });
      this.contain(parent, node, 'declaration', index);
      this.binding(value.name, node);
      this.typeParameters(value.typeParameters, node, path, value);
      if (ts.isInterfaceDeclaration(value)) {
        const members = this.container(`${path}/members`, 'type-member-container', node, value, 'members');
        value.members.forEach((member, childIndex) => {
          const memberNode = this.node(`${path}/member/${childIndex}`, 'type', 'type-member', member, {
            ...(member.name ? { label: member.name.getText(this.file) } : {}),
          });
          this.contain(members, memberNode, 'member', childIndex);
          if (
            (ts.isPropertySignature(member) || ts.isMethodSignature(member) || ts.isCallSignatureDeclaration(member)) &&
            member.type
          )
            this.type(member.type, memberNode, `${path}/member/${childIndex}/type`);
        });
      } else this.type(value.type, node, `${path}/type`);
      return;
    }
    if (ts.isFunctionDeclaration(value) && value.name && value.body) {
      const semanticKind = value.name.text === this.compilation.program.program.handler ? 'handler' : 'function';
      const node = this.node(path, 'declaration', semanticKind, value, {
        label: value.name.text,
        symbolId: derivedSymbolId(encoder.encode(`${this.request.source.module}:function:${value.name.text}`)),
      });
      this.contain(parent, node, 'declaration', index);
      this.binding(value.name, node);
      this.typeParameters(value.typeParameters, node, path, value);
      this.parameters(value.parameters, node, path, value);
      if (value.type) {
        const result = this.node(`${path}/return`, 'output', 'return-type', value.type, {
          ...(semanticKind === 'handler' ? { type: { kind: 'ref' as const, type: this.slot.output } } : {}),
        });
        this.contain(node, result, 'return-type');
        this.type(value.type, result, `${path}/return/type`);
      }
      this.statements(value.body.statements, node, `${path}/body`, value.body, 'body');
      return;
    }
    const node = this.node(path, 'declaration', 'structured', value);
    this.contain(parent, node, 'declaration', index);
  }

  finish(): CheckedSemanticModel {
    for (const reference of this.#references) {
      const symbol = this.checker.getSymbolAtLocation(reference.identifier);
      const declaration = symbol && this.#bindings.get(symbol);
      if (declaration) this.edge('references', reference.node, declaration, { role: 'binding' });
    }
    for (const [container, children] of this.#containerChildren) {
      for (let index = 0; index <= children.length; index++) {
        const before = children[index];
        const after = index === 0 ? undefined : children[index - 1];
        this.anchors.push(
          Object.freeze({
            container,
            index,
            ...(before ? { before } : {}),
            ...(after ? { after } : {}),
          }),
        );
      }
    }
    return Object.freeze({
      root: this.nodes[0]?.id as SemanticNodeId,
      nodes: Object.freeze(this.nodes),
      edges: Object.freeze(this.edges),
      anchors: Object.freeze(this.anchors),
    });
  }
}

function literalValue(value: ts.Expression): null | boolean | number | string {
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text.replaceAll('_', ''));
  if (ts.isBigIntLiteral(value)) return value.text.replaceAll('_', '').replace(/n$/, '');
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

/** Builds the checked, source-complete model without exposing TypeScript compiler objects. */
export function buildSemanticModel(
  source: string,
  request: CheckRequest,
  slot: SlotDefinition,
  compilation: VerifiedCompilation,
  limits: Readonly<{ nodes: number; edges: number }> = {
    nodes: Number.MAX_SAFE_INTEGER,
    edges: Number.MAX_SAFE_INTEGER,
  },
): CheckedSemanticModel {
  const checked = createCheckedSource(source);
  const builder = new ModelBuilder(
    checked.file,
    checked.checker,
    new Utf8SourceIndex(source),
    request,
    slot,
    compilation,
    limits,
  );
  const root = builder.node(`module:${request.source.module}`, 'module', 'module', checked.file, {
    label: String(request.source.module),
    symbolId: derivedSymbolId(encoder.encode(`${request.source.module}:module`)),
  });
  const declarations = builder.container('module/declarations', 'module-container', root, checked.file, 'declarations');
  checked.file.statements.forEach((statement, index) =>
    builder.declaration(statement, declarations, `module/declaration/${index}:${statement.kind}`, index),
  );
  const input = builder.node('module/slot-input', 'input', 'slot-input', undefined, {
    label: compilation.program.program.eventParameter,
    type: { kind: 'ref', type: slot.input },
  });
  builder.contain(root, input, 'slot-input');
  const output = builder.node('module/slot-output', 'output', 'slot-output', undefined, {
    type: { kind: 'ref', type: slot.output },
  });
  builder.contain(root, output, 'slot-output');
  return builder.finish();
}
