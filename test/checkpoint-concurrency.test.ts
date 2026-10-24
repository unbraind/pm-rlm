import assert from 'node:assert/strict';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { RlmBlobs } from '../src/blobs.ts';
import { RlmLedger } from '../src/ledger.ts';
import { prepareRlmRun, replayRlm, resumeRlm, runRlm } from '../src/engine.ts';
import { RlmError } from '../src/errors.ts';
import { tracker, ScriptedModel } from './helpers.ts';
import type { RlmState, RlmCall } from '../src/types.ts';

const failure = { code: 'model' as const, reason: 'Execution stopped' };
const answer = '{"action":"finish","answer":"completed answer"}';

/** Build one completed native run for write-authority and CAS boundary checks. */
async function completedLedger(t: TestContext) {
  const setup = await tracker(t);
  const model = new ScriptedModel(() => answer);
  const run = await runRlm('finish', { workspace: setup.workspace, model });
  return { ...setup, run, ledger: new RlmLedger(setup.workspace), model };
}

/** Exercise every asynchronous cleanup boundary with real SDK readers and competing resume writers. */
test('cleanup resume interleavings preserve completed answer steps and token charges at every boundary', async t => {
  const { root, workspace, client } = await tracker(t);
  await assert.rejects(access(join(root, '.git')), { code: 'ENOENT' });
  const boundaries = ['lease:before', 'lease:after', 'load:before', 'load:after', 'complete:before', 'complete:after', 'unlock:before', 'unlock:after'];
  for (const boundary of boundaries) await t.test(boundary, async () => {
    const model = new ScriptedModel(() => answer);
    const child = await prepareRlmRun('finish', { workspace, model });
    let completed: RlmState;
    // Before lease acquisition, complete the initially pending run to expose the stale-read race.
    if (boundary !== 'lease:before') {
      await resumeRlm(workspace, child.run, model);
      completed = await new RlmLedger(workspace).load(child.run);
    }
    let injected = 0;
    /** Compete once at the selected boundary; an owned lease must refuse the second writer. */
    const compete = async (point: string): Promise<void> => {
      if (point !== boundary || injected !== 0) return;
      injected++;
      if (['lease:after', 'load:before', 'load:after', 'complete:before', 'complete:after', 'unlock:before'].includes(point)) {
        await assert.rejects(resumeRlm(workspace, child.run, model), { code: 'busy' });
      } else {
        await resumeRlm(workspace, child.run, model);
        completed = await new RlmLedger(workspace).load(child.run);
      }
    };
    const ledger = child.ledger;
    const lease = ledger.lease.bind(ledger);
    const load = ledger.load.bind(ledger);
    const complete = ledger.complete.bind(ledger);
    t.mock.method(ledger, 'lease', async (run: string) => {
      if (run !== child.run) return lease(run);
      await compete('lease:before');
      const unlock = await lease(run);
      await compete('lease:after');
      return async () => { await compete('unlock:before'); await unlock(); await compete('unlock:after'); };
    });
    t.mock.method(ledger, 'load', async (run: string) => { await compete('load:before'); const state = await load(run); await compete('load:after'); return state; });
    t.mock.method(ledger, 'complete', async (state: RlmState, call: RlmCall) => { await compete('complete:before'); await complete(state, call); await compete('complete:after'); });
    const cleaned = await ledger.failUnfinished(child.run, failure).catch(error => assert.fail(`Cleanup must preserve a competing completion: ${String(error)}`));
    assert.equal(injected, 1, boundary);
    const after = await new RlmLedger(workspace).load(child.run);
    assert.deepEqual(after, completed!);
    assert.equal(after.calls[0].result, 'completed answer');
    assert.deepEqual(cleaned.skipped, [child.run]);
    assert.deepEqual(cleaned.state.calls[0].steps, completed!.calls[0].steps);
    assert.equal(cleaned.state.reserved_tokens, completed!.reserved_tokens);
    assert.equal((await replayRlm(workspace, child.run)).answer, 'completed answer');
    const row = (await client.get(child.run, { depth: 'full' })).item;
    assert.equal(row.rlm_tokens_in, after.calls[0].steps[0].response!.tokens_in);
    assert.equal(row.rlm_tokens_out, after.calls[0].steps[0].response!.tokens_out);
    assert.equal(row.status, 'closed');
    assert.equal(model.requests.length, 1);
    t.mock.restoreAll();
  });
});

