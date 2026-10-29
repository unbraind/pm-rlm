import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { RlmEngine, replayRlm, resumeRlm, runRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { RlmBlobs } from '../src/blobs.ts';
import { RlmError } from '../src/errors.ts';
import { RlmEvidenceError } from '../src/evidence.ts';
import { repairRlm } from '../src/repair.ts';
import { ScriptedModel, tracker } from './helpers.ts';
import { writeNativeCheckpoint } from './repair-fixture.ts';
import type { RlmState } from '../src/types.ts';

const answer = JSON.stringify({ action: 'answer', components: [{ component: 'title', status: 'unsupported', answer: '', reason: 'Fixture gap', witnesses: [] }] });

/** Capture actual producer refusals, including terminal-child and completion-hook receipts. */
async function corpus(t: Parameters<typeof tracker>[0]) {
  const fixture = await tracker(t);
  const id = (await fixture.client.create({ title: 'Public refusal source', parent: 'none' })).item.id;
  const rows: { state: RlmState; model: ScriptedModel; location: 'observation' | 'failure' | 'completion_refusal' }[] = [];
  for (const scenario of ['parse', 'tool', 'witness', 'component', 'child', 'hook']) {
    const model = new ScriptedModel(request => {
      const input = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1)) as { question: string; transcript: unknown[] };
      if (input.question === 'child') {
        if (scenario === 'child') throw new RlmEvidenceError('Fixture child refusal', 'Resolve the fixture child');
        return answer;
      }
      if (input.transcript.length > 0) return answer;
      return scenario === 'parse' ? 'invalid JSON action' : scenario === 'tool' ? '{"action":"get","id":"absent","fields":["title"]}'
        : scenario === 'witness' ? '{"action":"witness","id":"absent","start":0,"end":1}'
        : scenario === 'component' ? '{"action":"finish","answer":"unchecked"}' : '{"action":"spawn","subgoal":"child","slice":{"fragments":[],"estimated_tokens":2}}';
    });
    const result = await runRlm('Refusal field oracle', { workspace: fixture.workspace, scope: { ids: [id] }, components: ['title'], model, settings: { endpoint: 'http://127.0.0.1:1' }, on_call_complete: call => { if (scenario === 'hook' && call.depth === 1) throw new RlmEvidenceError('Fixture hook refusal', 'Resolve the fixture hook'); } });
    const state = await new RlmLedger(fixture.workspace).load(result.run);
    rows.push({ state, model, location: 'observation' });
    if (scenario === 'child' || scenario === 'hook') rows.push({ state, model, location: scenario === 'child' ? 'failure' : 'completion_refusal' });
  }
  return { ...fixture, id, rows };
}

/** Read the field under test without inventing normalization for the SDK-produced record. */
function receipt(state: RlmState, location: 'observation' | 'failure' | 'completion_refusal'): Record<string, unknown> {
  return (location === 'observation' ? state.calls[0].steps[0].observation : state.calls[1][location]) as Record<string, unknown>;
}

/** A prefix removes later prompt checks so every refusal field must authenticate independently. */
function prefix(state: RlmState): RlmState {
  const copy = structuredClone(state);
  delete copy.calls[0].result;
  copy.calls[0].steps = copy.calls[0].steps.slice(0, 1);
  return copy;
}

/** Every refusal family and field rejects deterministic extreme-value tampering without inference. */
test('500 seeded recorded refusal field mutations authenticate through the shared verifier', async t => {
  const { workspace, rows } = await corpus(t);
  const ledger = new RlmLedger(workspace);
  for (const row of rows) await new RlmEngine(ledger, prefix(row.state), row.model).validateRecorded();
  const values: unknown[] = [undefined, null, 42, Infinity, NaN, [], {}, 'forged refusal field'];
  let seed = 0x52656634;
  const fields = ['refused', 'reason', 'remedy'] as const;
  const seen = new Set<string>();
  for (let sequence = 0; sequence < 500; sequence++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const row = rows[sequence % rows.length];
    const field = fields[Math.floor(sequence / rows.length) % fields.length];
    const key = row.location === 'observation' ? field : field === 'refused' ? 'code' : field;
    const changed = prefix(row.state);
    const record = receipt(changed, row.location);
    let value = values[(seed >>> 16) % values.length];
    if (value === record[key]) value = 'different authenticated value';
    if (value === undefined) delete record[key]; else record[key] = value;
    await assert.rejects(new RlmEngine(ledger, changed, row.model).validateRecorded(), RlmError, `seed=0x52656634 sequence=${sequence} field=${key}`);
    seen.add(`${sequence % rows.length}:${key}`);
  }
  assert.equal(seen.size, rows.length * 3);
  for (const row of rows) {
    const legacy = prefix(row.state);
    if (row.location !== 'observation' || receipt(legacy, row.location).remedy !== undefined) continue;
    legacy.parser_version = 1; delete receipt(legacy, row.location).reason;
    await new RlmEngine(ledger, legacy, row.model).validateRecorded();
  }
  t.diagnostic(`500 sequences, ${rows.length} SDK-produced refusal records, ${seen.size} independently checked field positions`);
});

/** SDK imports must be rejected consistently by ordinary replay, resume and repair before writes. */
test('recorded refusal fields refuse replay resume and repair after SDK read-back', async t => {
  const { workspace, client, id, rows } = await corpus(t);
  const noInference = new ScriptedModel(() => assert.fail('Corrupt refusal must never reach inference'));
  for (const row of rows) for (const field of ['refused', 'reason', 'remedy'] as const) {
    const state = structuredClone(row.state);
    const key = row.location === 'observation' ? field : field === 'refused' ? 'code' : field;
    const value = key === 'code' ? 'scope' : 'forged field';
    receipt(state, row.location)[key] = value;
    await writeNativeCheckpoint(client, state.run, state);
    const native = (await client.listAllComplete()).items.find(item => item.id === state.run)!;
    const observed = await new RlmBlobs(workspace).decode(String(native.rlm_state)) as unknown as RlmState;
    assert.equal(receipt(observed, row.location)[key], value);
    const before = (await client.get(state.run, { depth: 'full' })).item;
    const history = await readFile(getHistoryPath(workspace, state.run));
    await assert.rejects(replayRlm(workspace, state.run), RlmError);
    await assert.rejects(resumeRlm(workspace, state.run, noInference), RlmError);
    await assert.rejects(repairRlm({ source: state.run, parts: [{ name: 'title', question: 'What is established?', depends_on: [], sources: [id] }], budget_tokens: 0 }, { workspace, model: noInference }), RlmError);
    assert.deepEqual((await client.get(state.run, { depth: 'full' })).item, before);
    assert.deepEqual(await readFile(getHistoryPath(workspace, state.run)), history);
  }
  assert.equal(noInference.requests.length, 0);
});

/** Missing or nonobject parse receipts are refused in every persisted parser version. */
test('recorded parse receipt shapes preserve only genuine legacy code-only refusals', async t => {
  const { workspace, rows } = await corpus(t);
  const row = rows[0];
  for (const version of [undefined, 1, 3] as const) for (const observation of [undefined, null, 42, [], 'invalid observation']) {
    const state = prefix(row.state);
    if (version === undefined) delete state.parser_version; else state.parser_version = version;
    state.calls[0].steps[0].observation = observation;
    await assert.rejects(new RlmEngine(new RlmLedger(workspace), state, row.model).validateRecorded(false, true), RlmError);
  }
});
