import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PmClient, commitItemMutations, getHistoryPath, hashHistoryStream, readHistoryEntries, readSettings, resolveRuntimeStatusRegistry } from '@unbrained/pm-cli/sdk';
import type { GetResult } from '@unbrained/pm-cli/sdk';
import { repairRlm, resumeRepairRlm } from '../src/repair.ts';
import { parseRepairCheckpoint, parseRepairRequest, RlmRepairError } from '../src/repair-contract.ts';
import { RlmLedger } from '../src/ledger.ts';
import { resumeRlm } from '../src/engine.ts';
import { ScriptedModel } from './helpers.ts';
import { repairJournal, repairFixture, repairModel, repaired } from './repair-fixture.ts';
import type { RlmRepairOptions, RlmRepairCheckpoint } from '../src/repair-contract.ts';

/** Fixed portable seed supplies reproducible operation orders and older-input selections. */
function seeded(seed: number): () => number { return () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 9; }; }
/** Read the actual native controller and run the same parser used by recovery. */
async function checkpoint(workspace: string, run: string): Promise<RlmRepairCheckpoint> {
  return repairJournal(new PmClient({ pmRoot: workspace, noExtensions: true }), run);
}

/** Model actual SDK state, including normalization, rather than writing a second normalizer. */
test('500 seeded repair journal round trips preserve SDK state across older inputs whitespace and relationships', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  const next = seeded(0x52657061);
  const controllers: { run: string; inputs: RlmRepairCheckpoint[]; native: GetResult['item']; expectedDescription: string | undefined; history: number[]; child?: { id: string; allowance: number; charged: number; native: GetResult['item'] } }[] = [];
  for (let index = 0; index < 12; index++) {
    const parts = structuredClone(request.parts);
    parts[0].question = [`What is known?\r\n keep  spaces `, ` What\n is known?\t`, `Unicode é 😀 ${index}`][index % 3];
    const result = repaired(await repairRlm({ ...request, parts, budget_tokens: index % 3 === 0 ? 1000000 : 0 }, { workspace, model: repairModel(ids[2]) }));
    const inputs: RlmRepairCheckpoint[] = [];
    const entries = await readHistoryEntries(getHistoryPath(workspace, result.run), result.run);
    for (let version = 1; version <= entries.length; version++) {
      const historical = (await client.get(result.run, { at: String(version), fields: 'description' })).item;
      const input = parseRepairCheckpoint(JSON.parse(historical.description!.slice('RLM repair v1\n'.length)));
      assert.deepEqual(input.targets.map(target => target.kind), ['reuse', 'reuse', 'repair']);
      inputs.push(input);
    }
    await client.update(result.run, { parent: ids[index % 3], dep: [`id=${ids[(index + 1) % 3]},kind=related`], body: 'native body\r\n  exact whitespace  ' });
    const native = (await client.get(result.run, { depth: 'full' })).item;
    let child: typeof controllers[number]['child'];
    if (result.status === 'complete') {
      const state = await new RlmLedger(workspace).load(result.components[2].run);
      const charged = state.calls.flatMap(call => call.steps).reduce((sum, step) => sum + step.reserved + ((step.observation as { estimated_tokens?: number } | undefined)?.estimated_tokens ?? 0), 0);
      assert.equal(state.reserved_tokens, charged);
      child = { id: state.run, allowance: inputs.at(-1)!.targets[2].allowance, charged, native: (await client.get(state.run, { depth: 'full' })).item };
    }
    controllers.push({ run: result.run, inputs, native, expectedDescription: native.description, history: [] as number[], child });
  }
  let replays = 0;
  const model = new ScriptedModel(() => assert.fail('A retained answer must not invoke a model'));
  for (let sequence = 0; sequence < 500; sequence++) {
    const controller = controllers[next() % controllers.length];
    const choice = next() % controller.inputs.length;
    const replay = controller.history.length > 0 && next() % 2 === 0;
    const selected = replay ? controller.history[next() % controller.history.length] : choice;
    if (replay) replays++;
    controller.history.push(choice);
    const exported = JSON.stringify(controller.inputs[selected], null, next() % 2 === 0 ? 2 : undefined);
    const imported = parseRepairCheckpoint(JSON.parse(next() % 2 === 0 ? exported.replaceAll('\n', '\r\n') : exported));
    assert.deepEqual(parseRepairRequest(imported.request), controller.inputs[selected].request);
    const reference = structuredClone(imported);
    // Independent model: retain completed native work; only missing intent and progress are published.
    for (const target of reference.targets) {
      if (target.kind === 'repair' && controller.child !== undefined) {
        if (target.child === '') { target.child = controller.child.id; target.allowance = controller.child.allowance; target.phase = 'running'; reference.revision++; }
        if (target.phase !== 'complete') { target.phase = 'complete'; target.reason = ''; reference.revision++; }
      } else if (target.phase === 'pending') {
        target.phase = target.kind === 'reuse' ? 'complete' : 'gap';
        target.reason = target.kind === 'reuse' ? '' : 'budget';
        reference.revision++;
      }
    }
    const targetRevision = hashHistoryStream(await readHistoryEntries(getHistoryPath(workspace, controller.run), controller.run));
    await commitItemMutations({ pmRoot: workspace, author: 'repair-property', transactionId: `repair-property-${sequence}-${targetRevision}`, mutations: [{ op: 'update', id: controller.run, match: { key: 'description', value: controller.expectedDescription }, options: { description: 'RLM repair v1\n' + JSON.stringify(imported) } }] });
    const recovered = repaired(await resumeRepairRlm(controller.run, { workspace, model }));
    assert.equal(recovered.calls, controller.child === undefined ? 0 : 1); assert.equal(recovered.reused, 2); assert.deepEqual(recovered.gaps, controller.child === undefined ? ['part2'] : []);
    assert.equal(recovered.budget.charged, controller.child?.charged ?? 0);
    const actual = (await new PmClient({ pmRoot: workspace, noExtensions: true }).get(controller.run, { depth: 'full' })).item;
    assert.deepEqual(parseRepairCheckpoint(JSON.parse(actual.description!.slice('RLM repair v1\n'.length))), reference, `seed=0x52657061 sequence=${sequence}`);
    if (controller.child !== undefined) {
      const observed = (await client.get(controller.child.id, { depth: 'full' })).item;
      const { updated_at: _observedTime, ...observedFields } = observed;
      const { updated_at: _nativeTime, ...nativeFields } = controller.child.native;
      assert.deepEqual(observedFields, nativeFields, 'Native child fields and relationships survive older controller imports');
    }
    controller.expectedDescription = actual.description;
    for (const field of ['id', 'title', 'type', 'status', 'tags', 'parent', 'body', 'assignee', 'dependencies']) assert.deepEqual(actual[field], controller.native[field], `native ${field} sequence=${sequence}`);
  }
  assert.ok(replays > 200);
  assert.equal(model.requests.length, 0);
  for (const id of ids) assert.equal((await client.get(id, { depth: 'full' })).item.parent, undefined);
  t.diagnostic(`500 sequences; ${replays} older-input replays; 12 real producer journals including four completed native children; native fields read back after actual package recovery; replayed checkpoint counters cannot reset native history`);
});

