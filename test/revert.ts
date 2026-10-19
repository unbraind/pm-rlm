/** Behavioral revert proofs: each removed invariant must make its regression fail. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const mutations = [
  { name: 'case-insensitive recovery environment', file: 'scripts/environment.ts', before: '!/^NODE_TEST_CONTEXT$/i.test(key)', after: '!/^NODE_TEST_CONTEXT$/.test(key)', test: 'test/round4.test.ts', pattern: '^test environment' },
  { name: 'case-insensitive Git environment', file: 'scripts/environment.ts', before: '!/^GIT_/i.test(key)', after: '!/^GIT_/.test(key)', test: 'test/round4.test.ts', pattern: '^Git environment' },
  { name: 'case-insensitive npm environment', file: 'scripts/environment.ts', before: '!/^npm_config_(allow_scripts|userconfig)$/i.test(key)', after: '!/^npm_config_(allow_scripts|userconfig)$/.test(key)', test: 'test/round4.test.ts', pattern: '^npm environment' },
  { name: 'case-insensitive coverage environment', file: 'scripts/coverage-gate.ts', before: '/^NODE_V8_COVERAGE$/i.test(key)', after: '/^NODE_V8_COVERAGE$/.test(key)', test: 'test/tooling.test.ts', pattern: '^coverage subprocess' },
  { name: 'strict CLI numeric operands', file: 'src/commands.ts', before: 'numericOperand(ctx.options[option])', after: 'Number(text(ctx.options[option]))', test: 'test/round4.test.ts', pattern: '^all CLI operands' },
  { name: 'nonblank CLI string operands', file: 'src/commands.ts', before: "  if (result.trim().length === 0) throw new RlmError('invalid', 'Expected nonblank operand');", after: '', test: 'test/round4.test.ts', pattern: '^all CLI operands' },
  { name: 'nonblank quality root operands', file: 'scripts/main-invocation.ts', before: 'argument !== undefined && argument.trim().length === 0', after: 'false', test: 'test/tooling.test.ts', pattern: '^quality CLI' },
  { name: 'root ancestor privacy exclusion', file: 'src/errors.ts', before: 'if (paths.dirname(grandparent) !== grandparent) needles.push', after: 'needles.push', test: 'test/round4.test.ts', pattern: '^privacy skips' },
  { name: 'portable Windows privacy needles', file: 'src/errors.ts', before: 'if (paths === win32) {', after: 'if (false) {', test: 'test/round4.test.ts', pattern: '^privacy skips' },
  { name: 'portable identity privacy matcher', file: 'scripts/identity-gate.ts', before: String.raw`/[\\/](?:home|Users)[\\/]|[\\/]root(?:[\\/]|\b)/i.test(line)`, after: String.raw`/\/(?:home|Users)\/|\/(?:root)(?:\/|\b)|[A-Za-z]:[\\/]Users[\\/]/.test(line)`, test: 'test/tooling.test.ts', pattern: '^identity privacy' },
  { name: 'marker-based report replacement', file: 'test/eval-report.ts', before: 'readme.indexOf(startMarker)', after: "readme.indexOf('The following measurements are **historical')", test: 'test/round4.test.ts', pattern: '^eval report' },
  { name: 'twenty-step actual settlement', file: 'src/ledger.ts', before: '  state.reserved_tokens -= step.reserved - actual;', after: '', test: 'test/settlement.test.ts', pattern: '^twenty sequential' },
  { name: 'pending SIGKILL settlement', file: 'src/ledger.ts', before: '  state.reserved_tokens -= step.reserved - actual;', after: '', test: 'test/settlement.test.ts', pattern: '^pre-response SIGKILL' },
  { name: 'empty response checkpoint (#5)', file: 'src/ledger.ts', before: "            if (typeof response.text !== 'string') throw new Error('Invalid response text');", after: '            text(response.text);', test: 'test/empty-response.test.ts', pattern: '^empty model' },
  { name: 'interrupted empty response (#5)', file: 'src/ledger.ts', before: "            if (typeof response.text !== 'string') throw new Error('Invalid response text');", after: '            text(response.text);', test: 'test/empty-response.test.ts', pattern: '^empty response interruption' },
  { name: 'endpoint redirect rejection', file: 'src/adapters.ts', before: ", redirect: 'error'", after: '', test: 'test/round3.test.ts', pattern: '^model endpoints reject' },
  { name: 'rejected body cancellation', file: 'src/adapters.ts', before: '        await response.body?.cancel();', after: '', test: 'test/round3.test.ts', pattern: '^non-OK streaming' },
  { name: 'typed missing spawn observation', file: 'src/engine.ts', before: "        if (typeof step.observation !== 'object' || step.observation === null || typeof (step.observation as { result?: unknown }).result !== 'string') throw new RlmError('replay', 'Recorded spawn step has no completed observation');", after: '', test: 'test/round3.test.ts', pattern: '^replay refuses absent' },
  { name: 'Git replacement isolation', file: 'test/live.ts', before: ", GIT_NO_REPLACE_OBJECTS: '1'", after: '', test: 'test/eval-source.test.ts', pattern: '^eval copies' },
  { name: 'checkpoint call validation', file: 'src/ledger.ts', before: '      for (const entry of decoded.calls) {', after: '      for (const entry of []) {', test: 'test/round2.test.ts', pattern: '^checkpoint validation' },
  { name: 'bounded response body', file: 'src/adapters.ts', before: "        if (size > limit) throw new RlmError('model', 'Model response exceeds byte allowance');", after: '', test: 'test/round2.test.ts', pattern: '^bounded HTTP' },
  { name: 'scope syntax diagnosis', file: 'src/commands.ts', before: "if (error instanceof SyntaxError) throw new RlmError('invalid', 'Invalid --scope JSON'); ", after: '', test: 'test/round2.test.ts', pattern: '^malformed scope' },
  { name: 'escaped privacy needles', file: 'src/errors.ts', before: ' || serialized.includes(JSON.stringify(needle).slice(1, -1))', after: '', test: 'test/round2.test.ts', pattern: '^privacy rejects JSON' },
  { name: 'checkpoint settings validation', file: 'src/ledger.ts', before: '      validateRlmSettings(decoded.settings);', after: '', test: 'test/round2.test.ts', pattern: '^checkpoint validation' },
  { name: 'HTTPS credential transport', file: 'src/settings.ts', before: "  if (config.adapter === 'openai' && url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new RlmError('invalid', 'Remote OpenAI endpoints require HTTPS');", after: '', test: 'test/round2.test.ts', pattern: '^remote OpenAI' },
  { name: 'verified archive paths', file: 'test/live.ts', before: "  if (extracted.length !== manifest.length) throw new RlmError('invalid', 'Public archive paths differ from verified revision');", after: '', test: 'test/eval-source.test.ts', pattern: '^eval copies' },
  { name: 'verified archive bytes', file: 'test/live.ts', before: "!(await readFile(path)).equals(expected)", after: 'false', test: 'test/eval-source.test.ts', pattern: '^eval copies' },
  { name: 'seeded answer frequency cap', file: 'test/eval-questions.ts', before: "if (!chosen.includes(task) && (histogram.get(task.answer) ?? 0) < 2)", after: 'if (!chosen.includes(task))', test: 'test/round2.test.ts', pattern: '^seeded eval' },
  { name: 'eval calibrated limits', file: 'test/live.ts', before: 'context_tokens: 131072, output_tokens: 512, budget_tokens: 300000, ', after: '', test: 'test/eval.test.ts', pattern: '^eval pins' },
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
