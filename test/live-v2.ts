/** One authorized v2 measurement; source selection and questions are frozen before inference. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HttpModel } from '../src/adapters.ts';
import { replayRlm } from '../src/engine.ts';
import { readCorpus } from '../src/environment.ts';
import { RlmLedger } from '../src/ledger.ts';
import { parseAction } from '../src/protocol.ts';
import { copyVerifiedRevision, publicSource, liveSettings, measureStuffing, attemptRun } from './live.ts';
import { questions, EVAL_SEED } from './eval-questions.ts';
import type { RlmState } from '../src/types.ts';

/** Historical rows are used only to lock source identity and verify an unchanged task set. */
interface HistoricalRow { repo: string; revision: string; question: string; expected: string; corpus_items: number; corpus_bytes: number }
/** Hash output without publishing raw responses or source bodies. */
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
/** Count successful environment deliveries separately from attempted/refused operations. */
function observations(state: RlmState) {
  let reads = 0; let aggregates = 0;
  const refusals: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const invalid: { text: string; reason: string }[] = [];
  for (const step of state.calls.flatMap(call => call.steps)) {
    const observation = step.observation as { refused?: string; reason?: string } | undefined;
    if (observation?.refused !== undefined) {
      refusals[observation.refused] = (refusals[observation.refused] ?? 0) + 1;
      const reason = observation.reason ?? observation.refused;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      if (observation.refused === 'invalid') invalid.push({ text: step.response!.text, reason });
    } else if (step.response !== undefined && observation !== undefined) {
      const action = parseAction(step.response.text).action;
      if (['count', 'sum', 'distinct', 'group_count', 'argmax', 'argmin'].includes(action)) aggregates++;
      else if (action !== 'spawn') reads++;
    }
  }
  return { reads, aggregates, refusals, reasons, invalid };
}

assert.equal(process.env.PM_RLM_LIVE_MODEL, 'glm-5.3:cloud');
const label = process.argv.includes('--constrained') ? 'constrained' : 'v2';
const historical = JSON.parse(await readFile('eval-results.json', 'utf8')) as { rows: HistoricalRow[] };
const paths = [...(await readdir('src')).filter(path => path.endsWith('.ts')).map(path => `src/${path}`), 'test/live-v2.ts', 'test/live.ts', 'test/eval-questions.ts'].sort();
const hash = createHash('sha256');
for (const path of paths) hash.update(path).update('\0').update(await readFile(path));
const marker = { started_at_utc: new Date().toISOString(), paths, implementation_source_sha256: hash.digest('hex') };
const root = await mkdtemp(join(tmpdir(), 'rlm-v2-eval-'));
const rows: Record<string, unknown>[] = [];
const raw: Record<string, unknown>[] = [];
try {
  const prepared = [];
  for (const repo of ['pm-vcs', 'pm-lint']) {
    const old = historical.rows.filter(row => row.repo === repo);
    assert.equal(old.length, 12);
    const visibility = JSON.parse(execFileSync('gh', ['repo', 'view', `unbraind/${repo}`, '--json', 'visibility'], { encoding: 'utf8' })) as { visibility: string };
    assert.equal(visibility.visibility, 'PUBLIC');
    const revision = execFileSync('gh', ['api', `repos/unbraind/${repo}/commits/${old[0].revision}`, '--jq', '.sha'], { encoding: 'utf8' }).trim();
    assert.equal(revision, old[0].revision);
    const base = join(root, repo);
    await mkdir(base);
    const source = publicSource(repo, import.meta.url);
    const { workspace } = await copyVerifiedRevision(source, revision, base);
    const corpus = await readCorpus(workspace);
    assert.equal(corpus.items.length, old[0].corpus_items);
    assert.equal(Buffer.byteLength(JSON.stringify(corpus.items)), old[0].corpus_bytes);
    const tasks = questions(corpus.items);
    assert.deepEqual(tasks.map(task => ({ question: task.question, expected: task.answer })), old.map(row => ({ question: row.question.replace(/ Answer only the integer or id\.$/, ''), expected: row.expected })));
    prepared.push({ repo, revision, workspace, corpus, tasks, config: await liveSettings(workspace) });
  }
  // Exclusive marker prevents accidental remeasurement, including after a partial provider failure.
  await writeFile(`live-${label}.started.local`, JSON.stringify(marker, null, 2) + '\n', { flag: 'wx' });
  for (const { repo, revision, workspace, corpus, tasks, config } of prepared) {
    const model = new HttpModel(config);
    for (const [index, task] of tasks.entries()) {
      const baseline = await measureStuffing(task.question, corpus.items, config, model, task.answer);
      console.log(JSON.stringify({ repo, index, phase: 'stuffing_complete', ms: baseline.ms, error: baseline.error }));
      const start = performance.now();
      const { answer, error, runId } = await attemptRun(task.question, workspace, model, task.scope, config);
      let counters = { tokens: 0, reserved: 0, pending: 0, read_tokens: 0, reads: 0, aggregates: 0, reached_child: false, calls: 0, model_calls: 0, refusals: {} as Record<string, number>, reasons: {} as Record<string, number>, replay: 'no checkpoint' };
      if (runId !== '') {
        const state = await new RlmLedger(workspace).load(runId);
        const steps = state.calls.flatMap(call => call.steps);
        const observed = observations(state);
        counters = { tokens: steps.reduce((sum, step) => sum + (step.response?.tokens_in ?? 0) + (step.response?.tokens_out ?? 0), 0), reserved: state.reserved_tokens, pending: steps.filter(step => step.response === undefined).reduce((sum, step) => sum + step.reserved, 0), read_tokens: state.reserved_tokens - steps.reduce((sum, step) => sum + step.reserved, 0), reads: observed.reads, aggregates: observed.aggregates, reached_child: state.calls.length > 1, calls: state.calls.length, model_calls: steps.length, refusals: observed.refusals, reasons: observed.reasons, replay: 'not completed' };
        raw.push({ repo, index, invalid: observed.invalid, responses: steps.filter(step => step.response !== undefined).map(step => ({ text: step.response!.text, observation: step.observation })) });
        // A replay mismatch is recorded in the row, not thrown: the exclusive marker forbids a rerun, so one
        // failed replay must not cost the remaining questions their only measurement.
        if (!error) {
          try {
            const replayed = (await replayRlm(workspace, runId)).answer;
            counters.replay = replayed === answer ? 'verified' : 'failed: replayed answer differs';
          } catch (replayError) {
            counters.replay = `failed: ${replayError instanceof Error ? replayError.message : String(replayError)}`;
          }
        }
      }
      const row = { question: task.question, expected: task.answer, index, repo, revision, corpus_bytes: Buffer.byteLength(JSON.stringify(corpus.items)), corpus_items: corpus.items.length, rlm: { correct: answer.trim() === task.answer, answer_sha256: digest(answer), ...counters, ms: Math.round(performance.now() - start), error }, stuffing: baseline };
      rows.push(row);
      await writeFile(`eval-${label}-raw.local.json`, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
      await writeFile(`eval-results-${label}.local.json`, JSON.stringify({ ...marker, design: EVAL_SEED, model: config.model, measured_at_utc: new Date().toISOString(), context_tokens: config.context_tokens, output_tokens: config.output_tokens, budget_tokens: config.budget_tokens, max_depth: config.max_depth, max_calls: config.max_calls, temperature: 0, live_invocations: 1, third_arm: 'Omitted to conserve owner quota: another complete arm requires 24 additional cloud requests.', rows }, null, 2) + '\n');
      console.log(JSON.stringify(row));
    }
  }
} finally { await rm(root, { recursive: true, force: true }); }