/** Compete at every traced controller transition on the same real non-git tracker. */
test('repair interleavings fence every boundary and report a peer completion without duplicate work', async t => {
  const { workspace, request, ids } = await repairFixture(t);
  const traced: string[] = [];
  await repairRlm(request, { workspace, model: repairModel(ids[2]), on_transition: name => { traced.push(name); } });
  for (const [chosenIndex, chosen] of traced.entries()) {
    let injected = 0; let position = 0;
    const model = repairModel(ids[2]);
    const options: RlmRepairOptions = { workspace, model, on_transition: async (name, run) => {
      if (position++ !== chosenIndex || injected > 0) return;
      assert.equal(name, chosen);
      injected++;
      if (name === 'created' || name === 'released') assert.equal(repaired(await resumeRepairRlm(run, { workspace, model })).status, 'complete');
      else {
        await assert.rejects(resumeRepairRlm(run, { workspace, model }), { code: 'busy' });
        if (name === 'prepared:part2') {
          const state = await checkpoint(workspace, run);
          const target = state.targets.find(target => target.component === 'part2')!;
          await resumeRlm(workspace, target.child, model);
        }
      }
    } };
    const result = repaired(await repairRlm(request, options));
    assert.equal(injected, 1, chosen); assert.equal(result.status, 'complete', chosen); assert.equal(model.requests.length, 2, chosen);
    // Retain the same tracker and its audit history without growing the active corpus per injection.
    const cleanup = new PmClient({ pmRoot: workspace, noExtensions: true });
    await cleanup.delete(result.components[2].run, { force: true });
    await cleanup.delete(result.run, { force: true });
  }
  t.diagnostic(`Competing executor injected at all ${traced.length} controller boundaries, including repeated locked SDK history writes, on one tracker; native child peer completion verified`);
});

