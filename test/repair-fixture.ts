import assert from 'node:assert/strict';
import { repairRlm } from '../src/repair.ts';
import { runRlm } from '../src/engine.ts';
import { ScriptedModel, tracker } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { ModelRequest, RlmSettings, RlmState, RlmModel } from '../src/types.ts';
import type { PmClient } from '@unbrained/pm-cli/sdk';
import { parseRepairCheckpoint } from '../src/repair-contract.ts';
import type { RlmRepairPart, RlmRepairResult, RlmRepairSkipped, RlmRepairCheckpoint, RlmRepairRequest } from '../src/repair-contract.ts';

/** Decode the native model prompt shared by all deterministic repair fixtures. */
export function repairPrompt(request: ModelRequest): { transcript: { observation: { data: { digest: string } } }[]; question: string } {
  return JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1));
}
/** Deterministic evidence adapter, replacing inference only and reading actual witness receipts. */
export function repairModel(id: string, component?: string): ScriptedModel {
  return new ScriptedModel(request => {
    const input = repairPrompt(request);
    const part = component ?? (JSON.parse(input.question) as { part: { name: string } }).part.name;
    return JSON.stringify(input.transcript.length === 0 ? { action: 'witness', id, start: 0, end: 20 } : { action: 'answer', components: [{ component: part, status: 'supported', answer: `answer ${part}`, reason: '', witnesses: [{ step: 0, digest: input.transcript[0].observation.data.digest }] }] });
  });
}
/** Create a partial native answer and independent source rows in a real non-git tracker. */
export async function repairFixture(t: TestContext, size = 3, settings: Partial<RlmSettings> = {}) {
  const setup = await tracker(t);
  const ids: string[] = [];
  for (let index = 0; index < size; index++) ids.push((await setup.client.create({ title: `Source ${index}`, type: 'Issue', parent: 'none', tags: 'source', description: `line ${index}\r\n content ` })).item.id);
  const parts: RlmRepairPart[] = ids.map((id, index) => ({ name: `part${index}`, question: `Explain source ${index}`, depends_on: [], sources: [id] }));
  const model = new ScriptedModel(request => {
    const input = repairPrompt(request);
    return JSON.stringify(input.transcript.length < size - 1 ? { action: 'witness', id: ids[input.transcript.length], start: 0, end: 20 } : { action: 'answer', components: parts.map((part, index) => ({ component: part.name, status: index === size - 1 ? 'unsupported' : 'supported', answer: index === size - 1 ? '' : `answer ${part.name}`, reason: index === size - 1 ? 'missing evidence' : '', witnesses: index === size - 1 ? [] : [{ step: index, digest: input.transcript[index].observation.data.digest }] })) });
  });
  const source = await runRlm('Explain all sources', { workspace: setup.workspace, model, components: parts.map(part => part.name), scope: { ids }, settings: { budget_tokens: 1000000, context_tokens: 131072, ...settings } });
  return { ...setup, source, parts, ids, model, request: { source: source.run, parts, budget_tokens: 1000000 } };
}
/** Narrow the foreign-row union for test assertions without weakening production types. */
export function repaired(result: RlmRepairResult | RlmRepairSkipped): RlmRepairResult {
  if (result.status === 'skipped') throw new Error('Unexpected foreign row');
  return result;
}
/** Resolve a durable child identity through the same SDK and checkpoint parser as recovery. */
export async function repairChild(client: PmClient, run: string, component: string): Promise<string> {
  return (await repairJournal(client, run)).targets.find(target => target.component === component)!.child;
}
/** Read the real controller through the native SDK and the package checkpoint parser. */
export async function repairJournal(client: PmClient, run: string): Promise<RlmRepairCheckpoint> {
  const item = (await client.get(run, { depth: 'full' })).item;
  return parseRepairCheckpoint(JSON.parse(item.description!.slice('RLM repair v1\n'.length)));
}

/** Route independent fixture components to their own native witness source. */
export function repairPartsModel(ids: string[]): ScriptedModel {
  return new ScriptedModel(async input => {
    const name = (JSON.parse(repairPrompt(input).question) as { part: { name: string } }).part.name;
    return (await repairModel(ids[Number(name.slice(4))]).complete(input)).text;
  });
}

/** Produce completed native evidence with optional declared downstream invalidation. */
export async function completedRepairFixture(t: TestContext, size = 3, dependent = false) {
  const setup = await repairFixture(t, size);
  if (dependent) setup.request.parts[0].depends_on = [setup.request.parts.at(-1)!.name];
  const model = repairPartsModel(setup.ids);
  const complete = repaired(await repairRlm(setup.request, { workspace: setup.workspace, model }));
  return { ...setup, model, complete };
}
/** Import native progress through the real SDK for corruption and replay tests. */
export async function writeNativeCheckpoint(client: PmClient, id: string, state: RlmState): Promise<void> {
  await client.run('update', { id, options: { rlmState: JSON.stringify(state) } });
}

/** Crash exactly at one durable boundary and read the resulting intent through the SDK. */
export async function interruptedRepair(workspace: string, request: RlmRepairRequest, model: RlmModel, stop: string, client: PmClient) {
  let run = ''; let stopped = false;
  await assert.rejects(repairRlm(request, { workspace, model, on_transition: (name, id) => {
    if (name === 'created') run = id;
    if (name === stop) { stopped = true; throw new Error('Interrupted native transition'); }
  } }));
  assert.ok(stopped, 'The declared transition must actually be reached');
  return { run, journal: await repairJournal(client, run) };
}
