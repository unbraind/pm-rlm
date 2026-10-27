import { parseReuseIdentity, parseReuseSelection, parseReuseProvenance } from './reuse-contract.ts';
import { parseComponents } from './evidence.ts';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { RlmBlobs } from './blobs.ts';
import { resolveRuntimeStatusRegistry, commitItemMutations, mutateItem, acquireLock, certifyCompleteListResult, getHistoryPath, PmClient, readHistoryEntries, verifyHistoryEntries, readFileIfExists, readSettings, removeFileIfExists, resolveTransactionSchema, resolveItemTypeRegistry, writeFileAtomic } from '@unbrained/pm-cli/sdk';
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
export function reserveStep(state: Pick<RlmState, 'settings' | 'reserved_tokens'>, call: RlmCall, prompt: string): RlmStep {
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
/** Atomic SDK manifests, immutable payloads, process-owned leases and idempotent call materialization. */
export class RlmLedger {
  /** Native client bound to this tracker. */
  readonly client: PmClient;
  /** Explicit tracker root; never serialized into run state. */
  readonly workspace: string;
  private readonly author: string;
  private readonly leases = new Map<string, string>();
  private readonly reads = new WeakMap<RlmState, { lease: string | undefined; checkpoint: string }>();
  private readonly versions = new WeakMap<RlmState, number>();
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
  /** Recover a checkpoint through certified SDK reads; optional native history reads never grant write authority. */
  async load(run: string, at?: string): Promise<RlmState> {
    const lease = this.leases.get(run);
    const version = (await sdkRead(() => readHistoryEntries(getHistoryPath(this.workspace, run), run))).length;
    // Historical manifests pin every committed version, including one read before a concurrent save.
    const blobs = new RlmBlobs(this.workspace);
    const corpus = await sdkRead(async () => certifyCompleteListResult(await this.client.listAllComplete({ includeBody: true })));
    const root = at === undefined ? corpus.items.find(item => item.id === run) : (await sdkRead(() => this.client.get(run, { at, fields: 'rlm_state' }))).item;
    if (root === undefined || typeof root.rlm_state !== 'string') throw new RlmError('invalid', 'Run checkpoint was not found');
    try {
      const decoded = await blobs.decode(root.rlm_state);
      if (decoded.version !== 1 || decoded.run !== run || !Array.isArray(decoded.calls) || decoded.calls.length === 0) throw new Error('Invalid checkpoint');
      if (decoded.parser_version !== undefined && ![1, 2, 3].includes(decoded.parser_version as number)) throw new Error('Invalid parser version');
      if (decoded.aggregate_version !== undefined && ![1, 2].includes(decoded.aggregate_version as number)) throw new Error('Invalid aggregate version');
      validateRlmSettings(decoded.settings);
      if (decoded.reuse_identity !== undefined) parseReuseIdentity(decoded.reuse_identity);
      if (decoded.reuse_selection !== undefined) parseReuseSelection(decoded.reuse_selection);
      if (decoded.reuse !== undefined) parseReuseProvenance(decoded.reuse);
      if (decoded.components !== undefined) parseComponents(decoded.components);
      text(decoded.question); parseFilter(decoded.scope); record(decoded.certificate);
      integer(decoded.reserved_tokens, 0);
      if (decoded.snapshot_only !== undefined && decoded.snapshot_only !== true) throw new Error('Invalid immutable boundary flag');
      if (!Array.isArray(decoded.snapshot)) throw new Error('Invalid snapshot');
      for (const item of decoded.snapshot) text(record(item).id);
      for (const entry of decoded.calls) {
        const call = record(entry);
        text(call.id); integer(call.depth, 0, 32); text(call.subgoal); text(call.digest); parseSlice(call.slice);
        if (call.parent !== undefined) text(call.parent);
        if (call.result !== undefined && typeof call.result !== 'string') throw new Error('Invalid result');
        if (call.failure !== undefined && !['budget', 'depth', 'calls', 'scope', 'invalid', 'incomplete', 'model', 'busy', 'replay', 'evidence'].includes(text(record(call.failure).code))) throw new Error('Invalid refusal');
        if (call.failure !== undefined && record(call.failure).reason !== undefined) text(record(call.failure).reason);
        if (call.completion_refusal !== undefined) {
          const refusal = record(call.completion_refusal);
          if (!['budget', 'depth', 'calls', 'scope', 'invalid', 'incomplete', 'model', 'busy', 'replay', 'evidence'].includes(text(refusal.code))) throw new Error('Invalid completion refusal');
          text(refusal.reason);
        }
        for (const failure of [call.failure, call.completion_refusal]) {
          if (failure === undefined) continue;
          const refusal = record(failure);
          if (refusal.remedy !== undefined && (refusal.code !== 'evidence' || typeof refusal.remedy !== 'string')) throw new Error('Invalid refusal remedy');
        }
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
      // Preserve by-value JSON semantics even when multiple references share a cached payload.
      const state = JSON.parse(JSON.stringify(decoded)) as RlmState;
      if (at === undefined && lease !== undefined && (await readHistoryEntries(getHistoryPath(this.workspace, run), run)).length !== version) throw new RlmError('busy', 'Run changed while loading; reload inside the run lease');
      this.versions.set(state, version);
      if (at === undefined) this.reads.set(state, { lease, checkpoint: root.rlm_state });
      return state;
    } catch (error) { if (error instanceof RlmError && error.code === 'busy') throw error; throw new RlmError('incomplete', 'Run checkpoint is invalid'); }
  }
  /** Save reservations, model outputs, observations and completed digests in one atomic SDK item update. */
  async save(state: RlmState): Promise<void> {
    assertLedgerPrivacy(state, this.workspace, state.settings.key_env);
    await this.storage(async blobs => {
      const expected = await this.assertCurrent(state);
      const checkpoint = await blobs.encode(state);
      const settings = await readSettings(this.workspace);
      const schema = await resolveTransactionSchema(this.workspace, settings);
      const hydrated = { ...settings, schema: schema.schema, item_types: { definitions: [...settings.item_types.definitions, ...schema.typeDefinitionsFromFile] } };
      let version = this.versions.get(state)!;
      await mutateItem({ pmRoot: this.workspace, settings: hydrated, id: state.run, op: 'update', author: this.author, message: 'Checkpoint recursive run', skipNoop: true, typeToFolder: resolveItemTypeRegistry(hydrated).type_to_folder,
        mutate: async document => {
          const current = (await readHistoryEntries(getHistoryPath(this.workspace, state.run), state.run)).length;
          if (document.metadata.rlm_state !== expected || document.metadata.rlm_run !== state.run || !document.metadata.tags.includes('rlm:call') || document.metadata.parent !== state.calls[0].parent || current !== version) throw new RlmError('busy', 'Stale checkpoint refused by SDK history compare-and-set');
          if (document.metadata.rlm_state === checkpoint) return { changedFields: [] };
          document.metadata.rlm_state = checkpoint;
          version = current + 1;
          return { changedFields: ['rlm_state'] };
        },
      });
      this.versions.set(state, version);
      this.reads.set(state, { lease: this.leases.get(state.run), checkpoint });
    });
  }
  /** Create a deterministic call item, or reuse its crash-surviving SDK write. */
  async materialize(state: RlmState, call: RlmCall): Promise<void> {
    assertLedgerPrivacy({ state, call }, this.workspace, state.settings.key_env);
    await this.storage(async blobs => {
      const corpus = await sdkRead(async () => certifyCompleteListResult(await this.client.listAllComplete()));
      if (corpus.items.some(item => item.id === call.id)) { await this.assertCurrent(state); return; }
      if (call.depth !== 0) await this.assertCurrent(state);
      else if (!this.leases.has(state.run)) throw new RlmError('busy', 'Run creation requires its lease');
      const checkpoint = call.depth === 0 ? await blobs.encode(state) : undefined;
      const statuses = resolveRuntimeStatusRegistry((await readSettings(this.workspace)).schema);
      await this.client.run('create', { options: { id: call.id, title: call.depth === 0 ? 'RLM root call' : `RLM sub-call ${call.depth}`, type: 'Task', status: statuses.in_progress_status, tags: 'rlm:call', parent: call.parent, description: call.subgoal, allowDuplicate: true,
        rlmRun: state.run, rlmDepth: call.depth, rlmModel: state.settings.model, rlmPromptDigest: call.digest, rlmTokensIn: 0, rlmTokensOut: 0,
        ...(checkpoint === undefined ? {} : { rlmState: checkpoint }),
      } });
      await this.client.claim(call.id);
      if (checkpoint !== undefined) {
        this.versions.set(state, (await readHistoryEntries(getHistoryPath(this.workspace, state.run), state.run)).length);
        this.reads.set(state, { lease: this.leases.get(state.run), checkpoint });
      }
    });
  }
  /** Repair completion evidence after a crash without repeating model inference or comments. */
  async complete(snapshot: RlmState, requestedCall: RlmCall): Promise<void> {
    assertLedgerPrivacy(requestedCall, this.workspace, snapshot.settings.key_env);
    await this.assertCurrent(snapshot, false);
    const state = await this.load(snapshot.run);
    const call = state.calls.find(entry => entry.id === requestedCall.id);
    if (call === undefined || (call.result === undefined && call.failure === undefined)) throw new RlmError('invalid', 'Completion requires a terminal checkpoint call');
    await this.materialize(state, call);
    await this.client.comments(call.id, { add: call.failure === undefined ? `RLM result:\n${call.result}` : `RLM refusal:\n${JSON.stringify(call.failure)}`, ifAbsent: true });
    const corpus = await sdkRead(async () => certifyCompleteListResult(await this.client.listAllComplete()));
    const row = corpus.items.find(item => item.id === call.id)!;
    const statuses = resolveRuntimeStatusRegistry((await readSettings(this.workspace)).schema);
    if (!statuses.terminal_statuses.has(row.status)) {
      await commitItemMutations({ pmRoot: this.workspace, author: this.author, transactionId: `rlm-usage-${randomUUID()}`, mutations: [{ op: 'update', id: call.id,
        match: { key: 'updated_at', value: row.updated_at },
        options: {
          rlmTokensIn: call.steps.reduce((sum, step) => sum + (step.response?.tokens_in ?? 0), 0),
          rlmTokensOut: call.steps.reduce((sum, step) => sum + (step.response?.tokens_out ?? 0), 0),
        },
      }] });
      await this.client.close(call.id, 'Call terminated; evidence recorded', { validateClose: 'off' });
    }
    await this.client.release(call.id);
    const version = (await readHistoryEntries(getHistoryPath(this.workspace, state.run), state.run)).length;
    this.versions.set(snapshot, version);
    this.versions.set(state, version);
  }
  /** Refuse snapshots read outside this lease or superseded by another checkpoint publication. */
  private async assertCurrent(state: RlmState, checkVersion = true): Promise<string> {
    const corpus = await sdkRead(async () => certifyCompleteListResult(await this.client.listAllComplete({ includeBody: true })));
    const expected = this.reads.get(state);
    const token = this.leases.get(state.run);
    const root = corpus.items.find(item => item.id === state.run);
    const raw = await sdkRead(() => readFileIfExists(join(this.workspace, 'runtime', `rlm-${state.run}.json`)));
    const owner = raw === null ? undefined : await sdkRead(() => record(JSON.parse(raw)));
    if (token === undefined || expected?.lease !== token || owner?.token !== token || root?.rlm_state !== expected.checkpoint || root.rlm_run !== state.run || !root.tags.includes('rlm:call') || root.parent !== state.calls[0].parent) throw new RlmError('busy', 'Stale checkpoint refused; reload inside the run lease');
    if (checkVersion && (await readHistoryEntries(getHistoryPath(this.workspace, state.run), state.run)).length !== this.versions.get(state)) throw new RlmError('busy', 'Checkpoint history advanced; reload inside the run lease');
    return expected.checkpoint;
  }
  /** Mark only unfinished calls failed; preserve and report completed or previously failed calls. */
  async failUnfinished(run: string, failure: NonNullable<RlmCall['failure']>): Promise<{ state: RlmState; skipped: string[] }> {
    const unlock = await this.lease(run);
    try {
      const state = await this.load(run);
      const skipped: string[] = [];
      for (const call of state.calls) {
        if (call.result !== undefined || call.failure !== undefined) skipped.push(call.id);
        else call.failure = { ...failure };
      }
      if (skipped.length !== state.calls.length) await this.save(state);
      for (const call of state.calls) await this.complete(state, call);
      return { state, skipped };
    } finally { await unlock(); }
  }
  /** Serialize publication and collection across all runs in this non-git tracker. */
  private async storage<T>(operation: (blobs: RlmBlobs) => Promise<T>): Promise<T> {
    const deadline = Date.now() + 60000;
    for (;;) {
      let unlock: () => Promise<void>;
      try { unlock = await this.lease('__blob_store'); }
      catch (error) {
        if (!(error instanceof RlmError) || error.code !== 'busy' || Date.now() >= deadline) throw error;
        await new Promise(resolve => { setTimeout(resolve, 25); });
        continue;
      }
      try { return await operation(new RlmBlobs(this.workspace)); }
      finally { await unlock(); }
    }
  }
  /** Collect unreachable payloads while retaining current and verified historical checkpoint references. */
  async gc(): Promise<{ removed: number; bytes: number }> {
    return this.storage(async blobs => sdkRead(async () => {
      const corpus = certifyCompleteListResult(await this.client.listAllComplete({ includeBody: true }));
      for (const item of corpus.items) if (typeof item.rlm_state === 'string') await blobs.decode(item.rlm_state);
      const streams = await readdir(join(this.workspace, 'history'));
      for (const name of streams) {
        if (!name.endsWith('.jsonl')) continue;
        const id = name.slice(0, -6);
        const history = await readHistoryEntries(getHistoryPath(this.workspace, id), id);
        if (!verifyHistoryEntries(history).ok) throw new RlmError('incomplete', 'History chain is invalid; collection refused');
        for (const entry of history) for (const patch of entry.patch) {
          if (patch.path === '/metadata/rlm_state' && 'value' in patch && typeof patch.value === 'string') await blobs.decode(patch.value);
        }
      }
      return blobs.sweep();
    }));
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
    this.leases.set(run, token);
    return async () => {
      const releaseLock = await acquireLock(this.workspace, `rlm-lease-${run}`, 60, this.author, false, false, 1000);
      try {
        const current = await sdkRead(() => readFileIfExists(path));
        if (current !== null && (await sdkRead(() => record(JSON.parse(current)))).token === token) await removeFileIfExists(path);
        if (this.leases.get(run) === token) this.leases.delete(run);
      } finally { await releaseLock(); }
    };
  }
}
