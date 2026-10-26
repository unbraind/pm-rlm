import { certifyCompleteListResult } from '@unbrained/pm-cli/sdk';
import { blobDigest } from './blobs.ts';
import { prepareRlmRun, replayRlm, validateReuseTranscript } from './engine.ts';
import type { RlmRunOptions } from './engine.ts';
import { matches, readCorpus } from './environment.ts';
import { RlmError } from './errors.ts';
import { readRlmSettings } from './settings.ts';
import { RlmLedger } from './ledger.ts';
import { assertReuseUsage, parseReuseProvenance, parseReuseRequest, parseReuseSelection, RlmReuseError } from './reuse-contract.ts';
import type { RlmReuseDimension, RlmReuseIdentity, RlmReuseProvenance, RlmReuseSelection } from './reuse-contract.ts';
import type { RlmCall, RlmItem, RlmResult, RlmState } from './types.ts';

/** Explicit cross-run request; settings and source scope must match the original contract. */
export interface RlmReuseOptions extends Omit<RlmRunOptions, 'reuse_identity' | 'reuse_selection' | 'source_workspace' | 'model' | 'on_call_complete' | 'components'> {
  reuse_identity: RlmReuseIdentity;
  selection: RlmReuseSelection;
}
/** Foreign native rows are skipped without mutation or model inference. */
export interface RlmReuseSkipped { status: 'skipped'; reason: 'foreign'; remedy: string }
/** Compact native run result retaining original provenance separately from new usage. */
export type RlmReuseResult = (RlmResult & { status: 'reused'; model_calls: 0; reuse: RlmReuseProvenance }) | (RlmResult & { status: 'peer_completed' }) | RlmReuseSkipped;

/** Hash JSON values with stable object-key order, retaining exact strings and array order. */
function digest(value: unknown): string {
  return blobDigest(JSON.stringify(value, (_key, entry: unknown) => typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, (entry as Record<string, unknown>)[key]])) : entry) ?? 'undefined');
}
/** Sanitize operational failures while retaining existing contract refusals and their remedies. */
function reuseFailure(error: unknown): RlmReuseError {
  return error instanceof RlmReuseError ? error : new RlmReuseError('tracker', error instanceof RlmError ? error.code : 'incomplete');
}
/** Fail one precise identity boundary without disclosing its values. */
function equal(actual: unknown, expected: unknown, dimension: RlmReuseDimension): void {
  if (digest(actual) !== digest(expected)) throw new RlmReuseError(dimension);
}
/** Roots depend on their complete scoped snapshot; children depend on every supplied fragment's row. */
function dependencies(state: RlmState, call: RlmCall): RlmItem[] {
  const ids = new Set(call.slice.fragments.map(fragment => fragment.id));
  return state.snapshot.filter(item => call.depth === 0 || ids.has(item.id)).sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
}
/** Replay the original graph and bind the exact selected subanswer to a target's frozen contract. */
async function provenance(workspace: string, target: RlmState, selection: RlmReuseSelection): Promise<{ receipt: RlmReuseProvenance; answer: string }> {
  const ledger = new RlmLedger(workspace);
  const origin = await ledger.load(selection.run);
  if (origin.reuse !== undefined || origin.reuse_selection !== undefined || origin.reuse_identity === undefined || origin.snapshot_only !== true) throw new RlmReuseError('original_opt_in');
  const call = origin.calls.find(call => call.id === selection.call);
  if (call === undefined || call.result === undefined || call.failure !== undefined || call.completion_refusal !== undefined) throw new RlmReuseError('completion');
  validateReuseTranscript(origin);
  equal(target.reuse_identity, origin.reuse_identity, 'identity');
  equal(target.settings, origin.settings, 'settings');
  equal([target.parser_version, target.aggregate_version, target.components], [origin.parser_version, origin.aggregate_version, origin.components], 'tool_policy');
  equal(target.scope, origin.scope, 'scope');
  equal(target.question, call.subgoal, 'question');
  const sources = dependencies(origin, call);
  const current = target.snapshot.filter(item => call.depth === 0 || sources.some(source => source.id === item.id)).sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  equal(current, sources, 'snapshot');
  await replayRlm(workspace, selection.run);
  equal(await ledger.load(selection.run), origin, 'origin_revision');
  const subtree = new Set([call.id]);
  for (const entry of origin.calls) if (entry.parent !== undefined && subtree.has(entry.parent)) subtree.add(entry.id);
  const steps = origin.calls.filter(entry => subtree.has(entry.id)).flatMap(entry => entry.steps);
  const receipt = parseReuseProvenance({ ...selection, state_digest: digest(origin), call_digest: call.digest, scope_digest: digest(origin.scope), snapshot_digest: digest(sources), policy_digest: digest([origin.reuse_identity, origin.settings, origin.parser_version, origin.aggregate_version, origin.components]), tokens_in: steps.reduce((sum, step) => sum + (step.response?.tokens_in ?? 0), 0), tokens_out: steps.reduce((sum, step) => sum + (step.response?.tokens_out ?? 0), 0), reserved_tokens: steps.reduce((sum, step) => sum + step.reserved, 0) });
  return { receipt, answer: call.result };
}
/** Validate persisted reuse during resume/replay without model calls or native item writes. */
export async function validateReuseState(workspace: string, state: RlmState): Promise<void> {
  try {
    const receipt = parseReuseProvenance(state.reuse);
    if (state.calls.length !== 1 || state.calls[0].steps.length !== 0 || state.calls[0].failure !== undefined || state.reserved_tokens !== 0 || state.snapshot_only !== true) throw new RlmReuseError('target_state');
    const verified = await provenance(workspace, state, receipt);
    equal(receipt, verified.receipt, 'provenance');
    equal(state.calls[0].result, verified.answer, 'answer');
  } catch (error) { throw reuseFailure(error); }
}
/** Satisfy a new run from one explicitly selected original subanswer, without inference or usage duplication. */
async function prepareReuse(question: string, options: RlmReuseOptions): Promise<Awaited<ReturnType<typeof prepareRlmRun>> | RlmReuseSkipped> {
  const request = parseReuseRequest({ question, scope: options.scope ?? {}, identity: options.reuse_identity, selection: options.selection });
  const selection = request.selection;
  const reuse_identity = request.identity;
  const sourceLedger = new RlmLedger(options.workspace, options.author);
  const rows = certifyCompleteListResult(await sourceLedger.client.listAllComplete({ includeBody: true })).items;
  const row = rows.find(row => row.id === selection.run);
  const selectedRow = rows.find(row => row.id === selection.call);
  if (selectedRow !== undefined && (selectedRow.rlm_run !== selection.run || !selectedRow.tags.includes('rlm:call'))) return { status: 'skipped', reason: 'foreign', remedy: 'Select a run created by pm-rlm in this tracker' };
  if (row === undefined || row.rlm_run !== selection.run || !row.tags.includes('rlm:call')) return { status: 'skipped', reason: 'foreign', remedy: 'Select a run created by pm-rlm in this tracker' };
  const releaseSource = await sourceLedger.lease(selection.run);
  try {
    const origin = await sourceLedger.load(selection.run);
    const corpus = await readCorpus(options.workspace);
    const candidate = { ...origin, question, scope: request.scope, reuse_identity, settings: await readRlmSettings(options.workspace, options.settings), parser_version: 3 as const, aggregate_version: 2 as const, snapshot: corpus.items.filter(item => matches(item, request.scope)) };
    await provenance(options.workspace, candidate, selection);
    const prepared = await prepareRlmRun(question, { ...options, scope: request.scope, reuse_identity, reuse_selection: selection, components: origin.components }, corpus);
    return prepared;
  } finally { await releaseSource(); }
}

