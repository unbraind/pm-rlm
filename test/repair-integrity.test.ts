import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyRootSlice, prepareRlmRun, resumeRlm, replayRlm, RlmEngine } from '../src/engine.ts';
import { promptDigest, RlmLedger } from '../src/ledger.ts';
import { blobDigest } from '../src/blobs.ts';
import { repairRlm, resumeRepairRlm } from '../src/repair.ts';
import { ScriptedModel } from './helpers.ts';
import { interruptedRepair, completedRepairFixture, writeNativeCheckpoint, repairFixture, repairJournal, repairModel, repairPartsModel, repaired } from './repair-fixture.ts';
import type { RlmRepairCheckpoint, RlmRepairRequest } from '../src/repair-contract.ts';
import type { PmClient } from '@unbrained/pm-cli/sdk';

/** Native import of a malformed initial intent must be refused before new execution. */
async function imported(client: PmClient, checkpoint: RlmRepairCheckpoint): Promise<string> {
  return (await client.create({ title: 'Imported repair intent', type: 'Task', parent: 'none', tags: 'rlm:question,rlm:repair', description: 'RLM repair v1\n' + JSON.stringify(checkpoint) })).item.id;
}

/** Verify only the damaged prior child and its dependent are unavailable. */
async function priorGaps(workspace: string, request: RlmRepairRequest, source: string): Promise<void> {
  const result = repaired(await repairRlm({ ...request, source, budget_tokens: 0 }, { workspace }));
  assert.deepEqual(result.gaps, ['part0', 'part2']); assert.equal(result.reused, 1);
}

/** Missing and unverifiable native revision coordinates cannot grant a controller write authority. */
test('repair refuses empty and invalid controller history before execution', async t => {
  const { workspace, request } = await repairFixture(t, 1);
  const result = repaired(await repairRlm({ ...request, budget_tokens: 0 }, { workspace }));
  const path = getHistoryPath(workspace, result.run);
  const original = await readFile(path, 'utf8');
  const invalid = original.split('\n').filter(Boolean).map(line => ({ ...JSON.parse(line), record_hash: '0'.repeat(64) })).map(entry => JSON.stringify(entry)).join('\n') + '\n';
  try {
    for (const contents of ['', invalid]) {
      await writeFile(path, contents);
      await assert.rejects(resumeRepairRlm(result.run, { workspace }), { code: 'incomplete' });
    }
  } finally { await writeFile(path, original); }
});

/** Current and historical source policy must agree, including legacy malformed birth records. */
test('repair validates original source contracts and malformed initial checkpoints', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  await assert.rejects(repairRlm(request, { workspace, model: Object.assign(repairModel(ids[2]), { name: 'wrong-model' }) }), { code: 'invalid' });
  const ledger = new RlmLedger(workspace);
  const original = await ledger.load(request.source);
  const changed = structuredClone(original); changed.question = 'A changed source question';
  await client.run('update', { id: request.source, options: { rlmState: JSON.stringify(changed) } });
  await assert.rejects(repairRlm(request, { workspace }), { code: 'evidence' });
  await client.run('update', { id: request.source, options: { rlmState: JSON.stringify(original) } });
  const id = await ledger.newRunId();
  await client.run('create', { options: { id, type: 'Task', title: 'Malformed legacy birth', parent: original.calls[0].parent!, tags: 'rlm:call', rlmRun: id, rlmState: '{}' } });
  original.run = id; original.calls[0].id = id;
  await client.run('update', { id, options: { rlmState: JSON.stringify(original) } });
  await assert.rejects(repairRlm({ ...request, source: id }, { workspace }), { code: 'incomplete' });
});

