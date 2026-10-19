/** Summarize the one authorized live invocation without making any model calls. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { METRIC_PROVENANCE } from './eval-metrics.ts';
import { answerDistribution } from './eval-questions.ts';

/** Counters recorded for either measured arm, including refused attempts. */
interface Arm { correct: boolean; tokens: number; ms: number; calls: number; error: string }
/** One exact question and both recorded outcomes. */
interface Row { repo: string; revision: string; index: number; question: string; expected: string; corpus_items: number; corpus_bytes: number; rlm: Arm & { reached_child: boolean; model_calls: number; reserved: number; pending: number; read_tokens: number; refusals: Record<string, number> }; stuffing: Arm }
/** Metadata emitted by the live harness. */
interface Measurement { design: string; model: string; measured_at_utc: string; context_tokens: number; output_tokens: number; budget_tokens: number; max_depth: number; max_calls: number; temperature: number; rows: Row[] }

const data = JSON.parse(await readFile('eval-results.local.json', 'utf8')) as Measurement;
if (data.rows.length !== 24 || data.model !== 'glm-5.3:cloud' || data.context_tokens !== 131072) throw new Error('Expected the complete authorized 24-question cloud measurement');
const marker = JSON.parse(await readFile('live-r3.started.local', 'utf8')) as { paths: string[]; implementation_source_sha256: string; started_at_utc: string };
const fingerprint = createHash('sha256');
for (const path of marker.paths) fingerprint.update(path).update('\0').update(await readFile(path));
if (fingerprint.digest('hex') !== marker.implementation_source_sha256) throw new Error('Measured implementation changed after the live invocation started');
if (!Number.isFinite(Date.parse(data.measured_at_utc)) || Date.parse(data.measured_at_utc) < Date.parse(marker.started_at_utc)) throw new Error('Measurement predates the authorized invocation');

