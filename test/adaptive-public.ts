/** Offline execution acceptance over a verified, read-only public source tracker. */
import { ScriptedModel } from './helpers.ts';
import { RlmError } from '../src/errors.ts';
import { RlmLedger } from '../src/ledger.ts';
import { replayRlm } from '../src/engine.ts';
import { adaptiveRlm } from '../src/adaptive.ts';
import { readCorpus } from '../src/environment.ts';
import { copyVerifiedRevision, publicSource } from './live.ts';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const repo = 'pm-lint';
const revision = 'f2c20efa78139f4071f3dd08d317bea05337fe28';
const visibility = execFileSync('gh', ['api', `repos/unbraind/${repo}`, '--jq', '.visibility'], { encoding: 'utf8' }).trim();
assert.equal(visibility, 'public');
const published = execFileSync('gh', ['api', `repos/unbraind/${repo}/commits/${revision}`], { encoding: 'utf8' });
assert.equal((JSON.parse(published) as { sha: string }).sha, revision);
const scratch = await fs.mkdtemp(join(tmpdir(), 'rlm-adaptive-public-'));
try {
  const source = await copyVerifiedRevision(publicSource(repo), revision, join(scratch, 'source'));
  const files: string[] = [];
  for (const entry of await fs.readdir(source.workspace, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
  }
  files.sort();
  const original = new Map<string, Buffer>();
  for (const file of files) {
    const contents = await fs.readFile(file);
    original.set(file, contents);
    await fs.chmod(file, 0o444);
  }
  const workspace = join(scratch, 'ledger');
  const client = new PmClient({ noExtensions: true, author: 'adaptive-validation', cwd: scratch, pmRoot: workspace });
  await client.init('adaptive-validation', { mergeFence: false, agentGuidance: 'skip', defaults: true });
  process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
  process.env.PATH = scratch;
  const corpus = await readCorpus(source.workspace);
  assert.ok(corpus.items.length >= 3);
  const selected = corpus.items.slice(0, 3);
  const structure = selected.map(item => ({ name: item.id, question: `What is the title of ${item.id}?` }));
  const options = { workspace, source_workspace: source.workspace, structure, remaining_tokens: 300000 };
  const model = new ScriptedModel(request => {
    const state = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1)) as { question: string; transcript: { observation: { data: { digest: string } } }[] };
    const part = (JSON.parse(state.question) as { parts: typeof structure }).parts[0];
    const item = selected.find(item => item.id === part.name)!;
    if (state.transcript.length === 0) {
      const text = JSON.stringify(item);
      const quotedTitle = JSON.stringify(item.title);
      const offset = text.indexOf(quotedTitle, text.indexOf('"title":') + 8);
      return JSON.stringify({ id: item.id, action: 'witness', start: offset, end: offset + quotedTitle.length });
    }
    return JSON.stringify({ action: 'answer', components: [{ component: part.name, status: 'supported', answer: item.title, reason: '', witnesses: [{ step: 0, digest: state.transcript[0].observation.data.digest }] }] });
  });
  const started = performance.now();
  const result = await adaptiveRlm('Return source titles with evidence', { ...options, model });
  assert.equal(result.status, 'complete');
  assert.equal(result.selected, 'components');
  const repeats = await adaptiveRlm('Return source titles with evidence', { ...options, model });
  assert.deepEqual(result.comparisons, repeats.comparisons);
  let verified = 0;
  for (const child of result.children) {
    const replay = await replayRlm(workspace, child.run);
    assert.equal(replay.components![0].answer, selected.find(item => item.id === replay.components![0].component)!.title);
    verified++;
  }
  const tiny = await adaptiveRlm('Return source titles with evidence', { ...options, model, remaining_tokens: 1 });
  assert.equal(tiny.calls, 0);
  const failed = await adaptiveRlm('Return source titles with evidence', { ...options, structure: structure.slice(0, 1), model: new ScriptedModel(() => { throw new RlmError('model', 'Scripted terminal refusal'); }) });
  const terminal = await new RlmLedger(workspace).load(failed.children[0].run);
  assert.equal(terminal.calls[0].failure?.code, 'model');
  assert.equal((await client.listAllComplete()).items.find(item => item.id === terminal.run)!.status, 'closed');
  const hash = createHash('sha256');
  for (const [file, originalBytes] of original) {
    assert.deepEqual(await fs.readFile(file), originalBytes);
    hash.update(file.slice(source.workspace.length)).update(originalBytes);
  }
  const measurement = { source: `unbraind/${repo}`, revision, source_items: corpus.items.length, source_json_bytes: Buffer.byteLength(JSON.stringify(corpus.items)), source_files: files.length, source_digest: hash.digest('hex'), source_files_read_only: true, source_files_unchanged: true, non_git: true, git_available_during_execution: false, fixture_only: true, external_inference_requests: 0, strategies_compared: result.comparisons.length, deterministic_repeat: true, declared_parts: structure.length, supported_parts: result.components.filter(part => part.status === 'supported').length, logical_calls: result.calls, model_steps: model.requests.length / 2, verified_child_replays: verified, accounting_charged: result.budget.charged, accounting_remaining: result.budget.remaining, report_json_bytes: Buffer.byteLength(JSON.stringify(result)), tiny_budget: tiny.budget.declared, tiny_budget_calls: tiny.calls, tiny_budget_deferred: tiny.components.filter(part => part.status === 'deferred').length, terminal_failed_children: terminal.calls.filter(call => call.failure !== undefined).length, elapsed_ms: Math.round(performance.now() - started) };
  await fs.writeFile('docs/adaptive-validation.json', JSON.stringify(measurement, null, 2) + '\n');
  console.log(JSON.stringify(measurement, null, 2));
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
