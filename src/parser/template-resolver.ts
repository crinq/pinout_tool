// ============================================================
// Template Resolver
//
// Runs on the parsed AST and does the two expansions that need
// structure rather than text:
//   - `port X from Y` template chains, with cycle detection
//   - `$var` mapping bindings, desugared into require statements
//
// Macros are NOT handled here — they expand on the source text
// before it is ever tokenized. See parser/preprocessor.ts.
// ============================================================

import type {
  ProgramNode,
  PortDeclNode,
  ConfigDeclNode,
  ConfigBodyNode,
  MappingNode,
  PatternPart,
} from './constraint-ast';

export interface MacroError {
  message: string;
  macroName: string;
}

export interface MacroExpansionResult {
  ast: ProgramNode;
  errors: MacroError[];
}

/**
 * Resolve `port X from Y` templates and desugar `$var` bindings.
 * Returns a new AST plus any errors encountered.
 */
export function resolveTemplates(
  ast: ProgramNode,
  extraTemplates?: Map<string, PortDeclNode>,
): MacroExpansionResult {
  // Collect port templates: every port_decl (including ones that
  // themselves use `from`) is a template candidate — chains resolve
  // recursively below with cycle detection.
  const templates = new Map<string, PortDeclNode>();
  if (extraTemplates) {
    for (const [name, tmpl] of extraTemplates) {
      templates.set(name, tmpl);
    }
  }
  for (const stmt of ast.statements) {
    if (stmt.type === 'port_decl') templates.set(stmt.name, stmt);
  }

  const errors: MacroError[] = [];

  /** Walk the `from` chain; cache results; guard cycles. */
  const resolved = new Map<string, PortDeclNode>();
  const resolvePort = (port: PortDeclNode, chain: Set<string>): PortDeclNode => {
    if (!port.template) return port;
    if (chain.has(port.name)) {
      errors.push({ message: `Port template cycle: ${[...chain, port.name].join(' → ')}`, macroName: port.name });
      return port;
    }
    const cached = resolved.get(port.name);
    if (cached) return cached;
    const base = templates.get(port.template);
    if (!base) {
      errors.push({ message: `Unknown port template '${port.template}'`, macroName: port.template });
      return port;
    }
    const chain2 = new Set(chain); chain2.add(port.name);
    const resolvedBase = resolvePort(base, chain2);
    const merged = applyTemplate(port, resolvedBase);
    resolved.set(port.name, merged);
    return merged;
  };

  const newStatements = ast.statements.map(stmt => {
    if (stmt.type !== 'port_decl') return stmt;

    // Apply template chain if specified.
    const port = stmt.template ? resolvePort(stmt, new Set()) : stmt;

    // Desugar $var bindings (port-scoped: collected across all configs)
    const desugaredConfigs = desugarVariableBindings(port.configs, errors);

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

  // Groups follow their channels: a derived port redeclaring a group name
  // replaces the template's version of it.
  const portGroupNames = new Set((port.groups ?? []).map(g => g.name));
  const mergedGroups = [
    ...(template.groups ?? []).filter(g => !portGroupNames.has(g.name)),
    ...(port.groups ?? []),
  ];

  return {
    ...port,
    template: undefined, // clear template reference
    channels: mergedChannels,
    configs: mergedConfigs,
    groups: mergedGroups.length > 0 ? mergedGroups : undefined,
    color: port.color ?? template.color,
    // A derived port's own placement clause overrides the template's
    // (e.g. `enc1 from enc0: @ ~NW`); otherwise inherit it.
    anchor: port.anchor ?? template.anchor,
    anchorFixedPins: port.anchorFixedPins ?? template.anchorFixedPins,
    anchorExcludedPins: port.anchorExcludedPins ?? template.anchorExcludedPins,
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
