import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, chmod, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { getHistoryPath, hashDocument, hashHistoryStream, locateItem, PmClient, readHistoryEntries, readLocatedItem } from '@unbrained/pm-cli/sdk';
import { blobDigest, RlmBlobs } from '../src/blobs.ts';
import type { RlmState } from '../src/types.ts';
import { RlmError } from '../src/errors.ts';
import { parseComponents, RlmEvidenceError } from '../src/evidence.ts';
import { prepareRlmRun, runRlm } from '../src/engine.ts';
import { compactRepairResult, repairRlm, resumeRepairRlm } from '../src/repair.ts';
import { parseRepairRequest, parseRepairCheckpoint, RlmRepairError, validateRepairResult } from '../src/repair-contract.ts';
import type { RlmRepairResult } from '../src/repair-contract.ts';
import { ScriptedModel } from './helpers.ts';
import { repairJournal, repairChild, repairFixture, repaired, repairModel } from './repair-fixture.ts';
import { RlmLedger } from '../src/ledger.ts';

/** Independent extreme-value corpus fuzzes both boundaries and exact accounting identities. */
test('repair schema fuzz keeps producer output finite and preserves arbitrary component names', () => {
  assert.throws(() => parseComponents(new Array(1)), RlmEvidenceError);
  const legacy = ['legacy component\r\n with spaces', 'constructor'];
  assert.deepEqual(parseComponents(legacy), legacy);
  let seed = 0x572e9;
  const extremes: unknown[] = [NaN, Infinity, -Infinity, -1, 1.5, 1000000001, Number.MAX_SAFE_INTEGER, undefined, null, '2', {}, []];
  for (let iteration = 0; iteration < 500; iteration++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const budget_tokens = seed % 1000000001;
    const request = { source: 'source', budget_tokens, parts: [{ name: '__proto__', question: ' exact\r\n question  ', sources: ['source'], depends_on: ['constructor'] }, { name: 'constructor', question: 'Question', sources: ['source'], depends_on: [] }] };
    assert.deepEqual(parseRepairRequest(JSON.parse(JSON.stringify(request))), request);
    const checkpoint = parseRepairCheckpoint({ version: 'repair-v1', revision: iteration, request, source_mode: 'tracker', source_revision: 'a'.repeat(64), revisions: [{ id: 'source', revision: 'b'.repeat(64) }], targets: request.parts.map(part => ({ component: part.name, kind: 'repair', phase: 'gap', child: '', allowance: 0, reason: 'budget' })) });
    assert.deepEqual(parseRepairCheckpoint(JSON.parse(JSON.stringify(checkpoint))), checkpoint);
    if (iteration % 50 === 0) for (const invalid of [null, { ...checkpoint, extra: true }, { ...checkpoint, revisions: [] }, { ...checkpoint, revisions: [checkpoint.revisions[0], checkpoint.revisions[0]] }, { ...checkpoint, revisions: [{ ...checkpoint.revisions[0], id: 'absent' }] }, { ...checkpoint, targets: [] }]) assert.throws(() => parseRepairCheckpoint(invalid), RlmRepairError);
    const charged = budget_tokens === 0 ? 0 : seed % budget_tokens;
    const result: RlmRepairResult = { run: 'repair', source: 'source', status: 'partial', budget: { limit: budget_tokens, charged, remaining: budget_tokens - charged }, calls: seed % 32, reused: 0, scheduled: ['__proto__', 'constructor'], gaps: ['__proto__', 'constructor'], components: [] };
    assert.deepEqual(validateRepairResult(result), result);
    assert.equal(compactRepairResult(result).status, 'partial');
    const extreme = extremes[seed % extremes.length];
    assert.throws(() => parseRepairRequest({ ...request, budget_tokens: extreme }), RlmRepairError);
    assert.throws(() => validateRepairResult({ ...result, calls: extreme as number }), RlmRepairError);
  }
  for (const parts of [new Array(2), Array.from({ length: 17 }, () => ({})), [{ name: 'x', question: 'q', sources: ['x'], depends_on: new Array(2) }], [{ name: 'x', question: 'q', sources: new Array(2), depends_on: [] }], [{ name: 'x', question: 'q', sources: ['x'], depends_on: ['y', 'y'] }, { name: 'y', question: 'q', sources: ['x'], depends_on: [] }]]) assert.throws(() => parseRepairRequest({ source: 'source', budget_tokens: 1, parts }), RlmRepairError);
});