/** Revalidate a journaled intent inside its target lease before publishing a zero-usage checkpoint. */
export async function applyPendingReuse(ledger: RlmLedger, state: RlmState): Promise<void> {
  try {
    const selection = parseReuseSelection(state.reuse_selection);
    if (state.calls.length !== 1 || state.calls[0].steps.length !== 0 || state.reserved_tokens !== 0) throw new RlmReuseError('target_started');
    const sourceLedger = new RlmLedger(ledger.workspace);
    const unlock = await sourceLedger.lease(selection.run);
    try {
      const verified = await provenance(ledger.workspace, state, selection);
      const live = (await readCorpus(ledger.workspace)).items.filter(item => matches(item, state.scope));
      await provenance(ledger.workspace, { ...state, snapshot: live }, selection);
      Object.assign(state.calls[0], { result: verified.answer });
      Object.assign(state, { reuse: verified.receipt });
      await ledger.save(state);
    } finally { await unlock(); }
  } catch (error) { throw reuseFailure(error); }
}

/** Preserve typed remedies for SDK failures without exposing backend details. */
export async function reuseRlm(question: string, options: RlmReuseOptions): Promise<RlmReuseResult> {
  try {
    const prepared = await prepareReuse(question, options);
    if ('status' in prepared) return prepared;
    const result = await prepared.engine.run();
    assertReuseUsage(result);
    return result.reuse === undefined ? { ...result, status: 'peer_completed' } : { ...result, reuse: result.reuse, status: 'reused', model_calls: 0 };
  }
  catch (error) { throw reuseFailure(error); }
}

/** Bound command output; full answers remain available through the SDK and explicit --full. */
export function compactReuseResult(result: RlmReuseResult): Record<string, unknown> {
  if (result.status === 'skipped') return { ...result };
  assertReuseUsage(result);
  const { answer, components: _components, ...receipt } = result;
  return { ...receipt, answer_digest: blobDigest(answer), answer_bytes: Buffer.byteLength(answer), answer_preview: answer.slice(0, 160), answer_complete: answer.length <= 160 };
}