/** Fresh-budget continuations revalidate every upstream declaration and operational source mode. */
test('repair continuation rejects changed upstream revisions names and missing external context', async t => {
  const { workspace, root, request, client } = await repairFixture(t);
  const partial = repaired(await repairRlm({ ...request, budget_tokens: 0 }, { workspace }));
  const journal = await repairJournal(client, partial.run);
  const renamed = structuredClone(journal); renamed.request.parts[0].name = 'renamed'; renamed.targets[0].component = 'renamed';
  const invalid = await imported(client, renamed);
  await assert.rejects(repairRlm({ ...request, source: invalid, parts: renamed.request.parts }, { workspace }), { code: 'evidence' });
  await assert.rejects(repairRlm({ ...request, source: partial.run }, { workspace, on_transition: async (name, run) => {
    if (name === 'source:read' && run === partial.run) await client.update(run, { title: 'A peer changed the source controller' });
  } }), { code: 'busy' });
  await client.update(request.source, { title: 'A peer changed the upstream ledger' });
  await assert.rejects(repairRlm({ ...request, source: partial.run }, { workspace }), { code: 'evidence' });
  const source_workspace = join(root, 'external'); await cp(workspace, source_workspace, { recursive: true });
  const external = repaired(await repairRlm({ ...request, budget_tokens: 0 }, { workspace, source_workspace }));
  await assert.rejects(repairRlm({ ...request, source: external.run }, { workspace }), { code: 'scope' });
  assert.equal(repaired(await repairRlm({ ...request, source: external.run, budget_tokens: 0 }, { workspace, source_workspace })).reused, 2);
});

/** Damaged prior children invalidate themselves and their completed dependents without hiding other answers. */
test('repair continuation isolates bad child ownership state scope and component contracts', async t => {
  const { workspace, request, ids, client, model, complete } = await completedRepairFixture(t, 3, true);
  const child = complete.components[2].run;
  const ledger = new RlmLedger(workspace); const state = await ledger.load(child);
  for (const options of [{ tags: 'foreign' }, { rlmState: '{}' }]) {
    await client.run('update', { id: child, options });
    await priorGaps(workspace, request, complete.run);
    await client.run('update', { id: child, options: { tags: 'rlm:call', rlmState: JSON.stringify(state) } });
  }
  const journal = await repairJournal(client, complete.run);
  for (const mode of ['scope', 'component', 'legacy', 'question', 'policy', 'allowance']) {
    const id = ids[mode === 'scope' ? 0 : 2]; const name = mode === 'component' ? 'other' : 'part2';
    const question = JSON.stringify({ question: 'Explain all sources', part: { name: 'part2', question: mode === 'question' ? 'A different intended question' : request.parts[2].question }, dependencies: [] });
    const substitute = await prepareRlmRun(question, { workspace, question_item: complete.run, snapshot_only: true, scope: { ids: [id] }, components: mode === 'legacy' ? undefined : [name], reuse_identity: { tool_policy: 'repair-v1', model_policy: 'original-model', consent: blobDigest(complete.run) }, settings: { ...state.settings, ...(mode === 'policy' ? { endpoint: 'https://example.invalid' } : {}), ...(mode === 'allowance' ? { budget_tokens: state.settings.budget_tokens + 1 } : {}) }, model: mode === 'legacy' ? new ScriptedModel(() => '{"action":"finish","answer":"legacy"}') : repairModel(id, name) });
    await substitute.engine.run();
    journal.targets[2].child = substitute.run;
    await client.update(complete.run, { description: 'RLM repair v1\n' + JSON.stringify(journal) });
    await priorGaps(workspace, request, complete.run);
  }
  journal.targets[2].child = child;
  await client.update(complete.run, { description: 'RLM repair v1\n' + JSON.stringify(journal) });
  await client.delete(child, { force: true });
  assert.deepEqual(repaired(await resumeRepairRlm(complete.run, { workspace, model })).gaps, ['part0', 'part2']);
});

