/** Format the single immutable v2 measurement without making model requests. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gitEnvironment } from '../scripts/environment.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { answerDistribution } from './eval-questions.ts';
import { METRIC_PROVENANCE } from './eval-metrics.ts';

/** One recorded outcome, including failures in the denominator. */
interface Outcome { correct: boolean; tokens: number; ms: number; calls: number; error: string }
/** Additional environment counters from the recorded checkpoint. */
interface RecursiveOutcome extends Outcome { reserved: number; pending: number; read_tokens: number; reads: number; aggregates: number; model_calls: number; reached_child: boolean; refusals: Record<string, number>; reasons: Record<string, number>; replay: string }
/** Frozen task identity and both arm observations. */
interface RecordedQuestion { repo: string; revision: string; index: number; question: string; expected: string; corpus_items: number; corpus_bytes: number; rlm: RecursiveOutcome; stuffing: Outcome }
/** Manifest generated before the exclusive live marker and retained with each row. */
interface V2Measurement { paths: string[]; implementation_source_sha256: string; started_at_utc: string; measured_at_utc: string; design: string; model: string; context_tokens: number; output_tokens: number; budget_tokens: number; max_depth: number; max_calls: number; temperature: number; live_invocations: number; third_arm: string; rows: RecordedQuestion[] }
/** Merge recorded exact counts without dropping failed attempts. */
function add(target: Record<string, number>, source: Record<string, number>): void {
  for (const key of Object.keys(source)) target[key] = (target[key] ?? 0) + source[key];
}
const measurement = JSON.parse(await readFile('eval-results-v2.local.json', 'utf8')) as V2Measurement;
assert.equal(measurement.rows.length, 24);
assert.equal(measurement.model, 'glm-5.3:cloud');
assert.equal(measurement.context_tokens, 131072);
assert.equal(measurement.live_invocations, 1);
const fingerprint = createHash('sha256');
for (const entry of measurement.paths) fingerprint.update(entry).update('\0').update(await readFile(entry));
assert.equal(fingerprint.digest('hex'), measurement.implementation_source_sha256, 'Measured source must remain unchanged');
const gitEnv = gitEnvironment(process.env);
const implementationRevision = execFileSync('git', ['log', '-1', '--format=%H', '--', ...measurement.paths], { encoding: 'utf8', env: gitEnv }).trim();
const committed = createHash('sha256');
for (const entry of measurement.paths) committed.update(entry).update('\0').update(execFileSync('git', ['show', `${implementationRevision}:${entry}`], { env: gitEnv }));
assert.equal(committed.digest('hex'), measurement.implementation_source_sha256, 'Commit must reproduce measured source bytes');
const legacy = JSON.parse(await readFile('eval-results.json', 'utf8')) as { rows: RecordedQuestion[] };
assert.deepEqual(measurement.rows.map(({ repo, revision, index, question, expected }) => ({ repo, revision, index, question, expected })), legacy.rows.map(({ repo, revision, index, question, expected }) => ({ repo, revision, index, question: question.replace(/ Answer only the integer or id\.$/, ''), expected })));
const summary = [];
for (const arm of ['rlm', 'stuffing'] as const) {
  let correct = 0; let tokens = 0; let milliseconds = 0; let requests = 0;
  const failures: Record<string, number> = {};
  for (const entry of measurement.rows) {
    const outcome = entry[arm];
    correct += Number(outcome.correct); tokens += outcome.tokens; milliseconds += outcome.ms;
    requests += arm === 'rlm' ? entry.rlm.model_calls : outcome.calls;
    if (outcome.error) add(failures, { [outcome.error]: 1 });
    assert.equal(entry.rlm.reserved, entry.rlm.tokens + entry.rlm.pending + entry.rlm.read_tokens);
  }
  summary.push({ arm, correct, questions: 24, tokens, tokens_per_question: tokens / 24, seconds_per_question: milliseconds / 24000, requests, requests_per_question: requests / 24, failures });
}
const tools = { child_reach: 0, delivered_reads: 0, delivered_aggregates: 0, observation_tokens: 0, pending_tokens: 0, replay_verified: 0, refusals: {} as Record<string, number>, reasons: {} as Record<string, number> };
for (const { rlm } of measurement.rows) {
  tools.child_reach += Number(rlm.reached_child); tools.delivered_reads += rlm.reads; tools.delivered_aggregates += rlm.aggregates;
  tools.observation_tokens += rlm.read_tokens; tools.pending_tokens += rlm.pending; tools.replay_verified += Number(rlm.replay === 'verified');
  add(tools.refusals, rlm.refusals); add(tools.reasons, rlm.reasons);
}
const raw = JSON.parse(await readFile('eval-v2-raw.local.json', 'utf8')) as { invalid: { text: string; reason: string }[]; responses: { text: string; observation?: unknown }[] }[];
const fixturePath = 'test/fixtures/glm-5.3-orphan-think.txt';
const capturedShape = await readFile(fixturePath, 'utf8');
assert.equal(raw[0].invalid[0].text, capturedShape, 'Fixture must be an exact recorded response');
const fixtureDigest = createHash('sha256').update(capturedShape).digest('hex');
const acceptedFixturePath = 'test/fixtures/glm-5.3-prose-action.txt';
const acceptedShape = await readFile(acceptedFixturePath, 'utf8');
const deliveredResponses = raw.flatMap(entry => entry.responses).filter(entry => entry.observation !== null && typeof entry.observation === 'object' && 'estimated_tokens' in entry.observation);
assert.ok(deliveredResponses.some(entry => entry.text === acceptedShape));
const acceptedFixtureDigest = createHash('sha256').update(acceptedShape).digest('hex');
let wrappedDeliveries = 0;
for (const entry of deliveredResponses) { try { JSON.parse(entry.text); } catch { wrappedDeliveries++; } }
const shapes: Record<string, number> = {};
for (const entry of raw) for (const invalid of entry.invalid) {
  const opening = (invalid.text.match(/<think>/gi) ?? []).length;
  const closing = (invalid.text.match(/<\/think>/gi) ?? []).length;
  let shape = closing > opening ? 'unmatched closing think tag with reasoning/prose' : opening > closing ? 'unclosed reasoning block' : 'other prose or malformed JSON';
  try { const object: unknown = JSON.parse(invalid.text); if (object !== null && typeof object === 'object' && !Array.isArray(object)) shape = 'complete JSON object with invalid action operands or keys'; }
  catch { /* The failed envelope remains classified by its actual reasoning delimiters. */ }
  add(shapes, { [shape]: 1 });
}
assert.equal(Object.values(shapes).reduce((total, count) => total + count, 0), tools.refusals.invalid ?? 0);
const baselines = answerDistribution(measurement.rows.map(row => ({ question: row.question, answer: row.expected, scope: {} })));
const published = { ...measurement, implementation_revision: implementationRevision, recorded_shape_fixture: { path: fixturePath, sha256: fixtureDigest }, accepted_shape_fixture: { path: acceptedFixturePath, sha256: acceptedFixtureDigest }, wrapped_deliveries: wrappedDeliveries, validation: { status: 'complete', task_identity: 'Same historical revisions and 24 exact tasks; format-neutral questions with historical seed hash inputs.' }, metric_provenance: METRIC_PROVENANCE, summary, tools, invalid_action_shapes: shapes, baselines };
await writeFile('eval-results-v2.json', JSON.stringify(published, null, 2) + '\n');
const table = ['| Arm | Correct | Tokens / question | Seconds / question | Requests / question |', '| --- | ---: | ---: | ---: | ---: |', ...summary.map(row => `| ${row.arm === 'rlm' ? 'RLM v2' : 'Complete-item stuffing'} | ${row.correct}/24 | ${row.tokens_per_question.toFixed(2)} | ${row.seconds_per_question.toFixed(2)} | ${row.requests_per_question.toFixed(2)} |`)].join('\n');
const resultText = summary[0].correct > summary[1].correct ? 'RLM v2 scored higher on this single fixed set.' : 'RLM v2 was not better than stuffing on this single fixed set.';
const evidence = `Child reach: ${tools.child_reach}/24. Delivered reads: ${tools.delivered_reads}; delivered aggregates: ${tools.delivered_aggregates}. Delivered responses requiring envelope extraction: ${wrappedDeliveries}. Successful read-only replays: ${tools.replay_verified}. Tool refusals: \`${JSON.stringify(tools.refusals)}\`. Outer failures: RLM \`${JSON.stringify(summary[0].failures)}\`; stuffing \`${JSON.stringify(summary[1].failures)}\`.`;
const constants = `Most-common constant guess: ${baselines.most_common}/24; constant zero: ${baselines.zero}/24.`;
const method = `One authorized model invocation, sequential stuffing-first arms, no retries of the evaluation and no answer-based tuning. Both arms share tolerant envelope extraction and retain their string answer schemas. Configured limits: ${measurement.context_tokens} context, ${measurement.output_tokens} output, ${measurement.budget_tokens} RLM budget, depth ${measurement.max_depth}, calls ${measurement.max_calls}, temperature ${measurement.temperature}. Questions are format-neutral. The historical suffix remains only in the hash input, preserving the original seeded task selection. Both source revisions, full corpus item/byte counts and all truths were verified before the first request. A preflight initially refused changed task selection before any inference; the exclusive marker was absent until the successful preflight. ${measurement.third_arm}`;
const limitations = `Tokens are provider-reported or conservative byte estimates, not measured-only usage. Pending reservations (${tools.pending_tokens} tokens total) are separate from settled usage; observation charges total ${tools.observation_tokens} byte-estimated tokens. Lost transport counters cannot be recovered. Incorrect stuffing answers are not separately classified as format versus content failures. Seconds include wall time and host load; the RLM arm includes SDK bookkeeping and replay verification for successful runs. Complete-item stuffing selects only whole items that fit the same conservative byte-based context ceiling. No confidence interval, recursive-quality claim or general model ranking follows from one fixed set. This run cannot isolate parser effects from aggregation effects.`;
let document = `# v2 cloud measurement\n\n${resultText}\n\nModel: \`${measurement.model}\`; seed: \`${measurement.design}\`; completed: ${measurement.measured_at_utc}.\n\n${table}\n\n${evidence}\n\n${constants}\n\n${method}\n\n${limitations}\n\n## Invalid-action evidence\n\nThe historical 451 strings were deleted, so their shapes remain unknown. New exact responses are retained locally in an ignored artifact. New shape counts: \`${JSON.stringify(shapes)}\`. Exact refusal reasons: \`${JSON.stringify(tools.reasons)}\`. See [the diagnosis](ACTION-DIAGNOSIS.md) for recorded versus synthetic cases.\n\n## Reproducibility\n\nMeasured source commit: \`${implementationRevision}\`. Measured implementation SHA-256: \`${measurement.implementation_source_sha256}\`. The artifact records every hashed source path; the formatter verifies they remain unchanged. [Per-question results](../eval-results-v2.json) retain exact tasks, truths, source revisions, digests and counters. The original invalidated results remain in [eval-results.json](../eval-results.json).\n\n`;
for (const repo of [...new Set(measurement.rows.map(row => row.repo))]) {
  const entry = measurement.rows.find(row => row.repo === repo)!;
  document += `- \`${repo}\` at \`${entry.revision}\`: ${entry.corpus_items} items, ${entry.corpus_bytes} JSON bytes.\n`;
}
await writeFile('docs/EVAL-V2.md', document);
const readme = await readFile('README.md', 'utf8');
const block = `<!-- eval-v2:start -->\n${resultText}\n\n${table}\n\n${evidence}\n\n${constants} ${measurement.third_arm} See [the v2 report](docs/EVAL-V2.md).\n<!-- eval-v2:end -->`;
const previous = /<!-- eval-v2:start -->[\s\S]*?<!-- eval-v2:end -->/;
await writeFile('README.md', previous.test(readme) ? readme.replace(previous, block) : readme + '\n## v2 measurement\n\n' + block + '\n');
console.log(JSON.stringify({ summary, tools, shapes, baselines }, null, 2));
