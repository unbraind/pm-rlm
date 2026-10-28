/** Behavioral revert proof runs only in a disposable source copy and restores before cleanup. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertChildCompleted, testTimeout } from './revert-source.ts';
import { testEnvironment } from '../scripts/environment.ts';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'repair-proof-'));
try {
  for (const name of ['src', 'test', 'scripts', 'index.ts', 'package.json', 'manifest.json']) await cp(join(root, name), join(scratch, name), { recursive: true });
  await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'junction');
  const env = testEnvironment(process.env);
  for (const key of Object.keys(env)) if (/^NODE_V8_COVERAGE$/i.test(key)) delete env[key];
  const proofs = [
    { file: 'src/engine.ts', pattern: 'replay verifies every witness digest', test: 'test/evidence.test.ts', changes: [["  const data = sourceWitness(callItems(state, call), action.id, action.start, action.end);", "  if (call.steps[0]?.observation !== undefined) return call.steps[0].observation as { data: ReturnType<typeof sourceWitness>; estimated_tokens: number; complete_list: RlmState['certificate'] };\n  const data = sourceWitness(callItems(state, call), action.id, action.start, action.end);"]] },
    { file: 'src/engine.ts', pattern: 'paired history refusal', test: 'test/reconcile.test.ts', changes: [["if (state.snapshot_only === true && action.action === 'history') throw new RlmEvidenceError", 'if (false) throw new RlmEvidenceError']] },
    { file: 'src/engine.ts', pattern: 'recursive pending inference', test: 'test/repair-auth.test.ts', changes: [["if (state.calls[0]?.id !== state.run || state.calls[0].depth !== 0 || calls.size !== state.calls.length || state.calls.length > state.settings.max_calls || state.calls.some((call, index) => call.depth > state.settings.max_depth || (index > 0 && call.depth !== (calls.get(call.parent!)?.depth ?? -2) + 1)))", 'if (false)']] },
    { file: 'src/engine.ts', pattern: 'pending repair holds authenticate', test: 'test/repair-auth.test.ts', changes: [['if (step.settled === true ? step.reserved > expected : step.reserved !== expected)', 'if (false)']] },
    { file: 'src/engine.ts', pattern: 'pending repair prompts authenticate', test: 'test/repair-auth.test.ts', changes: [['call.steps[index].prompt === modelPrompt({ ...call, steps: prefix }, state.components)', 'true']] },
    { file: 'src/repair.ts', pattern: 'unavailable prior repair evidence', test: 'test/repair-auth.test.ts', changes: [["if (answer.status !== 'supported')", 'if (false)']] },
    { file: 'src/repair-contract.ts', pattern: 'unavailable prior repair evidence', test: 'test/repair-auth.test.ts', changes: [["if (result.reused !== result.components.filter(part => part.disposition === 'reused').length || result.components.some(part => part.status === 'supported' ? part.disposition === 'gap' || part.remedy !== '' : part.disposition !== 'gap' || part.remedy.trim().length === 0))", 'if (false)']] },
    { file: 'src/repair.ts', pattern: 'uncertain repair budgets', test: 'test/repair-integrity.test.ts', changes: [["if (target.child === '' || childRow === undefined)", "if (target.child === '')"]] },
    { file: 'src/repair.ts', pattern: 'zero budget retains', test: 'test/repair.test.ts', changes: [["} else if (target.kind === 'reuse') {", '} else if (false) {']] },
    { file: 'src/ledger.ts', pattern: 'native checkpoint history refuses ABA', test: 'test/repair-refusals.test.ts', changes: [['if (checkVersion && (await readHistoryEntries', 'if (false && (await readHistoryEntries'], [' || current !== version', '']] },
    { file: 'src/repair.ts', pattern: 'controller history rejects ABA', test: 'test/repair-refusals.test.ts', changes: [[' || current.length !== expected.length || current.digest !== expected.digest', '']] },
    { file: 'src/repair.ts', pattern: 'late native child completion', test: 'test/repair-refusals.test.ts', changes: [['after.reserved_tokens - accountedTokens', 'after.reserved_tokens - (existing === undefined ? 0 : before.reserved_tokens)']] },
    { file: 'src/engine.ts', pattern: 'native repair charges', test: 'test/repair-refusals.test.ts', changes: [['if (verifyingProof && step.settled === true', 'if (false && step.settled === true'], ['if (strictUsage && state.reserved_tokens', 'if (false && state.reserved_tokens'], ['if (verifyingProof && (this.state.reserved_tokens < state.reserved_tokens || this.state.reserved_tokens > this.state.settings.budget_tokens))', 'if (false)']] },
    { file: 'src/repair.ts', pattern: 'prior repair contract', test: 'test/repair-integrity.test.ts', changes: [["if (state.calls[0].subgoal !== repairQuestion(base.state.question, part, dependencies) || !childPolicy(state, base.state.settings) || state.settings.budget_tokens !== target.allowance || target.allowance > Math.min(checkpoint.request.budget_tokens, base.state.settings.budget_tokens))", 'if (false)']] },
    { file: 'src/repair.ts', pattern: 'stopped budget gap', test: 'test/repair-integrity.test.ts', changes: [['(uncertain ? limit : limit - charged)', '(limit - charged)'], ['(uncertain ? limit : limit - charged + accountedTokens)', '(limit - charged + accountedTokens)'], ['if (state.calls[0].result !== undefined && !changed && !blocked)', 'if (false)']] },
    { file: 'src/ledger.ts', pattern: 'foreign native subcalls', test: 'test/repair-integrity.test.ts', changes: [["if (existing.rlm_run !== state.run || !existing.tags.includes('rlm:call') || existing.parent !== call.parent)", 'if (false)']] },
    { file: 'src/engine.ts', pattern: 'repair rejects unreachable native records', test: 'test/repair-integrity.test.ts', changes: [["if (strictUsage && visited.size !== this.state.calls.length)", 'if (false)']] },
    { file: 'src/evidence.ts', pattern: 'repair schema fuzz', test: 'test/repair-refusals.test.ts', changes: [['Array.from(value).every', 'value.every']] },
  ];
  const selected = process.argv[2] === undefined ? proofs : proofs.filter(proof => proof.pattern.includes(process.argv[2]));
  assert.ok(selected.length > 0);
  for (const proof of selected) {
    const path = join(scratch, proof.file);
    const fixed = await readFile(path, 'utf8');
    let reverted = fixed;
    for (const [before, after] of proof.changes) { assert.equal(reverted.split(before).length, 2); reverted = reverted.replace(before, after); }
    /** Execute the same named regression against fixed, reverted, and restored function behavior. */
    const run = () => {
      const timeout = testTimeout(300000);
      const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-name-pattern=' + proof.pattern, proof.test], { cwd: scratch, env, encoding: 'utf8', timeout });
      assertChildCompleted(result, timeout);
      return result;
    };
    const baseline = run(); assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    try {
      await writeFile(path, reverted);
      const broken = run(); assert.equal(broken.status, 1, broken.stdout + broken.stderr);
      assert.match(broken.stdout + broken.stderr, /AssertionError/);
    } finally { await writeFile(path, fixed); }
    const restored = run(); assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  }
  console.log(`${selected.length}/${selected.length} repair behavioral revert proofs: fixed pass, reverted behavior fails, restored pass`);
} finally { await rm(scratch, { recursive: true, force: true }); }