/** Save boundaries are reachable only for pending calls, where the lease must exclude completion. */
test('cleanup save boundaries exclude competing resume and report already terminal nested calls', async t => {
  const { workspace } = await tracker(t);
  for (const point of ['before', 'after']) {
    const model = new ScriptedModel(request => {
      const input = JSON.parse(request.prompt.split('\n').at(-1)!) as { question: string; transcript: unknown[] };
      if (input.question === 'nested') return answer;
      if (input.transcript.length === 0) return JSON.stringify({ action: 'spawn', subgoal: 'nested', slice: { fragments: [], estimated_tokens: 2 } });
      throw new RlmError('model', 'Parent inference stopped after child completion');
    });
    const child = await prepareRlmRun('finish', { workspace, model });
    await assert.rejects(child.engine.run(), { code: 'model' });
    const before = await child.ledger.load(child.run);
    assert.equal(before.calls[1].result, 'completed answer');
    const save = child.ledger.save.bind(child.ledger);
    let injected = 0;
    t.mock.method(child.ledger, 'save', async (state: RlmState) => {
      if (point === 'after') await save(state);
      await assert.rejects(resumeRlm(workspace, child.run, model), { code: 'busy' });
      injected++;
      if (point === 'before') await save(state);
    });
    const cleaned = await child.ledger.failUnfinished(child.run, failure);
    assert.equal(injected, 1);
    assert.deepEqual(cleaned.skipped, [before.calls[1].id]);
    assert.equal(cleaned.state.calls[0].failure?.code, 'model');
    assert.deepEqual(cleaned.state.calls[1], before.calls[1]);
    assert.deepEqual(cleaned.state.calls.map(call => call.steps), before.calls.map(call => call.steps));
    assert.equal(cleaned.state.reserved_tokens, before.reserved_tokens);
    assert.equal(model.requests.length, 3);
    t.mock.restoreAll();
    assert.deepEqual((await child.ledger.failUnfinished(child.run, failure)).skipped, before.calls.map(call => call.id));
  }
});

/** Every checkpoint/evidence mutation rejects stale state, including a read predating the current lease. */
test('ledger refuses pre-lease reads expired leases and superseded checkpoint writes', async t => {
  const { run, ledger } = await completedLedger(t);
  const outside = await ledger.load(run.run);
  const unlock = await ledger.lease(run.run);
  for (const operation of [() => ledger.save(outside), () => ledger.materialize(outside, outside.calls[0]), () => ledger.complete(outside, outside.calls[0])]) await assert.rejects(operation(), { code: 'busy' });
  const stale = await ledger.load(run.run);
  const current = await ledger.load(run.run);
  current.reserved_tokens++;
  await ledger.save(current);
  for (const operation of [() => ledger.save(stale), () => ledger.materialize(stale, stale.calls[0]), () => ledger.complete(stale, stale.calls[0])]) await assert.rejects(operation(), { code: 'busy' });
  await ledger.save(current);
  await unlock();
  await assert.rejects(ledger.save(current), { code: 'busy' });
  assert.deepEqual(await ledger.load(run.run), current);
});

