/** Offline acceptance against an independently verified public revision in a read-only no-git copy. */
import assert from 'node:assert/strict';
import { execFileSync as github } from 'node:child_process';
import { createHash as sourceHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir as temporaryRoot } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { certifyCompleteListResult, PmClient } from '@unbrained/pm-cli/sdk';
import { copyVerifiedRevision, publicSource } from './live.ts';
import { verifyRlmAnswer } from '../src/answer-invariants.ts';
import type { RlmAnswerContract } from '../src/answer-contract.ts';

const publicRepository = 'pm-lint';
const revision = 'f2c20efa78139f4071f3dd08d317bea05337fe28';
assert.equal(JSON.parse(github('gh', ['repo', 'view', `unbraind/${publicRepository}`, '--json', 'visibility'], { encoding: 'utf8' })).visibility, 'PUBLIC');
assert.equal(github('gh', ['api', `repos/unbraind/${publicRepository}/commits/${revision}`, '--jq', '.sha'], { encoding: 'utf8' }).trim(), revision);
const scratch = await mkdtemp(join(temporaryRoot(), 'rlm-invariants-public-'));
let directories: string[] = [];
try {
  const source = await copyVerifiedRevision(publicSource(publicRepository), revision, join(scratch, 'source'));
  const entries = await readdir(source.workspace, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
  directories = [source.workspace, ...entries.filter(entry => entry.isDirectory()).map(entry => join(entry.parentPath, entry.name))];
  const before = await Promise.all(files.map(file => readFile(file)));
  for (const file of files) await chmod(file, 0o444);
  for (const directory of directories) await chmod(directory, 0o555);
  process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
  process.env.PATH = scratch;
  const client = new PmClient({ pmRoot: source.workspace, noExtensions: true });
  const environment = certifyCompleteListResult(await client.listAllComplete({ includeBody: true }));
  const rows = environment.items.filter(item => !item.tags.includes('rlm:call') && !item.tags.includes('rlm:question'));
  assert.ok(rows.length > 0);
  const item = rows[0];
  const input: RlmAnswerContract = { version: 'answer-invariants-v1', answer: `There are ${rows.length + 1} items [${item.id}].`, scope: {}, checks: [
    { id: 'false-cited-count', kind: 'count', filter: {}, expected: rows.length + 1 },
    { id: 'true-count', kind: 'count', filter: {}, expected: rows.length },
    { id: 'source-member', kind: 'membership', filter: {}, field: 'id', value: item.id, expected: 'present' },
    { id: 'source-title', kind: 'equals', item: item.id, field: 'title', expected: item.title },
  ] };
  const start = performance.now();
  const report = await verifyRlmAnswer(input, { environment });
  assert.equal(report.status, 'failed'); assert.equal(report.source.status, 'complete');
  assert.deepEqual(report.checks.map(check => check.status), ['failed', 'passed', 'passed', 'passed']);
  const incomplete = await verifyRlmAnswer(input, { environment: { ...environment, completeness: { ...environment.completeness, status: 'partial' } } });
  assert.equal(incomplete.status, 'incomplete'); assert.ok(incomplete.checks.every(check => check.status === 'unknown'));
  const repeat = await verifyRlmAnswer(input, { environment: JSON.parse(JSON.stringify(environment)) });
  assert.deepEqual(repeat, report);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
  assert.deepEqual((await readdir(source.workspace, { recursive: true })).sort(), entries.map(entry => join(entry.parentPath, entry.name).slice(source.workspace.length + 1)).sort());
  const digest = sourceHash('sha256');
  for (let i = 0; i < files.length; i++) { digest.update(files[i].slice(source.workspace.length)); digest.update(before[i]); }
  const measurement = { source: `unbraind/${publicRepository}`, revision, source_items: rows.length, source_files: files.length, source_json_bytes: Buffer.byteLength(JSON.stringify(environment)), source_digest: digest.digest('hex'), source_files_read_only: true, source_directories_read_only: true, source_tree_unchanged: true, non_git: true, git_executable_available: false, model_calls: report.model_calls, verification_writes: report.writes, checks: report.checks.length, passed: report.verified_fact_ids.length, failed: report.checks.filter(check => check.status === 'failed').length, false_count_expected: rows.length + 1, false_count_actual: report.checks[0].actual, incomplete_unknown: incomplete.checks.length, report_json_bytes: Buffer.byteLength(JSON.stringify(report)), repeat_identical: true, elapsed_ms: Math.round(performance.now() - start) };
  await writeFile('docs/executable-answer-invariants-validation.json', JSON.stringify(measurement, null, 2) + '\n');
  console.log(JSON.stringify(measurement, null, 2));
} finally {
  for (const directory of directories) await chmod(directory, 0o755);
  await rm(scratch, { recursive: true, force: true });
}
