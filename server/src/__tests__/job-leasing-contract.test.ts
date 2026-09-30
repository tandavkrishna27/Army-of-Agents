import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  OPERATION_DESCRIPTORS,
  pollRequestV1Schema,
  protocolErrorV1Schema,
} from "@armyofagents/worker-protocol";
import { createWorkerSessionToken } from "../middleware/worker-session-auth.js";
import {
  verifyWorkerOperationProof,
  WorkerOperationProofError,
} from "../middleware/worker-operation-proof.js";
import { buildDeviceProofCanonicalInput } from "../services/worker-device-proof.js";
import { workerOperationProtocolErrorV1 } from "../services/worker-protocol-http.js";

type AuthorityWriter = {
  file: string;
  functionName: string;
  table: "executionTargets" | "workers";
  fields: string[];
  mode: "authority" | "last_seen_only";
};

type LexicalTableDeclaration = {
  name: string;
  table: AuthorityWriter["table"] | null;
  start: number;
  scopeStart: number;
  scopeEnd: number;
};

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "migrations" || entry.name === "dist") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return propertyName(current.name) ?? "<anonymous>";
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isPropertyAssignment(parent)) return propertyName(parent.name) ?? "<anonymous>";
    }
    current = current.parent;
  }
  return "<module>";
}

function canonicalTableName(
  node: ts.Expression | undefined,
  aliases: Map<string, AuthorityWriter["table"]>,
): AuthorityWriter["table"] | null {
  if (!node) return null;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return canonicalTableName(node.expression, aliases);
  }
  if (ts.isPropertyAccessExpression(node) &&
      (node.name.text === "executionTargets" || node.name.text === "workers")) {
    return node.name.text;
  }
  if (!ts.isIdentifier(node)) return null;
  if (node.text === "executionTargets" || node.text === "workers") return node.text;
  return aliases.get(node.text) ?? null;
}

function lexicalTableName(
  node: ts.Expression | undefined,
  useNode: ts.Node,
  declarations: LexicalTableDeclaration[],
  exportedAliases = new Map<string, AuthorityWriter["table"]>(),
): AuthorityWriter["table"] | null {
  if (!node) return null;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return lexicalTableName(node.expression, useNode, declarations, exportedAliases);
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === "executionTargets" || node.name.text === "workers") return node.name.text;
    return exportedAliases.get(node.name.text) ?? null;
  }
  if (!ts.isIdentifier(node)) return null;
  const use = useNode.getStart();
  const visible = declarations.filter((declaration) =>
    declaration.name === node.text && declaration.start <= use &&
    declaration.scopeStart <= use && use <= declaration.scopeEnd)
    .sort((left, right) =>
      (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart) || right.start - left.start);
  if (visible.length > 0) return visible[0]!.table;
  if (node.text === "executionTargets" || node.text === "workers") return node.text;
  return exportedAliases.get(node.text) ?? null;
}

function authorityExportAliases(
  sources: Array<{ file: string; source: string }>,
): Map<string, AuthorityWriter["table"]> {
  const aliases = new Map<string, AuthorityWriter["table"]>([
    ["executionTargets", "executionTargets"],
    ["workers", "workers"],
  ]);
  for (let pass = 0; pass < 4; pass += 1) {
    for (const input of sources) {
      const file = ts.createSourceFile(input.file, input.source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isExportSpecifier(node)) {
          const local = node.propertyName?.text ?? node.name.text;
          const table = aliases.get(local);
          if (table) aliases.set(node.name.text, table);
        }
        if (ts.isVariableStatement(node) &&
            node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          for (const declaration of node.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
            const initializer = declaration.initializer;
            const sourceName = ts.isIdentifier(initializer)
              ? initializer.text
              : ts.isPropertyAccessExpression(initializer) ? initializer.name.text : null;
            const table = sourceName ? aliases.get(sourceName) : undefined;
            if (table) aliases.set(declaration.name.text, table);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  }
  return aliases;
}

function lexicalTableDeclarations(
  sourceFile: ts.SourceFile,
  exportedAliases = new Map<string, AuthorityWriter["table"]>(),
): LexicalTableDeclaration[] {
  const declarations: LexicalTableDeclaration[] = [];
  const scopeOf = (node: ts.Node): ts.Node => {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
      current = current.parent;
    }
    return current ?? sourceFile;
  };
  const add = (name: string, table: AuthorityWriter["table"] | null, node: ts.Node, scope = scopeOf(node)): void => {
    declarations.push({
      name,
      table,
      start: node.getStart(sourceFile),
      scopeStart: scope.getStart(sourceFile),
      scopeEnd: scope.getEnd(),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      const direct = imported === "executionTargets" || imported === "workers" ? imported : null;
      add(node.name.text, exportedAliases.get(imported) ?? direct, node, sourceFile);
    }
    if (ts.isExportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      const direct = imported === "executionTargets" || imported === "workers" ? imported : null;
      add(node.name.text, exportedAliases.get(imported) ?? direct, node, sourceFile);
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) add(parameter.name.text, null, parameter, node);
      }
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) {
        const table = lexicalTableName(node.initializer, node, declarations, exportedAliases);
        add(node.name.text, table, node);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const sourceName = propertyName(element.propertyName) ?? element.name.text;
          add(element.name.text, exportedAliases.get(sourceName) ?? null, element);
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)) {
      add(node.left.text, lexicalTableName(node.right, node, declarations, exportedAliases), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function expressionObjectFields(
  node: ts.Expression | undefined,
  objects: Map<string, string[]>,
  functionReturns: Map<string, string[]>,
): string[] {
  if (!node) return ["<dynamic>"];
  if (ts.isAwaitExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return expressionObjectFields(node.expression, objects, functionReturns);
  }
  if (ts.isIdentifier(node)) return objects.get(node.text) ?? ["<dynamic>"];
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    return functionReturns.get(node.expression.text) ?? ["<dynamic>"];
  }
  if (ts.isConditionalExpression(node)) {
    return [...new Set([
      ...expressionObjectFields(node.whenTrue, objects, functionReturns),
      ...expressionObjectFields(node.whenFalse, objects, functionReturns),
    ])].sort();
  }
  if (!ts.isObjectLiteralExpression(node)) return ["<dynamic>"];
  const fields: string[] = [];
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      fields.push(...expressionObjectFields(property.expression, objects, functionReturns));
    } else {
      fields.push(propertyName(property.name) ?? "<computed>");
    }
  }
  return [...new Set(fields)].sort();
}

function templateText(node: ts.TaggedTemplateExpression): string {
  if (ts.isNoSubstitutionTemplateLiteral(node.template)) return node.template.text;
  return [node.template.head.text, ...node.template.templateSpans.map((span) => span.literal.text)].join(" ? ");
}

function staticStringBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  const resolve = (node: ts.Expression | undefined, seen = new Set<string>()): string | null => {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return resolve(node.expression, seen);
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return null;
      const value = bindings.get(node.text);
      return value ?? null;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolve(node.left, seen);
      const right = resolve(node.right, seen);
      return left === null || right === null ? null : left + right;
    }
    return null;
  };
  for (let pass = 0; pass < 4; pass += 1) {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = resolve(node.initializer, new Set([node.name.text]));
        if (value !== null) bindings.set(node.name.text, value);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return bindings;
}

function sqlFieldName(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function rawSqlAuthorityWriter(
  node: ts.TaggedTemplateExpression,
  resolveTable: (expression: ts.Expression | undefined) => AuthorityWriter["table"] | null =
    (expression) => canonicalTableName(expression, new Map()),
): {
  table: AuthorityWriter["table"];
  fields: string[];
} | null {
  const text = templateText(node);
  const deletion = /\bDELETE\s+FROM\s+(?:"?public"?\.)?"?(execution_targets|workers)"?\b/i.exec(text);
  if (deletion) {
    return {
      table: deletion[1]!.toLowerCase() === "execution_targets" ? "executionTargets" : "workers",
      fields: ["<delete>"],
    };
  }
  if (/^\s*DELETE\s+FROM\s+\?/i.test(text) && ts.isTemplateExpression(node.template)) {
    const table = resolveTable(node.template.templateSpans[0]?.expression);
    return table ? { table, fields: ["<delete>"] } : null;
  }
  const match = /\bUPDATE\s+(?:"?public"?\.)?"?(execution_targets|workers)"?(?:\s+(?:AS\s+)?[a-z][a-z0-9_]*)?\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i.exec(text);
  let table = match?.[1]?.toLowerCase() === "execution_targets"
    ? "executionTargets" as const
    : match?.[1]?.toLowerCase() === "workers" ? "workers" as const : null;
  let assignments = match?.[2] ?? "";
  if (!table && /^\s*UPDATE\s+\?/i.test(text) && ts.isTemplateExpression(node.template)) {
    table = resolveTable(node.template.templateSpans[0]?.expression);
    assignments = text.replace(/^\s*UPDATE\s+\?\s+(?:AS\s+\w+\s+)?SET\s+/i, "");
  }
  if (!table) return null;
  const fields = [...assignments.matchAll(/"?([a-z][a-z0-9_]*)"?\s*=/gi)]
    .map((field) => sqlFieldName(field[1]!.toLowerCase()))
    .sort();
  return {
    table,
    fields: fields.length > 0 ? fields : ["<dynamic>"],
  };
}

function rawSqlAuthorityWriterText(text: string): {
  table: AuthorityWriter["table"];
  fields: string[];
} | null {
  const deletion = /\bDELETE\s+FROM\s+(?:"?public"?\.)?"?(execution_targets|workers)"?\b/i.exec(text);
  if (deletion) {
    return {
      table: deletion[1]!.toLowerCase() === "execution_targets" ? "executionTargets" : "workers",
      fields: ["<delete>"],
    };
  }
  const match = /\bUPDATE\s+(?:"?public"?\.)?"?(execution_targets|workers)"?(?:\s+(?:AS\s+)?[a-z][a-z0-9_]*)?\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i.exec(text);
  if (!match) return null;
  const fields = [...match[2]!.matchAll(/"?([a-z][a-z0-9_]*)"?\s*=/gi)]
    .map((field) => sqlFieldName(field[1]!.toLowerCase()))
    .sort();
  return {
    table: match[1]!.toLowerCase() === "execution_targets" ? "executionTargets" : "workers",
    fields: fields.length > 0 ? fields : ["<dynamic>"],
  };
}

function scanAuthorityWriters(sources: Array<{ file: string; source: string }>): AuthorityWriter[] {
  const writers: AuthorityWriter[] = [];
  const exportedAliases = authorityExportAliases(sources);
  for (const input of sources) {
    const sourceFile = ts.createSourceFile(input.file, input.source, ts.ScriptTarget.Latest, true);
    const lexicalDeclarations = lexicalTableDeclarations(sourceFile, exportedAliases);
    const strings = staticStringBindings(sourceFile);
    const objectFields = new Map<string, string[]>();
    const functionReturnFields = new Map<string, string[]>();
    const collectFunctionReturns = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const returned: string[] = [];
        const scanReturns = (child: ts.Node): void => {
          if (child !== node && ts.isFunctionLike(child)) return;
          if (ts.isReturnStatement(child) && child.expression) {
            returned.push(...expressionObjectFields(child.expression, objectFields, functionReturnFields));
          }
          ts.forEachChild(child, scanReturns);
        };
        scanReturns(node.body);
        if (returned.length > 0) functionReturnFields.set(node.name.text, [...new Set(returned)].sort());
      }
      ts.forEachChild(node, collectFunctionReturns);
    };
    collectFunctionReturns(sourceFile);
    for (let pass = 0; pass < 3; pass += 1) {
      const collectObjects = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const fields = expressionObjectFields(node.initializer, objectFields, functionReturnFields);
          if (fields.some((field) => field !== "<dynamic>")) objectFields.set(node.name.text, fields);
        }
        ts.forEachChild(node, collectObjects);
      };
      collectObjects(sourceFile);
    }
    type ExpressionAlias = {
      name: string;
      expression: ts.Expression | null;
      start: number;
      scopeStart: number;
      scopeEnd: number;
    };
    const expressionAliases: ExpressionAlias[] = [];
    const expressionScope = (node: ts.Node): ts.Node => {
      let current: ts.Node | undefined = node.parent;
      while (current && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
        current = current.parent;
      }
      return current ?? sourceFile;
    };
    const collectExpressionAliases = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) {
        for (const parameter of node.parameters) {
          if (ts.isIdentifier(parameter.name)) {
            expressionAliases.push({
              name: parameter.name.text,
              expression: null,
              start: parameter.getStart(sourceFile),
              scopeStart: node.getStart(sourceFile),
              scopeEnd: node.getEnd(),
            });
          }
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const scope = expressionScope(node);
        expressionAliases.push({
          name: node.name.text,
          expression: node.initializer ?? null,
          start: node.getStart(sourceFile),
          scopeStart: scope.getStart(sourceFile),
          scopeEnd: scope.getEnd(),
        });
      }
      ts.forEachChild(node, collectExpressionAliases);
    };
    collectExpressionAliases(sourceFile);
    const conflictSetFields = (
      node: ts.Expression | undefined,
      useNode: ts.Node,
      seen = new Set<string>(),
    ): string[] => {
      if (!node) return ["<dynamic>"];
      if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
        return conflictSetFields(node.expression, useNode, seen);
      }
      if (ts.isIdentifier(node)) {
        if (seen.has(node.text)) return ["<dynamic>"];
        const use = useNode.getStart(sourceFile);
        const alias = expressionAliases.filter((candidate) => candidate.name === node.text &&
          candidate.start <= use && candidate.scopeStart <= use && use <= candidate.scopeEnd)
          .sort((left, right) =>
            (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart) || right.start - left.start)[0];
        return alias?.expression
          ? conflictSetFields(alias.expression, useNode, new Set([...seen, node.text]))
          : ["<dynamic>"];
      }
      if (!ts.isObjectLiteralExpression(node)) return ["<dynamic>"];
      const fields: string[] = [];
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property) && propertyName(property.name) === "set") {
          fields.push(...expressionObjectFields(property.initializer, objectFields, functionReturnFields));
        } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === "set") {
          fields.push(...expressionObjectFields(property.name, objectFields, functionReturnFields));
        } else if (ts.isSpreadAssignment(property)) {
          fields.push(...conflictSetFields(property.expression, useNode, seen));
        }
      }
      return fields.length > 0 ? [...new Set(fields)].sort() : ["<dynamic>"];
    };
    type Builder = {
      name: string;
      kind: "update" | "insert";
      table: AuthorityWriter["table"] | null;
      start: number;
      scopeStart: number;
      scopeEnd: number;
    };
    const builders: Builder[] = [];
    const builderScope = (node: ts.Node): ts.Node => {
      let current: ts.Node | undefined = node.parent;
      while (current && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
        current = current.parent;
      }
      return current ?? sourceFile;
    };
    const directBuilder = (expression: ts.Expression | undefined, useNode: ts.Node): Omit<Builder, "name" | "start" | "scopeStart" | "scopeEnd"> | null => {
      if (!expression) return null;
      if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) {
        return directBuilder(expression.expression, useNode);
      }
      let chain = expression;
      while (ts.isCallExpression(chain) && ts.isPropertyAccessExpression(chain.expression)) {
        const callName = chain.expression.name.text;
        if (callName === "update" || callName === "insert") {
          return {
            kind: callName,
            table: lexicalTableName(chain.arguments[0], useNode, lexicalDeclarations, exportedAliases),
          };
        }
        chain = chain.expression.expression;
      }
      return null;
    };
    const collectBuilders = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const binding = directBuilder(node.initializer, node);
        if (binding) {
          const scope = builderScope(node);
          builders.push({
            name: node.name.text,
            ...binding,
            start: node.getStart(sourceFile),
            scopeStart: scope.getStart(sourceFile),
            scopeEnd: scope.getEnd(),
          });
        }
      }
      ts.forEachChild(node, collectBuilders);
    };
    collectBuilders(sourceFile);
    const resolveBuilder = (expression: ts.Expression | undefined, useNode: ts.Node): Builder | null => {
      const direct = directBuilder(expression, useNode);
      if (direct) {
        return { name: "<direct>", ...direct, start: 0, scopeStart: 0, scopeEnd: sourceFile.getEnd() };
      }
      if (!expression || !ts.isIdentifier(expression)) return null;
      const use = useNode.getStart(sourceFile);
      return builders.filter((builder) => builder.name === expression.text && builder.start <= use &&
        builder.scopeStart <= use && use <= builder.scopeEnd)
        .sort((left, right) =>
          (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart) || right.start - left.start)[0] ?? null;
    };
    const recordWriter = (
      node: ts.Node,
      table: AuthorityWriter["table"] | null,
      fields: string[],
    ): void => {
      if (!table) return;
      const lastSeenOnly = fields.every((field) => field === "lastSeenAt" || field === "updatedAt");
      writers.push({
        file: input.file.replaceAll("\\", "/"),
        functionName: enclosingFunctionName(node),
        table,
        fields,
        mode: lastSeenOnly ? "last_seen_only" : "authority",
      });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "set") {
        const update = resolveBuilder(node.expression.expression, node);
        if (update?.kind === "update") {
          recordWriter(node, update.table, expressionObjectFields(node.arguments[0], objectFields, functionReturnFields));
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          (node.expression.name.text === "unsafe" || node.expression.name.text === "raw")) {
        const argument = node.arguments[0];
        const text = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
          ? argument.text
          : argument && ts.isIdentifier(argument) ? strings.get(argument.text) ?? null : null;
        const raw = text ? rawSqlAuthorityWriterText(text) : null;
        if (raw) {
          recordWriter(node, raw.table, raw.fields);
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "onConflictDoUpdate" && node.arguments[0]) {
        const builder = resolveBuilder(node.expression.expression, node);
        if (builder?.kind === "insert" && builder.table) {
          const fields = conflictSetFields(node.arguments[0], node);
          recordWriter(node, builder.table, fields);
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "values") {
        const builder = resolveBuilder(node.expression.expression, node);
        if (builder?.kind === "insert" && builder.table) recordWriter(node, builder.table, ["<insert>"]);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "delete") {
        const table = lexicalTableName(node.arguments[0], node, lexicalDeclarations, exportedAliases);
        if (table) {
          writers.push({
            file: input.file.replaceAll("\\", "/"),
            functionName: enclosingFunctionName(node),
            table,
            fields: ["<delete>"],
            mode: "authority",
          });
        }
      }
      if (ts.isTaggedTemplateExpression(node)) {
        const raw = rawSqlAuthorityWriter(
          node,
          (expression) => lexicalTableName(expression, node, lexicalDeclarations, exportedAliases),
        );
        if (raw) {
          recordWriter(node, raw.table, raw.fields);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return writers.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function scanDynamicRawSqlSites(sources: Array<{ file: string; source: string }>): string[] {
  const sites: string[] = [];
  for (const input of sources) {
    const sourceFile = ts.createSourceFile(input.file, input.source, ts.ScriptTarget.Latest, true);
    const strings = staticStringBindings(sourceFile);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          (node.expression.name.text === "unsafe" || node.expression.name.text === "raw")) {
        const argument = node.arguments[0];
        if (!argument || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
          const resolved = argument && ts.isIdentifier(argument) ? strings.get(argument.text) : undefined;
          const argumentShape = resolved ?? argument?.getText(sourceFile).replace(/\s+/g, " ") ?? "<missing>";
          const argumentDigest = createHash("sha256").update(argumentShape).digest("hex").slice(0, 12);
          sites.push(
            `${input.file.replaceAll("\\", "/")}#${enclosingFunctionName(node)}:.${node.expression.name.text}:${argumentDigest}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites.sort();
}

function writerIdentity(writer: AuthorityWriter): string {
  return `${writer.file}#${writer.functionName}:${writer.table}:${writer.fields.join(",")}:${writer.mode}`;
}

function namedFunctionSource(source: string, name: string): string {
  const file = ts.createSourceFile("named-source.ts", source, ts.ScriptTarget.Latest, true);
  let match: string | null = null;
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        propertyName(node.name) === name) {
      match = ts.isMethodDeclaration(node)
        ? `const fixture = { ${node.getText(file)} };`
        : node.getText(file);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!match) throw new Error(`writer function ${name} was not found`);
  return match;
}

function hasNamedFunction(source: string, name: string): boolean {
  const file = ts.createSourceFile("named-check.ts", source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && propertyName(node.name) === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function namedFunctionMutationInventory(source: string, name: string): string[] {
  const functionSource = namedFunctionSource(source, name);
  const file = ts.createSourceFile("mutation-inventory.ts", functionSource, ts.ScriptTarget.Latest, true);
  const canonicalTables = new Set([
    "workerLeaseRejections", "workers", "executionTargets", "jobs", "jobAttempts", "leases",
  ]);
  const aliases = new Map<string, string>();
  const builders = new Map<string, { operation: "insert" | "update"; table: string | null }>();
  const tableName = (expression: ts.Expression | undefined): string | null => {
    if (!expression) return null;
    if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) return tableName(expression.expression);
    if (ts.isIdentifier(expression)) {
      if (canonicalTables.has(expression.text)) return expression.text;
      return aliases.get(expression.text) ?? null;
    }
    if (ts.isPropertyAccessExpression(expression) && canonicalTables.has(expression.name.text)) {
      return expression.name.text;
    }
    return null;
  };
  const directBuilder = (expression: ts.Expression | undefined): { operation: "insert" | "update"; table: string | null } | null => {
    if (!expression) return null;
    if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) return directBuilder(expression.expression);
    let chain = expression;
    while (ts.isCallExpression(chain) && ts.isPropertyAccessExpression(chain.expression)) {
      if (chain.expression.name.text === "insert" || chain.expression.name.text === "update") {
        return { operation: chain.expression.name.text, table: tableName(chain.arguments[0]) };
      }
      chain = chain.expression.expression;
    }
    return ts.isIdentifier(expression) ? builders.get(expression.text) ?? null : null;
  };
  for (let pass = 0; pass < 3; pass += 1) {
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const table = tableName(node.initializer);
        if (table) aliases.set(node.name.text, table);
        const builder = directBuilder(node.initializer);
        if (builder) builders.set(node.name.text, builder);
      }
      ts.forEachChild(node, collect);
    };
    collect(file);
  }
  const found: string[] = [];
  const record = (table: string | null, operation: string): void => {
    found.push(`${table ?? "<dynamic>"}:${operation}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callName = node.expression.name.text;
      if (callName === "values") {
        const builder = directBuilder(node.expression.expression);
        if (builder?.operation === "insert") record(builder.table, "insert");
      } else if (callName === "set") {
        const builder = directBuilder(node.expression.expression);
        if (builder?.operation === "update") record(builder.table, "update");
      } else if (callName === "delete") {
        record(tableName(node.arguments[0]), "delete");
      } else if ((callName === "unsafe" || callName === "raw") && node.arguments[0] &&
          (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) {
        const match = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?public"?\.)?"?([a-z_]+)"?/i.exec(node.arguments[0].text);
        if (match) {
          const table = [...canonicalTables].find((candidate) =>
            candidate.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`) === match[2]!) ?? null;
          record(table, match[1]!.toUpperCase().startsWith("INSERT") ? "insert" :
            match[1]!.toUpperCase().startsWith("DELETE") ? "delete" : "update");
        }
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const text = templateText(node);
      const match = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?public"?\.)?"?([a-z_]+)"?/i.exec(text);
      if (match) {
        const table = [...canonicalTables].find((candidate) =>
          candidate.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`) === match[2]!) ?? null;
        record(table, match[1]!.toUpperCase().startsWith("INSERT") ? "insert" :
          match[1]!.toUpperCase().startsWith("DELETE") ? "delete" : "update");
      } else if (ts.isTemplateExpression(node.template)) {
        const dynamic = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\?/i.exec(text);
        if (dynamic) {
          record(
            tableName(node.template.templateSpans[0]?.expression),
            dynamic[1]!.toUpperCase().startsWith("INSERT") ? "insert" :
              dynamic[1]!.toUpperCase().startsWith("DELETE") ? "delete" : "update",
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(found)].sort();
}

function namedFunctionUnexpectedCertificateCalls(source: string, name: string): string[] {
  const functionSource = namedFunctionSource(source, name);
  const file = ts.createSourceFile("certificate-call-inventory.ts", functionSource, ts.ScriptTarget.Latest, true);
  const allowedDatabaseFluent = new Set([
    "select", "selectDistinct", "from", "innerJoin", "leftJoin", "rightJoin", "fullJoin",
    "where", "orderBy", "groupBy", "having", "limit", "offset", "for", "as",
    "insert", "values", "onConflictDoNothing", "onConflictDoUpdate", "delete", "returning",
  ]);
  const allowedCollectionFluent = new Set([
    "map", "filter", "some", "every", "includes", "slice", "sort",
  ]);
  const allowedPure = new Set([
    "and", "or", "eq", "ne", "gt", "gte", "lt", "lte", "inArray", "isNull", "isNotNull",
    "exists", "notExists", "asc", "desc",
  ]);
  const reviewedBuilders = new Set<string>();
  const reviewedCollections = new Set<string>();
  const locallyBound = new Set<string>();
  const databaseRooted = (expression: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
      return databaseRooted(expression.expression);
    }
    if (ts.isIdentifier(expression)) return reviewedBuilders.has(expression.text);
    if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return false;
    const receiver = expression.expression.expression;
    const callName = expression.expression.name.text;
    if (ts.isIdentifier(receiver) && receiver.text === "tx" &&
        ["select", "selectDistinct", "insert", "delete"].includes(callName)) return true;
    return allowedDatabaseFluent.has(callName) && databaseRooted(receiver);
  };
  const collectionRooted = (expression: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
        ts.isNonNullExpression(expression)) return collectionRooted(expression.expression);
    if (ts.isAwaitExpression(expression)) return databaseRooted(expression.expression);
    if (ts.isArrayLiteralExpression(expression)) return true;
    if (ts.isIdentifier(expression)) return reviewedCollections.has(expression.text);
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) &&
        expression.expression.text === "input") return true;
    if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return false;
    return allowedCollectionFluent.has(expression.expression.name.text) &&
      collectionRooted(expression.expression.expression);
  };
  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) locallyBound.add(node.name.text);
    if (ts.isFunctionDeclaration(node) && node.name) locallyBound.add(node.name.text);
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) locallyBound.add(parameter.name.text);
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(file);
  for (let pass = 0; pass < 3; pass += 1) {
    const collectBuilders = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (databaseRooted(node.initializer)) reviewedBuilders.add(node.name.text);
        if (collectionRooted(node.initializer)) reviewedCollections.add(node.name.text);
      }
      ts.forEachChild(node, collectBuilders);
    };
    collectBuilders(file);
  }
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        if (!allowedPure.has(node.expression.text) || locallyBound.has(node.expression.text)) {
          found.push(node.expression.text);
        }
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const callName = node.expression.name.text;
        const receiver = node.expression.expression.getText(file).replace(/\s+/g, "");
        const allowedMath = receiver === "Math" && ["min", "max", "floor"].includes(callName);
        // Reviewed non-Drizzle helpers used only for bound validation and the statement-budget
        // callback: receiver-scoped so a `mutateAuthority.isSafeInteger`/`authority.beforeStatement`
        // decoy is still flagged.
        const allowedNumericGuard = receiver === "Number" && callName === "isSafeInteger";
        const allowedBudgetCallback = receiver === "input" && callName === "beforeStatement";
        const allowedDatabaseCall = allowedDatabaseFluent.has(callName) &&
          ((ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "tx" &&
            ["select", "selectDistinct", "insert", "delete"].includes(callName)) ||
            databaseRooted(node.expression.expression));
        const allowedCollectionCall = allowedCollectionFluent.has(callName) &&
          collectionRooted(node.expression.expression);
        if (!allowedDatabaseCall && !allowedCollectionCall && !allowedMath &&
            !allowedNumericGuard && !allowedBudgetCallback) {
          found.push(`${receiver}.${callName}`);
        }
      } else {
        found.push("<dynamic-call>");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(found)].sort();
}

function namedFunctionCertificateMutationScopes(source: string, name: string): string[] {
  const functionSource = namedFunctionSource(source, name);
  const file = ts.createSourceFile("certificate-scope-columns.ts", functionSource, ts.ScriptTarget.Latest, true);
  const columns = new Set(["organizationId", "workerId", "targetId", "attemptId"]);
  const expressions = new Map<string, ts.Expression>();
  const tableAliases = new Map<string, string>();
  const builders = new Map<string, { table: string; operation: "insert" | "delete" }>();
  const tableName = (expression: ts.Expression): string | null => {
    if (ts.isIdentifier(expression)) {
      if (expression.text === "workerLeaseRejections") return expression.text;
      return tableAliases.get(expression.text) ?? null;
    }
    return null;
  };
  const directBuilder = (expression: ts.Expression): { table: string; operation: "insert" | "delete" } | null => {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
      return directBuilder(expression.expression);
    }
    if (ts.isIdentifier(expression)) return builders.get(expression.text) ?? null;
    if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return null;
    const callName = expression.expression.name.text;
    if ((callName === "insert" || callName === "delete") && expression.arguments[0]) {
      const table = tableName(expression.arguments[0]);
      return table ? { table, operation: callName } : null;
    }
    return directBuilder(expression.expression.expression);
  };
  for (let pass = 0; pass < 3; pass += 1) {
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        expressions.set(node.name.text, node.initializer);
        const table = tableName(node.initializer);
        if (table) tableAliases.set(node.name.text, table);
        const builder = directBuilder(node.initializer);
        if (builder) builders.set(node.name.text, builder);
      }
      ts.forEachChild(node, collect);
    };
    collect(file);
  }
  const inspectArgument = (node: ts.Node, found: Set<string>, seen = new Set<string>()): void => {
    if (ts.isIdentifier(node) && expressions.has(node.text) && !seen.has(node.text)) {
      const nextSeen = new Set(seen).add(node.text);
      inspectArgument(expressions.get(node.text)!, found, nextSeen);
    }
    if (ts.isPropertyAssignment(node)) {
      const key = propertyName(node.name);
      if (key && columns.has(key)) found.add(key);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === "workerLeaseRejections" && columns.has(node.name.text)) {
      found.add(node.name.text);
    }
    ts.forEachChild(node, (child) => inspectArgument(child, found, seen));
  };
  const maximalChain = (node: ts.CallExpression): ts.Node => {
    let current: ts.Node = node;
    while (current.parent) {
      if (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
        current = current.parent;
        continue;
      }
      if (ts.isCallExpression(current.parent) && current.parent.expression === current) {
        current = current.parent;
        continue;
      }
      break;
    }
    return current;
  };
  const results: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callName = node.expression.name.text;
      const builder = directBuilder(callName === "values" ? node.expression.expression : node);
      const isInsert = callName === "values" && builder?.operation === "insert";
      const isDelete = callName === "delete" && builder?.operation === "delete";
      if ((isInsert || isDelete) && builder?.table === "workerLeaseRejections") {
        const found = new Set<string>();
        inspectArgument(maximalChain(node), found);
        results.push(`${builder.table}:${builder.operation}:${[...found].sort().join(",")}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return results.sort();
}

function namedFunctionAuditSource(source: string, name: string): string {
  const file = ts.createSourceFile("audit-source.ts", source, ts.ScriptTarget.Latest, true);
  const imports = file.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => statement.getText(file));
  return `${imports.join("\n")}\n${namedFunctionSource(source, name)}`;
}

function namedVariableFunctionSource(source: string, name: string): string {
  const file = ts.createSourceFile("variable-function.ts", source, ts.ScriptTarget.Latest, true);
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name &&
        node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      found = `const ${name} = ${node.initializer.getText(file)};`;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`variable function ${name} was not found`);
  return found;
}

function awaitedCallFacts(source: string): Array<{ name: string; awaited: boolean; position: number }> {
  const file = ts.createSourceFile("awaited-calls.ts", source, ts.ScriptTarget.Latest, true);
  const facts: Array<{ name: string; awaited: boolean; position: number }> = [];
  const isAwaited = (node: ts.Node): boolean => {
    let current = node;
    while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent))) {
      current = current.parent;
    }
    return Boolean(current.parent && ts.isAwaitExpression(current.parent));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
      if (name) facts.push({ name, awaited: isAwaited(node), position: node.getStart(file) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return facts;
}

const authorityRepositoryDelegateMethods = new Set([
  "advanceTargetGeneration",
  "insertWorker",
  "ratifyPlacementProfile",
  "retireBootstrapCredential",
  "revokeTargetAuthority",
  "rotateWorker",
]);

function repositoryDelegateCallSiteInventory(
  sources: Array<{ file: string; source: string }>,
): string[] {
  const found: string[] = [];
  for (const input of sources) {
    const file = ts.createSourceFile(input.file, input.source, ts.ScriptTarget.Latest, true);
    type DelegateBinding = {
      name: string;
      initializer: ts.Expression | null;
      fixedMethod: string | null;
      start: number;
      scopeStart: number;
      scopeEnd: number;
      assignment: boolean;
    };
    const bindings: DelegateBinding[] = [];
    const bindingScope = (node: ts.Node): ts.Node => {
      let current: ts.Node | undefined = node.parent;
      while (current && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
        current = current.parent;
      }
      return current ?? file;
    };
    const addBinding = (
      name: string,
      initializer: ts.Expression | null,
      fixedMethod: string | null,
      node: ts.Node,
      scope = bindingScope(node),
      assignment = false,
    ): void => {
      bindings.push({
        name,
        initializer,
        fixedMethod,
        start: node.getStart(file),
        scopeStart: scope.getStart(file),
        scopeEnd: scope.getEnd(),
        assignment,
      });
    };
    const collectDeclarations = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) {
        for (const parameter of node.parameters) {
          if (ts.isIdentifier(parameter.name)) addBinding(parameter.name.text, null, null, parameter, node);
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        addBinding(node.name.text, null, null, node);
      }
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name)) {
          addBinding(node.name.text, node.initializer ?? null, null, node);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const imported = element.propertyName ? propertyName(element.propertyName) : element.name.text;
            addBinding(
              element.name.text,
              null,
              imported && authorityRepositoryDelegateMethods.has(imported) ? imported : null,
              element,
            );
          }
        }
      }
      ts.forEachChild(node, collectDeclarations);
    };
    collectDeclarations(file);
    const declarationAt = (name: string, useNode: ts.Node): DelegateBinding | null => {
      const use = useNode.getStart(file);
      return bindings.filter((binding) => !binding.assignment && binding.name === name &&
        binding.scopeStart <= use && use <= binding.scopeEnd)
        .sort((left, right) =>
          (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart) ||
          right.start - left.start)[0] ?? null;
    };
    const collectAssignments = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left)) {
        const declaration = declarationAt(node.left.text, node);
        if (declaration) {
          bindings.push({
            name: node.left.text,
            initializer: node.right,
            fixedMethod: null,
            start: node.getStart(file),
            scopeStart: declaration.scopeStart,
            scopeEnd: declaration.scopeEnd,
            assignment: true,
          });
        }
      }
      ts.forEachChild(node, collectAssignments);
    };
    collectAssignments(file);
    const delegateReference = (
      expression: ts.Expression,
      useNode: ts.Node,
      seen = new Set<string>(),
    ): string | null => {
      if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
          ts.isNonNullExpression(expression)) return delegateReference(expression.expression, useNode, seen);
      if (ts.isIdentifier(expression)) {
        if (seen.has(expression.text)) return null;
        const declaration = declarationAt(expression.text, useNode);
        if (!declaration) return null;
        const use = useNode.getStart(file);
        const assignment = bindings.filter((binding) => binding.assignment &&
          binding.name === expression.text && binding.scopeStart === declaration.scopeStart &&
          binding.scopeEnd === declaration.scopeEnd && binding.start <= use)
          .sort((left, right) => right.start - left.start)[0];
        const binding = assignment ?? declaration;
        if (!assignment && use < declaration.start) return null;
        if (binding.fixedMethod) return binding.fixedMethod;
        return binding.initializer
          ? delegateReference(binding.initializer, binding.initializer, new Set([...seen, expression.text]))
          : null;
      }
      if (ts.isPropertyAccessExpression(expression) &&
          authorityRepositoryDelegateMethods.has(expression.name.text)) return expression.name.text;
      if (ts.isElementAccessExpression(expression) && expression.argumentExpression &&
          (ts.isStringLiteral(expression.argumentExpression) ||
           ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression)) &&
          authorityRepositoryDelegateMethods.has(expression.argumentExpression.text)) {
        return expression.argumentExpression.text;
      }
      if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
          expression.expression.name.text === "bind") {
        return delegateReference(expression.expression.expression, useNode, seen);
      }
      return null;
    };
    const observation = (call: ts.CallExpression): "awaited" | "returned" | "unobserved" => {
      let current: ts.Node = call;
      while (current.parent && (
        ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) ||
        ts.isNonNullExpression(current.parent)
      )) current = current.parent;
      if (ts.isAwaitExpression(current.parent)) return "awaited";
      if (ts.isReturnStatement(current.parent)) return "returned";
      if ((ts.isArrowFunction(current.parent) || ts.isFunctionExpression(current.parent)) &&
          current.parent.body === current) return "returned";
      return "unobserved";
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const direct = delegateReference(node.expression, node);
        const method = direct ?? (ts.isPropertyAccessExpression(node.expression) &&
          (node.expression.name.text === "call" || node.expression.name.text === "apply")
          ? delegateReference(node.expression.expression, node)
          : null);
        if (method) {
          found.push(`${input.file.replaceAll("\\", "/")}#${enclosingFunctionName(node)}:${method}:${observation(node)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found.sort();
}

function placementProfileDelegateFlowViolations(source: string): string[] {
  const file = ts.createSourceFile("placement-profile-flow.ts", source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  let owner: ts.FunctionDeclaration | null = null;
  const locate = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "ratifyTenantExecutionTargetPlacementProfile") {
      owner = node;
      return;
    }
    ts.forEachChild(node, locate);
  };
  locate(file);
  if (!owner?.body) return ["ratifyTenantExecutionTargetPlacementProfile:missing"];

  const calls: Array<{ node: ts.CallExpression; name: string }> = [];
  const scan = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      calls.push({ node, name: node.expression.name.text });
    }
    ts.forEachChild(node, scan);
  };
  scan(owner.body);
  const delegates = calls.filter((call) => call.name === "ratifyPlacementProfile");
  if (delegates.length !== 1) return [`ratifyPlacementProfile:count:${delegates.length}`];
  const delegate = delegates[0]!.node;
  const executionScope = (node: ts.Node): ts.FunctionLikeDeclaration | null => {
    let current: ts.Node | undefined = node.parent;
    while (current && current !== owner) {
      if (ts.isFunctionLike(current)) return current;
      current = current.parent;
    }
    return owner;
  };
  const scope = executionScope(delegate);
  const directlyAwaited = (call: ts.CallExpression): boolean => {
    let current: ts.Node = call;
    while (current.parent && (
      ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent)
    )) current = current.parent;
    return ts.isAwaitExpression(current.parent);
  };
  const directInScope = (node: ts.Node, functionScope: ts.FunctionLikeDeclaration | null): boolean => {
    if (!functionScope) return false;
    let current: ts.Node | undefined = node.parent;
    while (current && current !== functionScope) {
      if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isTryStatement(current) ||
          ts.isCatchClause(current) || ts.isForStatement(current) || ts.isForInStatement(current) ||
          ts.isForOfStatement(current) || ts.isWhileStatement(current) || ts.isDoStatement(current) ||
          ts.isCaseClause(current) || ts.isDefaultClause(current) ||
          (ts.isBinaryExpression(current) &&
            (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
             current.operatorToken.kind === ts.SyntaxKind.BarBarToken))) return false;
      current = current.parent;
    }
    return current === functionScope;
  };
  if (!directlyAwaited(delegate) || !directInScope(delegate, scope)) {
    violations.push("ratifyPlacementProfile:observation");
  }

  const locks = calls.filter((call) => call.name === "lockPlacementProfileTarget" &&
    executionScope(call.node) === scope && call.node.getStart(file) < delegate.getStart(file));
  if (locks.length !== 1 || !directlyAwaited(locks[0]!.node) || !directInScope(locks[0]!.node, scope)) {
    violations.push("placement-profile-lock");
  }

  const normalize = (node: ts.Node): string => node.getText(file).replace(/\s+/g, "").replace(/'/g, '"');
  let exactScopeDenial = false;
  const findScopeDenial = (node: ts.Node): void => {
    if (node !== scope?.body && ts.isFunctionLike(node)) return;
    if (ts.isIfStatement(node) && node.getStart(file) < delegate.getStart(file) &&
        normalize(node.expression) === '!target||target.organizationId!==input.organizationId||target.scope==="platform"' &&
        directInScope(node, scope)) {
      const statements = ts.isBlock(node.thenStatement) ? node.thenStatement.statements : [node.thenStatement];
      exactScopeDenial = statements.some(ts.isThrowStatement);
    }
    ts.forEachChild(node, findScopeDenial);
  };
  if (scope?.body) findScopeDenial(scope.body);
  if (!exactScopeDenial) violations.push("placement-profile-scope-denial");
  return [...new Set(violations)].sort();
}

function enrollmentAuthorityFlowViolations(source: string): string[] {
  const file = ts.createSourceFile("enrollment-authority-flow.ts", source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  let body: ts.ConciseBody | null = null;
  let authoritativeSharedGuard: ts.VariableDeclaration | null = null;
  type GuardBinding = {
    declaration: ts.Node;
    start: number;
    scopeStart: number;
    scopeEnd: number;
  };
  const guardBindings: GuardBinding[] = [];
  const bindingScope = (node: ts.Node): ts.Node => {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
      current = current.parent;
    }
    return current ?? file;
  };
  const addGuardBinding = (declaration: ts.Node, scope = bindingScope(declaration)): void => {
    guardBindings.push({
      declaration,
      start: declaration.getStart(file),
      scopeStart: scope.getStart(file),
      scopeEnd: scope.getEnd(),
    });
  };
  const locate = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && node.name.text === "requireCurrentPlatformPhysicalAuthority") {
      addGuardBinding(node, file);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === "requireCurrentPlatformPhysicalAuthority") {
      addGuardBinding(node);
      const statement = node.parent.parent;
      const block = statement.parent;
      const owner = block.parent;
      if (ts.isVariableStatement(statement) && ts.isBlock(block) &&
          ts.isFunctionDeclaration(owner) && owner.name?.text === "createWorkerEnrollmentService" &&
          node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        authoritativeSharedGuard = node;
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "requireCurrentPlatformPhysicalAuthority") {
      addGuardBinding(node);
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === "requireCurrentPlatformPhysicalAuthority") {
          addGuardBinding(parameter, node);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === "completeEnrollment" && node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      body = node.initializer.body;
    }
    ts.forEachChild(node, locate);
  };
  locate(file);
  if (!body || !ts.isBlock(body)) return ["completeEnrollment:missing"];

  const normalize = (node: ts.Node): string => node.getText(file)
    .replace(/\s+/g, "")
    .replace(/'/g, '"');
  let sharedDeclaration: ts.VariableDeclaration | null = null;
  let sharedBranch: ts.IfStatement | null = null;
  const calls: Array<{ node: ts.CallExpression; name: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === "sharedPlatformProfile") sharedDeclaration = node;
    if (ts.isIfStatement(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === "sharedPlatformProfile") sharedBranch = node;
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
      if (name) calls.push({ node, name });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  const sharedInitializer = sharedDeclaration?.initializer;
  if (!sharedInitializer || normalize(sharedInitializer) !==
      'authoritativeOrganizationId!==null&&target.scope==="platform"') {
    violations.push("shared-platform-condition");
  }
  if (!sharedBranch) return [...violations, "shared-platform-branch"];

  const isDirectlyAwaited = (call: ts.CallExpression): boolean => {
    let current: ts.Node = call;
    while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent))) {
      current = current.parent;
    }
    return ts.isAwaitExpression(current.parent);
  };
  const isDirectInBranch = (call: ts.CallExpression, branch: ts.Statement): boolean => {
    let current: ts.Node | undefined = call.parent;
    while (current && current !== branch) {
      if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isTryStatement(current) ||
          ts.isCatchClause(current) || ts.isForStatement(current) || ts.isForInStatement(current) ||
          ts.isForOfStatement(current) || ts.isWhileStatement(current) || ts.isDoStatement(current) ||
          (ts.isBinaryExpression(current) &&
            (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
             current.operatorToken.kind === ts.SyntaxKind.BarBarToken))) return false;
      current = current.parent;
    }
    return current === branch;
  };
  const branchCalls = (branch: ts.Statement, name: string) => calls.filter((call) =>
    call.name === name && call.node.getStart(file) >= branch.getStart(file) && call.node.getEnd() <= branch.getEnd());
  const sharedGuards = branchCalls(sharedBranch.thenStatement, "requireCurrentPlatformPhysicalAuthority");
  if (sharedGuards.length !== 1 || !isDirectlyAwaited(sharedGuards[0]!.node) ||
      !isDirectInBranch(sharedGuards[0]!.node, sharedBranch.thenStatement)) {
    violations.push("shared-platform-guard");
  }
  const sharedGuardCall = sharedGuards[0]?.node;
  const boundGuard = sharedGuardCall && ts.isIdentifier(sharedGuardCall.expression)
    ? guardBindings.filter((binding) =>
        binding.scopeStart <= sharedGuardCall.getStart(file) && sharedGuardCall.getStart(file) <= binding.scopeEnd)
      .sort((left, right) =>
        (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart) || right.start - left.start)[0]
    : undefined;
  if (!authoritativeSharedGuard || boundGuard?.declaration !== authoritativeSharedGuard) {
    violations.push("shared-platform-guard-binding");
  }

  const nullBranch = sharedBranch.elseStatement && ts.isIfStatement(sharedBranch.elseStatement)
    ? sharedBranch.elseStatement
    : null;
  if (!nullBranch || normalize(nullBranch.expression) !==
      'authoritativeOrganizationId===null&&target.scope==="platform"') {
    violations.push("null-platform-condition");
  } else {
    const exclusive = branchCalls(nullBranch.thenStatement, "acquirePlatformTargetAuthorityExclusive");
    if (exclusive.length !== 1 || !isDirectlyAwaited(exclusive[0]!.node) ||
        !isDirectInBranch(exclusive[0]!.node, nullBranch.thenStatement)) {
      violations.push("null-platform-exclusive");
    }
  }

  const branchEnd = sharedBranch.getEnd();
  for (const mutationName of [
    "advanceTargetGeneration", "rotateWorker", "insertWorker", "retireBootstrapCredential",
  ]) {
    const mutations = calls.filter((call) => call.name === mutationName);
    if (mutations.length === 0 || mutations.some((call) =>
      call.node.getStart(file) <= branchEnd || !isDirectlyAwaited(call.node))) {
      violations.push(`mutation:${mutationName}`);
    }
  }
  return [...new Set(violations)].sort();
}

const exactPlacementDecisionWhereConjuncts = [
  "currentOwnerAuthority",
  "eq(jobAttempts.companyId,input.companyId)",
  "eq(jobAttempts.id,input.attemptId)",
  "eq(jobAttempts.jobId,input.jobId)",
  "eq(jobAttempts.organizationId,input.organizationId)",
  "isNull(jobAttempts.placementDecidedAt)",
].sort();

function persistPlacementDecisionPredicateFacts(source: string): Array<{
  exactMutation: boolean;
  conjuncts: string[];
}> {
  const file = ts.createSourceFile("placement-decision-predicate.ts", source, ts.ScriptTarget.Latest, true);
  type DrizzleBindingKind = "isNull" | "eq" | "exists" | "sql" | null;
  type PredicateBinding = {
    name: string;
    kind: DrizzleBindingKind;
    initializer: ts.Expression | null;
    scopeStart: number;
    scopeEnd: number;
  };
  const bindings: PredicateBinding[] = [];
  const bindingScope = (node: ts.Node): ts.Node => {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
      current = current.parent;
    }
    return current ?? file;
  };
  const addBinding = (
    name: string,
    kind: DrizzleBindingKind,
    initializer: ts.Expression | null,
    node: ts.Node,
    scope = bindingScope(node),
  ): void => {
    bindings.push({
      name,
      kind,
      initializer,
      scopeStart: scope.getStart(file),
      scopeEnd: scope.getEnd(),
    });
  };
  const collectBindings = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      const declaration = node.parent.parent.parent;
      const moduleName = ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier)
        ? declaration.moduleSpecifier.text
        : "";
      const kind = moduleName === "drizzle-orm" &&
          ["isNull", "eq", "exists", "sql"].includes(imported)
        ? imported as Exclude<DrizzleBindingKind, null>
        : null;
      addBinding(node.name.text, kind, null, node, file);
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) addBinding(parameter.name.text, null, null, parameter, node);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) addBinding(node.name.text, null, null, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      addBinding(node.name.text, null, node.initializer ?? null, node);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(file);
  const bindingAt = (name: string, useNode: ts.Node): PredicateBinding | null => {
    const use = useNode.getStart(file);
    return bindings.filter((binding) => binding.name === name &&
      binding.scopeStart <= use && use <= binding.scopeEnd)
      .sort((left, right) =>
        (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart))[0] ?? null;
  };
  const drizzlePredicate = (expression: ts.Expression, useNode: ts.Node): boolean => {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
        ts.isNonNullExpression(expression)) return drizzlePredicate(expression.expression, useNode);
    if (ts.isConditionalExpression(expression)) {
      return drizzlePredicate(expression.whenTrue, useNode) && drizzlePredicate(expression.whenFalse, useNode);
    }
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
      const kind = bindingAt(expression.expression.text, expression)?.kind;
      return kind === "eq" || kind === "exists";
    }
    if (ts.isTaggedTemplateExpression(expression) && ts.isIdentifier(expression.tag)) {
      return bindingAt(expression.tag.text, expression)?.kind === "sql";
    }
    return false;
  };
  let owner: ts.FunctionLikeDeclaration | null = null;
  const locate = (node: ts.Node): void => {
    const name = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node)) && node.name
      ? propertyName(node.name)
      : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ? node.name.text
        : null;
    if (name === "persistPlacementDecision") {
      owner = ts.isVariableDeclaration(node) ? node.initializer as ts.FunctionLikeDeclaration : node;
      return;
    }
    ts.forEachChild(node, locate);
  };
  locate(file);
  if (!owner?.body) return [];

  const unwrap = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
        ts.isNonNullExpression(current)) current = current.expression;
    return current;
  };
  const containsJobAttemptUpdate = (expression: ts.Expression): boolean => {
    const current = unwrap(expression);
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      if (current.expression.name.text === "update" && current.arguments.length === 1 &&
          unwrap(current.arguments[0]!) .getText(file) === "jobAttempts") return true;
      return containsJobAttemptUpdate(current.expression.expression);
    }
    if (ts.isPropertyAccessExpression(current)) return containsJobAttemptUpdate(current.expression);
    return false;
  };
  const isExactMutation = (whereReceiver: ts.Expression): boolean => {
    const setCall = unwrap(whereReceiver);
    if (!ts.isCallExpression(setCall) || !ts.isPropertyAccessExpression(setCall.expression) ||
        setCall.expression.name.text !== "set") return false;
    const updateCall = unwrap(setCall.expression.expression);
    return ts.isCallExpression(updateCall) && ts.isPropertyAccessExpression(updateCall.expression) &&
      updateCall.expression.name.text === "update" &&
      ts.isIdentifier(unwrap(updateCall.expression.expression)) &&
      (unwrap(updateCall.expression.expression) as ts.Identifier).text === "tx" &&
      updateCall.arguments.length === 1 && unwrap(updateCall.arguments[0]!).getText(file) === "jobAttempts";
  };
  const facts: Array<{ exactMutation: boolean; conjuncts: string[] }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "where" &&
        containsJobAttemptUpdate(node.expression.expression) &&
        node.arguments.length === 1) {
      const predicate = node.arguments[0]!;
      let conjuncts: string[] = [];
      if (ts.isCallExpression(predicate) && ts.isIdentifier(predicate.expression) &&
          predicate.expression.text === "and") {
        conjuncts = predicate.arguments.map((argument) => {
          const compact = argument.getText(file).replace(/\s+/g, "");
          if (ts.isCallExpression(argument) && ts.isIdentifier(argument.expression) &&
              argument.expression.text === "isNull" &&
              compact === "isNull(jobAttempts.placementDecidedAt)") {
            return bindingAt(argument.expression.text, argument)?.kind === "isNull"
              ? compact
              : "<invalid-isNull-binding>";
          }
          if (ts.isIdentifier(argument) && argument.text === "currentOwnerAuthority") {
            const binding = bindingAt(argument.text, argument);
            return binding?.initializer && drizzlePredicate(binding.initializer, binding.initializer)
              ? "currentOwnerAuthority"
              : "<invalid-currentOwnerAuthority>";
          }
          return compact;
        }).sort();
      }
      facts.push({ exactMutation: isExactMutation(node.expression.expression), conjuncts });
    }
    ts.forEachChild(node, visit);
  };
  visit(owner.body);
  return facts;
}

function persistPlacementDecisionWhereConjuncts(source: string): string[] {
  const facts = persistPlacementDecisionPredicateFacts(source);
  return facts.length === 1 && facts[0]!.exactMutation ? facts[0]!.conjuncts : [];
}

function persistPlacementDecisionPredicateViolations(source: string): string[] {
  const facts = persistPlacementDecisionPredicateFacts(source);
  const actual = facts[0]?.conjuncts ?? [];
  return facts.length === 1 && facts[0]!.exactMutation &&
    actual.length === exactPlacementDecisionWhereConjuncts.length &&
    actual.every((conjunct, index) => conjunct === exactPlacementDecisionWhereConjuncts[index])
    ? []
    : ["persistPlacementDecision:one-shot-predicate"];
}

function forbiddenLeaseContinuationIdentifiers(source: string): string[] {
  const file = ts.createSourceFile("lease-continuation.ts", source, ts.ScriptTarget.Latest, true);
  const forbidden = new Set(["LeaseCandidateCursor", "after", "continuation", "candidateCursor", "leaseScanCursor"]);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && forbidden.has(node.text)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(found)].sort();
}

function namedInterfaceMethodSource(source: string, interfaceName: string, methodName: string): string {
  const file = ts.createSourceFile("interface-method.ts", source, ts.ScriptTarget.Latest, true);
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      const member = node.members.find((candidate) =>
        (ts.isMethodSignature(candidate) || ts.isPropertySignature(candidate)) &&
        propertyName(candidate.name) === methodName);
      if (member) found = member.getText(file);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`${interfaceName}.${methodName} interface method was not found`);
  return found;
}

function namedInterfaceMethodInputMembers(
  source: string,
  interfaceName: string,
  methodName: string,
): string[] {
  const file = ts.createSourceFile("interface-input.ts", source, ts.ScriptTarget.Latest, true);
  let members: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      const method = node.members.find((candidate) =>
        ts.isMethodSignature(candidate) && propertyName(candidate.name) === methodName);
      const parameter = method && ts.isMethodSignature(method) ? method.parameters[0] : undefined;
      if (!parameter?.type || !ts.isTypeLiteralNode(parameter.type)) {
        members = ["<non-literal-input>"];
        return;
      }
      members = parameter.type.members.map((member) => propertyName(member.name) ?? "<dynamic>").sort();
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!members) throw new Error(`${interfaceName}.${methodName} literal input was not found`);
  return members;
}

function namedFunctionInputProperties(source: string, functionName: string, parameterName: string): string[] {
  const file = ts.createSourceFile("function-input.ts", source, ts.ScriptTarget.Latest, true);
  const properties: string[] = [];
  let found = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        propertyName(node.name) === functionName && node.body) {
      found = true;
      const scan = (child: ts.Node): void => {
        if (child !== node.body && ts.isFunctionLike(child)) return;
        if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression) &&
            child.expression.text === parameterName) {
          properties.push(child.name.text);
        }
        if (ts.isElementAccessExpression(child) && ts.isIdentifier(child.expression) &&
            child.expression.text === parameterName) {
          properties.push(ts.isStringLiteral(child.argumentExpression)
            ? child.argumentExpression.text
            : "<dynamic>");
        }
        ts.forEachChild(child, scan);
      };
      scan(node.body);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`function ${functionName} was not found`);
  return [...new Set(properties)].sort();
}

function namedFunctionMainWhereConjuncts(source: string, functionName: string): string[] {
  const file = ts.createSourceFile("where-contract.ts", source, ts.ScriptTarget.Latest, true);
  let conjuncts: ts.Expression[] | null = null;
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        propertyName(node.name) === functionName && node.body) {
      const scan = (child: ts.Node): void => {
        if (child !== node.body && ts.isFunctionLike(child)) return;
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) &&
            child.expression.name.text === "where" && child.arguments[0] &&
            ts.isCallExpression(child.arguments[0]) && ts.isIdentifier(child.arguments[0].expression) &&
            child.arguments[0].expression.text === "and") {
          const candidates = [...child.arguments[0].arguments];
          const text = candidates.map((candidate) => candidate.getText(file)).join("\n");
          if (text.includes("jobAttempts.status") && text.includes("notExists")) conjuncts = candidates;
        }
        ts.forEachChild(child, scan);
      };
      scan(node.body);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!conjuncts) return ["<main-candidate-where-missing>"];
  return conjuncts.map((expression) => {
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
        expression.expression.text === "notExists") {
      const text = expression.getText(file);
      return text.includes("workerLeaseRejections")
        ? "notExists(workerLeaseRejections)"
        : "notExists(<unexpected>)";
    }
    return expression.getText(file)
      .replace(/\s+/g, "")
      .replace(/'([^']*)'/g, '"$1"');
  }).sort();
}

function platformGuardOrderViolations(
  source: string,
  auditAllMutations = false,
  allowReviewedThisDelegate = false,
): string[] {
  const file = ts.createSourceFile("guard-fixture.ts", source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const lexicalDeclarations = lexicalTableDeclarations(file);
  const expressionIdentity = (expression: ts.Expression | undefined): string | null => {
    if (!expression) return null;
    if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression) ||
        ts.isNonNullExpression(expression)) return expressionIdentity(expression.expression);
    return expression.getText(file).replace(/\s+/g, "");
  };
  type MutationBuilder = {
    name: string;
    kind: "update" | "insert";
    table: AuthorityWriter["table"] | null;
    transaction: string | null;
  };
  const mutationBuilders: MutationBuilder[] = [];
  const directMutationBuilder = (expression: ts.Expression | undefined, useNode: ts.Node): Omit<MutationBuilder, "name"> | null => {
    if (!expression) return null;
    if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) {
      return directMutationBuilder(expression.expression, useNode);
    }
    let chain = expression;
    while (ts.isCallExpression(chain) && ts.isPropertyAccessExpression(chain.expression)) {
      const callName = chain.expression.name.text;
      if (callName === "update" || callName === "insert") {
        return {
          kind: callName,
          table: lexicalTableName(chain.arguments[0], useNode, lexicalDeclarations),
          transaction: expressionIdentity(chain.expression.expression),
        };
      }
      chain = chain.expression.expression;
    }
    return null;
  };
  const collectMutationBuilders = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const builder = directMutationBuilder(node.initializer, node);
      if (builder) mutationBuilders.push({ name: node.name.text, ...builder });
    }
    ts.forEachChild(node, collectMutationBuilders);
  };
  collectMutationBuilders(file);
  const mutationBuilder = (expression: ts.Expression | undefined, useNode: ts.Node): Omit<MutationBuilder, "name"> | null => {
    const direct = directMutationBuilder(expression, useNode);
    if (direct) return direct;
    return expression && ts.isIdentifier(expression)
      ? mutationBuilders.find((builder) => builder.name === expression.text) ?? null
      : null;
  };
  const directlyAwaited = (node: ts.Node): boolean => {
    let current: ts.Node = node;
    while (current.parent && (
      ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) ||
      (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) ||
      (ts.isCallExpression(current.parent) && current.parent.expression === current)
    )) current = current.parent;
    return ts.isAwaitExpression(current.parent);
  };
  type HelperKind = "exclusive" | "operatorFactory" | null;
  const helperDeclarations: Array<{
    name: string;
    kind: HelperKind;
    start: number;
    scopeStart: number;
    scopeEnd: number;
  }> = [];
  const helperScopeOf = (node: ts.Node): ts.Node => {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
      current = current.parent;
    }
    return current ?? file;
  };
  const addHelper = (name: string, kind: HelperKind, node: ts.Node, scope = helperScopeOf(node)): void => {
    helperDeclarations.push({
      name,
      kind,
      start: node.getStart(file),
      scopeStart: scope.getStart(file),
      scopeEnd: scope.getEnd(),
    });
  };
  const collectHelpers = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      const declaration = node.parent.parent.parent;
      const moduleName = ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier)
        ? declaration.moduleSpecifier.text
        : "";
      const allowedModule = moduleName === "@armyofagents/db" ||
        moduleName === "../../platform-target-authority-lock.js";
      addHelper(node.name.text,
        allowedModule && imported === "acquirePlatformTargetAuthorityExclusive"
          ? "exclusive"
          : allowedModule && imported === "operatorJobLeasingRepository"
            ? "operatorFactory"
            : null,
        node,
        file);
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) addHelper(parameter.name.text, null, parameter, node);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) addHelper(node.name.text, null, node);
    if (ts.isFunctionDeclaration(node) && node.name) addHelper(node.name.text, null, node);
    ts.forEachChild(node, collectHelpers);
  };
  collectHelpers(file);
  const helperKindAt = (name: string, useNode: ts.Node): HelperKind => {
    const use = useNode.getStart(file);
    const visible = helperDeclarations.filter((declaration) => declaration.name === name &&
      declaration.scopeStart <= use && use <= declaration.scopeEnd)
      .sort((left, right) =>
        (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart) || right.start - left.start);
    return visible[0]?.kind ?? null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node.body) {
      const markers: Array<{
        kind: "target" | "worker" | "combined" | "exclusive" | "mutation";
        position: number;
        controlPath: string[];
        awaited: boolean;
        transaction: string | null;
        target: string | null;
        identityBound: boolean;
      }> = [];
      const rowTargetAliases = new Map<string, { transaction: string | null; target: string }>();
      const queryFacts = (expression: ts.Expression): {
        transaction: string | null;
        target: string | null;
      } => {
        let current = expression;
        while (ts.isAwaitExpression(current) || ts.isAsExpression(current) ||
            ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
          current = current.expression;
        }
        let transaction: string | null = null;
        let target: string | null = null;
        const inspectPredicate = (predicate: ts.Node): void => {
          if (target === null && ts.isCallExpression(predicate) &&
              ts.isIdentifier(predicate.expression) && predicate.expression.text === "eq" &&
              predicate.arguments.length === 2) {
            const [left, right] = predicate.arguments;
            if (ts.isPropertyAccessExpression(left!) && left.name.text === "id" &&
                lexicalTableName(left.expression, predicate, lexicalDeclarations) === "executionTargets") {
              target = expressionIdentity(right);
            } else if (ts.isPropertyAccessExpression(right!) && right.name.text === "id" &&
                lexicalTableName(right.expression, predicate, lexicalDeclarations) === "executionTargets") {
              target = expressionIdentity(left);
            }
          }
          ts.forEachChild(predicate, inspectPredicate);
        };
        let chain: ts.Expression = current;
        while (ts.isCallExpression(chain) && ts.isPropertyAccessExpression(chain.expression)) {
          const callName = chain.expression.name.text;
          if (callName === "select") transaction = expressionIdentity(chain.expression.expression);
          if (callName === "where" && chain.arguments[0]) inspectPredicate(chain.arguments[0]);
          chain = chain.expression.expression;
        }
        return { transaction, target };
      };
      const collectRowTargetAliases = (child: ts.Node): void => {
        if (child !== node.body && ts.isFunctionLike(child)) return;
        if (ts.isVariableDeclaration(child) && ts.isArrayBindingPattern(child.name) && child.initializer) {
          const first = child.name.elements[0];
          if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
            const facts = queryFacts(child.initializer);
            if (facts.target) rowTargetAliases.set(first.name.text, {
              transaction: facts.transaction,
              target: facts.target,
            });
          }
        }
        ts.forEachChild(child, collectRowTargetAliases);
      };
      collectRowTargetAliases(node.body);
      const targetIdentity = (expression: ts.Expression | undefined): string | null => {
        if (!expression) return null;
        if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression) ||
            ts.isNonNullExpression(expression)) return targetIdentity(expression.expression);
        if (ts.isPropertyAccessExpression(expression) && expression.name.text === "id" &&
            ts.isIdentifier(expression.expression)) {
          return rowTargetAliases.get(expression.expression.text)?.target ?? expressionIdentity(expression);
        }
        return expressionIdentity(expression);
      };
      const mutationTarget = (
        mutation: ts.CallExpression,
        table: AuthorityWriter["table"] | null,
      ): string | null => {
        let current: ts.Node = mutation;
        while (current.parent && (
          ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current ||
          ts.isCallExpression(current.parent) && current.parent.expression === current
        )) {
          current = current.parent;
          if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) &&
              current.expression.name.text === "where" && current.arguments[0]) {
            let found: string | null = null;
            const inspect = (predicate: ts.Node): void => {
              if (found !== null || !ts.isCallExpression(predicate) ||
                  !ts.isIdentifier(predicate.expression) || predicate.expression.text !== "eq" ||
                  predicate.arguments.length !== 2) {
                ts.forEachChild(predicate, inspect);
                return;
              }
              const [left, right] = predicate.arguments;
              const columnMatches = (candidate: ts.Expression): boolean =>
                ts.isPropertyAccessExpression(candidate) &&
                lexicalTableName(candidate.expression, candidate, lexicalDeclarations) === table &&
                (candidate.name.text === "id" ||
                  table === "workers" && candidate.name.text === "executionTargetId");
              if (columnMatches(left!)) found = targetIdentity(right);
              else if (columnMatches(right!)) found = targetIdentity(left);
              if (found === null) ts.forEachChild(predicate, inspect);
            };
            inspect(current.arguments[0]);
            if (found !== null) return found;
          }
        }
        return null;
      };
      const controlPath = (child: ts.Node): string[] => {
        const path: string[] = [];
        let current: ts.Node | undefined = child;
        while (current && current !== node) {
          const parent = current.parent;
          if (!parent) break;
          if (ts.isIfStatement(parent)) {
            path.unshift(`${parent.getStart(file)}:${current === parent.thenStatement ? "then" : "else"}`);
          } else if (ts.isTryStatement(parent)) {
            path.unshift(`${parent.getStart(file)}:${current === parent.tryBlock ? "try" :
              current === parent.catchClause ? "catch" : "finally"}`);
          } else if (ts.isConditionalExpression(parent)) {
            path.unshift(`${parent.getStart(file)}:${current === parent.whenTrue ? "true" : "false"}`);
          } else if (ts.isBinaryExpression(parent) &&
              (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
               parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
            path.unshift(`${parent.getStart(file)}:${current === parent.left ? "left" : "right"}`);
          } else if (ts.isCaseClause(parent) || ts.isDefaultClause(parent) ||
              ts.isForStatement(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent) ||
              ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isCatchClause(parent)) {
            path.unshift(`${parent.kind}:${parent.getStart(file)}`);
          }
          current = parent;
        }
        return path;
      };
      const addMarker = (
        kind: (typeof markers)[number]["kind"],
        child: ts.Node,
        identity: Partial<Pick<(typeof markers)[number], "transaction" | "target" | "identityBound">> = {},
      ): void => {
        markers.push({
          kind,
          position: child.getStart(file),
          controlPath: controlPath(child),
          awaited: directlyAwaited(child),
          transaction: identity.transaction ?? null,
          target: identity.target ?? null,
          identityBound: identity.identityBound ?? false,
        });
      };
      const scan = (child: ts.Node): void => {
        if (child !== node.body && ts.isFunctionLike(child)) return;
        if (ts.isCallExpression(child)) {
          const callName = ts.isIdentifier(child.expression)
            ? child.expression.text
            : ts.isPropertyAccessExpression(child.expression)
              ? child.expression.name.text
              : null;
          if (callName === "for" && child.arguments[0] && ts.isStringLiteral(child.arguments[0]) &&
              child.arguments[0].text === "update" && ts.isPropertyAccessExpression(child.expression)) {
            let query: ts.Expression = child.expression.expression;
            let fromArgument: ts.Expression | undefined;
            while (ts.isCallExpression(query) && ts.isPropertyAccessExpression(query.expression)) {
              if (query.expression.name.text === "from") {
                fromArgument = query.arguments[0];
                break;
              }
              query = query.expression.expression;
            }
            const lockedTable = lexicalTableName(fromArgument, child, lexicalDeclarations);
            if (lockedTable === "executionTargets") {
              addMarker("target", child);
            }
            if (lockedTable === "workers") {
              addMarker("worker", child);
            }
          }
          if (ts.isIdentifier(child.expression) &&
              helperKindAt(child.expression.text, child) === "exclusive") {
            addMarker("exclusive", child);
          }
          if (ts.isPropertyAccessExpression(child.expression) &&
              child.expression.name.text === "lockPlatformAuthorityForMutation") {
            const receiver = child.expression.expression;
            const trustedThis = allowReviewedThisDelegate && receiver.kind === ts.SyntaxKind.ThisKeyword;
            const trustedFactory = ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression) &&
              helperKindAt(receiver.expression.text, child) === "operatorFactory";
            if (trustedThis) addMarker("combined", child);
            if (trustedFactory) addMarker("combined", child, {
              transaction: expressionIdentity(receiver.arguments[0]),
              target: targetIdentity(child.arguments[0]),
              identityBound: true,
            });
          }
          if (callName === "set" && ts.isPropertyAccessExpression(child.expression)) {
            const update = mutationBuilder(child.expression.expression, child);
            if (update?.kind === "update" && (auditAllMutations || update.table !== null)) {
              addMarker("mutation", child, {
                transaction: update.transaction,
                target: mutationTarget(child, update.table),
              });
            }
          }
          if (callName === "onConflictDoUpdate" && ts.isPropertyAccessExpression(child.expression)) {
            const insert = mutationBuilder(child.expression.expression, child);
            if (insert?.kind === "insert" && (auditAllMutations || insert.table !== null)) addMarker("mutation", child);
          }
          if (callName === "values" && ts.isPropertyAccessExpression(child.expression)) {
            const insert = mutationBuilder(child.expression.expression, child);
            if (insert?.kind === "insert" && (auditAllMutations || insert.table !== null)) addMarker("mutation", child);
          }
          if (callName === "delete" && ts.isPropertyAccessExpression(child.expression) &&
              (auditAllMutations || lexicalTableName(child.arguments[0], child, lexicalDeclarations) !== null)) {
            addMarker("mutation", child);
          }
          if ((callName === "unsafe" || callName === "raw") && child.arguments[0]) {
            const argument = child.arguments[0];
            const rawText = ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
              ? argument.text
              : "";
            if (/\bSELECT\b[\s\S]*?\bFROM\s+(?:"?public"?\.)?"?execution_targets"?[\s\S]*?\bFOR\s+UPDATE\b/i.test(rawText)) {
              addMarker("target", child);
            }
            if (/\bSELECT\b[\s\S]*?\bFROM\s+(?:"?public"?\.)?"?workers"?[\s\S]*?\bFOR\s+UPDATE\b/i.test(rawText)) {
              addMarker("worker", child);
            }
            if (rawSqlAuthorityWriterText(rawText) || auditAllMutations && /\b(?:UPDATE|DELETE)\b/i.test(rawText)) {
              addMarker("mutation", child);
            }
          }
        }
        if (ts.isTaggedTemplateExpression(child)) {
          const rawText = templateText(child);
          if (/\bSELECT\b[\s\S]*?\bFROM\s+"?execution_targets"?[\s\S]*?\bFOR\s+UPDATE\b/i.test(rawText)) {
            addMarker("target", child);
          }
          if (/\bSELECT\b[\s\S]*?\bFROM\s+"?workers"?[\s\S]*?\bFOR\s+UPDATE\b/i.test(rawText)) {
            addMarker("worker", child);
          }
          if (rawSqlAuthorityWriter(
            child,
            (expression) => lexicalTableName(expression, child, lexicalDeclarations),
          ) || auditAllMutations && /\b(?:UPDATE|DELETE)\b/i.test(rawText)) {
            addMarker("mutation", child);
          }
        }
        ts.forEachChild(child, scan);
      };
      scan(node.body);
      const dominates = (guard: (typeof markers)[number], mutation: (typeof markers)[number]): boolean =>
        guard.awaited && mutation.awaited && guard.position < mutation.position &&
        guard.controlPath.every((part, index) => mutation.controlPath[index] === part);
      const mutations = markers.filter((marker) => marker.kind === "mutation");
      if (mutations.length > 0) {
        for (const mutation of mutations) {
          const targets = markers.filter((marker) => marker.kind === "target" && dominates(marker, mutation));
          const workers = markers.filter((marker) => marker.kind === "worker" && dominates(marker, mutation));
          const exclusives = markers.filter((marker) => marker.kind === "exclusive" && dominates(marker, mutation));
          const combined = markers.filter((marker) => marker.kind === "combined" && dominates(marker, mutation));
          const directOrder = targets.some((target) => workers.some((worker) =>
            target.position < worker.position && exclusives.some((exclusive) =>
              worker.position < exclusive.position && exclusive.position < mutation.position)));
          // A delegated writer may call the single reviewed helper. The helper
          // itself is audited below and must contain target -> worker ->
          // exclusive; a call bearing this name is never enough on its own.
          const delegatedOrder = combined.some((guard) => dominates(guard, mutation) && (
            !guard.identityBound || Boolean(
              guard.transaction && mutation.transaction && guard.transaction === mutation.transaction &&
              guard.target && mutation.target && guard.target === mutation.target
            )
          ));
          if (directOrder || delegatedOrder) continue;
          violations.push(enclosingFunctionName(node));
          break;
        }
      } else if (enclosingFunctionName(node) === "lockPlatformAuthorityForMutation") {
        const targets = markers.filter((marker) => marker.kind === "target");
        const workers = markers.filter((marker) => marker.kind === "worker");
        const exclusives = markers.filter((marker) => marker.kind === "exclusive");
        const completePath = targets.some((target) => workers.some((worker) =>
          dominates(target, worker) && exclusives.some((exclusive) => dominates(worker, exclusive))));
        if (!completePath) violations.push("lockPlatformAuthorityForMutation");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(violations)].sort();
}

function signedPoll() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = publicKey.export({ format: "der", type: "spki" });
  const publicKeyHeader = publicKeyBytes.toString("base64url");
  const deviceThumbprint = createHash("sha256").update(publicKeyBytes).digest("hex");
  const now = new Date();
  const request = pollRequestV1Schema.parse({
    protocolVersion: 1,
    correlationId: randomUUID(),
    issuedAt: now.toISOString(),
    nonce: "job-003-contract-poll",
    audience: "worker_poll",
    workerId: "b3000000-0000-4000-8000-000000000001",
    targetId: "b3000000-0000-4000-8000-000000000002",
    deviceGeneration: 3,
    capacity: {
      batchSlots: 1,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 1_000,
      freeMemoryMiB: 1_024,
      freeDiskMiB: 2_048,
    },
  });
  const rawBody = Buffer.from(JSON.stringify(request));
  const proofId = "job-003-contract-proof";
  const canonical = buildDeviceProofCanonicalInput({
    method: "POST",
    path: "/api/worker-control/poll",
    bodyDigest: createHash("sha256").update(rawBody).digest("hex"),
    correlationId: request.correlationId,
    issuedAt: now.toISOString(),
    proofId,
  });
  const sessionKey = "job-003-contract-session-signing-key-which-is-long-enough";
  return {
    now,
    request,
    rawBody,
    authorization: `Bearer ${createWorkerSessionToken(sessionKey, {
      aud: "device_session",
      sub: request.workerId,
      organizationId: "b3000000-0000-4000-8000-000000000003",
      targetId: request.targetId,
      generation: 3,
      scope: "organization",
      deviceThumbprint,
      profileHash: "9".repeat(64),
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor((now.getTime() + 10 * 60_000) / 1000),
    })}`,
    sessionKey,
    deviceThumbprint,
    proof: {
      version: "1",
      publicKey: publicKeyHeader,
      signature: sign(null, Buffer.from(canonical), privateKey).toString("base64url"),
      issuedAt: now.toISOString(),
      proofId,
    },
  };
}

function leaseStaticContextPollViolations(source: string): string[] {
  const file = ts.createSourceFile("job-leasing-static-context.ts", source, ts.ScriptTarget.Latest, true);
  const violations = new Set<string>();
  const exactImports = [
    ["buildLeaseStaticContextInput", "./job-lease-eligibility.js"],
    ["evaluateStaticLeaseEligibility", "./job-lease-eligibility.js"],
    ["leaseStaticContextHash", "./job-lease-eligibility.js"],
    ["normalizePlacementRegistryTarget", "./execution-target-resolver.js"],
    ["normalizeSubmittedJobPlacementFacts", "./job-placement.js"],
    ["leaseOfferV1Schema", "@armyofagents/worker-protocol"],
    ["jobEnvelopeV1Schema", "@armyofagents/worker-protocol"],
    ["pollRequestV1Schema", "@armyofagents/worker-protocol"],
    ["pollResponseV1Schema", "@armyofagents/worker-protocol"],
    ["workerHelloV1Schema", "@armyofagents/worker-protocol"],
    ["runInTenant", "../db/tenant-context.js"],
    ["operatorJobLeasingRepository", "@armyofagents/db"],
  ] as const;
  const imports = new Map<string, Array<{ local: string; module: string }>>();
  const eligibilityNamespaces = new Set<string>();
  const namespaceImports = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceImports.add(bindings.name.text);
      if (statement.moduleSpecifier.text === "./job-lease-eligibility.js") {
        eligibilityNamespaces.add(bindings.name.text);
      }
      continue;
    }
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      const imported = specifier.propertyName?.text ?? specifier.name.text;
      const facts = imports.get(imported) ?? [];
      facts.push({ local: specifier.name.text, module: statement.moduleSpecifier.text });
      imports.set(imported, facts);
    }
  }
  for (const [name, module] of exactImports) {
    const facts = imports.get(name) ?? [];
    if (facts.length !== 1 || facts[0]!.local !== name || facts[0]!.module !== module) {
      violations.add(`import:${name}`);
    }
  }
  const eligibilityImportDeclarations = file.statements.filter((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === "./job-lease-eligibility.js");
  const reviewedEligibilityNames = [
    "buildLeaseStaticContextInput",
    "evaluateStaticLeaseEligibility",
    "LEASE_STATIC_ELIGIBILITY_VERSION",
    "leaseStaticContextHash",
  ];
  const reviewedEligibilityBindings = eligibilityImportDeclarations.length === 1
    ? eligibilityImportDeclarations[0]!.importClause?.namedBindings
    : null;
  if (eligibilityImportDeclarations.length !== 1 || !reviewedEligibilityBindings ||
      !ts.isNamedImports(reviewedEligibilityBindings) ||
      reviewedEligibilityBindings.elements.some((element) => Boolean(element.propertyName)) ||
      reviewedEligibilityBindings.elements.map((element) => element.name.text).sort().join(",") !==
        [...reviewedEligibilityNames].sort().join(",")) {
    violations.add("import:job-lease-eligibility-named-only");
  }

  const directCalls = (name: string): ts.CallExpression[] => {
    const found: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
        found.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
  };
  let builderCalls: ts.CallExpression[] = [];
  let hashCalls: ts.CallExpression[] = [];
  const auditImportedUse = (node: ts.Node): void => {
    if (ts.isIdentifier(node) &&
        (node.text === "buildLeaseStaticContextInput" || node.text === "leaseStaticContextHash")) {
      if (ts.isImportSpecifier(node.parent)) return;
      if (!(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        violations.add(`${node.text === "buildLeaseStaticContextInput" ? "builder" : "hash"}:laundered-use`);
      }
    }
    ts.forEachChild(node, auditImportedUse);
  };
  auditImportedUse(file);
  const exactImportNames = new Set<string>([
    ...exactImports.map(([name]) => name),
    "LEASE_STATIC_ELIGIBILITY_VERSION",
  ]);
  const auditShadowedImports = (node: ts.Node): void => {
    const declared = ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)
      ? node.name
      : null;
    if (declared && ts.isIdentifier(declared) && exactImportNames.has(declared.text)) {
      const category = declared.text === "buildLeaseStaticContextInput"
        ? "builder"
        : declared.text === "leaseStaticContextHash"
          ? "hash"
          : `import-symbol:${declared.text}`;
      violations.add(`${category}:shadowed-import`);
    }
    ts.forEachChild(node, auditShadowedImports);
  };
  auditShadowedImports(file);

  const services = file.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "createJobLeasingService" && Boolean(statement.body));
  if (services.length !== 1) {
    violations.add("service:exact-createJobLeasingService");
    return [...violations].sort();
  }
  const service = services[0]!;
  const serviceBody = service.body!;
  const serviceInputName = service.parameters.length === 1 && ts.isIdentifier(service.parameters[0]!.name)
    ? service.parameters[0]!.name.text
    : null;
  const returnedPolls: ts.MethodDeclaration[] = [];
  const returnedAcks: ts.MethodDeclaration[] = [];
  for (const statement of serviceBody.statements) {
    if (!ts.isReturnStatement(statement) || !statement.expression ||
        !ts.isObjectLiteralExpression(statement.expression)) continue;
    for (const property of statement.expression.properties) {
      if (ts.isMethodDeclaration(property) && propertyName(property.name) === "poll" && property.body) {
        returnedPolls.push(property);
      }
      if (ts.isMethodDeclaration(property) && propertyName(property.name) === "ack" && property.body) {
        returnedAcks.push(property);
      }
    }
  }
  if (returnedPolls.length !== 1 || returnedAcks.length !== 1) {
    violations.add("poll:exact-returned-service-method");
    return [...violations].sort();
  }
  const pollMethod = returnedPolls[0]!;
  const ackMethod = returnedAcks[0]!;
  const within = (node: ts.Node, ancestor: ts.Node): boolean => {
    let current: ts.Node | undefined = node;
    while (current) {
      if (current === ancestor) return true;
      current = current.parent;
    }
    return false;
  };
  const allBuilderCalls = directCalls("buildLeaseStaticContextInput");
  const allHashCalls = directCalls("leaseStaticContextHash");
  builderCalls = allBuilderCalls.filter((call) => within(call, pollMethod));
  hashCalls = allHashCalls.filter((call) => within(call, pollMethod));
  if (allBuilderCalls.length !== 1 || builderCalls.length !== 1) {
    violations.add("builder:exactly-one-direct-call");
  }
  if (allHashCalls.length !== 1 || hashCalls.length !== 1) {
    violations.add("hash:exactly-one-direct-call");
  }
  if (allBuilderCalls.some((call) => !within(call, pollMethod)) ||
      allHashCalls.some((call) => !within(call, pollMethod))) {
    violations.add("poll:context-call-outside-poll");
  }

  const unwrap = (expression: ts.Expression | undefined): ts.Expression | undefined => {
    let current = expression;
    while (current && (
      ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) || ts.isAwaitExpression(current)
    )) current = current.expression;
    return current;
  };
  const pathOf = (expression: ts.Expression | undefined): string[] | null => {
    const current = unwrap(expression);
    if (!current) return null;
    if (ts.isIdentifier(current)) return [current.text];
    if (ts.isPropertyAccessExpression(current)) {
      const receiver = pathOf(current.expression);
      return receiver ? [...receiver, current.name.text] : null;
    }
    if (ts.isElementAccessExpression(current)) {
      const receiver = pathOf(current.expression);
      const property = unwrap(current.argumentExpression);
      return receiver && property && ts.isStringLiteral(property)
        ? [...receiver, property.text]
        : null;
    }
    return null;
  };
  const unwrappedCall = (expression: ts.Expression | undefined): ts.CallExpression | null => {
    const current = unwrap(expression);
    return current && ts.isCallExpression(current) ? current : null;
  };
  const callPath = (call: ts.CallExpression | null): string | null =>
    call ? pathOf(call.expression)?.join(".") ?? null : null;
  const criticalComputedNames = new Set([
    "HeadRestartConflict", "ackAuthorityCurrent", "authorityCurrent", "buildLeaseStaticContextInput",
    "deriveAdmissibleWorkloadTypes", "evaluateStaticLeaseEligibility", "guardPlatformAuthority",
    "isHeadRestartConflict", "leaseStaticContextHash", "lockEligibleLeaseCandidates",
    "offerLease", "snapshotLiveLeaseCapacity", "tryOffer", "upsertLeaseRejectionCertificates",
  ]);
  const dangerousObjectMethods = new Set([
    "assign", "defineProperties", "defineProperty", "setPrototypeOf",
  ]);
  const metaprogramAliases = new Set<string>();
  let metaprogramAliasAdded = true;
  while (metaprogramAliasAdded) {
    metaprogramAliasAdded = false;
    const discover = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const path = pathOf(node.initializer)?.join(".");
        if ((path && (path.startsWith("Reflect.") ||
              [...dangerousObjectMethods].some((method) =>
                path === `Object.${method}` || path.startsWith(`Object.${method}.`)))) ||
            (path && metaprogramAliases.has(path.split(".")[0]!))) {
          if (!metaprogramAliases.has(node.name.text)) {
            metaprogramAliases.add(node.name.text);
            metaprogramAliasAdded = true;
          }
        }
      }
      ts.forEachChild(node, discover);
    };
    discover(serviceBody);
  }
  const auditDynamicMetaprogramming = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      violations.add("binding:dynamic-metaprogramming");
    }
    if (ts.isIdentifier(node) && namespaceImports.has(node.text) &&
        !(ts.isNamespaceImport(node.parent))) {
      violations.add("binding:dynamic-metaprogramming");
    }
    if (ts.isIdentifier(node) && node.text === "Reflect") {
      violations.add("binding:dynamic-metaprogramming");
    }
    if (ts.isPropertyAccessExpression(node)) {
      const path = pathOf(node)?.join(".") ?? "";
      if (path.startsWith("Reflect.") || [...dangerousObjectMethods].some((method) =>
        path === `Object.${method}` || path.startsWith(`Object.${method}.`)) ||
          metaprogramAliases.has(path.split(".")[0]!)) {
        violations.add("binding:dynamic-metaprogramming");
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const argument = unwrap(node.argumentExpression);
      const property = argument && ts.isStringLiteral(argument) ? argument.text : null;
      const root = pathOf(node.expression)?.[0];
      if (criticalComputedNames.has(property ?? "") || root === "Reflect" ||
          root === "Object" || Boolean(root && namespaceImports.has(root)) ||
          Boolean(root && metaprogramAliases.has(root))) {
        violations.add("binding:dynamic-metaprogramming");
      }
    }
    if (ts.isBindingElement(node) && (Boolean(node.propertyName && ts.isStringLiteral(node.propertyName)) ||
        Boolean(node.propertyName && ts.isComputedPropertyName(node.propertyName)))) {
      violations.add("binding:dynamic-metaprogramming");
    }
    ts.forEachChild(node, auditDynamicMetaprogramming);
  };
  // Dynamic imports, namespace access, and reflection are forbidden across the
  // whole reviewed module: limiting this inventory to poll permits a helper to
  // manufacture a critical export before the canonical chain begins.
  auditDynamicMetaprogramming(file);
  const eligibilityNamespaceAliases = new Set(eligibilityNamespaces);
  let namespaceAliasAdded = true;
  while (namespaceAliasAdded) {
    namespaceAliasAdded = false;
    const discoverNamespaceAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const path = pathOf(node.initializer);
        if (path?.length === 1 && eligibilityNamespaceAliases.has(path[0]!) &&
            !eligibilityNamespaceAliases.has(node.name.text)) {
          eligibilityNamespaceAliases.add(node.name.text);
          namespaceAliasAdded = true;
        }
      }
      ts.forEachChild(node, discoverNamespaceAliases);
    };
    discoverNamespaceAliases(file);
  }
  const containsEligibilityDynamicImport = (node: ts.Node): boolean => {
    let found = false;
    const scan = (current: ts.Node): void => {
      if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword &&
          current.arguments.length === 1 && ts.isStringLiteral(unwrap(current.arguments[0])!) &&
          (unwrap(current.arguments[0]) as ts.StringLiteral).text === "./job-lease-eligibility.js") {
        found = true;
        return;
      }
      ts.forEachChild(current, scan);
    };
    scan(node);
    return found;
  };
  const auditEligibilityModuleAccess = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 && ts.isStringLiteral(unwrap(node.arguments[0])!) &&
        (unwrap(node.arguments[0]) as ts.StringLiteral).text === "./job-lease-eligibility.js") {
      violations.add("import:job-lease-eligibility-named-only");
    }
    if (ts.isIdentifier(node) && eligibilityNamespaceAliases.has(node.text) &&
        !ts.isNamespaceImport(node.parent)) {
      violations.add("import:job-lease-eligibility-named-only");
    }
    if (ts.isCallExpression(node) && pathOf(node.expression)?.join(".")?.startsWith("Reflect.")) {
      const text = node.getText(file);
      if (text.includes("eligibility") || reviewedEligibilityNames.some((name) => text.includes(name))) {
        violations.add("import:job-lease-eligibility-named-only");
      }
    }
    ts.forEachChild(node, auditEligibilityModuleAccess);
  };
  auditEligibilityModuleAccess(file);
  const auditAlternateContextSymbols = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) &&
        ["buildLeaseStaticContextInput", "leaseStaticContextHash"].includes(node.name.text)) {
      violations.add(node.name.text === "buildLeaseStaticContextInput"
        ? "builder:laundered-use"
        : "hash:laundered-use");
    }
    if (ts.isElementAccessExpression(node)) {
      const argument = unwrap(node.argumentExpression);
      const name = argument && ts.isStringLiteral(argument) ? argument.text : null;
      const receiverRoot = pathOf(node.expression)?.[0];
      const alternateModule = Boolean(receiverRoot && eligibilityNamespaceAliases.has(receiverRoot)) ||
        containsEligibilityDynamicImport(node.expression);
      if (name === "buildLeaseStaticContextInput" || alternateModule && name === null) {
        violations.add("builder:laundered-use");
      }
      if (name === "leaseStaticContextHash" || alternateModule && name === null) {
        violations.add("hash:laundered-use");
      }
    }
    ts.forEachChild(node, auditAlternateContextSymbols);
  };
  auditAlternateContextSymbols(file);
  const isAwaitedCall = (call: ts.CallExpression): boolean => {
    let current: ts.Node = call;
    while (current.parent && (
      ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)
    ) && current.parent.expression === current) current = current.parent;
    return ts.isAwaitExpression(current.parent) && current.parent.expression === current;
  };
  const closedObjectProperties = (expression: ts.Expression | undefined): Map<string, ts.Expression> | null => {
    const current = unwrap(expression);
    if (!current || !ts.isObjectLiteralExpression(current)) return null;
    const properties = new Map<string, ts.Expression>();
    for (const property of current.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        if (properties.has(property.name.text)) return null;
        properties.set(property.name.text, property.name);
        continue;
      }
      if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return null;
      const name = propertyName(property.name);
      if (!name || properties.has(name)) return null;
      properties.set(name, property.initializer);
    }
    return properties;
  };
  const calledName = (expression: ts.Expression | undefined): string | null => {
    const call = unwrappedCall(expression);
    if (!call) return null;
    if (ts.isIdentifier(call.expression)) return call.expression.text;
    return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;
  };
  type DirectBinding = {
    declaration: ts.VariableDeclaration;
    statement: ts.VariableStatement;
    initializer: ts.Expression;
  };
  const directBinding = (body: ts.Block, name: string): DirectBinding | null => {
    const matches: DirectBinding[] = [];
    for (const statement of body.statements) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
          matches.push({ declaration, statement, initializer: declaration.initializer });
        }
      }
    }
    return matches.length === 1 ? matches[0]! : null;
  };
  const bindingForCall = (call: ts.CallExpression | undefined): DirectBinding | null => {
    if (!call || !ts.isVariableDeclaration(call.parent) || call.parent.initializer !== call ||
        !ts.isIdentifier(call.parent.name)) return null;
    const list = call.parent.parent;
    const statement = list.parent;
    if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(statement) ||
        !(list.flags & ts.NodeFlags.Const)) return null;
    return { declaration: call.parent, statement, initializer: call };
  };
  const directBodyBindingForCall = (body: ts.Block, call: ts.CallExpression): DirectBinding | null => {
    let current: ts.Node = call;
    while (current.parent && (
      ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) || ts.isSatisfiesExpression(current.parent)
    ) && current.parent.expression === current) current = current.parent;
    if (!ts.isVariableDeclaration(current.parent) || current.parent.initializer !== current ||
        !ts.isIdentifier(current.parent.name)) return null;
    const list = current.parent.parent;
    const statement = list.parent;
    if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(statement) ||
        !(list.flags & ts.NodeFlags.Const) || statement.parent !== body) return null;
    return { declaration: current.parent, statement, initializer: current.parent.initializer! };
  };

  const criticalHelperNames = new Set([
    "ackAuthorityCurrent", "authorityCurrent", "buildJobEnvelope", "deriveAdmissibleWorkloadTypes", "minCapacity",
    "normalizedProviderDemand", "normalizedRequirements",
  ]);
  const criticalDeclarationNames = new Map<string, ts.Identifier[]>();
  const recordCriticalBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      if (criticalHelperNames.has(name.text)) {
        const declarations = criticalDeclarationNames.get(name.text) ?? [];
        declarations.push(name);
        criticalDeclarationNames.set(name.text, declarations);
      }
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) recordCriticalBindingName(element.name);
    }
  };
  const collectCriticalDeclarations = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
        ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      if (node.name) recordCriticalBindingName(node.name);
    }
    ts.forEachChild(node, collectCriticalDeclarations);
  };
  collectCriticalDeclarations(file);
  const topLevelCriticalFunction = (name: string): ts.FunctionDeclaration | null => {
    const declarations = file.statements.filter((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name && Boolean(statement.body));
    return declarations.length === 1 ? declarations[0]! : null;
  };
  const criticalRootBindings = new Map<string, ts.Node | null>([
    ["ackAuthorityCurrent", topLevelCriticalFunction("ackAuthorityCurrent")],
    ["authorityCurrent", topLevelCriticalFunction("authorityCurrent")],
    ["buildJobEnvelope", topLevelCriticalFunction("buildJobEnvelope")],
    ["minCapacity", topLevelCriticalFunction("minCapacity")],
    ["normalizedProviderDemand", topLevelCriticalFunction("normalizedProviderDemand")],
    ["normalizedRequirements", topLevelCriticalFunction("normalizedRequirements")],
    ["deriveAdmissibleWorkloadTypes", directBinding(serviceBody, "deriveAdmissibleWorkloadTypes")?.declaration ?? null],
  ]);
  let criticalHelperBindingInvalid = false;
  for (const [name, root] of criticalRootBindings) {
    if (!root || (criticalDeclarationNames.get(name)?.length ?? 0) !== 1 || directCalls(name).length !== 1) {
      criticalHelperBindingInvalid = true;
    }
  }
  const auditCriticalHelperUses = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && criticalHelperNames.has(node.text)) {
      const declarations = criticalDeclarationNames.get(node.text) ?? [];
      const isDeclaration = declarations.includes(node);
      const isDirectCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!isDeclaration && !isDirectCall) criticalHelperBindingInvalid = true;
    }
    ts.forEachChild(node, auditCriticalHelperUses);
  };
  auditCriticalHelperUses(file);
  if (criticalHelperBindingInvalid) violations.add("binding:trusted-critical-helper-symbols");

  const builderCall = builderCalls[0];
  const hashCall = hashCalls[0];
  if (!builderCall || !hashCall) return [...violations].sort();
  const builderBinding = bindingForCall(builderCall);
  const hashBinding = bindingForCall(hashCall);
  if (!builderBinding) violations.add("builder:direct-const-binding");
  if (!hashBinding) violations.add("hash:direct-const-binding");

  const headConflictClasses: ts.ClassDeclaration[] = [];
  const classifierDeclarations: ts.VariableDeclaration[] = [];
  const collectRetrySentinelDeclarations = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === "HeadRestartConflict") {
      headConflictClasses.push(node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === "isHeadRestartConflict") classifierDeclarations.push(node);
    ts.forEachChild(node, collectRetrySentinelDeclarations);
  };
  collectRetrySentinelDeclarations(file);
  const headConflictClass = headConflictClasses.length === 1 ? headConflictClasses[0]! : null;
  const classifierBinding = directBinding(serviceBody, "isHeadRestartConflict");
  const classifierExpression = classifierBinding ? unwrap(classifierBinding.initializer) : null;
  const classifier = classifierExpression &&
      (ts.isArrowFunction(classifierExpression) || ts.isFunctionExpression(classifierExpression))
    ? classifierExpression
    : null;
  const classifierParameter = classifier?.parameters.length === 1 &&
      ts.isIdentifier(classifier.parameters[0]!.name)
    ? classifier.parameters[0]!.name.text
    : null;
  const classifierBody = classifier && !ts.isBlock(classifier.body) ? unwrap(classifier.body) : null;
  let classifierWritten = false;
  let retrySentinelEscaped = false;
  const auditClassifierWrites = (node: ts.Node): void => {
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        !ts.isBlock(node.body) && node !== classifier &&
        node.body.getText(file).match(/\b(?:HeadRestartConflict|isHeadRestartConflict)\b/)) {
      retrySentinelEscaped = true;
    }
    if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const leftRoot = pathOf(node.left)?.[0];
      const rightRoot = pathOf(node.right)?.[0];
      if (leftRoot === "isHeadRestartConflict") classifierWritten = true;
      if (["HeadRestartConflict", "isHeadRestartConflict"].includes(leftRoot ?? "") ||
          ["HeadRestartConflict", "isHeadRestartConflict"].includes(rightRoot ?? "")) {
        retrySentinelEscaped = true;
      }
    }
    if (ts.isClassDeclaration(node) && node.name?.text === "HeadRestartConflict" &&
        node.members.some((member) => member.name && propertyName(member.name) === "__@hasInstance")) {
      retrySentinelEscaped = true;
    }
    if (ts.isPropertyAccessExpression(node) && pathOf(node)?.join(".") === "Symbol.hasInstance") {
      retrySentinelEscaped = true;
    }
    if (ts.isElementAccessExpression(node) && pathOf(node.expression)?.join(".") === "Symbol" &&
        ts.isStringLiteral(unwrap(node.argumentExpression)!) &&
        (unwrap(node.argumentExpression) as ts.StringLiteral).text === "hasInstance") {
      retrySentinelEscaped = true;
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) &&
        ["HeadRestartConflict", "isHeadRestartConflict"].includes(pathOf(node.initializer)?.join(".") ?? "") &&
        !["HeadRestartConflict", "isHeadRestartConflict"].includes(node.name.text)) {
      retrySentinelEscaped = true;
    }
    if ((ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) ||
        ts.isReturnStatement(node) || ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        node !== classifierBinding?.initializer) {
      const sentinelIdentifiers: string[] = [];
      const scan = (current: ts.Node): void => {
        if (ts.isFunctionLike(current) && current !== node) return;
        if (ts.isIdentifier(current) &&
            ["HeadRestartConflict", "isHeadRestartConflict"].includes(current.text)) {
          sentinelIdentifiers.push(current.text);
        }
        ts.forEachChild(current, scan);
      };
      scan(node);
      const exactClassifierInstanceof = classifierBody && within(node, classifierBody);
      const exactRestartConstruction = ts.isNewExpression(node) &&
        pathOf(node.expression)?.join(".") === "HeadRestartConflict";
      const exactCatchClassification = ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) && node.expression.text === "isHeadRestartConflict";
      if (sentinelIdentifiers.length > 0 && !exactClassifierInstanceof &&
          !exactRestartConstruction && !exactCatchClassification) retrySentinelEscaped = true;
    }
    ts.forEachChild(node, auditClassifierWrites);
  };
  auditClassifierWrites(file);
  const exactClassifier = Boolean(headConflictClass && headConflictClass.parent === serviceBody &&
    headConflictClass.heritageClauses?.length === 1 &&
    headConflictClass.heritageClauses[0]!.token === ts.SyntaxKind.ExtendsKeyword &&
    headConflictClass.heritageClauses[0]!.types.length === 1 &&
    pathOf(headConflictClass.heritageClauses[0]!.types[0]!.expression)?.join(".") === "Error" &&
    headConflictClass.members.length === 0 && classifierDeclarations.length === 1 && !classifierWritten &&
    !retrySentinelEscaped &&
    classifierBinding?.statement.parent === serviceBody && classifierParameter && classifierBody &&
    ts.isBinaryExpression(classifierBody) &&
    classifierBody.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    pathOf(classifierBody.left)?.join(".") === classifierParameter &&
    pathOf(classifierBody.right)?.join(".") === "HeadRestartConflict");
  if (!exactClassifier) violations.add("poll:trusted-head-conflict-sentinel");

  const maxHeartbeatBinding = directBinding(serviceBody, "maxHeartbeatAgeMs");
  const maxHeartbeatCall = maxHeartbeatBinding ? unwrappedCall(maxHeartbeatBinding.initializer) : null;
  const maxHeartbeatFallback = maxHeartbeatCall?.arguments.length === 2
    ? unwrap(maxHeartbeatCall.arguments[1])
    : null;
  const exactConfiguredMaxHeartbeat = Boolean(maxHeartbeatBinding?.statement.parent === serviceBody &&
    maxHeartbeatCall && callPath(maxHeartbeatCall) === "Math.max" &&
    ts.isNumericLiteral(unwrap(maxHeartbeatCall.arguments[0])!) &&
    Number((unwrap(maxHeartbeatCall.arguments[0]) as ts.NumericLiteral).text.replaceAll("_", "")) === 1000 &&
    maxHeartbeatFallback && ts.isBinaryExpression(maxHeartbeatFallback) &&
    maxHeartbeatFallback.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    pathOf(maxHeartbeatFallback.left)?.join(".") === `${serviceInputName}.maxHeartbeatAgeMs` &&
    ts.isNumericLiteral(unwrap(maxHeartbeatFallback.right)!) &&
    Number((unwrap(maxHeartbeatFallback.right) as ts.NumericLiteral).text.replaceAll("_", "")) === 300000);
  if (!exactConfiguredMaxHeartbeat) violations.add("builder:trusted-service-authority-guard");
  const compactServiceExpression = (expression: ts.Expression | undefined): string =>
    expression?.getText(file).replace(/\s+/g, "") ?? "";
  const ackTimeoutBinding = directBinding(serviceBody, "ackTimeoutMs");
  const leaseDurationBinding = directBinding(serviceBody, "leaseDurationMs");
  const exactConfiguredLeaseTiming = Boolean(ackTimeoutBinding && leaseDurationBinding &&
    compactServiceExpression(ackTimeoutBinding.initializer) ===
      `Math.max(1000,${serviceInputName}.ackTimeoutMs??15000)` &&
    compactServiceExpression(leaseDurationBinding.initializer) ===
      `Math.max(ackTimeoutMs+1000,${serviceInputName}.leaseDurationMs??300000)`);
  if (!exactConfiguredLeaseTiming) violations.add("candidate:result-consumed-by-canonical-chain");

  const authorityCurrentDeclaration = topLevelCriticalFunction("authorityCurrent");
  const ackAuthorityCurrentDeclaration = topLevelCriticalFunction("ackAuthorityCurrent");
  const requiredAuthorityCurrentPredicates = [
    "worker.id===auth.workerId",
    "worker.executionTargetId===auth.targetId",
    "worker.organizationId===auth.organizationId",
    'worker.scope!=="platform"',
    "worker.deviceGeneration===auth.targetGeneration",
    "worker.deviceThumbprint===auth.deviceThumbprint",
    "worker.devicePublicKey===auth.publicKey",
    "worker.profileHash===auth.profileHash",
    "worker.revokedAt===null",
    'worker.status==="enrolled"||worker.status==="active"',
    "authority.ownerMembershipActive",
    "target.id===auth.targetId",
    'target.status==="active"',
    "target.deviceGeneration===auth.targetGeneration",
    "request.workerId===auth.workerId",
    "request.targetId===auth.targetId",
    "request.deviceGeneration===auth.targetGeneration",
    "oldestHeartbeat!==null",
    "input.databaseNow.getTime()-oldestHeartbeat<=input.maxHeartbeatAgeMs",
  ];
  const compact = (node: ts.Node | undefined): string => node?.getText(file).replace(/\s+/g, "") ?? "";
  const flattenAnd = (expression: ts.Expression): ts.Expression[] => {
    const current = unwrap(expression)!;
    return ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? [...flattenAnd(current.left), ...flattenAnd(current.right)]
      : [current];
  };
  const oldestHeartbeatDeclaration = authorityCurrentDeclaration?.body?.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "oldestHeartbeat");
  const expectedOldestHeartbeat = 'target.scope==="platform"?input.platformPhysicalHeartbeatAt?.getTime()??null:!worker.lastSeenAt||!target.lastSeenAt?null:Math.min(worker.lastSeenAt.getTime(),target.lastSeenAt.getTime())';
  const soleConstDeclaration = (statement: ts.Statement | undefined): ts.VariableDeclaration | null => {
    if (!statement || !ts.isVariableStatement(statement) ||
        !(statement.declarationList.flags & ts.NodeFlags.Const) ||
        statement.declarationList.declarations.length !== 1) return null;
    return statement.declarationList.declarations[0]!;
  };
  const exactInputBinding = (
    statement: ts.Statement | undefined,
    names: readonly string[],
  ): boolean => {
    const declaration = soleConstDeclaration(statement);
    if (!declaration || !ts.isObjectBindingPattern(declaration.name) ||
        pathOf(declaration.initializer)?.join(".") !== "input" ||
        declaration.name.elements.length !== names.length) return false;
    return declaration.name.elements.every((element, index) =>
      !element.dotDotDotToken && !element.propertyName && !element.initializer &&
      ts.isIdentifier(element.name) && element.name.text === names[index]);
  };
  const exactPathBinding = (
    statement: ts.Statement | undefined,
    name: string,
    initializerPath: string,
  ): boolean => {
    const declaration = soleConstDeclaration(statement);
    return Boolean(declaration && ts.isIdentifier(declaration.name) &&
      declaration.name.text === name &&
      pathOf(declaration.initializer)?.join(".") === initializerPath);
  };
  const exactAuthorityHelperBody = (
    declaration: ts.FunctionDeclaration | null,
    inputNames: readonly string[],
  ): boolean => {
    if (!declaration?.body || declaration.body.statements.length !== 5) return false;
    const statements = [...declaration.body.statements];
    const directStatements = new Set<ts.Statement>(statements);
    const returns: ts.ReturnStatement[] = [];
    let nestedOrAdditionalStatement = false;
    const auditStatements = (node: ts.Node): void => {
      if (ts.isReturnStatement(node)) returns.push(node);
      if (ts.isStatement(node) && !directStatements.has(node)) nestedOrAdditionalStatement = true;
      ts.forEachChild(node, auditStatements);
    };
    for (const statement of statements) auditStatements(statement);
    const oldestHeartbeat = soleConstDeclaration(statements[3]);
    return !nestedOrAdditionalStatement &&
      exactInputBinding(statements[0], inputNames) &&
      exactPathBinding(statements[1], "worker", "authority.worker") &&
      exactPathBinding(statements[2], "target", "authority.target") &&
      Boolean(oldestHeartbeat && ts.isIdentifier(oldestHeartbeat.name) &&
        oldestHeartbeat.name.text === "oldestHeartbeat" &&
        compact(oldestHeartbeat.initializer) === expectedOldestHeartbeat) &&
      ts.isReturnStatement(statements[4]) && Boolean(statements[4].expression) &&
      returns.length === 1 && returns[0] === statements[4];
  };
  const exactPollAuthorityHelperBody = exactAuthorityHelperBody(
    authorityCurrentDeclaration,
    ["auth", "authority", "request"],
  );
  const exactAckAuthorityHelperBody = exactAuthorityHelperBody(
    ackAuthorityCurrentDeclaration,
    ["auth", "authority"],
  );
  let sharedActiveStatusSymbol = false;
  const auditSharedActiveStatusSymbol = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "ACTIVE_WORKER_STATUSES") {
      sharedActiveStatusSymbol = true;
    }
    ts.forEachChild(node, auditSharedActiveStatusSymbol);
  };
  auditSharedActiveStatusSymbol(file);
  const exactClosedStatusPredicate = (expression: ts.Expression, requiredPath: string): boolean => {
    const current = unwrap(expression);
    if (!current || !ts.isBinaryExpression(current) ||
        current.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return false;
    const exactStatus = (candidate: ts.Expression, status: "enrolled" | "active"): boolean => {
      const comparison = unwrap(candidate);
      if (!comparison || !ts.isBinaryExpression(comparison) ||
          comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
      const right = unwrap(comparison.right);
      return pathOf(comparison.left)?.join(".") === requiredPath &&
        Boolean(right && ts.isStringLiteral(right) && right.text === status);
    };
    return exactStatus(current.left, "enrolled") && exactStatus(current.right, "active");
  };
  const returnedConjuncts = (declaration: ts.FunctionDeclaration | null): ts.Expression[] => {
    const returns = declaration?.body?.statements.filter((statement): statement is ts.ReturnStatement =>
      ts.isReturnStatement(statement) && Boolean(statement.expression)) ?? [];
    return returns.length === 1 ? flattenAnd(returns[0]!.expression!) : [];
  };
  const pollAuthorityConjuncts = returnedConjuncts(authorityCurrentDeclaration);
  const ackAuthorityConjuncts = returnedConjuncts(ackAuthorityCurrentDeclaration);
  const statusConjuncts = (conjuncts: ts.Expression[]): ts.Expression[] => conjuncts.filter((expression) => {
    const text = compact(expression);
    return text.includes("worker.status") || text.includes("ACTIVE_WORKER_STATUSES");
  });
  const pollStatusConjuncts = statusConjuncts(pollAuthorityConjuncts);
  const ackStatusConjuncts = statusConjuncts(ackAuthorityConjuncts);
  const exactPollInlineStatus = pollStatusConjuncts.length === 1 &&
    exactClosedStatusPredicate(pollStatusConjuncts[0]!, "worker.status");
  const exactAckInlineStatus = ackStatusConjuncts.length === 1 &&
    exactClosedStatusPredicate(ackStatusConjuncts[0]!, "worker.status");
  const nonStatusPredicates = (conjuncts: ts.Expression[]): string[] => conjuncts
    .filter((expression) => !statusConjuncts(conjuncts).includes(expression))
    .map((expression) => compact(expression))
    .sort();
  const requiredPollNonStatusPredicates = requiredAuthorityCurrentPredicates
    .filter((predicate) => !predicate.includes("worker.status"))
    .sort();
  const requiredAckNonStatusPredicates = [
    "input.workerId===auth.workerId",
    "worker.id===auth.workerId",
    "worker.executionTargetId===auth.targetId",
    "worker.organizationId===auth.organizationId",
    'worker.scope!=="platform"',
    "worker.deviceGeneration===auth.targetGeneration",
    "worker.deviceThumbprint===auth.deviceThumbprint",
    "worker.devicePublicKey===auth.publicKey",
    "worker.profileHash===auth.profileHash",
    "worker.revokedAt===null",
    "authority.ownerMembershipActive",
    "target.id===auth.targetId",
    'target.status==="active"',
    "target.deviceGeneration===auth.targetGeneration",
    "oldestHeartbeat!==null",
    "input.databaseNow.getTime()-oldestHeartbeat<=input.maxHeartbeatAgeMs",
  ].sort();
  const helperIsImpure = (declaration: ts.FunctionDeclaration | null): boolean => {
    let impure = false;
    const audit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) impure = true;
      if ((ts.isPrefixUnaryExpression(node) &&
            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) ||
          ts.isPostfixUnaryExpression(node) || ts.isDeleteExpression(node) ||
          ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isNewExpression(node)) {
        impure = true;
      }
      if (ts.isCallExpression(node) && callPath(node) !== "input.databaseNow.getTime" &&
          callPath(node) !== "worker.lastSeenAt.getTime" && callPath(node) !== "target.lastSeenAt.getTime" &&
          callPath(node) !== "input.platformPhysicalHeartbeatAt.getTime" && callPath(node) !== "Math.min" &&
          callPath(node) !== "ACTIVE_WORKER_STATUSES.has") {
        impure = true;
      }
      ts.forEachChild(node, audit);
    };
    if (declaration?.body) audit(declaration.body);
    return impure;
  };
  const oldestHeartbeatIn = (declaration: ts.FunctionDeclaration | null): ts.VariableDeclaration | undefined =>
    declaration?.body?.statements.filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "oldestHeartbeat");
  const exactAckAuthorityHelper = Boolean(ackAuthorityCurrentDeclaration &&
    ackAuthorityCurrentDeclaration.parameters.length === 1 &&
    ts.isIdentifier(ackAuthorityCurrentDeclaration.parameters[0]!.name) &&
    ackAuthorityCurrentDeclaration.parameters[0]!.name.text === "input" &&
    exactAckAuthorityHelperBody &&
    !helperIsImpure(ackAuthorityCurrentDeclaration) &&
    nonStatusPredicates(ackAuthorityConjuncts).join("|") === requiredAckNonStatusPredicates.join("|") &&
    compact(oldestHeartbeatIn(ackAuthorityCurrentDeclaration)?.initializer) === expectedOldestHeartbeat &&
    directCalls("ackAuthorityCurrent").length === 1);
  if (!authorityCurrentDeclaration || authorityCurrentDeclaration.parameters.length !== 1 ||
      !ts.isIdentifier(authorityCurrentDeclaration.parameters[0]!.name) ||
      authorityCurrentDeclaration.parameters[0]!.name.text !== "input" ||
      helperIsImpure(authorityCurrentDeclaration) ||
      nonStatusPredicates(pollAuthorityConjuncts).join("|") !== requiredPollNonStatusPredicates.join("|") ||
      compact(oldestHeartbeatDeclaration?.initializer) !== expectedOldestHeartbeat ||
      directCalls("authorityCurrent").length !== 1) {
    violations.add("builder:trusted-non-platform-authority-current");
  }
  if (sharedActiveStatusSymbol || !exactPollAuthorityHelperBody ||
      !exactPollInlineStatus || !exactAckInlineStatus ||
      !exactAckAuthorityHelper) {
    violations.add("builder:trusted-service-authority-guard");
  }

  const normalizedRequirementsDeclaration = topLevelCriticalFunction("normalizedRequirements");
  const normalizedRequirementsStatements = normalizedRequirementsDeclaration?.body?.statements ?? [];
  const normalizedDeclaration = normalizedRequirementsStatements[0] &&
      ts.isVariableStatement(normalizedRequirementsStatements[0]) &&
      normalizedRequirementsStatements[0].declarationList.declarations.length === 1
    ? normalizedRequirementsStatements[0].declarationList.declarations[0]!
    : null;
  const normalizedFactsCall = normalizedDeclaration ? unwrappedCall(normalizedDeclaration.initializer) : null;
  const normalizedFactsInput = normalizedFactsCall?.arguments.length === 1
    ? closedObjectProperties(normalizedFactsCall.arguments[0])
    : null;
  const normalizedReturn = normalizedRequirementsStatements[1] &&
      ts.isReturnStatement(normalizedRequirementsStatements[1])
    ? normalizedRequirementsStatements[1]
    : null;
  const exactNormalizedRequirements = Boolean(normalizedRequirementsDeclaration &&
    normalizedRequirementsDeclaration.parameters.length === 2 &&
    normalizedRequirementsDeclaration.parameters.every((parameter) => ts.isIdentifier(parameter.name)) &&
    normalizedRequirementsDeclaration.parameters.map((parameter) =>
      (parameter.name as ts.Identifier).text).join(",") === "job,target" &&
    normalizedRequirementsStatements.length === 2 && normalizedDeclaration &&
    ts.isIdentifier(normalizedDeclaration.name) && normalizedDeclaration.name.text === "normalized" &&
    normalizedFactsCall && ts.isIdentifier(normalizedFactsCall.expression) &&
    normalizedFactsCall.expression.text === "normalizeSubmittedJobPlacementFacts" &&
    directCalls("normalizeSubmittedJobPlacementFacts").length === 1 &&
    normalizedFactsInput && [...normalizedFactsInput.keys()].sort().join(",") ===
      "credentialBinding,inputHash,placementRequest,policyHash,requirements,resolvedTarget,rollout,sourceKind" &&
    pathOf(normalizedFactsInput.get("sourceKind"))?.join(".") === "job.sourceKind" &&
    pathOf(normalizedFactsInput.get("inputHash"))?.join(".") === "job.inputHash" &&
    pathOf(normalizedFactsInput.get("policyHash"))?.join(".") === "job.policyHash" &&
    pathOf(normalizedFactsInput.get("requirements"))?.join(".") === "job.requirements" &&
    pathOf(normalizedFactsInput.get("placementRequest"))?.join(".") === "job.placementRequest" &&
    compact(normalizedFactsInput.get("rollout")) ===
      '{enabled:true,mode:"active",reason:"stored_placement"}' &&
    compact(normalizedFactsInput.get("credentialBinding")) === "inferredCredentialBinding(target)" &&
    pathOf(normalizedFactsInput.get("resolvedTarget"))?.join(".") === "target" &&
    compact(normalizedReturn?.expression) ===
      "normalized.success&&normalized.active?normalized:null");
  if (!exactNormalizedRequirements) violations.add("binding:trusted-critical-helper-symbols");

  let tenantCallback: ts.ArrowFunction | ts.FunctionExpression | null = null;
  let runInTenantCall: ts.CallExpression | null = null;
  let ancestor: ts.Node | undefined = builderCall;
  while (ancestor && ancestor !== pollMethod) {
    if ((ts.isArrowFunction(ancestor) || ts.isFunctionExpression(ancestor)) &&
        ts.isCallExpression(ancestor.parent) && ancestor.parent.arguments[2] === ancestor &&
        ts.isIdentifier(ancestor.parent.expression) && ancestor.parent.expression.text === "runInTenant") {
      tenantCallback = ancestor;
      runInTenantCall = ancestor.parent;
      break;
    }
    ancestor = ancestor.parent;
  }
  if (!tenantCallback || !runInTenantCall || !ts.isBlock(tenantCallback.body)) {
    violations.add("builder:inside-direct-tenant-attempt");
    return [...violations].sort();
  }
  const tenantBody = tenantCallback.body;
  const pollInputName = pollMethod.parameters.length === 1 && ts.isIdentifier(pollMethod.parameters[0]!.name)
    ? pollMethod.parameters[0]!.name.text
    : null;
  const reposName = tenantCallback.parameters.length === 1 && ts.isIdentifier(tenantCallback.parameters[0]!.name)
    ? tenantCallback.parameters[0]!.name.text
    : null;
  if (!pollInputName) violations.add("poll:one-identifier-input");
  if (!reposName) violations.add("poll:one-identifier-tenant-repositories");
  if (!serviceInputName || runInTenantCall.arguments.length !== 3 ||
      pathOf(runInTenantCall.arguments[0])?.join(".") !== `${serviceInputName}.appDb`) {
    violations.add("poll:tenant-from-service-app-db");
  }
  if (!pollInputName || runInTenantCall.arguments.length !== 3 ||
      pathOf(runInTenantCall.arguments[1])?.join(".") !== `${pollInputName}.auth.organizationId`) {
    violations.add("poll:tenant-from-auth-organization");
  }
  if (!builderBinding || builderBinding.statement.parent !== tenantBody) {
    violations.add("builder:unconditional-top-level-attempt-call");
  }
  if (!hashBinding || hashBinding.statement.parent !== tenantBody) {
    violations.add("hash:unconditional-top-level-attempt-call");
  }
  const tenantCalls = directCalls("runInTenant").filter((call) => within(call, pollMethod));
  if (tenantCalls.length !== 1 || tenantCalls[0] !== runInTenantCall) {
    violations.add("poll:one-tenant-transaction-per-restart-site");
  }
  let restartLoop: ts.IterationStatement | null = null;
  ancestor = runInTenantCall.parent;
  while (ancestor && ancestor !== pollMethod) {
    if (ts.isForStatement(ancestor) || ts.isForOfStatement(ancestor) ||
        ts.isWhileStatement(ancestor) || ts.isDoStatement(ancestor)) {
      restartLoop = ancestor;
      break;
    }
    ancestor = ancestor.parent;
  }
  if (!restartLoop) {
    violations.add("poll:tenant-transaction-inside-restart-loop");
  } else {
    const loop = restartLoop;
    let validLoop = false;
    let restartLoopName: string | null = null;
    let restartAttemptLimit: number | null = null;
    if (ts.isForStatement(loop) && loop.initializer && ts.isVariableDeclarationList(loop.initializer) &&
        loop.initializer.declarations.length === 1) {
      const declaration = loop.initializer.declarations[0]!;
      const loopName = ts.isIdentifier(declaration.name) ? declaration.name.text : null;
      const initial = unwrap(declaration.initializer);
      const condition = loop.condition;
      const incrementor = loop.incrementor;
      const bound = condition && ts.isBinaryExpression(condition) &&
        condition.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
        pathOf(condition.left)?.join(".") === loopName &&
        ts.isNumericLiteral(unwrap(condition.right)!)
        ? Number((unwrap(condition.right) as ts.NumericLiteral).text)
        : null;
      const incrementsOnce = Boolean(loopName && incrementor && (
        (ts.isPostfixUnaryExpression(incrementor) &&
          incrementor.operator === ts.SyntaxKind.PlusPlusToken &&
          pathOf(incrementor.operand)?.join(".") === loopName) ||
        (ts.isBinaryExpression(incrementor) && incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
          pathOf(incrementor.left)?.join(".") === loopName &&
          ts.isNumericLiteral(unwrap(incrementor.right)!) && Number((unwrap(incrementor.right) as ts.NumericLiteral).text) === 1)
      ));
      validLoop = Boolean(loopName && initial && ts.isNumericLiteral(initial) && Number(initial.text) === 0 &&
        bound === 3 && incrementsOnce);
      if (validLoop) {
        restartLoopName = loopName;
        restartAttemptLimit = bound;
      }
      if (loopName) {
        let illegalCounterWrite = false;
        const auditCounterWrites = (node: ts.Node): void => {
          if (ts.isVariableDeclaration(node) && node !== declaration &&
              ts.isIdentifier(node.name) && node.name.text === loopName) illegalCounterWrite = true;
          if (ts.isBinaryExpression(node) &&
              node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
              node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
              pathOf(node.left)?.join(".") === loopName && node !== incrementor) {
            illegalCounterWrite = true;
          }
          if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
              (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
              pathOf(node.operand)?.join(".") === loopName && node !== incrementor) {
            illegalCounterWrite = true;
          }
          ts.forEachChild(node, auditCounterWrites);
        };
        auditCounterWrites(pollMethod);
        if (illegalCounterWrite) violations.add("poll:immutable-restart-counter");
      }
    }
    if (!validLoop) violations.add("poll:bounded-two-to-three-restart-attempts");

    let retryTry: ts.TryStatement | null = null;
    let current: ts.Node | undefined = runInTenantCall.parent;
    while (current && current !== loop) {
      if (ts.isTryStatement(current) && within(runInTenantCall, current.tryBlock)) {
        retryTry = current;
        break;
      }
      current = current.parent;
    }
    const directThrowExpression = (statement: ts.Statement | undefined): ts.Expression | null => {
      if (!statement) return null;
      if (ts.isThrowStatement(statement)) return statement.expression;
      if (ts.isBlock(statement) && statement.statements.length === 1 &&
          ts.isThrowStatement(statement.statements[0]!)) return statement.statements[0]!.expression;
      return null;
    };
    const internalUnavailableThrow = (statement: ts.Statement | undefined): boolean => {
      const expression = unwrap(directThrowExpression(statement) ?? undefined);
      if (!expression || (!ts.isNewExpression(expression) && !ts.isCallExpression(expression))) return false;
      if (!ts.isIdentifier(expression.expression) ||
          !["Error", "JobLeasingError"].includes(expression.expression.text) ||
          expression.arguments?.length !== 1) return false;
      const argument = unwrap(expression.arguments[0]);
      return Boolean(argument && ts.isStringLiteral(argument) && argument.text === "internal_unavailable");
    };
    const caughtErrorThrow = (statement: ts.Statement | undefined, errorName: string): boolean =>
      pathOf(directThrowExpression(statement) ?? undefined)?.join(".") === errorName;
    const headConflictOnlyCondition = (expression: ts.Expression, errorName: string): boolean => {
      const current = unwrap(expression);
      if (!current || !ts.isPrefixUnaryExpression(current) ||
          current.operator !== ts.SyntaxKind.ExclamationToken) return false;
      const call = unwrappedCall(current.operand);
      return Boolean(call && ts.isIdentifier(call.expression) &&
        call.expression.text === "isHeadRestartConflict" && call.arguments.length === 1 &&
        pathOf(call.arguments[0])?.join(".") === errorName);
    };
    const exhaustionCondition = (expression: ts.Expression): boolean => {
      const current = unwrap(expression);
      if (!current || !restartLoopName || restartAttemptLimit === null ||
          !ts.isBinaryExpression(current) ||
          current.operatorToken.kind !== ts.SyntaxKind.GreaterThanEqualsToken ||
          pathOf(current.left)?.join(".") !== restartLoopName) return false;
      const right = unwrap(current.right);
      return Boolean(right && ts.isNumericLiteral(right) &&
        Number(right.text) === restartAttemptLimit - 1);
    };
    const catchClause = retryTry?.catchClause;
    const catchName = catchClause?.variableDeclaration && ts.isIdentifier(catchClause.variableDeclaration.name)
      ? catchClause.variableDeclaration.name.text
      : null;
    const catchStatements = catchClause?.block.statements ?? [];
    const classifier = catchStatements[0];
    const exhaustion = catchStatements[1];
    const continueStatement = catchStatements[2];
    const exactHeadConflictRetry = Boolean(catchName && catchStatements.length === 3 &&
      classifier && ts.isIfStatement(classifier) && !classifier.elseStatement &&
      headConflictOnlyCondition(classifier.expression, catchName) &&
      caughtErrorThrow(classifier.thenStatement, catchName) &&
      exhaustion && ts.isIfStatement(exhaustion) && !exhaustion.elseStatement &&
      exhaustionCondition(exhaustion.expression) && internalUnavailableThrow(exhaustion.thenStatement) &&
      continueStatement && ts.isContinueStatement(continueStatement));
    const successReturns = retryTry?.tryBlock.statements.some((statement) =>
      ts.isReturnStatement(statement) && statement.getStart(file) <= runInTenantCall!.getStart(file) &&
      runInTenantCall!.getEnd() <= statement.getEnd());
    const statementsAfterLoop = pollMethod.body!.statements.filter((statement) =>
      statement.getStart(file) > loop.getEnd());
    const exactExhaustion = statementsAfterLoop.length === 1 &&
      internalUnavailableThrow(statementsAfterLoop[0]);
    if (!exactHeadConflictRetry || !exactExhaustion) {
      violations.add("poll:head-conflict-only-restart");
    }
    if (!isAwaitedCall(runInTenantCall) || !retryTry || !exactHeadConflictRetry ||
        !exactExhaustion || !successReturns) {
      violations.add("poll:awaited-retryable-tenant-attempt");
    }
  }

  const sourceArgument = builderCall.arguments[0];
  if (!sourceArgument || !ts.isObjectLiteralExpression(sourceArgument)) {
    violations.add("builder:direct-source-object");
    return [...violations].sort();
  }
  const exactSourceKeys = [
    "currentTarget", "logicalWorker", "organizationId", "parsedWorkerHello", "physicalAuthorityWorker",
  ];
  const sourceProperties = new Map<string, ts.Expression>();
  let malformedSourceProperty = false;
  for (const property of sourceArgument.properties) {
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) {
      malformedSourceProperty = true;
      continue;
    }
    const key = propertyName(property.name);
    if (!key || sourceProperties.has(key)) {
      malformedSourceProperty = true;
      continue;
    }
    sourceProperties.set(key, property.initializer);
  }
  if (malformedSourceProperty || [...sourceProperties.keys()].sort().join(",") !== exactSourceKeys.join(",")) {
    violations.add("builder:closed-source-object");
  }
  const organizationPath = pathOf(sourceProperties.get("organizationId"));
  const logicalPath = pathOf(sourceProperties.get("logicalWorker"));
  const helloPath = pathOf(sourceProperties.get("parsedWorkerHello"));
  const targetPath = pathOf(sourceProperties.get("currentTarget"));
  const physicalPath = pathOf(sourceProperties.get("physicalAuthorityWorker"));
  const authorityName = logicalPath?.length === 2 && logicalPath[1] === "worker" ? logicalPath[0] : null;
  const parseName = helloPath?.length === 2 && helloPath[1] === "data" ? helloPath[0] : null;
  const targetName = targetPath?.length === 1 ? targetPath[0] : null;
  const guardName = physicalPath?.length === 2 && physicalPath[1] === "physicalAuthorityWorker"
    ? physicalPath[0]
    : null;
  if (!authorityName || organizationPath?.join(".") !== `${authorityName}.worker.organizationId`) {
    violations.add("builder:locked-logical-organization-source");
  }
  if (!authorityName) violations.add("builder:locked-logical-worker-source");
  if (!parseName) violations.add("builder:parsed-stored-hello-source");
  if (!targetName) violations.add("builder:current-normalized-target-source");
  if (!guardName) violations.add("builder:guarded-physical-source");
  if (new Set([authorityName, parseName, targetName, guardName].filter(Boolean)).size !== 4) {
    violations.add("builder:distinct-source-bindings");
  }

  const sourceNames = [authorityName, parseName, targetName, guardName]
    .filter((name): name is string => Boolean(name));
  for (const name of sourceNames) {
    const binding = directBinding(tenantBody, name);
    if (!binding || binding.statement.getStart(file) >= builderCall.getStart(file)) {
      violations.add(`builder:attempt-local-source:${name}`);
    }
  }
  const authorityBinding = authorityName ? directBinding(tenantBody, authorityName) : null;
  const parseBinding = parseName ? directBinding(tenantBody, parseName) : null;
  const targetBinding = targetName ? directBinding(tenantBody, targetName) : null;
  const guardResultBinding = guardName ? directBinding(tenantBody, guardName) : null;
  const authorityCall = authorityBinding ? unwrappedCall(authorityBinding.initializer) : null;
  const authorityInput = authorityCall?.arguments.length === 1
    ? closedObjectProperties(authorityCall.arguments[0])
    : null;
  if (!authorityBinding || !authorityCall || !isAwaitedCall(authorityCall) ||
      callPath(authorityCall) !== `${reposName}.jobControl.lockWorkerLeaseAuthority` ||
      !authorityInput || [...authorityInput.keys()].sort().join(",") !== "targetId,workerId" ||
      pathOf(authorityInput.get("workerId"))?.join(".") !== `${pollInputName}.auth.workerId` ||
      pathOf(authorityInput.get("targetId"))?.join(".") !== `${pollInputName}.auth.targetId`) {
    violations.add("builder:logical-from-locked-authority");
  }
  const parseCall = parseBinding ? unwrappedCall(parseBinding.initializer) : null;
  if (!parseCall || !ts.isPropertyAccessExpression(parseCall.expression) ||
      pathOf(parseCall.expression)?.join(".") !== "workerHelloV1Schema.safeParse" ||
      pathOf(parseCall.arguments[0])?.join(".") !== `${authorityName}.worker.profileSnapshot`) {
    violations.add("builder:hello-from-locked-profile-snapshot");
  }
  const guardCall = guardResultBinding ? unwrappedCall(guardResultBinding.initializer) : null;
  if (!guardCall || !ts.isIdentifier(guardCall.expression) || guardCall.expression.text !== "guardPlatformAuthority" ||
      !isAwaitedCall(guardCall) || guardCall.arguments.length !== 3 ||
      pathOf(guardCall.arguments[0])?.join(".") !== reposName ||
      pathOf(guardCall.arguments[1])?.join(".") !== `${pollInputName}.auth` ||
      pathOf(guardCall.arguments[2])?.join(".") !== authorityName) {
    violations.add("builder:physical-from-authority-guard");
  }
  const commonAuthorityCalls = directCalls("authorityCurrent").filter((call) => within(call, tenantBody));
  const commonAuthorityCall = commonAuthorityCalls.length === 1 ? commonAuthorityCalls[0]! : null;
  const commonAuthorityBinding = commonAuthorityCall
    ? directBodyBindingForCall(tenantBody, commonAuthorityCall)
    : null;
  const commonAuthorityName = commonAuthorityBinding && ts.isIdentifier(commonAuthorityBinding.declaration.name)
    ? commonAuthorityBinding.declaration.name.text
    : null;
  const commonAuthorityInput = commonAuthorityCall?.arguments.length === 1
    ? closedObjectProperties(commonAuthorityCall.arguments[0])
    : null;
  const commonAuthorityIndex = commonAuthorityBinding
    ? tenantBody.statements.indexOf(commonAuthorityBinding.statement)
    : -1;
  const commonAuthorityReject = commonAuthorityIndex >= 0
    ? tenantBody.statements[commonAuthorityIndex + 1]
    : null;
  const platformHeartbeatBinding = directBinding(tenantBody, "platformPhysicalHeartbeatAt");
  const platformHeartbeatSource = platformHeartbeatBinding?.initializer.getText(file).replace(/\s+/g, "") ?? "";
  const exactCommonAuthority = Boolean(commonAuthorityCall && commonAuthorityBinding &&
    commonAuthorityInput && [...commonAuthorityInput.keys()].sort().join(",") ===
      "auth,authority,databaseNow,maxHeartbeatAgeMs,platformPhysicalHeartbeatAt,request" &&
    pathOf(commonAuthorityInput.get("auth"))?.join(".") === `${pollInputName}.auth` &&
    pathOf(commonAuthorityInput.get("authority"))?.join(".") === authorityName &&
    pathOf(commonAuthorityInput.get("request"))?.join(".") === "parsedRequest" &&
    pathOf(commonAuthorityInput.get("databaseNow"))?.join(".") === "databaseNow" &&
    pathOf(commonAuthorityInput.get("maxHeartbeatAgeMs"))?.join(".") === "maxHeartbeatAgeMs" &&
    pathOf(commonAuthorityInput.get("platformPhysicalHeartbeatAt"))?.join(".") ===
      "platformPhysicalHeartbeatAt" &&
    platformHeartbeatBinding && platformHeartbeatBinding.statement.getStart(file) >
      (guardResultBinding?.statement.getStart(file) ?? Number.MAX_SAFE_INTEGER) &&
    platformHeartbeatBinding.statement.getStart(file) < commonAuthorityBinding.statement.getStart(file) &&
    platformHeartbeatSource.includes(`${guardName}.physicalAuthorityWorker`) &&
    platformHeartbeatSource.includes(`${guardName}.currentTarget.lastSeenAt`) &&
    platformHeartbeatSource.includes(`${guardName}.physicalAuthorityWorker.lastSeenAt`) &&
    commonAuthorityName && commonAuthorityReject && ts.isIfStatement(commonAuthorityReject) &&
    !commonAuthorityReject.elseStatement && (() => {
      const condition = unwrap(commonAuthorityReject.expression);
      return Boolean(condition && ts.isPrefixUnaryExpression(condition) &&
        condition.operator === ts.SyntaxKind.ExclamationToken &&
        pathOf(condition.operand)?.join(".") === commonAuthorityName &&
        (ts.isThrowStatement(commonAuthorityReject.thenStatement) ||
          ts.isBlock(commonAuthorityReject.thenStatement) &&
          commonAuthorityReject.thenStatement.statements.length === 1 &&
          ts.isThrowStatement(commonAuthorityReject.thenStatement.statements[0]!)));
    })());
  if (!exactCommonAuthority) violations.add("builder:trusted-common-authority-current");
  const ackInputName = ackMethod.parameters.length === 1 && ts.isIdentifier(ackMethod.parameters[0]!.name)
    ? ackMethod.parameters[0]!.name.text
    : null;
  const ackTenantCalls = directCalls("runInTenant").filter((call) => within(call, ackMethod));
  const ackTenantCall = ackTenantCalls.length === 1 ? ackTenantCalls[0]! : null;
  const ackCallbackExpression = ackTenantCall?.arguments.length === 3
    ? unwrap(ackTenantCall.arguments[2])
    : null;
  const ackCallback = ackCallbackExpression &&
      (ts.isArrowFunction(ackCallbackExpression) || ts.isFunctionExpression(ackCallbackExpression)) &&
      ts.isBlock(ackCallbackExpression.body)
    ? ackCallbackExpression
    : null;
  const ackBody = ackCallback?.body && ts.isBlock(ackCallback.body) ? ackCallback.body : null;
  const ackCallbackParameter = ackCallback?.parameters[0] ?? null;
  const exactAckCallbackParameters = Boolean(ackCallback && ackCallback.parameters.length === 1 &&
    ackCallbackParameter && ts.isIdentifier(ackCallbackParameter.name) &&
    !ackCallbackParameter.initializer && !ackCallbackParameter.dotDotDotToken &&
    !ackCallbackParameter.questionToken && !ackCallbackParameter.type &&
    !(ackCallbackParameter.modifiers?.length));
  const ackGateCalls = directCalls("ackAuthorityCurrent").filter((call) => within(call, ackMethod));
  const ackGateCall = ackGateCalls.length === 1 ? ackGateCalls[0]! : null;
  const ackGateInput = ackGateCall?.arguments.length === 1
    ? closedObjectProperties(ackGateCall.arguments[0])
    : null;
  const ackAuthorityName = ackGateInput ? pathOf(ackGateInput.get("authority"))?.join(".") ?? null : null;
  const ackGuardIf = ackGateCall && ackBody ? (() => {
    let current: ts.Node = ackGateCall;
    while (current.parent && current.parent !== ackBody) {
      if (ts.isFunctionLike(current.parent)) return null;
      if (ts.isIfStatement(current.parent) && within(ackGateCall, current.parent.expression)) {
        return current.parent;
      }
      current = current.parent;
    }
    return null;
  })() : null;
  const flattenOrExpression = (expression: ts.Expression): ts.Expression[] => {
    const current = unwrap(expression)!;
    return ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.BarBarToken
      ? [...flattenOrExpression(current.left), ...flattenOrExpression(current.right)]
      : [current];
  };
  const exactAckReject = Boolean(ackGuardIf && ackBody && ackGateCall && ackAuthorityName &&
    ackGuardIf.parent === ackBody && !ackGuardIf.elseStatement &&
    (ts.isThrowStatement(ackGuardIf.thenStatement) ||
      ts.isBlock(ackGuardIf.thenStatement) && ackGuardIf.thenStatement.statements.length === 1 &&
      ts.isThrowStatement(ackGuardIf.thenStatement.statements[0]!)) && (() => {
      const terms = flattenOrExpression(ackGuardIf.expression);
      const missingAuthority = unwrap(terms[0]);
      const staleAuthority = unwrap(terms[1]);
      return terms.length === 2 && missingAuthority && ts.isPrefixUnaryExpression(missingAuthority) &&
        missingAuthority.operator === ts.SyntaxKind.ExclamationToken &&
        pathOf(missingAuthority.operand)?.join(".") === ackAuthorityName &&
        staleAuthority && ts.isPrefixUnaryExpression(staleAuthority) &&
        staleAuthority.operator === ts.SyntaxKind.ExclamationToken &&
        unwrap(staleAuthority.operand) === ackGateCall;
    })());
  const protectedAckEffectNames = new Set([
    "activateLeaseAck", "findOperationReceipt", "lockLeaseAckContext", "touchWorkerLeaseProfile",
  ]);
  const ackEffectCalls: ts.CallExpression[] = [];
  let invalidAckEffectUse = false;
  if (ackBody) {
    const collectAckEffects = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && protectedAckEffectNames.has(node.name.text)) {
        if (ts.isCallExpression(node.parent) && node.parent.expression === node) ackEffectCalls.push(node.parent);
        else invalidAckEffectUse = true;
      }
      if (ts.isElementAccessExpression(node)) {
        const argument = unwrap(node.argumentExpression);
        if (argument && ts.isStringLiteral(argument) && protectedAckEffectNames.has(argument.text)) {
          invalidAckEffectUse = true;
        }
      }
      ts.forEachChild(node, collectAckEffects);
    };
    collectAckEffects(ackBody);
  }
  const directAckStatement = (node: ts.Node): ts.Statement | null => {
    if (!ackBody) return null;
    let current: ts.Node = node;
    while (current.parent && current.parent !== ackBody) {
      if (ts.isFunctionLike(current.parent) && current.parent !== ackCallback) return null;
      current = current.parent;
    }
    return current.parent === ackBody && ts.isStatement(current) ? current : null;
  };
  const ackReturns: ts.ReturnStatement[] = [];
  const collectAckReturns = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) ackReturns.push(node);
    ts.forEachChild(node, collectAckReturns);
  };
  collectAckReturns(ackMethod.body!);
  const outerAckTenantReturns = ackReturns.filter((statement) =>
    statement.parent === ackMethod.body &&
    unwrappedCall(statement.expression) === ackTenantCall);
  const outerAckTenantReturn = outerAckTenantReturns.length === 1
    ? outerAckTenantReturns[0]!
    : null;
  const ackResultReturns = ackReturns.filter((statement) => statement !== outerAckTenantReturn);
  const followsAckGuard = (statement: ts.Statement | null): boolean => Boolean(
    ackGuardIf && statement && statement.getStart(file) > ackGuardIf.getEnd(),
  );
  const exactAckEffectDominance = Boolean(ackGuardIf && ackEffectCalls.length > 0 &&
    !invalidAckEffectUse && ackEffectCalls.every((call) => {
      const statement = directAckStatement(call);
      return followsAckGuard(statement);
    }));
  const exactAckReturnDominance = Boolean(outerAckTenantReturn && ackResultReturns.length > 0 &&
    ackResultReturns.every((statement) => followsAckGuard(directAckStatement(statement))));
  const exactAckGateFlow = Boolean(ackInputName && serviceInputName && ackTenantCall && ackCallback && ackBody &&
    exactAckCallbackParameters &&
    ackTenantCall.arguments.length === 3 &&
    pathOf(ackTenantCall.arguments[0])?.join(".") === `${serviceInputName}.appDb` &&
    pathOf(ackTenantCall.arguments[1])?.join(".") === `${ackInputName}.auth.organizationId` &&
    ackGateCall && ackGateInput && [...ackGateInput.keys()].sort().join(",") ===
      "auth,authority,databaseNow,maxHeartbeatAgeMs,platformPhysicalHeartbeatAt,workerId" &&
    pathOf(ackGateInput.get("auth"))?.join(".") === `${ackInputName}.auth` &&
    ackAuthorityName === "authority" &&
    pathOf(ackGateInput.get("workerId"))?.join(".") === "request.body.workerId" &&
    pathOf(ackGateInput.get("databaseNow"))?.join(".") === "authorityNow" &&
    pathOf(ackGateInput.get("maxHeartbeatAgeMs"))?.join(".") === "maxHeartbeatAgeMs" &&
    pathOf(ackGateInput.get("platformPhysicalHeartbeatAt"))?.join(".") === "platformPhysicalHeartbeatAt" &&
    exactAckReject && exactAckEffectDominance && exactAckReturnDominance);
  if (!exactAckGateFlow) violations.add("builder:trusted-service-authority-guard");
  if (guardCall && ts.isIdentifier(guardCall.expression)) {
    const helperName = guardCall.expression.text;
    const declarations: ts.VariableDeclaration[] = [];
    const collectDeclarations = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === helperName) {
        declarations.push(node);
      }
      ts.forEachChild(node, collectDeclarations);
    };
    collectDeclarations(file);
    const helperBinding = directBinding(serviceBody, helperName);
    const helperExpression = helperBinding ? unwrap(helperBinding.initializer) : null;
    const helper = helperExpression && (ts.isArrowFunction(helperExpression) || ts.isFunctionExpression(helperExpression))
      ? helperExpression
      : null;
    const helperBody = helper && ts.isBlock(helper.body) ? helper.body : null;
    const helperParameters = helper?.parameters.map((parameter) =>
      ts.isIdentifier(parameter.name) ? parameter.name.text : null) ?? [];
    if (declarations.length !== 1 || !helperBody || helperParameters.length !== 3 ||
        helperParameters.some((name) => !name) || !helperBinding ||
        helperBinding.statement.parent !== serviceBody) {
      violations.add("builder:trusted-service-authority-guard");
    } else {
      const [guardReposName, guardAuthName, guardLockedName] =
        helperParameters as [string, string, string];
      auditDynamicMetaprogramming(helperBody);
      const helperCalls: ts.CallExpression[] = [];
      const collectCalls = (node: ts.Node, output: ts.CallExpression[]): void => {
        if (ts.isCallExpression(node)) output.push(node);
        ts.forEachChild(node, (child) => collectCalls(child, output));
      };
      collectCalls(helperBody, helperCalls);
      const operatorTransactions = helperCalls.filter((call) =>
        callPath(call) === `${serviceInputName}.operatorDb.transaction`);
      const operatorTransaction = operatorTransactions.length === 1 ? operatorTransactions[0]! : null;
      const operatorCallbackExpression = operatorTransaction?.arguments.length === 1
        ? unwrap(operatorTransaction.arguments[0])
        : null;
      const operatorCallback = operatorCallbackExpression &&
          (ts.isArrowFunction(operatorCallbackExpression) || ts.isFunctionExpression(operatorCallbackExpression)) &&
          ts.isBlock(operatorCallbackExpression.body)
        ? operatorCallbackExpression
        : null;
      const operatorBody = operatorCallback?.body && ts.isBlock(operatorCallback.body)
        ? operatorCallback.body
        : null;
      const operatorTxName = operatorCallback?.parameters.length === 1 &&
          ts.isIdentifier(operatorCallback.parameters[0]!.name)
        ? operatorCallback.parameters[0]!.name.text
        : null;
      const operatorCalls: ts.CallExpression[] = [];
      if (operatorBody) collectCalls(operatorBody, operatorCalls);
      const physicalCalls = operatorCalls.filter((call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "lockPlatformPhysicalAuthority");
      const sharedCalls = operatorCalls.filter((call) =>
        callPath(call) === `${guardReposName}.jobControl.acquirePlatformTargetAuthorityShared`);
      const recheckCalls = operatorCalls.filter((call) =>
        callPath(call) === `${guardReposName}.jobControl.recheckPlatformTargetAuthority`);
      const databaseNowCalls = operatorCalls.filter((call) =>
        callPath(call) === `${guardReposName}.jobControl.currentDatabaseTime`);
      const wrappedBindingName = (call: ts.CallExpression | undefined): string | null => {
        if (!call) return null;
        let current: ts.Node = call;
        while (current.parent && (
          ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent) ||
          ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent) ||
          ts.isNonNullExpression(current.parent) || ts.isSatisfiesExpression(current.parent)
        ) && current.parent.expression === current) current = current.parent;
        return ts.isVariableDeclaration(current.parent) && current.parent.initializer === current &&
          ts.isIdentifier(current.parent.name) ? current.parent.name.text : null;
      };
      const physicalName = physicalCalls.length === 1 && isAwaitedCall(physicalCalls[0]!)
        ? wrappedBindingName(physicalCalls[0])
        : null;
      const currentName = recheckCalls.length === 1 && isAwaitedCall(recheckCalls[0]!)
        ? wrappedBindingName(recheckCalls[0])
        : null;
      const platformNowName = databaseNowCalls.length === 1 && isAwaitedCall(databaseNowCalls[0]!)
        ? wrappedBindingName(databaseNowCalls[0])
        : null;
      const repositoryFactory = physicalCalls.length === 1 &&
          ts.isPropertyAccessExpression(physicalCalls[0]!.expression)
        ? unwrappedCall(physicalCalls[0]!.expression.expression)
        : null;
      const physicalBinding = operatorBody && physicalCalls.length === 1
        ? directBodyBindingForCall(operatorBody, physicalCalls[0]!)
        : null;
      const currentBinding = operatorBody && recheckCalls.length === 1
        ? directBodyBindingForCall(operatorBody, recheckCalls[0]!)
        : null;
      const platformNowBinding = operatorBody && databaseNowCalls.length === 1
        ? directBodyBindingForCall(operatorBody, databaseNowCalls[0]!)
        : null;
      const recheckInput = recheckCalls.length === 1 && recheckCalls[0]!.arguments.length === 1
        ? closedObjectProperties(recheckCalls[0]!.arguments[0])
        : null;
      const callbackReturns: ts.ReturnStatement[] = [];
      const collectCallbackReturns = (node: ts.Node): void => {
        if (node !== operatorCallback && ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node)) callbackReturns.push(node);
        ts.forEachChild(node, collectCallbackReturns);
      };
      if (operatorCallback) collectCallbackReturns(operatorCallback);
      const helperReturns: ts.ReturnStatement[] = [];
      const collectHelperReturns = (node: ts.Node): void => {
        if (node !== helper && ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node)) helperReturns.push(node);
        ts.forEachChild(node, collectHelperReturns);
      };
      if (helper) collectHelperReturns(helper);
      const directlyThrowsFromGuard = (statement: ts.Statement): boolean =>
        ts.isThrowStatement(statement) ||
        ts.isBlock(statement) && statement.statements.length === 1 &&
        ts.isThrowStatement(statement.statements[0]!);
      const nonPlatformBranch = helperBody.statements[0];
      const nonPlatformCondition = nonPlatformBranch && ts.isIfStatement(nonPlatformBranch)
        ? unwrap(nonPlatformBranch.expression)
        : null;
      const exactScopeComparison = (expression: ts.Expression, scope: "organization" | "owner"): boolean => {
        const current = unwrap(expression);
        if (!current || !ts.isBinaryExpression(current) ||
            current.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
        const left = pathOf(current.left)?.join(".");
        const right = unwrap(current.right);
        return left === `${guardLockedName}.target.scope` &&
          Boolean(right && ts.isStringLiteral(right) && right.text === scope);
      };
      const exactNonPlatformCondition = Boolean(nonPlatformCondition &&
        ts.isBinaryExpression(nonPlatformCondition) &&
        nonPlatformCondition.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
        exactScopeComparison(nonPlatformCondition.left, "organization") &&
        exactScopeComparison(nonPlatformCondition.right, "owner"));
      const nonPlatformReturns: ts.ReturnStatement[] = [];
      if (nonPlatformBranch && ts.isIfStatement(nonPlatformBranch)) {
        const scan = (node: ts.Node): void => {
          if (ts.isFunctionLike(node)) return;
          if (ts.isReturnStatement(node)) nonPlatformReturns.push(node);
          ts.forEachChild(node, scan);
        };
        scan(nonPlatformBranch.thenStatement);
      }
      const nonPlatformReturn = nonPlatformReturns.length === 1
        ? closedObjectProperties(nonPlatformReturns[0]!.expression)
        : null;
      const exactNonPlatformReturn = Boolean(nonPlatformReturn &&
        [...nonPlatformReturn.keys()].sort().join(",") === "currentTarget,physicalAuthorityWorker" &&
        pathOf(nonPlatformReturn.get("currentTarget"))?.join(".") === `${guardLockedName}.target` &&
        unwrap(nonPlatformReturn.get("physicalAuthorityWorker"))?.kind === ts.SyntaxKind.NullKeyword);
      const platformScopeReject = helperBody.statements[1];
      const exactPlatformFallthrough = Boolean(platformScopeReject && ts.isIfStatement(platformScopeReject) &&
        !platformScopeReject.elseStatement && directlyThrowsFromGuard(platformScopeReject.thenStatement) &&
        (() => {
          const condition = unwrap(platformScopeReject.expression);
          if (!condition || !ts.isBinaryExpression(condition) ||
              condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return false;
          const right = unwrap(condition.right);
          return pathOf(condition.left)?.join(".") === `${guardLockedName}.target.scope` &&
            Boolean(right && ts.isStringLiteral(right) && right.text === "platform");
        })());
      const platformTransactionReturn = helperBody.statements[2];
      const exactTransactionWrapper = helperReturns.length === 2 &&
        exactNonPlatformCondition && exactNonPlatformReturn && exactPlatformFallthrough &&
        platformTransactionReturn && ts.isReturnStatement(platformTransactionReturn) &&
        unwrappedCall(platformTransactionReturn.expression) === operatorTransaction;
      const exactReturn = callbackReturns.length === 1 && operatorBody &&
          callbackReturns[0]!.parent === operatorBody
        ? closedObjectProperties(callbackReturns[0]!.expression)
        : null;
      const exactReturnedSnapshots = Boolean(exactReturn &&
        [...exactReturn.keys()].sort().join(",") === "currentTarget,physicalAuthorityWorker" &&
        pathOf(exactReturn.get("currentTarget"))?.join(".") === currentName &&
        pathOf(exactReturn.get("physicalAuthorityWorker"))?.join(".") === `${physicalName}.worker`);
      const flattenOr = (expression: ts.Expression): ts.Expression[] => {
        const current = unwrap(expression)!;
        return ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.BarBarToken
          ? [...flattenOr(current.left), ...flattenOr(current.right)]
          : [current];
      };
      const platformValidationStatements = operatorBody?.statements.filter((statement) =>
        ts.isIfStatement(statement) && !statement.elseStatement &&
        directlyThrowsFromGuard(statement.thenStatement)) ?? [];
      const platformValidation = platformValidationStatements.length === 1 &&
          ts.isIfStatement(platformValidationStatements[0]!)
        ? platformValidationStatements[0]!
        : null;
      const compact = (value: string): string => value.replace(/\s+/g, "");
      const expectedPlatformChecks = physicalName && currentName && platformNowName ? [
        `!${physicalName}`,
        `!${currentName}`,
        `${physicalName}.target.scope!=="platform"`,
        `${physicalName}.worker.scope!=="platform"`,
        `${currentName}.scope!=="platform"`,
        `${physicalName}.target.status!=="active"`,
        `!(${physicalName}.worker.status==="enrolled"||${physicalName}.worker.status==="active")`,
        `${currentName}.status!=="active"`,
        `${physicalName}.worker.revokedAt!==null`,
        `${physicalName}.target.id!==${guardAuthName}.targetId`,
        `${currentName}.id!==${guardAuthName}.targetId`,
        `${physicalName}.worker.executionTargetId!==${physicalName}.target.id`,
        `${physicalName}.worker.targetAuthorityKey!==${physicalName}.target.targetAuthorityKey`,
        `${currentName}.targetAuthorityKey!==${physicalName}.target.targetAuthorityKey`,
        `${guardLockedName}.worker.executionTargetId!==${currentName}.id`,
        `${guardLockedName}.worker.targetAuthorityKey!==${currentName}.targetAuthorityKey`,
        `${guardLockedName}.worker.deviceGeneration!==${guardAuthName}.targetGeneration`,
        `${physicalName}.target.deviceGeneration!==${guardAuthName}.targetGeneration`,
        `${physicalName}.worker.deviceGeneration!==${guardAuthName}.targetGeneration`,
        `${currentName}.deviceGeneration!==${guardAuthName}.targetGeneration`,
        `${physicalName}.worker.devicePublicKey!==${guardAuthName}.publicKey`,
        `${physicalName}.worker.deviceThumbprint!==${guardAuthName}.deviceThumbprint`,
        `!${physicalName}.target.registeredProfileHash`,
        `${physicalName}.target.registeredProfileHash!==${currentName}.registeredProfileHash`,
        `!${physicalName}.worker.profileHash`,
        `${guardLockedName}.worker.profileHash!==${guardAuthName}.profileHash`,
        `!${physicalName}.target.lastSeenAt`,
        `!${physicalName}.worker.lastSeenAt`,
        `${platformNowName}.getTime()-${physicalName}.target.lastSeenAt.getTime()>maxHeartbeatAgeMs`,
        `${platformNowName}.getTime()-${physicalName}.worker.lastSeenAt.getTime()>maxHeartbeatAgeMs`,
      ].sort() : [];
      const actualPlatformChecks = platformValidation
        ? flattenOr(platformValidation.expression).map((expression) => compact(expression.getText(file))).sort()
        : [];
      const exactPlatformChecks = expectedPlatformChecks.length === 30 &&
        actualPlatformChecks.length === expectedPlatformChecks.length &&
        actualPlatformChecks.every((value, index) => value === expectedPlatformChecks[index]);
      const physicalRepositoryBoundToOperatorTx = Boolean(repositoryFactory &&
        ts.isIdentifier(repositoryFactory.expression) &&
        repositoryFactory.expression.text === "operatorJobLeasingRepository" &&
        repositoryFactory.arguments.length === 1 &&
        pathOf(repositoryFactory.arguments[0])?.join(".") === operatorTxName);
      const transactionWrapsGuard = Boolean(operatorTransaction && operatorCallback && operatorBody &&
        operatorTxName && serviceInputName &&
        within(operatorTransaction, helperBody) && exactTransactionWrapper);
      const sharedTopLevel = Boolean(operatorBody && sharedCalls.length === 1 &&
        (() => {
          let current: ts.Node = sharedCalls[0]!;
          while (current.parent && (
            ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent) ||
            ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent) ||
            ts.isNonNullExpression(current.parent) || ts.isSatisfiesExpression(current.parent)
          ) && current.parent.expression === current) current = current.parent;
          return ts.isExpressionStatement(current.parent) && current.parent.parent === operatorBody;
        })());
      const orderedGuard = Boolean(physicalCalls[0] && sharedCalls[0] && recheckCalls[0] &&
        databaseNowCalls[0] && platformValidation && callbackReturns[0] &&
        physicalCalls[0]!.getStart(file) < sharedCalls[0]!.getStart(file) &&
        sharedCalls[0]!.getStart(file) < recheckCalls[0]!.getStart(file) &&
        recheckCalls[0]!.getStart(file) < databaseNowCalls[0]!.getStart(file) &&
        databaseNowCalls[0]!.getStart(file) < platformValidation.getStart(file) &&
        platformValidation.getStart(file) < callbackReturns[0]!.getStart(file));
      const guardProtectedNames = new Set<string>([
        guardAuthName, guardLockedName, physicalName, currentName,
      ].filter((name): name is string => Boolean(name)));
      const guardAllowedCalls = new Set<ts.CallExpression>([
        physicalCalls[0], sharedCalls[0], recheckCalls[0], databaseNowCalls[0], repositoryFactory,
      ].filter((call): call is ts.CallExpression => Boolean(call)));
      const guardAllowedContainers = new Set<ts.Node>([
        recheckCalls[0]?.arguments[0], callbackReturns[0]?.expression, nonPlatformReturns[0]?.expression,
      ].filter((node): node is ts.Node => Boolean(node)));
      let guardCriticalEscape = false;
      let guardAliasAdded = true;
      while (guardAliasAdded) {
        guardAliasAdded = false;
        const discoverGuardAliases = (node: ts.Node): void => {
          const addName = (name: ts.BindingName): void => {
            if (ts.isIdentifier(name)) {
              if (!guardProtectedNames.has(name.text)) {
                guardProtectedNames.add(name.text);
                guardAliasAdded = true;
              }
              return;
            }
            for (const element of name.elements) {
              if (!ts.isOmittedExpression(element)) addName(element.name);
            }
          };
          if (ts.isVariableDeclaration(node) && node.initializer) {
            const root = pathOf(node.initializer)?.[0];
            if (root && guardProtectedNames.has(root)) addName(node.name);
          }
          if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const root = pathOf(node.right)?.[0];
            if (root && guardProtectedNames.has(root) && ts.isIdentifier(node.left)) addName(node.left);
          }
          ts.forEachChild(node, discoverGuardAliases);
        };
        discoverGuardAliases(helperBody);
      }
      const containsGuardReference = (node: ts.Node): boolean => {
        let found = false;
        const scan = (currentNode: ts.Node): void => {
          if (ts.isFunctionLike(currentNode)) return;
          if (ts.isIdentifier(currentNode) && guardProtectedNames.has(currentNode.text)) {
            found = true;
            return;
          }
          ts.forEachChild(currentNode, scan);
        };
        scan(node);
        return found;
      };
      const auditGuardSnapshots = (node: ts.Node): void => {
        if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
            !ts.isBlock(node.body) && containsGuardReference(node.body)) {
          guardCriticalEscape = true;
        }
        if (ts.isReturnStatement(node) && node.expression && containsGuardReference(node.expression) &&
            !guardAllowedContainers.has(node.expression)) {
          guardCriticalEscape = true;
        }
        if (ts.isVariableDeclaration(node) && node.initializer) {
          const root = pathOf(node.initializer)?.[0];
          if (root && guardProtectedNames.has(root) && ts.isIdentifier(node.name) &&
              !guardProtectedNames.has(node.name.text)) guardCriticalEscape = true;
        }
        if (ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
            (containsGuardReference(node.left) || containsGuardReference(node.right))) guardCriticalEscape = true;
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
            containsGuardReference(node.operand)) guardCriticalEscape = true;
        if (ts.isDeleteExpression(node) && containsGuardReference(node.expression)) {
          guardCriticalEscape = true;
        }
        if (ts.isElementAccessExpression(node) && containsGuardReference(node.expression)) {
          guardCriticalEscape = true;
        }
        if ((ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) &&
            containsGuardReference(node) && !guardAllowedContainers.has(node)) {
          guardCriticalEscape = true;
        }
        if (ts.isCallExpression(node) &&
            (node.arguments.some(containsGuardReference) || containsGuardReference(node.expression)) &&
            !guardAllowedCalls.has(node) && !(callPath(node)?.endsWith(".getTime") ?? false)) {
          guardCriticalEscape = true;
        }
        ts.forEachChild(node, auditGuardSnapshots);
      };
      auditGuardSnapshots(helperBody);
      if (!transactionWrapsGuard || operatorTransactions.length !== 1 ||
          !physicalName || !currentName || physicalCalls.length !== 1 ||
          !physicalRepositoryBoundToOperatorTx || !isAwaitedCall(physicalCalls[0]!) ||
          !physicalBinding || !currentBinding || !platformNowBinding || !sharedTopLevel ||
          physicalCalls[0]!.arguments.length !== 2 ||
          pathOf(physicalCalls[0]!.arguments[0])?.join(".") !== `${guardAuthName}.targetId` ||
          !ts.isStringLiteral(unwrap(physicalCalls[0]!.arguments[1])!) ||
          (unwrap(physicalCalls[0]!.arguments[1]) as ts.StringLiteral).text !== "share" ||
          sharedCalls.length !== 1 || !isAwaitedCall(sharedCalls[0]!) || sharedCalls[0]!.arguments.length !== 1 ||
          pathOf(sharedCalls[0]!.arguments[0])?.join(".") !== `${guardAuthName}.targetId` ||
          !recheckInput || [...recheckInput.keys()].sort().join(",") !==
            "targetAuthorityKey,targetGeneration,targetId" ||
          pathOf(recheckInput.get("targetId"))?.join(".") !== `${guardAuthName}.targetId` ||
          pathOf(recheckInput.get("targetGeneration"))?.join(".") !== `${guardAuthName}.targetGeneration` ||
          !ts.isStringLiteral(unwrap(recheckInput.get("targetAuthorityKey"))!) ||
          (unwrap(recheckInput.get("targetAuthorityKey")) as ts.StringLiteral).text !== "platform" ||
          databaseNowCalls.length !== 1 || databaseNowCalls[0]!.arguments.length !== 0 ||
          !exactPlatformChecks || !exactReturnedSnapshots || !orderedGuard || guardCriticalEscape) {
        violations.add("builder:trusted-service-authority-guard");
      }
    }
  }
  const targetCall = targetBinding ? unwrappedCall(targetBinding.initializer) : null;
  if (!targetCall || !ts.isIdentifier(targetCall.expression) ||
      targetCall.expression.text !== "normalizePlacementRegistryTarget" ||
      pathOf(targetCall.arguments[0])?.join(".") !== `${guardName}.currentTarget`) {
    violations.add("builder:target-from-post-advisory-current-snapshot");
  }

  const directlyThrows = (statement: ts.Statement | undefined): boolean =>
    Boolean(statement && (ts.isThrowStatement(statement) ||
      ts.isBlock(statement) && statement.statements.some((child) => ts.isThrowStatement(child))));
  const conditionRejects = (expression: ts.Expression, requiredPath: string): boolean => {
    const current = unwrap(expression);
    if (!current) return false;
    if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken &&
        pathOf(current.operand)?.join(".") === requiredPath) return true;
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return conditionRejects(current.left, requiredPath) || conditionRejects(current.right, requiredPath);
    }
    if (ts.isBinaryExpression(current) && [
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ].includes(current.operatorToken.kind)) {
      const left = pathOf(current.left)?.join(".");
      const right = unwrap(current.right);
      return left === requiredPath && Boolean(right &&
        (right.kind === ts.SyntaxKind.NullKeyword || right.kind === ts.SyntaxKind.FalseKeyword));
    }
    return false;
  };
  const failClosedBeforeBuilder = (requiredPath: string | null): boolean => Boolean(requiredPath &&
    tenantBody.statements.some((statement) =>
      ts.isIfStatement(statement) && statement.getStart(file) < builderCall.getStart(file) &&
      conditionRejects(statement.expression, requiredPath) && directlyThrows(statement.thenStatement)));
  if (!failClosedBeforeBuilder(authorityName)) violations.add("builder:locked-logical-validated");
  if (!failClosedBeforeBuilder(parseName ? `${parseName}.success` : null)) {
    violations.add("builder:stored-hello-validated");
  }
  if (!failClosedBeforeBuilder(targetName)) violations.add("builder:current-target-validated");

  const builderName = builderBinding && ts.isIdentifier(builderBinding.declaration.name)
    ? builderBinding.declaration.name.text
    : null;
  const hashName = hashBinding && ts.isIdentifier(hashBinding.declaration.name)
    ? hashBinding.declaration.name.text
    : null;
  if (!builderName || hashCall.arguments.length !== 1 || pathOf(hashCall.arguments[0])?.join(".") !== builderName) {
    violations.add("hash:only-projected-input");
  }
  if (builderCall.getStart(file) >= hashCall.getStart(file)) violations.add("hash:after-builder");

  const candidateReceiverAliases = new Set<string>();
  let candidateAliasAdded = true;
  while (candidateAliasAdded) {
    candidateAliasAdded = false;
    const discoverCandidateReceivers = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializerPath = pathOf(node.initializer)?.join(".");
        if (initializerPath === `${reposName}.jobControl` ||
            (initializerPath && candidateReceiverAliases.has(initializerPath))) {
          if (!candidateReceiverAliases.has(node.name.text)) {
            candidateReceiverAliases.add(node.name.text);
            candidateAliasAdded = true;
          }
        }
      }
      ts.forEachChild(node, discoverCandidateReceivers);
    };
    discoverCandidateReceivers(tenantBody);
  }
  const isCandidateReceiver = (expression: ts.Expression): boolean => {
    const path = pathOf(expression)?.join(".");
    return path === `${reposName}.jobControl` || Boolean(path && candidateReceiverAliases.has(path));
  };
  const candidateAccesses: ts.Expression[] = [];
  const directCandidateCalls: ts.CallExpression[] = [];
  const collectCandidateInventory = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "lockEligibleLeaseCandidates") {
      candidateAccesses.push(node);
      if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
        directCandidateCalls.push(node.parent);
      }
    } else if (ts.isElementAccessExpression(node) && isCandidateReceiver(node.expression)) {
      const argument = unwrap(node.argumentExpression);
      if (!argument || !ts.isStringLiteral(argument) ||
          argument.text === "lockEligibleLeaseCandidates") candidateAccesses.push(node);
    } else if (ts.isBindingElement(node) &&
        (propertyName(node.propertyName) ?? propertyName(node.name as ts.PropertyName)) ===
          "lockEligibleLeaseCandidates") {
      candidateAccesses.push(node as unknown as ts.Expression);
    }
    ts.forEachChild(node, collectCandidateInventory);
  };
  collectCandidateInventory(tenantBody);
  const candidateCalls = directCandidateCalls.filter((call) =>
    callPath(call) === `${reposName}.jobControl.lockEligibleLeaseCandidates`);
  if (candidateAccesses.length !== 1 || candidateCalls.length !== 1 ||
      candidateAccesses[0] !== candidateCalls[0]!.expression) {
    violations.add("candidate:exactly-one-selection-call");
  }
  if (directCandidateCalls.length !== 1 || candidateCalls.length !== 1) {
    violations.add("candidate:awaited-top-level-repository-selection");
  }
  const canonicalCandidateTaintNames = new Set<string>();
  if (candidateCalls.length === 1) {
    const candidate = candidateCalls[0]!;
    // A reviewed selection binds the candidate array either directly
    // (`const candidates = await <call>`) or via the payload-free scan-telemetry destructure
    // (`const { candidates, certificateMetrics } = await <call>`). Only these two exact shapes pass:
    // an array pattern, a rest element, a renamed/extra key, or a non-const/out-of-body statement is
    // still rejected (candidateBinding stays null → the two selection violations fire).
    let candidateBinding = directBodyBindingForCall(tenantBody, candidate);
    let candidateArrayName = candidateBinding && ts.isIdentifier(candidateBinding.declaration.name)
      ? candidateBinding.declaration.name.text
      : null;
    if (!candidateBinding) {
      let selection: ts.Node = candidate;
      while (selection.parent && (
        ts.isAwaitExpression(selection.parent) || ts.isParenthesizedExpression(selection.parent) ||
        ts.isAsExpression(selection.parent) || ts.isTypeAssertionExpression(selection.parent) ||
        ts.isNonNullExpression(selection.parent) || ts.isSatisfiesExpression(selection.parent)
      ) && (selection.parent as ts.AwaitExpression).expression === selection) {
        selection = selection.parent;
      }
      const declaration = selection.parent;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer === selection &&
          ts.isObjectBindingPattern(declaration.name)) {
        const list = declaration.parent;
        const statement = list.parent;
        const reviewedScanKeys = new Set(["candidates", "certificateMetrics"]);
        const reviewedOnly = declaration.name.elements.every((element) =>
          !element.dotDotDotToken && !element.propertyName && ts.isIdentifier(element.name) &&
          reviewedScanKeys.has(element.name.text));
        const arrayElement = declaration.name.elements.find((element) =>
          ts.isIdentifier(element.name) && element.name.text === "candidates");
        if (ts.isVariableDeclarationList(list) && ts.isVariableStatement(statement) &&
            (list.flags & ts.NodeFlags.Const) && statement.parent === tenantBody &&
            reviewedOnly && arrayElement && ts.isIdentifier(arrayElement.name)) {
          candidateBinding = { declaration, statement, initializer: declaration.initializer };
          candidateArrayName = arrayElement.name.text;
        }
      }
    }
    const candidateInput = candidate.arguments.length === 1
      ? closedObjectProperties(candidate.arguments[0])
      : null;
    const expectedCandidateKeys = [
      "admissibleWorkloadTypes", "eligibilityVersion", "limit", "staticContextHash",
      "placementOwner", "targetAuthorityKey", "targetClass", "targetGeneration", "targetId",
      "targetProfileHash", "targetProviderConstraintHash", "targetScope", "workerId",
    ];
    const closedCandidate = candidateInput &&
      [...candidateInput.keys()].sort().join(",") === expectedCandidateKeys.sort().join(",");
    const boundHash = closedCandidate && hashName &&
      pathOf(candidateInput.get("staticContextHash"))?.join(".") === hashName;
    if (!candidateBinding || !isAwaitedCall(candidate) ||
        callPath(candidate) !== `${reposName}.jobControl.lockEligibleLeaseCandidates`) {
      violations.add("candidate:awaited-top-level-repository-selection");
    }
    if (!closedCandidate) violations.add("candidate:closed-input-object");
    if (!boundHash) violations.add("candidate:bind-one-context-hash");
    if (candidateInput && (
      pathOf(candidateInput.get("workerId"))?.join(".") !== `${pollInputName}.auth.workerId` ||
      pathOf(candidateInput.get("targetId"))?.join(".") !== `${targetName}.targetId` ||
      [...candidateInput.values()].some((value) => value.getText(file).includes(`${pollInputName}.request`))
    )) violations.add("candidate:validated-auth-and-target-sources");
    const eligibilityVersionImports = imports.get("LEASE_STATIC_ELIGIBILITY_VERSION") ?? [];
    if (!candidateInput || eligibilityVersionImports.length !== 1 ||
        eligibilityVersionImports[0]!.local !== "LEASE_STATIC_ELIGIBILITY_VERSION" ||
        eligibilityVersionImports[0]!.module !== "./job-lease-eligibility.js" ||
        violations.has("import-symbol:LEASE_STATIC_ELIGIBILITY_VERSION:shadowed-import") ||
        pathOf(candidateInput.get("eligibilityVersion"))?.join(".") !==
          "LEASE_STATIC_ELIGIBILITY_VERSION") {
      violations.add("candidate:server-eligibility-version");
    }
    if (!candidateInput ||
        pathOf(candidateInput.get("targetGeneration"))?.join(".") !== `${targetName}.targetGeneration` ||
        pathOf(candidateInput.get("targetProfileHash"))?.join(".") !== `${targetName}.profileHash` ||
        pathOf(candidateInput.get("targetProviderConstraintHash"))?.join(".") !==
          `${targetName}.providerConstraintHash` ||
        pathOf(candidateInput.get("targetAuthorityKey"))?.join(".") !==
          `${guardName}.currentTarget.targetAuthorityKey` ||
        pathOf(candidateInput.get("placementOwner"))?.join(".") !== `${targetName}.targetClass` ||
        pathOf(candidateInput.get("targetClass"))?.join(".") !== `${targetName}.targetClass` ||
        pathOf(candidateInput.get("targetScope"))?.join(".") !== `${targetName}.targetScope`) {
      violations.add("candidate:current-target-provenance");
    }
    const candidateLimit = candidateInput ? unwrap(candidateInput.get("limit")) : null;
    if (!candidateLimit || !ts.isNumericLiteral(candidateLimit) || Number(candidateLimit.text) !== 256) {
      violations.add("candidate:bounded-global-head-limit");
    }
    const admissiblePath = candidateInput ? pathOf(candidateInput.get("admissibleWorkloadTypes")) : null;
    const admissibleName = admissiblePath?.length === 1 ? admissiblePath[0]! : null;
    const admissibleBinding = admissibleName ? directBinding(tenantBody, admissibleName) : null;
    const admissibleCall = admissibleBinding ? unwrappedCall(admissibleBinding.initializer) : null;
    const effectiveCapacityBinding = directBinding(tenantBody, "effectiveCapacity");
    const effectiveCapacityCall = effectiveCapacityBinding
      ? unwrappedCall(effectiveCapacityBinding.initializer)
      : null;
    const liveCapacityBinding = directBinding(tenantBody, "liveCapacity");
    const liveCapacityCall = liveCapacityBinding ? unwrappedCall(liveCapacityBinding.initializer) : null;
    const liveCapacityInput = liveCapacityCall?.arguments.length === 1
      ? closedObjectProperties(liveCapacityCall.arguments[0])
      : null;
    const liveCapacityCalls: ts.CallExpression[] = [];
    const collectLiveCapacityCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node) &&
          callPath(node) === `${reposName}.jobControl.snapshotLiveLeaseCapacity`) {
        liveCapacityCalls.push(node);
      }
      ts.forEachChild(node, collectLiveCapacityCalls);
    };
    collectLiveCapacityCalls(tenantBody);
    const deriveBinding = directBinding(serviceBody, "deriveAdmissibleWorkloadTypes");
    const deriveExpression = deriveBinding ? unwrap(deriveBinding.initializer) : null;
    const deriveHelper = deriveExpression &&
        (ts.isArrowFunction(deriveExpression) || ts.isFunctionExpression(deriveExpression)) &&
        ts.isBlock(deriveExpression.body)
      ? deriveExpression
      : null;
    const deriveParameters = deriveHelper?.parameters.map((parameter) =>
      ts.isIdentifier(parameter.name) ? parameter.name.text : null) ?? [];
    const requiredDerivationPredicates = [
      "live.total>=provider.maxConcurrentOperations",
      "capacity.freeCpuMillis>provider.resourceCeiling.cpuMillis",
      "capacity.freeMemoryMiB>provider.resourceCeiling.memoryMiB",
      "capacity.freeDiskMiB>provider.resourceCeiling.diskMiB",
      "capacity.freeCpuMillis<demand.resources.cpuMillis",
      "capacity.freeMemoryMiB<demand.resources.memoryMiB",
      "capacity.freeDiskMiB<demand.resources.diskMiB",
    ].sort();
    const deriveStatements = deriveHelper?.body.statements ?? [];
    const deriveGate = deriveStatements[0] && ts.isIfStatement(deriveStatements[0])
      ? deriveStatements[0]
      : null;
    const flattenOrExpressions = (expression: ts.Expression): ts.Expression[] => {
      const current = unwrap(expression)!;
      return ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.BarBarToken
        ? [...flattenOrExpressions(current.left), ...flattenOrExpressions(current.right)]
        : [current];
    };
    const actualDerivationPredicates = deriveGate
      ? flattenOrExpressions(deriveGate.expression).map((expression) => compact(expression)).sort()
      : [];
    const expectedDerivationStatements = [
      "capacity.batchSlots>live.batch",
      "capacity.browserSessionSlots>live.browserSession",
      "capacity.serviceSlots>live.service",
    ];
    const minCapacityDeclaration = topLevelCriticalFunction("minCapacity");
    const minCapacityStatements = minCapacityDeclaration?.body?.statements ?? [];
    const minCapacityReturn = minCapacityStatements.length === 1 && ts.isReturnStatement(minCapacityStatements[0])
      ? minCapacityStatements[0]
      : null;
    const minCapacityFields = closedObjectProperties(minCapacityReturn?.expression);
    const capacityFields = [
      "batchSlots", "browserSessionSlots", "serviceSlots", "freeCpuMillis", "freeMemoryMiB",
      "freeDiskMiB",
    ];
    const exactMinCapacityHelper = Boolean(minCapacityDeclaration &&
      minCapacityDeclaration.parameters.length === 2 &&
      minCapacityDeclaration.parameters.every((parameter) => ts.isIdentifier(parameter.name)) &&
      minCapacityDeclaration.parameters.map((parameter) =>
        (parameter.name as ts.Identifier).text).join(",") === "left,right" &&
      minCapacityFields && [...minCapacityFields.keys()].sort().join(",") ===
        [...capacityFields].sort().join(",") && capacityFields.every((field) =>
        compact(minCapacityFields.get(field)) === `Math.min(left.${field},right.${field})`));
    const exactEffectiveCapacity = Boolean(effectiveCapacityBinding && effectiveCapacityCall &&
      callPath(effectiveCapacityCall) === "minCapacity" && effectiveCapacityCall.arguments.length === 2 &&
      pathOf(effectiveCapacityCall.arguments[0])?.join(".") === `${parseName}.data.capacity` &&
      pathOf(effectiveCapacityCall.arguments[1])?.join(".") === "parsedRequest.capacity" &&
      exactMinCapacityHelper);
    const exactLiveCapacity = Boolean(liveCapacityBinding && liveCapacityCall &&
      liveCapacityCalls.length === 1 && liveCapacityCalls[0] === liveCapacityCall &&
      isAwaitedCall(liveCapacityCall) &&
      liveCapacityInput && [...liveCapacityInput.keys()].sort().join(",") === "targetId,workerId" &&
      pathOf(liveCapacityInput.get("workerId"))?.join(".") === `${pollInputName}.auth.workerId` &&
      pathOf(liveCapacityInput.get("targetId"))?.join(".") === `${targetName}.targetId` &&
      liveCapacityBinding.statement.getStart(file) >
        (commonAuthorityReject?.getStart(file) ?? Number.MAX_SAFE_INTEGER));
    const providerDemandBinding = directBinding(tenantBody, "providerDemand");
    const providerDemandCall = providerDemandBinding ? unwrappedCall(providerDemandBinding.initializer) : null;
    const providerDemandDeclaration = topLevelCriticalFunction("normalizedProviderDemand");
    const providerDemandParameter = providerDemandDeclaration?.parameters.length === 1 &&
        ts.isIdentifier(providerDemandDeclaration.parameters[0]!.name)
      ? providerDemandDeclaration.parameters[0]!.name.text
      : null;
    const providerDemandStatements = providerDemandDeclaration?.body?.statements ?? [];
    const providerDeclaration = providerDemandStatements[0] && ts.isVariableStatement(providerDemandStatements[0])
      ? providerDemandStatements[0].declarationList.declarations[0]
      : null;
    const supportedDeclaration = providerDemandStatements[1] && ts.isVariableStatement(providerDemandStatements[1])
      ? providerDemandStatements[1].declarationList.declarations[0]
      : null;
    const operationsDeclaration = providerDemandStatements[2] && ts.isVariableStatement(providerDemandStatements[2])
      ? providerDemandStatements[2].declarationList.declarations[0]
      : null;
    const providerDemandReturn = providerDemandStatements[3] && ts.isReturnStatement(providerDemandStatements[3])
      ? providerDemandStatements[3]
      : null;
    const providerDemandInput = closedObjectProperties(providerDemandReturn?.expression);
    const providerResources = providerDemandInput
      ? closedObjectProperties(providerDemandInput.get("resources"))
      : null;
    const exactProviderDemand = Boolean(providerDemandBinding && providerDemandCall &&
      providerDemandBinding.statement.getStart(file) < (liveCapacityBinding?.statement.getStart(file) ?? -1) &&
      ts.isIdentifier(providerDemandCall.expression) &&
      providerDemandCall.expression.text === "normalizedProviderDemand" &&
      providerDemandCall.arguments.length === 1 &&
      pathOf(providerDemandCall.arguments[0])?.join(".") === targetName &&
      providerDemandParameter === "target" && providerDemandStatements.length === 4 &&
      providerDeclaration && ts.isIdentifier(providerDeclaration.name) && providerDeclaration.name.text === "provider" &&
      pathOf(providerDeclaration.initializer)?.join(".") === "target.providerConstraintProfile" &&
      supportedDeclaration && ts.isIdentifier(supportedDeclaration.name) &&
      supportedDeclaration.name.text === "supported" &&
      compact(supportedDeclaration.initializer) === "newSet(provider.supportedOperations)" &&
      operationsDeclaration && ts.isIdentifier(operationsDeclaration.name) &&
      operationsDeclaration.name.text === "operations" &&
      compact(operationsDeclaration.initializer) ===
        '["create","execute"].filter((operation)=>supported.has(operation))' &&
      providerDemandInput && [...providerDemandInput.keys()].sort().join(",") ===
        "concurrentOperations,localityTags,maxIdleSeconds,maxRuntimeSeconds,operations,resources" &&
      providerResources && [...providerResources.keys()].sort().join(",") ===
        "cpuMillis,diskMiB,memoryMiB,pids" &&
      compact(providerDemandInput.get("maxRuntimeSeconds")) ===
        "Math.min(600,provider.maxContinuousRuntimeSeconds)" &&
      compact(providerDemandInput.get("maxIdleSeconds")) === "Math.min(60,provider.maxIdleSeconds)" &&
      compact(providerResources.get("cpuMillis")) === "Math.min(1000,provider.resourceCeiling.cpuMillis)" &&
      compact(providerResources.get("memoryMiB")) === "Math.min(1024,provider.resourceCeiling.memoryMiB)" &&
      compact(providerResources.get("pids")) === "Math.min(128,provider.resourceCeiling.pids)" &&
      compact(providerResources.get("diskMiB")) === "Math.min(1024,provider.resourceCeiling.diskMiB)" &&
      compact(providerDemandInput.get("concurrentOperations")) ===
        "Math.min(1,provider.maxConcurrentOperations)" &&
      pathOf(providerDemandInput.get("operations"))?.join(".") === "operations" &&
      compact(providerDemandInput.get("localityTags")) === "provider.localityTags.slice(0,1)");
    const exactDerivation = Boolean(deriveBinding?.statement.parent === serviceBody && deriveHelper &&
      deriveParameters.join(",") === "capacity,live,provider,demand" && deriveStatements.length === 6 &&
      deriveGate && !deriveGate.elseStatement &&
      actualDerivationPredicates.join("|") === requiredDerivationPredicates.join("|") &&
      compact(deriveGate.thenStatement) === "return[];" &&
      expectedDerivationStatements.every((predicate, index) =>
        compact(deriveStatements[index + 2]).startsWith(`if(${predicate})workloadTypes.push(`)) &&
      compact(deriveStatements[1]) === "constworkloadTypes:string[]=[];" &&
      compact(deriveStatements[5]) === "returnworkloadTypes;" &&
      directCalls("deriveAdmissibleWorkloadTypes").length === 1 && admissibleCall &&
      ts.isIdentifier(admissibleCall.expression) &&
      admissibleCall.expression.text === "deriveAdmissibleWorkloadTypes" &&
      admissibleCall.arguments.length === 4 &&
      pathOf(admissibleCall.arguments[0])?.join(".") === "effectiveCapacity" &&
      pathOf(admissibleCall.arguments[1])?.join(".") === "liveCapacity" &&
      pathOf(admissibleCall.arguments[2])?.join(".") ===
        `${targetName}.providerConstraintProfile` &&
      pathOf(admissibleCall.arguments[3])?.join(".") === "providerDemand");
    let dynamicBindingWritten = false;
    const auditDynamicBindingWrites = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          ["effectiveCapacity", "liveCapacity", admissibleName].includes(pathOf(node.left)?.[0] ?? null)) {
        dynamicBindingWritten = true;
      }
      ts.forEachChild(node, auditDynamicBindingWrites);
    };
    auditDynamicBindingWrites(tenantBody);
    if (!admissibleBinding || admissibleBinding.statement.getStart(file) >= candidate.getStart(file) ||
        !exactEffectiveCapacity || !exactProviderDemand || !exactLiveCapacity ||
        !exactDerivation || dynamicBindingWritten) {
      violations.add("candidate:dynamic-admissible-workload-source");
    }
    if (candidateBinding) {
      const preceding = tenantBody.statements.filter((statement) =>
        statement.getStart(file) < candidateBinding.statement.getStart(file));
      const allowedValidationPaths = new Set<string>([
        authorityName ?? "<missing-authority>",
        commonAuthorityName ?? "<missing-common-authority>",
        parseName ? `${parseName}.success` : "<missing-parse>",
        targetName ?? "<missing-target>",
      ]);
      const auditedValidationBranches = new Set<ts.IfStatement>();
      for (const statement of preceding) {
        if (!ts.isIfStatement(statement) || statement.elseStatement ||
            !directlyThrows(statement.thenStatement)) continue;
        if ([...allowedValidationPaths].some((path) => conditionRejects(statement.expression, path))) {
          auditedValidationBranches.add(statement);
        }
      }
      let bypassesCanonicalChain = false;
      const auditPreChainControl = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node)) bypassesCanonicalChain = true;
        if (ts.isThrowStatement(node)) {
          let owner: ts.Node | undefined = node.parent;
          while (owner && owner.parent !== tenantBody) owner = owner.parent;
          if (!owner || !ts.isIfStatement(owner) || !auditedValidationBranches.has(owner)) {
            bypassesCanonicalChain = true;
          }
        }
        ts.forEachChild(node, auditPreChainControl);
      };
      for (const statement of preceding) auditPreChainControl(statement);
      if (bypassesCanonicalChain) {
        violations.add("candidate:canonical-chain-dominates-return");
      }
      const candidateName = ts.isIdentifier(candidateBinding.declaration.name)
        ? candidateBinding.declaration.name.text
        : candidateArrayName;
      if (candidateName) canonicalCandidateTaintNames.add(candidateName);
      const laterStatements = tenantBody.statements.filter((statement) =>
        statement.getStart(file) > candidateBinding.statement.getStart(file));
      const candidateLoops = laterStatements.filter((statement): statement is ts.ForOfStatement =>
        ts.isForOfStatement(statement) && pathOf(statement.expression)?.join(".") === candidateName);
      const evaluationCalls: ts.CallExpression[] = [];
      const offerLeaseCalls: ts.CallExpression[] = [];
      const upsertCalls: ts.CallExpression[] = [];
      const tryOfferCalls: ts.CallExpression[] = [];
      let inventedCandidateSurface = false;
      const collectEvaluationCalls = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
            node.expression.text === "evaluateStaticLeaseEligibility") evaluationCalls.push(node);
        if (ts.isCallExpression(node) && callPath(node) === `${reposName}.jobControl.offerLease`) {
          offerLeaseCalls.push(node);
        }
        if (ts.isCallExpression(node) &&
            callPath(node) === `${reposName}.jobControl.upsertLeaseRejectionCertificates`) upsertCalls.push(node);
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
            node.expression.text === "tryOffer") tryOfferCalls.push(node);
        if (ts.isIdentifier(node) && node.text === "evaluateCandidate" ||
            ts.isPropertyAccessExpression(node) &&
            ["staticEligible", "offerCandidate"].includes(node.name.text)) inventedCandidateSurface = true;
        ts.forEachChild(node, collectEvaluationCalls);
      };
      collectEvaluationCalls(tenantBody);
      let auditedCandidateLoop = false;
      if (candidateLoops.length === 1 && candidateName) {
        const loop = candidateLoops[0]!;
        const loopDeclaration = ts.isVariableDeclarationList(loop.initializer) &&
            loop.initializer.declarations.length === 1
          ? loop.initializer.declarations[0]!
          : null;
        const loopCandidateName = loopDeclaration && ts.isIdentifier(loopDeclaration.name)
          ? loopDeclaration.name.text
          : null;
        const loopBody = ts.isBlock(loop.statement) ? loop.statement : null;
        const statements = loopBody?.statements ?? [];
        const normalizedDeclaration = statements[0] && ts.isVariableStatement(statements[0]) &&
            statements[0].declarationList.declarations.length === 1
          ? statements[0].declarationList.declarations[0]!
          : null;
        const normalizedName = normalizedDeclaration && ts.isIdentifier(normalizedDeclaration.name)
          ? normalizedDeclaration.name.text
          : null;
        const normalizedCall = normalizedDeclaration ? unwrappedCall(normalizedDeclaration.initializer) : null;
        const normalizedReject = statements[1] && ts.isIfStatement(statements[1]) ? statements[1] : null;
        const evaluationDeclaration = statements[2] && ts.isVariableStatement(statements[2]) &&
            statements[2].declarationList.declarations.length === 1
          ? statements[2].declarationList.declarations[0]!
          : null;
        const evaluationName = evaluationDeclaration && ts.isIdentifier(evaluationDeclaration.name)
          ? evaluationDeclaration.name.text
          : null;
        const evaluationCall = evaluationDeclaration ? unwrappedCall(evaluationDeclaration.initializer) : null;
        const evaluationInput = evaluationCall?.arguments.length === 1
          ? closedObjectProperties(evaluationCall.arguments[0])
          : null;
        const staticNegative = statements[3] && ts.isIfStatement(statements[3]) ? statements[3] : null;
        const staticNegativeBody = staticNegative && ts.isBlock(staticNegative.thenStatement)
          ? staticNegative.thenStatement
          : null;
        const negativeStatements = staticNegativeBody?.statements ?? [];
        const reasonReject = negativeStatements[0] && ts.isIfStatement(negativeStatements[0])
          ? negativeStatements[0]
          : null;
        const negativePushStatement = negativeStatements[1] && ts.isExpressionStatement(negativeStatements[1])
          ? negativeStatements[1]
          : null;
        const negativePush = negativePushStatement
          ? unwrappedCall(negativePushStatement.expression)
          : null;
        const negativeInput = negativePush?.arguments.length === 1
          ? closedObjectProperties(negativePush.arguments[0])
          : null;
        const flushBeforeOffer = statements[4] && ts.isIfStatement(statements[4])
          ? statements[4]
          : null;
        // The guarded flush runs the certificate upsert either as a bare `await upsert(...)`
        // statement (legacy) or as the exact payload-free telemetry pair
        // `const upserted = await upsert(...); metrics.certificateUpsert({ count: upserted });`.
        // Only those two shapes yield the upsert call; exactFlush still fully validates it. Any other
        // statement in the block (or a mismatched telemetry emit) returns null → the flush fails.
        const flushUpsertCall = (flush: ts.IfStatement): ts.CallExpression | null => {
          const thenStatement = flush.thenStatement;
          const bodyStatements = ts.isBlock(thenStatement)
            ? [...thenStatement.statements]
            : [thenStatement];
          if (bodyStatements.length === 1) {
            const only = bodyStatements[0]!;
            return ts.isExpressionStatement(only) ? unwrappedCall(only.expression) : null;
          }
          if (bodyStatements.length === 2 && ts.isVariableStatement(bodyStatements[0]!) &&
              (bodyStatements[0]!.declarationList.flags & ts.NodeFlags.Const) &&
              bodyStatements[0]!.declarationList.declarations.length === 1 &&
              ts.isExpressionStatement(bodyStatements[1]!)) {
            const declaration = bodyStatements[0]!.declarationList.declarations[0]!;
            const countName = ts.isIdentifier(declaration.name) ? declaration.name.text : null;
            const upsertCall = unwrappedCall(declaration.initializer);
            const emitCall = unwrappedCall(bodyStatements[1]!.expression);
            const emitInput = emitCall?.arguments.length === 1
              ? closedObjectProperties(emitCall.arguments[0])
              : null;
            if (countName && upsertCall && emitCall &&
                callPath(emitCall) === "metrics.certificateUpsert" && emitInput &&
                [...emitInput.keys()].join(",") === "count" &&
                pathOf(emitInput.get("count"))?.join(".") === countName) {
              return upsertCall;
            }
            return null;
          }
          return null;
        };
        const flushBeforeOfferCall = flushBeforeOffer ? flushUpsertCall(flushBeforeOffer) : null;
        const offeredDeclaration = statements[5] && ts.isVariableStatement(statements[5]) &&
            statements[5].declarationList.declarations.length === 1
          ? statements[5].declarationList.declarations[0]!
          : null;
        const offeredName = offeredDeclaration && ts.isIdentifier(offeredDeclaration.name)
          ? offeredDeclaration.name.text
          : null;
        const offerCall = offeredDeclaration ? unwrappedCall(offeredDeclaration.initializer) : null;
        const restart = statements[6] && ts.isIfStatement(statements[6]) ? statements[6] : null;
        const restartThrow = restart
          ? ts.isThrowStatement(restart.thenStatement)
            ? restart.thenStatement.expression
            : ts.isBlock(restart.thenStatement) && restart.thenStatement.statements.length === 1 &&
                ts.isThrowStatement(restart.thenStatement.statements[0]!)
              ? restart.thenStatement.statements[0]!.expression
              : null
          : null;
        const restartError = restartThrow && ts.isNewExpression(unwrap(restartThrow)!)
          ? unwrap(restartThrow) as ts.NewExpression
          : null;
        const offeredReturn = statements[7] && ts.isReturnStatement(statements[7])
          ? statements[7]
          : null;
        const certificateBinding = directBinding(tenantBody, "staticNegativeCertificates");
        const certificateInitializer = certificateBinding ? unwrap(certificateBinding.initializer) : null;
        const loopIndex = tenantBody.statements.indexOf(loop);
        const flushAfterLoop = loopIndex >= 0 && tenantBody.statements[loopIndex + 1] &&
            ts.isIfStatement(tenantBody.statements[loopIndex + 1]!)
          ? tenantBody.statements[loopIndex + 1] as ts.IfStatement
          : null;
        const flushAfterLoopCall = flushAfterLoop ? flushUpsertCall(flushAfterLoop) : null;
        const noWorkReturn = loopIndex >= 0 && ts.isReturnStatement(tenantBody.statements[loopIndex + 2]!)
          ? tenantBody.statements[loopIndex + 2] as ts.ReturnStatement
          : null;
        const noWorkCall = noWorkReturn ? unwrappedCall(noWorkReturn.expression) : null;
        const noWorkInput = noWorkCall?.arguments.length === 1
          ? closedObjectProperties(noWorkCall.arguments[0])
          : null;
        const readySignalBinding = directBinding(pollMethod.body!, "readySignaled");
        const readySignalExpression = readySignalBinding
          ? unwrap(readySignalBinding.initializer)
          : null;
        const readySignalCall = readySignalExpression && ts.isBinaryExpression(readySignalExpression) &&
            readySignalExpression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
          ? unwrappedCall(readySignalExpression.left)
          : null;
        let readySignalUses = 0;
        const countReadySignalUses = (node: ts.Node): void => {
          if (ts.isIdentifier(node) && node.text === "readySignaled") readySignalUses += 1;
          ts.forEachChild(node, countReadySignalUses);
        };
        countReadySignalUses(pollMethod);
        const exactReadySignal = Boolean(readySignalBinding && readySignalExpression &&
          ts.isBinaryExpression(readySignalExpression) &&
          unwrap(readySignalExpression.right)?.kind === ts.SyntaxKind.FalseKeyword &&
          readySignalCall && callPath(readySignalCall) === `${serviceInputName}.scheduler.consume` &&
          readySignalCall.arguments.length === 2 &&
          pathOf(readySignalCall.arguments[0])?.join(".") === `${pollInputName}.auth.organizationId` &&
          pathOf(readySignalCall.arguments[1])?.join(".") === `${pollInputName}.auth.targetId` &&
          readySignalUses === 2);
        const tryOfferBinding = directBinding(tenantBody, "tryOffer");
        const tryOfferExpression = tryOfferBinding ? unwrap(tryOfferBinding.initializer) : null;
        const tryOfferHelper = tryOfferExpression &&
            (ts.isArrowFunction(tryOfferExpression) || ts.isFunctionExpression(tryOfferExpression)) &&
            ts.isBlock(tryOfferExpression.body)
          ? tryOfferExpression
          : null;
        const tryOfferParameter = tryOfferHelper?.parameters.length === 2 &&
            ts.isIdentifier(tryOfferHelper.parameters[0]!.name)
          ? tryOfferHelper.parameters[0]!.name.text
          : null;
        const tryOfferNormalizedParameter = tryOfferHelper?.parameters.length === 2 &&
            ts.isIdentifier(tryOfferHelper.parameters[1]!.name)
          ? tryOfferHelper.parameters[1]!.name.text
          : null;
        const tryOfferStatements = tryOfferHelper?.body.statements ?? [];
        const declarationAt = (index: number): ts.VariableDeclaration | null =>
          tryOfferStatements[index] && ts.isVariableStatement(tryOfferStatements[index]!) &&
            (tryOfferStatements[index] as ts.VariableStatement).declarationList.declarations.length === 1
            ? (tryOfferStatements[index] as ts.VariableStatement).declarationList.declarations[0]!
            : null;
        const ackDeadlineDeclaration = declarationAt(0);
        const expiresAtDeclaration = declarationAt(1);
        // DAT-008 — the job's ACTIVE execution-secret handles are read inside this
        // same tenant transaction, immediately before the envelope that advertises
        // them, so a concurrently revoked handle cannot be advertised from a stale
        // read. Pinned positionally like every other statement in this chain.
        const storedHandlesDeclaration = declarationAt(2);
        const storedHandlesName = storedHandlesDeclaration && ts.isIdentifier(storedHandlesDeclaration.name)
          ? storedHandlesDeclaration.name.text
          : null;
        const storedHandlesCall = storedHandlesDeclaration
          ? unwrappedCall(storedHandlesDeclaration.initializer)
          : null;
        const storedHandlesInput = storedHandlesCall?.arguments.length === 1
          ? closedObjectProperties(storedHandlesCall.arguments[0])
          : null;
        // CLI-008 Unit B — this attempt's staged-input pointers are rebuilt from the DURABLE
        // job_artifacts rows inside the SAME tenant transaction that offers the lease, so the
        // envelope cannot advertise a pointer from a stale read (and a stage that has not
        // committed yet simply is not advertised). Pinned positionally like every other
        // statement in this chain.
        const stagedInputDeclaration = declarationAt(3);
        const stagedInputName = stagedInputDeclaration && ts.isIdentifier(stagedInputDeclaration.name)
          ? stagedInputDeclaration.name.text
          : null;
        const stagedInputCall = stagedInputDeclaration
          ? unwrappedCall(stagedInputDeclaration.initializer)
          : null;
        const jobEnvelopeDeclaration = declarationAt(4);
        const jobEnvelopeName = jobEnvelopeDeclaration && ts.isIdentifier(jobEnvelopeDeclaration.name)
          ? jobEnvelopeDeclaration.name.text
          : null;
        const jobEnvelopeCall = jobEnvelopeDeclaration
          ? unwrappedCall(jobEnvelopeDeclaration.initializer)
          : null;
        const jobEnvelopeInput = jobEnvelopeCall?.arguments.length === 1
          ? closedObjectProperties(jobEnvelopeCall.arguments[0])
          : null;
        const jobEnvelopeReject = tryOfferStatements[5] && ts.isIfStatement(tryOfferStatements[5])
          ? tryOfferStatements[5]
          : null;
        const fenceDeclaration = declarationAt(6);
        const leaseDeclaration = declarationAt(7);
        const ackDeadlineName = ackDeadlineDeclaration && ts.isIdentifier(ackDeadlineDeclaration.name)
          ? ackDeadlineDeclaration.name.text
          : null;
        const expiresAtName = expiresAtDeclaration && ts.isIdentifier(expiresAtDeclaration.name)
          ? expiresAtDeclaration.name.text
          : null;
        const fenceName = fenceDeclaration && ts.isIdentifier(fenceDeclaration.name)
          ? fenceDeclaration.name.text
          : null;
        const leaseName = leaseDeclaration && ts.isIdentifier(leaseDeclaration.name)
          ? leaseDeclaration.name.text
          : null;
        const offerLeaseCall = leaseDeclaration ? unwrappedCall(leaseDeclaration.initializer) : null;
        const offerLeaseInput = offerLeaseCall?.arguments.length === 1
          ? closedObjectProperties(offerLeaseCall.arguments[0])
          : null;
        const leaseReject = tryOfferStatements[8] && ts.isIfStatement(tryOfferStatements[8])
          ? tryOfferStatements[8]
          : null;
        const offerDeclaration = declarationAt(9);
        const offerName = offerDeclaration && ts.isIdentifier(offerDeclaration.name)
          ? offerDeclaration.name.text
          : null;
        const leaseOfferCall = offerDeclaration ? unwrappedCall(offerDeclaration.initializer) : null;
        const leaseOfferInput = leaseOfferCall?.arguments.length === 1
          ? closedObjectProperties(leaseOfferCall.arguments[0])
          : null;
        const protocolReturn = tryOfferStatements[10] && ts.isReturnStatement(tryOfferStatements[10])
          ? tryOfferStatements[10]
          : null;
        const protocolCall = protocolReturn ? unwrappedCall(protocolReturn.expression) : null;
        const protocolInput = protocolCall?.arguments.length === 1
          ? closedObjectProperties(protocolCall.arguments[0])
          : null;
        const exactTryOffer = Boolean(tryOfferBinding && tryOfferHelper && tryOfferParameter &&
          tryOfferNormalizedParameter === "normalized" && tryOfferStatements.length === 11 &&
          ackDeadlineName === "ackDeadline" &&
          expiresAtName === "expiresAt" && fenceName === "fence" &&
          compact(ackDeadlineDeclaration?.initializer) === "newDate(databaseNow.getTime()+ackTimeoutMs)" &&
          compact(expiresAtDeclaration?.initializer) === "newDate(databaseNow.getTime()+leaseDurationMs)" &&
          jobEnvelopeName === "jobEnvelope" && jobEnvelopeCall &&
          callPath(jobEnvelopeCall) === "buildJobEnvelope" && jobEnvelopeInput &&
          [...jobEnvelopeInput.keys()].sort().join(",") ===
            "attempt,databaseNow,job,leaseExpiresAt,requirements,resourceLimits,secretHandles,stagedInput,target" &&
          pathOf(jobEnvelopeInput.get("job"))?.join(".") === `${tryOfferParameter}.job` &&
          pathOf(jobEnvelopeInput.get("attempt"))?.join(".") === `${tryOfferParameter}.attempt` &&
          pathOf(jobEnvelopeInput.get("target"))?.join(".") === targetName &&
          pathOf(jobEnvelopeInput.get("requirements"))?.join(".") ===
            `${tryOfferNormalizedParameter}.requirements` &&
          pathOf(jobEnvelopeInput.get("resourceLimits"))?.join(".") === "providerDemand.resources" &&
          pathOf(jobEnvelopeInput.get("databaseNow"))?.join(".") === "databaseNow" &&
          pathOf(jobEnvelopeInput.get("leaseExpiresAt"))?.join(".") === expiresAtName &&
          storedHandlesName === "storedHandles" && storedHandlesCall &&
          isAwaitedCall(storedHandlesCall) &&
          callPath(storedHandlesCall) === `${reposName}.jobControl.listActiveExecutionSecretHandles` &&
          storedHandlesInput && [...storedHandlesInput.keys()].sort().join(",") === "jobId,organizationId" &&
          pathOf(storedHandlesInput.get("organizationId"))?.join(".") ===
            `${tryOfferParameter}.job.organizationId` &&
          pathOf(storedHandlesInput.get("jobId"))?.join(".") === `${tryOfferParameter}.job.id` &&
          compact(jobEnvelopeInput.get("secretHandles")) === `toSecretHandleRefs(${storedHandlesName})` &&
          // CLI-008 Unit B — one awaited, tenant-scoped read of THIS job's artifact rows, and
          // the envelope's `stagedInput` derived from exactly that binding and this candidate's
          // attempt number. Pinned so the pointer can never come from anywhere else — a
          // caller-supplied pointer would let the offer advertise bytes nobody committed.
          stagedInputName === "stagedInputRows" && stagedInputCall && isAwaitedCall(stagedInputCall) &&
          callPath(stagedInputCall) === `${reposName}.jobArtifacts.listForJob` &&
          stagedInputCall.arguments.length === 1 &&
          pathOf(stagedInputCall.arguments[0])?.join(".") === `${tryOfferParameter}.job.id` &&
          compact(jobEnvelopeInput.get("stagedInput")) ===
            `stagedInputPointersFromRows(${stagedInputName},${tryOfferParameter}.attempt.attemptNumber)` &&
          jobEnvelopeReject && !jobEnvelopeReject.elseStatement &&
          conditionRejects(jobEnvelopeReject.expression, jobEnvelopeName) &&
          directlyThrows(jobEnvelopeReject.thenStatement) &&
          compact(fenceDeclaration?.initializer) === 'randomBytes(32).toString("base64url")' &&
          offerLeaseCall && offerLeaseCalls.length === 1 &&
          offerLeaseCalls[0] === offerLeaseCall && isAwaitedCall(offerLeaseCall) &&
          callPath(offerLeaseCall) === `${reposName}.jobControl.offerLease` &&
          offerLeaseInput && [...offerLeaseInput.keys()].sort().join(",") ===
            "ackDeadline,attemptId,attemptNumber,companyId,createdAt,expiresAt,fence,jobId,organizationId,profileHash,providerConstraintHash,targetAuthorityKey,targetGeneration,targetId,workerId" &&
          pathOf(offerLeaseInput.get("attemptId"))?.join(".") === `${tryOfferParameter}.attempt.id` &&
          pathOf(offerLeaseInput.get("organizationId"))?.join(".") === `${tryOfferParameter}.job.organizationId` &&
          pathOf(offerLeaseInput.get("companyId"))?.join(".") === `${tryOfferParameter}.job.companyId` &&
          pathOf(offerLeaseInput.get("jobId"))?.join(".") === `${tryOfferParameter}.job.id` &&
          pathOf(offerLeaseInput.get("attemptNumber"))?.join(".") ===
            `${tryOfferParameter}.attempt.attemptNumber` &&
          pathOf(offerLeaseInput.get("workerId"))?.join(".") === `${pollInputName}.auth.workerId` &&
          pathOf(offerLeaseInput.get("targetId"))?.join(".") === `${targetName}.targetId` &&
          pathOf(offerLeaseInput.get("targetAuthorityKey"))?.join(".") ===
            `${authorityName}.worker.targetAuthorityKey` &&
          pathOf(offerLeaseInput.get("targetGeneration"))?.join(".") === `${targetName}.targetGeneration` &&
          pathOf(offerLeaseInput.get("profileHash"))?.join(".") === `${pollInputName}.auth.profileHash` &&
          pathOf(offerLeaseInput.get("providerConstraintHash"))?.join(".") ===
            `${targetName}.providerConstraintHash` &&
          pathOf(offerLeaseInput.get("fence"))?.join(".") === fenceName &&
          pathOf(offerLeaseInput.get("ackDeadline"))?.join(".") === ackDeadlineName &&
          pathOf(offerLeaseInput.get("expiresAt"))?.join(".") === expiresAtName &&
          pathOf(offerLeaseInput.get("createdAt"))?.join(".") === "databaseNow" &&
          leaseName && leaseReject && !leaseReject.elseStatement &&
          conditionRejects(leaseReject.expression, leaseName) &&
          (() => {
            const returned = ts.isReturnStatement(leaseReject.thenStatement)
              ? leaseReject.thenStatement.expression
              : ts.isBlock(leaseReject.thenStatement) && leaseReject.thenStatement.statements.length === 1 &&
                  ts.isReturnStatement(leaseReject.thenStatement.statements[0]!)
                ? leaseReject.thenStatement.statements[0]!.expression
                : null;
            return unwrap(returned ?? undefined)?.kind === ts.SyntaxKind.NullKeyword;
          })() && offerName === "offer" && leaseOfferCall &&
          callPath(leaseOfferCall) === "leaseOfferV1Schema.parse" && leaseOfferInput &&
          [...leaseOfferInput.keys()].sort().join(",") ===
            "ackDeadline,expiresAt,extensions,fenceToken,job,leaseId,protocolVersion,workerId" &&
          compact(leaseOfferInput.get("protocolVersion")) === "1" &&
          pathOf(leaseOfferInput.get("workerId"))?.join(".") === `${pollInputName}.auth.workerId` &&
          pathOf(leaseOfferInput.get("leaseId"))?.join(".") === `${leaseName}.id` &&
          pathOf(leaseOfferInput.get("fenceToken"))?.join(".") === fenceName &&
          compact(leaseOfferInput.get("ackDeadline")) === `${ackDeadlineName}.toISOString()` &&
          compact(leaseOfferInput.get("expiresAt")) === `${expiresAtName}.toISOString()` &&
          pathOf(leaseOfferInput.get("job"))?.join(".") === jobEnvelopeName &&
          ts.isArrayLiteralExpression(unwrap(leaseOfferInput.get("extensions"))!) &&
          (unwrap(leaseOfferInput.get("extensions")) as ts.ArrayLiteralExpression).elements.length === 0 &&
          protocolCall && callPath(protocolCall) === "pollResponseV1Schema.parse" &&
          protocolInput && [...protocolInput.keys()].sort().join(",") ===
            "body,correlationId,outcome,protocolVersion,serverTime" &&
          compact(protocolInput.get("protocolVersion")) === "1" &&
          pathOf(protocolInput.get("correlationId"))?.join(".") === "parsedRequest.correlationId" &&
          compact(protocolInput.get("serverTime")) === "databaseNow.toISOString()" &&
          ts.isStringLiteral(unwrap(protocolInput.get("outcome"))!) &&
          (unwrap(protocolInput.get("outcome")) as ts.StringLiteral).text === "offer" &&
          pathOf(protocolInput.get("body"))?.join(".") === offerName);
        const exactFlush = (flush: ts.IfStatement | null, call: ts.CallExpression | null): boolean => Boolean(
          flush && !flush.elseStatement && call && isAwaitedCall(call) &&
          callPath(call) === `${reposName}.jobControl.upsertLeaseRejectionCertificates` &&
          call.arguments.length === 1 &&
          pathOf(call.arguments[0])?.join(".") === "staticNegativeCertificates" &&
          flush.expression.getText(file).replace(/\s+/g, "") === "staticNegativeCertificates.length>0",
        );
        auditedCandidateLoop = Boolean(loopDeclaration &&
          (loop.initializer.flags & ts.NodeFlags.Const) && loopCandidateName && loopBody &&
          statements.length === 8 && normalizedName && normalizedCall &&
          callPath(normalizedCall) === "normalizedRequirements" && normalizedCall.arguments.length === 2 &&
          pathOf(normalizedCall.arguments[0])?.join(".") === `${loopCandidateName}.job` &&
          pathOf(normalizedCall.arguments[1])?.join(".") === targetName &&
          normalizedReject && !normalizedReject.elseStatement &&
          conditionRejects(normalizedReject.expression, normalizedName) &&
          directlyThrows(normalizedReject.thenStatement) && evaluationName && evaluationCall &&
          evaluationCalls.length === 1 && evaluationCalls[0] === evaluationCall &&
          ts.isIdentifier(evaluationCall.expression) &&
          evaluationCall.expression.text === "evaluateStaticLeaseEligibility" &&
          evaluationInput && [...evaluationInput.keys()].sort().join(",") ===
            "requirements,target,verifiedProviderConstraints,worker" &&
          pathOf(evaluationInput.get("target"))?.join(".") === `${targetName}.registeredProfile` &&
          pathOf(evaluationInput.get("verifiedProviderConstraints"))?.join(".") ===
            `${targetName}.providerConstraintProfile` &&
          pathOf(evaluationInput.get("worker"))?.join(".") === `${parseName}.data` &&
          pathOf(evaluationInput.get("requirements"))?.join(".") === `${normalizedName}.requirements` &&
          staticNegative && !staticNegative.elseStatement && staticNegativeBody &&
          staticNegative.expression.getText(file).replace(/\s+/g, "") === `!${evaluationName}.eligible` &&
          negativeStatements.length === 3 && reasonReject && !reasonReject.elseStatement &&
          reasonReject.expression.getText(file).replace(/\s+/g, "") ===
            `${evaluationName}.reasonCode!=="static_requirements_mismatch"` &&
          directlyThrows(reasonReject.thenStatement) && negativePush &&
          callPath(negativePush) === "staticNegativeCertificates.push" && negativeInput &&
          [...negativeInput.keys()].sort().join(",") === "candidate,reasonCode,staticContextHash" &&
          pathOf(negativeInput.get("candidate"))?.join(".") === loopCandidateName &&
          pathOf(negativeInput.get("reasonCode"))?.join(".") === `${evaluationName}.reasonCode` &&
          pathOf(negativeInput.get("staticContextHash"))?.join(".") === hashName &&
          ts.isContinueStatement(negativeStatements[2]!) && certificateBinding &&
          certificateBinding.statement.getStart(file) > candidateBinding.statement.getStart(file) &&
          certificateBinding.statement.getStart(file) < loop.getStart(file) &&
          certificateInitializer && ts.isArrayLiteralExpression(certificateInitializer) &&
          certificateInitializer.elements.length === 0 && upsertCalls.length === 2 &&
          exactFlush(flushBeforeOffer, flushBeforeOfferCall) &&
          exactFlush(flushAfterLoop, flushAfterLoopCall) &&
          offeredName && offerCall && tryOfferCalls.length === 1 && tryOfferCalls[0] === offerCall &&
          isAwaitedCall(offerCall) && ts.isIdentifier(offerCall.expression) &&
          offerCall.expression.text === "tryOffer" && offerCall.arguments.length === 2 &&
          pathOf(offerCall.arguments[0])?.join(".") === loopCandidateName &&
          pathOf(offerCall.arguments[1])?.join(".") === normalizedName && exactTryOffer &&
          restart && !restart.elseStatement && conditionRejects(restart.expression, offeredName) &&
          restartError && pathOf(restartError.expression)?.join(".") === "HeadRestartConflict" &&
          restartError.arguments?.length === 0 && offeredReturn &&
          pathOf(offeredReturn.expression)?.join(".") === offeredName && noWorkReturn && noWorkCall &&
          exactReadySignal &&
          callPath(noWorkCall) === "pollResponseV1Schema.parse" && noWorkInput &&
          [...noWorkInput.keys()].sort().join(",") ===
            "correlationId,outcome,protocolVersion,retryAfterMs,serverTime" &&
          compact(noWorkInput.get("protocolVersion")) === "1" &&
          pathOf(noWorkInput.get("correlationId"))?.join(".") === "parsedRequest.correlationId" &&
          compact(noWorkInput.get("serverTime")) === "databaseNow.toISOString()" &&
          ts.isStringLiteral(unwrap(noWorkInput.get("outcome"))!) &&
          (unwrap(noWorkInput.get("outcome")) as ts.StringLiteral).text === "no_work" &&
          compact(noWorkInput.get("retryAfterMs")) === "readySignaled?100:750" &&
          !inventedCandidateSurface);
        if (loopCandidateName) canonicalCandidateTaintNames.add(loopCandidateName);
        if (normalizedName) canonicalCandidateTaintNames.add(normalizedName);
        if (evaluationName) canonicalCandidateTaintNames.add(evaluationName);
        if (offeredName) canonicalCandidateTaintNames.add(offeredName);
        if (jobEnvelopeName) canonicalCandidateTaintNames.add(jobEnvelopeName);
        if (leaseName) canonicalCandidateTaintNames.add(leaseName);
        canonicalCandidateTaintNames.add("staticNegativeCertificates");
      }
      if (!candidateName || !auditedCandidateLoop) {
        violations.add("candidate:result-consumed-by-canonical-chain");
      }
    } else {
      violations.add("candidate:result-consumed-by-canonical-chain");
    }
    if (hashCall.getStart(file) >= candidate.getStart(file)) violations.add("candidate:after-context-hash");
  }

  const assigned = new Set<string>();
  const protectedContextNames = new Set(
    [...sourceNames, builderName, hashName, ...canonicalCandidateTaintNames,
      "admissibleWorkloadTypes", "currentAuthority", "databaseNow", "effectiveCapacity",
      "liveCapacity", "parsedRequest", "platformPhysicalHeartbeatAt", "providerDemand", pollInputName]
      .filter((value): value is string => Boolean(value)),
  );
  const allowedServiceOptionKeys = new Set([
    "ackTimeoutMs", "appDb", "leaseDurationMs", "maxHeartbeatAgeMs", "metrics", "operatorDb", "scheduler",
  ]);
  const rejectUnknownServiceOption = (name: string): void => {
    if (!allowedServiceOptionKeys.has(name)) violations.add("service:no-context-or-guard-injection");
  };
  const identifiersIn = (node: ts.Node): string[] => {
    const names: string[] = [];
    const scan = (current: ts.Node): void => {
      if (ts.isIdentifier(current)) names.push(current.text);
      ts.forEachChild(current, scan);
    };
    scan(node);
    return names;
  };
  const acquisitionStart = authorityBinding?.statement.getStart(file) ?? builderCall.getStart(file);
  let aliasAdded = true;
  while (aliasAdded) {
    aliasAdded = false;
    const discoverProtectedAliases = (node: ts.Node): void => {
      if (node.getStart(file) < acquisitionStart) {
        ts.forEachChild(node, discoverProtectedAliases);
        return;
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const root = pathOf(node.initializer)?.[0];
        if (root && protectedContextNames.has(root)) {
          const addBindingNames = (name: ts.BindingName): void => {
            if (ts.isIdentifier(name)) {
              if (!protectedContextNames.has(name.text)) {
                protectedContextNames.add(name.text);
                aliasAdded = true;
              }
              return;
            }
            for (const element of name.elements) {
              if (!ts.isOmittedExpression(element)) addBindingNames(element.name);
            }
          };
          addBindingNames(node.name);
        }
      }
      if (ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left)) {
        const root = pathOf(node.right)?.[0];
        if (root && protectedContextNames.has(root) &&
            !protectedContextNames.has(node.left.text)) {
          protectedContextNames.add(node.left.text);
          aliasAdded = true;
        }
      }
      ts.forEachChild(node, discoverProtectedAliases);
    };
    discoverProtectedAliases(tenantBody);
  }
  const mutatesProtected = (node: ts.Node): boolean =>
    identifiersIn(node).some((name) => protectedContextNames.has(name));
  const inspectProtectedMutations = (node: ts.Node): void => {
    if (node.getStart(file) < acquisitionStart) {
      ts.forEachChild(node, inspectProtectedMutations);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      if (ts.isIdentifier(node.left)) assigned.add(node.left.text);
      if (mutatesProtected(node.left)) {
        violations.add("binding:mutated-authority-or-context");
      }
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
        mutatesProtected(node.operand)) violations.add("binding:mutated-authority-or-context");
    if (ts.isDeleteExpression(node) && mutatesProtected(node.expression)) {
      violations.add("binding:mutated-authority-or-context");
    }
    if (ts.isCallExpression(node)) {
      const path = pathOf(node.expression)?.join(".");
      if (["Object.assign", "Object.defineProperty", "Reflect.set"].includes(path ?? "") &&
          node.arguments[0] && mutatesProtected(node.arguments[0])) {
        violations.add("binding:mutated-authority-or-context");
      }
      if (ts.isPropertyAccessExpression(node.expression) &&
          ["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"].includes(
            node.expression.name.text,
          ) && mutatesProtected(node.expression.expression) &&
          pathOf(node.expression)?.join(".") !== "staticNegativeCertificates.push") {
        violations.add("binding:mutated-authority-or-context");
      }
    }
    ts.forEachChild(node, inspectProtectedMutations);
  };
  inspectProtectedMutations(tenantBody);
  const allowedProtectedCalls = new Set<ts.CallExpression>([
    builderCall,
    hashCall,
    ...[authorityCall, guardCall, commonAuthorityCall, targetCall, parseCall, candidateCalls[0]].filter(
      (call): call is ts.CallExpression => Boolean(call),
    ),
  ]);
  const auditedProtectedCallPath = (call: ts.CallExpression): boolean => {
    const path = callPath(call);
    return [
      "authorityCurrent", "deriveAdmissibleWorkloadTypes", "evaluateStaticLeaseEligibility",
      // DE-18 slice 2 (Codex P2 on PR #448) — a PURE classifier that mirrors
      // `authorityCurrent`'s predicate to derive the failed conjunct(s) and the
      // audit crossing, so a non-generation authority-currency failure is not filed
      // under DE-18. It performs no IO, selects no repository, and cannot mutate the
      // authority context; registered here for the same reason `authorityCurrent` is.
      "pollAuthorityCurrencyIntent",
      // REL-004 clause 3a. A PURE decision over the locked, revalidated target's `kind` plus a
      // document read BEFORE the transaction opened: it adds no repository selection, performs
      // no IO, and cannot mutate the authority context. Reviewed and registered here for the
      // same reason `evaluateStaticLeaseEligibility` is — this list is a register of reviewed
      // calls, not a freeze. The `binding:protected-value-escape` guard still refuses anything
      // NOT on it, which `job-leasing-contract-guard.mutation` proves.
      "evaluateKillSwitches",
      "buildJobEnvelope", "leaseOfferV1Schema.parse", "Math.min", "minCapacity", "normalizedProviderDemand",
      "normalizedRequirements", "pollResponseV1Schema.parse",
      "staticNegativeCertificates.push", "tryOffer",
      `${reposName}.jobControl.offerLease`,
      `${reposName}.jobControl.snapshotLiveLeaseCapacity`,
      // DAT-008 — a tenant-scoped READ keyed on (organizationId, jobId), taken inside
      // the same transaction that offers the lease. It selects no authority row, writes
      // nothing, and returns only NON-SECRET handle references, so it cannot mutate or
      // launder the authority context. Registered here for the same reason the two reads
      // above are.
      `${reposName}.jobControl.listActiveExecutionSecretHandles`,
      // CLI-008 Unit B — the same shape and the same reasoning as the DAT-008 read above: a
      // tenant-scoped READ keyed on this candidate's jobId, taken inside the transaction that
      // offers the lease. It selects no authority row, writes nothing, and returns artifact
      // metadata only, so it cannot mutate or launder the authority context. The pure mapper
      // that turns those rows into pointers is registered with it — it touches the candidate
      // only to read `attempt.attemptNumber`, and `exactTryOffer` above pins both exactly.
      `${reposName}.jobArtifacts.listForJob`,
      "stagedInputPointersFromRows",
      `${reposName}.jobControl.upsertLeaseRejectionCertificates`,
    ].includes(path ?? "") || Boolean(path &&
      (path.endsWith(".getTime") || path === "databaseNow.toISOString"));
  };
  const containsProtectedReference = (node: ts.Node): boolean => {
    let found = false;
    const scan = (current: ts.Node): void => {
      if (ts.isFunctionLike(current)) return;
      if (ts.isIdentifier(current) && protectedContextNames.has(current.text)) {
        found = true;
        return;
      }
      ts.forEachChild(current, scan);
    };
    scan(node);
    return found;
  };
  const auditProtectedEscapes = (node: ts.Node): void => {
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !ts.isBlock(node.body) &&
        containsProtectedReference(node.body)) {
      const returnedPath = pathOf(node.body)?.join(".");
      const returnedCall = unwrappedCall(node.body);
      if (returnedPath !== "offered" && callPath(returnedCall) !== "pollResponseV1Schema.parse") {
        violations.add("binding:protected-value-escape");
      }
    }
    if (ts.isCallExpression(node)) {
      const hasProtectedArgument = node.arguments.some(containsProtectedReference);
      const protectedReceiver = containsProtectedReference(node.expression);
      if ((hasProtectedArgument || protectedReceiver) && !allowedProtectedCalls.has(node) &&
          !auditedProtectedCallPath(node)) {
        violations.add("binding:protected-value-escape");
      }
    }
    if (ts.isNewExpression(node) && node.arguments?.some(containsProtectedReference)) {
      if (pathOf(node.expression)?.join(".") !== "Date") {
        violations.add("binding:protected-value-escape");
      }
    }
    if (ts.isElementAccessExpression(node) && containsProtectedReference(node.expression)) {
      violations.add("binding:protected-value-escape");
    }
    if ((ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) &&
        containsProtectedReference(node)) {
      const parentCall = ts.isCallExpression(node.parent) ? node.parent : null;
      const parentPath = callPath(parentCall);
      const approvedContainer = node === sourceArgument ||
        Boolean(parentCall && [
          "authorityCurrent", "buildJobEnvelope", "buildLeaseStaticContextInput", "evaluateStaticLeaseEligibility",
          // REL-004 clause 3a — see the note in `auditedProtectedCallPath`.
          "evaluateKillSwitches",
          "leaseOfferV1Schema.parse", "pollResponseV1Schema.parse", "staticNegativeCertificates.push",
          `${reposName}.jobControl.lockEligibleLeaseCandidates`,
          `${reposName}.jobControl.lockWorkerLeaseAuthority`,
          `${reposName}.jobControl.offerLease`,
          `${reposName}.jobControl.snapshotLiveLeaseCapacity`,
          // DAT-008 — see the register note in `auditedProtectedCallPath`.
          `${reposName}.jobControl.listActiveExecutionSecretHandles`,
        ].includes(parentPath ?? ""));
      if (!approvedContainer) {
        violations.add("binding:protected-value-escape");
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
        containsProtectedReference(node.right)) {
      violations.add("binding:protected-value-escape");
    }
    if (ts.isReturnStatement(node) && node.expression && containsProtectedReference(node.expression)) {
      const returnedPath = pathOf(node.expression)?.join(".");
      const returnedCall = unwrappedCall(node.expression);
      if (returnedPath !== "offered" && callPath(returnedCall) !== "pollResponseV1Schema.parse") {
        violations.add("binding:protected-value-escape");
      }
    }
    ts.forEachChild(node, auditProtectedEscapes);
  };
  auditProtectedEscapes(tenantBody);
  for (const name of protectedContextNames) {
    if (assigned.has(name)) violations.add(`binding:reassigned:${name}`);
  }

  const serviceParameter = service.parameters[0];
  const inspectBindingHooks = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const boundName = propertyName(element.propertyName) ??
        (ts.isIdentifier(element.name) ? element.name.text : null);
      if (boundName) rejectUnknownServiceOption(boundName);
      inspectBindingHooks(element.name);
    }
  };
  if (serviceParameter && !ts.isIdentifier(serviceParameter.name)) {
    inspectBindingHooks(serviceParameter.name);
  }
  const inspectedTypes = new Set<ts.TypeNode>();
  const inspectServiceType = (type: ts.TypeNode | undefined): void => {
    if (!type || inspectedTypes.has(type)) return;
    inspectedTypes.add(type);
    if (ts.isTypeLiteralNode(type)) {
      for (const member of type.members) {
        if (!ts.isPropertySignature(member)) continue;
        const name = propertyName(member.name);
        if (name) rejectUnknownServiceOption(name);
      }
      return;
    }
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      for (const statement of file.statements) {
        if (ts.isInterfaceDeclaration(statement) && statement.name.text === type.typeName.text) {
          for (const member of statement.members) {
            if (!ts.isPropertySignature(member)) continue;
            const name = propertyName(member.name);
            if (name) rejectUnknownServiceOption(name);
          }
        } else if (ts.isTypeAliasDeclaration(statement) && statement.name.text === type.typeName.text) {
          inspectServiceType(statement.type);
        }
      }
      return;
    }
    if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
      for (const member of type.types) inspectServiceType(member);
    }
  };
  inspectServiceType(serviceParameter?.type);

  const serviceAliases = new Set<string>();
  if (serviceInputName) serviceAliases.add(serviceInputName);
  let serviceAliasAdded = true;
  while (serviceAliasAdded) {
    serviceAliasAdded = false;
    const discoverServiceAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializerPath = pathOf(node.initializer);
        if (initializerPath?.length === 1 && serviceAliases.has(initializerPath[0]!)) {
          if (ts.isIdentifier(node.name) && !serviceAliases.has(node.name.text)) {
            serviceAliases.add(node.name.text);
            serviceAliasAdded = true;
          } else if (!ts.isIdentifier(node.name)) {
            inspectBindingHooks(node.name);
          }
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left)) {
        const initializerPath = pathOf(node.right);
        if (initializerPath?.length === 1 && serviceAliases.has(initializerPath[0]!) &&
            !serviceAliases.has(node.left.text)) {
          serviceAliases.add(node.left.text);
          serviceAliasAdded = true;
        }
      }
      ts.forEachChild(node, discoverServiceAliases);
    };
    discoverServiceAliases(serviceBody);
  }
  const isServiceAliasExpression = (expression: ts.Expression | undefined): boolean => {
    const path = pathOf(expression);
    return Boolean(path?.length === 1 && serviceAliases.has(path[0]!));
  };
  const inspectServiceHookAccess = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isServiceAliasExpression(node.expression) &&
        !allowedServiceOptionKeys.has(node.name.text)) rejectUnknownServiceOption(node.name.text);
    if (ts.isElementAccessExpression(node) && isServiceAliasExpression(node.expression)) {
      violations.add("service:no-context-or-guard-injection");
    }
    if (ts.isVariableDeclaration(node) && node.initializer &&
        isServiceAliasExpression(node.initializer) && !ts.isIdentifier(node.name)) {
      inspectBindingHooks(node.name);
    }
    if (ts.isCallExpression(node) && pathOf(node.expression)?.join(".") === "Object.assign" &&
        node.arguments.some((argument) => isServiceAliasExpression(argument))) {
      violations.add("service:no-context-or-guard-injection");
    }
    ts.forEachChild(node, inspectServiceHookAccess);
  };
  inspectServiceHookAccess(serviceBody);
  if ([...serviceAliases].some((name) => name !== serviceInputName)) {
    violations.add("service:no-context-or-guard-injection");
  }
  const auditExactServiceInputUses = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === serviceInputName) {
      if (ts.isParameter(node.parent) && node.parent.name === node) return;
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node &&
          allowedServiceOptionKeys.has(node.parent.name.text)) return;
      violations.add("service:no-context-or-guard-injection");
    }
    ts.forEachChild(node, auditExactServiceInputUses);
  };
  auditExactServiceInputUses(serviceBody);
  return [...violations].sort();
}

describe("JOB-003 frozen worker-operation HTTP contract", () => {
  it("verifies the session and Ed25519 proof without opening a database transaction", () => {
    const signed = signedPoll();
    const verified = verifyWorkerOperationProof({
      sessionSigningKey: signed.sessionKey,
      authorization: signed.authorization,
      rawBody: signed.rawBody,
      proof: signed.proof,
      method: "POST",
      path: "/api/worker-control/poll",
      correlationId: signed.request.correlationId,
      now: signed.now,
    });
    expect(verified).toMatchObject({
      organizationId: "b3000000-0000-4000-8000-000000000003",
      workerId: signed.request.workerId,
      targetId: signed.request.targetId,
      targetGeneration: 3,
      profileHash: "9".repeat(64),
      proofId: "job-003-contract-proof",
    });
    expect(Object.keys(verified)).not.toContain("fenceToken");
  });

  it("binds proof to method/path/body/correlation and denies a copied bearer token", () => {
    const signed = signedPoll();
    const base = {
      sessionSigningKey: signed.sessionKey,
      authorization: signed.authorization,
      rawBody: signed.rawBody,
      proof: signed.proof,
      method: "POST",
      path: "/api/worker-control/poll",
      correlationId: signed.request.correlationId,
      now: signed.now,
    };
    expect(() => verifyWorkerOperationProof({ ...base, method: "PUT" })).toThrow(WorkerOperationProofError);
    expect(() => verifyWorkerOperationProof({ ...base, path: "/api/worker-control/lease-ack" })).toThrow(WorkerOperationProofError);
    expect(() => verifyWorkerOperationProof({ ...base, rawBody: Buffer.from("{}") })).toThrow(WorkerOperationProofError);
    expect(() => verifyWorkerOperationProof({
      ...base,
      proof: { ...signed.proof, signature: "copied-session-without-device-key" },
    })).toThrow(WorkerOperationProofError);
  });

  it("rejects the platform-scoped physical session before any tenant lookup", () => {
    const signed = signedPoll();
    const platformAuthorization = `Bearer ${createWorkerSessionToken(signed.sessionKey, {
      aud: "device_session",
      sub: signed.request.workerId,
      organizationId: null,
      targetId: signed.request.targetId,
      generation: 3,
      scope: "platform",
      deviceThumbprint: signed.deviceThumbprint,
      profileHash: "9".repeat(64),
      iat: Math.floor(signed.now.getTime() / 1000),
      exp: Math.floor((signed.now.getTime() + 10 * 60_000) / 1000),
    })}`;
    expect(() => verifyWorkerOperationProof({
      sessionSigningKey: signed.sessionKey,
      authorization: platformAuthorization,
      rawBody: signed.rawBody,
      proof: signed.proof,
      method: "POST",
      path: "/api/worker-control/poll",
      correlationId: signed.request.correlationId,
      now: signed.now,
    })).toThrow(WorkerOperationProofError);
  });

  it("uses only descriptor-allowed frozen poll errors with redacted detail", () => {
    const request = {
      body: { correlationId: randomUUID() },
      header: () => undefined,
    } as never;
    for (const code of OPERATION_DESCRIPTORS.poll.errors) {
      const error = workerOperationProtocolErrorV1(request, "poll", code, new Date());
      expect(protocolErrorV1Schema.parse(error)).toEqual(error);
      expect(error.detail).toEqual({});
      expect(error.redaction).toBe("secret");
    }
  });

  it("keeps worker routes behind the default-off distributed execution composition", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const flagBlock = source.slice(
      source.indexOf("if (opts.distributedExecutionEnabled)"),
      source.indexOf("// Settings -> Providers"),
    );
    expect(flagBlock).toContain("workerControlRoutes");
    expect(flagBlock).toContain("tenantAppDb");
    expect(flagBlock).toContain("operatorDb");
    expect(flagBlock).toContain("workerSessionSigningKey");
    expect(flagBlock).toContain("owner fallback is forbidden");
    expect(flagBlock).not.toContain("appDb: db");
  });

  it("binds the shared-platform enrollment guard to the exact outer production declaration", () => {
    const validModule = `function createWorkerEnrollmentService() {
      const requireCurrentPlatformPhysicalAuthority = async () => undefined;
      const completeEnrollment = async (authority: any, authoritativeOrganizationId: string | null) => {
        const sharedPlatformProfile = authoritativeOrganizationId !== null && target.scope === "platform";
        if (sharedPlatformProfile) {
          await requireCurrentPlatformPhysicalAuthority({ target });
        } else if (authoritativeOrganizationId === null && target.scope === "platform") {
          await acquirePlatformTargetAuthorityExclusive(authority, target.id);
        }
        await authority.advanceTargetGeneration();
        await authority.rotateWorker();
        await authority.insertWorker();
        await authority.retireBootstrapCredential();
      };
    }`;
    expect.soft(enrollmentAuthorityFlowViolations(validModule)).toEqual([]);
    expect.soft(enrollmentAuthorityFlowViolations(validModule.replace(
      "const sharedPlatformProfile =",
      "const requireCurrentPlatformPhysicalAuthority = async () => undefined; const sharedPlatformProfile =",
    ))).toContain("shared-platform-guard-binding");
    expect.soft(enrollmentAuthorityFlowViolations(validModule.replace(
      "await requireCurrentPlatformPhysicalAuthority({ target });",
      "await requireCurrentPlatformPhysicalAuthority({ target }); " +
        "function requireCurrentPlatformPhysicalAuthority() { return undefined; }",
    ))).toContain("shared-platform-guard-binding");
    expect.soft(enrollmentAuthorityFlowViolations(validModule.replace(
      "function createWorkerEnrollmentService() {\n      const requireCurrentPlatformPhysicalAuthority = async () => undefined;",
      'import { requireCurrentPlatformPhysicalAuthority } from "./fake-worker-authority.js";',
    ))).toContain("shared-platform-guard-binding");
  });

  it("discovers every exempt repository delegate call site and its promise observation", () => {
    const fixture = [{
      file: "server/src/services/delegate-fixture.ts",
      source: `async function guarded(authority: any) {
        await authority.rotateWorker({});
      }
      async function injectedUnguarded(repos: any) {
        repos.workerEnrollment.rotateWorker({});
      }
      async function returned(repos: any) {
        return repos.workerEnrollment.revokeTargetAuthority({});
      }
      async function computed(repos: any) {
        await repos.workerEnrollment["insertWorker"]({});
      }
      async function aliased(repos: any) {
        const { advanceTargetGeneration: advance } = repos.workerEnrollment;
        await advance({});
      }
      async function bound(repos: any) {
        const retire = repos.workerEnrollment.retireBootstrapCredential.bind(repos.workerEnrollment);
        await retire({});
      }
      async function called(repos: any) {
        const advance = repos.workerEnrollment.advanceTargetGeneration;
        await advance.call(repos.workerEnrollment, {});
      }
      async function appliedUnobserved(repos: any) {
        const rotate = repos.workerEnrollment.rotateWorker;
        rotate.apply(repos.workerEnrollment, [{}]);
      }
      async function shadowedCall(repos: any) {
        const rotate = repos.workerEnrollment.rotateWorker;
        {
          const rotate = () => undefined;
          await rotate.call(null, {});
        }
      }`,
    }];
    expect(repositoryDelegateCallSiteInventory(fixture)).toEqual([
      "server/src/services/delegate-fixture.ts#aliased:advanceTargetGeneration:awaited",
      "server/src/services/delegate-fixture.ts#appliedUnobserved:rotateWorker:unobserved",
      "server/src/services/delegate-fixture.ts#bound:retireBootstrapCredential:awaited",
      "server/src/services/delegate-fixture.ts#called:advanceTargetGeneration:awaited",
      "server/src/services/delegate-fixture.ts#computed:insertWorker:awaited",
      "server/src/services/delegate-fixture.ts#guarded:rotateWorker:awaited",
      "server/src/services/delegate-fixture.ts#injectedUnguarded:rotateWorker:unobserved",
      "server/src/services/delegate-fixture.ts#returned:revokeTargetAuthority:returned",
    ]);
  });

  it("requires the tenant placement-profile delegate to follow its awaited row lock and scope denial", () => {
    const validFlow = `async function ratifyTenantExecutionTargetPlacementProfile(input: any) {
      return runInTenant(input.appDb, input.organizationId, async (repos: any) => {
        const target = await repos.workerEnrollment.lockPlacementProfileTarget(input.executionTargetId);
        if (!target || target.organizationId !== input.organizationId || target.scope === "platform") {
          throw new Error("execution_target_not_found");
        }
        const updated = await repos.workerEnrollment.ratifyPlacementProfile({ executionTargetId: target.id });
        return updated;
      });
    }`;
    expect.soft(placementProfileDelegateFlowViolations(validFlow)).toEqual([]);
    expect.soft(placementProfileDelegateFlowViolations(validFlow.replace(
      "const target = await repos.workerEnrollment.lockPlacementProfileTarget(input.executionTargetId);",
      "const target = repos.workerEnrollment.lockPlacementProfileTarget(input.executionTargetId);",
    ))).toContain("placement-profile-lock");
    expect.soft(placementProfileDelegateFlowViolations(validFlow.replace(
      "const target = await repos.workerEnrollment.lockPlacementProfileTarget(input.executionTargetId);",
      "let target; try { target = await repos.workerEnrollment.lockPlacementProfileTarget(input.executionTargetId); throw failure; } catch {}",
    ))).toContain("placement-profile-lock");
    expect.soft(placementProfileDelegateFlowViolations(validFlow.replace(
      "const updated = await repos.workerEnrollment.ratifyPlacementProfile",
      "const updated = repos.workerEnrollment.ratifyPlacementProfile",
    ))).toContain("ratifyPlacementProfile:observation");
    expect.soft(placementProfileDelegateFlowViolations(validFlow.replace(
      ' || target.scope === "platform"',
      "",
    ))).toContain("placement-profile-scope-denial");
  });

  it("requires the placement decision writer's exact one-shot null predicate", () => {
    const validWriter = `import { and, eq, isNull } from "drizzle-orm";
    const repository = {
      async persistPlacementDecision(input: any) {
        const currentOwnerAuthority = eq(ownerAuthority.current, input.currentOwnerAuthority);
        return tx.update(jobAttempts).set({ placementDecidedAt: input.placementDecidedAt }).where(and(
          eq(jobAttempts.organizationId, input.organizationId),
          eq(jobAttempts.companyId, input.companyId),
          eq(jobAttempts.jobId, input.jobId),
          eq(jobAttempts.id, input.attemptId),
          isNull(jobAttempts.placementDecidedAt),
          currentOwnerAuthority,
        ));
      },
    };`;
    expect.soft(persistPlacementDecisionWhereConjuncts(validWriter)).toEqual(exactPlacementDecisionWhereConjuncts);
    expect.soft(persistPlacementDecisionPredicateViolations(validWriter)).toEqual([]);
    expect.soft(persistPlacementDecisionPredicateViolations(validWriter.replace(
      "          isNull(jobAttempts.placementDecidedAt),\n",
      "",
    ))).toEqual(["persistPlacementDecision:one-shot-predicate"]);
    expect.soft(persistPlacementDecisionPredicateViolations(validWriter.replace(
      "isNull(jobAttempts.placementDecidedAt)",
      "isNotNull(jobAttempts.placementDecidedAt)",
    ))).toEqual(["persistPlacementDecision:one-shot-predicate"]);
    expect.soft(persistPlacementDecisionPredicateViolations(validWriter.replace(
      'import { and, eq, isNull } from "drizzle-orm";',
      'import { and, eq } from "drizzle-orm"; import { isNull } from "./fake-drizzle.js";',
    ))).toEqual(["persistPlacementDecision:one-shot-predicate"]);
    expect.soft(persistPlacementDecisionPredicateViolations(validWriter.replace(
      "const currentOwnerAuthority =",
      "const isNull = () => true; const currentOwnerAuthority =",
    ))).toEqual(["persistPlacementDecision:one-shot-predicate"]);
    expect.soft(persistPlacementDecisionPredicateViolations(validWriter.replace(
      "const currentOwnerAuthority =",
      "const eq = () => true; const currentOwnerAuthority =",
    ))).toEqual(["persistPlacementDecision:one-shot-predicate"]);
    expect.soft(persistPlacementDecisionPredicateViolations(validWriter.replace(
      "eq(ownerAuthority.current, input.currentOwnerAuthority)",
      "undefined",
    ))).toEqual(["persistPlacementDecision:one-shot-predicate"]);
    expect.soft(persistPlacementDecisionPredicateViolations(validWriter.replace(
      "eq(ownerAuthority.current, input.currentOwnerAuthority)",
      "input.enforceOwner ? eq(ownerAuthority.current, input.currentOwnerAuthority) : undefined",
    ))).toEqual(["persistPlacementDecision:one-shot-predicate"]);
    const decoyWriter = `const repository = {
      async persistPlacementDecision(input: any) {
        const currentOwnerAuthority = undefined;
        await tx.update(jobAttempts).set({ placementDecidedAt: input.placementDecidedAt }).where(and(
          eq(jobAttempts.organizationId, input.organizationId)
        ));
        return audit.update(jobAttempts).where(and(
          eq(jobAttempts.organizationId, input.organizationId),
          eq(jobAttempts.companyId, input.companyId),
          eq(jobAttempts.jobId, input.jobId),
          eq(jobAttempts.id, input.attemptId),
          isNull(jobAttempts.placementDecidedAt),
          currentOwnerAuthority,
        ));
      },
    };`;
    expect.soft(persistPlacementDecisionPredicateViolations(decoyWriter)).toEqual([
      "persistPlacementDecision:one-shot-predicate",
    ]);
  });

  it("binds the combined platform-authority guard to the protected transaction and target", () => {
    const importedFactory = `import { operatorJobLeasingRepository } from "@armyofagents/db";\n`;
    const valid = importedFactory + `async function guarded(tx: any, targetId: string) {
      await operatorJobLeasingRepository(tx).lockPlatformAuthorityForMutation(targetId);
      await tx.update(executionTargets).set({ status: "offline" })
        .where(eq(executionTargets.id, targetId));
    }`;
    const otherTransaction = valid.replace(
      "operatorJobLeasingRepository(tx)",
      "operatorJobLeasingRepository(otherTx)",
    );
    const otherTarget = valid.replace(
      "lockPlatformAuthorityForMutation(targetId)",
      "lockPlatformAuthorityForMutation(otherTargetId)",
    );
    const unawaited = valid.replace(
      "await operatorJobLeasingRepository(tx)",
      "operatorJobLeasingRepository(tx)",
    );
    const branchOnly = importedFactory + `async function guarded(tx: any, targetId: string, lock: boolean) {
      if (lock) {
        await operatorJobLeasingRepository(tx).lockPlatformAuthorityForMutation(targetId);
      }
      await tx.update(executionTargets).set({ status: "offline" })
        .where(eq(executionTargets.id, targetId));
    }`;
    expect.soft(platformGuardOrderViolations(valid)).toEqual([]);
    expect.soft(platformGuardOrderViolations(otherTransaction)).toEqual(["guarded"]);
    expect.soft(platformGuardOrderViolations(otherTarget)).toEqual(["guarded"]);
    expect.soft(platformGuardOrderViolations(unawaited)).toEqual(["guarded"]);
    expect.soft(platformGuardOrderViolations(branchOnly)).toEqual(["guarded"]);
  });

  it("inventories interpolated tagged-SQL certificate mutations by their real target", () => {
    const fixture = `async function cleanupLeaseRejectionCertificates(tx: any, raw: any, unknownRows: any) {
      await raw\`DELETE FROM \${leases} WHERE organization_id = 'x'\`;
      await raw\`DELETE FROM \${unknownRows} WHERE organization_id = 'x'\`;
      await tx.delete(workerLeaseRejections).where(scope);
    }`;
    expect(namedFunctionMutationInventory(fixture, "cleanupLeaseRejectionCertificates")).toEqual([
      "<dynamic>:delete",
      "leases:delete",
      "workerLeaseRejections:delete",
    ]);
  });

  // AST-scans the whole production source tree (server + packages/db) — ~14s locally,
  // which tips over the 30s default under CI vitest-worker parallelism. Give it headroom.
  it("enforces an exhaustive authority-writer allowlist and target-worker-exclusive lock order", { timeout: 120_000 }, () => {
    const dbHelper = new URL("../../../packages/db/src/platform-target-authority-lock.ts", import.meta.url);
    expect(existsSync(dbHelper), "platform-target lock helper must exist before writers can be guarded").toBe(true);
    const sourceFiles = [
      ...productionTypeScriptFiles(join(repositoryRoot, "server", "src")),
      ...productionTypeScriptFiles(join(repositoryRoot, "packages", "db", "src")),
    ].map((path) => ({
      file: relative(repositoryRoot, path).replaceAll("\\", "/"),
      source: readFileSync(path, "utf8"),
    }));
    const authorityWriters = scanAuthorityWriters(sourceFiles);
    const inventory = authorityWriters.map(writerIdentity);
    const dynamicRawSqlSites = scanDynamicRawSqlSites(sourceFiles);
    const expected = [
      "packages/db/src/repositories/tenant/job-control.ts#touchWorkerLeaseProfile:workers:lastSeenAt,updatedAt:last_seen_only",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#insertWorker:workers:<insert>:authority",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#advanceTargetGeneration:executionTargets:deviceGeneration,updatedAt:authority",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#heartbeatPlatformPhysicalLivenessOnly:executionTargets:lastSeenAt,updatedAt:last_seen_only",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#heartbeatPlatformPhysicalLivenessOnly:workers:lastSeenAt,updatedAt:last_seen_only",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#heartbeatSessionProfile:workers:lastSeenAt,updatedAt:last_seen_only",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#heartbeatSessionTarget:executionTargets:lastSeenAt,updatedAt:last_seen_only",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#heartbeatSharedPlatformTarget:executionTargets:lastSeenAt,updatedAt:last_seen_only",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#heartbeatSharedPlatformTarget:workers:lastSeenAt,updatedAt:last_seen_only",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#ratifyPlacementProfile:executionTargets:providerConstraintProfile,registeredProfile,registeredProfileHash,updatedAt:authority",
      // WRK-011 self-hello refresh: a WORKER-row authority write. It now proves the
      // target -> worker -> exclusive lock order inline (directOrder), so it is a reviewed
      // authority writer, not an exempt delegate.
      "packages/db/src/repositories/tenant/worker-enrollment.ts#refreshWorkerProfile:workers:profileHash,profileSnapshot,updatedAt:authority",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#retireBootstrapCredential:executionTargets:updatedAt,workerTokenHash:authority",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#revokeTargetAuthority:executionTargets:deviceGeneration,status,updatedAt,workerTokenHash:authority",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#revokeTargetAuthority:workers:revokedAt,status,updatedAt:authority",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#rotateWorker:workers:deviceGeneration,devicePublicKey,deviceThumbprint,enrolledAt,profileHash,profileSnapshot,revokedAt,status,updatedAt:authority",
      "server/src/services/execution-targets.ts#ratifyPlatformExecutionTargetPlacementProfile:executionTargets:providerConstraintProfile,registeredProfile,registeredProfileHash,updatedAt:authority",
      "server/src/services/execution-targets.ts#registerWorkerHeartbeat:executionTargets:capabilities,lastSeenAt,status,updatedAt:authority",
      "server/src/services/execution-targets.ts#revokeExecutionTargetWorkerToken:executionTargets:status,updatedAt,workerTokenHash:authority",
      "server/src/services/execution-targets.ts#rotateExecutionTargetWorkerToken:executionTargets:updatedAt,workerTokenHash:authority",
      "server/src/routes/execution-targets.ts#executionTargetRoutes:executionTargets:<insert>:authority",
      // JOB-007 revocation: the operator generation-cutoff — it increments the target's
      // deviceGeneration + disables it (status), the immutable authority write the fence
      // guard's generation recheck denies against. A narrow service-guarded delegate whose
      // transaction/scope is established by ensureExecutionTargetCutoff (see exception below).
      "server/src/services/execution-targets.ts#bumpExecutionTargetGeneration:executionTargets:deviceGeneration,status,updatedAt:authority",
      "server/src/services/execution-targets.ts#ensureControlPlaneExecutionTarget:executionTargets:<insert>:authority",
    ].sort();
    expect.soft(inventory).toEqual(expected);
    expect.soft(inventory.some((identity) => /<(?:dynamic|computed|spread)>/.test(identity))).toBe(false);
    expect.soft(inventory.filter((identity) => identity.includes("#heartbeatSessionTarget:"))).toEqual([
      "packages/db/src/repositories/tenant/worker-enrollment.ts#heartbeatSessionTarget:executionTargets:lastSeenAt,updatedAt:last_seen_only",
    ]);
    expect.soft(dynamicRawSqlSites).toEqual([
      "packages/db/src/backup-lib.ts#runDatabaseBackup:.unsafe:072365d746d7",
      "packages/db/src/backup-lib.ts#runDatabaseBackup:.unsafe:1a3a09674d60",
      "packages/db/src/backup-lib.ts#runDatabaseBackup:.unsafe:1b4f79e16771",
      "packages/db/src/backup-lib.ts#runDatabaseBackup:.unsafe:23c6bcd5053a",
      "packages/db/src/backup-lib.ts#runDatabaseBackup:.unsafe:3750173f79dd",
      "packages/db/src/backup-lib.ts#runDatabaseBackup:.unsafe:3750173f79dd",
      "packages/db/src/backup-lib.ts#runDatabaseBackup:.unsafe:449ea6fe0706",
      "packages/db/src/backup-lib.ts#runDatabaseBackup:.unsafe:5cf9416d39b4",
      "packages/db/src/backup-lib.ts#runDatabaseBackup:.unsafe:9466a8f59f88",
      "packages/db/src/backup-lib.ts#runDatabaseBackup:.unsafe:b40423ff6671",
      "packages/db/src/backup-lib.ts#runDatabaseRestore:.unsafe:b111c6e1d318",
      "packages/db/src/client.ts#applyPendingMigrationsManually:.unsafe:b111c6e1d318",
      "packages/db/src/client.ts#ensureMigrationJournalTable:.unsafe:36625b5007ab",
      "packages/db/src/client.ts#ensureMigrationJournalTable:.unsafe:72ea4f2f1e05",
      "packages/db/src/client.ts#ensurePostgresDatabase:.unsafe:22f3c71744a5",
      "packages/db/src/client.ts#getMigrationTableColumnNames:.unsafe:c6ac6fc777f9",
      "packages/db/src/client.ts#latestMigrationCreatedAt:.unsafe:10d48ff08468",
      "packages/db/src/client.ts#loadAppliedMigrationIdentity:.unsafe:5dcba962f76d",
      "packages/db/src/client.ts#loadAppliedMigrations:.unsafe:011cd7b63172",
      "packages/db/src/client.ts#loadAppliedMigrations:.unsafe:1b3e82512ded",
      "packages/db/src/client.ts#loadAppliedMigrations:.unsafe:d6ac42909b63",
      "packages/db/src/client.ts#loadAppliedMigrations:.unsafe:e46ca1a1a142",
      "packages/db/src/client.ts#migrationHistoryEntryExists:.unsafe:fc859f500d61",
      "packages/db/src/client.ts#reconcilePendingMigrationHistory:.unsafe:0e04f6f93840",
      "packages/db/src/client.ts#reconcilePendingMigrationHistory:.unsafe:6a9fa2fe3ca4",
      "packages/db/src/client.ts#reconcilePendingMigrationHistory:.unsafe:7fb4c733313e",
      "packages/db/src/client.ts#reconcilePendingMigrationHistory:.unsafe:dae5b792be39",
      "packages/db/src/client.ts#reconcilePendingMigrationHistory:.unsafe:e1e4403341c7",
      "packages/db/src/client.ts#recordMigrationHistoryEntry:.unsafe:6a9fa2fe3ca4",
      // SVC-002 — the live-instance predicate, inlined as SQL LITERALS on purpose.
      //
      // WHY IT IS `raw` AT ALL, since this inventory exists to make every dynamic SQL site a
      // reviewed decision: drizzle's `notInArray` emits the three terminal statuses as `$n`
      // BIND PARAMETERS, and once postgres-js's prepared statement is promoted to a GENERIC
      // plan PostgreSQL can no longer prove that `status NOT IN ($1,$2,$3)` implies the
      // LITERAL predicate of the partial index `service_instances_live_service_uq` — so the
      // index drops out and the plan sequentially scans `service_instances`. Reproduced on
      // PostgreSQL 18 in review of PR #406.
      //
      // WHY IT IS SAFE, and this is a mechanism rather than an assurance: the interpolated
      // text is built ONLY from `TERMINAL_SERVICE_INSTANCE_STATUSES`, a frozen `as const`
      // array of three literals in the same module, and a MODULE-LOAD guard beside the helper
      // throws unless every one matches /^[a-z_]+$/. No caller input reaches it — the helper
      // takes no arguments at all.
      "packages/db/src/repositories/tenant/job-control.ts#nonTerminalServiceInstanceStatus:.raw:b1ca4eadcba6",
      "packages/db/src/schema/company_brain_edges.ts#<module>:.raw:04b29159c874",
      "packages/db/src/schema/company_brain_edges.ts#<module>:.raw:30517078e05a",
      "packages/db/src/schema/company_brain_edges.ts#<module>:.raw:9e956052e63f",
      "server/src/db/rls-bootstrap.ts#bootstrapRlsCanary:.unsafe:a321b270a566",
      "server/src/db/rls-bootstrap.ts#bootstrapRlsCanary:.unsafe:c0d44c46ae86",
      "server/src/db/rls-bootstrap.ts#bootstrapRlsCanary:.unsafe:db3d79e1a54e",
      "server/src/index.ts#maybeProvisionDistributedExecutionRoles:.unsafe:326335454339",
      // Universe intake accepts one validated literal order direction (asc|desc)
      // before it reaches sql.raw; no user-controlled identifier or predicate is interpolated.
      "server/src/routes/universe-intake.ts#universeIntakeRoutes:.raw:bac634eaa595",
      "server/src/services/comment-wakeup-outbox.ts#claimOneRow:.raw:de6ed04ad69b",
      "server/src/services/embeddings.ts#processQueue:.raw:6a66fe80944e",
      "server/src/services/execution-workspaces.ts#tryClaimWorkspaceRun:.raw:e678f0747f5c",
      "server/src/services/internal-agent/conversation.ts#claimTurn:.raw:852b69d2495a",
      "server/src/services/memory-projection.ts#buildMemoryInsert:.raw:4c5170ac8630",
      "server/src/services/memory-projection.ts#buildMemoryInsert:.raw:6b4e01ae278b",
      "server/src/services/mention-outbox.ts#claimOneRow:.raw:3d6aba2162f3",
    ]);

    const injected = scanAuthorityWriters([...sourceFiles,
      {
        file: "server/src/services/injected-authority-barrel.ts",
        source: `export { executionTargets as authorityRows, workers as workerRows } from "@armyofagents/db";`,
      },
      {
        file: "server/src/services/injected-platform-bypass.ts",
        source: `export async function injectedBypass(tx: any) {
          await tx.update(executionTargets).set({ status: "offline" });
        }`,
      },
      {
        file: "server/src/services/injected-aliased-bypass.ts",
        source: `import { executionTargets as importedTargets } from "@armyofagents/db";
          const targetTable = importedTargets;
          export async function injectedAliasedBypass(tx: any) {
            await tx.update(targetTable).set({ deviceGeneration: 2 });
          }
          export async function shadowedAliasIsNotTheImportedTable(tx: any, targetTable: unknown) {
            await tx.update(targetTable).set({ status: "not-an-authority-write" });
          }`,
      },
      {
        file: "server/src/services/injected-dynamic-bypass.ts",
        source: `export async function injectedDynamicBypass(tx: any, patch: any) {
          await tx.update(executionTargets).set(patch);
        }
        export async function injectedSpreadBypass(tx: any, patch: any) {
          await tx.update(executionTargets).set({ ...patch });
        }`,
      },
      {
        file: "server/src/services/injected-raw-bypass.ts",
        source: "const rawTarget = executionTargets;\n" +
          "export async function injectedRawBypass(tx: any) { await tx`UPDATE public.execution_targets AS et SET status = 'offline'`; }\n" +
          "export async function injectedInterpolatedRawBypass(tx: any) { await tx`UPDATE ${rawTarget} SET ${column} = 'offline'`; }\n" +
          "export async function injectedUnsafeRawBypass(tx: any) { await tx.unsafe(\"UPDATE workers AS w SET status = 'revoked'\"); }\n" +
          "export async function injectedRawDeleteBypass(tx: any) { await tx.raw(\"DELETE FROM public.execution_targets WHERE id = 'x'\"); }\n" +
          "export async function injectedSqlRawBypass() { return sql.raw(\"UPDATE public.execution_targets SET device_generation = 9\"); }",
      },
      {
        file: "server/src/services/injected-destructured-assignment-bypass.ts",
        source: `import * as schema from "@armyofagents/db";
          import { authorityRows as reexportedRows } from "./injected-authority-barrel.js";
          const { executionTargets: destructuredRows } = schema;
          const authorityPatch = { status: "offline" };
          const authoritySet = { ...authorityPatch };
          const authorityConflictOptions = { target: reexportedRows.id, set: authoritySet };
          let assignedRows: unknown;
          assignedRows = destructuredRows;
          export async function destructuredBypass(tx: any) {
            await tx.update(destructuredRows).set({ status: "offline" });
          }
          export async function assignmentBypass(tx: any) {
            await tx.update(assignedRows).set({ deviceGeneration: 4 });
          }
          export async function reexportedBypass(tx: any) {
            await tx.update(reexportedRows).set({ workerTokenHash: null });
          }
          export async function upsertBypass(tx: any) {
            await tx.insert(reexportedRows).values({}).onConflictDoUpdate(authorityConflictOptions);
          }
          export async function shorthandUpsertBypass(tx: any) {
            const set = authorityPatch;
            await tx.insert(reexportedRows).values({}).onConflictDoUpdate({
              target: reexportedRows.id, set,
            });
          }
          export async function dynamicUpsertBypass(tx: any, options: unknown) {
            await tx.insert(reexportedRows).values({}).onConflictDoUpdate(options);
          }
          export async function deleteBypass(tx: any) {
            await tx.delete(reexportedRows).where(ok);
          }
          export async function preboundUpdateBypass(tx: any) {
            const writer = tx.update(reexportedRows);
            await writer.set({ status: "offline" }).where(ok);
          }
          export async function preboundInsertBypass(tx: any) {
            const writer = tx.insert(reexportedRows);
            await writer.values({ status: "active" });
          }
          export async function preboundUpsertBypass(tx: any) {
            const writer = tx.insert(reexportedRows).values({ status: "active" });
            const options = authorityConflictOptions;
            await writer.onConflictDoUpdate(options);
          }`,
      },
    ]).map(writerIdentity);
    expect.soft(injected.filter((identity) => identity.startsWith("server/src/services/injected-"))).toEqual([
      "server/src/services/injected-aliased-bypass.ts#injectedAliasedBypass:executionTargets:deviceGeneration:authority",
      "server/src/services/injected-dynamic-bypass.ts#injectedDynamicBypass:executionTargets:<dynamic>:authority",
      "server/src/services/injected-dynamic-bypass.ts#injectedSpreadBypass:executionTargets:<dynamic>:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#assignmentBypass:executionTargets:deviceGeneration:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#destructuredBypass:executionTargets:status:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#reexportedBypass:executionTargets:workerTokenHash:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#upsertBypass:executionTargets:status:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#shorthandUpsertBypass:executionTargets:status:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#dynamicUpsertBypass:executionTargets:<dynamic>:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#deleteBypass:executionTargets:<delete>:authority",
      "server/src/services/injected-platform-bypass.ts#injectedBypass:executionTargets:status:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#dynamicUpsertBypass:executionTargets:<insert>:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#preboundInsertBypass:executionTargets:<insert>:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#preboundUpdateBypass:executionTargets:status:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#preboundUpsertBypass:executionTargets:<insert>:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#preboundUpsertBypass:executionTargets:status:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#shorthandUpsertBypass:executionTargets:<insert>:authority",
      "server/src/services/injected-destructured-assignment-bypass.ts#upsertBypass:executionTargets:<insert>:authority",
      "server/src/services/injected-raw-bypass.ts#injectedInterpolatedRawBypass:executionTargets:<dynamic>:authority",
      "server/src/services/injected-raw-bypass.ts#injectedRawBypass:executionTargets:status:authority",
      "server/src/services/injected-raw-bypass.ts#injectedRawDeleteBypass:executionTargets:<delete>:authority",
      "server/src/services/injected-raw-bypass.ts#injectedSqlRawBypass:executionTargets:deviceGeneration:authority",
      "server/src/services/injected-raw-bypass.ts#injectedUnsafeRawBypass:workers:status:authority",
    ].sort());
    expect.soft(scanDynamicRawSqlSites([...sourceFiles, {
      file: "server/src/services/injected-dynamic-raw-bypass.ts",
      source: `export async function injectedDynamicRawBypass(tx: any, statement: string) {
        await tx.unsafe(statement);
      }`,
    }]).filter((identity) => identity.startsWith("server/src/services/injected-"))).toEqual([
      "server/src/services/injected-dynamic-raw-bypass.ts#injectedDynamicRawBypass:.unsafe:b111c6e1d318",
    ]);
    const resolvedSqlFingerprints = scanDynamicRawSqlSites([{
      file: "server/src/services/injected-resolved-a.ts",
      source: `const statement = "UPDATE workers SET status = 'revoked'";
        export async function write(tx: any) { await tx.unsafe(statement); }`,
    }, {
      file: "server/src/services/injected-resolved-b.ts",
      source: `const statement = "DELETE FROM workers WHERE id = 'x'";
        export async function write(tx: any) { await tx.unsafe(statement); }`,
    }]);
    expect.soft(resolvedSqlFingerprints).toHaveLength(2);
    expect.soft(new Set(resolvedSqlFingerprints.map((site) => site.split(":").at(-1))).size).toBe(2);

    const authorityHelperImport = `import { acquirePlatformTargetAuthorityExclusive }
      from "../../platform-target-authority-lock.js";\n`;
    const guarded = authorityHelperImport + `async function guarded(tx: any) {
      await tx.select().from(executionTargets).where(ok).for("update");
      await tx.select().from(workers).where(ok).for("update");
      await acquirePlatformTargetAuthorityExclusive(tx, targetId);
      await tx.update(executionTargets).set({ status: "offline" });
    }`;
    const wrongOrder = authorityHelperImport + `async function wrongOrder(tx: any) {
      await tx.select().from(executionTargets).where(ok).for("update");
      await acquirePlatformTargetAuthorityExclusive(tx, targetId);
      await tx.select().from(workers).where(ok).for("update");
      await tx.update(executionTargets).set({ status: "offline" });
    }`;
    const unguarded = `async function unguarded(tx: any) {
      await tx.update(executionTargets).set({ deviceGeneration: 2 });
    }`;
    const rawWrongOrder = authorityHelperImport + "async function rawWrongOrder(tx: any) { " +
      "await tx`SELECT id FROM workers FOR UPDATE`; " +
      "await tx`SELECT id FROM execution_targets FOR UPDATE`; " +
      "await acquirePlatformTargetAuthorityExclusive(tx, id); " +
      "await tx`UPDATE execution_targets SET status = 'offline'`; }";
    const rawGuarded = authorityHelperImport + "async function rawGuarded(tx: any) { " +
      "await tx`SELECT id FROM execution_targets FOR UPDATE`; " +
      "await tx`SELECT id FROM workers FOR UPDATE`; " +
      "await acquirePlatformTargetAuthorityExclusive(tx, id); " +
      "await tx`UPDATE execution_targets SET status = 'offline'`; }";
    const branchBypass = authorityHelperImport + `async function branchBypass(tx: any, shouldLock: boolean) {
      if (shouldLock) {
        await tx.select().from(executionTargets).where(ok).for("update");
        await tx.select().from(workers).where(ok).for("update");
        await acquirePlatformTargetAuthorityExclusive(tx, targetId);
      }
      await tx.update(executionTargets).set({ status: "offline" });
    }`;
    const rawUnsafeUnguarded = `async function rawUnsafeUnguarded(tx: any) {
      await tx.unsafe("UPDATE public.execution_targets AS target SET status = 'offline'");
    }`;
    const workerUnguarded = `async function workerUnguarded(tx: any) {
      await tx.update(workers).set({ deviceGeneration: 2 });
    }`;
    const tryCatchBypass = authorityHelperImport + `async function tryCatchBypass(tx: any) {
      try {
        await tx.select().from(executionTargets).where(ok).for("update");
        await tx.select().from(workers).where(ok).for("update");
        await acquirePlatformTargetAuthorityExclusive(tx, targetId);
        throw new Error("race");
      } catch {
        await tx.update(executionTargets).set({ status: "offline" });
      }
    }`;
    const shadowedExclusiveBypass = authorityHelperImport + `async function shadowedExclusiveBypass(tx: any) {
      const acquirePlatformTargetAuthorityExclusive = async () => undefined;
      await tx.select().from(executionTargets).where(ok).for("update");
      await tx.select().from(workers).where(ok).for("update");
      await acquirePlatformTargetAuthorityExclusive();
      await tx.update(executionTargets).set({ status: "offline" });
    }`;
    const hoistedExclusiveBypass = authorityHelperImport + `async function hoistedExclusiveBypass(tx: any) {
      await tx.select().from(executionTargets).where(ok).for("update");
      await tx.select().from(workers).where(ok).for("update");
      await acquirePlatformTargetAuthorityExclusive();
      await tx.update(executionTargets).set({ status: "offline" });
      function acquirePlatformTargetAuthorityExclusive() { return Promise.resolve(); }
    }`;
    const shadowedCombinedBypass = `async function shadowedCombinedBypass(tx: any) {
      const lockPlatformAuthorityForMutation = async () => true;
      await lockPlatformAuthorityForMutation();
      await tx.update(executionTargets).set({ status: "offline" });
    }`;
    const fakeSuffixImportBypass = `import { acquirePlatformTargetAuthorityExclusive }
      from "./fake/platform-target-authority-lock.js";
      async function fakeSuffixImportBypass(tx: any) {
        await tx.select().from(executionTargets).where(ok).for("update");
        await tx.select().from(workers).where(ok).for("update");
        await acquirePlatformTargetAuthorityExclusive(tx, targetId);
        await tx.update(executionTargets).set({ status: "offline" });
      }`;
    const unrelatedThisDelegateBypass = `const unrelated = {
      async lockPlatformAuthorityForMutation() { return true; },
      async unrelatedThisDelegateBypass(tx: any) {
        await this.lockPlatformAuthorityForMutation();
        await tx.update(executionTargets).set({ status: "offline" });
      },
    };`;
    const unawaitedBypass = authorityHelperImport + `async function unawaitedBypass(tx: any) {
      tx.select().from(executionTargets).where(ok).for("update");
      tx.select().from(workers).where(ok).for("update");
      acquirePlatformTargetAuthorityExclusive(tx, targetId);
      await tx.update(executionTargets).set({ status: "offline" });
    }`;
    const promiseAllBypass = authorityHelperImport + `async function promiseAllBypass(tx: any) {
      await Promise.all([
        tx.select().from(executionTargets).where(ok).for("update"),
        tx.select().from(workers).where(ok).for("update"),
        acquirePlatformTargetAuthorityExclusive(tx, targetId),
      ]);
      await tx.update(executionTargets).set({ status: "offline" });
    }`;
    const logicalAndBypass = authorityHelperImport + `async function logicalAndBypass(tx: any, lock: boolean) {
      lock && await tx.select().from(executionTargets).where(ok).for("update");
      lock && await tx.select().from(workers).where(ok).for("update");
      lock && await acquirePlatformTargetAuthorityExclusive(tx, targetId);
      await tx.update(executionTargets).set({ status: "offline" });
    }`;
    const logicalOrBypass = authorityHelperImport + `async function logicalOrBypass(tx: any, skip: boolean) {
      skip || await tx.select().from(executionTargets).where(ok).for("update");
      skip || await tx.select().from(workers).where(ok).for("update");
      skip || await acquirePlatformTargetAuthorityExclusive(tx, targetId);
      await tx.update(executionTargets).set({ status: "offline" });
    }`;
    const rawDeleteBypass = `async function rawDeleteBypass(tx: any) {
      await tx.unsafe("DELETE FROM public.workers WHERE id = 'x'");
    }`;
    const preboundGuardBypass = authorityHelperImport + `async function preboundGuardBypass(tx: any) {
      const writer = tx.update(executionTargets);
      await writer.set({ status: "offline" });
    }`;
    expect.soft(platformGuardOrderViolations(guarded)).toEqual([]);
    expect.soft(platformGuardOrderViolations(wrongOrder)).toEqual(["wrongOrder"]);
    expect.soft(platformGuardOrderViolations(unguarded)).toEqual(["unguarded"]);
    expect.soft(platformGuardOrderViolations(rawWrongOrder)).toEqual(["rawWrongOrder"]);
    expect.soft(platformGuardOrderViolations(rawGuarded)).toEqual([]);
    expect.soft(platformGuardOrderViolations(branchBypass)).toEqual(["branchBypass"]);
    expect.soft(platformGuardOrderViolations(rawUnsafeUnguarded)).toEqual(["rawUnsafeUnguarded"]);
    expect.soft(platformGuardOrderViolations(workerUnguarded)).toEqual(["workerUnguarded"]);
    expect.soft(platformGuardOrderViolations(tryCatchBypass)).toEqual(["tryCatchBypass"]);
    expect.soft(platformGuardOrderViolations(shadowedExclusiveBypass)).toContain("shadowedExclusiveBypass");
    expect.soft(platformGuardOrderViolations(hoistedExclusiveBypass)).toContain("hoistedExclusiveBypass");
    expect.soft(platformGuardOrderViolations(shadowedCombinedBypass)).toContain("shadowedCombinedBypass");
    expect.soft(platformGuardOrderViolations(fakeSuffixImportBypass)).toContain("fakeSuffixImportBypass");
    expect.soft(platformGuardOrderViolations(unrelatedThisDelegateBypass)).toContain("unrelatedThisDelegateBypass");
    expect.soft(platformGuardOrderViolations(unawaitedBypass)).toContain("unawaitedBypass");
    expect.soft(platformGuardOrderViolations(promiseAllBypass)).toContain("promiseAllBypass");
    expect.soft(platformGuardOrderViolations(logicalAndBypass)).toContain("logicalAndBypass");
    expect.soft(platformGuardOrderViolations(logicalOrBypass)).toContain("logicalOrBypass");
    expect.soft(platformGuardOrderViolations(rawDeleteBypass)).toContain("rawDeleteBypass");
    expect.soft(platformGuardOrderViolations(preboundGuardBypass)).toContain("preboundGuardBypass");

    const sourceByFile = new Map(sourceFiles.map((entry) => [entry.file, entry.source]));
    expect.soft(repositoryDelegateCallSiteInventory(sourceFiles)).toEqual([
      "server/src/middleware/worker-session-auth.ts#revokeTenantWorkerAuthority:revokeTargetAuthority:returned",
      "server/src/services/execution-targets.ts#ratifyTenantExecutionTargetPlacementProfile:ratifyPlacementProfile:awaited",
      "server/src/services/worker-enrollment.ts#completeEnrollment:advanceTargetGeneration:awaited",
      "server/src/services/worker-enrollment.ts#completeEnrollment:insertWorker:awaited",
      "server/src/services/worker-enrollment.ts#completeEnrollment:retireBootstrapCredential:awaited",
      "server/src/services/worker-enrollment.ts#completeEnrollment:rotateWorker:awaited",
    ]);
    const exactNonPlatformWriters = new Set([
      "server/src/services/execution-targets.ts#registerWorkerHeartbeat",
      "server/src/services/execution-targets.ts#revokeExecutionTargetWorkerToken",
      "server/src/services/execution-targets.ts#rotateExecutionTargetWorkerToken",
    ]);
    const exactReviewedThisDelegates = new Set([
      "packages/db/src/repositories/tenant/worker-enrollment.ts#revokeTargetAuthority",
    ]);
    const exactServiceGuardedDelegates = new Set([
      "packages/db/src/repositories/tenant/worker-enrollment.ts#advanceTargetGeneration",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#ratifyPlacementProfile",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#retireBootstrapCredential",
      "packages/db/src/repositories/tenant/worker-enrollment.ts#rotateWorker",
    ]);
    // JOB-007 operator generation-cutoff: a narrow write helper living in a service file
    // (execution-targets.ts) that also imports runInTenant/operatorJobLeasingRepository for
    // OTHER functions — so the import-prepended audit source can't use the generic
    // service-delegate negative match. Verify its OWN body instead: it must never open a
    // transaction, and must gate on the exact (targetId, revokedGeneration) predicate so the
    // bump stays monotonic + idempotent. Scope is the caller's (org: runInTenant/tenant RLS,
    // platform: operatorDb), exactly like the enrollment generation writers above.
    const exactGenerationCutoffDelegates = new Set([
      "server/src/services/execution-targets.ts#bumpExecutionTargetGeneration",
    ]);
    const reviewedCreateOnlyOrDelegatedInserts = new Set([
      "packages/db/src/repositories/tenant/worker-enrollment.ts#insertWorker",
      "server/src/routes/execution-targets.ts#executionTargetRoutes",
      "server/src/services/execution-targets.ts#ensureControlPlaneExecutionTarget",
    ]);
    for (const writer of authorityWriters.filter((entry) => entry.mode === "authority")) {
      const key = `${writer.file}#${writer.functionName}`;
      const functionSource = namedFunctionAuditSource(sourceByFile.get(writer.file)!, writer.functionName);
      if (writer.fields.join(",") === "<insert>" && reviewedCreateOnlyOrDelegatedInserts.has(key)) {
        if (key.endsWith("#executionTargetRoutes")) {
          expect.soft(functionSource).toMatch(/assertOrgAdmin[\s\S]*organizationId:\s*orgId[\s\S]*targetAuthorityKey/);
        } else if (key.endsWith("#ensureControlPlaneExecutionTarget")) {
          expect.soft(functionSource).toMatch(/organizationId:\s*null[\s\S]*scope:\s*["']platform["'][\s\S]*targetAuthorityKey:\s*["']platform["']/);
        } else {
          expect.soft(functionSource).toMatch(/insert\(workers\)[\s\S]*values\(values\)/);
        }
        continue;
      }
      if (exactServiceGuardedDelegates.has(key)) {
        expect.soft(functionSource, `${key} must remain a narrow repository delegate`).not.toMatch(
          /(?:\.transaction\(|runInTenant\(|operatorJobLeasingRepository)/,
        );
        continue;
      }
      if (exactGenerationCutoffDelegates.has(key)) {
        const body = namedFunctionSource(sourceByFile.get(writer.file)!, writer.functionName);
        expect.soft(body, `${key} must never open its own transaction`).not.toMatch(
          /\.transaction\(|runInTenant\(/,
        );
        // The cutoff must DISABLE the target under an idempotent `status != 'disabled'`
        // guard (not an exact-generation CAS, which silently no-ops if a racing
        // re-enrollment advanced the generation — see finding-1). Together: it always
        // disables + strictly advances the generation, exactly once per contention.
        expect.soft(body, `${key} must set status disabled`).toMatch(
          /status:\s*["']disabled["']/,
        );
        expect.soft(body, `${key} must gate idempotently on status != disabled`).toMatch(
          /ne\(executionTargets\.status,\s*["']disabled["']\)/,
        );
        expect.soft(body, `${key} must target exactly one row by id`).toMatch(
          /eq\(executionTargets\.id,\s*input\.targetId\)/,
        );
        continue;
      }
      if (exactNonPlatformWriters.has(key)) {
        expect.soft(
          functionSource,
          `${key} may be exempt only while it has an explicit non-null Organization predicate`,
        ).toMatch(/isNotNull\(executionTargets\.organizationId\)|eq\(executionTargets\.organizationId,\s*input\.organizationId\)/);
        expect.soft(functionSource, `${key} must never accept a null-Org platform row`).not.toMatch(
          /isNull\(executionTargets\.organizationId\)/,
        );
        continue;
      }
      expect.soft(
        platformGuardOrderViolations(functionSource, true, exactReviewedThisDelegates.has(key)),
        `${key} must prove target -> worker -> named exclusive authority before every mutation`,
      ).toEqual([]);
    }
    const targetWriters = sourceByFile.get("server/src/services/execution-targets.ts")!;
    expect.soft(placementProfileDelegateFlowViolations(targetWriters)).toEqual([]);
    const tenantRevocation = namedFunctionAuditSource(
      sourceByFile.get("server/src/middleware/worker-session-auth.ts")!,
      "revokeTenantWorkerAuthority",
    ).replace(/\s+/g, "");
    expect.soft(tenantRevocation).toContain(
      "returnrunInTenant(input.appDb,input.organizationId,(repos)=>repos.workerEnrollment.revokeTargetAuthority({",
    );
    expect.soft(tenantRevocation).toContain("executionTargetId:input.executionTargetId");
    const workerRepository = sourceByFile.get(
      "packages/db/src/repositories/tenant/worker-enrollment.ts",
    )!;
    const operatorRepository = sourceByFile.get(
      "packages/db/src/repositories/operator/job-leasing.ts",
    )!;
    expect.soft(platformGuardOrderViolations(namedFunctionAuditSource(
      targetWriters,
      "ratifyPlatformExecutionTargetPlacementProfile",
    ))).toEqual([]);
    expect.soft(platformGuardOrderViolations(namedFunctionAuditSource(
      workerRepository,
      "lockPlatformAuthorityForMutation",
    ))).toEqual([]);
    expect.soft(platformGuardOrderViolations(namedFunctionAuditSource(
      workerRepository,
      "revokeTargetAuthority",
    ), false, true)).toEqual([]);
    expect.soft(platformGuardOrderViolations(namedFunctionAuditSource(
      operatorRepository,
      "lockPlatformAuthorityForMutation",
    ))).toEqual([]);

    const enrollmentService = sourceByFile.get("server/src/services/worker-enrollment.ts")!;
    const platformExclusiveDelegate = namedVariableFunctionSource(
      enrollmentService,
      "acquirePlatformTargetAuthorityExclusive",
    );
    const delegateFacts = awaitedCallFacts(platformExclusiveDelegate);
    expect.soft(delegateFacts.filter((fact) => fact.name === "lockPlatformAuthorityForMutation")).toEqual([
      expect.objectContaining({ awaited: true }),
    ]);
    const completeEnrollment = namedVariableFunctionSource(enrollmentService, "completeEnrollment");
    const enrollmentFacts = awaitedCallFacts(completeEnrollment);
    for (const mutation of ["advanceTargetGeneration", "rotateWorker", "insertWorker", "retireBootstrapCredential"]) {
      const calls = enrollmentFacts.filter((fact) => fact.name === mutation);
      expect.soft(calls, `worker enrollment ${mutation} delegation must be awaited`).not.toHaveLength(0);
      expect.soft(calls.every((fact) => fact.awaited), `${mutation} must not be unawaited or Promise.all`).toBe(true);
    }
    const exclusiveCalls = enrollmentFacts.filter((fact) => fact.name === "acquirePlatformTargetAuthorityExclusive");
    expect.soft(exclusiveCalls).toEqual([expect.objectContaining({ awaited: true })]);
    expect.soft(enrollmentAuthorityFlowViolations(enrollmentService)).toEqual([]);
    const validEnrollmentFlow = `const completeEnrollment = async (authority: any, authoritativeOrganizationId: string | null) => {
      const sharedPlatformProfile = authoritativeOrganizationId !== null && target.scope === "platform";
      if (sharedPlatformProfile) {
        await requireCurrentPlatformPhysicalAuthority({ target });
      } else if (authoritativeOrganizationId === null && target.scope === "platform") {
        await acquirePlatformTargetAuthorityExclusive(authority, target.id);
      }
      await authority.advanceTargetGeneration();
      await authority.rotateWorker();
      await authority.insertWorker();
      await authority.retireBootstrapCredential();
    };`;
    const validEnrollmentModule = `function createWorkerEnrollmentService() {
      const requireCurrentPlatformPhysicalAuthority = async () => undefined;
      ${validEnrollmentFlow}
    }`;
    expect.soft(enrollmentAuthorityFlowViolations(validEnrollmentModule)).toEqual([]);
    expect.soft(enrollmentAuthorityFlowViolations(validEnrollmentModule.replace(
      "await requireCurrentPlatformPhysicalAuthority({ target });",
      "maybe && await requireCurrentPlatformPhysicalAuthority({ target });",
    ))).toContain("shared-platform-guard");
    expect.soft(enrollmentAuthorityFlowViolations(validEnrollmentModule.replace(
      "await requireCurrentPlatformPhysicalAuthority({ target });",
      "try { await requireCurrentPlatformPhysicalAuthority({ target }); throw failure; } catch {}",
    ))).toContain("shared-platform-guard");
    expect.soft(enrollmentAuthorityFlowViolations(validEnrollmentModule.replace(
      "await acquirePlatformTargetAuthorityExclusive(authority, target.id);",
      "acquirePlatformTargetAuthorityExclusive(authority, target.id);",
    ))).toContain("null-platform-exclusive");
    expect.soft(enrollmentAuthorityFlowViolations(validEnrollmentModule.replace(
      "await authority.rotateWorker();",
      "await Promise.all([authority.rotateWorker()]);",
    ))).toContain("mutation:rotateWorker");
    expect.soft(enrollmentAuthorityFlowViolations(validEnrollmentModule.replace(
      "authoritativeOrganizationId !== null && target.scope === \"platform\"",
      "authoritativeOrganizationId !== null || target.scope === \"platform\"",
    ))).toContain("shared-platform-condition");

    const writerFiles = new Set(inventory.map((identity) => identity.slice(0, identity.indexOf("#"))));
    for (const { file, source } of sourceFiles.filter((entry) => writerFiles.has(entry.file))) {
      expect(source, `${file} must not widen platform target RLS or grants`).not.toContain(
        "execution_targets_tenant_enrollment_update",
      );
    }
  });

  it("maps one attempt-local typed static context from exact authority symbols with no laundering or injection", () => {
    const valid = `
      import { randomBytes } from "node:crypto";
      import {
        buildLeaseStaticContextInput,
        evaluateStaticLeaseEligibility,
        LEASE_STATIC_ELIGIBILITY_VERSION,
        leaseStaticContextHash,
      } from "./job-lease-eligibility.js";
      import { normalizePlacementRegistryTarget } from "./execution-target-resolver.js";
      import { normalizeSubmittedJobPlacementFacts } from "./job-placement.js";
      import {
        jobEnvelopeV1Schema,
        leaseOfferV1Schema,
        pollRequestV1Schema,
        pollResponseV1Schema,
        workerHelloV1Schema,
      } from "@armyofagents/worker-protocol";
      import { runInTenant } from "../db/tenant-context.js";
      import { operatorJobLeasingRepository } from "@armyofagents/db";
      function minCapacity(left: any, right: any) {
        return {
          batchSlots: Math.min(left.batchSlots, right.batchSlots),
          browserSessionSlots: Math.min(left.browserSessionSlots, right.browserSessionSlots),
          serviceSlots: Math.min(left.serviceSlots, right.serviceSlots),
          freeCpuMillis: Math.min(left.freeCpuMillis, right.freeCpuMillis),
          freeMemoryMiB: Math.min(left.freeMemoryMiB, right.freeMemoryMiB),
          freeDiskMiB: Math.min(left.freeDiskMiB, right.freeDiskMiB),
        };
      }
      function inferredCredentialBinding(target: any) {
        return target.credentialBinding;
      }
      function normalizedRequirements(job: any, target: any) {
        const normalized = normalizeSubmittedJobPlacementFacts({
          sourceKind: job.sourceKind,
          inputHash: job.inputHash,
          policyHash: job.policyHash,
          requirements: job.requirements,
          placementRequest: job.placementRequest,
          rollout: { enabled: true, mode: "active", reason: "stored_placement" },
          credentialBinding: inferredCredentialBinding(target),
          resolvedTarget: target,
        });
        return normalized.success && normalized.active ? normalized : null;
      }
      function normalizedProviderDemand(target: any) {
        const provider = target.providerConstraintProfile;
        const supported = new Set(provider.supportedOperations);
        const operations = ["create", "execute"].filter((operation) => supported.has(operation));
        return {
          maxRuntimeSeconds: Math.min(600, provider.maxContinuousRuntimeSeconds),
          maxIdleSeconds: Math.min(60, provider.maxIdleSeconds),
          resources: {
            cpuMillis: Math.min(1000, provider.resourceCeiling.cpuMillis),
            memoryMiB: Math.min(1024, provider.resourceCeiling.memoryMiB),
            pids: Math.min(128, provider.resourceCeiling.pids),
            diskMiB: Math.min(1024, provider.resourceCeiling.diskMiB),
          },
          concurrentOperations: Math.min(1, provider.maxConcurrentOperations),
          operations,
          localityTags: provider.localityTags.slice(0, 1),
        };
      }
      function source(job: any) {
        return job.executionSource;
      }
      function buildJobEnvelope(input: any) {
        const executionSource = source(input.job);
        if (!executionSource) return null;
        const deadline = new Date(Math.max(
          input.job.createdAt.getTime() + 1,
          input.databaseNow.getTime() + 600000,
          input.leaseExpiresAt.getTime() + 1,
        ));
        const parsed = jobEnvelopeV1Schema.safeParse({
          protocolVersion: 1,
          jobId: input.job.id,
          attempt: input.attempt.attemptNumber,
          organizationId: input.job.organizationId,
          companyId: input.job.companyId,
          source: executionSource,
          createdAt: input.job.createdAt.toISOString(),
          notBefore: input.job.availableAt.toISOString(),
          deadline: deadline.toISOString(),
          inputHash: input.job.inputHash,
          policyHash: input.requirements.policyHash,
          placement: {
            policyId: "job-placement",
            version: 1,
            digest: input.attempt.placementPolicyDigest,
            targetRequirements: input.requirements.targetRequirements,
          },
          adapter: { type: "aoa_job_control", version: "1", configArtifactId: null },
          requiredCapabilities: input.requirements.capabilities,
          workspace: null,
          secretHandles: [],
          resourceLimits: input.resourceLimits,
          networkPolicy: {
            policyId: "job-default-deny",
            version: 1,
            digest: input.attempt.placementPolicyDigest,
          },
          offlinePolicy: "cancel",
          extensions: [],
          workloadType: input.job.workloadType,
          workload: input.job.input,
        });
        return parsed.success ? parsed.data : null;
      }
      function authorityCurrent(input: any): boolean {
        const { auth, authority, request } = input;
        const worker = authority.worker;
        const target = authority.target;
        const oldestHeartbeat = target.scope === "platform"
          ? input.platformPhysicalHeartbeatAt?.getTime() ?? null
          : !worker.lastSeenAt || !target.lastSeenAt
            ? null
            : Math.min(worker.lastSeenAt.getTime(), target.lastSeenAt.getTime());
        return worker.id === auth.workerId &&
          worker.executionTargetId === auth.targetId &&
          worker.organizationId === auth.organizationId &&
          worker.scope !== "platform" &&
          worker.deviceGeneration === auth.targetGeneration &&
          worker.deviceThumbprint === auth.deviceThumbprint &&
          worker.devicePublicKey === auth.publicKey &&
          worker.profileHash === auth.profileHash &&
          worker.revokedAt === null &&
          (worker.status === "enrolled" || worker.status === "active") &&
          authority.ownerMembershipActive &&
          target.id === auth.targetId &&
          target.status === "active" &&
          target.deviceGeneration === auth.targetGeneration &&
          request.workerId === auth.workerId &&
          request.targetId === auth.targetId &&
          request.deviceGeneration === auth.targetGeneration &&
          oldestHeartbeat !== null &&
          input.databaseNow.getTime() - oldestHeartbeat <= input.maxHeartbeatAgeMs;
      }
      function ackAuthorityCurrent(input: any): boolean {
        const { auth, authority } = input;
        const worker = authority.worker;
        const target = authority.target;
        const oldestHeartbeat = target.scope === "platform"
          ? input.platformPhysicalHeartbeatAt?.getTime() ?? null
          : !worker.lastSeenAt || !target.lastSeenAt
            ? null
            : Math.min(worker.lastSeenAt.getTime(), target.lastSeenAt.getTime());
        return input.workerId === auth.workerId &&
          worker.id === auth.workerId &&
          worker.executionTargetId === auth.targetId &&
          worker.organizationId === auth.organizationId &&
          worker.scope !== "platform" &&
          worker.deviceGeneration === auth.targetGeneration &&
          worker.deviceThumbprint === auth.deviceThumbprint &&
          worker.devicePublicKey === auth.publicKey &&
          worker.profileHash === auth.profileHash &&
          worker.revokedAt === null &&
          (worker.status === "enrolled" || worker.status === "active") &&
          authority.ownerMembershipActive &&
          target.id === auth.targetId &&
          target.status === "active" &&
          target.deviceGeneration === auth.targetGeneration &&
          oldestHeartbeat !== null &&
          input.databaseNow.getTime() - oldestHeartbeat <= input.maxHeartbeatAgeMs;
      }
      export function createJobLeasingService(input: {
        appDb: unknown;
        operatorDb: any;
        scheduler?: any;
        ackTimeoutMs?: number;
        leaseDurationMs?: number;
        maxHeartbeatAgeMs?: number;
      }) {
        const ackTimeoutMs = Math.max(1000, input.ackTimeoutMs ?? 15000);
        const leaseDurationMs = Math.max(ackTimeoutMs + 1000, input.leaseDurationMs ?? 300000);
        const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300000);
        class HeadRestartConflict extends Error {}
        const isHeadRestartConflict = (error: unknown): error is HeadRestartConflict =>
          error instanceof HeadRestartConflict;
        const guardPlatformAuthority = async (guardRepos: any, guardAuth: any, locked: any) => {
          if (locked.target.scope === "organization" || locked.target.scope === "owner") {
            return { currentTarget: locked.target, physicalAuthorityWorker: null };
          }
          if (locked.target.scope !== "platform") throw new Error("target_revoked");
          return input.operatorDb.transaction(async (operatorTx: any) => {
            const physical = await operatorJobLeasingRepository(operatorTx)
              .lockPlatformPhysicalAuthority(guardAuth.targetId, "share");
            await guardRepos.jobControl.acquirePlatformTargetAuthorityShared(guardAuth.targetId);
            const current = await guardRepos.jobControl.recheckPlatformTargetAuthority({
              targetId: guardAuth.targetId,
              targetAuthorityKey: "platform",
              targetGeneration: guardAuth.targetGeneration,
            });
            const platformNow = await guardRepos.jobControl.currentDatabaseTime();
            if (!physical ||
                !current ||
                physical.target.scope !== "platform" ||
                physical.worker.scope !== "platform" ||
                current.scope !== "platform" ||
                physical.target.status !== "active" ||
                !(physical.worker.status === "enrolled" || physical.worker.status === "active") ||
                current.status !== "active" ||
                physical.worker.revokedAt !== null ||
                physical.target.id !== guardAuth.targetId ||
                current.id !== guardAuth.targetId ||
                physical.worker.executionTargetId !== physical.target.id ||
                physical.worker.targetAuthorityKey !== physical.target.targetAuthorityKey ||
                current.targetAuthorityKey !== physical.target.targetAuthorityKey ||
                locked.worker.executionTargetId !== current.id ||
                locked.worker.targetAuthorityKey !== current.targetAuthorityKey ||
                locked.worker.deviceGeneration !== guardAuth.targetGeneration ||
                physical.target.deviceGeneration !== guardAuth.targetGeneration ||
                physical.worker.deviceGeneration !== guardAuth.targetGeneration ||
                current.deviceGeneration !== guardAuth.targetGeneration ||
                physical.worker.devicePublicKey !== guardAuth.publicKey ||
                physical.worker.deviceThumbprint !== guardAuth.deviceThumbprint ||
                !physical.target.registeredProfileHash ||
                physical.target.registeredProfileHash !== current.registeredProfileHash ||
                !physical.worker.profileHash ||
                locked.worker.profileHash !== guardAuth.profileHash ||
                !physical.target.lastSeenAt ||
                !physical.worker.lastSeenAt ||
                platformNow.getTime() - physical.target.lastSeenAt.getTime() > maxHeartbeatAgeMs ||
                platformNow.getTime() - physical.worker.lastSeenAt.getTime() > maxHeartbeatAgeMs) {
              throw new Error("target_revoked");
            }
            return { currentTarget: current, physicalAuthorityWorker: physical.worker };
          });
        };
        const deriveAdmissibleWorkloadTypes = (capacity: any, live: any, provider: any, demand: any) => {
          if (live.total >= provider.maxConcurrentOperations ||
              capacity.freeCpuMillis > provider.resourceCeiling.cpuMillis ||
              capacity.freeMemoryMiB > provider.resourceCeiling.memoryMiB ||
              capacity.freeDiskMiB > provider.resourceCeiling.diskMiB ||
              capacity.freeCpuMillis < demand.resources.cpuMillis ||
              capacity.freeMemoryMiB < demand.resources.memoryMiB ||
              capacity.freeDiskMiB < demand.resources.diskMiB) return [];
          const workloadTypes: string[] = [];
          if (capacity.batchSlots > live.batch) workloadTypes.push("batch");
          if (capacity.browserSessionSlots > live.browserSession) workloadTypes.push("browser_session");
          if (capacity.serviceSlots > live.service) workloadTypes.push("service");
          return workloadTypes;
        };
        return {
          async poll(pollInput: any) {
            const parsedRequestResult = pollRequestV1Schema.safeParse(pollInput.request);
            if (!parsedRequestResult.success) throw new Error("malformed");
            const parsedRequest = parsedRequestResult.data;
            const readySignaled = input.scheduler?.consume(
              pollInput.auth.organizationId,
              pollInput.auth.targetId,
            ) ?? false;
            for (let restartAttempt = 0; restartAttempt < 3; restartAttempt += 1) {
              try {
                return await runInTenant(input.appDb, pollInput.auth.organizationId, async (repos) => {
                  const databaseNow = await repos.jobControl.currentDatabaseTime();
                  const lockedAuthority = await repos.jobControl.lockWorkerLeaseAuthority({
                    workerId: pollInput.auth.workerId,
                    targetId: pollInput.auth.targetId,
                  });
                  if (!lockedAuthority) throw new Error("target_revoked");
                  const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);
                  const platformPhysicalHeartbeatAt = guardedAuthority.physicalAuthorityWorker &&
                      guardedAuthority.currentTarget.lastSeenAt &&
                      guardedAuthority.physicalAuthorityWorker.lastSeenAt
                    ? new Date(Math.min(
                        guardedAuthority.currentTarget.lastSeenAt.getTime(),
                        guardedAuthority.physicalAuthorityWorker.lastSeenAt.getTime(),
                      ))
                    : null;
                  const currentAuthority = authorityCurrent({
                    auth: pollInput.auth,
                    authority: lockedAuthority,
                    request: parsedRequest,
                    databaseNow,
                    maxHeartbeatAgeMs,
                    platformPhysicalHeartbeatAt,
                  });
                  if (!currentAuthority) throw new Error("target_revoked");
                  const normalizedCurrentTarget = await normalizePlacementRegistryTarget(guardedAuthority.currentTarget);
                  if (!normalizedCurrentTarget) throw new Error("target_revoked");
                   const parsedStoredHello = workerHelloV1Schema.safeParse(lockedAuthority.worker.profileSnapshot);
                   if (!parsedStoredHello.success) throw new Error("target_revoked");
                   const effectiveCapacity = minCapacity(
                     parsedStoredHello.data.capacity,
                     parsedRequest.capacity,
                   );
                   const providerDemand = normalizedProviderDemand(normalizedCurrentTarget);
                   const liveCapacity = await repos.jobControl.snapshotLiveLeaseCapacity({
                     workerId: pollInput.auth.workerId,
                     targetId: normalizedCurrentTarget.targetId,
                   });
                   const admissibleWorkloadTypes = deriveAdmissibleWorkloadTypes(
                     effectiveCapacity,
                     liveCapacity,
                     normalizedCurrentTarget.providerConstraintProfile,
                     providerDemand,
                   );
                   const staticContextInput = buildLeaseStaticContextInput({
                    organizationId: lockedAuthority.worker.organizationId,
                    parsedWorkerHello: parsedStoredHello.data,
                    logicalWorker: lockedAuthority.worker,
                    currentTarget: normalizedCurrentTarget,
                    physicalAuthorityWorker: guardedAuthority.physicalAuthorityWorker,
                  });
                   const staticContextHash = leaseStaticContextHash(staticContextInput);
                   const tryOffer = async (candidate: any, normalized: any) => {
                     const ackDeadline = new Date(databaseNow.getTime() + ackTimeoutMs);
                     const expiresAt = new Date(databaseNow.getTime() + leaseDurationMs);
                     const storedHandles = await repos.jobControl.listActiveExecutionSecretHandles({
                       organizationId: candidate.job.organizationId,
                       jobId: candidate.job.id,
                     });
                     const stagedInputRows = await repos.jobArtifacts.listForJob(candidate.job.id);
                     const jobEnvelope = buildJobEnvelope({
                       job: candidate.job,
                       attempt: candidate.attempt,
                       target: normalizedCurrentTarget,
                       requirements: normalized.requirements,
                       resourceLimits: providerDemand.resources,
                       databaseNow,
                       leaseExpiresAt: expiresAt,
                       secretHandles: toSecretHandleRefs(storedHandles),
                       stagedInput: stagedInputPointersFromRows(stagedInputRows, candidate.attempt.attemptNumber),
                     });
                     if (!jobEnvelope) throw new Error("internal_unavailable");
                     const fence = randomBytes(32).toString("base64url");
                     const lease = await repos.jobControl.offerLease({
                       attemptId: candidate.attempt.id,
                       organizationId: candidate.job.organizationId,
                       companyId: candidate.job.companyId,
                       jobId: candidate.job.id,
                       attemptNumber: candidate.attempt.attemptNumber,
                       workerId: pollInput.auth.workerId,
                       targetId: normalizedCurrentTarget.targetId,
                       targetAuthorityKey: lockedAuthority.worker.targetAuthorityKey,
                       targetGeneration: normalizedCurrentTarget.targetGeneration,
                       profileHash: pollInput.auth.profileHash,
                       providerConstraintHash: normalizedCurrentTarget.providerConstraintHash,
                       fence,
                       ackDeadline,
                       expiresAt,
                       createdAt: databaseNow,
                     });
                     if (!lease) return null;
                     const offer = leaseOfferV1Schema.parse({
                       protocolVersion: 1,
                       workerId: pollInput.auth.workerId,
                       leaseId: lease.id,
                       fenceToken: fence,
                       ackDeadline: ackDeadline.toISOString(),
                       expiresAt: expiresAt.toISOString(),
                       job: jobEnvelope,
                       extensions: [],
                     });
                     return pollResponseV1Schema.parse({
                       protocolVersion: 1,
                       correlationId: parsedRequest.correlationId,
                       serverTime: databaseNow.toISOString(),
                       outcome: "offer",
                       body: offer,
                     });
                   };
                   const candidates = await repos.jobControl.lockEligibleLeaseCandidates({
                     admissibleWorkloadTypes,
                    eligibilityVersion: LEASE_STATIC_ELIGIBILITY_VERSION,
                    limit: 256,
                    staticContextHash,
                     targetAuthorityKey: guardedAuthority.currentTarget.targetAuthorityKey,
                    targetClass: normalizedCurrentTarget.targetClass,
                    targetGeneration: normalizedCurrentTarget.targetGeneration,
                    targetId: normalizedCurrentTarget.targetId,
                    placementOwner: normalizedCurrentTarget.targetClass,
                    targetProfileHash: normalizedCurrentTarget.profileHash,
                    targetProviderConstraintHash: normalizedCurrentTarget.providerConstraintHash,
                    targetScope: normalizedCurrentTarget.targetScope,
                    workerId: pollInput.auth.workerId,
                   });
                   const staticNegativeCertificates: any[] = [];
                   for (const candidate of candidates) {
                     const normalized = normalizedRequirements(candidate.job, normalizedCurrentTarget);
                     if (!normalized) throw new Error("internal_unavailable");
                     const evaluation = evaluateStaticLeaseEligibility({
                       target: normalizedCurrentTarget.registeredProfile,
                       verifiedProviderConstraints: normalizedCurrentTarget.providerConstraintProfile,
                       worker: parsedStoredHello.data,
                       requirements: normalized.requirements,
                     });
                     if (!evaluation.eligible) {
                       if (evaluation.reasonCode !== "static_requirements_mismatch") {
                         throw new Error("internal_unavailable");
                       }
                       staticNegativeCertificates.push({
                         candidate,
                         reasonCode: evaluation.reasonCode,
                         staticContextHash,
                       });
                       continue;
                     }
                     if (staticNegativeCertificates.length > 0) {
                       await repos.jobControl.upsertLeaseRejectionCertificates(staticNegativeCertificates);
                     }
                     const offered = await tryOffer(candidate, normalized);
                     if (!offered) throw new HeadRestartConflict();
                     return offered;
                   }
                   if (staticNegativeCertificates.length > 0) {
                     await repos.jobControl.upsertLeaseRejectionCertificates(staticNegativeCertificates);
                   }
                   return pollResponseV1Schema.parse({
                     protocolVersion: 1,
                     correlationId: parsedRequest.correlationId,
                     serverTime: databaseNow.toISOString(),
                     outcome: "no_work",
                     retryAfterMs: readySignaled ? 100 : 750,
                   });
                });
              } catch (error) {
                if (!isHeadRestartConflict(error)) throw error;
                if (restartAttempt >= 2) throw new Error("internal_unavailable");
                continue;
              }
            }
            throw new Error("internal_unavailable");
          },
          async ack(ackInput: any) {
            const request = ackInput.request;
            return runInTenant(input.appDb, ackInput.auth.organizationId, async (repos) => {
              const authority = ackInput.authority;
              const authorityNow = ackInput.databaseNow;
              const platformPhysicalHeartbeatAt = ackInput.platformPhysicalHeartbeatAt;
              if (!authority || !ackAuthorityCurrent({
                auth: ackInput.auth,
                authority,
                workerId: request.body.workerId,
                databaseNow: authorityNow,
                maxHeartbeatAgeMs,
                platformPhysicalHeartbeatAt,
              })) throw new Error("target_revoked");
              await repos.jobControl.activateLeaseAck({});
              return { outcome: "acknowledged" };
            });
          },
        };
      }
    `;
    const validViolations = leaseStaticContextPollViolations(valid);
    expect.soft(validViolations, `valid symbol/provenance fixture: ${validViolations.join("|")}`).toEqual([]);
    const decision124Checks = [
      ["physical-present", "!physical"],
      ["current-target-present", "!current"],
      ["physical-target-platform-scope", 'physical.target.scope !== "platform"'],
      ["physical-worker-platform-scope", 'physical.worker.scope !== "platform"'],
      ["current-target-platform-scope", 'current.scope !== "platform"'],
      ["physical-target-active", 'physical.target.status !== "active"'],
      ["physical-worker-admitted-status", '!(physical.worker.status === "enrolled" || physical.worker.status === "active")'],
      ["current-target-active", 'current.status !== "active"'],
      ["physical-worker-not-revoked", "physical.worker.revokedAt !== null"],
      ["physical-target-auth-id", "physical.target.id !== guardAuth.targetId"],
      ["current-target-auth-id", "current.id !== guardAuth.targetId"],
      ["physical-worker-target-binding", "physical.worker.executionTargetId !== physical.target.id"],
      ["physical-worker-authority-binding", "physical.worker.targetAuthorityKey !== physical.target.targetAuthorityKey"],
      ["current-target-authority-binding", "current.targetAuthorityKey !== physical.target.targetAuthorityKey"],
      ["logical-worker-current-target-binding", "locked.worker.executionTargetId !== current.id"],
      ["logical-worker-current-authority-binding", "locked.worker.targetAuthorityKey !== current.targetAuthorityKey"],
      ["logical-generation-auth", "locked.worker.deviceGeneration !== guardAuth.targetGeneration"],
      ["physical-target-generation-auth", "physical.target.deviceGeneration !== guardAuth.targetGeneration"],
      ["physical-worker-generation-auth", "physical.worker.deviceGeneration !== guardAuth.targetGeneration"],
      ["current-target-generation-auth", "current.deviceGeneration !== guardAuth.targetGeneration"],
      ["physical-device-public-key", "physical.worker.devicePublicKey !== guardAuth.publicKey"],
      ["physical-device-thumbprint", "physical.worker.deviceThumbprint !== guardAuth.deviceThumbprint"],
      ["physical-target-profile-present", "!physical.target.registeredProfileHash"],
      ["physical-current-target-profile", "physical.target.registeredProfileHash !== current.registeredProfileHash"],
      ["physical-worker-profile-present", "!physical.worker.profileHash"],
      ["logical-worker-profile-auth", "locked.worker.profileHash !== guardAuth.profileHash"],
      ["physical-target-heartbeat-present", "!physical.target.lastSeenAt"],
      ["physical-worker-heartbeat-present", "!physical.worker.lastSeenAt"],
      ["physical-target-heartbeat-fresh", "platformNow.getTime() - physical.target.lastSeenAt.getTime() > maxHeartbeatAgeMs"],
      ["physical-worker-heartbeat-fresh", "platformNow.getTime() - physical.worker.lastSeenAt.getTime() > maxHeartbeatAgeMs"],
    ] as const;
    for (const [name, fragment] of decision124Checks) {
      expect.soft(valid, `Decision #124 fixture must contain ${name}`).toContain(fragment);
    }
    const logicalStatusPredicate = '(worker.status === "enrolled" || worker.status === "active")';
    const physicalStatusPredicate =
      '!(physical.worker.status === "enrolled" || physical.worker.status === "active")';
    const replaceOccurrence = (source: string, fragment: string, occurrence: number, replacement: string): string => {
      let index = -1;
      let offset = 0;
      for (let current = 0; current <= occurrence; current += 1) {
        index = source.indexOf(fragment, offset);
        if (index < 0) return source;
        offset = index + fragment.length;
      }
      return source.slice(0, index) + replacement + source.slice(index + fragment.length);
    };
    const ackAuthorityCall = 'ackAuthorityCurrent({\n' +
      '                auth: ackInput.auth,\n' +
      '                authority,\n' +
      '                workerId: request.body.workerId,\n' +
      '                databaseNow: authorityNow,\n' +
      '                maxHeartbeatAgeMs,\n' +
      '                platformPhysicalHeartbeatAt,\n' +
      '              })';
    const ackReject = `if (!authority || !${ackAuthorityCall}) throw new Error("target_revoked");`;
    const ackCallbackStart =
      "return runInTenant(input.appDb, ackInput.auth.organizationId, async (repos) => {";
    expect.soft(valid).toContain(logicalStatusPredicate);
    expect.soft(valid).toContain(physicalStatusPredicate);
    expect.soft(valid).toContain(ackReject);
    expect.soft(valid).toContain(ackCallbackStart);
    const adversaries: Array<{ name: string; source: string; violation: string }> = [
      ...decision124Checks.map(([name, fragment]) => ({
        name: `decision-124-delete-${name}`,
        source: valid.replace(fragment, "false"),
        violation: "builder:trusted-service-authority-guard",
      })),
      {
        name: "decision-124-poll-helper-early-draining-return",
        source: valid.replace(
          "      function authorityCurrent(input: any): boolean {",
          "      function authorityCurrent(input: any): boolean {\n        if (input.authority.worker.status === \"draining\") return true;",
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-ack-helper-early-draining-return",
        source: valid.replace(
          "      function ackAuthorityCurrent(input: any): boolean {",
          "      function ackAuthorityCurrent(input: any): boolean {\n        if (input.authority.worker.status === \"draining\") return true;",
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-ack-method-early-acknowledged-return",
        source: valid.replace(
          "          async ack(ackInput: any) {",
          "          async ack(ackInput: any) {\n            if (ackInput.request.body.workerId) return { outcome: \"acknowledged\" };",
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      ...["activateLeaseAck", "findOperationReceipt", "lockLeaseAckContext", "touchWorkerLeaseProfile"].map(
        (effect) => ({
          name: `decision-124-ack-${effect}-default-parameter-effect`,
          source: valid.replace(
            ackCallbackStart,
            ackCallbackStart.replace(
              "async (repos)",
              `async (repos, _unused = repos.jobControl.${effect}({}))`,
            ),
          ),
          violation: "builder:trusted-service-authority-guard",
        }),
      ),
      {
        name: "decision-124-ack-extra-optional-parameter",
        source: valid.replace(
          ackCallbackStart,
          ackCallbackStart.replace("async (repos)", "async (repos, _extra?: unknown)"),
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-ack-destructured-parameter",
        source: valid.replace(
          ackCallbackStart,
          ackCallbackStart.replace("async (repos)", "async ({ repos }: any)"),
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-ack-rest-parameter",
        source: valid.replace(
          ackCallbackStart,
          ackCallbackStart.replace("async (repos)", "async (...[repos]: any[])"),
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-narrow-physical-worker-to-active-only",
        source: valid.replace(physicalStatusPredicate, 'physical.worker.status !== "active"'),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-omit-physical-worker-status-membership",
        source: valid.replace(`                ${physicalStatusPredicate} ||\n`, ""),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-drop-poll-logical-worker-status-gate",
        source: replaceOccurrence(valid, logicalStatusPredicate, 0, "true"),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-drop-ack-logical-worker-status-gate",
        source: replaceOccurrence(valid, logicalStatusPredicate, 1, "true"),
        violation: "builder:trusted-service-authority-guard",
      },
      ...[
        ["poll", 0],
        ["ack", 1],
      ].map(([gate, occurrence]) => ({
        name: `decision-124-widen-${gate}-worker-status-gate`,
        source: replaceOccurrence(
          valid,
          logicalStatusPredicate,
          occurrence as number,
          '(worker.status === "enrolled" || worker.status === "active" || worker.status === "draining")',
        ),
        violation: "builder:trusted-service-authority-guard",
      })),
      {
        name: "decision-124-widen-physical-worker-status-gate",
        source: valid.replace(
          physicalStatusPredicate,
          '!(physical.worker.status === "enrolled" || physical.worker.status === "active" || physical.worker.status === "draining")',
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-invert-poll-worker-status-gate",
        source: replaceOccurrence(
          valid,
          logicalStatusPredicate,
          0,
          '(worker.status !== "enrolled" || worker.status === "active")',
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-invert-ack-worker-status-gate",
        source: replaceOccurrence(
          valid,
          logicalStatusPredicate,
          1,
          '(worker.status === "enrolled" || worker.status !== "active")',
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-invert-physical-worker-status-gate",
        source: valid.replace(physicalStatusPredicate, physicalStatusPredicate.slice(1)),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-launder-poll-worker-status-gate",
        source: replaceOccurrence(valid, logicalStatusPredicate, 0, "pollStatusAllowed").replace(
          "        return worker.id === auth.workerId &&",
          `        const pollStatusAllowed = ${logicalStatusPredicate};\n        return worker.id === auth.workerId &&`,
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-launder-ack-status-expression-then-return-true",
        source: replaceOccurrence(valid, logicalStatusPredicate, 1, "true").replace(
          "        return input.workerId === auth.workerId &&",
          `        ${logicalStatusPredicate};\n        return input.workerId === auth.workerId &&`,
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-launder-physical-worker-status-gate",
        source: valid.replace(physicalStatusPredicate, "!physicalStatusAllowed").replace(
          "            if (!physical ||",
          `            const physicalStatusAllowed = ${physicalStatusPredicate.slice(1)};\n            if (!physical ||`,
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-dead-ack-authority-call",
        source: valid.replace(
          ackReject,
          `void ${ackAuthorityCall};\n              if (!authority) throw new Error("target_revoked");`,
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-inverted-ack-authority-reject",
        source: valid.replace(ackReject, ackReject.replace("!ackAuthorityCurrent", "ackAuthorityCurrent")),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-constant-ack-authority-reject",
        source: valid.replace(ackReject, ackReject.replace(")) throw", ") || true) throw")),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-conditional-ack-authority-reject",
        source: valid.replace(ackReject, `if (ackInput.enforceAuthority) { ${ackReject} }`),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-caught-ack-authority-reject",
        source: valid.replace(ackReject, `try { ${ackReject} } catch {}`),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-promise-wrapped-ack-authority-call",
        source: valid.replace(
          ackReject,
          `await Promise.all([${ackAuthorityCall}]);\n              if (!authority) throw new Error("target_revoked");`,
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-aliased-ack-authority-result",
        source: valid.replace(
          ackReject,
          `const ackCurrent = ${ackAuthorityCall};\n              if (!authority || !ackCurrent) throw new Error("target_revoked");`,
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "decision-124-ack-effect-before-authority-reject",
        source: valid.replace(
          ackReject,
          `await repos.jobControl.findOperationReceipt({});\n              ${ackReject}`,
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "fake-builder-import",
        source: valid.replace(
          'from "./job-lease-eligibility.js";',
          'from "./fake-job-lease-eligibility.js";',
        ),
        violation: "import:buildLeaseStaticContextInput",
      },
      {
        name: "aliased-builder-import",
        source: valid
          .replace("buildLeaseStaticContextInput,", "buildLeaseStaticContextInput as projectContext,")
          .replace("const staticContextInput = buildLeaseStaticContextInput(", "const staticContextInput = projectContext("),
        violation: "builder:exactly-one-direct-call",
      },
      {
        name: "builder-wrapper",
        source: valid.replace(
          "const staticContextInput = buildLeaseStaticContextInput(",
          "const projectContext = buildLeaseStaticContextInput; const staticContextInput = projectContext(",
        ),
        violation: "builder:laundered-use",
      },
      {
        name: "builder-call",
        source: valid.replace(
          "const staticContextInput = buildLeaseStaticContextInput(",
          "const staticContextInput = buildLeaseStaticContextInput.call(null, ",
        ),
        violation: "builder:laundered-use",
      },
      {
        name: "builder-apply",
        source: valid.replace(
          "const staticContextInput = buildLeaseStaticContextInput(",
          "const staticContextInput = buildLeaseStaticContextInput.apply(null, [",
        ).replace(
          "                });\n                const staticContextHash",
          "                }]);\n                const staticContextHash",
        ),
        violation: "builder:laundered-use",
      },
      {
        name: "builder-bind",
        source: valid.replace(
          "const staticContextInput = buildLeaseStaticContextInput(",
          "const staticContextInput = buildLeaseStaticContextInput.bind(null)(",
        ),
        violation: "builder:laundered-use",
      },
      {
        name: "conditional-builder",
        source: valid.replace(
          "const staticContextInput = buildLeaseStaticContextInput(",
          "const staticContextInput = pollInput.useFresh ? buildLeaseStaticContextInput(",
        ).replace(
          "                });\n                const staticContextHash",
          "                }) : buildLeaseStaticContextInput(pollInput.context);\n                const staticContextHash",
        ),
        violation: "builder:direct-const-binding",
      },
      {
        name: "promise-all-builder",
        source: valid.replace(
          "const staticContextInput = buildLeaseStaticContextInput(",
          "const [staticContextInput] = await Promise.all([buildLeaseStaticContextInput(",
        ).replace(
          "                });\n                const staticContextHash",
          "                })]);\n                const staticContextHash",
        ),
        violation: "builder:direct-const-binding",
      },
      {
        name: "try-catch-builder",
        source: valid.replace(
          "const staticContextInput = buildLeaseStaticContextInput(",
          "try { const staticContextInput = buildLeaseStaticContextInput(",
        ).replace(
          "                return candidates;",
          "                return candidates; } catch { return []; }",
        ),
        violation: "builder:unconditional-top-level-attempt-call",
      },
      {
        name: "shadowed-builder",
        source: valid.replace(
          "const staticContextInput = buildLeaseStaticContextInput(",
          "const buildLeaseStaticContextInput = fakeBuilder; const staticContextInput = buildLeaseStaticContextInput(",
        ),
        violation: "builder:shadowed-import",
      },
      {
        name: "reassigned-builder-result",
        source: valid.replace(
          "const staticContextHash = leaseStaticContextHash(staticContextInput);",
          "staticContextInput = pollInput.context; const staticContextHash = leaseStaticContextHash(staticContextInput);",
        ),
        violation: "binding:reassigned:staticContextInput",
      },
      {
        name: "auth-organization-substitution",
        source: valid.replace(
          "organizationId: lockedAuthority.worker.organizationId",
          "organizationId: pollInput.auth.organizationId",
        ),
        violation: "builder:locked-logical-organization-source",
      },
      {
        name: "raw-profile-instead-of-parsed-hello",
        source: valid.replace(
          "parsedWorkerHello: parsedStoredHello.data",
          "parsedWorkerHello: lockedAuthority.worker.profileSnapshot",
        ),
        violation: "builder:parsed-stored-hello-source",
      },
      {
        name: "request-logical-substitution",
        source: valid.replace(
          "logicalWorker: lockedAuthority.worker",
          "logicalWorker: pollInput.request.worker",
        ),
        violation: "builder:locked-logical-worker-source",
      },
      {
        name: "pre-guard-target-substitution",
        source: valid.replace(
          "currentTarget: normalizedCurrentTarget",
          "currentTarget: lockedAuthority.target",
        ),
        violation: "builder:current-normalized-target-source",
      },
      {
        name: "logical-physical-collapse",
        source: valid.replace(
          "physicalAuthorityWorker: guardedAuthority.physicalAuthorityWorker",
          "physicalAuthorityWorker: lockedAuthority.worker",
        ),
        violation: "builder:guarded-physical-source",
      },
      {
        name: "spread-override",
        source: valid.replace(
          "organizationId: lockedAuthority.worker.organizationId,",
          "...pollInput.context, organizationId: lockedAuthority.worker.organizationId,",
        ),
        violation: "builder:closed-source-object",
      },
      {
        name: "computed-override",
        source: valid.replace(
          "organizationId: lockedAuthority.worker.organizationId,",
          "[pollInput.key]: pollInput.value, organizationId: lockedAuthority.worker.organizationId,",
        ),
        violation: "builder:closed-source-object",
      },
      {
        name: "second-builder",
        source: valid.replace(
          "const staticContextHash = leaseStaticContextHash(staticContextInput);",
          "buildLeaseStaticContextInput(pollInput.context); const staticContextHash = leaseStaticContextHash(staticContextInput);",
        ),
        violation: "builder:exactly-one-direct-call",
      },
      {
        name: "inline-hash",
        source: valid.replace(
          "const staticContextHash = leaseStaticContextHash(staticContextInput);",
          "const staticContextHash = \"decoy\";",
        ).replace(
          "{ staticContextHash }",
          "{ staticContextHash: leaseStaticContextHash(staticContextInput) }",
        ),
        violation: "hash:exactly-one-direct-call",
      },
      {
        name: "hash-wrapper",
        source: valid.replace(
          "const staticContextHash = leaseStaticContextHash(staticContextInput);",
          "const hashContext = leaseStaticContextHash; const staticContextHash = hashContext(staticContextInput);",
        ),
        violation: "hash:laundered-use",
      },
      {
        name: "second-hash",
        source: valid.replace(
          "const staticContextHash = leaseStaticContextHash(staticContextInput);",
          "leaseStaticContextHash(staticContextInput); const staticContextHash = leaseStaticContextHash(staticContextInput);",
        ),
        violation: "hash:exactly-one-direct-call",
      },
      {
        name: "second-candidate-selection",
        source: valid.replace(
          "const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
          "await repos.jobControl.lockEligibleLeaseCandidates({}); const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
        ),
        violation: "candidate:exactly-one-selection-call",
      },
      {
        name: "service-builder-injection",
        source: valid.replace(
          "operatorDb: any",
          "operatorDb: any; contextBuilder?: unknown",
        ),
        violation: "service:no-context-or-guard-injection",
      },
      {
        name: "builder-outside-attempt-transaction",
        source: valid.replace(
          "return await runInTenant(input.appDb, pollInput.auth.organizationId, async (repos) => {",
          "const leaked = buildLeaseStaticContextInput(pollInput.context); return await runInTenant(input.appDb, pollInput.auth.organizationId, async (repos) => {",
        ),
        violation: "builder:exactly-one-direct-call",
      },
      {
        name: "transaction-outside-restart",
        source: valid
          .replace("for (let restartAttempt = 0; restartAttempt < 3; restartAttempt += 1) {", "{")
          .replace("            throw new Error(\"internal_unavailable\");", "            throw new Error(\"internal_unavailable\");"),
        violation: "poll:tenant-transaction-inside-restart-loop",
      },
      {
        name: "request-tenant-organization",
        source: valid.replace(
          "runInTenant(input.appDb, pollInput.auth.organizationId",
          "runInTenant(input.appDb, pollInput.request.organizationId",
        ),
        violation: "poll:tenant-from-auth-organization",
      },
      {
        name: "request-lock-receiver",
        source: valid.replace(
          "repos.jobControl.lockWorkerLeaseAuthority",
          "pollInput.request.jobControl.lockWorkerLeaseAuthority",
        ),
        violation: "builder:logical-from-locked-authority",
      },
      {
        name: "request-lock-worker",
        source: valid.replace(
          "workerId: pollInput.auth.workerId,\n                    targetId: pollInput.auth.targetId,",
          "workerId: pollInput.request.workerId,\n                    targetId: pollInput.auth.targetId,",
        ),
        violation: "builder:logical-from-locked-authority",
      },
      {
        name: "request-lock-target",
        source: valid.replace("targetId: pollInput.auth.targetId,", "targetId: pollInput.request.targetId,"),
        violation: "builder:logical-from-locked-authority",
      },
      {
        name: "fake-local-authority-guard",
        source: valid.replace(
          "const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
          "const guardPlatformAuthority = async () => pollInput.request; const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "guard-request-repositories",
        source: valid.replace(
          "guardPlatformAuthority(repos, pollInput.auth, lockedAuthority)",
          "guardPlatformAuthority(pollInput.request.repos, pollInput.auth, lockedAuthority)",
        ),
        violation: "builder:physical-from-authority-guard",
      },
      {
        name: "duplicate-builder-property",
        source: valid.replace(
          "organizationId: lockedAuthority.worker.organizationId,",
          "organizationId: pollInput.request.organizationId, organizationId: lockedAuthority.worker.organizationId,",
        ),
        violation: "builder:closed-source-object",
      },
      {
        name: "candidate-spread-override",
        source: valid.replace(
          "admissibleWorkloadTypes,",
          "...pollInput.request, admissibleWorkloadTypes,",
        ),
        violation: "candidate:closed-input-object",
      },
      {
        name: "candidate-computed-override",
        source: valid.replace(
          "admissibleWorkloadTypes,",
          "[pollInput.key]: pollInput.value, admissibleWorkloadTypes,",
        ),
        violation: "candidate:closed-input-object",
      },
      {
        name: "candidate-duplicate-hash-override",
        source: valid.replace(
          "                    staticContextHash,\n                     targetAuthorityKey:",
          "                    staticContextHash, staticContextHash: pollInput.request.hash,\n                     targetAuthorityKey:",
        ),
        violation: "candidate:closed-input-object",
      },
      {
        name: "candidate-request-receiver",
        source: valid.replace(
          "repos.jobControl.lockEligibleLeaseCandidates",
          "pollInput.request.jobControl.lockEligibleLeaseCandidates",
        ),
        violation: "candidate:awaited-top-level-repository-selection",
      },
      {
        name: "candidate-request-hash",
        source: valid.replace(
          "                    staticContextHash,\n                     targetAuthorityKey:",
          "                    staticContextHash: pollInput.request.hash,\n                     targetAuthorityKey:",
        ),
        violation: "candidate:bind-one-context-hash",
      },
      {
        name: "conditional-candidate",
        source: valid.replace(
          "const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
          "const candidates = pollInput.useFresh ? await repos.jobControl.lockEligibleLeaseCandidates({",
        ).replace(
          "                  });\n                  return candidates;",
          "                  }) : [];\n                  return candidates;",
        ),
        violation: "candidate:awaited-top-level-repository-selection",
      },
      {
        name: "try-catch-candidate",
        source: valid.replace(
          "const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
          "try { const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
        ).replace(
          "                  return candidates;",
          "                  return candidates; } catch { return []; }",
        ),
        violation: "candidate:awaited-top-level-repository-selection",
      },
      {
        name: "promise-all-candidate",
        source: valid.replace(
          "const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
          "const [candidates] = await Promise.all([repos.jobControl.lockEligibleLeaseCandidates({",
        ).replace(
          "                  });\n                  return candidates;",
          "                  })]);\n                  return candidates;",
        ),
        violation: "candidate:awaited-top-level-repository-selection",
      },
      {
        name: "early-return-before-canonical-chain",
        source: valid.replace(
          "const staticContextInput = buildLeaseStaticContextInput({",
          "if (pollInput.request.skip) return []; const staticContextInput = buildLeaseStaticContextInput({",
        ),
        violation: "candidate:canonical-chain-dominates-return",
      },
      {
        name: "one-iteration-restart-loop",
        source: valid.replace("restartAttempt < 3", "restartAttempt < 1"),
        violation: "poll:bounded-two-to-three-restart-attempts",
      },
      {
        name: "mutate-locked-authority",
        source: valid.replace(
          "const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
          "Object.assign(lockedAuthority.worker, pollInput.request.worker); const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
        ),
        violation: "binding:mutated-authority-or-context",
      },
      {
        name: "mutate-projected-context",
        source: valid.replace(
          "const staticContextHash = leaseStaticContextHash(staticContextInput);",
          "staticContextInput[pollInput.key] = pollInput.value; const staticContextHash = leaseStaticContextHash(staticContextInput);",
        ),
        violation: "binding:mutated-authority-or-context",
      },
      {
        name: "inverted-authority-validation",
        source: valid.replace("if (!lockedAuthority) throw", "if (lockedAuthority) throw"),
        violation: "builder:locked-logical-validated",
      },
      {
        name: "inverted-hello-validation",
        source: valid.replace("if (!parsedStoredHello.success) throw", "if (parsedStoredHello.success) throw"),
        violation: "builder:stored-hello-validated",
      },
      {
        name: "dead-nested-authority-throw",
        source: valid.replace(
          "if (!lockedAuthority) throw new Error(\"target_revoked\");",
          "if (!lockedAuthority) { if (false) throw new Error(\"target_revoked\"); }",
        ),
        violation: "builder:locked-logical-validated",
      },
      {
        name: "shadowed-run-in-tenant",
        source: valid.replace(
          "for (let restartAttempt = 0; restartAttempt < 3; restartAttempt += 1) {",
          "const runInTenant = fakeTenant; for (let restartAttempt = 0; restartAttempt < 3; restartAttempt += 1) {",
        ),
        violation: "import-symbol:runInTenant:shadowed-import",
      },
      {
        name: "shadowed-worker-hello-schema",
        source: valid.replace(
          "const parsedStoredHello = workerHelloV1Schema.safeParse",
          "const workerHelloV1Schema = fakeSchema; const parsedStoredHello = workerHelloV1Schema.safeParse",
        ),
        violation: "import-symbol:workerHelloV1Schema:shadowed-import",
      },
      {
        name: "shadowed-placement-normalizer",
        source: valid.replace(
          "const normalizedCurrentTarget = await normalizePlacementRegistryTarget",
          "const normalizePlacementRegistryTarget = fakeNormalizer; const normalizedCurrentTarget = await normalizePlacementRegistryTarget",
        ),
        violation: "import-symbol:normalizePlacementRegistryTarget:shadowed-import",
      },
      {
        name: "computed-service-hook",
        source: valid.replace(
          "export function createJobLeasingService(input: {",
          "export function createJobLeasingService(input: {",
        ).replace(
          "        const guardPlatformAuthority",
          "        input[\"contextBuilder\"]; const guardPlatformAuthority",
        ),
        violation: "service:no-context-or-guard-injection",
      },
      {
        name: "named-interface-service-hook",
        source: `interface ServiceOptions { appDb: unknown; operatorDb: any; scheduler?: any; ackTimeoutMs?: number; leaseDurationMs?: number; maxHeartbeatAgeMs?: number; contextBuilder?: unknown }\n${valid}`.replace(
          "input: {\n        appDb: unknown;\n        operatorDb: any;\n        scheduler?: any;\n        ackTimeoutMs?: number;\n        leaseDurationMs?: number;\n        maxHeartbeatAgeMs?: number;\n      }",
          "input: ServiceOptions",
        ),
        violation: "service:no-context-or-guard-injection",
      },
      {
        name: "first-decoy-poll-does-not-mask-returned-poll",
        source: `const decoy = { async poll() { const decoyInput = buildLeaseStaticContextInput({}); return leaseStaticContextHash(decoyInput); } };\n${valid.replace(
          "runInTenant(input.appDb, pollInput.auth.organizationId",
          "runInTenant(input.appDb, pollInput.request.organizationId",
        )}`,
        violation: "poll:tenant-from-auth-organization",
      },
      {
        name: "extra-helper-builder-and-hash-calls",
        source: `${valid}\nfunction extraContextHelper() { const projected = buildLeaseStaticContextInput({}); return leaseStaticContextHash(projected); }`,
        violation: "builder:exactly-one-direct-call",
      },
      {
        name: "request-supplied-app-db",
        source: valid.replace(
          "runInTenant(input.appDb, pollInput.auth.organizationId",
          "runInTenant(pollInput.request.appDb, pollInput.auth.organizationId",
        ),
        violation: "poll:tenant-from-service-app-db",
      },
      {
        name: "retry-all-catch-with-dead-throw",
        source: valid.replace(
          "if (!isHeadRestartConflict(error)) throw error;",
          "if (false) throw error;",
        ),
        violation: "poll:head-conflict-only-restart",
      },
      {
        name: "wrong-head-conflict-classifier",
        source: valid.replace("isHeadRestartConflict(error)", "isAnyRetryableError(error)"),
        violation: "poll:head-conflict-only-restart",
      },
      {
        name: "head-conflict-exhaustion-reraises-sentinel",
        source: valid.replace(
          'if (restartAttempt >= 2) throw new Error("internal_unavailable");',
          "if (restartAttempt >= 2) throw error;",
        ),
        violation: "poll:head-conflict-only-restart",
      },
      {
        name: "head-conflict-catch-without-explicit-continue",
        source: valid.replace(
          '                if (restartAttempt >= 2) throw new Error("internal_unavailable");\n                continue;',
          '                if (restartAttempt >= 2) throw new Error("internal_unavailable");',
        ),
        violation: "poll:head-conflict-only-restart",
      },
      {
        name: "operator-repository-uses-wrong-transaction",
        source: valid.replace(
          "operatorJobLeasingRepository(operatorTx)",
          "operatorJobLeasingRepository(input.operatorDb)",
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "authority-guard-deletes-null-validation",
        source: valid.replace(
          "            if (!physical ||\n",
          "            if (\n",
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "dead-exact-authority-return-before-request-return",
        source: valid.replace(
          "return { currentTarget: current, physicalAuthorityWorker: physical.worker };",
          "if (false) return { currentTarget: current, physicalAuthorityWorker: physical.worker }; return { currentTarget: locked.request.currentTarget, physicalAuthorityWorker: locked.request.worker };",
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "candidate-target-generation-from-auth",
        source: valid.replace(
          "                    targetGeneration: normalizedCurrentTarget.targetGeneration,\n                    targetId:",
          "                    targetGeneration: pollInput.auth.targetGeneration,\n                    targetId:",
        ),
        violation: "candidate:current-target-provenance",
      },
      {
        name: "candidate-target-profile-from-auth",
        source: valid.replace(
          "targetProfileHash: normalizedCurrentTarget.profileHash,",
          "targetProfileHash: pollInput.auth.profileHash,",
        ),
        violation: "candidate:current-target-provenance",
      },
      {
        name: "candidate-target-provider-from-auth",
        source: valid.replace(
          "targetProviderConstraintHash: normalizedCurrentTarget.providerConstraintHash,",
          "targetProviderConstraintHash: pollInput.auth.providerConstraintHash,",
        ),
        violation: "candidate:current-target-provenance",
      },
      {
        name: "candidate-hard-coded-eligibility-version",
        source: valid.replace(
          "eligibilityVersion: LEASE_STATIC_ELIGIBILITY_VERSION,",
          "eligibilityVersion: 999,",
        ),
        violation: "candidate:server-eligibility-version",
      },
      {
        name: "ignored-candidate-result",
        source: valid.replace(
          "                   for (const candidate of candidates) {",
          "                   for (const candidate of []) {",
        ),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "request-candidate-result",
        source: valid.replace(
          "                   for (const candidate of candidates) {",
          "                   for (const candidate of pollInput.request.candidates) {",
        ),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "computed-second-candidate-selection",
        source: valid.replace(
          "const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
          "await repos.jobControl[pollInput.request.method]({}); const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
        ),
        violation: "candidate:exactly-one-selection-call",
      },
      {
        name: "element-access-second-candidate-selection",
        source: valid.replace(
          "const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
          'await repos.jobControl["lockEligibleLeaseCandidates"]({}); const candidates = await repos.jobControl.lockEligibleLeaseCandidates({',
        ),
        violation: "candidate:exactly-one-selection-call",
      },
      {
        name: "aliased-second-candidate-selection",
        source: valid.replace(
          "const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
          "const selectCandidates = repos.jobControl.lockEligibleLeaseCandidates; await selectCandidates({}); const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
        ),
        violation: "candidate:exactly-one-selection-call",
      },
      {
        name: "destructured-second-candidate-selection",
        source: valid.replace(
          "const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
          "const { lockEligibleLeaseCandidates: selectCandidates } = repos.jobControl; await selectCandidates({}); const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
        ),
        violation: "candidate:exactly-one-selection-call",
      },
      {
        name: "destructured-service-builder-hook",
        source: valid
          .replace(
            "createJobLeasingService(input: {\n        appDb: unknown;\n        operatorDb: any;\n        scheduler?: any;\n        ackTimeoutMs?: number;\n        leaseDurationMs?: number;\n        maxHeartbeatAgeMs?: number;\n      })",
            "createJobLeasingService({ appDb, operatorDb, scheduler, ackTimeoutMs: configuredAckTimeoutMs, leaseDurationMs: configuredLeaseDurationMs, maxHeartbeatAgeMs: configuredMaxHeartbeatAgeMs, builder }: { appDb: unknown; operatorDb: any; scheduler?: any; ackTimeoutMs?: number; leaseDurationMs?: number; maxHeartbeatAgeMs?: number; builder?: unknown })",
          )
          .replaceAll("input.appDb", "appDb")
          .replaceAll("input.operatorDb", "operatorDb")
          .replaceAll("input.scheduler", "scheduler")
          .replaceAll("input.ackTimeoutMs", "configuredAckTimeoutMs")
          .replaceAll("input.leaseDurationMs", "configuredLeaseDurationMs")
          .replaceAll("input.maxHeartbeatAgeMs", "configuredMaxHeartbeatAgeMs"),
        violation: "service:no-context-or-guard-injection",
      },
      {
        name: "renamed-service-option-builder-hook",
        source: valid
          .replace(
            "createJobLeasingService(input: {\n        appDb: unknown;\n        operatorDb: any;\n        scheduler?: any;\n        ackTimeoutMs?: number;\n        leaseDurationMs?: number;\n        maxHeartbeatAgeMs?: number;\n      })",
            "createJobLeasingService(options: { appDb: unknown; operatorDb: any; scheduler?: any; ackTimeoutMs?: number; leaseDurationMs?: number; maxHeartbeatAgeMs?: number; builder?: unknown })",
          )
          .replaceAll("input.", "options.")
          .replace(
            "const guardPlatformAuthority",
            "const { builder } = options; const guardPlatformAuthority",
          ),
        violation: "service:no-context-or-guard-injection",
      },
      {
        name: "object-assign-service-observer-hook",
        source: valid.replace(
          "const guardPlatformAuthority",
          "Object.assign(input, { observer: pollInputObserver }); const guardPlatformAuthority",
        ),
        violation: "service:no-context-or-guard-injection",
      },
      {
        name: "aliased-worker-object-assign-mutation",
        source: valid.replace(
          "const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
          "const workerAlias = lockedAuthority.worker; Object.assign(workerAlias, pollInput.request.worker); const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
        ),
        violation: "binding:mutated-authority-or-context",
      },
      {
        name: "destructured-worker-object-assign-mutation",
        source: valid.replace(
          "const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
          "const { worker: workerAlias } = lockedAuthority; Object.assign(workerAlias, pollInput.request.worker); const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
        ),
        violation: "binding:mutated-authority-or-context",
      },
      {
        name: "non-platform-source-collapse",
        source: valid.replace(
          "return { currentTarget: locked.target, physicalAuthorityWorker: null };",
          "return { currentTarget: locked.target, physicalAuthorityWorker: locked.worker };",
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "shadowed-head-conflict-classifier",
        source: valid.replace(
          "            for (let restartAttempt = 0; restartAttempt < 3; restartAttempt += 1) {",
          "            const isHeadRestartConflict = () => true; for (let restartAttempt = 0; restartAttempt < 3; restartAttempt += 1) {",
        ),
        violation: "poll:trusted-head-conflict-sentinel",
      },
      {
        name: "fake-head-conflict-classifier-semantics",
        source: valid.replace(
          "error instanceof HeadRestartConflict;",
          "Boolean(error);",
        ),
        violation: "poll:trusted-head-conflict-sentinel",
      },
      {
        name: "reset-restart-counter-inside-attempt",
        source: valid.replace(
          "              try {\n                return await runInTenant",
          "              try { restartAttempt = 0;\n                return await runInTenant",
        ),
        violation: "poll:immutable-restart-counter",
      },
      {
        name: "mutable-restart-bound",
        source: valid.replace(
          "            for (let restartAttempt = 0; restartAttempt < 3; restartAttempt += 1) {",
          "            let restartBound = 3; for (let restartAttempt = 0; restartAttempt < restartBound; restartAttempt += 1) {",
        ),
        violation: "poll:bounded-two-to-three-restart-attempts",
      },
      {
        name: "candidate-authority-key-from-auth",
        source: valid.replace(
          "targetAuthorityKey: guardedAuthority.currentTarget.targetAuthorityKey,",
          "targetAuthorityKey: pollInput.auth.targetAuthorityKey,",
        ),
        violation: "candidate:current-target-provenance",
      },
      {
        name: "candidate-class-from-auth",
        source: valid.replace(
          "targetClass: normalizedCurrentTarget.targetClass,",
          "targetClass: pollInput.auth.targetClass,",
        ),
        violation: "candidate:current-target-provenance",
      },
      {
        name: "candidate-placement-owner-from-target-owner-user-id",
        source: valid.replace(
          "placementOwner: normalizedCurrentTarget.targetClass,",
          "placementOwner: guardedAuthority.currentTarget.ownerUserId,",
        ),
        violation: "candidate:current-target-provenance",
      },
      {
        name: "candidate-placement-owner-from-authenticated-owner-user-id",
        source: valid.replace(
          "placementOwner: normalizedCurrentTarget.targetClass,",
          "placementOwner: pollInput.auth.ownerUserId,",
        ),
        violation: "candidate:current-target-provenance",
      },
      {
        name: "candidate-ambiguous-target-owner-key",
        source: valid.replace(
          "placementOwner: normalizedCurrentTarget.targetClass,",
          "targetOwner: normalizedCurrentTarget.targetClass,",
        ),
        violation: "candidate:closed-input-object",
      },
      {
        name: "candidate-scope-from-auth",
        source: valid.replace(
          "targetScope: normalizedCurrentTarget.targetScope,",
          "targetScope: pollInput.auth.targetScope,",
        ),
        violation: "candidate:current-target-provenance",
      },
      {
        name: "candidate-limit-one",
        source: valid.replace("limit: 256,", "limit: 1,"),
        violation: "candidate:bounded-global-head-limit",
      },
      {
        name: "candidate-literal-admissible-workloads",
        source: valid.replace("admissibleWorkloadTypes,", 'admissibleWorkloadTypes: ["batch"],'),
        violation: "candidate:dynamic-admissible-workload-source",
      },
      {
        name: "candidate-request-derived-admissible-workloads",
        source: valid.replace(
          "const admissibleWorkloadTypes = deriveAdmissibleWorkloadTypes(\n                     effectiveCapacity,\n                     liveCapacity,\n                     normalizedCurrentTarget.providerConstraintProfile,\n                     providerDemand,\n                   );",
          "const admissibleWorkloadTypes = pollInput.request.workloadTypes;",
        ),
        violation: "candidate:dynamic-admissible-workload-source",
      },
      {
        name: "ceremonial-candidate-loop",
        source: valid.replace(
          "const evaluation = evaluateStaticLeaseEligibility({",
          "const evaluation = ignoredEvaluateStaticLeaseEligibility({",
        ),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "namespace-extra-builder-call",
        source: `import * as eligibilityExtra from "./job-lease-eligibility.js";\n${valid}\nfunction extraNamespaceBuilder() { return eligibilityExtra.buildLeaseStaticContextInput({}); }`,
        violation: "builder:laundered-use",
      },
      {
        name: "element-extra-hash-call",
        source: `${valid}\nfunction extraElementHash(value: any) { return eligibilityExtra["leaseStaticContextHash"](value); }`,
        violation: "hash:laundered-use",
      },
      {
        name: "dynamic-import-extra-builder-call",
        source: `${valid}\nasync function extraDynamicBuilder() { return (await import("./job-lease-eligibility.js")).buildLeaseStaticContextInput({}); }`,
        violation: "builder:laundered-use",
      },
      {
        name: "unknown-hash-tap",
        source: valid.replace(
          "const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
          "auditTap(staticContextHash); const candidates = await repos.jobControl.lockEligibleLeaseCandidates({",
        ),
        violation: "binding:protected-value-escape",
      },
      {
        name: "unknown-authority-helper",
        source: valid.replace(
          "const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
          "unknownHelper(lockedAuthority); const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
        ),
        violation: "binding:protected-value-escape",
      },
      {
        name: "object-assign-call-worker-mutation",
        source: valid.replace(
          "const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
          "Object.assign.call(null, lockedAuthority.worker, pollInput.request.worker); const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
        ),
        violation: "binding:protected-value-escape",
      },
      {
        name: "object-assign-apply-worker-mutation",
        source: valid.replace(
          "const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
          "Object.assign.apply(null, [lockedAuthority.worker, pollInput.request.worker]); const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
        ),
        violation: "binding:protected-value-escape",
      },
      {
        name: "object-assign-bind-worker-mutation",
        source: valid.replace(
          "const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
          "Object.assign.bind(null, lockedAuthority.worker, pollInput.request.worker)(); const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
        ),
        violation: "binding:protected-value-escape",
      },
      {
        name: "unknown-service-tap-option",
        source: valid.replace(
          "        maxHeartbeatAgeMs?: number;\n      }",
          "        maxHeartbeatAgeMs?: number;\n        tap?: unknown;\n      }",
        ),
        violation: "service:no-context-or-guard-injection",
      },
      {
        name: "inner-authority-current-shadow",
        source: valid.replace(
          "            const parsedRequestResult = pollRequestV1Schema.safeParse(pollInput.request);",
          "            if (pollInput.request.shadow) { const authorityCurrent = () => true; void authorityCurrent(); }\n            const parsedRequestResult = pollRequestV1Schema.safeParse(pollInput.request);",
        ),
        violation: "binding:trusted-critical-helper-symbols",
      },
      {
        name: "inner-min-capacity-shadow",
        source: valid.replace(
          "            const parsedRequestResult = pollRequestV1Schema.safeParse(pollInput.request);",
          "            if (pollInput.request.shadow) { const minCapacity = () => pollInput.request.capacity; void minCapacity(); }\n            const parsedRequestResult = pollRequestV1Schema.safeParse(pollInput.request);",
        ),
        violation: "binding:trusted-critical-helper-symbols",
      },
      {
        name: "inner-derived-workloads-shadow",
        source: valid.replace(
          "            const parsedRequestResult = pollRequestV1Schema.safeParse(pollInput.request);",
          "            if (pollInput.request.shadow) { const deriveAdmissibleWorkloadTypes = () => [\"batch\"]; void deriveAdmissibleWorkloadTypes(); }\n            const parsedRequestResult = pollRequestV1Schema.safeParse(pollInput.request);",
        ),
        violation: "binding:trusted-critical-helper-symbols",
      },
      {
        name: "inner-normalized-requirements-shadow",
        source: valid.replace(
          "            const parsedRequestResult = pollRequestV1Schema.safeParse(pollInput.request);",
          "            if (pollInput.request.shadow) { const normalizedRequirements = () => pollInput.request.requirements; void normalizedRequirements(); }\n            const parsedRequestResult = pollRequestV1Schema.safeParse(pollInput.request);",
        ),
        violation: "binding:trusted-critical-helper-symbols",
      },
      {
        name: "inner-provider-demand-shadow",
        source: valid.replace(
          "            const parsedRequestResult = pollRequestV1Schema.safeParse(pollInput.request);",
          "            if (pollInput.request.shadow) { const normalizedProviderDemand = () => pollInput.request.demand; void normalizedProviderDemand(); }\n            const parsedRequestResult = pollRequestV1Schema.safeParse(pollInput.request);",
        ),
        violation: "binding:trusted-critical-helper-symbols",
      },
      {
        name: "dead-authority-current-predicate",
        source: valid.replace(
          "        return worker.id === auth.workerId &&\n          worker.executionTargetId",
          "        void (worker.id === auth.workerId);\n        return true &&\n          worker.executionTargetId",
        ),
        violation: "builder:trusted-non-platform-authority-current",
      },
      {
        name: "assignment-rhs-platform-snapshot-alias",
        source: valid.replace(
          '.lockPlatformPhysicalAuthority(guardAuth.targetId, "share");',
          '.lockPlatformPhysicalAuthority(guardAuth.targetId, "share"); let snapshotAlias: any; snapshotAlias = physical; snapshotAlias.worker.profileHash = guardAuth.profileHash;',
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "assigned-retry-sentinel-escape",
        source: valid.replace(
          "          error instanceof HeadRestartConflict;",
          "          error instanceof HeadRestartConflict; let retrySentinel: any; retrySentinel = HeadRestartConflict;",
        ),
        violation: "poll:trusted-head-conflict-sentinel",
      },
      {
        name: "computed-symbol-has-instance",
        source: valid.replace(
          "          error instanceof HeadRestartConflict;",
          '          error instanceof HeadRestartConflict; Object.defineProperty(HeadRestartConflict, Symbol["hasInstance"], { value: () => true });',
        ),
        violation: "poll:trusted-head-conflict-sentinel",
      },
      {
        name: "whole-module-eligibility-namespace-reflect",
        source: `import * as eligibilityMirror from "./job-lease-eligibility.js";\n${valid}\nconst reflectedEligibilityHash = Reflect.get(eligibilityMirror, "leaseStaticContextHash");`,
        violation: "import:job-lease-eligibility-named-only",
      },
      {
        name: "whole-module-eligibility-dynamic-import",
        source: `${valid}\nasync function loadEligibilityMirror() { return import("./job-lease-eligibility.js"); }`,
        violation: "import:job-lease-eligibility-named-only",
      },
      {
        name: "whole-module-reflect-critical-string",
        source: `${valid}\nconst reflectedEligibilityHash = Reflect.get(globalThis, "leaseStaticContextHash");`,
        violation: "import:job-lease-eligibility-named-only",
      },
      {
        name: "reflect-service-input-tap",
        source: valid.replace(
          "        const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300000);",
          '        const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300000); Reflect.get(input, "tap");',
        ),
        violation: "service:no-context-or-guard-injection",
      },
      {
        name: "container-service-input-escape",
        source: valid.replace(
          "        const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300000);",
          "        const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300000); const escapedOptions = { input }; void escapedOptions;",
        ),
        violation: "service:no-context-or-guard-injection",
      },
      {
        name: "computed-allowed-service-option",
        source: valid.replace("runInTenant(input.appDb,", 'runInTenant(input["appDb"],'),
        violation: "service:no-context-or-guard-injection",
      },
      {
        name: "provider-demand-from-request",
        source: valid.replace(
          "normalizedProviderDemand(normalizedCurrentTarget)",
          "normalizedProviderDemand(pollInput.request.target)",
        ),
        violation: "candidate:dynamic-admissible-workload-source",
      },
      {
        name: "provider-demand-cpu-fit-deleted",
        source: valid.replace(
          "              capacity.freeCpuMillis < demand.resources.cpuMillis ||\n",
          "",
        ),
        violation: "candidate:dynamic-admissible-workload-source",
      },
      {
        name: "provider-demand-memory-fit-deleted",
        source: valid.replace(
          "              capacity.freeMemoryMiB < demand.resources.memoryMiB ||\n",
          "",
        ),
        violation: "candidate:dynamic-admissible-workload-source",
      },
      {
        name: "provider-demand-disk-fit-deleted",
        source: valid.replace(
          "              capacity.freeDiskMiB < demand.resources.diskMiB) return [];",
          "              false) return [];",
        ),
        violation: "candidate:dynamic-admissible-workload-source",
      },
      {
        name: "short-invented-offer-lease-input",
        source: valid.replace(
          /                       attemptId: candidate\.attempt\.id,[\s\S]*?                       createdAt: databaseNow,/,
          "                       candidate,\n                       staticContextHash,",
        ),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "offer-lease-wrong-authority-key",
        source: valid.replace(
          "targetAuthorityKey: lockedAuthority.worker.targetAuthorityKey,",
          "targetAuthorityKey: pollInput.auth.targetAuthorityKey,",
        ),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "lease-offer-missing-protocol-version",
        source: valid.replace(
          "                       protocolVersion: 1,\n                       workerId: pollInput.auth.workerId,",
          "                       workerId: pollInput.auth.workerId,",
        ),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "poll-offer-missing-server-time",
        source: valid.replace(
          "                       serverTime: databaseNow.toISOString(),\n                       outcome: \"offer\",",
          "                       outcome: \"offer\",",
        ),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "no-work-missing-retry-after",
        source: valid.replace("                     retryAfterMs: readySignaled ? 100 : 750,\n", ""),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "nested-closure-protected-snapshot-laundering",
        source: valid.replace(
          "const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
          "const leakAuthority = () => lockedAuthority; void leakAuthority(); const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);",
        ),
        violation: "binding:protected-value-escape",
      },
      {
        name: "nested-closure-guard-snapshot-laundering",
        source: valid.replace(
          "            await guardRepos.jobControl.acquirePlatformTargetAuthorityShared(guardAuth.targetId);",
          "            const leakPhysical = () => physical; void leakPhysical(); await guardRepos.jobControl.acquirePlatformTargetAuthorityShared(guardAuth.targetId);",
        ),
        violation: "builder:trusted-service-authority-guard",
      },
      {
        name: "nested-closure-retry-sentinel-laundering",
        source: valid.replace(
          "          error instanceof HeadRestartConflict;",
          "          error instanceof HeadRestartConflict; const leakSentinel = () => HeadRestartConflict; void leakSentinel();",
        ),
        violation: "poll:trusted-head-conflict-sentinel",
      },
      {
        name: "constructed-dynamic-module-import",
        source: `${valid}\nconst dynamicModuleName = ["./job-lease-", "eligibility.js"].join(""); async function loadDynamicModule() { return import(dynamicModuleName); }`,
        violation: "binding:dynamic-metaprogramming",
      },
      {
        name: "constructed-reflected-export-name",
        source: `${valid}\nconst reflectedExportName = ["leaseStatic", "ContextHash"].join(""); const reflectedExport = Reflect.get(globalThis, reflectedExportName);`,
        violation: "binding:dynamic-metaprogramming",
      },
      {
        name: "nonexistent-candidate-job-envelope",
        source: valid.replace("                       job: jobEnvelope,", "                       job: candidate.jobEnvelope,"),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "hard-coded-ack-timeout",
        source: valid.replace(
          "new Date(databaseNow.getTime() + ackTimeoutMs)",
          "new Date(databaseNow.getTime() + 15000)",
        ),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "hard-coded-lease-duration",
        source: valid.replace(
          "new Date(databaseNow.getTime() + leaseDurationMs)",
          "new Date(databaseNow.getTime() + 60000)",
        ),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "hard-coded-no-work-retry",
        source: valid.replace("readySignaled ? 100 : 750", "750"),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "ready-signal-influences-candidate-selection",
        source: valid.replace("limit: 256,", "limit: readySignaled ? 1 : 256,"),
        violation: "candidate:result-consumed-by-canonical-chain",
      },
      {
        name: "conditional-unconditional-throw-before-builder",
        source: valid.replace(
          "const staticContextInput = buildLeaseStaticContextInput({",
          'if (true) { throw new Error("decoy"); } const staticContextInput = buildLeaseStaticContextInput({',
        ),
        violation: "candidate:canonical-chain-dominates-return",
      },
      {
        name: "unconditional-throw-before-builder",
        source: valid.replace(
          "const staticContextInput = buildLeaseStaticContextInput({",
          'throw new Error("decoy"); const staticContextInput = buildLeaseStaticContextInput({',
        ),
        violation: "candidate:canonical-chain-dominates-return",
      },
    ];
    for (const adversary of adversaries) {
      const found = leaseStaticContextPollViolations(adversary.source);
      expect.soft(
        found,
        `${adversary.name}: ${found.join("|")}`,
      ).toContain(adversary.violation);
    }

    const leasing = readFileSync(new URL("../services/job-leasing.ts", import.meta.url), "utf8");
    expect.soft(
      leaseStaticContextPollViolations(leasing),
      "the real poll must use the exact direct typed source/hash/candidate chain once in every restart transaction",
    ).toEqual([]);
  });

  it("selects one database-native global head with an exact static-certificate anti-join", () => {
    const repository = readFileSync(
      new URL("../../../packages/db/src/repositories/tenant/job-control.ts", import.meta.url),
      "utf8",
    );
    const leasing = readFileSync(new URL("../services/job-leasing.ts", import.meta.url), "utf8");
    const scheduler = readFileSync(new URL("../services/job-ready-scheduler.ts", import.meta.url), "utf8");
    const candidateQuery = namedFunctionSource(repository, "lockEligibleLeaseCandidates");
    const candidateSignature = namedInterfaceMethodSource(
      repository,
      "JobControlRepository",
      "lockEligibleLeaseCandidates",
    );
    const exactCandidateInputMembers = [
      "admissibleWorkloadTypes",
      "eligibilityVersion",
      "limit",
      "placementOwner",
      "staticContextHash",
      "targetAuthorityKey",
      "targetClass",
      "targetGeneration",
      "targetId",
      "targetProfileHash",
      "targetProviderConstraintHash",
      "targetScope",
      "workerId",
    ];
    const pollService = namedFunctionSource(leasing, "poll");

    expect.soft(repository).not.toMatch(/lockEligibleLeaseCandidates[\s\S]{0,500}attemptIds\??:/);
    expect.soft(forbiddenLeaseContinuationIdentifiers(repository)).not.toContain("LeaseCandidateCursor");
    expect.soft(forbiddenLeaseContinuationIdentifiers(candidateSignature)).toEqual([]);
    expect.soft(forbiddenLeaseContinuationIdentifiers(candidateQuery)).toEqual([]);
    expect.soft(forbiddenLeaseContinuationIdentifiers(pollService)).toEqual([]);
    expect.soft(namedInterfaceMethodInputMembers(
      repository,
      "JobControlRepository",
      "lockEligibleLeaseCandidates",
    )).toEqual(exactCandidateInputMembers);
    expect.soft(namedFunctionInputProperties(
      repository,
      "lockEligibleLeaseCandidates",
      "input",
    )).toEqual(exactCandidateInputMembers);
    expect.soft(candidateQuery).not.toMatch(
      /\b(?:gt|gte|lt)\(jobs\.(?:availableAt|priority|createdAt|id),/,
    );
    expect.soft(namedFunctionMainWhereConjuncts(
      repository,
      "lockEligibleLeaseCandidates",
    )).toEqual([
      'eq(jobAttempts.placementDisposition,"selected")',
      'eq(jobAttempts.placementLeaseEligible,true)',
      'eq(jobAttempts.placementMode,"active")',
      'eq(jobAttempts.placementOwner,input.placementOwner)',
      'eq(jobAttempts.placementProfileHash,input.targetProfileHash)',
      'eq(jobAttempts.placementProviderConstraintHash,input.targetProviderConstraintHash)',
      'eq(jobAttempts.placementTargetClass,input.targetClass)',
      'eq(jobAttempts.placementTargetGeneration,input.targetGeneration)',
      'eq(jobAttempts.placementTargetId,input.targetId)',
      'eq(jobAttempts.placementTargetScope,input.targetScope)',
      'eq(jobAttempts.status,"pending")',
      'eq(jobs.status,"queued")',
      'inArray(jobs.workloadType,input.admissibleWorkloadTypes)',
      'lte(jobs.availableAt,sql`statement_timestamp()`)',
      'notExists(workerLeaseRejections)',
    ].sort());
    expect.soft(candidateQuery).toContain("workerLeaseRejections");
    expect.soft(candidateQuery).toMatch(/notExists\s*\(|NOT EXISTS/i);
    const exactCertificateEqualities = [
      ["organizationId", "jobAttempts.organizationId"],
      ["companyId", "jobAttempts.companyId"],
      ["jobId", "jobAttempts.jobId"],
      ["attemptId", "jobAttempts.id"],
      ["workerId", "input.workerId"],
      ["targetId", "input.targetId"],
      ["targetAuthorityKey", "input.targetAuthorityKey"],
      ["workloadType", "jobs.workloadType"],
      ["placementOwner", "jobAttempts.placementOwner"],
      ["placementTargetClass", "jobAttempts.placementTargetClass"],
      ["placementTargetScope", "jobAttempts.placementTargetScope"],
      ["placementTargetGeneration", "jobAttempts.placementTargetGeneration"],
      ["placementProfileHash", "jobAttempts.placementProfileHash"],
      ["placementProviderConstraintHash", "jobAttempts.placementProviderConstraintHash"],
      ["placementInputDigest", "jobAttempts.placementInputDigest"],
      ["placementPolicyDigest", "jobAttempts.placementPolicyDigest"],
      ["eligibilityVersion", "input.eligibilityVersion"],
      ["staticContextHash", "input.staticContextHash"],
    ] as const;
    for (const [certificateColumn, currentValue] of exactCertificateEqualities) {
      expect.soft(
        candidateQuery,
        `certificate anti-join must bind ${certificateColumn} to ${currentValue}`,
      ).toMatch(new RegExp(
        `eq\\(workerLeaseRejections\\.${certificateColumn},\\s*${currentValue.replaceAll(".", "\\.")}\\)`,
      ));
    }
    expect.soft(repository).toContain("statement_timestamp()");
    expect.soft(repository).toMatch(
      /orderBy\(asc\(jobs\.availableAt\),\s*desc\(jobs\.priority\),\s*asc\(jobs\.createdAt\),\s*asc\(jobs\.id\)\)/,
    );
    expect.soft(repository).toMatch(/\.limit\(256\)/);
    expect.soft(repository).toMatch(/\.for\(["']update["'],\s*\{[^}]*skipLocked:\s*true/);
    expect.soft(repository).toMatch(/inArray\(jobs\.workloadType,\s*input\.admissibleWorkloadTypes\)/);

    expect.soft(leasing).not.toContain("hintedAttemptIds");
    expect.soft(leasing).not.toMatch(/scheduler\?\.take|scheduler\.take/);
    expect.soft(leasing).toContain("LEASE_STATIC_ELIGIBILITY_VERSION");
    expect.soft(leasing).toContain("static_requirements_mismatch");
    expect.soft(leasing).toMatch(/(?:MAX_|max).*HEAD.*RESTART|headRestart/si);
    expect.soft(leasing).toMatch(/(?:3|THREE)[\s\S]{0,100}(?:restart|attempt)/i);
    expect.soft(leasing.match(/snapshotLiveLeaseCapacity\s*\(/g) ?? []).toHaveLength(1);
    expect.soft(leasing).not.toMatch(/for\s*\([^)]*candidate[^)]*\)[\s\S]{0,500}countLiveWorkerLeases/);
    const hasCapacitySnapshot = repository.includes("snapshotLiveLeaseCapacity");
    expect.soft(hasCapacitySnapshot).toBe(true);
    if (hasCapacitySnapshot) {
      const capacitySnapshot = namedFunctionSource(repository, "snapshotLiveLeaseCapacity");
      for (const predicate of ["organizationId", "workerId", "targetId"]) {
        expect.soft(capacitySnapshot, `capacity snapshot must bind ${predicate}`).toContain(predicate);
      }
      expect.soft(capacitySnapshot).toMatch(/groupBy\([^)]*workloadType|FILTER\s*\(\s*WHERE[^)]*workload_type/is);
      expect.soft(capacitySnapshot).not.toMatch(/executionTargetId[\s\S]{0,500}(?:organizationId\s+IS\s+NULL|isNull\([^)]*organization)/i);
    }
    expect.soft(repository).toMatch(/cleanupLeaseRejectionCertificates[\s\S]*\.limit\(256\)/);
    expect.soft(repository).toMatch(/cleanupLeaseRejectionCertificates[\s\S]*(?:terminal|retired|status)/i);
    expect.soft(scheduler).not.toContain("attemptId");
    expect.soft(scheduler).toMatch(/consume\(/);
  });

  // Same whole-tree AST scan as the allowlist test above; headroom over the 30s default.
  it("keeps protected candidate facts immutable and certificate writers certificate-only", { timeout: 120_000 }, () => {
    const production = [
      ...productionTypeScriptFiles(join(repositoryRoot, "server", "src")),
      ...productionTypeScriptFiles(join(repositoryRoot, "packages", "db", "src")),
    ].map((path) => ({
      file: relative(repositoryRoot, path).replaceAll("\\", "/"),
      source: readFileSync(path, "utf8"),
    }));
    const protectedFields = new Map<string, Set<string>>([
      ["jobs", new Set([
        "workloadType", "input", "inputHash", "policySnapshot", "policyHash",
        "requirements", "placementRequest", "priority", "availableAt", "createdAt",
      ])],
      ["jobAttempts", new Set([
        "placementDisposition", "placementOwner", "placementTargetId",
        "placementTargetClass", "placementTargetScope", "placementTargetGeneration",
        "placementProfileHash", "placementProviderConstraintHash",
        "placementMode", "placementLeaseEligible", "placementInputDigest",
        "placementPolicyDigest", "placementDecidedAt",
      ])],
    ]);

    function scan(inputs: typeof production): string[] {
      const found: string[] = [];
      type CandidateTable = "jobs" | "jobAttempts";
      const exportedAliases = new Map<string, CandidateTable>([
        ["jobs", "jobs"],
        ["jobAttempts", "jobAttempts"],
      ]);
      for (let pass = 0; pass < 4; pass += 1) {
        for (const input of inputs) {
          const source = ts.createSourceFile(input.file, input.source, ts.ScriptTarget.Latest, true);
          const collectExport = (node: ts.Node): void => {
            if (ts.isExportSpecifier(node)) {
              const local = node.propertyName?.text ?? node.name.text;
              const table = exportedAliases.get(local);
              if (table) exportedAliases.set(node.name.text, table);
            }
            if (ts.isVariableStatement(node) &&
                node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
              for (const declaration of node.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
                const sourceName = ts.isIdentifier(declaration.initializer)
                  ? declaration.initializer.text
                  : ts.isPropertyAccessExpression(declaration.initializer)
                    ? declaration.initializer.name.text
                    : null;
                const table = sourceName ? exportedAliases.get(sourceName) : undefined;
                if (table) exportedAliases.set(declaration.name.text, table);
              }
            }
            ts.forEachChild(node, collectExport);
          };
          collectExport(source);
        }
      }
      for (const input of inputs) {
        const file = ts.createSourceFile(input.file, input.source, ts.ScriptTarget.Latest, true);
        type CandidateDeclaration = {
          name: string;
          table: CandidateTable | null;
          start: number;
          scopeStart: number;
          scopeEnd: number;
        };
        const declarations: CandidateDeclaration[] = [];
        const objects = new Map<string, string[]>();
        const expressionAliases: Array<{
          name: string;
          expression: ts.Expression;
          start: number;
          scopeStart: number;
          scopeEnd: number;
        }> = [];
        const staticStrings = staticStringBindings(file);
        const scopeOf = (node: ts.Node): ts.Node => {
          let current: ts.Node | undefined = node.parent;
          while (current && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
            current = current.parent;
          }
          return current ?? file;
        };
        const tableName = (node: ts.Expression | undefined, useNode: ts.Node): CandidateTable | null => {
          if (!node) return null;
          if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
            return tableName(node.expression, useNode);
          }
          if (ts.isPropertyAccessExpression(node)) {
            if (protectedFields.has(node.name.text)) return node.name.text as CandidateTable;
            return exportedAliases.get(node.name.text) ?? null;
          }
          if (!ts.isIdentifier(node)) return null;
          const use = useNode.getStart(file);
          const visible = declarations.filter((declaration) =>
            declaration.name === node.text && declaration.start <= use &&
            declaration.scopeStart <= use && use <= declaration.scopeEnd)
            .sort((left, right) =>
              (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart) ||
              right.start - left.start);
          if (visible.length > 0) return visible[0]!.table;
          if (protectedFields.has(node.text)) return node.text as CandidateTable;
          return exportedAliases.get(node.text) ?? null;
        };
        const addDeclaration = (
          name: string,
          table: CandidateTable | null,
          node: ts.Node,
          scope = scopeOf(node),
        ): void => {
          declarations.push({
            name,
            table,
            start: node.getStart(file),
            scopeStart: scope.getStart(file),
            scopeEnd: scope.getEnd(),
          });
        };
        const collect = (node: ts.Node): void => {
          if (ts.isImportSpecifier(node)) {
            const imported = node.propertyName?.text ?? node.name.text;
            addDeclaration(
              node.name.text,
              exportedAliases.get(imported) ?? null,
              node,
              file,
            );
          }
          if (ts.isExportSpecifier(node)) {
            const imported = node.propertyName?.text ?? node.name.text;
            addDeclaration(node.name.text, exportedAliases.get(imported) ?? null, node, file);
          }
          if (ts.isFunctionLike(node)) {
            for (const parameter of node.parameters) {
              if (ts.isIdentifier(parameter.name)) addDeclaration(parameter.name.text, null, parameter, node);
            }
          }
          if (ts.isVariableDeclaration(node)) {
            if (ts.isIdentifier(node.name) && node.initializer) {
              addDeclaration(node.name.text, tableName(node.initializer, node), node);
              const scope = scopeOf(node);
              expressionAliases.push({
                name: node.name.text,
                expression: node.initializer,
                start: node.getStart(file),
                scopeStart: scope.getStart(file),
                scopeEnd: scope.getEnd(),
              });
              const fields = expressionObjectFields(node.initializer, objects, new Map());
              if (fields.some((field) => field !== "<dynamic>")) objects.set(node.name.text, fields);
            } else if (ts.isObjectBindingPattern(node.name)) {
              for (const element of node.name.elements) {
                if (!ts.isIdentifier(element.name)) continue;
                const sourceName = propertyName(element.propertyName) ?? element.name.text;
                addDeclaration(element.name.text, exportedAliases.get(sourceName) ?? null, element);
              }
            }
          }
          if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isIdentifier(node.left)) {
            addDeclaration(node.left.text, tableName(node.right, node), node);
          }
          ts.forEachChild(node, collect);
        };
        collect(file);
        type CandidateBuilder = {
          name: string;
          kind: "update" | "insert";
          table: CandidateTable | null;
          start: number;
          scopeStart: number;
          scopeEnd: number;
        };
        const builders: CandidateBuilder[] = [];
        const directBuilder = (
          expression: ts.Expression | undefined,
          useNode: ts.Node,
        ): Omit<CandidateBuilder, "name" | "start" | "scopeStart" | "scopeEnd"> | null => {
          if (!expression) return null;
          if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) {
            return directBuilder(expression.expression, useNode);
          }
          let chain = expression;
          while (ts.isCallExpression(chain) && ts.isPropertyAccessExpression(chain.expression)) {
            const kind = chain.expression.name.text;
            if (kind === "update" || kind === "insert") {
              return { kind, table: tableName(chain.arguments[0], useNode) };
            }
            chain = chain.expression.expression;
          }
          return null;
        };
        const collectBuilders = (node: ts.Node): void => {
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            const builder = directBuilder(node.initializer, node);
            if (builder) {
              const scope = scopeOf(node);
              builders.push({
                name: node.name.text,
                ...builder,
                start: node.getStart(file),
                scopeStart: scope.getStart(file),
                scopeEnd: scope.getEnd(),
              });
            }
          }
          ts.forEachChild(node, collectBuilders);
        };
        collectBuilders(file);
        const resolveBuilder = (expression: ts.Expression | undefined, useNode: ts.Node) => {
          const direct = directBuilder(expression, useNode);
          if (direct) return direct;
          if (!expression || !ts.isIdentifier(expression)) return null;
          const use = useNode.getStart(file);
          return builders.filter((builder) => builder.name === expression.text && builder.start <= use &&
            builder.scopeStart <= use && use <= builder.scopeEnd)
            .sort((left, right) =>
              (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart) || right.start - left.start)[0] ?? null;
        };
        const resolveAlias = (
          expression: ts.Expression | undefined,
          useNode: ts.Node,
          seen = new Set<string>(),
        ): ts.Expression | undefined => {
          if (!expression || !ts.isIdentifier(expression) || seen.has(expression.text)) return expression;
          const use = useNode.getStart(file);
          const alias = expressionAliases.filter((candidate) => candidate.name === expression.text &&
            candidate.start <= use && candidate.scopeStart <= use && use <= candidate.scopeEnd)
            .sort((left, right) =>
              (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart) || right.start - left.start)[0];
          return alias ? resolveAlias(alias.expression, useNode, new Set([...seen, expression.text])) : expression;
        };
        const conflictFields = (expression: ts.Expression | undefined, useNode: ts.Node): string[] => {
          const resolved = resolveAlias(expression, useNode);
          if (!resolved || !ts.isObjectLiteralExpression(resolved)) return ["<dynamic>"];
          const fields: string[] = [];
          for (const property of resolved.properties) {
            if (ts.isPropertyAssignment(property) && propertyName(property.name) === "set") {
              fields.push(...expressionObjectFields(resolveAlias(property.initializer, useNode), objects, new Map()));
            } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === "set") {
              fields.push(...expressionObjectFields(resolveAlias(property.name, useNode), objects, new Map()));
            } else if (ts.isSpreadAssignment(property)) {
              fields.push(...conflictFields(property.expression, useNode));
            }
          }
          return fields.length > 0 ? [...new Set(fields)].sort() : ["<dynamic>"];
        };
        const record = (node: ts.Node, table: string, fields: string[]): void => {
          const protectedForTable = protectedFields.get(table);
          if (!protectedForTable) return;
          const relevant = [...new Set(fields.filter((field) =>
            protectedForTable.has(field) || field === "<dynamic>" || field === "<computed>"))].sort();
          if (relevant.length > 0) {
            found.push(`${input.file}#${enclosingFunctionName(node)}:${table}:${relevant.join(",")}`);
          }
        };
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
              node.expression.name.text === "set") {
            const update = resolveBuilder(node.expression.expression, node);
            if (update?.kind === "update") {
              const table = update.table ?? "";
              const values = node.arguments[0];
              record(node, table, expressionObjectFields(resolveAlias(values, node), objects, new Map()));
            }
          }
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
              node.expression.name.text === "onConflictDoUpdate" && node.arguments[0]) {
            const insert = resolveBuilder(node.expression.expression, node);
            if (insert?.kind === "insert") record(node, insert.table ?? "", conflictFields(node.arguments[0], node));
          }
          if (ts.isTaggedTemplateExpression(node)) {
            const raw = templateText(node);
            const match = /\bUPDATE\s+(?:"?public"?\.)?"?(jobs|job_attempts)"?(?:\s+(?:AS\s+)?\w+)?\s+SET\s+([\s\S]*?)(?:\bWHERE\b|$)/i.exec(raw);
            let table = match?.[1] === "jobs" ? "jobs" : match?.[1] === "job_attempts" ? "jobAttempts" : null;
            let assignments = match?.[2] ?? "";
            if (!table && /^\s*UPDATE\s+\?/i.test(raw) && ts.isTemplateExpression(node.template)) {
              table = tableName(node.template.templateSpans[0]?.expression, node);
              assignments = raw.replace(/^\s*UPDATE\s+\?\s+(?:AS\s+\w+\s+)?SET\s+/i, "");
            }
            if (table) {
              const fields = [...assignments.matchAll(/"?([a-z][a-z0-9_]*)"?\s*=/gi)]
                .map((field) => sqlFieldName(field[1]!.toLowerCase()));
              record(node, table, fields.length > 0 ? fields : ["<dynamic>"]);
            }
          }
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
              (node.expression.name.text === "unsafe" || node.expression.name.text === "raw")) {
            const argument = node.arguments[0];
            const raw = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
              ? argument.text
              : argument && ts.isIdentifier(argument) ? staticStrings.get(argument.text) ?? "" : "";
            const match = /\bUPDATE\s+(?:"?public"?\.)?"?(jobs|job_attempts)"?(?:\s+(?:AS\s+)?\w+)?\s+SET\s+([\s\S]*?)(?:\bWHERE\b|$)/i.exec(raw);
            if (match) {
              const table = match[1] === "jobs" ? "jobs" : "jobAttempts";
              const fields = [...match[2]!.matchAll(/"?([a-z][a-z0-9_]*)"?\s*=/gi)]
                .map((field) => sqlFieldName(field[1]!.toLowerCase()));
              record(node, table, fields.length > 0 ? fields : ["<dynamic>"]);
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(file);
      }
      return found.sort();
    }

    expect.soft(scan(production)).toEqual([
      // JOB-006 retry: the reaper reschedules the job's next-availability to the immutable
      // backoff instant (jobs.availableAt = backoffUntil) when it re-queues attempt N+1.
      // availableAt is the field lockEligibleLeaseCandidates + the outbox claim gate on, so
      // the backoff MUST land here; this is server/reaper authority (never a worker path), so
      // it is an admitted certificate-only writer of this candidate fact, not tampering.
      "packages/db/src/repositories/tenant/job-control.ts#allocateRetry:jobs:availableAt",
      "packages/db/src/repositories/tenant/job-control.ts#persistPlacementDecision:jobAttempts:placementDecidedAt,placementDisposition,placementInputDigest,placementLeaseEligible,placementMode,placementOwner,placementPolicyDigest,placementProfileHash,placementProviderConstraintHash,placementTargetClass,placementTargetGeneration,placementTargetId,placementTargetScope",
    ]);
    const injected = scan([...production, {
      file: "server/src/services/injected-candidate-barrel.ts",
      source: `export { jobs as queuedRows, jobAttempts as attemptRows } from "@armyofagents/db";`,
    }, {
      file: "server/src/services/injected-candidate-mutation.ts",
      source: `import * as schema from "@armyofagents/db";
      import { jobs as importedJobs, jobAttempts as importedAttempts } from "@armyofagents/db";
      import { queuedRows as reexportedJobs, attemptRows as reexportedAttempts } from "./injected-candidate-barrel.js";
      const jobsPatch = {
        workloadType: "batch", input: {}, inputHash: "x", policySnapshot: {}, policyHash: "x",
        requirements: {}, placementRequest: {}, priority: 9, availableAt: new Date(), createdAt: new Date(),
      };
      const attemptsPatch = {
        placementDisposition: "selected", placementOwner: "managed_cloud", placementTargetId: "x",
        placementTargetClass: "managed_cloud", placementTargetScope: "platform",
        placementTargetGeneration: 2, placementProfileHash: "x", placementProviderConstraintHash: "x",
        placementMode: "active", placementLeaseEligible: true, placementInputDigest: "x",
        placementPolicyDigest: "x", placementDecidedAt: new Date(),
      };
      const aliasedConflictOptions = { target: importedAttempts.id, set: attemptsPatch };
      const resolvedCandidateSql = "UPDATE public.jobs SET policy_hash = 'resolved-change'";
      async function mutateAll(tx: any) {
        await tx.update(importedJobs).set({ ...jobsPatch });
        await tx.update(importedAttempts).set({ ...attemptsPatch });
      }
      async function mutateDynamic(tx: any, patch: any, field: string) {
        await tx.update(jobAttempts).set(patch);
        await tx.update(jobs).set({ ...patch });
        await tx.update(jobAttempts).set({ [field]: "changed" });
      }
      async function mutateConflict(tx: any) {
        await tx.insert(importedJobs).values({}).onConflictDoUpdate({ target: importedJobs.id, set: jobsPatch });
      }
      async function mutatePrebound(tx: any) {
        const writer = tx.update(importedAttempts);
        await writer.set(attemptsPatch);
      }
      async function mutateAliasedConflict(tx: any) {
        const insert = tx.insert(importedAttempts).values({});
        await insert.onConflictDoUpdate(aliasedConflictOptions);
      }
      async function mutateResolvedRaw(tx: any) {
        await tx.unsafe(resolvedCandidateSql);
      }
      async function mutateRaw(tx: any) {
        await tx\`UPDATE public.job_attempts AS attempt SET placement_profile_hash = 'changed'\`;
        await tx.unsafe("UPDATE public.jobs AS job SET policy_hash = 'changed'");
        await sql.raw("UPDATE public.job_attempts SET placement_policy_digest = 'changed'");
      }
      const aliasAttempts = importedAttempts;
      const { jobs: destructuredJobs, jobAttempts: destructuredAttempts } = schema;
      let assignedJobs: unknown;
      assignedJobs = destructuredJobs;
      async function mutateAliasForms(tx: any) {
        await tx.update(destructuredJobs).set({ priority: 10 });
        await tx.update(destructuredAttempts).set({ placementLeaseEligible: false });
        await tx.update(assignedJobs).set({ availableAt: new Date() });
        await tx.update(reexportedJobs).set({ policyHash: "changed" });
        await tx.update(reexportedAttempts).set({ placementPolicyDigest: "changed" });
      }
      async function mutateInterpolatedRaw(tx: any, field: unknown) {
        await tx\`UPDATE \${aliasAttempts} SET \${field} = 'changed'\`;
      }
      async function shadowedProtectedAliasIsNotTheTable(tx: any, importedJobs: unknown) {
        await tx.update(importedJobs).set({ workloadType: "not-a-table" });
      }`,
    }]);
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutateAll:jobs:availableAt,createdAt,input,inputHash,placementRequest,policyHash,policySnapshot,priority,requirements,workloadType",
    );
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutateAll:jobAttempts:placementDecidedAt,placementDisposition,placementInputDigest,placementLeaseEligible,placementMode,placementOwner,placementPolicyDigest,placementProfileHash,placementProviderConstraintHash,placementTargetClass,placementTargetGeneration,placementTargetId,placementTargetScope",
    );
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutateDynamic:jobAttempts:<dynamic>",
    );
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutateDynamic:jobs:<dynamic>",
    );
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutateDynamic:jobAttempts:<computed>",
    );
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutateConflict:jobs:availableAt,createdAt,input,inputHash,placementRequest,policyHash,policySnapshot,priority,requirements,workloadType",
    );
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutatePrebound:jobAttempts:placementDecidedAt,placementDisposition,placementInputDigest,placementLeaseEligible,placementMode,placementOwner,placementPolicyDigest,placementProfileHash,placementProviderConstraintHash,placementTargetClass,placementTargetGeneration,placementTargetId,placementTargetScope",
    );
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutateAliasedConflict:jobAttempts:placementDecidedAt,placementDisposition,placementInputDigest,placementLeaseEligible,placementMode,placementOwner,placementPolicyDigest,placementProfileHash,placementProviderConstraintHash,placementTargetClass,placementTargetGeneration,placementTargetId,placementTargetScope",
    );
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutateResolvedRaw:jobs:policyHash",
    );
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutateRaw:jobAttempts:placementProfileHash",
    );
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutateRaw:jobs:policyHash",
    );
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutateRaw:jobAttempts:placementPolicyDigest",
    );
    expect.soft(injected).toContain(
      "server/src/services/injected-candidate-mutation.ts#mutateInterpolatedRaw:jobAttempts:<dynamic>",
    );
    for (const identity of [
      "server/src/services/injected-candidate-mutation.ts#mutateAliasForms:jobs:priority",
      "server/src/services/injected-candidate-mutation.ts#mutateAliasForms:jobAttempts:placementLeaseEligible",
      "server/src/services/injected-candidate-mutation.ts#mutateAliasForms:jobs:availableAt",
      "server/src/services/injected-candidate-mutation.ts#mutateAliasForms:jobs:policyHash",
      "server/src/services/injected-candidate-mutation.ts#mutateAliasForms:jobAttempts:placementPolicyDigest",
    ]) {
      expect.soft(injected).toContain(identity);
    }
    expect.soft(injected.some((identity) => identity.includes("#shadowedProtectedAliasIsNotTheTable:"))).toBe(false);

    const repository = readFileSync(
      new URL("../../../packages/db/src/repositories/tenant/job-control.ts", import.meta.url),
      "utf8",
    );
    expect.soft(
      persistPlacementDecisionPredicateViolations(repository),
      "persistPlacementDecision must remain one-shot and scoped to the exact tenant/job/attempt identity",
    ).toEqual([]);
    const certificateMethods = [
      ["upsertLeaseRejectionCertificates", ["workerLeaseRejections:insert"]],
      ["cleanupLeaseRejectionCertificates", ["workerLeaseRejections:delete"]],
    ] as const;
    for (const [method, expectedInventory] of certificateMethods) {
      const exists = hasNamedFunction(repository, method);
      expect.soft(exists, `${method} production method must exist`).toBe(true);
      if (!exists) continue;
      expect.soft(
        namedFunctionMutationInventory(repository, method),
        `${method} is eligibility_certificate_only and may mutate no authority/liveness/job/attempt/lease row`,
      ).toEqual(expectedInventory);
      expect.soft(
        namedFunctionUnexpectedCertificateCalls(repository, method),
        `${method} may call only reviewed Drizzle query/predicate operations and no mutating delegate`,
      ).toEqual([]);
      expect.soft(namedFunctionCertificateMutationScopes(repository, method)).toEqual([
        `workerLeaseRejections:${method === "upsertLeaseRejectionCertificates" ? "insert" : "delete"}:` +
          "attemptId,organizationId,targetId,workerId",
      ]);
    }
    const certificateOnlyFixture = `async function upsertLeaseRejectionCertificates(tx: any, input: any) {
      const certificateRows = workerLeaseRejections;
      const insert = tx.insert(certificateRows);
      await insert.values({
        organizationId: input.organizationId,
        workerId: input.workerId,
        targetId: input.targetId,
        attemptId: input.attemptId,
      }).onConflictDoNothing({ target: [
        workerLeaseRejections.organizationId,
        workerLeaseRejections.workerId,
        workerLeaseRejections.attemptId,
      ] });
    }
    async function cleanupLeaseRejectionCertificates(tx: any, input: any) {
      await tx.delete(workerLeaseRejections).where(and(
        eq(workerLeaseRejections.organizationId, input.organizationId),
        eq(workerLeaseRejections.workerId, input.workerId),
        eq(workerLeaseRejections.targetId, input.targetId),
        eq(workerLeaseRejections.attemptId, input.attemptId),
      ));
    }`;
    expect.soft(namedFunctionMutationInventory(
      certificateOnlyFixture,
      "upsertLeaseRejectionCertificates",
    )).toEqual(["workerLeaseRejections:insert"]);
    expect.soft(namedFunctionMutationInventory(
      certificateOnlyFixture,
      "cleanupLeaseRejectionCertificates",
    )).toEqual(["workerLeaseRejections:delete"]);
    for (const method of ["upsertLeaseRejectionCertificates", "cleanupLeaseRejectionCertificates"]) {
      expect.soft(namedFunctionUnexpectedCertificateCalls(certificateOnlyFixture, method)).toEqual([]);
      expect.soft(namedFunctionCertificateMutationScopes(certificateOnlyFixture, method)).toEqual([
        `workerLeaseRejections:${method === "upsertLeaseRejectionCertificates" ? "insert" : "delete"}:` +
          "attemptId,organizationId,targetId,workerId",
      ]);
    }
    const certificateAuthorityBypass = `async function upsertLeaseRejectionCertificates(tx: any) {
      const workerRows = workers;
      const writer = tx.update(workerRows);
      await writer.set({ lastSeenAt: new Date() });
      await this.touchWorkerLeaseProfile();
      await tx.insert(workerLeaseRejections).values(rows);
    }
    async function cleanupLeaseRejectionCertificates(tx: any) {
      await mutateAuthority();
      await tx.unsafe("DELETE FROM public.job_attempts WHERE status = 'expired'");
      await tx.delete(workerLeaseRejections).where(scope);
    }`;
    expect.soft(namedFunctionMutationInventory(
      certificateAuthorityBypass,
      "upsertLeaseRejectionCertificates",
    )).toContain("workers:update");
    expect.soft(namedFunctionMutationInventory(
      certificateAuthorityBypass,
      "cleanupLeaseRejectionCertificates",
    )).toContain("jobAttempts:delete");
    expect.soft(namedFunctionUnexpectedCertificateCalls(
      certificateAuthorityBypass,
      "upsertLeaseRejectionCertificates",
    )).toContain("this.touchWorkerLeaseProfile");
    expect.soft(namedFunctionUnexpectedCertificateCalls(
      certificateAuthorityBypass,
      "cleanupLeaseRejectionCertificates",
    )).toContain("mutateAuthority");
    const certificateScopeDecoy = `async function upsertLeaseRejectionCertificates(tx: any, input: any) {
      await tx.insert(workerLeaseRejections).values({ reasonCode: "static_requirements_mismatch" });
      await tx.select().from(workerLeaseRejections).where(and(
        eq(workerLeaseRejections.organizationId, input.organizationId),
        eq(workerLeaseRejections.workerId, input.workerId),
        eq(workerLeaseRejections.targetId, input.targetId),
        eq(workerLeaseRejections.attemptId, input.attemptId),
      ));
    }`;
    expect.soft(namedFunctionCertificateMutationScopes(
      certificateScopeDecoy,
      "upsertLeaseRejectionCertificates",
    )).toEqual(["workerLeaseRejections:insert:"]);
    const fakeFluentReceiver = `async function upsertLeaseRejectionCertificates(tx: any, input: any) {
      await authority.delete();
      await this.insert();
      await tx.insert(workerLeaseRejections).values({
        organizationId: input.organizationId,
        workerId: input.workerId,
        targetId: input.targetId,
        attemptId: input.attemptId,
      });
    }`;
    expect.soft(namedFunctionUnexpectedCertificateCalls(
      fakeFluentReceiver,
      "upsertLeaseRejectionCertificates",
    )).toEqual(["authority.delete", "this.insert"]);
    const aliasedFluentReceiver = `async function upsertLeaseRejectionCertificates(tx: any, input: any) {
      const authority = { map: async () => undefined };
      const eq = mutateAuthority;
      await authority.map();
      await eq();
      await tx.insert(workerLeaseRejections).values({
        organizationId: input.organizationId,
        workerId: input.workerId,
        targetId: input.targetId,
        attemptId: input.attemptId,
      });
    }`;
    expect.soft(namedFunctionUnexpectedCertificateCalls(
      aliasedFluentReceiver,
      "upsertLeaseRejectionCertificates",
    )).toEqual(["authority.map", "eq"]);
  });
});

describe("JOB-003 final-review repository and telemetry contracts", () => {
  const repositorySource = readFileSync(
    new URL("../../../packages/db/src/repositories/tenant/job-control.ts", import.meta.url),
    "utf8",
  );
  const leasingSource = readFileSync(new URL("../services/job-leasing.ts", import.meta.url), "utf8");
  const outboxSource = readFileSync(new URL("../services/job-outbox-worker.ts", import.meta.url), "utf8");
  const schedulerSource = readFileSync(new URL("../services/job-ready-scheduler.ts", import.meta.url), "utf8");

  it("defines bounded tuple-exact cleanup with left-join drift retention and three statement gates", () => {
    // Paired with the executable real-PG cross-tuple test: these assertions close the
    // false-green mutations that replace the bound with a literal or hide missing parents.
    expect(repositorySource).toMatch(/interface LeaseRejectionCleanupResult[\s\S]*deleted:\s*number[\s\S]*cardinalityObserved:\s*number[\s\S]*cardinalitySaturated:\s*boolean/);
    expect(repositorySource).toMatch(/cleanupLeaseRejectionCertificates\(input:\s*\{[\s\S]*limit:\s*number[\s\S]*cardinalityLimit:\s*number[\s\S]*beforeStatement/);
    expect(repositorySource).toMatch(/Number\.isSafeInteger\([^)]*limit/);
    expect(repositorySource).toMatch(/Number\.isSafeInteger\([^)]*cardinalityLimit/);
    expect(repositorySource).toMatch(/cleanupLeaseRejectionCertificates[\s\S]*\.leftJoin\(jobs/);
    expect(repositorySource).toMatch(/cleanupLeaseRejectionCertificates[\s\S]*\.leftJoin\(jobAttempts/);
    expect(repositorySource).toMatch(/cleanupLeaseRejectionCertificates[\s\S]*\.limit\(boundedLimit\)/);
    expect(repositorySource).toMatch(/beforeStatement\(["']select["']\)[\s\S]*beforeStatement\(["']delete["']\)[\s\S]*beforeStatement\(["']cardinality["']\)/);
    expect(repositorySource).toMatch(/cardinalityLimit\s*\+\s*1/);
    expect(repositorySource).toMatch(/lease_rejection_cleanup_bound/);
    expect(repositorySource).not.toMatch(/cleanupLeaseRejectionCertificates[\s\S]{0,5000}inArray\(workerLeaseRejections\.workerId/);
    expect(repositorySource).not.toMatch(/return Math\.min\(boundedLimit,\s*deleted\.length\)/);
  });

  it("returns certificate telemetry from the claim SQL instead of inferring it from candidate length", () => {
    expect(repositorySource).toMatch(/lockEligibleLeaseCandidates[\s\S]*certificateMetrics/);
    expect(repositorySource).toMatch(/hitsObserved[\s\S]*hitsSaturated[\s\S]*missesObserved[\s\S]*missesSaturated/);
    expect(repositorySource).toMatch(/scanExhausted[\s\S]*cardinalityObserved[\s\S]*cardinalitySaturated/);
    expect(repositorySource).toMatch(/4_?097|4097/);
    expect(repositorySource).toMatch(/256/);
    expect(leasingSource).toMatch(/certificateMetrics/);
    expect(leasingSource).not.toMatch(/hitsObserved\s*:\s*candidates\.length/);
    expect(leasingSource).not.toMatch(/missesObserved\s*:\s*candidates\.length/);
  });

  it("locks non-platform target before worker and touches liveness only after authority revalidation", () => {
    const repositoryFunction = repositorySource.slice(
      repositorySource.indexOf("async lockWorkerLeaseAuthority"),
      repositorySource.indexOf("async lockEligibleLeaseCandidates"),
    );
    expect(repositoryFunction.indexOf(".from(executionTargets)")).toBeGreaterThanOrEqual(0);
    expect(repositoryFunction.indexOf(".from(workers)")).toBeGreaterThan(
      repositoryFunction.indexOf(".from(executionTargets)"),
    );
    expect(repositoryFunction).toMatch(/organizationId[\s\S]*targetAuthorityKey/);

    const firstTouch = leasingSource.indexOf("touchWorkerLeaseProfile");
    const firstAuthorityLock = leasingSource.indexOf("lockWorkerLeaseAuthority");
    expect(firstAuthorityLock).toBeGreaterThanOrEqual(0);
    expect(firstTouch).toBeGreaterThan(firstAuthorityLock);
  });

  it("requires the real-PG lock-order overlap to enter through the public poll service", () => {
    const nonPlatformRepositoryLockControl = readFileSync(
      new URL("../../../packages/db/src/__tests__/job-leasing-lock-order.integration.test.ts", import.meta.url),
      "utf8",
    );
    const platformAuthorityLockControl = readFileSync(
      new URL("../../../packages/db/src/__tests__/platform-target-authority-lock.integration.test.ts", import.meta.url),
      "utf8",
    );
    const platformOperatorServiceControl = readFileSync(
      new URL("./worker-enrollment.integration.test.ts", import.meta.url),
      "utf8",
    );
    const publicServiceOverlap = readFileSync(
      new URL("./job-leasing.integration.test.ts", import.meta.url),
      "utf8",
    );
    expect(nonPlatformRepositoryLockControl).toMatch(
      /locks target before worker so overlapping poll and revoke settle without a deadlock or post-cutoff effect/,
    );
    expect(platformAuthorityLockControl).toMatch(
      /serializes shared tenant guards against exclusive cutoffs[\s\S]*acquirePlatformTargetAuthorityShared/,
    );
    expect(platformAuthorityLockControl).toMatch(
      /implements target-to-worker row handoff with guard-first and cutoff-first ordering[\s\S]*acquirePlatformTargetAuthorityExclusive/,
    );
    expect(platformOperatorServiceControl).toMatch(
      /uses one operator transaction for platform identity[\s\S]*issuePlatformCode[\s\S]*\.enroll\s*\(/,
    );
    expect(publicServiceOverlap).toContain("createJobLeasingService");
    expect(publicServiceOverlap).toMatch(/\.poll\s*\(/);
    expect(publicServiceOverlap).toMatch(/settles public poll against target-first revoke/);
    expect(publicServiceOverlap).toMatch(/worker_proof_replays/);
    expect(publicServiceOverlap).toMatch(/worker_lease_rejections/);
    expect(publicServiceOverlap).toMatch(/job_attempts/);
    expect(publicServiceOverlap).toMatch(/leases/);
    expect(publicServiceOverlap).toMatch(/worker_operation_receipts/);
    expect(publicServiceOverlap).toMatch(/job_outbox/);
    expect(publicServiceOverlap).toMatch(/last_seen_at/);
    expect(publicServiceOverlap).toMatch(/revokeWins[\s\S]*pollWins/);
  });

  it("threads one optional closed metrics instance through leasing, scheduler, and outbox", () => {
    for (const [source, factory] of [
      [leasingSource, "createJobLeasingService"],
      [schedulerSource, "createJobReadyScheduler"],
      [outboxSource, "createJobOutboxWorker"],
    ] as const) {
      expect(source).toMatch(new RegExp(`${factory}[\\s\\S]*metrics\\?:\\s*JobControlMetrics`));
      expect(source).toContain("NOOP_JOB_CONTROL_METRICS");
    }
    expect(leasingSource).toMatch(/headRestart\(\)/);
    expect(leasingSource).toMatch(/certificateScan\(/);
    expect(leasingSource).toMatch(/certificateUpsert\(/);
    expect(outboxSource).toMatch(/certificateCleanup\(/);
    expect(outboxSource).toMatch(/outboxTick\(/);
    expect(schedulerSource).toMatch(/schedulerCapacityReject\(/);
    expect(schedulerSource).toMatch(/schedulerExpiry\(/);
    expect(schedulerSource).toMatch(/schedulerCardinality\(/);
  });
});
