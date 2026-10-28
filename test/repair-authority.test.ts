import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { tracker } from './helpers.ts';
import { PmClient, commitItemMutations, getHistoryPath, hashHistoryStream, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { repairRlm, resumeRepairRlm } from '../src/repair.ts';
import { RlmLedger } from '../src/ledger.ts';
import { prepareRlmRun, resumeRlm } from '../src/engine.ts';
import { completedRepairFixture, repairFixture, repairJournal, repairModel, repairPartsModel, repaired } from './repair-fixture.ts';
import type { GetResult } from '@unbrained/pm-cli/sdk';
import type { RlmRepairCheckpoint } from '../src/repair-contract.ts';

/** Sum real native child ledgers through the SDK, never the mutable controller receipt. */
async function nativeCharge(workspace: string, run: string): Promise<{ charged: number; children: string[] }> {
  const client = new PmClient({ pmRoot: workspace, noExtensions: true });
  const children = (await client.listAllComplete()).items.filter(item => item.parent === run && item.tags.includes('rlm:call') && item.rlm_run === item.id).map(item => item.id);
  let charged = 0;
  for (const id of children) charged += (await new RlmLedger(workspace).load(id)).reserved_tokens;
  return { charged, children };
}

/** Repeated replacement must neither fund fresh children nor erase the canonical child's charge. */
test('repair child identity replacement cannot reset its explicit budget', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  request.budget_tokens = 20000;
  const model = repairModel(ids[2]);
  const original = repaired(await repairRlm(request, { workspace, model }));
  assert.equal(original.status, 'complete');
  const journal = await repairJournal(client, original.run);
  const receipts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const imported = structuredClone(journal);
    imported.targets[2].child = `${original.run}-replacement${attempt}`;
    imported.targets[2].phase = 'pending';
    await client.update(original.run, { description: 'RLM repair v1\n' + JSON.stringify(imported) });
    receipts.push(repaired(await resumeRepairRlm(original.run, { workspace, model })));
  }
  assert.deepEqual(repaired(await resumeRepairRlm(original.run, { workspace, model })), receipts.at(-1), 'Repeated CLI and SDK resumes retain the named identity refusal');
  const actual = await nativeCharge(workspace, original.run);
  t.diagnostic(`Native children=${actual.children.length}, native charge=${actual.charged}, explicit cap=${request.budget_tokens}, final reported=${receipts.at(-1)!.budget.charged}`);
  assert.ok(actual.charged <= request.budget_tokens, 'Replacing an identity cannot authorize spending the same budget again');
  assert.equal(actual.charged, original.budget.charged);
  assert.deepEqual(actual.children, [original.components[2].run]); assert.equal(model.requests.length, 2);
  for (const result of receipts) {
    assert.equal(result.budget.charged, actual.charged);
    assert.deepEqual(result.gaps, ['part2']); assert.equal(result.reused, 2);
    assert.equal(result.components[2].reason, 'child_identity'); assert.ok(result.components[2].remedy.length > 0);
  }
});

/** Older or damaged progress cannot hide a canonical child by blanking its saved identity. */
test('repair cleared child intents retain native charges before other work is admitted', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  await client.update(ids[0], { description: 'Invalidate another part' });
  request.budget_tokens = 20000;
  const model = repairModel(ids[0], 'part0');
  let run = '';
  await assert.rejects(repairRlm(request, { workspace, model, on_transition: (phase, id) => { run = id; if (phase === 'executed:part0') throw new Error('Synthetic interruption'); } }));
  const journal = await repairJournal(client, run);
  const before = await nativeCharge(workspace, run);
  assert.equal(before.children.length, 1); assert.ok(before.charged > 0);
  journal.targets[0].child = ''; journal.targets[0].allowance = 0; journal.targets[0].phase = 'gap'; journal.targets[0].reason = 'budget';
  journal.targets[2].phase = 'gap'; journal.targets[2].reason = 'budget';
  await client.update(run, { description: 'RLM repair v1\n' + JSON.stringify(journal) });
  const result = repaired(await resumeRepairRlm(run, { workspace, model }));
  assert.equal(result.budget.charged, before.charged, 'Clearing an intent must not erase prior native charges');
  assert.equal(result.components[0].status, 'supported'); assert.equal(model.requests.length, 2);
  assert.deepEqual(await nativeCharge(workspace, run), before);
});

