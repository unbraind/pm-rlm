/** Executed from installed npm/Bun consumers; imports only their actual packed public SDK. */
import assert from 'node:assert/strict';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { parseRepairCheckpoint, replayRlm, repairRlm, resumeRepairRlm, resumeRlm, RlmLedger, RlmTranscriptError, runRlm } from '../index.ts';
import type { ModelRequest, RlmModel, RlmRepairResult } from '../index.ts';

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
const source = await runRlm('Explain three budget sources', { workspace, model: sourceModel, scope: { ids }, components: parts.map(part => part.name), settings: { budget_tokens: 1000000, endpoint: 'http://127.0.0.1:1' } });
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
const receipts: RlmRepairResult[] = [result];
const complete = await repairRlm({ source: source.run, parts, budget_tokens: 1000000 }, { workspace, model });
assert.equal(complete.status, 'complete');
if (complete.status !== 'complete') throw new Error('Expected completed native fixture');
let staleRun = '';
await assert.rejects(repairRlm({ source: complete.run, parts, budget_tokens: 0 }, { workspace, model, on_transition: (phase, id) => {
  if (phase === 'created') { staleRun = id; throw new Error('Synthetic stopped reuse plan'); }
} }));
await client.update(complete.components[2].run, { tags: 'foreign' });
const unavailable = await resumeRepairRlm(staleRun, { workspace, model });
assert.ok(unavailable.status === 'partial'); assert.equal(unavailable.reused, 2); assert.deepEqual(unavailable.gaps, ['budget2']);
assert.equal(unavailable.components[2].disposition, 'gap'); assert.ok(unavailable.components[2].remedy.length > 0);
receipts.push(unavailable);
let pendingRun = '';
const transportFailure: RlmModel = { name: model.name, complete: async () => { throw new Error('Synthetic reserved-step interruption'); } };
await assert.rejects(repairRlm({ source: source.run, parts, budget_tokens: 1000000 }, { workspace, model: transportFailure, on_transition: (phase, id) => { if (phase === 'created') pendingRun = id; } }));
const description = (await client.get(pendingRun, { depth: 'full' })).item.description!;
const pending = parseRepairCheckpoint(JSON.parse(description.split('\n').slice(1).join('\n')));
const child = pending.targets[0].child;
const original = await new RlmLedger(workspace).load(child);
let unexpected = 0;
const forbidden: RlmModel = { name: model.name, complete: async () => { unexpected++; throw new Error('Untrusted state reached the model'); } };
for (const mode of ['reservation', 'prompt']) {
  const state = structuredClone(original);
  if (mode === 'reservation') { state.calls[0].steps[0].reserved = 0; state.reserved_tokens = 0; }
  else {
    const prompt = state.calls[0].steps[0].prompt;
    state.calls[0].steps[0].prompt = prompt.replace('Explain evidence 0', 'Invent! evidence 0');
    assert.notEqual(state.calls[0].steps[0].prompt, prompt); assert.equal(Buffer.byteLength(state.calls[0].steps[0].prompt), Buffer.byteLength(prompt));
  }
  await client.run('update', { id: child, options: { rlmState: JSON.stringify(state) } });
  await client.update(pendingRun, { description });
  await assert.rejects(resumeRlm(workspace, child, forbidden), (error: unknown) => error instanceof RlmTranscriptError && error.code === 'replay' && error.remedy.length > 0);
  const refused = await resumeRepairRlm(pendingRun, { workspace, model: forbidden });
  assert.ok(refused.status === 'partial'); assert.equal(refused.components[0].reason, 'child_evidence'); assert.deepEqual(refused.gaps, ['budget0', 'budget2']);
  assert.equal(unexpected, 0); receipts.push(refused);
}
/** Keep each packed receipt independently resumable across every CLI transport. */
async function authorityFixture() {
  const authority = await repairRlm({ source: source.run, parts, budget_tokens: 20000 }, { workspace, model });
  assert.equal(authority.status, 'complete');
  if (authority.status !== 'complete') throw new Error('Expected completed identity fixture');
  const authoritative = parseRepairCheckpoint(JSON.parse((await client.get(authority.run, { depth: 'full' })).item.description!.slice('RLM repair v1\n'.length)));
  return { authority, authoritative, authorizedRequests: requests };
}
const identityFixture = await authorityFixture();
for (let attempt = 0; attempt < 2; attempt++) {
  const { authority, authoritative, authorizedRequests } = identityFixture;
  const imported = structuredClone(authoritative);
  imported.targets[0].child = `${authority.run}-replacement${attempt}`; imported.targets[0].phase = 'pending';
  await client.update(authority.run, { description: 'RLM repair v1\n' + JSON.stringify(imported) });
  const refused = await resumeRepairRlm(authority.run, { workspace, model });
  assert.equal(refused.status, 'partial');
  if (refused.status !== 'partial') throw new Error('Expected isolated identity gap');
  assert.deepEqual(refused.gaps, ['budget0']); assert.equal(refused.components[0].reason, 'child_identity');
  assert.equal(refused.budget.charged, authority.budget.charged); assert.equal(requests, authorizedRequests);
  receipts.push(refused);
}
{
  const { authority, authoritative, authorizedRequests } = await authorityFixture();
  const older = structuredClone(authoritative);
  older.targets[0].child = ''; older.targets[0].allowance = 0; older.targets[0].phase = 'gap'; older.targets[0].reason = 'budget';
  await client.update(authority.run, { description: 'RLM repair v1\n' + JSON.stringify(older) });
  const restored = await resumeRepairRlm(authority.run, { workspace, model });
  assert.equal(restored.status, 'complete');
  if (restored.status !== 'complete') throw new Error('Expected recovered canonical child');
  assert.equal(restored.budget.charged, authority.budget.charged); assert.equal(requests, authorizedRequests);
  receipts.push(restored);
}
{
  const { authority, authoritative, authorizedRequests } = await authorityFixture();
  const nativeLedger = new RlmLedger(workspace);
  const nativeChild = authoritative.targets[0].child;
  const nativeBirth = await nativeLedger.load(nativeChild, '1');
  await client.run('update', { id: nativeChild, options: { rlmState: JSON.stringify(nativeBirth) } });
  await assert.rejects(resumeRlm(workspace, nativeChild, forbidden), (error: unknown) => error instanceof RlmTranscriptError && error.code === 'replay' && error.remedy.length > 0);
  const nativeReplay = await resumeRepairRlm(authority.run, { workspace, model: forbidden });
  assert.equal(nativeReplay.status, 'partial');
  if (nativeReplay.status !== 'partial') throw new Error('Expected native history gap');
  assert.deepEqual(nativeReplay.gaps, ['budget0']); assert.equal(nativeReplay.components[0].reason, 'child_evidence');
  assert.equal(nativeReplay.budget.charged, nativeReplay.budget.limit); assert.equal(unexpected, 0); assert.equal(requests, authorizedRequests);
  receipts.push(nativeReplay);
}
let plainRequests = 0;
const plainModel: RlmModel = { name: 'packed-refusal-protocol', complete: async () => ({ text: JSON.stringify(plainRequests++ === 0 ? { action: 'get', id: 'outside', fields: [] } : { action: 'finish', answer: 'Retained plain answer' }), tokens_in: 24, tokens_out: 16 }) };
const plain = await runRlm('Plain execution refusal', { workspace, scope: { ids }, model: plainModel, settings: { endpoint: 'http://127.0.0.1:1' } });
const plainState = await new RlmLedger(workspace).load(plain.run);
(plainState.calls[0].steps[0].observation as { reason: string }).reason = 'Forged corrective text';
await client.run('update', { id: plain.run, options: { rlmState: JSON.stringify(plainState) } });
await assert.rejects(replayRlm(workspace, plain.run), (error: unknown) => error instanceof RlmTranscriptError && error.code === 'replay' && error.remedy.length > 0);
assert.equal(plainRequests, 2);
let parseRequests = 0;
const parseModel: RlmModel = { name: 'packed-parse-refusal', complete: async () => ({ text: parseRequests++ === 0 ? 'invalid action JSON' : '{"action":"finish","answer":"Retained parse answer"}', tokens_in: 24, tokens_out: 16 }) };
const parsed = await runRlm('Parse refusal integrity', { workspace, scope: { ids }, model: parseModel, settings: { endpoint: 'http://127.0.0.1:1' } });
const parsedState = await new RlmLedger(workspace).load(parsed.run);
(parsedState.calls[0].steps[0].observation as { remedy?: string }).remedy = 'Forged parse remedy';
await client.run('update', { id: parsed.run, options: { rlmState: JSON.stringify(parsedState) } });
for (const read of [() => replayRlm(workspace, parsed.run), () => resumeRlm(workspace, parsed.run, forbidden)]) {
  await assert.rejects(read, (error: unknown) => error instanceof RlmTranscriptError && error.code === 'replay' && error.remedy.length > 0);
}
assert.equal(parseRequests, 2); assert.equal(unexpected, 0);
console.log(JSON.stringify(receipts));
