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
import { verifyPackedRepairBudget } from './repair-consumer.ts';

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
  const allowed = /^(dist\/|manifest\.json$|eval-results(?:-v2|-constrained)?\.json$|docs\/(?:EVAL-V2|EVAL-CONSTRAINED|EVAL-CLOUD|EVAL-DESIGN|PUBLIC-EVALUATION|ACTION-DIAGNOSIS|LEDGER-STORAGE|ANSWER-EVIDENCE|ADAPTIVE-DECOMPOSITION|RECONCILIATION|EVIDENCE-DIRECTED-REPAIR)\.md$|package\.json$|README\.md$|ARCHITECTURE\.md$|LICENSE$|docs\/(?:eval-design|public-eval-suite|public-eval-results|ledger-scale|answer-evidence-validation|adaptive-validation|reconciliation-validation|verified-subanswer-reuse-validation|repair-validation)\.json$|CHANGELOG\.md$|examples\/(?:reconciliation-plan\.json|verified-subanswer-reuse\.ts|evidence-directed-repair\.ts)$)/;
  assert.ok(packed[0].files.every(file => allowed.test(file.path)), 'Packed file allowlist');
  assert.ok(packed[0].files.some(file => file.path === 'dist/index.js'));
  for (const path of ['docs/PUBLIC-EVALUATION.md', 'docs/public-eval-suite.json', 'docs/public-eval-results.json', 'docs/ANSWER-EVIDENCE.md', 'docs/answer-evidence-validation.json', 'docs/ADAPTIVE-DECOMPOSITION.md', 'docs/adaptive-validation.json', 'docs/RECONCILIATION.md', 'docs/reconciliation-validation.json', 'examples/reconciliation-plan.json', 'examples/verified-subanswer-reuse.ts', 'docs/verified-subanswer-reuse-validation.json']) assert.ok(packed[0].files.some(file => file.path === path));
    const consumer = join(scratch, manager); mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'rlm-consumer-fixture', private: true, type: 'module', dependencies: { 'pm-rlm': `file:${join(scratch, packed[0].filename)}`, '@unbrained/pm-cli': manifest.devDependencies['@unbrained/pm-cli'] } }));
    execute(consumer, manager === 'npm' ? ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--ignore-scripts'], manager, env);
    const hostEnv = { ...env, PM_PATH: join(consumer, '.agents', 'pm'), GIT_CEILING_DIRECTORIES: scratch };
    const executable = manager === 'npm' ? 'npx' : 'bunx';
    const prefix = manager === 'npm' ? ['--no-install', 'pm'] : ['--bun', '--no-install', 'pm'];
    execute(consumer, [...prefix, 'init', '--prefix', 'rlm-consumer', '--defaults', '--agent-guidance', 'skip'], executable, hostEnv);
    execute(consumer, [...prefix, 'package', 'install', join(scratch, packed[0].filename)], executable, hostEnv);
    const help = execute(consumer, [...prefix, 'rlm', '--help'], executable, hostEnv);
    for (const command of ['run', 'repair', 'repair-resume', 'reuse', 'adaptive', 'reconcile', 'eval', 'tree', 'resume', 'replay', 'evidence']) assert.ok(help.includes(command));
    const description = execute(consumer, [...prefix, 'package', 'describe', 'pm-rlm', '--json'], executable, hostEnv);
    assert.ok(description.includes('pm-rlm'));
    writeFileSync(join(consumer, 'create-run.ts'), `import { runRlm, reuseRlm, RlmLedger } from 'pm-rlm';
import { isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import assert from 'node:assert/strict';
let ticks = 0;
const expired = new RlmLedger(process.env.PM_PATH!, 'rlm-consumer', { deadOwnerRetryMs: 10, retryTiming: { now: () => ticks++ === 0 ? 0 : 10 } });
await assert.rejects(expired.lease('expired-packed-run'), (error: unknown) => isPmCliExpectedError(error) && error.code === 'lock_conflict');
let step = 0;
const reuse_identity = { tool_policy: 'snapshot-v1', model_policy: 'packed-fixture-v1', consent: 'public-fixture:1' };
const result = await runRlm('Packed tree fixture', { workspace: process.env.PM_PATH!, author: 'rlm-consumer', reuse_identity, model: { name: 'packed-test-only', complete: async request => { if (step++ === 0) return { text: '{"action":"count","filter":{}}', tokens_in: 20, tokens_out: 10 }; assert.ok(request.prompt.includes('"data":0')); return { text: 'Answer: {"action":"finish","answer":"packed result"}', tokens_in: 20, tokens_out: 10 }; } } });
const state = await new RlmLedger(process.env.PM_PATH!).load(result.run);
const reused = await reuseRlm('Packed tree fixture', { workspace: process.env.PM_PATH!, scope: state.scope, settings: state.settings, reuse_identity, selection: { run: result.run, call: result.run } });
assert.equal(reused.status, 'reused'); assert.equal(step, 2);
if (reused.status !== 'reused') throw new Error('Packed reuse refused');
assert.equal(reused.tokens_in, 0); assert.equal(reused.tokens_out, 0); assert.equal(reused.reserved_tokens, 0); assert.equal(reused.reuse.run, result.run);
console.log(JSON.stringify(result));
`);
    const run = JSON.parse(execute(consumer, ['create-run.ts'], manager === 'npm' ? process.execPath : 'bun', hostEnv)) as { run: string; answer: string };
    assert.equal(run.answer, 'packed result');
    const identity = JSON.stringify({ tool_policy: 'snapshot-v1', model_policy: 'packed-fixture-v1', consent: 'public-fixture:1' });
    for (const format of [[], ['--json']]) {
      const output = execute(consumer, [...prefix, 'rlm', 'reuse', 'Packed tree fixture', '--from', run.run, '--call', run.run, '--identity', identity, '--model', 'packed-test-only', ...format], executable, hostEnv);
      const receipt = (format.length === 0 ? decodeToon(output) : JSON.parse(output)) as { status: string; model_calls: number; tokens_in: number; answer_preview: string };
      assert.equal(receipt.status, 'reused'); assert.equal(receipt.model_calls, 0); assert.equal(receipt.tokens_in, 0); assert.equal(receipt.answer_preview, 'packed result');
    }
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

    const repairParts = JSON.stringify([{ name: 'source', question: 'Return the source id', depends_on: [], sources: [evidenceRun.components[0].answer] }]);
    verifyPackedRepairBudget(repository, consumer, args => execute(consumer, args, manager === 'npm' ? process.execPath : 'bun', hostEnv), [
      args => execute(consumer, [...prefix, ...args], executable, hostEnv),
      args => execute(consumer, args, join(consumer, 'node_modules', '.bin', 'pm'), hostEnv),
    ]);
    for (const render of [[], ['--json']]) {
      const output = execute(consumer, [...prefix, 'rlm', 'repair', evidenceRun.run, '--parts', repairParts, '--budget-tokens', '0', ...render], executable, hostEnv);
      const repaired = (render.length === 0 ? decodeToon(output) : JSON.parse(output)) as { run: string; reused: number; status: string; calls: number };
      assert.equal(repaired.status, 'complete'); assert.equal(repaired.reused, 1); assert.equal(repaired.calls, 0);
      const recovered = JSON.parse(execute(consumer, [...prefix, 'rlm', 'repair-resume', repaired.run, '--json'], executable, hostEnv)) as { reused: number };
      assert.equal(recovered.reused, 1);
    }

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

    writeFileSync(join(consumer, 'paired-sdk.ts'), `import { reconcileRlm, parseReconcileArms, RlmReconcileError } from 'pm-rlm';
import assert from 'node:assert/strict';
const structure = [{ name: 'source', question: 'What is documented?' }];
const arms = parseReconcileArms([{ groups: [['source']], budget_tokens: 30000 }, { groups: [['source']], budget_tokens: 30000 }], ['source']);
assert.equal(typeof RlmReconcileError, 'function');
const result = await reconcileRlm('Packed pair', { workspace: process.env.PM_PATH!, structure, arms, reserved_tokens: 60000, model: { name: 'packed-pair', complete: async () => ({ text: JSON.stringify({ action: 'answer', components: [{ component: 'source', status: 'unknown', answer: '', reason: 'No source establishes this claim', witnesses: [] }] }), tokens_in: 40, tokens_out: 20 }) } });
assert.equal(result.status, 'partial');
assert.equal(result.comparisons[0].relation, 'unresolved');
assert.equal(result.budget.charged, 120);
console.log(JSON.stringify(result.budget));
`);
    const paired = JSON.parse(execute(consumer, ['paired-sdk.ts'], manager === 'npm' ? process.execPath : 'bun', hostEnv)) as { charged: number };
    assert.equal(paired.charged, 120);
    writeFileSync(join(consumer, 'eval-sdk.ts'), `import { evaluateRlm, createRlmContext, evalDigest, RlmEvalError } from 'pm-rlm';
import type { ModelRequest } from 'pm-rlm';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const workspace = process.env.PM_PATH!;
const items = (await createRlmContext({ workspace, budget: 1000000 })).list().data;
const suite = { version: 1, id: 'packed-eval', sources: [{ id: 'sample', repository: 'fixture/public', revision: 'a'.repeat(40), corpus_sha256: evalDigest(JSON.stringify(items)) }], questions: Array.from({length:20}, (_, index) => ({ id: 'q'+index, source: 'sample', question: 'How many nonexistent tasks are there?', gold: '0' })) };
const options = { workspace, sources: { sample: workspace }, id: 'packed-eval', model: 'packed-eval', mode: 'stub' as const, stub: { name: 'packed-eval', complete: async (request: ModelRequest) => ({ text: request.response_kind === 'answer' ? '{"answer":"0"}' : '{"action":"finish","answer":"0"}', tokens_in: 20, tokens_out: 10 }) } };
assert.equal(typeof RlmEvalError, 'function');
const receipt = await evaluateRlm(suite, options);
assert.equal(receipt.status, 'complete'); assert.equal(receipt.rows, undefined);
assert.equal(receipt.summary.recursive.correct, 20); assert.equal(receipt.summary.truncated.calls, 20);
assert.deepEqual((await evaluateRlm(suite, options)).summary, receipt.summary);
await writeFile('packed-eval-suite.json', JSON.stringify(suite));
console.log(JSON.stringify(options.sources));
`);
    const evalSources = execute(consumer, ['eval-sdk.ts'], manager === 'npm' ? process.execPath : 'bun', hostEnv).trim();
    const invalidEval = spawnSync(executable, [...prefix, 'rlm', 'eval', 'packed-eval-suite.json', '--sources', evalSources, '--id', 'packed-eval', '--model', 'packed-eval', '--json'], { cwd: consumer, env: hostEnv, encoding: 'utf8' });
    assert.equal(invalidEval.status, 2); assert.match(invalidEval.stderr, /another configuration.*remedy:/);

    const invalidPair = spawnSync(executable, [...prefix, 'rlm', 'reconcile', 'Packed refusal', '--plan', '{}', '--budget-tokens', '0', '--json'], { cwd: consumer, env: hostEnv, encoding: 'utf8' });
    assert.equal(invalidPair.status, 2);
    assert.match(invalidPair.stderr, /remedy:/);

});
