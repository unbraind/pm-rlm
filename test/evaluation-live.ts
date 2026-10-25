/** Run the frozen paired comparison on independently verified public scratch copies. */
import { mkdtemp, readFile, writeFile, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { evaluateRlm, evalDigest } from '../src/evaluation.ts';
import type { ModelRequest } from '../src/types.ts';
import { readCorpus } from '../src/environment.ts';

const { sources } = JSON.parse(await readFile('evaluation-sources.local.json', 'utf8')) as { sources: Record<string, string> };
const suite: unknown = JSON.parse(await readFile('docs/public-eval-suite.json', 'utf8'));
const root = await mkdtemp(join(tmpdir(), 'rlm-live-receipt-'));
const workspace = join(root, '.agents', 'pm');
await new PmClient({ cwd: root, pmRoot: workspace, author: 'rlm-eval', noExtensions: true }).init('eval', { defaults: true, agentGuidance: 'skip', mergeFence: false });
await writeFile('evaluation-run.local.json', JSON.stringify({ root, workspace, sources }) + '\n');
const paths = ['src/evaluation.ts', 'src/evaluation-types.ts', 'src/engine.ts', 'src/adapters.ts', 'src/environment.ts', 'src/protocol.ts', 'src/ledger.ts', 'src/settings.ts'];
let implementation = '';
for (const path of paths) implementation += path + '\0' + await readFile(path, 'utf8');
const implementation_sha256 = evalDigest(implementation);
const sourceCounts = [];
for (const [id, source] of Object.entries(sources)) { const { items } = await readCorpus(source); sourceCounts.push({ id, items: items.length, bytes: Buffer.byteLength(JSON.stringify(items)) }); }
/** Make only the already verified scratch source copies read-only, including directories. */
async function freezeCopy(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) await freezeCopy(child);
    else await chmod(child, 0o444);
  }
  await chmod(root, 0o555);
}
for (const source of Object.values(sources)) await freezeCopy(source);
const started_at = new Date().toISOString();
const mode = process.argv.includes('--stub') ? 'stub' : 'local';
const model = mode === 'stub' ? 'constant-zero-stub' : process.env.PM_RLM_EVAL_MODEL ?? 'gemma3:4b';
const stub = mode === 'stub' ? { name: model, async complete(request: ModelRequest) {
  const text = request.response_kind === 'answer' ? '{"answer":"0"}' : '{"action":"finish","answer":"0"}';
  return { text, tokens_in: Buffer.byteLength(request.prompt), tokens_out: Buffer.byteLength(text) };
} } : undefined;
const result = await evaluateRlm(suite, { workspace, sources, id: mode + '-v1', model, mode, stub, full: true, on_boundary: step => { if (step === 'row_settled') console.log('paired row settled'); } });
const source_integrity = [];
for (const [id, source] of Object.entries(sources)) source_integrity.push({ id, after_sha256: evalDigest(JSON.stringify((await readCorpus(source)).items)), read_only_copy: true });
await writeFile('docs/public-eval-results.json', JSON.stringify({ ...result, started_at, finished_at: new Date().toISOString(), implementation_sha256, source_counts: sourceCounts, source_integrity, live_comparison: mode === 'stub' ? 'pending: local inventory reachable, but Gemma inference exceeded 60 seconds and a minimal FunctionGemma availability probe exceeded 20 seconds; no live accuracy claim' : 'complete', methodology: 'One sequential trial; truncated first, recursive second. Temperature zero; shared context and output allocations. Model counters are reported or byte-estimated; failed requests can have unknown usage. Wall time includes tracker IO and host load. No raw model output or source bodies are published. Child reach is observed, never forced. Interrupted arms are not retried.' }, null, 2) + '\n');
console.log(JSON.stringify(result.summary));
