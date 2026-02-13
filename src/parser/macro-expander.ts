// ============================================================
// Macro Expander
// Walks the AST and expands macro calls into their bodies
// with parameter substitution, cycle detection, and
// recursive expansion.
// ============================================================

import type {
  ProgramNode,
  MacroDeclNode,
  ConfigBodyNode,
  ConstraintExprNode,
} from './constraint-ast';

const MAX_EXPANSION_DEPTH = 10;

export interface MacroError {
  message: string;
  macroName: string;
}

export interface MacroExpansionResult {
  ast: ProgramNode;
  errors: MacroError[];
}

/**
 * Extract all macro declarations from an AST.
 */
export function extractMacros(ast: ProgramNode): Map<string, MacroDeclNode> {
  const macros = new Map<string, MacroDeclNode>();
  for (const stmt of ast.statements) {
    if (stmt.type === 'macro_decl') {
      macros.set(stmt.name, stmt);
    }
  }
  return macros;
}

/**
 * Expand all macro calls within config bodies throughout the AST.
 * Returns a new AST with macros expanded and any errors encountered.
 */
export function expandAllMacros(ast: ProgramNode, extraMacros?: Map<string, MacroDeclNode>): MacroExpansionResult {
  const macros = extractMacros(ast);
  if (extraMacros) {
    for (const [name, macro] of extraMacros) {
      if (!macros.has(name)) {
        macros.set(name, macro);
      }
    }
  }

  const errors: MacroError[] = [];

  const newStatements = ast.statements.map(stmt => {
    if (stmt.type !== 'port_decl') return stmt;

    const newConfigs = stmt.configs.map(cfg => {
      const expandedBody = expandBody(cfg.body, macros, new Set(), errors);
      return { ...cfg, body: expandedBody };
    });

    return { ...stmt, configs: newConfigs };
  });

  return {
    ast: { ...ast, statements: newStatements },
    errors,
  };
}

/**
 * Expand macro calls in a config body, with cycle detection.
 */
function expandBody(
  body: ConfigBodyNode[],
  macros: Map<string, MacroDeclNode>,
  expansionStack: Set<string>,
  errors: MacroError[],
  depth = 0,
): ConfigBodyNode[] {
  if (depth > MAX_EXPANSION_DEPTH) {
    errors.push({ message: `Maximum macro expansion depth (${MAX_EXPANSION_DEPTH}) exceeded`, macroName: '<unknown>' });
    return body;
  }

  const result: ConfigBodyNode[] = [];
  for (const item of body) {
    if (item.type !== 'macro_call') {
      result.push(item);
      continue;
    }

    const macro = macros.get(item.name);
    if (!macro) {
      errors.push({ message: `Unknown macro '${item.name}'`, macroName: item.name });
      continue;
    }

    if (expansionStack.has(item.name)) {
      errors.push({ message: `Recursive macro call detected: '${item.name}'`, macroName: item.name });
      continue;
    }

    if (item.args.length !== macro.params.length) {
      errors.push({
        message: `Macro '${item.name}' expects ${macro.params.length} arguments, got ${item.args.length}`,
        macroName: item.name,
      });
    }

    const paramMap = new Map<string, string>();
    for (let i = 0; i < macro.params.length && i < item.args.length; i++) {
      paramMap.set(macro.params[i], item.args[i]);
    }

    const substituted = substituteParams(macro.body, paramMap);

    // Recursively expand any macro calls in the expanded body
    expansionStack.add(item.name);
    const expanded = expandBody(substituted, macros, expansionStack, errors, depth + 1);
    expansionStack.delete(item.name);

    result.push(...expanded);
  }

  return result;
}

function substituteParams(body: ConfigBodyNode[], paramMap: Map<string, string>): ConfigBodyNode[] {
  return body.map(item => {
    if (item.type === 'mapping') {
      const newName = paramMap.get(item.channelName) ?? item.channelName;
      return { ...item, channelName: newName };
    }
    if (item.type === 'require') {
      return { ...item, expression: substituteExpr(item.expression, paramMap) };
    }
    if (item.type === 'macro_call') {
      // Substitute args in nested macro calls
      const newArgs = item.args.map(arg => paramMap.get(arg) ?? arg);
      return { ...item, args: newArgs };
    }
    return item;
  });
}

function substituteExpr(expr: ConstraintExprNode, paramMap: Map<string, string>): ConstraintExprNode {
  switch (expr.type) {
    case 'ident':
      return { ...expr, name: paramMap.get(expr.name) ?? expr.name };
    case 'function_call':
      return { ...expr, args: expr.args.map(a => substituteExpr(a, paramMap)) };
    case 'binary_expr':
      return { ...expr, left: substituteExpr(expr.left, paramMap), right: substituteExpr(expr.right, paramMap) };
    case 'unary_expr':
      return { ...expr, operand: substituteExpr(expr.operand, paramMap) };
    case 'dot_access':
      return expr;
    case 'string_literal':
      return expr;
  }
}
