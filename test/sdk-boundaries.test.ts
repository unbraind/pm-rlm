import assert from 'node:assert/strict';
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { getHistoryPath, listMutationEvents } from '@unbrained/pm-cli/sdk';
import { RlmBlobs } from '../src/blobs.ts';
import { createRlmContext } from '../src/environment.ts';
import { RlmLedger } from '../src/ledger.ts';
import { tracker } from './helpers.ts';

/** Run every SDK regression without Git discovery or a git executable. */
async function isolatedTracker(t: TestContext) {
  const setup = await tracker(t);
  const previousPath = process.env.PATH;
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  });
  process.env.PATH = setup.root;
  process.env.GIT_CEILING_DIRECTORIES = dirname(setup.root);
  return setup;
}

/** Corrupt valid JSON without changing size or mtime after the real SDK indexes it. */
async function corruptIndexedHistory(workspace: string, id: string): Promise<void> {
  const path = getHistoryPath(workspace, id);
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  await utimes(path, timestamp, timestamp);
  const page = await listMutationEvents({ pmRoot: workspace, item: id, full: true });
  assert.equal(page.source, 'derived_index');
  assert.ok(page.events.some(event => event.item_id === id));
  const before = await readFile(path, 'utf8');
  const metadata = await stat(path);
  const after = before.replace('Cache source', 'Cache tamper');
  assert.notEqual(after, before);
  assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
  for (const line of after.trim().split('\n')) JSON.parse(line);
  await writeFile(path, after);
  await utimes(path, metadata.atime, metadata.mtime);
  const corrupted = await stat(path);
  assert.equal(corrupted.mtimeMs, metadata.mtimeMs);
  assert.equal(corrupted.size, metadata.size);
}

/** A frozen scope keeps literal commas and never observes later live item updates. */
test('SDK adoption preserves frozen exact filter semantics', async t => {
  const { workspace, client } = await isolatedTracker(t);
  const item = (await client.create({ title: 'Cache source', type: 'Issue', tags: 'first,second' })).item;
  const context = await createRlmContext({ workspace, scope: { ids: [item.id] }, budget: 100000 });
  assert.deepEqual(context.list({ type: 'Issue,Task' }).data, []);
  assert.deepEqual(context.list({ status: 'open,closed' }).data, []);
  assert.deepEqual(context.list({ tag: 'first,second' }).data, []);
  assert.equal(context.list({ type: 'Issue', status: 'open', tag: 'first' }).data.length, 1);
  await client.update(item.id, { title: 'Live replacement' });
  assert.equal(context.get(item.id).data.title, 'Cache source');
  assert.equal(context.list({ text: 'Cache source' }).data.length, 1);
  assert.deepEqual(context.list({ text: 'Live replacement' }).data, []);
});

/** A primed event cache cannot authorize unverified immutable history reads. */
test('history rejects same-size corruption after priming the SDK event cache', async t => {
  const { workspace, client } = await isolatedTracker(t);
  const item = (await client.create({ title: 'Cache source' })).item;
  const context = await createRlmContext({ workspace, budget: 100000 });
  assert.equal((await context.history(item.id, { start: 0, end: 10 })).data.length, 1);
  await corruptIndexedHistory(workspace, item.id);
  const remaining = context.remaining;
  await assert.rejects(context.history(item.id, { start: 0, end: 10 }), { code: 'incomplete' });
  assert.equal(context.remaining, remaining);
});

/** Collection must verify authoritative history before making a destructive reachability decision. */
test('collection retains orphans when primed SDK event cache history is corrupt', async t => {
  const { workspace, client } = await isolatedTracker(t);
  const item = (await client.create({ title: 'Cache source' })).item;
  const ledger = new RlmLedger(workspace);
  assert.deepEqual(await ledger.gc(), { removed: 0, bytes: 0 });
  const orphan = await new RlmBlobs(workspace).put('Preserve until verified');
  const path = join(workspace, 'rlm-blobs', `${orphan}.json`);
  const before = await readFile(path);
  await corruptIndexedHistory(workspace, item.id);
  await assert.rejects(ledger.gc(), { code: 'incomplete' });
  assert.deepEqual(await readFile(path), before);
});