/** Sum only recorded counters, keeping failures in every denominator. */
function stats(arm: 'rlm' | 'stuffing') {
  const rows = data.rows.map(row => row[arm]);
  const correct = rows.filter(row => row.correct).length;
  const refusals: Record<string, number> = {};
  for (const row of rows) if (row.error) refusals[row.error] = (refusals[row.error] ?? 0) + 1;
  return { correct, questions: rows.length, accuracy_pct: correct / rows.length * 100, tokens: rows.reduce((sum, row) => sum + row.tokens, 0), tokens_per_question: rows.reduce((sum, row) => sum + row.tokens, 0) / rows.length, seconds_per_question: rows.reduce((sum, row) => sum + row.ms, 0) / rows.length / 1000, requests_per_question: arm === 'rlm' ? data.rows.reduce((sum, row) => sum + row.rlm.model_calls, 0) / rows.length : 1, refusal_histogram: refusals };
}
const distribution = answerDistribution(data.rows.map(row => ({ question: row.question, answer: row.expected, scope: {} })));
const inner: Record<string, number> = {};
for (const row of data.rows) for (const [code, count] of Object.entries(row.rlm.refusals)) inner[code] = (inner[code] ?? 0) + count;
const rlm = { ...stats('rlm'), reached_child: data.rows.filter(row => row.rlm.reached_child).length, tool_refusal_histogram: inner, mean_charged_tokens: data.rows.reduce((sum, row) => sum + row.rlm.reserved, 0) / data.rows.length, mean_pending_tokens: data.rows.reduce((sum, row) => sum + row.rlm.pending, 0) / data.rows.length, mean_read_tokens: data.rows.reduce((sum, row) => sum + row.rlm.read_tokens, 0) / data.rows.length };
const stuffing = stats('stuffing');
const sources = [...new Set(data.rows.map(row => row.repo))].map(repo => { const row = data.rows.find(row => row.repo === repo)!; return { repo, revision: row.revision, items: row.corpus_items, bytes: row.corpus_bytes }; });
const result = { ...data, started_at_utc: marker.started_at_utc, implementation_source_sha256: marker.implementation_source_sha256, live_invocations: 1, measurement: 'One authorized invocation, sequential arms, stuffing first; all failures included; model usage is reported-or-estimated; per-response provenance was not retained', metric_provenance: METRIC_PROVENANCE, source_revisions: sources, summary: { rlm, stuffing, answer_distribution: distribution } };
const table = `| Arm | Exact correct | Reported-or-estimated model tokens / question | Measured seconds / question | Observed model requests / question | Observed child reach |\n| --- | ---: | ---: | ---: | ---: | ---: |\n| RLM | ${rlm.correct}/24 (${rlm.accuracy_pct.toFixed(2)}%) | ${rlm.tokens_per_question.toFixed(2)} | ${rlm.seconds_per_question.toFixed(2)} | ${rlm.requests_per_question.toFixed(2)} | ${rlm.reached_child}/24 |\n| Complete-item stuffing | ${stuffing.correct}/24 (${stuffing.accuracy_pct.toFixed(2)}%) | ${stuffing.tokens_per_question.toFixed(2)} | ${stuffing.seconds_per_question.toFixed(2)} | 1.00 | — |`;
const baselines = `Exact truth-derived most-common constant guess: ${distribution.most_common}/24 (${(distribution.most_common / 24 * 100).toFixed(2)}%). Constant zero: ${distribution.zero}/24 (${(distribution.zero / 24 * 100).toFixed(2)}%).`;
const refusals = `Exact observed outer refusal histograms: RLM ${JSON.stringify(rlm.refusal_histogram)}; stuffing ${JSON.stringify(stuffing.refusal_histogram)}. Exact observed RLM tool refusals: ${JSON.stringify(inner)}.`;
const methodology = METRIC_PROVENANCE.model_tokens + ' Exact scoring, baselines, observed counts and corpus byte lengths are computed from recorded data; wall time is measured. Allocations and ceilings are configured limits. Both arms use the same model and 131072 context allocation, 512 output allocation and temperature 0. The conservative context estimator permits one UTF-8 byte per token, so effective provider context use can be lower than the configured ceiling. RLM limits are 300000 charged tokens, depth 2 and eight ledger calls. Wall time includes SDK work and concurrent host load. There is one invocation and no answer-based tuning, retries of the eval, or confidence interval. Refused runs count incorrect. Lost/unrecorded response counters cannot be included; pending reservations are shown separately. This does not establish an RLM advantage.';
let doc = `# Cloud evaluation after two-phase settlement\n\nModel: \`${data.model}\`; completed at ${data.measured_at_utc}. Seed: \`${data.design}\`. Exactly one authorized live invocation.\n\n${table}\n\n${baselines}\n\n${refusals}\n\nMean RLM accounting charge / reported-or-estimated model / worst-case estimated pending / byte-estimated read tokens: ${rlm.mean_charged_tokens.toFixed(2)} / ${rlm.tokens_per_question.toFixed(2)} / ${rlm.mean_pending_tokens.toFixed(2)} / ${rlm.mean_read_tokens.toFixed(2)}. Charged tokens include reported-or-estimated settled model usage, delivered-read estimates and outstanding reservations.\n\n${methodology}\n\nSources:\n\n`;
for (const source of sources) doc += `- \`${source.repo}\` at \`${source.revision}\`: ${source.items} items, ${source.bytes} JSON bytes.\n`;
doc += '\nAnswer histogram:\n\n| Answer | Count |\n| --- | ---: |\n';
for (const [answer, count] of Object.entries(distribution.histogram)) doc += `| \`${answer}\` | ${count} |\n`;
doc += '\nSee [eval-results.json](../eval-results.json) for every exact question, truth, outcome digest and counter. Raw model responses and source bodies are not published.\n';
const readme = await readFile('README.md', 'utf8');
const startMarker = '<!-- eval-table:start -->';
const endMarker = '<!-- eval-table:end -->';
const start = readme.indexOf(startMarker);
const end = readme.indexOf(endMarker, start);
if (start < 0 || end < start || readme.indexOf(startMarker, start + 1) !== -1 || readme.indexOf(endMarker) !== end || readme.indexOf(endMarker, end + 1) !== -1) throw new Error('README measurement markers are missing, duplicated or out of order');
const block = `<!-- eval-table:start -->\nMeasured once with \`${data.model}\` at a shared 131072 context allocation after two-phase settlement.\n\n${table}\n\n${baselines}\n\n${refusals}\n\n${methodology} See [the cloud evaluation report](docs/EVAL-CLOUD.md) and [per-question results](eval-results.json).\n\nHistorical superseded v1 small-model measurement: RLM 7/24, stuffing 2/24, child reach 0/24, constant zero 12/24. Its [original artifact](https://github.com/unbraind/pm-rlm/blob/aa3787b2c1a2d66ed784a4b0d824eb7341581bc0/eval-results.json) remains available. Those scores do not measure this design.\n<!-- eval-table:end -->`;
const updatedReadme = readme.slice(0, start) + block + readme.slice(end + endMarker.length);
await mkdir('docs', { recursive: true });
await writeFile('eval-results.json', JSON.stringify(result, null, 2) + '\n');
await writeFile('docs/EVAL-CLOUD.md', doc);
await writeFile('README.md', updatedReadme);
console.log(JSON.stringify(result.summary));
