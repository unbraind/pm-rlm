import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { acquireLock, certifyCompleteListResult, PmClient, readFileIfExists, readSettings, removeFileIfExists, writeFileAtomic } from '@unbrained/pm-cli/sdk';
import { assertLedgerPrivacy, estimateTokens, integer, record, RlmError, sdkRead, text } from './errors.ts';
import { parseFilter } from './environment.ts';
import { parseSlice } from './protocol.ts';
import { validateRlmSettings } from './settings.ts';
import type { ModelResponse, RlmCall, RlmSettings, RlmSlice, RlmState, RlmStep } from './types.ts';
import type { SchemaFieldDefinition } from '@unbrained/pm-cli/sdk/authoring';

/** Registered fields shared by SDK-created schemas and extension activation. */
export const RLM_FIELDS: SchemaFieldDefinition[] = [
  ...['rlm_run', 'rlm_model', 'rlm_prompt_digest', 'rlm_state'].map(name => ({ name, type: 'string' as const, optional: true })),
  ...['rlm_depth', 'rlm_tokens_in', 'rlm_tokens_out'].map(name => ({ name, type: 'number' as const, optional: true })),
];
/** Hash the exact model, subgoal, scope fragments and limits used by a logical call. */
export function promptDigest(subgoal: string, slice: RlmSlice, settings: RlmSettings): string {
  return createHash('sha256').update(JSON.stringify({ subgoal, slice, settings })).digest('hex');
}
/** Atomically charge once per logical model step; callers persist the enclosing checkpoint before inference. */
export function reserveStep(state: RlmState, call: RlmCall, prompt: string): RlmStep {
  const charge = estimateTokens(prompt) + state.settings.output_tokens * 16;
  if (estimateTokens(prompt) + state.settings.output_tokens > state.settings.context_tokens) throw new RlmError('budget', 'Model prompt exceeds configured context');
  if (charge > state.settings.budget_tokens - state.reserved_tokens) throw new RlmError('budget', 'Model step exceeds remaining run budget');
  const step: RlmStep = { prompt, reserved: charge };
  state.reserved_tokens += charge;
  call.steps.push(step);
  return step;
}
/** Settle once in memory; the caller atomically checkpoints the response and released allowance together. */
export function settleStep(state: RlmState, step: RlmStep, response: ModelResponse): void {
  if (step.settled === true) return;
  const actual = response.tokens_in + response.tokens_out;
  if (!Number.isSafeInteger(actual) || actual < 0 || actual > step.reserved) throw new RlmError('model', 'Model usage exceeds its reservation');
  state.reserved_tokens -= step.reserved - actual;
  step.reserved = actual;
  step.response = response;
  step.settled = true;
}
/** SDK-only ledger writes, single-writer runtime lease and idempotent call materialization. */
export class RlmLedger {
  /** Native client bound to this tracker. */
  readonly client: PmClient;
  /** Explicit tracker root; never serialized into run state. */
  readonly workspace: string;
  private readonly author: string;
  /** Bind every mutation to the supplied tracker and an attributable author. */
  constructor(workspace: string, author = 'pm-rlm') {
    this.workspace = workspace; this.author = author;
    this.client = new PmClient({ pmRoot: workspace, author, noExtensions: true });
  }
  /** Persist package schema through native SDK schema mutations. */
  async registerFields(): Promise<void> {
    const registered = (await sdkRead(() => this.client.schemaListFields())).fields;
    for (const field of RLM_FIELDS) {
      const previous = registered.find(entry => entry.key === field.name);
      if (previous !== undefined && previous.type !== field.type) throw new RlmError('invalid', 'Incompatible existing rlm schema field');
      if (previous === undefined) await this.client.schemaAddField(field.name, { type: field.type, description: 'Recursive model ledger data', author: this.author });
    }
  }
  /** Allocate a canonical SDK id before creating the root call. */
  async newRunId(): Promise<string> {
    const settings = await sdkRead(() => readSettings(this.workspace));
    return `${settings.id_prefix}rlm-${randomUUID().replaceAll('-', '')}`;
  }
  /** Read a certified full corpus to recover the root checkpoint without compact projections. */
  async load(run: string): Promise<RlmState> {
    const corpus = await sdkRead(async () => certifyCompleteListResult(await this.client.listAllComplete({ includeBody: true })));
    const root = corpus.items.find(item => item.id === run);
    if (root === undefined || typeof root.rlm_state !== 'string') throw new RlmError('invalid', 'Run checkpoint was not found');
    try {
      const decoded = record(JSON.parse(root.rlm_state));
      if (decoded.version !== 1 || decoded.run !== run || !Array.isArray(decoded.calls) || decoded.calls.length === 0) throw new Error('Invalid checkpoint');
      if (decoded.parser_version !== undefined && ![1, 2, 3].includes(decoded.parser_version as number)) throw new Error('Invalid parser version');
      validateRlmSettings(decoded.settings);
      text(decoded.question); parseFilter(decoded.scope); record(decoded.certificate);
      integer(decoded.reserved_tokens, 0);
      if (!Array.isArray(decoded.snapshot)) throw new Error('Invalid snapshot');
      for (const item of decoded.snapshot) text(record(item).id);
      for (const entry of decoded.calls) {
        const call = record(entry);
        text(call.id); integer(call.depth, 0, 32); text(call.subgoal); text(call.digest); parseSlice(call.slice);
        if (call.parent !== undefined) text(call.parent);
        if (call.result !== undefined && typeof call.result !== 'string') throw new Error('Invalid result');
        if (call.failure !== undefined && !['budget', 'depth', 'calls', 'scope', 'invalid', 'incomplete', 'model', 'busy', 'replay'].includes(text(record(call.failure).code))) throw new Error('Invalid refusal');
        if (!Array.isArray(call.steps)) throw new Error('Invalid steps');
        for (const entry of call.steps) {
          const step = record(entry);
          text(step.prompt); integer(step.reserved, 0);
          if (step.settled !== undefined && (step.settled !== true || step.response === undefined)) throw new Error('Invalid settlement');
          if (step.response !== undefined) {
            const response = record(step.response);
            if (typeof response.text !== 'string') throw new Error('Invalid response text');
            integer(response.tokens_in, 0); integer(response.tokens_out, 0);
          }
        }
      }
      return decoded as unknown as RlmState;
    } catch { throw new RlmError('incomplete', 'Run checkpoint is invalid'); }
  }
  /** Save reservations, model outputs, observations and completed digests in one atomic SDK item update. */
  async save(state: RlmState): Promise<void> {
    assertLedgerPrivacy(state, this.workspace, state.settings.key_env);
    await this.client.run('update', { id: state.run, options: { rlmState: JSON.stringify(state), message: 'Checkpoint recursive run' } });
  }
  /** Create a deterministic call item, or reuse its crash-surviving SDK write. */
  async materialize(state: RlmState, call: RlmCall): Promise<void> {
    assertLedgerPrivacy({ state, call }, this.workspace, state.settings.key_env);
    const corpus = await sdkRead(async () => certifyCompleteListResult(await this.client.listAllComplete()));
    if (corpus.items.some(item => item.id === call.id)) return;
    await this.client.run('create', { options: { id: call.id, title: call.depth === 0 ? 'RLM root call' : `RLM sub-call ${call.depth}`, type: 'Task', status: 'in_progress', tags: 'rlm:call', parent: call.parent, description: call.subgoal, allowDuplicate: true,
      rlmRun: state.run, rlmDepth: call.depth, rlmModel: state.settings.model, rlmPromptDigest: call.digest, rlmTokensIn: 0, rlmTokensOut: 0,
      ...(call.depth === 0 ? { rlmState: JSON.stringify(state) } : {}),
    } });
    await this.client.claim(call.id);
  }
  /** Repair completion evidence after a crash without repeating model inference or comments. */
  async complete(state: RlmState, call: RlmCall): Promise<void> {
    assertLedgerPrivacy(call, this.workspace, state.settings.key_env);
    await this.materialize(state, call);
    await this.client.comments(call.id, { add: call.failure === undefined ? `RLM result:\n${call.result}` : `RLM refusal:\n${JSON.stringify(call.failure)}`, ifAbsent: true });
    const corpus = await sdkRead(async () => certifyCompleteListResult(await this.client.listAllComplete()));
    const row = corpus.items.find(item => item.id === call.id)!;
    if (row.status !== 'closed') {
      await this.client.run('update', { id: call.id, options: {
        rlmTokensIn: call.steps.reduce((sum, step) => sum + (step.response?.tokens_in ?? 0), 0),
        rlmTokensOut: call.steps.reduce((sum, step) => sum + (step.response?.tokens_out ?? 0), 0),
      } });
      await this.client.close(call.id, 'Call terminated; evidence recorded', { validateClose: 'off' });
    }
    await this.client.release(call.id);
  }
  /** Acquire a process-owned lease under a short SDK lock; dead owners are resumable. */
  async lease(run: string): Promise<() => Promise<void>> {
    if (!/^[a-zA-Z0-9_-]+$/.test(run)) throw new RlmError('invalid', 'Invalid run id');
    const unlock = await acquireLock(this.workspace, `rlm-lease-${run}`, 60, this.author, false, false, 1000);
    const path = join(this.workspace, 'runtime', `rlm-${run}.json`);
    const token = randomUUID();
    try {
      const raw = await sdkRead(() => readFileIfExists(path));
      if (raw !== null) {
        const owner = await sdkRead(() => record(JSON.parse(raw)));
        const pid = integer(owner.pid, 1);
        let alive = true;
        try { process.kill(pid, 0); } catch (error) { alive = record(error).code !== 'ESRCH'; }
        if (alive) throw new RlmError('busy', 'Run already has a live executor');
      }
      await writeFileAtomic(path, JSON.stringify({ pid: process.pid, token }));
    } finally { await unlock(); }
    return async () => {
      const current = await sdkRead(() => readFileIfExists(path));
      if (current !== null && (await sdkRead(() => record(JSON.parse(current)))).token === token) await removeFileIfExists(path);
    };
  }
}
