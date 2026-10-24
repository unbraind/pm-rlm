/** Measure paired evidence on verified public tracker bytes, without external inference. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { blobDigest } from '../src/blobs.ts';
import { readCorpus } from '../src/environment.ts';
import { reconcileRlm } from '../src/reconcile.ts';
import { replayRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { copyVerifiedRevision, publicSource } from './live.ts';
import { ScriptedModel } from './helpers.ts';
import type { RlmReconcileOptions } from '../src/reconcile.ts';

const repository = 'unbraind/pm-lint';
const revision = 'f2c20efa78139f4071f3dd08d317bea05337fe28';
/** Read independently published GitHub metadata before selecting any corpus. */
function github(field: string): string { return execFileSync('gh', ['api', `repos/${repository}${field === '.sha' ? '/commits/' + revision : ''}`, '--jq', field], { encoding: 'utf8' }).trim(); }
assert.equal(github('.visibility'), 'public');
assert.equal(github('.sha'), revision);
const scratch = await fs.mkdtemp(join(tmpdir(), 'rlm-paired-public-'));
try {
  const exported = await copyVerifiedRevision(publicSource('pm-lint'), revision, join(scratch, 'published'));
  const contents = new Map<string, Buffer>();
  const records = await fs.readdir(exported.workspace, { recursive: true, withFileTypes: true });
  for (const entry of records.filter(entry => entry.isFile())) {
    const file = join(entry.parentPath, entry.name);
    contents.set(file, await fs.readFile(file));
    await fs.chmod(file, 0o444);
  }
  const workspace = join(scratch, 'execution');
  const sdk = new PmClient({ cwd: scratch, pmRoot: workspace, author: 'paired-validation', noExtensions: true });
  await sdk.init('paired-validation', { defaults: true, mergeFence: false, agentGuidance: 'skip' });
  const priorPath = process.env.PATH;
  process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
  process.env.PATH = scratch;
  const corpus = await readCorpus(exported.workspace);
  const selected = corpus.items.slice(0, 3);
  assert.equal(selected.length, 3);
  const structure = selected.map(item => ({ name: item.id, question: `Return the documented title of ${item.id}` }));
  const options: RlmReconcileOptions = {
    workspace, source_workspace: exported.workspace, structure, reserved_tokens: 300000,
    arms: [{ groups: [structure.map(part => part.name)], budget_tokens: 150000 }, { groups: structure.map(part => [part.name]), budget_tokens: 150000 }],
  };
  const model = new ScriptedModel(request => {
    const current = JSON.parse(request.prompt.split('\n').at(-1)!) as { question: string; transcript: { observation: { data: { digest: string } } }[] };
    const parts = (JSON.parse(current.question) as { parts: typeof structure }).parts;
    if (current.transcript.length < parts.length) {
      const item = selected.find(item => item.id === parts[current.transcript.length].name)!;
      const serialized = JSON.stringify(item);
      const titleBytes = JSON.stringify(item.title);
      const start = serialized.indexOf(titleBytes, serialized.indexOf('"title":') + 8);
      return JSON.stringify({ action: 'witness', id: item.id, start, end: start + titleBytes.length });
    }
    return JSON.stringify({ action: 'answer', components: parts.map((part, index) => ({ component: part.name, status: 'supported', answer: selected.find(item => item.id === part.name)!.title + (parts.length === 1 && part.name === selected[0].id ? ' (deliberate alternative)' : ''), reason: '', witnesses: [{ step: index, digest: current.transcript[index].observation.data.digest }] })) });
  });
  const start = performance.now();
  const result = await reconcileRlm('Compare documented titles', { ...options, model });
  assert.equal(result.status, 'complete');
  assert.equal(result.comparisons.filter(entry => entry.relation === 'disagreement').length, 1);
  const steps = model.requests.length;
  let replays = 0;
  let witnesses = 0;
  for (const arm of result.arms) for (const group of arm.groups) {
    assert.deepEqual((await replayRlm(workspace, group.run)).components, group.components);
    const checkpoint = await new RlmLedger(workspace).load(group.run);
    assert.equal(JSON.stringify(checkpoint.snapshot), JSON.stringify(corpus.items));
    for (const component of group.components) witnesses += component.witnesses.length;
    replays++;
  }
  assert.equal(model.requests.length, steps);
  let tinyRefusals = 0;
  try { await reconcileRlm('Compare documented titles', { ...options, model, reserved_tokens: 1 }); }
  catch (error) { assert.equal((error as { code: string }).code, 'budget'); tinyRefusals++; }
  let serializedSource = '';
  for (const [file, before] of [...contents].sort(([a], [b]) => a.localeCompare(b))) {
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal((await fs.stat(file)).mode & 0o222, 0);
    serializedSource += relative(exported.workspace, file) + '\0' + before.toString('utf8');
  }
  process.env.PATH = priorPath;
  const report = {
    source: repository, revision, source_items: corpus.items.length, source_json_bytes: Buffer.byteLength(JSON.stringify(corpus.items)), source_files: contents.size,
    source_digest: blobDigest(serializedSource), source_files_unchanged: true, source_files_read_only: true, non_git: true, git_available_during_execution: false,
    protocol_fixture: true, external_inference_requests: 0, intentional_disagreements: 1, comparisons: result.comparisons.length, equal_text: result.comparisons.filter(entry => entry.relation === 'equal_text').length,
    boundary_items: result.boundary.items, boundary_digest: result.boundary.digest, logical_calls: result.arms.flatMap(arm => arm.groups).reduce((sum, group) => sum + group.calls, 0),
    model_steps: steps, replay_verified_runs: replays, witness_references: witnesses, validation_inference_requests: model.requests.length - steps,
    budget: result.budget, arm_charges: result.arms.map(arm => arm.charged), report_json_bytes: Buffer.byteLength(JSON.stringify(result)), tiny_budget_refusals: tinyRefusals,
    elapsed_ms: Math.round(performance.now() - start),
  };
  await fs.writeFile('docs/reconciliation-validation.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
