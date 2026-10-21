/** Offline storage-format benchmark on the exact public evaluation revisions; no model endpoint. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { certifyCompleteListResult, createHistoryEntry, emptyImportedDocument, parseItemDocument, PmClient, serializeItemDocument, writeFileAtomic } from '@unbrained/pm-cli/sdk';
import { RlmBlobs } from '../src/blobs.ts';
import { RlmLedger } from '../src/ledger.ts';
import { runRlm } from '../src/engine.ts';
import { copyVerifiedRevision, publicSource } from './live.ts';
import { ScriptedModel } from './helpers.ts';
import type { RlmState } from '../src/types.ts';

/** Sum logical file lengths and allocated file blocks in this isolated tracker only. */
async function sizes(workspace: string) {
  let bytes = 0; let allocated_bytes = 0; let history_bytes = 0; let blob_bytes = 0;
  const entries = await readdir(workspace, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const info = await stat(path);
    bytes += info.size; allocated_bytes += info.blocks * 512;
    if (entry.parentPath === join(workspace, 'history')) history_bytes += info.size;
    if (entry.parentPath === join(workspace, 'rlm-blobs')) blob_bytes += info.size;
  }
  return { bytes, allocated_bytes, history_bytes, blob_bytes };
}

/** Median warm certified complete-list latency, verifying full ledger row counts every time. */
async function latency(workspace: string, runs: number) {
  const client = new PmClient({ pmRoot: workspace, noExtensions: true });
  const milliseconds = [];
  for (let index = 0; index < 4; index++) {
    const start = performance.now();
    const result = certifyCompleteListResult(await client.listAllComplete({ includeBody: true }));
    const elapsed = performance.now() - start;
    assert.equal(result.items.filter(item => typeof item.rlm_state === 'string').length, runs);
    if (index > 0) milliseconds.push(elapsed);
  }
  return { complete_read_ms: milliseconds.sort((a, b) => a - b)[1], samples_ms: milliseconds };
}

/** Advance complete-corpus receipts as roots accumulate, including exact changed prompt accounting. */
function repeatedState(captured: RlmState, run: number): RlmState {
  const state = structuredClone(captured);
  state.run = `scale-run-${run}`;
  state.certificate.item_count += run;
  state.certificate.unique_item_id_count += run;
  for (const call of state.calls) {
    call.id = state.run;
    for (const step of call.steps) {
      const previous = Buffer.byteLength(step.prompt);
      for (const field of ['item_count', 'unique_item_id_count'] as const) {
        step.prompt = step.prompt.replaceAll(`"${field}":${captured.certificate[field]},`, `"${field}":${state.certificate[field]},`);
      }
      const delta = Buffer.byteLength(step.prompt) - previous;
      step.reserved += delta; state.reserved_tokens += delta;
      if (step.response !== undefined) step.response.tokens_in += delta;
      const observation = step.observation as { complete_list?: typeof state.certificate } | undefined;
      if (observation?.complete_list !== undefined) observation.complete_list = structuredClone(state.certificate);
    }
  }
  return state;
}

