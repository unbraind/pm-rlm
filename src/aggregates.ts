import { matches, parseFilter } from './environment.ts';
import { record, RlmError, text } from './errors.ts';
import type { RlmAggregate, RlmItem, RlmScalar } from './types.ts';

/** Accept a single own-field identifier, never paths or executable syntax. */
function fieldName(value: unknown): string {
  const name = text(value);
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new RlmError('invalid', 'Expected a single field name');
  return name;
}
/** Validate the complete numeric expression grammar without evaluating source. */
function expression(value: unknown): string {
  const source = text(value);
  fieldName(source.startsWith('len(') && source.endsWith(')') ? source.slice(4, -1) : source);
  return source;
}
/** Parse typed aggregate operands, preserving the existing filter boundary. */
export function parseAggregate(input: unknown): RlmAggregate {
  const value = record(input);
  const filter = parseFilter(value.filter ?? {});
  switch (value.action) {
    case 'count': return { action: 'count', filter };
    case 'sum': return { action: 'sum', filter, field_expr: expression(value.field_expr) };
    case 'distinct': case 'group_count': return { action: value.action, filter, field: fieldName(value.field) };
    case 'argmax': case 'argmin': return { action: value.action, filter, numeric_expr: expression(value.numeric_expr) };
    default: throw new RlmError('invalid', 'Unknown aggregate action');
  }
}
/** Refuse overflow and unsafe integer arithmetic rather than inventing exact results. */
function finite(value: number): number {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new RlmError('invalid', 'Numeric result is non-finite or an unsafe integer');
  return value;
}
/** Read only own fields, with explicit UTF-8 text length and finite numeric semantics. */
function numeric(item: RlmItem, expr: string): number {
  const length = expr.startsWith('len(');
  const field = length ? expr.slice(4, -1) : expr;
  const value: unknown = Object.hasOwn(item, field) ? item[field] : undefined;
  if (length) {
    if (value === null || value === undefined) return 0;
    if (typeof value !== 'string') throw new RlmError('invalid', 'len requires a string field');
    return Buffer.byteLength(value, 'utf8');
  }
  if (typeof value !== 'number') throw new RlmError('invalid', 'Expected a numeric field on every matching item');
  return finite(value);
}
/** Normalize absent scalars and refuse structured or non-finite grouping values. */
function scalar(item: RlmItem, field: string): RlmScalar {
  const value: unknown = Object.hasOwn(item, field) ? item[field] : null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return finite(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  throw new RlmError('invalid', 'Grouping requires a scalar field');
}
/** Compute deterministic, scope-local aggregates with no code or query execution. */
export function aggregateItems(items: readonly RlmItem[], input: RlmAggregate): number | RlmScalar[] | { value: RlmScalar; count: number }[] {
  const action = parseAggregate(input);
  const rows = items.filter(item => matches(item, action.filter));
  switch (action.action) {
    case 'count': return rows.length;
    case 'sum': return rows.reduce((sum, item) => finite(sum + numeric(item, action.field_expr)), 0);
    case 'distinct': case 'group_count': {
      const groups = new Map<string, { value: RlmScalar; count: number }>();
      for (const item of rows) {
        const value = scalar(item, action.field);
        const key = JSON.stringify(value);
        const previous = groups.get(key);
        groups.set(key, { value, count: (previous?.count ?? 0) + 1 });
      }
      const sorted = [...groups.keys()].sort().map(key => groups.get(key)!);
      return action.action === 'distinct' ? sorted.map(row => row.value) : sorted;
    }
    case 'argmax': case 'argmin': {
      const values = rows.map(item => ({ id: item.id, value: numeric(item, action.numeric_expr) }));
      const sorted = values.sort((a, b) => action.action === 'argmax' ? b.value - a.value : a.value - b.value);
      return sorted.filter(row => row.value === sorted[0].value).map(row => row.id).sort();
    }
  }
}
