import { acceptsSchema } from './action-schema.ts';
import type { ActionSchema } from './action-schema.ts';
import { RlmError } from './errors.ts';
import type { RlmFilter } from './types.ts';

/** Scalar native fields supported by immutable checks; paths and code are excluded. */
export type RlmAnswerField = 'id' | 'title' | 'type' | 'status' | 'priority' | 'parent' | 'assignee' | 'sprint' | 'release';
/** Exact bounded strings, safe integers and absent optional fields. */
export type RlmAnswerScalar = string | number | null;
/** Exact cardinality over the intersection of contract scope and check filter. */
export interface RlmCountInvariant { id: string; kind: 'count'; filter: RlmFilter; expected: number }
/** Membership in the distinct scalar values of the filtered certified environment. */
export interface RlmMembershipInvariant { id: string; kind: 'membership'; filter: RlmFilter; field: RlmAnswerField; value: RlmAnswerScalar; expected: 'present' | 'absent' }
/** Exact scalar equality for one item inside the contract's immutable scope. */
export interface RlmEqualityInvariant { id: string; kind: 'equals'; item: string; field: RlmAnswerField; expected: RlmAnswerScalar }
/** Closed declarative grammar with no executable predicates or inference. */
export type RlmAnswerInvariant = RlmCountInvariant | RlmMembershipInvariant | RlmEqualityInvariant;
/** Caller-owned final answer and independently verifiable structured assertions. */
export interface RlmAnswerContract { version: 'answer-invariants-v1'; answer: string; scope: RlmFilter; checks: RlmAnswerInvariant[] }
/** One bounded result; an unsupported field value affects only this check. */
export interface RlmInvariantResult {
  id: string; kind: RlmAnswerInvariant['kind']; status: 'passed' | 'failed' | 'unknown';
  actual: RlmAnswerScalar; reason: 'matched' | 'mismatch' | 'source_incomplete' | 'item_unavailable' | 'value_out_of_domain'; remedy: string;
}
/** Facts and prose have separate labels; complete failures are never source gaps. */
export interface RlmAnswerReport {
  version: 'answer-invariants-v1'; status: 'passed' | 'failed' | 'incomplete'; contract_digest: string;
  source: { status: 'complete' | 'incomplete'; snapshot_digest: string; items: number | 'unknown' };
  checks: RlmInvariantResult[]; verified_fact_ids: string[] | 'none';
  answer: { text: string; verification: 'not_evaluated' }; model_calls: 0; writes: 0;
}
/** Safe actionable refusals never repeat rejected input or filesystem diagnostics. */
export class RlmInvariantError extends RlmError {
  readonly remedy: string;
  /** Distinguish invalid declarations from invalid generated receipts. */
  constructor(code: 'invalid' | 'incomplete' = 'invalid') {
    super(code, 'Answer invariant contract refused');
    this.remedy = 'Supply answer-invariants-v1 JSON with 1 to 64 uniquely named count, membership or equals checks; use bounded native scalar fields and exact integer counts; CLI requires --environment with a complete SDK read';
  }
}
/** Generate closed objects from the definitions shared by producers and validators. */
function closed(properties: Record<string, ActionSchema>, required = Object.keys(properties)): ActionSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}
const count: ActionSchema = { type: 'integer', minimum: 0, maximum: 1000000000 };
const label: ActionSchema = { type: 'string', pattern: '^(?=[\\s\\S]{1,256}$)[\\s\\S]*\\S[\\s\\S]*$' };
const scalar: ActionSchema = { anyOf: [{ type: 'string', pattern: '^[\\s\\S]{0,256}$' }, { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }, { type: 'null' }] };
const field: ActionSchema = { type: 'string', enum: ['id', 'title', 'type', 'status', 'priority', 'parent', 'assignee', 'sprint', 'release'] };
const filter = closed({ ...Object.fromEntries(['type', 'status', 'parent', 'tag', 'text'].map(key => [key, label])), ids: { type: 'array', maxItems: 1000, items: label } }, []);
const check: ActionSchema = { anyOf: [
  closed({ id: label, kind: { type: 'string', enum: ['count'] }, filter, expected: count }),
  closed({ id: label, kind: { type: 'string', enum: ['membership'] }, filter, field, value: scalar, expected: { type: 'string', enum: ['present', 'absent'] } }),
  closed({ id: label, kind: { type: 'string', enum: ['equals'] }, item: label, field, expected: scalar }),
] };
const answer = closed({ text: { type: 'string', pattern: '^[\\s\\S]{0,8192}$' }, verification: { type: 'string', enum: ['not_evaluated'] } });
const resultFields = { id: label, status: { type: 'string', enum: ['passed', 'failed', 'unknown'] } as ActionSchema, reason: { type: 'string', enum: ['matched', 'mismatch', 'source_incomplete', 'item_unavailable', 'value_out_of_domain'] } as ActionSchema, remedy: { type: 'string', pattern: '^[\\s\\S]{0,256}$' } as ActionSchema };
const result: ActionSchema = { anyOf: [
  closed({ ...resultFields, kind: { type: 'string', enum: ['count'] }, actual: { anyOf: [count, { type: 'null' }] } }),
  closed({ ...resultFields, kind: { type: 'string', enum: ['membership'] }, actual: { anyOf: [{ type: 'string', enum: ['present', 'absent'] }, { type: 'null' }] } }),
  closed({ ...resultFields, kind: { type: 'string', enum: ['equals'] }, actual: scalar }),
] };
const digest: ActionSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
/** Single strict schema family for input, individual results, and emitted accounting. */
export const ANSWER_INVARIANT_SCHEMA = {
  contract: closed({ version: { type: 'string', enum: ['answer-invariants-v1'] }, answer: { type: 'string', pattern: '^[\\s\\S]{0,8192}$' }, scope: filter, checks: { type: 'array', maxItems: 64, items: check } }),
  result,
  report: closed({ version: { type: 'string', enum: ['answer-invariants-v1'] }, status: { type: 'string', enum: ['passed', 'failed', 'incomplete'] }, contract_digest: digest,
    source: { anyOf: [closed({ status: { type: 'string', enum: ['complete'] }, snapshot_digest: digest, items: count }), closed({ status: { type: 'string', enum: ['incomplete'] }, snapshot_digest: { type: 'string', enum: [''] }, items: { type: 'string', enum: ['unknown'] } })] },
    checks: { type: 'array', maxItems: 64, items: result }, verified_fact_ids: { anyOf: [{ type: 'array', maxItems: 64, items: label }, { type: 'string', enum: ['none'] }] }, answer,
    model_calls: { type: 'integer', minimum: 0, maximum: 0 }, writes: { type: 'integer', minimum: 0, maximum: 0 },
  }),
  source_count: count,
  scalar,
};
/** Validate once before any read, preserve text exactly, and detach caller mutation. */
export function parseAnswerContract(value: unknown): RlmAnswerContract {
  if (!acceptsSchema(ANSWER_INVARIANT_SCHEMA.contract, value)) throw new RlmInvariantError();
  const contract = value as RlmAnswerContract;
  if (contract.checks.length === 0 || new Set(contract.checks.map(check => check.id)).size !== contract.checks.length || Buffer.byteLength(JSON.stringify(contract)) > 65536) throw new RlmInvariantError();
  return structuredClone(contract);
}

