import { acceptsSchema } from './action-schema.ts';
import type { ActionSchema } from './action-schema.ts';
import type { RlmFilter, RlmResult } from './types.ts';
import { RlmError } from './errors.ts';

/** Caller-owned immutable policy revisions and explicit consent identity. */
export interface RlmReuseIdentity { tool_policy: string; model_policy: string; consent: string }
/** Explicit original run and logical call; there is no cache search. */
export interface RlmReuseSelection { run: string; call: string }
/** Original provenance and usage, informational only and never charged to the new run. */
export interface RlmReuseProvenance extends RlmReuseSelection {
  state_digest: string;
  call_digest: string;
  scope_digest: string;
  snapshot_digest: string;
  policy_digest: string;
  tokens_in: number;
  tokens_out: number;
  reserved_tokens: number;
}
/** Stable contract dimensions available to typed SDK callers. */
export type RlmReuseDimension = 'identity' | 'selection' | 'provenance' | 'request' | 'original_opt_in' | 'completion' | 'settings' | 'tool_policy' | 'scope' | 'question' | 'snapshot' | 'origin_revision' | 'target_state' | 'answer' | 'target_started' | 'tracker' | 'source_workspace';
/** Stable reuse refusal with a field identifying the mismatched contract boundary. */
export class RlmReuseError extends RlmError {
  /** Failed contract dimension, safe for machine routing. */
  readonly dimension: RlmReuseDimension;
  /** Corrective action independent of untrusted content. */
  readonly remedy: string;
  /** Retain safe typed diagnostics without source text. */
  constructor(dimension: RlmReuseDimension, code: RlmError['code'] = 'evidence') {
    super(code, `Verified reuse refused: ${dimension}`);
    this.dimension = dimension;
    this.remedy = 'Select an intact original completed call and match its exact question, scope, snapshot, settings and recorded policy/consent identities; otherwise execute a fresh run';
  }
}
const identityText: ActionSchema = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,127}$' };
const id: ActionSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,160}$' };
const hash: ActionSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const counter: ActionSchema = { type: 'integer', minimum: 0, maximum: 1000000000 };
/** Build strict object definitions for the single reuse boundary schema. */
function closed(properties: Record<string, ActionSchema>): ActionSchema {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
const bounded: ActionSchema = { type: 'string', pattern: '^[\\s\\S]{1,4096}$' };
const scope: ActionSchema = { ...closed({ ...Object.fromEntries(['type', 'status', 'parent', 'tag', 'text'].map(key => [key, bounded])), ids: { type: 'array', maxItems: 10000, items: bounded } }), required: [] };
const identity = closed({ tool_policy: identityText, model_policy: identityText, consent: identityText });
const selection = closed({ run: id, call: id });
/** One strict schema for runtime requests, persisted identity and emitted provenance. */
export const REUSE_SCHEMA = {
  identity, selection,
  usage: closed({ calls: { ...counter, minimum: 1 }, reserved_tokens: counter, tokens_in: counter, tokens_out: counter }),
  reused_usage: closed({ calls: { ...counter, minimum: 1, maximum: 1 }, reserved_tokens: { ...counter, maximum: 0 }, tokens_in: { ...counter, maximum: 0 }, tokens_out: { ...counter, maximum: 0 } }),
  request: closed({ question: { type: 'string', pattern: '^(?=[\\s\\S]{1,4096}$)[\\s\\S]*\\S[\\s\\S]*$' }, scope, identity, selection }),
  provenance: closed({ run: id, call: id, state_digest: hash, call_digest: hash, scope_digest: hash, snapshot_digest: hash, policy_digest: hash, tokens_in: counter, tokens_out: counter, reserved_tokens: counter }),
};
/** Validate an identity once at the API or checkpoint boundary, preserving exact bytes. */
export function parseReuseIdentity(value: unknown): RlmReuseIdentity {
  if (!acceptsSchema(REUSE_SCHEMA.identity, value)) throw new RlmReuseError('identity');
  return structuredClone(value) as RlmReuseIdentity;
}
/** Validate the explicitly selected origin without coercion or implicit discovery. */
export function parseReuseSelection(value: unknown): RlmReuseSelection {
  if (!acceptsSchema(REUSE_SCHEMA.selection, value)) throw new RlmReuseError('selection');
  return structuredClone(value) as RlmReuseSelection;
}
/** Validate every emitted or imported counter and digest before reporting success. */
export function parseReuseProvenance(value: unknown): RlmReuseProvenance {
  if (!acceptsSchema(REUSE_SCHEMA.provenance, value)) throw new RlmReuseError('provenance');
  return structuredClone(value) as RlmReuseProvenance;
}

/** Validate the complete untrusted reuse contract once, including dense bounded scope arrays. */
export function parseReuseRequest(value: unknown): { question: string; scope: RlmFilter; identity: RlmReuseIdentity; selection: RlmReuseSelection } {
  if (!acceptsSchema(REUSE_SCHEMA.request, value)) throw new RlmReuseError('request');
  return structuredClone(value) as { question: string; scope: RlmFilter; identity: RlmReuseIdentity; selection: RlmReuseSelection };
}

/** Check every returned accounting coordinate, including exact zero charges for verified reuse. */
export function assertReuseUsage(result: RlmResult): void {
  const { calls, reserved_tokens, tokens_in, tokens_out } = result;
  const schema = result.reuse === undefined ? REUSE_SCHEMA.usage : REUSE_SCHEMA.reused_usage;
  if (!acceptsSchema(schema, { calls, reserved_tokens, tokens_in, tokens_out })) throw new RlmReuseError('provenance');
}
