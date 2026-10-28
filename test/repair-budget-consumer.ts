/** Executed from installed npm/Bun consumers; imports only their actual packed public SDK. */
import assert from 'node:assert/strict';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { parseRepairCheckpoint, repairRlm, resumeRepairRlm, runRlm } from '../index.ts';
import type { ModelRequest, RlmModel } from '../index.ts';

const workspace = process.env.PM_PATH!;
const client = new PmClient({ pmRoot: workspace, author: 'budget-consumer', noExtensions: true });
const ids: string[] = [];
for (let index = 0; index < 3; index++) ids.push((await client.create({ title: `Budget source ${index}`, parent: 'none', description: 'Public synthetic evidence' })).item.id);
const parts = ids.map((id, index) => ({ name: `budget${index}`, question: `Explain evidence ${index}`, sources: [id], depends_on: [] }));
/** Decode the model protocol without accessing any host installation internals. */
function protocol(request: ModelRequest): { question: string; transcript: { observation: { data: { digest: string } } }[] } {
  return JSON.parse(request.prompt.substring(request.prompt.lastIndexOf('\n') + 1));
}
const sourceModel: RlmModel = { name: 'packed-budget-protocol', complete: async request => {
  const prompt = protocol(request);
  const action = prompt.transcript.length < 2 ? { action: 'witness', id: ids[prompt.transcript.length], start: 0, end: 8 }
    : { action: 'answer', components: parts.map((part, index) => ({ component: part.name, status: index < 2 ? 'supported' : 'unsupported', answer: index < 2 ? part.name : '', reason: index < 2 ? '' : 'Missing evidence', witnesses: index < 2 ? [{ step: index, digest: prompt.transcript[index].observation.data.digest }] : [] })) };
  return { text: JSON.stringify(action), tokens_in: 24, tokens_out: 16 };
} };
const source = await runRlm('Explain three budget sources', { workspace, model: sourceModel, scope: { ids }, components: parts.map(part => part.name), settings: { budget_tokens: 1000000 } });
await client.update(ids[0], { description: 'Updated evidence invalidates the first source' });
let requests = 0;
const model: RlmModel = { name: sourceModel.name, complete: async request => {
  requests++;
  const prompt = protocol(request);
  const part = (JSON.parse(prompt.question) as { part: { name: string } }).part.name;
  const index = parts.findIndex(entry => entry.name === part);
  return { text: JSON.stringify(prompt.transcript.length === 0 ? { action: 'witness', id: ids[index], start: 0, end: 8 }
    : { action: 'answer', components: [{ component: part, status: 'supported', answer: part, reason: '', witnesses: [{ step: 0, digest: prompt.transcript[0].observation.data.digest }] }] }), tokens_in: 24, tokens_out: 16 };
} };
let run = ''; let interrupted = false;
await assert.rejects(repairRlm({ source: source.run, parts, budget_tokens: 1000000 }, { workspace, model, on_transition: (phase, id) => {
  run = id;
  if (phase === 'intent:budget2') { interrupted = true; throw new Error('Synthetic crash after durable intent'); }
} }));
assert.equal(interrupted, true);
const journal = parseRepairCheckpoint(JSON.parse((await client.get(run, { depth: 'full' })).item.description!.split('\n').slice(1).join('\n')));
await client.update(journal.targets[0].child, { tags: 'foreign' });
const result = await resumeRepairRlm(run, { workspace, model });
assert.ok(result.status === 'partial');
assert.deepEqual(result.gaps, ['budget0', 'budget2']);
assert.equal(result.components[1].answer, 'budget1'); assert.equal(result.budget.remaining, 0); assert.equal(requests, 2);
assert.equal((await client.listAllComplete()).items.some(item => item.id === journal.targets[2].child), false);
console.log(JSON.stringify(result));