/** Refuse replacement independently for repaired and reused components, through continuation too. */
test('repair authenticates child identity for every component and accepts SDK aliases', async t => {
  const { workspace, request, client, model, complete } = await completedRepairFixture(t);
  const original = await repairJournal(client, complete.run);
  for (const index of [0, 1, 2]) {
    const journal = structuredClone(original);
    journal.targets[index].child = `${complete.run}-r99`;
    await client.update(complete.run, { description: 'RLM repair v1\n' + JSON.stringify(journal) });
    const result = repaired(await resumeRepairRlm(complete.run, { workspace, model }));
    assert.deepEqual(result.gaps, [`part${index}`]); assert.equal(result.components[index].reason, 'child_identity');
    assert.equal(result.budget.charged, complete.budget.charged); assert.equal(model.requests.length, 2);
    const continued = repaired(await repairRlm({ ...request, source: complete.run, budget_tokens: 0 }, { workspace, model }));
    assert.deepEqual(continued.gaps, [`part${index}`]); assert.equal(model.requests.length, 2);
  }
  original.targets[2].child = original.targets[2].child.toUpperCase();
  await client.update(complete.run, { description: 'RLM repair v1\n' + JSON.stringify(original) });
  const alias = repaired(await resumeRepairRlm(complete.run, { workspace, model }));
  assert.deepEqual(alias, complete);
  assert.equal((await client.get(original.targets[2].child, { depth: 'full' })).item.id, complete.components[2].run);
});