/** Peer edits at SDK publication and final read boundaries never acquire stale write authority. */
test('repair fences peer transitions during initial read publication and final receipts', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  for (const mode of ['head', 'native', 'journal:written', 'controller', 'source', 'issue']) {
    let injected = false;
    if (mode === 'issue') request.parts[1].depends_on = ['part0'];
    const work = repairRlm({ ...request, budget_tokens: 0 }, { workspace, author: 'repair-integrity', on_transition: async (name, run) => {
      if (injected || name !== (['controller', 'source', 'issue'].includes(mode) ? 'saved:part2' : mode)) return;
      injected = true;
      await client.update(mode === 'source' ? request.source : mode === 'issue' ? ids[0] : run, mode === 'head' ? { tags: 'foreign' } : { title: 'A peer transition' });
    } });
    if (mode === 'head') assert.equal((await work).status, 'skipped');
    else if (mode === 'issue') assert.deepEqual(repaired(await work).gaps, ['part0', 'part1', 'part2']);
    else await assert.rejects(work, { code: mode === 'source' ? 'evidence' : 'busy' });
    assert.ok(injected);
  }
});

/** Busy native children and unknown transport failures retain durable intents for explicit recovery. */
test('repair recovers a peer leased child and sanitizes unexpected model failures', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  let run = ''; let unlock: (() => Promise<void>) | undefined;
  try {
    await assert.rejects(repairRlm(request, { workspace, model: repairModel(ids[2]), on_transition: async (name, id) => {
      run = id;
      if (name === 'prepared:part2') unlock = await new RlmLedger(workspace).lease((await repairJournal(client, id)).targets[2].child);
    } }), { code: 'busy' });
  } finally { await unlock?.(); }
  assert.equal(repaired(await resumeRepairRlm(run, { workspace, model: repairModel(ids[2]) })).status, 'complete');
  await assert.rejects(repairRlm(request, { workspace, model: new ScriptedModel(() => { throw new Error('Unexpected transport error'); }), on_transition: (name, id) => { if (name === 'created') run = id; } }), { code: 'incomplete' });
  assert.equal(repaired(await resumeRepairRlm(run, { workspace, model: repairModel(ids[2]) })).status, 'complete');
});

/** The default HTTP adapter is exercised only against a disposable loopback protocol fixture. */
test('repair uses the original configured HTTP model when no adapter is injected', async t => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++; request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ response: JSON.stringify({ action: 'answer', components: [{ component: 'part2', status: 'unsupported', answer: '', reason: 'Fixture gap', witnesses: [] }] }), prompt_eval_count: 1, eval_count: 1 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const { workspace, request } = await repairFixture(t, 3, { endpoint: `http://127.0.0.1:${address.port}`, adapter: 'ollama' });
  const result = repaired(await repairRlm(request, { workspace }));
  assert.equal(requests, 1); assert.equal(result.reused, 2); assert.deepEqual(result.gaps, ['part2']);
});

/** A valid saved allocation still materializes exactly its intended native child. */
test('resumed unmaterialized repair intent admits intact current headroom', async t => {
  const { workspace, request, ids, client } = await repairFixture(t, 1);
  const model = repairModel(ids[0]);
  const { run, journal } = await interruptedRepair(workspace, request, model, 'intent:part0', client);
  const result = repaired(await resumeRepairRlm(run, { workspace, model }));
  assert.equal(result.status, 'complete'); assert.deepEqual(result.gaps, []);
  assert.equal(result.components[0].run, journal.targets[0].child);
  assert.equal(model.requests.length, 2); assert.equal(result.calls, 1);
  assert.deepEqual(repaired(await resumeRepairRlm(run, { workspace, model })), result);
  assert.equal(model.requests.length, 2);
});