/** Child refusals retain native reservation charges while preserving all independent answers. */
test('unsupported child and exhausted call slots keep supported answers and explicit reasons', async t => {
  const { workspace, request, ids } = await repairFixture(t, 3, { max_calls: 1 });
  request.parts[0].depends_on = ['part2'];
  const model = repairModel(ids[2]);
  const result = repaired(await repairRlm(request, { workspace, model }));
  assert.equal(result.reused, 1); assert.equal(result.calls, 1); assert.deepEqual(result.gaps, ['part0']); assert.equal(result.components[0].reason, 'calls');
  const unknown = new ScriptedModel(() => JSON.stringify({ action: 'answer', components: [{ component: 'part2', status: 'unknown', answer: '', reason: 'Unavailable', witnesses: [] }] }));
  const partial = repaired(await repairRlm(request, { workspace, model: unknown }));
  assert.equal(partial.components[2].reason, 'evidence'); assert.equal(partial.components[0].reason, 'dependency_gap'); assert.equal(unknown.requests.length, 1);
  assert.deepEqual(repaired(await resumeRepairRlm(partial.run, { workspace, model: unknown })), partial);
  const failure = new ScriptedModel(() => { throw new RlmError('budget', 'Fixture exhaustion'); });
  const exhausted = repaired(await repairRlm(request, { workspace, model: failure }));
  assert.equal(exhausted.reused, 1); assert.equal(exhausted.components[2].reason, 'budget'); assert.ok(exhausted.budget.charged > 0);
  await assert.rejects(resumeRepairRlm(result.run, { workspace, model: Object.assign(repairModel(ids[2]), { name: 'wrong' }) }), RlmRepairError);
});

/** External source mode is explicit on both initial execution and recovery. */
test('read-only source copies work and missing recovery context refuses with a remedy', async t => {
  const { workspace, root, request, ids } = await repairFixture(t);
  const source_workspace = join(root, 'read-only-copy');
  await cp(workspace, source_workspace, { recursive: true });
  const client = new PmClient({ pmRoot: source_workspace, noExtensions: true });
  // Only copied source item files become read-only; caches remain disposable.
  for (const id of ids) {
    const source = (await client.get(id, { depth: 'full' })).item;
    assert.equal(source.id, id);
    await chmod(join(source_workspace, 'issues', `${id}.toon`), 0o444);
  }
  const result = repaired(await repairRlm(request, { workspace, source_workspace, model: repairModel(ids[2]) }));
  assert.equal(result.status, 'complete');
  await assert.rejects(resumeRepairRlm(result.run, { workspace }), { code: 'scope' });
  await assert.rejects(repairRlm({ ...request, source: result.run }, { workspace }), { code: 'scope' });
  assert.equal(repaired(await resumeRepairRlm(result.run, { workspace, source_workspace })).status, 'complete');
});

/** Continuations reject cyclic, oversized and unfinished histories before new run creation. */
test('repair source chains enforce depth and revision contracts and reject pending plans', async t => {
  const { workspace, request, client } = await repairFixture(t);
  const original = repaired(await repairRlm({ ...request, budget_tokens: 0 }, { workspace }));
  const native = (await client.get(original.run, { depth: 'full' })).item;
  const template = JSON.parse(native.description!.slice('RLM repair v1\n'.length));
  let previous = request.source;
  for (let index = 0; index < 16; index++) {
    const clone = structuredClone(template);
    clone.request.source = previous;
    const located = await locateItem(workspace, previous);
    const parsed = await readLocatedItem(located!);
    clone.source_revision = blobDigest(JSON.stringify([hashDocument(parsed.document), hashHistoryStream(await readHistoryEntries(getHistoryPath(workspace, previous), previous))]));
    previous = (await client.create({ title: `Source chain ${index}`, parent: 'none', tags: 'rlm:question,rlm:repair', description: 'RLM repair v1\n' + JSON.stringify(clone) })).item.id;
  }
  let depth = 0;
  await assert.rejects(repairRlm({ ...request, source: previous }, { workspace, on_transition: name => { if (name === 'source:read') depth++; } }), { code: 'evidence' });
  assert.equal(depth, 16);
  const cyclic = structuredClone(template); cyclic.request.source = original.run;
  await client.update(original.run, { description: 'RLM repair v1\n' + JSON.stringify(cyclic) });
  await assert.rejects(repairRlm({ ...request, source: original.run }, { workspace }), { code: 'evidence' });
  const altered = structuredClone(template); altered.source_revision = 'f'.repeat(64);
  await client.update(original.run, { description: 'RLM repair v1\n' + JSON.stringify(altered) });
  await assert.rejects(repairRlm({ ...request, source: original.run }, { workspace }), { code: 'evidence' });
  const renamed = structuredClone(template); renamed.request.parts[0].name = 'different'; renamed.targets[0].component = 'different';
  await client.update(original.run, { description: 'RLM repair v1\n' + JSON.stringify(renamed) });
  await assert.rejects(repairRlm({ ...request, source: original.run, parts: renamed.request.parts }, { workspace }), { code: 'evidence' });
  let pending = '';
  await assert.rejects(repairRlm(request, { workspace, on_transition: (name, id) => { if (name === 'created') { pending = id; throw new Error('crash'); } } }), RlmRepairError);
  await assert.rejects(repairRlm({ ...request, source: pending }, { workspace }), { code: 'evidence' });
  await assert.rejects(repairRlm(request, { workspace, on_transition: async name => { if (name === 'source:read') await client.update(request.source, { title: 'Source revision raced' }); } }), { code: 'busy' });
});

/** A missing source is a gap; broken source history is a typed integrity refusal. */
test('missing source and legacy evidence contracts refuse safely without hiding other rows', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  const absent = await repairRlm({ ...request, source: 'absent' }, { workspace }); assert.equal(absent.status, 'skipped');
  const legacy = await runRlm('Legacy execution', { workspace, model: new ScriptedModel(() => '{"action":"finish","answer":"legacy"}') });
  await assert.rejects(repairRlm({ ...request, source: legacy.run }, { workspace }), { code: 'evidence' });
  const history = getHistoryPath(workspace, ids[2]);
  await rename(history, history + '.saved');
  try { await assert.rejects(repairRlm(request, { workspace }), { code: 'incomplete' }); }
  finally { await rename(history + '.saved', history); }
  const model = repairModel(ids[2]);
  const result = repaired(await repairRlm(request, { workspace, model, on_transition: async name => { if (name === 'intent:part2') await client.delete(ids[2], { force: true }); } }));
  assert.deepEqual(result.gaps, ['part2']); assert.equal(result.reused, 2); assert.equal(model.requests.length, 0);
});

/** A modified checkpoint never gains authority from a previously saved plan. */
test('repair checkpoint corruption and target contract replacement fail individually', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  const result = repaired(await repairRlm({ ...request, budget_tokens: 0 }, { workspace }));
  const row = (await client.get(result.run, { depth: 'full' })).item;
  const checkpoint = JSON.parse(row.description!.slice('RLM repair v1\n'.length));
  assert.throws(() => parseRepairCheckpoint({ ...checkpoint, targets: checkpoint.targets.map((target: Record<string, unknown>) => ({ ...target, component: 'other' })) }), RlmRepairError);
  await client.update(result.run, { description: 'RLM repair v1\n{' });
  await assert.rejects(resumeRepairRlm(result.run, { workspace }), RlmRepairError);
  let run = '';
  await assert.rejects(repairRlm(request, { workspace, model: repairModel(ids[2]), on_transition: async (name, id) => { run = id; if (name !== 'prepared:part2') return; const parent = (await client.get(run, { depth: 'full' })).item; const native = JSON.parse(parent.description!.slice('RLM repair v1\n'.length)); await client.update(native.targets[2].child, { parent: ids[0] }); throw new Error('crash'); } }), RlmRepairError);
  assert.deepEqual(repaired(await resumeRepairRlm(run, { workspace })).gaps, ['part2']);
});

/** All three native ownership dimensions are checked under the run lease before publication. */
test('native checkpoint ownership refuses changed run marker tag and parent before writing', async t => {
  const { workspace, source, ids, client } = await repairFixture(t);
  const ledger = new RlmLedger(workspace);
  const release = await ledger.lease(source.run);
  try {
    const native = (await client.get(source.run, { depth: 'full' })).item;
    for (const patch of [{ rlmRun: 'foreign' }, { tags: 'foreign' }, { parent: ids[0] }]) {
      const state = await ledger.load(source.run);
      await client.run('update', { id: source.run, options: patch });
      try { await assert.rejects(ledger.save(state), { code: 'busy' }); }
      finally { await client.run('update', { id: source.run, options: { rlmRun: source.run, tags: native.tags!.join(','), parent: native.parent! } }); }
    }
  } finally { await release(); }
});

/** Foreign records introduced during an active run are skipped and consume a conservative allowance. */
test('late foreign child transitions never mutate the peer record or free its budget', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  let foreign = ''; let snapshot: unknown;
  const occupied = repaired(await repairRlm(request, { workspace, on_transition: async (name, run) => {
    if (name !== 'intent:part2') return;
    const controller = (await client.get(run, { depth: 'full' })).item;
    foreign = JSON.parse(controller.description!.slice('RLM repair v1\n'.length)).targets[2].child;
    await client.create({ id: foreign, title: 'Peer record', parent: 'none' });
    snapshot = (await client.get(foreign, { depth: 'full' })).item;
  } }));
  assert.deepEqual(occupied.gaps, ['part2']); assert.equal(occupied.budget.remaining, 0);
  assert.deepEqual((await client.get(foreign, { depth: 'full' })).item, snapshot);
  let child = '';
  const response = repairModel(ids[2]);
  for (const patch of [{ rlmRun: 'foreign' }, { tags: 'foreign' }, { parent: 'none' }]) {
    const model = new ScriptedModel(async input => {
      await client.run('update', { id: child, options: patch });
      snapshot = (await client.get(child, { depth: 'full' })).item;
      return (await response.complete(input)).text;
    });
    const lost = repaired(await repairRlm(request, { workspace, model, on_transition: async (name, run) => {
      if (name !== 'prepared:part2') return;
      child = await repairChild(client, run, 'part2');
    } }));
    assert.deepEqual(lost.gaps, ['part2']); assert.equal(lost.budget.remaining, 0); assert.equal(model.requests.length, 1);
    assert.deepEqual((await client.get(child, { depth: 'full' })).item, snapshot);
  }
});

/** The history coordinate fences both stale reads and the gap before the locked SDK mutation. */
test('native checkpoint history refuses ABA even when content returns to its previous value', async t => {
  const { workspace, source, client, ids } = await repairFixture(t);
  const ledger = new RlmLedger(workspace);
  const unlock = await ledger.lease(source.run);
  const native = (await client.get(source.run, { depth: 'full' })).item;
  try {
    const stale = await ledger.load(source.run);
    await client.update(source.run, { description: 'Temporary description' });
    await client.update(source.run, { description: native.description });
    await assert.rejects(ledger.save(stale), { code: 'busy' });
    const encode = RlmBlobs.prototype.encode;
    for (const patch of [{ description: 'Temporary description' }, { rlmState: '{}' }, { rlmRun: 'foreign' }, { tags: 'foreign' }, { parent: ids[0] }]) {
      const state = await ledger.load(source.run);
      t.mock.method(RlmBlobs.prototype, 'encode', async function (this: RlmBlobs, input: RlmState) {
        const encoded = await encode.call(this, input);
        await client.run('update', { id: source.run, options: patch });
        if ('description' in patch) await client.update(source.run, { description: native.description });
        return encoded;
      });
      try { await assert.rejects(ledger.save(state), { code: 'busy' }); }
      finally {
        t.mock.restoreAll();
        await client.run('update', { id: source.run, options: { description: native.description, rlmState: native.rlm_state, rlmRun: source.run, tags: native.tags!.join(','), parent: native.parent! } });
      }
    }
    await ledger.save(await ledger.load(source.run));
  } finally { await unlock(); }
});

/** Read-only hydration remains available while write-authorized loads refuse a changing history head. */
test('native checkpoint load detects a concurrent history transition without rejecting read-only snapshots', async t => {
  const { workspace, source, client } = await repairFixture(t);
  const ledger = new RlmLedger(workspace);
  const decode = RlmBlobs.prototype.decode;
  let revision = 0;
  t.mock.method(RlmBlobs.prototype, 'decode', async function (this: RlmBlobs, text: string) {
    const state = await decode.call(this, text);
    await client.update(source.run, { description: `Concurrent metadata ${revision++}` });
    return state;
  });
  const unlock = await ledger.lease(source.run);
  try { await assert.rejects(ledger.load(source.run), { code: 'busy' }); }
  finally { await unlock(); }
  assert.equal((await ledger.load(source.run)).run, source.run);
  t.mock.restoreAll();
});