/** Completion reads canonical saved counters rather than uncommitted caller mutations. */
test('completion materialization uses durable answer and usage and refuses nonterminal calls', async t => {
  const { workspace, client } = await tracker(t);
  const child = await prepareRlmRun('finish', { workspace, model: new ScriptedModel(() => answer) });
  const ledger = child.ledger;
  const unlock = await ledger.lease(child.run);
  try {
    const state = await ledger.load(child.run);
    await assert.rejects(ledger.complete(state, state.calls[0]), { code: 'invalid' });
    await assert.rejects(ledger.complete(state, { ...state.calls[0], id: 'absent' }), { code: 'invalid' });
  } finally { await unlock(); }
  await child.engine.run();
  const release = await ledger.lease(child.run);
  try {
    const state = await ledger.load(child.run);
    state.calls[0].result = 'unsaved stale answer';
    state.calls[0].steps[0].response!.tokens_in = 999999;
    await client.reopen(child.run, 'Exercise completion recovery');
    await ledger.complete(state, state.calls[0]);
    const row = (await client.get(child.run, { depth: 'full' })).item;
    assert.notEqual(row.rlm_tokens_in, 999999);
    assert.equal(JSON.stringify(await client.comments(child.run)).includes('unsaved stale answer'), false);
  } finally { await release(); }
  assert.ok(new RlmError('busy', 'refused') instanceof Error);
});

/** Change the real tracker after encoding to exercise the SDK's lock-held match check. */
test('SDK compare-and-set refuses a checkpoint changed between comparison and publication', async t => {
  const { workspace, client, run, ledger } = await completedLedger(t);
  const unlock = await ledger.lease(run.run);
  try {
    const state = await ledger.load(run.run);
    const competing = structuredClone(state);
    competing.reserved_tokens += 7;
    const raw = await new RlmBlobs(workspace).encode(competing);
    const encode = RlmBlobs.prototype.encode;
    t.mock.method(RlmBlobs.prototype, 'encode', async function (this: RlmBlobs, input: RlmState) {
      const encoded = await encode.call(this, input);
      await client.run('update', { id: run.run, options: { rlmState: raw } });
      return encoded;
    });
    state.reserved_tokens++;
    await assert.rejects(ledger.save(state), error => {
      assert.equal((error as { code: string }).code, 'busy', String(error));
      return true;
    });
    assert.deepEqual(await ledger.load(run.run), competing);
    t.mock.restoreAll();
  } finally { await unlock(); }
});

/** A read begun outside a lease cannot gain write authority merely by finishing inside it. */
test('load captures lease provenance before its first asynchronous read', async t => {
  const { run, ledger } = await completedLedger(t);
  const decode = RlmBlobs.prototype.decode;
  let unlock: (() => Promise<void>) | undefined;
  t.mock.method(RlmBlobs.prototype, 'decode', async function (this: RlmBlobs, raw: string) {
    unlock = await ledger.lease(run.run);
    return decode.call(this, raw);
  });
  const outside = await ledger.load(run.run);
  t.mock.restoreAll();
  try { await assert.rejects(ledger.save(outside), { code: 'busy' }); }
  finally { await unlock!(); }
});

/** Lease token replacement, removal and stale release callbacks cannot authorize writes. */
test('ledger verifies current lease token and keeps newer lease ownership on repeated release', async t => {
  const { workspace, run, ledger } = await completedLedger(t);
  const first = await ledger.lease(run.run);
  await first();
  const second = await ledger.lease(run.run);
  try {
    const current = await ledger.load(run.run);
    await first();
    await ledger.save(current);
    await assert.rejects(ledger.save(structuredClone(current)), { code: 'busy' });
    const path = join(workspace, 'runtime', `rlm-${run.run}.json`);
    const original = await readFile(path, 'utf8');
    for (const replacement of [null, '{"token":"other"}', '{']) {
      if (replacement === null) await rm(path); else await writeFile(path, replacement);
      await assert.rejects(ledger.save(current), { code: replacement === '{' ? 'incomplete' : 'busy' });
      await writeFile(path, original);
    }
    const uncreated = structuredClone(current);
    uncreated.run = 'uncreated-run'; uncreated.calls[0].id = uncreated.run;
    await assert.rejects(ledger.materialize(uncreated, uncreated.calls[0]), { code: 'busy' });
  } finally { await second(); }
});