/** Seeded edits, old inputs and aliases preserve SDK-observed native spending and relationships. */
test('500 seeded repair identity imports preserve a reference budget and SDK state', async t => {
  const controllers: (Awaited<ReturnType<typeof completedRepairFixture>> & { finished: RlmRepairCheckpoint; canonical: string; child: GetResult['item']; charge: number; inputs: RlmRepairCheckpoint[] })[] = [];
  for (let index = 0; index < 8; index++) {
    const fixture = await completedRepairFixture(t);
    const { workspace, client, complete } = fixture;
    const initial = (await client.get(complete.run, { at: '1', fields: 'description' })).item.description!;
    const birth = JSON.parse(initial.slice('RLM repair v1\n'.length)) as RlmRepairCheckpoint;
    const finished = await repairJournal(client, complete.run);
    const canonical = finished.targets[2].child;
    const child = (await client.get(canonical, { depth: 'full' })).item;
    const charge = (await new RlmLedger(workspace).load(canonical)).reserved_tokens;
    controllers.push({ ...fixture, finished, canonical, child, charge, inputs: [birth, finished] });
  }
  let seed = 0x4368696c;
  /** One deterministic generator also selects replayed older snapshots. */
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  let replacements = 0; let older = 0;
  for (let sequence = 0; sequence < 500; sequence++) {
    const { workspace, client, model, complete, finished, canonical, child, charge, inputs } = controllers[next() % controllers.length];
    const imported = structuredClone(inputs[next() % inputs.length]);
    const mode = next() % 7;
    const target = imported.targets[2];
    if (mode === 0 || mode === 4) { target.child = `${complete.run}-foreign${sequence}`; target.allowance = finished.targets[2].allowance; target.phase = 'pending'; replacements++; }
    if (mode === 1 || mode === 5) { target.child = ''; target.allowance = 0; target.phase = 'gap'; target.reason = 'budget'; older++; }
    if (mode === 2) { target.child = canonical; target.allowance = finished.targets[2].allowance; target.phase = 'pending'; target.reason = ''; }
    if (mode === 3) { target.child = canonical.toUpperCase(); target.allowance = finished.targets[2].allowance; target.phase = 'complete'; target.reason = ''; }
    inputs.push(structuredClone(imported));
    const native = (await client.get(complete.run, { depth: 'full' })).item;
    const head = hashHistoryStream(await readHistoryEntries(getHistoryPath(workspace, complete.run), complete.run));
    const serialized = JSON.stringify(imported, null, sequence % 2 === 0 ? 2 : undefined);
    await commitItemMutations({ pmRoot: workspace, author: 'repair-authority', transactionId: `authority-${sequence}-${head}`, mutations: [{ op: 'update', id: complete.run, match: { key: 'description', value: native.description }, options: { description: 'RLM repair v1\n' + (sequence % 3 === 0 ? serialized.replaceAll('\n', '\r\n') : serialized) } }] });
    const readBack = await repairJournal(client, complete.run);
    assert.deepEqual(readBack, imported, 'Input is read back through the SDK before modeling recovery');
    let reference = structuredClone(readBack);
    const working = structuredClone(readBack);
    let resolved = '';
    if (target.child !== '') { try { resolved = (await client.get(target.child, { fields: 'id' })).item.id; } catch { resolved = 'foreign'; } }
    const badIdentity = target.child !== '' && resolved !== canonical;
    if (working.targets[2].child !== '') working.targets[2].child = canonical;
    if (badIdentity) { working.targets[2].phase = 'skipped'; working.targets[2].reason = 'child_identity'; }
    for (const [index, part] of working.targets.entries()) {
      const previous = JSON.stringify(part);
      if (part.kind === 'repair' && part.child === '') {
        part.child = canonical; part.allowance = finished.targets[index].allowance; part.phase = 'running';
        working.revision++; reference = structuredClone(working);
      }
      if (index !== 2 || !badIdentity) { part.phase = 'complete'; part.reason = ''; }
      if (JSON.stringify(part) !== previous) { working.revision++; reference = structuredClone(working); }
    }
    const result = repaired(await resumeRepairRlm(complete.run, { workspace, model }));
    assert.equal(result.budget.charged, charge); assert.equal(result.calls, 1); assert.equal(result.reused, 2);
    assert.deepEqual(result.gaps, badIdentity ? ['part2'] : []);
    assert.deepEqual(await repairJournal(client, complete.run), reference, `seed=0x4368696c sequence=${sequence}`);
    const actual = (await client.get(canonical, { depth: 'full' })).item;
    const { updated_at: _actualTime, ...actualFields } = actual;
    const { updated_at: _referenceTime, ...referenceFields } = child;
    assert.deepEqual(actualFields, referenceFields, `every native child field and relationship sequence=${sequence}`);
  }
  assert.ok(replacements > 100 && older > 100);
  for (const { model, workspace, complete, charge, canonical } of controllers) {
    assert.equal(model.requests.length, 2);
    assert.deepEqual(await nativeCharge(workspace, complete.run), { charged: charge, children: [canonical] });
  }
  t.diagnostic(`500 SDK import/recovery sequences across eight real trackers; ${replacements} replacements and ${older} explicit older cleared intents; no additional model requests or native children`);
});

/** Deleted or foreign canonical rows cannot become fresh spending authority after an old import. */
test('repair cleared intents conserve unavailable native usage and preserve foreign rows', async t => {
  for (const mode of ['missing', 'foreign']) {
    const { workspace, client, model, complete } = await completedRepairFixture(t, 1);
    const child = complete.components[0].run;
    const birth = (await client.get(complete.run, { at: '1', fields: 'description' })).item.description!;
    if (mode === 'missing') await client.delete(child, { force: true });
    else await client.update(child, { tags: 'foreign' });
    const foreign = mode === 'foreign' ? (await client.get(child, { depth: 'full' })).item : undefined;
    await client.update(complete.run, { description: birth });
    const result = repaired(await resumeRepairRlm(complete.run, { workspace, model }));
    assert.equal(result.status, 'partial'); assert.deepEqual(result.gaps, ['part0']);
    assert.equal(result.components[0].reason, mode === 'missing' ? 'missing_child' : 'foreign');
    assert.equal(result.budget.charged, result.budget.limit); assert.equal(model.requests.length, 2);
    if (foreign !== undefined) assert.deepEqual((await client.get(child, { depth: 'full' })).item, foreign);
  }
});

