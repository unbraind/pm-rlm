import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { test } from 'node:test';
import { npmEnvironment } from '../scripts/environment.ts';
import { replayRlm, resumeRlm, runRlm } from '../src/engine.ts';
import { estimateTokens } from '../src/errors.ts';
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

/** Legacy responses release reservations before refusal checks; only v1 may omit a reason. */
for (const operation of ['replay', 'resume'] as const) test(`review r7 ${operation} preserves legacy execution refusals and unsettled usage`, async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'Legacy budget fixture', description: 'x'.repeat(29000) })).item;
  const actions = [
    ...Array.from({ length: 3 }, () => ({ action: 'get', id: item.id, fields: ['title'] })),
    { action: 'get', id: item.id, fields: ['description'] },
    { action: 'finish', answer: 'legacy recovered' },
  ];
  const model = new ScriptedModel((_request, index) => JSON.stringify(actions[index]));
  const result = await runRlm('Legacy budget refusal', { workspace, model, settings: { budget_tokens: 30000 } });
  const ledger = new RlmLedger(workspace);
  const original = await ledger.load(result.run);
  assert.deepEqual(original.calls[0].steps[3].observation, { refused: 'budget', reason: 'Read exceeds remaining token budget' });
  for (const version of [undefined, 1] as const) for (const codeOnly of [false, true]) {
    const legacy = structuredClone(original);
    if (version === undefined) delete legacy.parser_version; else legacy.parser_version = version;
    for (const step of legacy.calls[0].steps) {
      const reservation = estimateTokens(step.prompt) + legacy.settings.output_tokens * 16;
      legacy.reserved_tokens += reservation - step.reserved;
      step.reserved = reservation;
      delete step.settled;
    }
    assert.ok(legacy.calls[0].steps.slice(0, 4).reduce((sum, step) => sum + step.reserved, 0) > legacy.settings.budget_tokens, 'Old reservations would exhaust the budget before the recorded refusal');
    if (codeOnly) delete (legacy.calls[0].steps[3].observation as { reason?: string }).reason;
    await ledger.save(legacy);
    const before = await readFile(getHistoryPath(workspace, result.run));
    const noInference = new ScriptedModel(() => assert.fail('Completed legacy steps must not repeat inference'));
    await assert.doesNotReject(async () => {
      const recovered = operation === 'replay' ? await replayRlm(workspace, result.run) : await resumeRlm(workspace, result.run, noInference);
      assert.deepEqual(recovered, { ...result, reserved_tokens: operation === 'replay' ? legacy.reserved_tokens : result.reserved_tokens });
    });
    assert.equal(noInference.requests.length, 0);
    if (operation === 'replay') {
      assert.deepEqual(await readFile(getHistoryPath(workspace, result.run)), before);
      assert.deepEqual(await ledger.load(result.run), legacy);
    } else {
      const settled = await ledger.load(result.run);
      assert.equal(settled.reserved_tokens, original.reserved_tokens);
      assert.ok(settled.calls[0].steps.every(step => step.settled === true && step.reserved === step.response!.tokens_in + step.response!.tokens_out));
      const unfinished = structuredClone(legacy);
      delete unfinished.calls[0].result;
      unfinished.reserved_tokens -= unfinished.calls[0].steps.pop()!.reserved;
      await ledger.save(unfinished);
      const continuation = new ScriptedModel(() => JSON.stringify(actions[4]));
      await assert.doesNotReject(async () => { assert.equal((await resumeRlm(workspace, result.run, continuation)).answer, result.answer); });
      assert.equal(continuation.requests.length, 1, 'Only the missing finish inference is retried');
      assert.equal((await replayRlm(workspace, result.run)).answer, result.answer);
    }
  }
  for (const version of [undefined, 1, 2, 3] as const) for (const change of ['code', 'reason', 'missing'] as const) {
    if (change === 'missing' && (version === undefined || version === 1)) continue;
    const forged = structuredClone(original);
    if (version === undefined) delete forged.parser_version; else forged.parser_version = version;
    const observation = forged.calls[0].steps[3].observation as { refused: string; reason?: string };
    if (change === 'code') { observation.refused = 'scope'; delete observation.reason; }
    if (change === 'reason') observation.reason = 'Forged legacy correction';
    if (change === 'missing') delete observation.reason;
    await ledger.save(forged);
    const before = await readFile(getHistoryPath(workspace, result.run));
    const noInference = new ScriptedModel(() => assert.fail('Forged refusals must fail before inference'));
    await assert.rejects(operation === 'replay' ? replayRlm(workspace, result.run) : resumeRlm(workspace, result.run, noInference), { code: 'replay', message: `Recorded execution refusal differs at step ${result.run}:3` });
    assert.equal(noInference.requests.length, 0);
    assert.deepEqual(await readFile(getHistoryPath(workspace, result.run)), before);
  }
});
