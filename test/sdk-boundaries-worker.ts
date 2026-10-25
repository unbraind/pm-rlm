import assert from 'node:assert/strict';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { createRlmContext, readCorpus } from '../dist/src/environment.js';
import { RlmLedger } from '../dist/src/ledger.js';

const [workspace, ledgerRoot] = process.argv.slice(2);
assert.ok(workspace && ledgerRoot);
const corpus = await readCorpus(workspace);
assert.ok(corpus.items.length > 0);
const context = await createRlmContext({ workspace, budget: 100000000 });
const first = corpus.items[0];
const results: Record<string, unknown> = {
  corpus,
  list: context.list(),
  exact: context.list({ type: first.type, status: first.status }),
  literal: context.list({ type: `${first.type},Task`, status: `${first.status},open` }),
  search: context.search(first.title, 3),
  get: context.get(first.id, ['title', 'status']),
  peek: context.peek(first.id, 'title', 0, 12),
  history: await context.history(first.id, { start: 0, end: 1000 }),
  partition: context.partition({ ids: [first.id] }, 2000),
  count: context.aggregate({ action: 'count', filter: {} }),
};
const client = new PmClient({ pmRoot: ledgerRoot, author: 'sdk-parity', noExtensions: true });
await client.init('sdk-parity', { defaults: true, agentGuidance: 'skip', mergeFence: false });
const ledger = new RlmLedger(ledgerRoot);
const release = await ledger.lease('public-parity');
try {
  await assert.rejects(new RlmLedger(ledgerRoot).lease('public-parity'), { code: 'busy' });
  results.lease_exclusion = 'busy';
} finally { await release(); }
await release();
const reacquired = await ledger.lease('public-parity');
await reacquired();
results.lease_reacquisition = true;
results.collection = await ledger.gc();
console.log(JSON.stringify(results));
