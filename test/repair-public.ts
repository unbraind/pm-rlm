/** Reproducible offline repair measurement over a verified read-only public tracker copy. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { copyVerifiedRevision, publicSource } from './live.ts';
import { readCorpus } from '../src/environment.ts';
import { runRlm } from '../src/engine.ts';
import { compactRepairResult, repairRlm, resumeRepairRlm } from '../src/repair.ts';
import { ScriptedModel } from './helpers.ts';
import { repaired, repairPrompt } from './repair-fixture.ts';

const repository = 'pm-lint';
const revision = 'f2c20efa78139f4071f3dd08d317bea05337fe28';
assert.equal(JSON.parse(execFileSync('gh', ['repo', 'view', `unbraind/${repository}`, '--json', 'visibility'], { encoding: 'utf8' })).visibility, 'PUBLIC');
assert.equal(execFileSync('gh', ['api', `repos/unbraind/${repository}/commits/${revision}`, '--jq', '.sha'], { encoding: 'utf8' }).trim(), revision);
const scratch = await mkdtemp(join(tmpdir(), 'rlm-repair-public-'));
try {
  const source = await copyVerifiedRevision(publicSource(repository), revision, join(scratch, 'source'));
  const archivedFiles: string[] = [];
  for (const entry of await readdir(source.workspace, { recursive: true, withFileTypes: true })) if (entry.isFile()) archivedFiles.push(join(entry.parentPath, entry.name));
  archivedFiles.sort();
  const originals = await Promise.all(archivedFiles.map(file => readFile(file)));
  for (const file of archivedFiles) await chmod(file, 0o444);
  const workspace = join(scratch, 'ledger');
  const client = new PmClient({ noExtensions: true, author: 'repair-validation', pmRoot: workspace, cwd: scratch });
  await client.init('repair-validation', { mergeFence: false, agentGuidance: 'skip', defaults: true });
  process.env.PATH = scratch;
  process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
  const corpus = await readCorpus(source.workspace);
  const selected = corpus.items.slice(0, 10);
  assert.equal(selected.length, 10);
  const parts = selected.map(item => ({ name: `title:${item.id}`, question: 'Return the documented source title', depends_on: [] as string[], sources: [item.id] }));
  /** Select exactly the title bytes rather than claiming a whole-item semantic proof. */
  const witness = (index: number) => {
    const item = selected[index]; const text = JSON.stringify(item); const title = JSON.stringify(item.title);
    const start = text.indexOf(title, text.indexOf('"title":') + 8);
    return { action: 'witness', id: item.id, start, end: start + title.length };
  };
  const initial = new ScriptedModel(request => {
    const { transcript } = repairPrompt(request);
    return JSON.stringify(transcript.length < 9 ? witness(transcript.length) : { action: 'answer', components: parts.map((part, index) => ({ component: part.name, status: index < 9 ? 'supported' : 'unsupported', answer: index < 9 ? selected[index].title : '', reason: index < 9 ? '' : 'Deliberately uncompleted fixture component', witnesses: index < 9 ? [{ step: index, digest: transcript[index].observation.data.digest }] : [] })) });
  });
  const original = await runRlm('Return ten documented titles', { workspace, source_workspace: source.workspace, snapshot_only: true, components: parts.map(part => part.name), model: initial, settings: { budget_tokens: 1000000, context_tokens: 131072, output_tokens: 2048 } });
  const model = new ScriptedModel(request => {
    const { transcript } = repairPrompt(request);
    return JSON.stringify(transcript.length === 0 ? witness(9) : { action: 'answer', components: [{ component: parts[9].name, status: 'supported', answer: selected[9].title, reason: '', witnesses: [{ step: 0, digest: transcript[0].observation.data.digest }] }] });
  });
  const options = { workspace, source_workspace: source.workspace, model };
  const result = repaired(await repairRlm({ source: original.run, parts, budget_tokens: 1000000 }, options));
  assert.equal(result.status, 'complete'); assert.equal(result.reused, 9); assert.equal(result.calls, 1); assert.equal(model.requests.length, 2);
  assert.deepEqual(result.components.map(part => part.answer), selected.map(item => item.title));
  assert.deepEqual(repaired(await resumeRepairRlm(result.run, options)), result);
  const exhausted = repaired(await repairRlm({ source: original.run, parts, budget_tokens: 0 }, options));
  assert.equal(exhausted.reused, 9); assert.equal(exhausted.gaps.length, 1); assert.equal(exhausted.budget.charged, 0);
  assert.deepEqual(await Promise.all(archivedFiles.map(file => readFile(file))), originals);
  const hash = createHash('sha256');
  for (const [index, file] of archivedFiles.entries()) { hash.update(file.slice(source.workspace.length)); hash.update(originals[index]); }
  const report = { repository: `unbraind/${repository}`, revision, source_items: corpus.items.length, source_json_bytes: Buffer.byteLength(JSON.stringify(corpus.items)), source_files: archivedFiles.length, source_digest: hash.digest('hex'), source_files_read_only: true, source_files_unchanged: true, non_git: true, git_executable_available: false, protocol_fixture: true, external_inference_calls: 0, original_components: 10, original_supported: 9, repair_scheduled: result.scheduled.length, repair_reused: result.reused, repair_supported: result.components.filter(part => part.status === 'supported').length, repair_logical_calls: result.calls, repair_model_requests: model.requests.length, repair_charged_tokens: result.budget.charged, resume_additional_requests: model.requests.length - 2, zero_budget_supported: exhausted.reused, zero_budget_named_gaps: exhausted.gaps.length, compact_json_bytes: Buffer.byteLength(JSON.stringify(compactRepairResult(result))) };
  await writeFile('docs/repair-validation.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }
