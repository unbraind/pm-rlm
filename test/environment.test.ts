import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { createRlmContext, matches, parseFilter, partitionItems } from '../src/environment.ts';
import { assertLedgerPrivacy, estimateTokens, integer, record, text } from '../src/errors.ts';
import { tracker } from './helpers.ts';

/** Cover every environment surface with real SDK data and an intersected private scope. */
test('environment operations preserve scope, structured fields, complete receipts and immutable views', async t => {
  const { workspace, client } = await tracker(t);
  const parent = (await client.create({ title: 'Parent', type: 'Epic' })).item;
  const a = (await client.create({ title: 'Coverage A', type: 'Issue', parent: parent.id, tags: 'test', description: 'abcdef', acceptanceCriteria: 'coverage' })).item;
  const b = (await client.create({ title: 'Other', type: 'Task' })).item;
  await client.comments(a.id, { add: 'Evidence from real SDK' });
  const ctx = await createRlmContext({ workspace, scope: { ids: [a.id] }, budget: 100000 });
  const list = ctx.list({ type: 'Issue', status: 'open', parent: parent.id, tag: 'test', text: 'coverage', ids: [a.id] });
  assert.equal(list.data.length, 1); assert.equal(list.complete_list.item_count, 3);
  assert.deepEqual(ctx.list({ type: 'Task' }).data, []);
  assert.equal(ctx.search('COVERAGE', 1).data[0].id, a.id);
  assert.deepEqual(ctx.search('missing', 1).data, []);
  assert.equal(ctx.get(a.id).data.title, 'Coverage A');
  assert.equal(ctx.peek(a.id, 'description', 1, 4).data, 'bcd');
  assert.equal(ctx.peek(a.id, 'tags', 0, 100).data, '["test"]');
  assert.equal((await ctx.history(a.id, { start: 0, end: 100 })).data.length, 2);
  assert.ok(ctx.partition({}, 1000).data.length > 0);
  for (const operation of [() => ctx.get(b.id), () => ctx.get(a.id, ['absent']), () => ctx.peek(a.id, 'absent', 0, 1), () => ctx.peek(a.id, 'title', -1, 0), () => ctx.search('', 1), () => ctx.search('a', 0)]) assert.throws(operation);
  await assert.rejects(ctx.history(b.id, { start: 0, end: 2 }));
  assert.deepEqual(parseFilter({}), {});
  for (const filter of [{ typo: 'x' }, { ids: 1 }, { status: '' }]) assert.throws(() => parseFilter(filter));
  assert.equal(matches(a, { status: 'closed' }), false);
  assert.equal(matches(a, { parent: b.id }), false);
  assert.equal(matches(a, { tag: 'absent' }), false);
  assert.equal(matches(a, { ids: [] }), false);
  assert.throws(() => partitionItems(list.data, 1), { code: 'budget' });
  assert.deepEqual(partitionItems([], 100), []);
});

/** A malformed source item or broken history cannot be silently omitted. */
test('incomplete corpus and corrupt history fail closed without SDK mocks', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'History' })).item;
  const ctx = await createRlmContext({ workspace, budget: 100000 });
  await appendFile(getHistoryPath(workspace, item.id), '\n{"broken":true}\n');
  await assert.rejects(ctx.history(item.id, { start: 0, end: 10 }));
  await mkdir(join(workspace, 'tasks', 'unreadable.toon'));
  await assert.rejects(createRlmContext({ workspace, budget: 10000 }));
});

/** Primitive validators and privacy refusals never print rejected contents. */
test('public validation rejects unsafe numbers, shapes and local credential disclosures', async t => {
  const { workspace } = await tracker(t);
  for (const bad of [NaN, Infinity, 1.1, -1, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => integer(bad, 0));
  for (const bad of [[], null, 1]) assert.throws(() => record(bad));
  assert.deepEqual(record({ ok: true }), { ok: true });
  assert.equal(text('valid'), 'valid');
  assert.throws(() => text(''));
  assert.equal(estimateTokens(''), 1); assert.equal(estimateTokens('🎉'), 4);
  const key = 'RLM_TEST_SECRET'; const previous = process.env[key];
  const privateKey = randomUUID();
  process.env[key] = privateKey;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  assert.throws(() => assertLedgerPrivacy(privateKey, workspace, key), { code: 'invalid' });
  assert.throws(() => assertLedgerPrivacy(workspace, workspace, key));
  assertLedgerPrivacy('public', workspace, key);
  delete process.env[key]; assertLedgerPrivacy('public', workspace, key);
});