const scratch = await mkdtemp(join(tmpdir(), 'rlm-storage-scale-'));
const design = JSON.parse(await readFile('docs/eval-design.json', 'utf8')) as { sources: { repo: string; revision: string }[] };
const report = { methodology: 'Storage-format microbenchmark: captured real two-step aggregate/finish engine checkpoints, repeated with distinct run ids through native SDK TOON serialization and sealed history diffs. Corpus receipt counts and embedded prompts advance with accumulated roots, including exact prompt-byte accounting. Both arms retain identical checkpoint transitions in history and materialize each final item once; intermediate item flushes and write throughput are excluded. Each source uses its existing eval-design revision in independent plain-directory trackers. No inference, full-engine throughput, provider quality, cold-cache latency or power-loss durability claim. Logical/allocated file bytes include the entire tracker. Complete reads are SDK-certified full-item reads; median of three warm samples after one warm-up.', sources: [] as { repo: string; revision: string; checkpoints_per_run: number; source_bytes: number; measurements: Record<string, unknown>[] }[] };
try {
  for (const source of design.sources) {
    const visibility = JSON.parse(execFileSync('gh', ['repo', 'view', `unbraind/${source.repo}`, '--json', 'visibility'], { encoding: 'utf8' })) as { visibility: string };
    assert.equal(visibility.visibility, 'PUBLIC');
    assert.equal(execFileSync('gh', ['api', `repos/unbraind/${source.repo}/commits/${source.revision}`, '--jq', '.sha'], { encoding: 'utf8' }).trim(), source.revision);
    const copy = await copyVerifiedRevision(publicSource(source.repo), source.revision, join(scratch, source.repo));
    const captures: RlmState[] = [];
    const save = RlmLedger.prototype.save; const materialize = RlmLedger.prototype.materialize;
    RlmLedger.prototype.save = async function(state) { captures.push(structuredClone(state)); await save.call(this, state); };
    RlmLedger.prototype.materialize = async function(state, call) { if (call.depth === 0 && captures.length === 0) captures.push(structuredClone(state)); await materialize.call(this, state, call); };
    let seed;
    try {
      seed = await runRlm('How many source items are there?', { workspace: copy.workspace, model: new ScriptedModel((_request, index) => index === 0 ? '{"action":"count"}' : '{"action":"finish","answer":"measured"}') });
    } finally { RlmLedger.prototype.save = save; RlmLedger.prototype.materialize = materialize; }
    const template = parseItemDocument(await readFile(join(copy.workspace, 'tasks', `${seed.run}.toon`), 'utf8'));
    await rm(join(copy.workspace, 'tasks', `${seed.run}.toon`));
    await rm(join(copy.workspace, 'history', `${seed.run}.jsonl`));
    for (const directory of ['runtime', 'locks', 'transactions', 'search', 'rlm-blobs']) await rm(join(copy.workspace, directory), { recursive: true, force: true });
    const result = { ...source, checkpoints_per_run: captures.length, source_bytes: Buffer.byteLength(JSON.stringify(captures[0].snapshot)), measurements: [] as Record<string, unknown>[] };
    for (const format of ['before', 'after']) {
      const workspace = join(scratch, `${source.repo}-${format}`);
      await cp(copy.workspace, workspace, { recursive: true });
      const blobs = new RlmBlobs(workspace);
      for (let run = 1; run <= 500; run++) {
        const id = `scale-run-${run}`;
        let before = emptyImportedDocument();
        const history = [];
        for (const [index, captured] of captures.entries()) {
          const state = repeatedState(captured, run);
          const checkpoint = format === 'before' ? JSON.stringify(state) : await blobs.encode(state);
          const after = { ...template, metadata: { ...template.metadata, id, rlm_run: id, rlm_state: checkpoint } };
          history.push(createHistoryEntry({ nowIso: new Date(1800000000000 + run * 100 + index).toISOString(), author: 'scale-fixture', op: index === 0 ? 'create' : 'update', before, after, message: 'Checkpoint recursive run' }));
          before = after;
        }
        // Only final items contribute to disk/read measurements; retain every native history transition.
        await writeFileAtomic(join(workspace, 'tasks', `${id}.toon`), serializeItemDocument(before));
        await writeFile(join(workspace, 'history', `${id}.jsonl`), history.map(entry => JSON.stringify(entry) + '\n').join(''));
        if ([10, 100, 500].includes(run)) {
          const measured = { format, runs: run, ...await sizes(workspace), ...await latency(workspace, run) };
          result.measurements.push(measured);
          console.log(JSON.stringify({ repo: source.repo, ...measured }));
        }
      }
      // Every historical reference remains readable after a full mark/sweep.
      if (format === 'after') await new RlmLedger(workspace).gc();
      await rm(workspace, { recursive: true, force: true });
    }
    report.sources.push(result);
    await writeFile('docs/ledger-scale.json', JSON.stringify(report, null, 2) + '\n');
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