/** Unknown earlier usage blocks pending work while retaining independently completed native evidence. */
test('uncertain repair budgets retain completed peers and skip only unfinished work', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  await client.update(ids[0], { description: 'Invalidate only this supported source' });
  for (const stage of ['intent', 'prepared', 'executed']) for (const damage of stage === 'intent' ? ['foreign', 'malformed', 'missing'] : ['foreign']) {
    const model = repairPartsModel(ids);
    const { run, journal } = await interruptedRepair(workspace, request, model, `${stage}:part2`, client);
    if (damage === 'missing') await client.delete(journal.targets[0].child, { force: true });
    else await client.run('update', { id: journal.targets[0].child, options: damage === 'foreign' ? { tags: 'foreign' } : { rlmState: '{}' } });
    const requests = model.requests.length;
    let result: Awaited<ReturnType<typeof resumeRepairRlm>> | undefined;
    await assert.doesNotReject(async () => { result = await resumeRepairRlm(run, { workspace, model }); }, 'Exhaustion must retain supported answers for every durable child phase');
    assert.ok(result && result.status !== 'skipped');
    assert.deepEqual(result.gaps, stage === 'executed' ? ['part0'] : ['part0', 'part2']);
    assert.equal(result.components[1].status, 'supported'); assert.equal(result.budget.remaining, 0);
    assert.deepEqual(result.components.map(part => part.component), request.parts.map(part => part.name));
    assert.equal(result.components[1].answer, 'answer part1');
    assert.equal(model.requests.length, requests);
    if (stage === 'intent') assert.equal((await client.listAllComplete()).items.some(item => item.id === journal.targets[2].child), false);
    if (stage === 'prepared') {
      await resumeRlm(workspace, journal.targets[2].child, model);
      const afterPeer = model.requests.length;
      const refreshed = repaired(await resumeRepairRlm(run, { workspace, model }));
      assert.deepEqual(refreshed.gaps, ['part0']); assert.equal(model.requests.length, afterPeer);
    }
  }
});

/** An existing unrelated row cannot be materialized as a call from imported native progress. */
test('foreign native subcalls are refused without changing their SDK fields', async t => {
  const { workspace, request, client } = await repairFixture(t, 1);
  const foreign = (await client.create({ title: 'Unrelated native record', parent: 'none' })).item;
  const before = (await client.get(foreign.id, { depth: 'full' })).item;
  const ledger = new RlmLedger(workspace); const unlock = await ledger.lease(request.source);
  try {
    const state = await ledger.load(request.source); const slice = emptyRootSlice();
    const call = { id: foreign.id, parent: state.run, depth: 1, subgoal: 'Foreign subcall', slice, digest: promptDigest('Foreign subcall', slice, state.settings), steps: [] };
    await assert.rejects(ledger.materialize(state, call), { code: 'scope' });
    assert.deepEqual((await client.get(foreign.id, { depth: 'full' })).item, before);
    assert.equal((await client.get(foreign.id, { depth: 'full' })).item.title, foreign.title);
  } finally { await unlock(); }
});

/** A valid-looking extra native node must never create or mutate unrelated tracker data. */
test('repair rejects unreachable native records before any materialization', async t => {
  const { workspace, client, model, complete } = await completedRepairFixture(t, 1);
  const child = complete.components[0].run; const ledger = new RlmLedger(workspace); const state = await ledger.load(child);
  const id = 'unreachable-native-record'; const slice = emptyRootSlice();
  state.calls.push({ id, parent: child, depth: 1, subgoal: 'Unreachable data', slice, digest: promptDigest('Unreachable data', slice, state.settings), steps: [], result: 'Unexpected materialization' });
  await assert.rejects(new RlmEngine(ledger, state, model, undefined, true).validateRecorded(), { code: 'replay' });
  const count = (await client.listAllComplete()).items.length;
  await writeNativeCheckpoint(client, child, state);
  await assert.rejects(replayRlm(workspace, child), { code: 'replay' });
  let observed: Awaited<ReturnType<typeof resumeRepairRlm>> | undefined;
  await assert.doesNotReject(async () => { observed = await resumeRepairRlm(complete.run, { workspace, model }); }, 'One malformed child must return its named gap');
  assert.ok(observed && observed.status !== 'skipped');
  const result = observed;
  assert.deepEqual(result.gaps, ['part0']); assert.equal(result.components[0].reason, 'child_evidence');
  assert.equal((await client.listAllComplete()).items.length, count);
  assert.equal((await client.listAllComplete()).items.some(item => item.id === id), false); assert.equal(model.requests.length, 2);
});

