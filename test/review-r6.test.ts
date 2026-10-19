import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { test } from 'node:test';
import { npmEnvironment } from '../scripts/environment.ts';
import { replayRlm, resumeRlm, runRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { PROTOCOL } from '../src/protocol.ts';
import { ScriptedModel, tracker } from './helpers.ts';

/** Inspect the actual tarball inventory and follow every local link from installed measurement reports. */
test('review r6 packed measurement report links resolve recursively', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'rlm-report-pack-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], { encoding: 'utf8', env: npmEnvironment(process.env) });
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const inventory = new Set((JSON.parse(packed.stdout) as { files: { path: string }[] }[])[0].files.map(file => file.path));
  const pending = ['README.md'];
  const seen = new Set<string>();
  for (const path of pending) {
    assert.ok(inventory.has(path), `Installed report target missing: ${path}`);
    if (seen.has(path) || !path.endsWith('.md')) continue;
    seen.add(path);
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (/^https?:/.test(match[1])) continue;
      pending.push(posix.normalize(posix.join(dirname(path), match[1])));
    }
  }
  assert.ok(pending.includes('eval-results-v2.json'));
  assert.ok(pending.includes('eval-results-constrained.json'));
});

/** Execution codes and exact corrective text are checked before replay or any resumed inference/write. */
for (const operation of ['replay', 'resume'] as const) test(`review r6 ${operation} rejects altered aggregate and read execution refusals`, async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Aggregate refusal fixture' });
  const actions = [
    { action: 'sum', field_expr: 'title' },
    { action: 'get', id: 'absent', fields: [] },
  ];
  const model = new ScriptedModel((_request, index) => JSON.stringify(actions[index] ?? { action: 'finish', answer: 'recovered' }));
  const result = await runRlm('Execution refusal integrity', { workspace, model });
  const ledger = new RlmLedger(workspace);
  const original = await ledger.load(result.run);
  for (const step of original.calls[0].steps.slice(0, 2)) assert.ok('refused' in (step.observation as object));
  await assert.doesNotReject(async () => { assert.deepEqual(await replayRlm(workspace, result.run), result); });
  for (const index of [0, 1]) for (const unfinished of [false, true]) for (const change of ['reason', 'code', 'missing'] as const) {
    const state = structuredClone(original);
    const observation = state.calls[0].steps[index].observation as { refused: string; reason?: string };
    if (change === 'reason') observation.reason = 'Tampered corrective prompt';
    if (change === 'code') observation.refused = 'budget';
    if (change === 'missing') delete observation.reason;
    if (unfinished) { delete state.calls[0].result; state.calls[0].steps.pop(); }
    await ledger.save(state);
    const before = await readFile(getHistoryPath(workspace, result.run));
    const noInference = new ScriptedModel(() => assert.fail('Integrity validation must precede inference'));
    await assert.rejects(operation === 'replay' ? replayRlm(workspace, result.run) : resumeRlm(workspace, result.run, noInference), { code: 'replay', message: `Recorded execution refusal differs at step ${result.run}:${index}` });
    assert.equal(noInference.requests.length, 0);
    assert.deepEqual(await readFile(getHistoryPath(workspace, result.run)), before);
  }
  const unfinished = structuredClone(original);
  delete unfinished.calls[0].result; unfinished.calls[0].steps.pop();
  await ledger.save(unfinished);
  const recovery = new ScriptedModel(request => {
    assert.ok(request.prompt.includes('Item is outside the certified scope'));
    return '{"action":"finish","answer":"recovered"}';
  });
  assert.equal((await resumeRlm(workspace, result.run, recovery)).answer, result.answer);
});

/** Earlier successful reads and reused children consume budget before the later execution refusal. */
test('review r6 execution refusal budgets follow recursive order and transcript prefixes', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'Budget fixture', description: 'x'.repeat(29000) })).item;
  const spawn = { action: 'spawn', subgoal: 'child', slice: { fragments: [], estimated_tokens: 2 } };
  const actions = [{ action: 'count' }, spawn, spawn, { action: 'get', id: item.id, fields: ['description'] }, { action: 'finish', answer: 'budget recovered' }];
  const model = new ScriptedModel(request => {
    const input = JSON.parse(request.prompt.slice(PROTOCOL.length + 1)) as { depth: number; transcript: unknown[] };
    return JSON.stringify(input.depth === 1 ? { action: 'finish', answer: 'child' } : actions[input.transcript.length]);
  });
  const result = await runRlm('Budget reconstruction', { workspace, model, settings: { budget_tokens: 30000 } });
  const ledger = new RlmLedger(workspace);
  const original = await ledger.load(result.run);
  assert.equal(original.calls.length, 2);
  assert.deepEqual(original.calls[0].steps[3].observation, { refused: 'budget', reason: 'Read exceeds remaining token budget' });
  await assert.doesNotReject(async () => { assert.deepEqual(await replayRlm(workspace, result.run), result); });
  assert.deepEqual(await resumeRlm(workspace, result.run, model), result);
  const forged = structuredClone(original);
  forged.calls[0].steps[0].observation = { refused: 'budget', reason: 'Read exceeds remaining token budget' };
  await ledger.save(forged);
  await assert.rejects(replayRlm(workspace, result.run), { code: 'replay' });
  await assert.rejects(resumeRlm(workspace, result.run, model), { code: 'replay' });
});
