import { RlmError } from './errors.ts';
import type { RlmAction, RlmFilter } from './types.ts';

/** Supported JSON Schema vocabulary, shared by transport and runtime validation. */
export interface ActionSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'null';
  properties?: Record<string, ActionSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: ActionSchema;
  anyOf?: ActionSchema[];
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
}
/** Build a closed object without duplicating required-field definitions. */
function object(properties: Record<string, ActionSchema>, required = Object.keys(properties)): ActionSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}
const nonempty: ActionSchema = { type: 'string', minLength: 1 };
const integer: ActionSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const field: ActionSchema = { type: 'string', pattern: '^[A-Za-z_][A-Za-z_0-9]*$' };
const expression: ActionSchema = { type: 'string', pattern: '^(?:[A-Za-z_][A-Za-z_0-9]*|len\\([A-Za-z_][A-Za-z_0-9]*\\))$' };
const filter = object({ ...Object.fromEntries(['type', 'status', 'parent', 'tag', 'text'].map(key => [key, nonempty])), ids: { type: 'array', items: nonempty } }, []);
const slice = { anyOf: [object({ partition_step: integer, index: integer }), object({ fragments: { type: 'array', items: object({ id: nonempty, start: integer, end: integer, text: nonempty }) }, estimated_tokens: integer })] };
/** One discriminated action definition drives both the schema and its validator. */
const alternatives: Record<string, Record<string, ActionSchema>> = {
  list: { filter }, search: { query: nonempty, limit: { ...integer, minimum: 1 } }, get: { id: nonempty, fields: { type: 'array', items: nonempty } },
  history: { id: nonempty, start: integer, end: integer }, peek: { id: nonempty, field: nonempty, start: integer, end: integer },
  partition: { filter, maxTokens: { ...integer, minimum: 1 } }, spawn: { subgoal: nonempty, slice }, finish: { answer: { type: 'string' } },
  count: { filter }, sum: { filter, field_expr: expression }, distinct: { filter, field }, group_count: { filter, field }, argmax: { filter, numeric_expr: expression }, argmin: { filter, numeric_expr: expression },
};
/** Action transport schema; optional filters keep the established empty-filter shorthand. */
export const ACTION_SCHEMA: ActionSchema = { type: 'object', anyOf: Object.entries(alternatives).map(([action, fields]) => object({ action: { type: 'string', enum: [action] }, ...fields }, ['action', ...Object.keys(fields).filter(key => key !== 'filter')])) };
/** Independent stuffing response contract, with no access to environment actions. */
export const ANSWER_SCHEMA: ActionSchema = object({ answer: { type: 'string' } });
/** Interpret precisely the schema vocabulary emitted above; no executable expressions. */
export function acceptsSchema(schema: ActionSchema, value: unknown): boolean {
  if (schema.anyOf !== undefined) return schema.anyOf.some(branch => acceptsSchema(branch, value));
  switch (schema.type) {
    case 'null': return value === null;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const entries = value as Record<string, unknown>;
      return schema.required!.every(key => Object.hasOwn(entries, key)) && Object.keys(entries).every(key => Object.hasOwn(schema.properties!, key) && acceptsSchema(schema.properties![key], entries[key]));
    }
    case 'array': return Array.isArray(value) && value.every(entry => acceptsSchema(schema.items!, entry));
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value) && value >= schema.minimum! && value <= schema.maximum!;
    case 'string': return typeof value === 'string' && (schema.minLength === undefined || [...value].length >= schema.minLength) && (schema.enum === undefined || schema.enum.includes(value)) && (schema.pattern === undefined || new RegExp(schema.pattern, 'u').test(value));
  }
  return false;
}
/** Validate the generated transport contract and normalize only the optional filter. */
export function schemaAction(value: unknown): RlmAction {
  if (!acceptsSchema(ACTION_SCHEMA, value)) throw new RlmError('invalid', 'Action does not match the action JSON Schema');
  const action = value as RlmAction;
  return Object.hasOwn(alternatives[action.action], 'filter') ? { ...action, filter: (action as { filter?: RlmFilter }).filter ?? {} } as RlmAction : action;
}

/** Convert optional properties to required nullable properties for strict compatible endpoints. */
function strictSchema(schema: ActionSchema): ActionSchema {
  if (schema.anyOf !== undefined) return { anyOf: schema.anyOf.map(strictSchema) };
  if (schema.type === 'object') {
    const properties = Object.fromEntries(Object.entries(schema.properties!).map(([key, value]) => [key, schema.required!.includes(key) ? strictSchema(value) : { anyOf: [strictSchema(value), { type: 'null' as const }] }]));
    return object(properties);
  }
  return schema.items === undefined ? schema : { ...schema, items: strictSchema(schema.items) };
}
/** OpenAI requires an object root rather than a root union; keep the action union inside it. */
export const COMPATIBLE_ACTION_SCHEMA = strictSchema(object({ response: ACTION_SCHEMA }));
/** Strict stuffing contract generated through the same compatibility conversion. */
export const COMPATIBLE_ANSWER_SCHEMA = strictSchema(ANSWER_SCHEMA);
/** Remove only schema-declared optional nulls, preserving every other emitted value for validation. */
function optionalNulls(schema: ActionSchema, value: unknown): unknown {
  if (schema.anyOf !== undefined) {
    const branch = schema.anyOf.find(branch => acceptsSchema(strictSchema(branch), value));
    return optionalNulls(branch!, value);
  }
  if (schema.type === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== null).map(([key, entry]) => [key, optionalNulls(schema.properties![key], entry)]));
  if (schema.type === 'array') return (value as unknown[]).map(entry => optionalNulls(schema.items!, entry));
  return value;
}
/** Decode strict transport wrapping only when it validates; ignored-format responses keep the fallback. */
export function compatibleAction(output: string): string {
  try {
    const value: unknown = JSON.parse(output);
    if (!acceptsSchema(COMPATIBLE_ACTION_SCHEMA, value)) return output;
    return JSON.stringify(optionalNulls(ACTION_SCHEMA, (value as { response: unknown }).response));
  } catch { return output; }
}
