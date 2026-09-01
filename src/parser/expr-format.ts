import type { ConstraintExprNode } from './constraint-ast';

/**
 * Render a require expression back to something close to its source form —
 * for the read-only constraint viewer and for explaining why a stored solution
 * no longer satisfies the constraints.
 */
export function formatConstraintExpr(expr: ConstraintExprNode): string {
  switch (expr.type) {
    case 'function_call':
      return `${expr.name}(${expr.args.map(formatConstraintExpr).join(', ')})`;
    case 'binary_expr':
      return `${formatConstraintExpr(expr.left)} ${expr.operator} ${formatConstraintExpr(expr.right)}`;
    case 'unary_expr':
      return `!${formatConstraintExpr(expr.operand)}`;
    case 'ident':
      return expr.name;
    case 'dot_access':
      return `${expr.object}.${expr.property}`;
    case 'string_literal':
      return `"${expr.value}"`;
    case 'number_literal':
      return String(expr.value);
    case 'boolean_literal':
      return expr.value ? 'true' : 'false';
    case 'pattern_literal':
      return expr.text;
  }
}
