import { replaceCheckpointFixture } from './checkpoint-fixture.ts';
/** Reproducible offline coverage acceptance using a pinned, independently verified public tracker. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { copyVerifiedRevision, publicSource } from './live.ts';
import { readCorpus } from '../src/environment.ts';
import { runRlm, replayRlm, evidenceRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { ScriptedModel } from './helpers.ts';
import type { RlmAnswerComponent } from '../src/types.ts';

const repo = 'pm-lint';
const revision = 'f2c20efa78139f4071f3dd08d317bea05337fe28';
assert.equal(JSON.parse(execFileSync('gh', ['repo', 'view', `unbraind/${repo}`, '--json', 'visibility'], { encoding: 'utf8' })).visibility, 'PUBLIC');
assert.equal(execFileSync('gh', ['api', `repos/unbraind/${repo}/commits/${revision}`, '--jq', '.sha'], { encoding: 'utf8' }).trim(), revision);
const scratch = await mkdtemp(join(tmpdir(), 'rlm-evidence-public-'));
try {
  const source = await copyVerifiedRevision(publicSource(repo), revision, join(scratch, 'source'));
  const entries = (await readdir(source.workspace, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
  const before = await Promise.all(entries.map(path => readFile(path)));
  for (const file of entries) await chmod(file, 0o444);
  const workspace = join(scratch, 'ledger');
  const client = new PmClient({ cwd: scratch, pmRoot: workspace, author: 'coverage-validation', noExtensions: true });
  await client.init('coverage-validation', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
  process.env.PATH = scratch;
  const corpus = await readCorpus(source.workspace);
  const selected = corpus.items.slice(0, 3);
  assert.equal(selected.length, 3);
  const components = [...selected.map(item => `title:${item.id}`), 'unavailable causal explanation', 'unobserved external outcome'];
  const start = performance.now();
  const model = new ScriptedModel((request, index) => {
    if (index < selected.length) {
      const item = selected[index];
      const serialized = JSON.stringify(item);
      const title = JSON.stringify(item.title);
      const start = serialized.indexOf(title, serialized.indexOf('"title":') + 8);
      return JSON.stringify({ action: 'witness', id: item.id, start, end: start + title.length });
    }
    const state = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1)) as { transcript: { observation: { data: { digest: string } } }[] };
    const supported: RlmAnswerComponent[] = selected.map((item, step) => ({ component: components[step], status: 'supported', answer: item.title, reason: '', witnesses: [{ step, digest: state.transcript[step].observation.data.digest }] }));
    return JSON.stringify({ action: 'answer', components: [...supported, { component: components[3], status: 'unsupported', answer: '', reason: 'The declared sources do not establish causality', witnesses: [] }, { component: components[4], status: 'unknown', answer: '', reason: 'External outcome was not observed', witnesses: [] }] });
  });
  const result = await runRlm('Provide source titles and explicitly classify unavailable components', { workspace, source_workspace: source.workspace, components, model, settings: { output_tokens: 2048 } });
  const callsBefore = model.requests.length;
  const report = await evidenceRlm(workspace, result.run);
  assert.deepEqual(await replayRlm(workspace, result.run), result);
  assert.equal(model.requests.length, callsBefore);
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(result.run);
  const witnessBytes = state.calls[0].steps.slice(0, 3).map(step => Buffer.byteLength((step.observation as { data: { text: string } }).data.text));
  let refusedTampering = 0;
  for (const mode of ['digest', 'omission']) {
    const copy = structuredClone(state);
    if (mode === 'digest') (copy.calls[0].steps[0].observation as { data: { digest: string } }).data.digest = 'a'.repeat(64);
    else delete copy.calls[0].steps[0].observation;
    await replaceCheckpointFixture(ledger, copy);
    await assert.rejects(replayRlm(workspace, result.run));
    refusedTampering++;
  }
  assert.deepEqual(await Promise.all(entries.map(path => readFile(path))), before);
  const sourceDigest = createHash('sha256');
  for (const [index, file] of entries.entries()) { sourceDigest.update(file.slice(source.workspace.length)); sourceDigest.update(before[index]); }
  const measurement = { source: `unbraind/${repo}`, revision, source_items: corpus.items.length, source_json_bytes: Buffer.byteLength(JSON.stringify(corpus.items)), source_files: entries.length, source_files_unchanged: true, source_files_read_only: true, source_digest: sourceDigest.digest('hex'), non_git: true, git_executable_available_during_run: false, protocol_fixture: true, external_inference_calls: 0, model_steps: callsBefore, validation_model_calls: model.requests.length - callsBefore, logical_calls: result.calls, components: report.total, supported: report.supported, unsupported: report.unsupported, unknown: report.unknown, verified_witnesses: witnessBytes.length, witness_bytes: witnessBytes, report_json_bytes: Buffer.byteLength(JSON.stringify(report)), tampering_refused: refusedTampering, elapsed_ms: Math.round(performance.now() - start) };
  await writeFile('docs/answer-evidence-validation.json', JSON.stringify(measurement, null, 2) + '\n');
  console.log(JSON.stringify(measurement, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }
