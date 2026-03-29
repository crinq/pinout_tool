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
  MappingNode,
  PatternPart,
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

    // Desugar $var bindings (port-scoped: collected across all configs)
    const desugaredConfigs = desugarVariableBindings(newConfigs, errors);

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
 * Check if a PatternPart contains a wildcard (wildcard, any, or range — not literal).
 */
function isWildcard(part: PatternPart): boolean {
  return part.type !== 'literal';
}

/**
 * Count wildcard positions in a mapping and return their types in order.
 * For each signal expression (+ segment), checks instance and function parts
 * of the first alternative.
 */
function getWildcardPositions(mapping: MappingNode): Array<'instance' | 'function'> {
  const positions: Array<'instance' | 'function'> = [];
  for (const expr of mapping.signalExprs) {
    if (expr.alternatives.length === 0) continue;
    const pattern = expr.alternatives[0];
    if (isWildcard(pattern.instancePart)) positions.push('instance');
    if (isWildcard(pattern.functionPart)) positions.push('function');
  }
  return positions;
}

/**
 * Desugar $var bindings into require statements.
 * Port-scoped: collects $var usages across ALL configs of a port, then
 * appends appropriate constraints to each config.
 *
 * - Instance wildcards (e.g. USART*_TX $u) → same_instance()
 * - Function wildcards (e.g. TIM1_CH* $ch) → channel_signal() == channel_signal()
 */
function desugarVariableBindings(configs: ConfigDeclNode[], errors: MacroError[]): ConfigDeclNode[] {
  // Collect channels by ($var name, wildcard type) across all configs
  type BindingInfo = { channels: Set<string>; type: 'instance' | 'function' };
  const bindingGroups = new Map<string, BindingInfo>();

  for (const cfg of configs) {
    for (const item of cfg.body) {
      if (item.type !== 'mapping' || !item.instanceBindings || item.instanceBindings.length === 0) continue;

      const wildcardPositions = getWildcardPositions(item);

      if (item.instanceBindings.length > wildcardPositions.length) {
        errors.push({
          message: `Mapping '${item.channelName}' has ${item.instanceBindings.length} variable(s) ($${item.instanceBindings.join(', $')}) but pattern only has ${wildcardPositions.length} wildcard(s)`,
          macroName: '$' + item.instanceBindings[0],
        });
        continue;
      }

      for (let i = 0; i < item.instanceBindings.length; i++) {
        const varName = item.instanceBindings[i];
        const wildcardType = wildcardPositions[i];
        const key = varName + '\0' + wildcardType;
        let group = bindingGroups.get(key);
        if (!group) {
          group = { channels: new Set(), type: wildcardType };
          bindingGroups.set(key, group);
        }
        group.channels.add(item.channelName);
      }
    }
  }

  // No usable bindings → return as-is
  const hasBindings = [...bindingGroups.values()].some(g => g.channels.size >= 2);
  if (!hasBindings) return stripBindings(configs);

  return configs.map(cfg => {
    const cfgChannels = new Set(
      cfg.body.filter(b => b.type === 'mapping').map(b => (b as { channelName: string }).channelName)
    );

    const extraRequires: ConfigBodyNode[] = [];

    for (const [, group] of bindingGroups) {
      if (group.channels.size < 2) continue;
      const channelArr = [...group.channels].sort();

      // Only add if this config maps at least 2 channels from the group
      const overlap = channelArr.filter(ch => cfgChannels.has(ch));
      if (overlap.length < 2) continue;

      const loc = { line: 0, column: 0 };

      if (group.type === 'instance') {
        extraRequires.push({
          type: 'require',
          expression: {
            type: 'function_call',
            name: 'same_instance',
            args: overlap.map(name => ({ type: 'ident' as const, name, loc })),
            loc,
          },
          loc,
        });
      } else {
        // Pairwise channel_signal equality for overlapping channels
        for (let i = 0; i < overlap.length - 1; i++) {
          extraRequires.push({
            type: 'require',
            expression: {
              type: 'binary_expr',
              operator: '==',
              left: {
                type: 'function_call',
                name: 'channel_signal',
                args: [{ type: 'ident' as const, name: overlap[i], loc }],
                loc,
              },
              right: {
                type: 'function_call',
                name: 'channel_signal',
                args: [{ type: 'ident' as const, name: overlap[i + 1], loc }],
                loc,
              },
              loc,
            },
            loc,
          });
        }
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

function stripBindings(configs: ConfigDeclNode[]): ConfigDeclNode[] {
  return configs.map(cfg => ({
    ...cfg,
    body: cfg.body.map(item => {
      if (item.type === 'mapping' && item.instanceBindings) {
        const { instanceBindings: _, ...rest } = item;
        return rest;
      }
      return item;
    }),
  }));
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
