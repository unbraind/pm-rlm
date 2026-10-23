import { gitEnvironment, npmEnvironment } from '../scripts/environment.ts';
/** Packed npm/npx and Bun/bunx consumers exercise the real pm host. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import type { RlmAdaptiveResult } from '../src/adaptive.ts';
import type { RlmAnswerComponent, RlmEvidenceReport } from '../src/types.ts';

/** Run a consumer process with private settings isolated from the current machine. */
function execute(cwd: string, args: string[], executable: string, env: NodeJS.ProcessEnv): string {
  const child = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 300000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  return child.stdout;
}
/** Install the actual packed distribution in independent package-manager consumers. */
for (const manager of ['npm', 'bun']) test(`packed ${manager} consumer installs, discovers and executes the rlm command`, t => {
  const repository = resolve(import.meta.dirname, '..');
  const scratch = mkdtempSync(join(tmpdir(), 'rlm-consumer-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: string; devDependencies: Record<string, string> };
  const env = { ...npmEnvironment(gitEnvironment(process.env)), HOME: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PM_AUTHOR: 'rlm-consumer' };
  const packed = JSON.parse(execute(repository, ['pack', '--json', '--pack-destination', scratch, '--ignore-scripts'], 'npm', env)) as { filename: string; files: { path: string }[] }[];
  const allowed = /^(dist\/|manifest\.json$|eval-results(?:-v2|-constrained)?\.json$|docs\/(?:EVAL-V2|EVAL-CONSTRAINED|EVAL-CLOUD|EVAL-DESIGN|ACTION-DIAGNOSIS|LEDGER-STORAGE|ANSWER-EVIDENCE|ADAPTIVE-DECOMPOSITION)\.md$|package\.json$|README\.md$|ARCHITECTURE\.md$|LICENSE$|docs\/(?:eval-design|ledger-scale|answer-evidence-validation|adaptive-validation)\.json$|CHANGELOG\.md$)/;
  assert.ok(packed[0].files.every(file => allowed.test(file.path)), 'Packed file allowlist');
  assert.ok(packed[0].files.some(file => file.path === 'dist/index.js'));
  for (const path of ['docs/ANSWER-EVIDENCE.md', 'docs/answer-evidence-validation.json', 'docs/ADAPTIVE-DECOMPOSITION.md', 'docs/adaptive-validation.json']) assert.ok(packed[0].files.some(file => file.path === path));
    const consumer = join(scratch, manager); mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'rlm-consumer-fixture', private: true, type: 'module', dependencies: { 'pm-rlm': `file:${join(scratch, packed[0].filename)}`, '@unbrained/pm-cli': manifest.devDependencies['@unbrained/pm-cli'] } }));
    execute(consumer, manager === 'npm' ? ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--ignore-scripts'], manager, env);
    const hostEnv = { ...env, PM_PATH: join(consumer, '.agents', 'pm') };
    const executable = manager === 'npm' ? 'npx' : 'bunx';
    const prefix = manager === 'npm' ? ['--no-install', 'pm'] : ['--bun', '--no-install', 'pm'];
    execute(consumer, [...prefix, 'init', '--prefix', 'rlm-consumer', '--defaults', '--agent-guidance', 'skip'], executable, hostEnv);
    execute(consumer, [...prefix, 'package', 'install', join(scratch, packed[0].filename)], executable, hostEnv);
    const help = execute(consumer, [...prefix, 'rlm', '--help'], executable, hostEnv);
    for (const command of ['run', 'adaptive', 'tree', 'resume', 'replay', 'evidence']) assert.ok(help.includes(command));
    const description = execute(consumer, [...prefix, 'package', 'describe', 'pm-rlm', '--json'], executable, hostEnv);
    assert.ok(description.includes('pm-rlm'));
    writeFileSync(join(consumer, 'create-run.ts'), `import { runRlm } from 'pm-rlm';
import assert from 'node:assert/strict';
let step = 0;
const result = await runRlm('Packed tree fixture', { workspace: process.env.PM_PATH!, author: 'rlm-consumer', model: { name: 'packed-test-only', complete: async request => { if (step++ === 0) return { text: '{"action":"count","filter":{}}', tokens_in: 20, tokens_out: 10 }; assert.ok(request.prompt.includes('"data":0')); return { text: 'Answer: {"action":"finish","answer":"packed result"}', tokens_in: 20, tokens_out: 10 }; } } });
console.log(JSON.stringify(result));
`);
    const run = JSON.parse(execute(consumer, ['create-run.ts'], manager === 'npm' ? process.execPath : 'bun', hostEnv)) as { run: string; answer: string };
    assert.equal(run.answer, 'packed result');
    const tree = JSON.parse(execute(consumer, [...prefix, 'rlm', 'tree', run.run, '--json'], executable, hostEnv)) as { run: string; token_usage: string; calls: { id: string; parent: string; depth: number; status: string; result: string; used_tokens: number; reserved_tokens: number }[] };
    assert.equal(tree.token_usage, 'reported_or_estimated');
    assert.equal(tree.run, run.run); assert.equal(tree.calls.length, 1);
    assert.equal(tree.calls[0].id, run.run); assert.equal(tree.calls[0].depth, 0);
    assert.equal(tree.calls[0].status, 'closed'); assert.equal(tree.calls[0].result, 'packed result');
    assert.equal(tree.calls[0].reserved_tokens, 60); assert.equal(tree.calls[0].used_tokens, 60);
    assert.match(tree.calls[0].parent, /^rlm-consumer-/);

    writeFileSync(join(consumer, 'create-evidence.ts'), `import { runRlm, sourceWitness, RlmEvidenceError } from 'pm-rlm';
import { PmClient } from '@unbrained/pm-cli/sdk';
import assert from 'node:assert/strict';
assert.equal(typeof sourceWitness, 'function');
assert.equal(typeof RlmEvidenceError, 'function');
const client = new PmClient({ pmRoot: process.env.PM_PATH!, author: 'rlm-consumer', noExtensions: true });
const item = (await client.create({ title: 'Packed evidence source' })).item;
let index = 0;
const result = await runRlm('Witness source', { workspace: process.env.PM_PATH!, components: ['source'], scope: { ids: [item.id] }, model: { name: 'packed-evidence', complete: async request => {
  const transcript = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\\n') + 1)).transcript;
  const action = index++ === 0 ? { action: 'witness', id: item.id, start: 0, end: 20 } : { action: 'answer', components: [{ component: 'source', status: 'supported', answer: item.id, reason: '', witnesses: [{ step: 0, digest: transcript[0].observation.data.digest }] }] };
  return { text: JSON.stringify(action), tokens_in: 40, tokens_out: 20 };
} } });
assert.equal(index, 2);
console.log(JSON.stringify(result));
`);
    const evidenceRun = JSON.parse(execute(consumer, ['create-evidence.ts'], manager === 'npm' ? process.execPath : 'bun', hostEnv)) as { run: string; components: RlmAnswerComponent[] };
    const expected: RlmEvidenceReport = { run: evidenceRun.run, verified: true, total: 1, supported: 1, unsupported: 0, unknown: 0, components: evidenceRun.components };
    const evidence = JSON.parse(execute(consumer, [...prefix, 'rlm', 'evidence', evidenceRun.run, '--json'], executable, hostEnv)) as RlmEvidenceReport;
    assert.deepEqual(evidence, expected);
    const toon = execute(consumer, [...prefix, 'rlm', 'evidence', evidenceRun.run], executable, hostEnv);
    assert.deepEqual(decodeToon(toon), expected);

    writeFileSync(join(consumer, 'create-adaptive.ts'), `import { adaptiveRlm, parseQuestionStructure, RlmAdaptiveError } from 'pm-rlm';
import assert from 'node:assert/strict';
assert.equal(typeof RlmAdaptiveError, 'function');
const structure = parseQuestionStructure([{ name: 'summary', question: 'What is established?' }]);
const receipt = await adaptiveRlm('Packed adaptive fixture', { workspace: process.env.PM_PATH!, structure, remaining_tokens: 0 });
console.log(JSON.stringify(receipt));
`);
    const partial = JSON.parse(execute(consumer, ['create-adaptive.ts'], manager === 'npm' ? process.execPath : 'bun', hostEnv)) as RlmAdaptiveResult;
    assert.equal(partial.status, 'partial');
    assert.equal(partial.calls, 0);
    assert.equal(partial.components[0].status, 'deferred');
    const args = [...prefix, 'rlm', 'adaptive', 'Packed adaptive fixture', '--structure', '[{"name":"summary","question":"What is established?"}]', '--budget-tokens', '0'];
    for (const json of [true, false]) {
      const rendered = execute(consumer, [...args, ...(json ? ['--json'] : [])], executable, hostEnv);
      const receipt = (json ? JSON.parse(rendered) : decodeToon(rendered)) as RlmAdaptiveResult;
      assert.equal(receipt.stop_reason, 'budget');
      assert.equal(receipt.budget.charged, 0);
      assert.deepEqual(receipt.components, partial.components);
    }

});