/** Revision checks include edits that restore identical content, and skip every downstream target. */
test('repair detects ABA source changes after intent and after preparation', async t => {
  const { workspace, request, client, ids } = await repairFixture(t);
  request.parts[0].depends_on = ['part2'];
  for (const chosen of ['intent:part2', 'prepared:part2']) {
    const model = repairModel(ids[2]);
    const current = (await client.get(ids[2], { depth: 'full' })).item;
    const result = repaired(await repairRlm(request, { workspace, model, on_transition: async name => {
      if (name !== chosen) return;
      await client.update(ids[2], { description: 'temporary value' });
      await client.update(ids[2], { description: current.description });
    } }));
    assert.deepEqual(result.gaps, ['part0', 'part2']); assert.equal(model.requests.length, 0);
  }
});

/** Ambient focus and arbitrary configured lifecycle names cannot change repair ownership or completion. */
test('random focus and custom status roles preserve explicit controller scope', async t => {
  const { workspace, request, client, ids } = await repairFixture(t);
  const next = seeded(0x51a7);
  const model = repairModel(ids[2]);
  const roles = [['active'], ['blocked'], ['terminal', 'terminal_done'], ['terminal', 'terminal_canceled']];
  const result = repaired(await repairRlm(request, { workspace, model }));
  const child = (await checkpoint(workspace, result.run)).targets[2].child;
  for (let iteration = 0; iteration < 8; iteration++) {
    const status = `repair_custom_${next()}`;
    const role = roles[next() % roles.length];
    await client.schemaAddStatus(status, { role });
    await client.focus(ids[next() % ids.length]);
    await client.update(child, { status, closeReason: 'Custom registry fixture' });
    await resumeRepairRlm(result.run, { workspace, model });
    const registry = resolveRuntimeStatusRegistry((await readSettings(workspace)).schema);
    const actual = (await client.get(child, { depth: 'full' })).item;
    assert.equal(actual.status, registry.terminal_statuses.has(status) ? status : registry.close_status);
    const zero = repaired(await repairRlm({ ...request, budget_tokens: 0 }, { workspace, model }));
    assert.equal((await client.get(zero.run, { depth: 'full' })).item.parent, undefined);
    assert.equal((await client.get(child, { depth: 'full' })).item.parent, result.run);
  }
  assert.equal(model.requests.length, 2);
});

/** Bad records fail alone and foreign rows occupying a planned child never get overwritten. */
test('repair skips foreign child identities and refuses changed source ledgers', async t => {
  const { workspace, request, client, ids } = await repairFixture(t);
  request.parts[0].depends_on = ['part2'];
  const model = repairModel(ids[2]);
  let run = '';
  await assert.rejects(repairRlm(request, { workspace, model, on_transition: (name, id) => { run = id; if (name === 'intent:part2') throw new Error('crash'); } }), RlmRepairError);
  const state = await checkpoint(workspace, run);
  const id = state.targets[2].child;
  await client.create({ id, title: 'Foreign native record', parent: 'none' });
  const before = (await client.get(id, { depth: 'full' })).item;
  assert.deepEqual(repaired(await resumeRepairRlm(run, { workspace, model })).gaps, ['part0', 'part2']);
  assert.deepEqual((await client.get(id, { depth: 'full' })).item, before);
  await client.update(request.source, { title: 'Altered source ledger' });
  await assert.rejects(resumeRepairRlm(run, { workspace, model }), RlmRepairError);
  assert.equal(model.requests.length, 0);
});