/** Competing recovery at every restored-intent boundary cannot duplicate native execution or accounting. */
test('repair restored intent interleavings fence every recovery boundary', async t => {
  const { workspace, client, model, complete } = await completedRepairFixture(t, 1);
  const birth = (await client.get(complete.run, { at: '1', fields: 'description' })).item.description!;
  await client.update(complete.run, { description: birth });
  const traced: string[] = [];
  assert.equal(repaired(await resumeRepairRlm(complete.run, { workspace, model, on_transition: name => { traced.push(name); } })).budget.charged, complete.budget.charged);
  for (let chosen = 0; chosen < traced.length; chosen++) {
    await client.update(complete.run, { description: birth });
    let position = 0; let injected = false;
    const result = repaired(await resumeRepairRlm(complete.run, { workspace, model, on_transition: async name => {
      if (position++ !== chosen) return;
      assert.equal(name, traced[chosen]); injected = true;
      if (name === 'released') assert.equal(repaired(await resumeRepairRlm(complete.run, { workspace, model })).budget.charged, complete.budget.charged);
      else await assert.rejects(resumeRepairRlm(complete.run, { workspace, model }), { code: 'busy' });
    } }));
    assert.equal(injected, true); assert.equal(result.status, 'complete');
    assert.equal(result.budget.charged, complete.budget.charged); assert.equal(result.calls, 1);
  }
  assert.equal(model.requests.length, 2);
  assert.deepEqual((await nativeCharge(workspace, complete.run)).children, [complete.components[0].run]);
  t.diagnostic(`Peer recovery injected at all ${traced.length} restored-intent boundaries on one non-git tracker`);
});

/** Replaying the native checkpoint itself cannot refund the controller or bypass native SDK recovery. */
test('repair native checkpoint replays cannot refund completed work through either resume API', async t => {
  for (const mode of ['repair', 'native', 'save']) {
    const { workspace, client, request, ids } = await repairFixture(t);
    request.budget_tokens = 20000;
    const model = repairModel(ids[2]);
    const complete = repaired(await repairRlm(request, { workspace, model }));
    const child = complete.components[2].run;
    const older = await new RlmLedger(workspace).load(child, '1');
    if (mode === 'save') {
      const ledger = new RlmLedger(workspace); const unlock = await ledger.lease(child);
      try {
        const current = await ledger.load(child);
        const before = (await client.get(child, { depth: 'full' })).item;
        const head = hashHistoryStream(await readHistoryEntries(getHistoryPath(workspace, child), child));
        Object.assign(current, older);
        await assert.rejects(ledger.save(current), { code: 'replay' });
        assert.deepEqual((await client.get(child, { depth: 'full' })).item, before);
        assert.equal(hashHistoryStream(await readHistoryEntries(getHistoryPath(workspace, child), child)), head);
      } finally { await unlock(); }
      assert.equal(model.requests.length, 2); continue;
    }
    await client.run('update', { id: child, options: { rlmState: JSON.stringify(older) } });
    if (mode === 'native') await assert.rejects(resumeRlm(workspace, child, model), { code: 'replay' });
    else {
      const result = repaired(await resumeRepairRlm(complete.run, { workspace, model }));
      assert.equal(result.reused, 2);
      assert.equal(result.budget.charged, result.budget.limit);
      assert.deepEqual(result.gaps, ['part2']);
    }
    assert.equal(model.requests.length, 2, 'Older native state must not authorize inference already charged to this controller');
  }
});