/** Derive the overall verdict with exact discrete comparisons and failure precedence. */
export function invariantStatus(checks: RlmInvariantResult[]): RlmAnswerReport['status'] {
  return checks.some(check => check.status === 'failed') ? 'failed' : checks.some(check => check.status === 'unknown') ? 'incomplete' : 'passed';
}
/** Keep an empty fact set explicit in both native TOON and JSON. */
export function verifiedFactIds(checks: RlmInvariantResult[]): RlmAnswerReport['verified_fact_ids'] {
  const ids = checks.filter(check => check.status === 'passed').map(check => check.id);
  return ids.length === 0 ? 'none' : ids;
}
/** Validate every emitted scalar and count, including cross-field success invariants. */
export function validateAnswerReport(report: RlmAnswerReport): RlmAnswerReport {
  if (!acceptsSchema(ANSWER_INVARIANT_SCHEMA.report, report) || report.checks.length === 0
    || new Set(report.checks.map(check => check.id)).size !== report.checks.length
    || JSON.stringify(report.verified_fact_ids) !== JSON.stringify(verifiedFactIds(report.checks))
    || report.status !== invariantStatus(report.checks)
    || (report.source.status === 'incomplete' && report.checks.some(check => check.reason !== 'source_incomplete' || check.status !== 'unknown'))
    || report.checks.some(check => check.status === 'passed' ? check.reason !== 'matched' || check.remedy !== '' : check.remedy.length === 0 || (check.status === 'failed' ? check.reason !== 'mismatch' : ['matched', 'mismatch'].includes(check.reason)))) throw new RlmInvariantError('incomplete');
  return report;
}