/** Stored input from another intent cannot change tools, transport, source data or declared coverage. */
test('foreign initial child contracts fail alone before inference', async t => {
  const { root, workspace, request, ids, client } = await repairFixture(t);
  const settings = (await new RlmLedger(workspace).load(request.source)).settings;
  const modes = ['question', 'scope', 'snapshot', 'relocated', 'endpoint', 'no-parent', 'reuse-current', 'reuse-initial', 'snapshot-policy', 'current-policy', 'components-none', 'components-other', 'components-many', 'allowance', 'call-limit'];
  const receipt = { run: 'foreign', call: 'foreign', state_digest: 'a'.repeat(64), call_digest: 'a'.repeat(64), scope_digest: 'a'.repeat(64), snapshot_digest: 'a'.repeat(64), policy_digest: 'a'.repeat(64), tokens_in: 0, tokens_out: 0, reserved_tokens: 0 };
  for (const mode of modes) await t.test(mode, async () => {
    const model = repairModel(ids[2]); let child = ''; let saved: unknown;
    const result = repaired(await repairRlm(request, { workspace, model, on_transition: async (name, run) => {
      if (name !== 'intent:part2') return;
      const intent = await repairJournal(client, run);
      child = intent.targets[2].child;
      let source_workspace: string | undefined;
      if (mode === 'snapshot') {
        source_workspace = join(root, 'different-source-copy');
        await cp(workspace, source_workspace, { recursive: true });
        await new PmClient({ pmRoot: source_workspace, noExtensions: true }).update(ids[2], { title: 'A different source revision' });
      }
      const parent = mode === 'relocated' ? ids[0] : run;
      const question = mode === 'question' ? 'An unrelated question' : JSON.stringify({ question: 'Explain all sources', part: { name: 'part2', question: request.parts[2].question }, dependencies: [] });
      const components = mode === 'components-none' ? undefined : mode === 'components-many' ? ['part2', 'extra'] : [mode === 'components-other' ? 'other' : 'part2'];
      const prepared = await prepareRlmRun(question, { workspace, source_workspace, model, scope: { ids: [mode === 'scope' ? ids[0] : ids[2]] }, components, question_item: parent, reuse_identity: { tool_policy: 'repair-v1', model_policy: 'original-model', consent: blobDigest(parent) }, settings: { ...settings, budget_tokens: intent.targets[2].allowance + (mode === 'allowance' ? 1 : 0), ...(mode === 'call-limit' ? { max_calls: settings.max_calls + 1 } : {}), ...(mode === 'endpoint' ? { endpoint: 'https://example.invalid' } : {}) } });
      const state = await prepared.ledger.load(prepared.run, '1');
      state.run = child; state.calls[0].id = child;
      if (mode === 'no-parent') delete state.calls[0].parent;
      if (mode === 'reuse-initial') state.reuse = receipt;
      if (mode === 'snapshot-policy') delete state.snapshot_only;
      await client.run('create', { options: { id: child, title: 'Foreign producer checkpoint', type: 'Task', parent: run, tags: 'rlm:call', rlmRun: child, rlmState: JSON.stringify(state), allowDuplicate: true } });
      if (mode === 'reuse-initial') delete state.reuse;
      if (mode === 'reuse-current') state.reuse = receipt;
      if (mode === 'current-policy') state.settings.model = 'different-model';
      if (['reuse-initial', 'reuse-current', 'current-policy'].includes(mode)) await client.run('update', { id: child, options: { rlmState: JSON.stringify(state) } });
      saved = (await client.get(child, { depth: 'full' })).item;
    } }));
    assert.deepEqual(result.gaps, ['part2']); assert.equal(result.reused, 2); assert.equal(model.requests.length, 0);
    assert.equal(result.components[2].reason, 'child_evidence');
    assert.deepEqual((await client.get(child, { depth: 'full' })).item, saved);
  });
});

/** A bad serialized child, including extreme counters, cannot remove other supported components. */
test('corrupt child records and extreme output counters remain isolated named gaps', async t => {
  const { workspace, request, client, ids } = await repairFixture(t);
  for (const stage of ['prepared', 'executed']) for (const mode of ['corrupt', 'counter', 'calls']) {
    const model = repairModel(ids[2]); let child = '';
    const result = repaired(await repairRlm(request, { workspace, model, on_transition: async (name, run) => {
      if (name !== `${stage}:part2`) return;
      child = await repairChild(client, run, 'part2');
      const state = await new RlmLedger(workspace).load(child);
      if (mode === 'counter') state.reserved_tokens = Number.MAX_SAFE_INTEGER;
      if (mode === 'calls') state.calls = Array.from({ length: state.settings.max_calls + 1 }, () => structuredClone(state.calls[0]));
      await client.run('update', { id: child, options: { rlmState: mode === 'corrupt' ? '{}' : JSON.stringify(state) } });
    } }));
    assert.deepEqual(result.gaps, ['part2']); assert.equal(result.reused, 2); assert.equal(result.budget.remaining, 0);
    assert.deepEqual(repaired(await resumeRepairRlm(result.run, { workspace, model })), result);
  }
});

