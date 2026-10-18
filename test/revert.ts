/** Behavioral revert proofs: each removed invariant must make its regression fail. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const mutations = [
  { name: 'terminal child refusal (#4)', file: 'src/engine.ts', before: 'call.failure = { code: error.code };', after: 'void error.code;', test: 'test/review.test.ts', pattern: '^terminal child model' },
  { name: 'projected observation guard', file: 'src/engine.ts', before: "    if (estimateTokens(this.prompt(call, observation)) + state.settings.output_tokens > state.settings.context_tokens) throw new RlmError('budget', 'Observation does not fit the next model prompt');", after: '', test: 'test/review.test.ts', pattern: '^oversized read' },
  { name: 'scoped privacy', file: 'src/engine.ts', before: 'assertLedgerPrivacy({ question, items: snapshot, settings }', after: 'assertLedgerPrivacy({ question, items: corpus.items, settings }', test: 'test/review.test.ts', pattern: '^privacy applies' },
  { name: 'budget reserver', file: 'src/ledger.ts', before: "  if (charge > state.settings.budget_tokens - state.reserved_tokens) throw new RlmError('budget', 'Model step exceeds remaining run budget');", after: '', test: 'test/recovery.test.ts', pattern: '^model reservation' },
  { name: 'resume by digest', file: 'src/engine.ts', before: 'let call = state.calls.find(call => call.parent === parent.id && call.digest === digest);', after: 'let call: RlmCall | undefined = undefined;', test: 'test/recovery.test.ts', pattern: '^SIGKILL' },
  { name: 'partitioner', file: 'src/environment.ts', before: 'if (estimateTokens([...fragments, candidate]) <= maxTokens) low = size;', after: 'if (true) low = size;', test: 'test/core.test.ts', pattern: '^partition slices' },
];
for (const mutation of mutations) {
  const original = readFileSync(mutation.file, 'utf8');
  assert.equal(original.split(mutation.before).length, 2, 'Mutation must identify exactly one invariant');
  const hash = createHash('sha256').update(original).digest('hex');
  try {
    writeFileSync(mutation.file, original.replace(mutation.before, mutation.after));
    const child = spawnSync(process.execPath, ['--test', '--test-name-pattern', mutation.pattern, mutation.test], { encoding: 'utf8', timeout: 300000 });
    assert.equal(child.error, undefined);
    assert.notEqual(child.status, 0, `${mutation.name} regression incorrectly passed`);
    assert.match(child.stdout + child.stderr, /AssertionError|ERR_ASSERTION/);
    console.log(`${mutation.name}: regression failed with invariant removed (exit ${child.status})`);
  } finally {
    writeFileSync(mutation.file, original);
    assert.equal(createHash('sha256').update(readFileSync(mutation.file)).digest('hex'), hash);
  }
}
console.log(`${mutations.length}/${mutations.length} behavioral revert proofs; original source bytes restored`);