/** Older positive-budget journals must recover the completed native child with no extra inference. */
test('completed native repair survives every older producer journal and preserves relationships', async t => {
  const { workspace, ids, client, model, complete } = await completedRepairFixture(t);
  const entries = await readHistoryEntries(getHistoryPath(workspace, complete.run), complete.run);
  const inputs: string[] = [];
  for (let index = 1; index <= entries.length; index++) inputs.push((await client.get(complete.run, { at: String(index), fields: 'description' })).item.description!);
  await client.update(complete.run, { parent: ids[0], body: 'Exact native body\r\n whitespace  ', dep: [`id=${ids[1]},kind=related`] });
  const baseline = (await client.get(complete.run, { depth: 'full' })).item;
  for (const description of inputs) {
    await client.update(complete.run, { description });
    const actual = repaired(await resumeRepairRlm(complete.run, { workspace, model }));
    assert.deepEqual(actual, complete); assert.equal(model.requests.length, 2);
    const native = (await client.get(complete.run, { depth: 'full' })).item;
    for (const field of ['parent', 'body', 'dependencies', 'tags', 'status', 'assignee']) assert.deepEqual(native[field], baseline[field]);
  }
});

/** A completed native proof for a different intended question cannot authorize continuation. */
test('prior repair contract refuses a substituted completed proof', async t => {
  const { workspace, request, ids, client } = await repairFixture(t, 1);
  const partial = repaired(await repairRlm({ ...request, budget_tokens: 0 }, { workspace }));
  const state = await new RlmLedger(workspace).load(request.source);
  const forged = await prepareRlmRun(JSON.stringify({ part: { name: 'part0', question: 'A different intended question' } }), { workspace, question_item: partial.run, scope: { ids }, components: ['part0'], snapshot_only: true, settings: state.settings, reuse_identity: { tool_policy: 'repair-v1', model_policy: 'original-model', consent: blobDigest(partial.run) }, model: repairModel(ids[0]) });
  await forged.engine.run();
  const journal = await repairJournal(client, partial.run);
  Object.assign(journal.targets[0], { phase: 'complete', child: forged.run, allowance: state.settings.budget_tokens, reason: '' });
  await client.update(partial.run, { description: 'RLM repair v1\n' + JSON.stringify(journal) });
  const result = repaired(await repairRlm({ ...request, source: partial.run, budget_tokens: 0 }, { workspace }));
  assert.deepEqual(result.gaps, ['part0']);
  const canonical = await prepareRlmRun(JSON.stringify({ part: { name: 'part0', question: 'A different intended question' } }), { workspace, question_item: partial.run, scope: { ids }, components: ['part0'], snapshot_only: true, settings: state.settings, reuse_identity: { tool_policy: 'repair-v1', model_policy: 'original-model', consent: blobDigest(partial.run) }, model: repairModel(ids[0]) }, undefined, `${partial.run}-r0`);
  await canonical.engine.run();
  journal.targets[0].child = canonical.run;
  await client.update(partial.run, { description: 'RLM repair v1\n' + JSON.stringify(journal) });
  assert.deepEqual(repaired(await repairRlm({ ...request, source: partial.run, budget_tokens: 0 }, { workspace })).gaps, ['part0']);
});

/** A stopped receipt reads current native completion rather than reusing its saved budget-gap verdict. */
test('stopped budget gap recognizes a native peer completion', async t => {
  const { workspace, request, ids, client } = await repairFixture(t, 2);
  await client.update(ids[0], { description: 'Invalidate the first source' });
  const model = repairPartsModel(ids);
  const { run, journal } = await interruptedRepair(workspace, request, model, 'prepared:part1', client);
  await client.update(journal.targets[0].child, { tags: 'foreign' });
  assert.deepEqual(repaired(await resumeRepairRlm(run, { workspace, model })).gaps, ['part0', 'part1']);
  await resumeRlm(workspace, journal.targets[1].child, model);
  const requests = model.requests.length;
  assert.deepEqual(repaired(await resumeRepairRlm(run, { workspace, model })).gaps, ['part0']);
  assert.equal(model.requests.length, requests);
});
