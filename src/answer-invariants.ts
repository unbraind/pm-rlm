import { open } from 'node:fs/promises';
import { extractObject } from './action-envelope.ts';
import { acceptsSchema } from './action-schema.ts';
import { aggregateItems } from './aggregates.ts';
import { blobDigest } from './blobs.ts';
import { record } from './errors.ts';
import { matches, certifiedRlmCorpus } from './environment.ts';
import { ANSWER_INVARIANT_SCHEMA, invariantStatus, verifiedFactIds, parseAnswerContract, RlmInvariantError, validateAnswerReport } from './answer-contract.ts';
import type { RlmAnswerInvariant, RlmAnswerReport, RlmAnswerScalar, RlmInvariantResult } from './answer-contract.ts';
import type { RlmItem, RlmScalar } from './types.ts';

/** Explicit complete SDK read; acquisition remains outside immutable check execution. */
export interface RlmVerifyAnswerOptions { environment: unknown }

/** Read bounded JSON with one sentinel byte; refuse ambiguous keys and malformed UTF-8. */
export async function readAnswerContract(file: string, maxBytes = 65536): Promise<unknown> {
  try {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, null);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      if (size > maxBytes) throw new RlmInvariantError();
      const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
      if (extractObject(source) !== source.trim()) throw new RlmInvariantError();
      return JSON.parse(source) as unknown;
    } finally { await handle.close(); }
  } catch { throw new RlmInvariantError(); }
}

/** A bad or unavailable record refuses only its dependent check. */
function unknown(check: RlmAnswerInvariant, reason: RlmInvariantResult['reason']): RlmInvariantResult {
  return { id: check.id, kind: check.kind, status: 'unknown', actual: null, reason, remedy: reason === 'source_incomplete' ? 'Repair source read completeness and retry against a fresh certified snapshot' : 'Select an available item and a bounded native scalar value inside the declared scope' };
}

/** Evaluate closed operations over one captured scope, without a tool/model execution hook. */
function evaluate(check: RlmAnswerInvariant, items: readonly RlmItem[]): RlmInvariantResult {
  let actual: RlmAnswerScalar;
  if (check.kind === 'count') actual = aggregateItems(items, { action: 'count', filter: check.filter }) as number;
  else if (check.kind === 'membership') {
    const values = aggregateItems(items, { action: 'distinct', filter: check.filter, field: check.field }) as RlmScalar[];
    if (values.some(value => !acceptsSchema(ANSWER_INVARIANT_SCHEMA.scalar, value))) return unknown(check, 'value_out_of_domain');
    actual = values.includes(check.value) ? 'present' : 'absent';
  } else {
    const item = items.find(item => item.id === check.item);
    if (item === undefined) return unknown(check, 'item_unavailable');
    actual = (aggregateItems([item], { action: 'distinct', filter: {}, field: check.field }) as RlmAnswerScalar[])[0];
  }
  if (!acceptsSchema(ANSWER_INVARIANT_SCHEMA.scalar, actual)) return unknown(check, 'value_out_of_domain');
  const passed = actual === check.expected;
  return { id: check.id, kind: check.kind, status: passed ? 'passed' : 'failed', actual, reason: passed ? 'matched' : 'mismatch', remedy: passed ? '' : 'Correct the structured assertion or choose the intended scope; citations alone do not prove this assertion' };
}

/** Verify a final answer's structured facts; prose remains explicitly unevaluated. */
export async function verifyRlmAnswer(input: unknown, options: RlmVerifyAnswerOptions): Promise<RlmAnswerReport> {
  const contract = parseAnswerContract(input);
  const report: RlmAnswerReport = {
    version: contract.version, status: 'incomplete', contract_digest: blobDigest(JSON.stringify(contract)),
    source: { status: 'incomplete', snapshot_digest: '', items: 'unknown' }, checks: [], verified_fact_ids: 'none',
    answer: { text: contract.answer, verification: 'not_evaluated' }, model_calls: 0, writes: 0,
  };
  let items: RlmItem[];
  try {
    const rows = record(options.environment).items;
    if (!Array.isArray(rows) || rows.length > 100000 || Array.from({ length: rows.length }, (_, index) => Object.hasOwn(rows, index)).includes(false) || Buffer.byteLength(JSON.stringify(options.environment)) > 16777216) throw new RlmInvariantError('incomplete');
    const corpus = certifiedRlmCorpus(options.environment);
    items = corpus.items.filter(item => matches(item, contract.scope));
    report.source = { status: 'complete', snapshot_digest: blobDigest(JSON.stringify({ scope: contract.scope, items })), items: items.length };
  } catch {
    report.checks = contract.checks.map(check => unknown(check, 'source_incomplete'));
    return validateAnswerReport(report);
  }
  report.checks = contract.checks.map(check => {
    try { return evaluate(check, items); }
    catch {
      return unknown(check, 'value_out_of_domain');
    }
  });
  report.verified_fact_ids = verifiedFactIds(report.checks);
  report.status = invariantStatus(report.checks);
  return validateAnswerReport(report);
}
