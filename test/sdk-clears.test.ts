import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareRlmRun } from '../src/engine.ts';
import { repairRlm } from '../src/repair.ts';
import { repairFixture, repaired } from './repair-fixture.ts';

/** Native question and repair roots stay unparented when a caller has saved focus. */
test('question and repair roots explicitly clear parent through the typed SDK', async t => {
  const { workspace, client, request, ids } = await repairFixture(t);
  await client.focus(ids[0]);
  const prepared = await prepareRlmRun('Independent question', { workspace });
  const question = (await client.get((await prepared.ledger.load(prepared.run)).calls[0].parent!, { depth: 'full' })).item;
  assert.equal(question.parent, undefined);
  const repair = repaired(await repairRlm({ ...request, budget_tokens: 0 }, { workspace }));
  assert.equal((await client.get(repair.run, { depth: 'full' })).item.parent, undefined);
});
