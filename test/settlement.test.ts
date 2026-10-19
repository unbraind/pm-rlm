import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RlmLedger, settleStep } from '../src/ledger.ts';
import { runRlm, resumeRlm, replayRlm, treeRlm } from '../src/engine.ts';
import { estimateTokens } from '../src/errors.ts';
import type { RlmResult } from '../src/types.ts';
import { tracker, crashProcess, killAtCheckpoint } from './helpers.ts';

import { smallModel } from './settlement-model.ts';

/** Actual charges fit while twenty accumulated worst-case reservations cannot. */
test('twenty sequential steps settle unused reservations under the actual-usage budget', async t => {
  const { workspace } = await tracker(t);
  const result = await runRlm('settlement', { workspace, model: smallModel, settings: { budget_tokens: 16000 } }).catch(error => assert.fail(`Twenty small steps must fit actual usage: ${String(error)}`));
  const ledger = new RlmLedger(workspace); const state = await ledger.load(result.run);
  const steps = state.calls[0].steps;
  assert.equal(steps.length, 20); assert.equal(result.answer, 'settled');
  assert.ok(steps.reduce((sum, step) => sum + estimateTokens(step.prompt) + state.settings.output_tokens * 16, 0) > 16000);
  assert.ok(steps.every(step => step.settled === true && step.reserved === 44));
  assert.equal(result.reserved_tokens, 880); assert.equal(result.tokens_in + result.tokens_out, 880);
  const tree = await treeRlm(workspace, result.run) as { calls: { reserved_tokens: number; used_tokens: number }[] };
  assert.equal(tree.calls[0].reserved_tokens, 880); assert.equal(tree.calls[0].used_tokens, 880);
  settleStep(state, steps[0], steps[0].response!);
  assert.equal(state.reserved_tokens, 880);
  assert.equal((await replayRlm(workspace, result.run)).answer, 'settled');
  const legacy = structuredClone(state);
  for (const step of legacy.calls[0].steps) {
    const original = estimateTokens(step.prompt) + legacy.settings.output_tokens * 16;
    legacy.reserved_tokens += original - step.reserved; step.reserved = original; delete step.settled;
  }
  await ledger.save(legacy);
  assert.equal((await resumeRlm(workspace, result.run, smallModel)).reserved_tokens, 880);
  const bad = structuredClone(state); bad.calls[0].steps[0].settled = undefined;
  const step = bad.calls[0].steps[0];
  for (const [tokens_in, tokens_out] of [[Number.MAX_SAFE_INTEGER, 1], [-1, 0], [step.reserved + 1, 0]]) assert.throws(() => settleStep(bad, step, { text: '', tokens_in, tokens_out }), { code: 'model' });
});

/** A killed pending inference retains one worst-case reservation and settles exactly once on resume. */
test('pre-response SIGKILL resumes twenty settled steps without a double charge', async t => {
  const { workspace, root } = await tracker(t);
  const log = join(root, 'requests.jsonl');
  const child = crashProcess('settlement-worker.ts', workspace, 'kill', log);
  const message = await killAtCheckpoint(t, child);
  const ledger = new RlmLedger(workspace);
  const pending = await ledger.load(message.run);
  assert.equal(pending.calls[0].steps.length, 1);
  assert.equal(pending.calls[0].steps[0].response, undefined); assert.equal(pending.calls[0].steps[0].settled, undefined);
  assert.equal(pending.reserved_tokens, pending.calls[0].steps[0].reserved);
  const tree = await treeRlm(workspace, message.run) as { calls: { reserved_tokens: number; used_tokens: number }[] };
  assert.equal(tree.calls[0].reserved_tokens, pending.reserved_tokens); assert.equal(tree.calls[0].used_tokens, 0);
  const resumed = crashProcess('settlement-worker.ts', workspace, 'resume', log, message.run);
  const [reply] = await once(resumed, 'message') as [{ result: RlmResult; error?: unknown }];
  await once(resumed, 'exit'); assert.equal(reply.error, undefined);
  assert.equal(reply.result.answer, 'settled'); assert.equal(reply.result.reserved_tokens, 880);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 21);
  const baseline = crashProcess('settlement-worker.ts', workspace, 'baseline', join(root, 'baseline.jsonl'));
  const [normal] = await once(baseline, 'message') as [{ result: RlmResult; error?: unknown }];
  await once(baseline, 'exit'); assert.equal(normal.error, undefined);
  assert.equal(reply.result.reserved_tokens, normal.result.reserved_tokens);
  assert.equal(reply.result.answer, normal.result.answer);
  assert.equal((await replayRlm(workspace, message.run)).answer, 'settled');
});