/** Legacy roots that attached their first checkpoint after creation remain readable repair sources. */
test('legacy evidence checkpoints without an initial state remain repairable', async t => {
  const { workspace, request, client } = await repairFixture(t);
  const state = await new RlmLedger(workspace).load(request.source);
  const legacy = (await client.create({ title: 'Legacy evidence root', type: 'Task', parent: state.calls[0].parent!, tags: 'rlm:call' })).item.id;
  state.run = legacy; state.calls[0].id = legacy;
  await client.run('update', { id: legacy, options: { rlmRun: legacy, rlmState: JSON.stringify(state) } });
  const result = repaired(await repairRlm({ ...request, source: legacy, budget_tokens: 0 }, { workspace }));
  assert.equal(result.reused, 2); assert.deepEqual(result.gaps, ['part2']);
});

/** A replayed body never reuses the native revision observed before an ABA transition. */
test('controller history rejects ABA before writing even when the checkpoint body is restored', async t => {
  const { workspace, request, client } = await repairFixture(t);
  let run = ''; let original = ''; let injected = false;
  await assert.rejects(repairRlm({ ...request, budget_tokens: 0 }, { workspace, on_transition: async (name, id) => {
    if (name !== 'journal:before' || injected) return;
    injected = true; run = id;
    original = (await client.get(run, { depth: 'full' })).item.description!;
    await client.update(run, { description: 'A peer transition' });
    await client.update(run, { description: original });
  } }), { code: 'busy' });
  assert.equal(injected, true);
  assert.equal((await client.get(run, { depth: 'full' })).item.description, original);
  assert.equal(repaired(await resumeRepairRlm(run, { workspace })).reused, 2);
});

/** A peer can finish an intended native child before discovery; its usage still belongs to this budget. */
test('late native child completion reports its full charge exactly once', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  const original = await new RlmLedger(workspace).load(request.source);
  const model = repairModel(ids[2]);
  const result = repaired(await repairRlm(request, { workspace, model, on_transition: async (name, run) => {
    if (name !== 'intent:part2') return;
    const intent = await repairJournal(client, run);
    const target = intent.targets[2];
    const question = JSON.stringify({ question: original.question, part: { name: 'part2', question: request.parts[2].question }, dependencies: [] });
    const child = await prepareRlmRun(question, { workspace, model, snapshot_only: true, scope: { ids: [ids[2]] }, components: ['part2'], question_item: run, reuse_identity: { tool_policy: 'repair-v1', model_policy: 'original-model', consent: blobDigest(run) }, settings: { ...original.settings, budget_tokens: target.allowance } }, undefined, target.child);
    await child.engine.run();
  } }));
  const child = await new RlmLedger(workspace).load(await repairChild(client, result.run, 'part2'));
  assert.equal(result.budget.charged, child.reserved_tokens); assert.ok(result.budget.charged > 0);
  assert.equal(result.calls, child.calls.length); assert.equal(model.requests.length, 2);
  assert.deepEqual(repaired(await resumeRepairRlm(result.run, { workspace, model })), result);
});

/** Finite but understated totals cannot erase native inference already charged to a repair. */
test('native repair charges reject lower finite counters and inconsistent settled usage', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  for (const mode of ['total', 'step']) {
    const model = repairModel(ids[2]);
    const complete = repaired(await repairRlm(request, { workspace, model }));
    const child = complete.components[2].run;
    const state = await new RlmLedger(workspace).load(child);
    if (mode === 'total') state.reserved_tokens = 0;
    else { const step = state.calls[0].steps[0]; state.reserved_tokens -= step.reserved; step.reserved = 0; }
    await client.run('update', { id: child, options: { rlmState: JSON.stringify(state) } });
    const result = repaired(await resumeRepairRlm(complete.run, { workspace, model }));
    assert.deepEqual(result.gaps, ['part2']); assert.equal(result.reused, 2); assert.equal(result.budget.remaining, 0);
    assert.equal(result.components[2].reason, 'child_evidence'); assert.equal(model.requests.length, 2);
  }
});
