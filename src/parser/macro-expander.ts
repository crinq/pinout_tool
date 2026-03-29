// ============================================================
// Macro Expander
// Walks the AST and expands macro calls into their bodies
// with parameter substitution, cycle detection, and
// recursive expansion.
// ============================================================

import type {
  ProgramNode,
  PortDeclNode,
  MacroDeclNode,
  ConfigDeclNode,
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

/** Key for macro lookup: name/arity */
function macroKey(name: string, arity: number): string {
  return `${name}/${arity}`;
}

/**
 * Extract all macro declarations from an AST.
 * Supports overloading: multiple macros with the same name but different parameter counts.
 */
export function extractMacros(ast: ProgramNode): Map<string, MacroDeclNode> {
  const macros = new Map<string, MacroDeclNode>();
  for (const stmt of ast.statements) {
    if (stmt.type === 'macro_decl') {
      macros.set(macroKey(stmt.name, stmt.params.length), stmt);
    }
  }
  return macros;
}

/**
 * Expand all macro calls within config bodies throughout the AST.
 * Returns a new AST with macros expanded and any errors encountered.
 */
export function expandAllMacros(
  ast: ProgramNode,
  extraMacros?: Map<string, MacroDeclNode>,
  extraTemplates?: Map<string, PortDeclNode>,
): MacroExpansionResult {
  const macros = extractMacros(ast);
  if (extraMacros) {
    for (const [key, macro] of extraMacros) {
      if (!macros.has(key)) {
        macros.set(key, macro);
      }
    }
  }

  // Collect port templates: ports from this AST + extra templates (from stdlib)
  const templates = new Map<string, PortDeclNode>();
  if (extraTemplates) {
    for (const [name, tmpl] of extraTemplates) {
      templates.set(name, tmpl);
    }
  }
  for (const stmt of ast.statements) {
    if (stmt.type === 'port_decl' && !stmt.template) {
      templates.set(stmt.name, stmt);
    }
  }

  const errors: MacroError[] = [];

  const newStatements = ast.statements.map(stmt => {
    if (stmt.type !== 'port_decl') return stmt;

    // Apply template if specified
    let port = stmt;
    if (stmt.template) {
      const tmpl = templates.get(stmt.template);
      if (!tmpl) {
        errors.push({ message: `Unknown port template '${stmt.template}'`, macroName: stmt.template });
      } else {
        port = applyTemplate(stmt, tmpl);
      }
    }

    const newConfigs = port.configs.map(cfg => {
      const expandedBody = expandBody(cfg.body, macros, new Set(), errors);
      return { ...cfg, body: expandedBody };
    });

    // Desugar $var instance bindings (port-scoped: collected across all configs)
    const desugaredConfigs = desugarInstanceBindings(newConfigs);

    return { ...port, configs: desugaredConfigs };
  });

  return {
    ast: { ...ast, statements: newStatements },
    errors,
  };
}

/**
 * Apply a port template: merge template channels/configs with overrides from the port.
 * Port's own channels are appended. Port's configs with same name replace template's.
 */
function applyTemplate(port: PortDeclNode, template: PortDeclNode): PortDeclNode {
  // Merge channels: template channels first, then port's additional channels
  const portChannelNames = new Set(port.channels.map(c => c.name));
  const mergedChannels = [
    ...template.channels.filter(c => !portChannelNames.has(c.name)),
    ...port.channels,
  ];

  // Merge configs: port configs override template configs with same name
  const portConfigNames = new Set(port.configs.map(c => c.name));
  const mergedConfigs = [
    ...template.configs.filter(c => !portConfigNames.has(c.name)),
    ...port.configs,
  ];

  return {
    ...port,
    template: undefined, // clear template reference
    channels: mergedChannels,
    configs: mergedConfigs,
    color: port.color ?? template.color,
  };
}

/**
 * Desugar $var instance bindings into same_instance() require statements.
 * Port-scoped: collects $var usages across ALL configs of a port, then
 * appends same_instance() to each config that uses channels from the group.
 */
function desugarInstanceBindings(configs: ConfigDeclNode[]): ConfigDeclNode[] {
  // Collect channels by $var name across all configs
  const bindingGroups = new Map<string, Set<string>>();
  for (const cfg of configs) {
    for (const item of cfg.body) {
      if (item.type === 'mapping' && item.instanceBindings) {
        for (const varName of item.instanceBindings) {
          let group = bindingGroups.get(varName);
          if (!group) {
            group = new Set();
            bindingGroups.set(varName, group);
          }
          group.add(item.channelName);
        }
      }
    }
  }

  // No bindings → return as-is
  const hasBindings = [...bindingGroups.values()].some(g => g.size >= 2);
  if (!hasBindings) return configs;

  // Build require nodes for groups with 2+ channels
  const groupRequires = new Map<string, ConfigBodyNode>();
  for (const [, channels] of bindingGroups) {
    if (channels.size < 2) continue;
    const loc = { line: 0, column: 0 };
    const channelArr = [...channels];
    const req: ConfigBodyNode = {
      type: 'require',
      expression: {
        type: 'function_call',
        name: 'same_instance',
        args: channelArr.map(name => ({ type: 'ident' as const, name, loc })),
        loc,
      },
      loc,
    };
    // Key by sorted channel names for dedup
    groupRequires.set(channelArr.sort().join(','), req);
  }

  return configs.map(cfg => {
    // Find which binding groups this config touches
    const cfgChannels = new Set(
      cfg.body.filter(b => b.type === 'mapping').map(b => (b as { channelName: string }).channelName)
    );

    const extraRequires: ConfigBodyNode[] = [];
    for (const [key, req] of groupRequires) {
      const groupChannels = key.split(',');
      // Add the require if this config maps at least 2 channels from the group
      const overlap = groupChannels.filter(ch => cfgChannels.has(ch));
      if (overlap.length >= 2) {
        extraRequires.push(req);
      }
    }

    // Strip instanceBindings from mappings
    const cleanedBody = cfg.body.map(item => {
      if (item.type === 'mapping' && item.instanceBindings) {
        const { instanceBindings: _, ...rest } = item;
        return rest;
      }
      return item;
    });

    if (extraRequires.length === 0) return { ...cfg, body: cleanedBody };
    return { ...cfg, body: [...cleanedBody, ...extraRequires] };
  });
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

    const key = macroKey(item.name, item.args.length);
    const macro = macros.get(key);
    if (!macro) {
      // Collect available arities for better error message
      const arities: number[] = [];
      for (const k of macros.keys()) {
        if (k.startsWith(item.name + '/')) {
          arities.push(parseInt(k.split('/')[1], 10));
        }
      }
      if (arities.length > 0) {
        errors.push({
          message: `Macro '${item.name}' with ${item.args.length} arguments not found. Available: ${arities.map(a => `${item.name}(${a} args)`).join(', ')}`,
          macroName: item.name,
        });
      } else {
        errors.push({ message: `Unknown macro '${item.name}'`, macroName: item.name });
      }
      continue;
    }

    if (expansionStack.has(item.name)) {
      errors.push({ message: `Recursive macro call detected: '${item.name}'`, macroName: item.name });
      continue;
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
    case 'number_literal':
      return expr;
  }
}
