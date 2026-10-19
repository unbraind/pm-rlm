import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { certifyCompleteListResult } from '@unbrained/pm-cli/sdk';
import { RlmLedger, promptDigest, reserveStep } from '../src/ledger.ts';
import { RlmEngine, replayRlm, runRlm } from '../src/engine.ts';
import { estimateTokens, RlmError } from '../src/errors.ts';
import type { RlmResult } from '../src/types.ts';
import { ScriptedModel, tracker, crashProcess, killAtCheckpoint } from './helpers.ts';

/** Kill exactly between completed child persistence and parent observation persistence. */
test('SIGKILL then resume reuses completed digest with no repeated completed inference and identical total charge', async t => {
  const { workspace, root, client } = await tracker(t);
  const log = join(root, 'requests.jsonl');
  const child = crashProcess('crash-worker.ts', workspace, 'kill', log);
  const message = await killAtCheckpoint(t, child);
  const ledger = new RlmLedger(workspace, 'rlm-test');
  const interrupted = await ledger.load(message.run);
  assert.equal(interrupted.calls[1].result, '7');
  assert.equal(interrupted.calls[0].steps[0].observation, undefined);
  await assert.rejects(replayRlm(workspace, message.run), { code: 'replay', message: 'Recorded spawn step has no completed observation' });
  const resumed = crashProcess('crash-worker.ts', workspace, 'resume', log, message.run);
  const [reply] = await once(resumed, 'message') as [{ result: RlmResult }];
  await once(resumed, 'exit');
  const requests = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(requests.filter(value => value === 'first').length, 1);
  assert.equal(requests.filter(value => value === 'second').length, 1);
  assert.equal(reply.result.answer, '7+11');
  assert.equal((await replayRlm(workspace, message.run)).answer, '7+11');
  const baseline = crashProcess('crash-worker.ts', workspace, 'baseline', join(root, 'baseline.jsonl'));
  const [normal] = await once(baseline, 'message') as [{ result: RlmResult }];
  await once(baseline, 'exit');
  assert.equal(reply.result.answer, normal.result.answer);
  assert.equal(reply.result.reserved_tokens, normal.result.reserved_tokens);
  const state = await ledger.load(message.run);
  const rows = certifyCompleteListResult(await client.listAllComplete()).items.filter(item => item.rlm_run === message.run);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(item => [item.id, item.parent, item.rlm_depth]).sort(), state.calls.map(call => [call.id, call.parent, call.depth]).sort());
  assert.ok(rows.every(item => item.status === 'closed' && item.assignee === undefined));
});

/** Pure reservation boundaries are backed by real SDK-created run state. */
test('model reservation refuses one below equality and never appends a partial reservation', async t => {
  const { workspace } = await tracker(t);
  const run = await runRlm('reserve', { workspace, model: new ScriptedModel(() => '{"action":"finish","answer":"ok"}') });
  const state = await new RlmLedger(workspace).load(run.run);
  const call = state.calls[0];
  call.steps = []; state.reserved_tokens = 0;
  const prompt = 'exact';
  const required = estimateTokens(prompt) + state.settings.output_tokens * 16;
  state.settings.budget_tokens = required - 1;
  assert.throws(() => reserveStep(state, call, prompt), { code: 'budget' });
  assert.equal(state.reserved_tokens, 0); assert.equal(call.steps.length, 0);
  state.settings.budget_tokens = required;
  assert.equal(reserveStep(state, call, prompt).reserved, required);
  assert.equal(state.reserved_tokens, required);
  state.settings.context_tokens = 1;
  assert.throws(() => reserveStep(state, call, prompt), { code: 'budget' });
});

/** Limits are checked before child creation; recorded refusals still consume model steps. */
test('depth and call limits, digest reuse and scope checks operate on a real ledger', async t => {
  const { workspace } = await tracker(t);
  const run = await runRlm('limits', { workspace, model: new ScriptedModel(() => '{"action":"finish","answer":"root"}') });
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(run.run);
  const model = new ScriptedModel(() => '{"action":"finish","answer":"child"}');
  const engine = new RlmEngine(ledger, state, model);
  assert.deepEqual(engine.snapshot(), state);
  const empty = { fragments: [], estimated_tokens: 2 };
  state.settings.max_depth = 0;
  await assert.rejects(engine.spawn(state.run, 'subgoal', empty), { code: 'depth' });
  state.settings.max_depth = 2; state.settings.max_calls = 1;
  await assert.rejects(engine.spawn(state.run, 'subgoal', empty), { code: 'calls' });
  state.settings.max_calls = 3;
  assert.equal(await engine.spawn(state.run, 'subgoal', empty), 'child');
  assert.equal(await engine.spawn(state.run, 'subgoal', empty), 'child');
  assert.equal(model.requests.length, 1);
  assert.equal(state.calls[1].digest, promptDigest('subgoal', empty, state.settings));
  await assert.rejects(engine.spawn('absent', 'subgoal', empty), { code: 'scope' });
  await assert.rejects(engine.spawn(state.run, 'leak', { fragments: [{ id: 'absent', start: 0, end: 6, text: 'secret' }], estimated_tokens: estimateTokens([{ id: 'absent', start: 0, end: 6, text: 'secret' }]) }), { code: 'scope' });
  assert.ok(new RlmError('depth', 'depth') instanceof Error);
});