/** Old unexpected allocations consume authority; unrelated SDK runs stay foreign and unchanged. */
test('repair untracked native allocations cannot fund additional children', async t => {
  for (const mode of ['owned', 'foreign']) {
    const { workspace, client, request, ids } = await repairFixture(t);
    await client.update(ids[0], { description: 'Invalidate the first source' });
    request.budget_tokens = 1000000;
    const model = repairPartsModel(ids);
    let run = '';
    await assert.rejects(repairRlm(request, { workspace, model, on_transition: (phase, id) => {
      if (phase === 'created') run = id;
      if (phase === 'executed:part0') throw new Error('Synthetic older controller interruption');
    } }));
    const canonical = (await repairJournal(client, run)).targets[0].child;
    if (mode === 'foreign') {
      const id = `${run}-unrecognized`;
      await client.run('create', { options: { id, title: 'Foreign native format', type: 'Task', parent: run, tags: 'rlm:call', rlmRun: id, rlmState: '{}' } });
    }
    const state = await new RlmLedger(workspace).load(canonical);
    const extra = await prepareRlmRun(state.question, { workspace, model, settings: state.settings, question_item: run, scope: state.scope, components: state.components, snapshot_only: true, reuse_identity: mode === 'owned' ? state.reuse_identity : { tool_policy: 'foreign', model_policy: 'foreign', consent: 'foreign' } }, undefined, `${run}-historic`);
    await extra.engine.run();
    const before = (await client.get(extra.run, { depth: 'full' })).item;
    const result = repaired(await resumeRepairRlm(run, { workspace, model }));
    assert.equal(result.components[0].status, 'supported');
    if (mode === 'owned') {
      assert.deepEqual(result.gaps, ['part2']); assert.equal(result.components[2].reason, 'untracked_child');
      assert.equal(result.budget.charged, result.budget.limit); assert.equal(model.requests.length, 4);
    } else {
      assert.equal(result.status, 'complete'); assert.equal(model.requests.length, 6);
    }
    assert.deepEqual((await client.get(extra.run, { depth: 'full' })).item, before);
  }
});

/** Foreign legacy records remain readable while changed native history cannot confer authority. */
test('repair publisher history distinguishes legacy records from altered audit chains', async t => {
  const { workspace, client } = await tracker(t);
  const id = (await client.create({ title: 'Previously released foreign native record', parent: 'none' })).item.id;
  const ledger = new RlmLedger(workspace);
  await ledger.registerFields();
  assert.equal(await ledger.publishedState(id), undefined);
  const path = getHistoryPath(workspace, id);
  const original = await readFile(path, 'utf8');
  const entries = await readHistoryEntries(path, id);
  entries[0].message = 'Altered audit event';
  try {
    await writeFile(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await assert.rejects(ledger.publishedState(id), { code: 'replay' });
  } finally { await writeFile(path, original); }
  assert.equal(await ledger.publishedState(id), undefined);
});

/** Immutable intent comparison requires the entire native field, beyond presentation budgets. */
test('repair large native intents retain complete immutable declarations', async t => {
  const { workspace, request, client } = await repairFixture(t);
  request.parts.forEach((part, index) => { part.question = `Question ${index}: ` + 'x'.repeat(4000); });
  request.budget_tokens = 0;
  const result = repaired(await repairRlm(request, { workspace }).catch(error => assert.fail('Complete native intent must remain readable: ' + String(error))));
  const native = (await client.get(result.run, { at: '1', fields: 'description', outputBudget: 'unbounded', outputLimit: 'unbounded' })).item;
  assert.ok(Buffer.byteLength(native.description!) > 12000);
  assert.equal(result.reused, 2); assert.deepEqual(result.gaps, ['part2']);
  assert.deepEqual(repaired(await resumeRepairRlm(result.run, { workspace })), result);
});
