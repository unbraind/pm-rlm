import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { runRlm, replayRlm, RlmLedger, createRlmContext, partitionItems, compactReuseResult, reuseRlm } from '../dist/index.js';
import type { ModelRequest, RlmModel } from '../dist/index.js';

// Read only committed public tracker bytes. All SDK writes use the disposable copy.
const checkout = resolve(process.argv[2] ?? '.');
const revision = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: checkout, encoding: 'utf8' }).trim();
const archive = execFileSync('git', ['archive', revision, '.agents/pm'], { cwd: checkout, maxBuffer: 64 * 1024 * 1024 });
const fingerprint = createHash('sha256').update(archive).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'rlm-public-reuse-'));
try {
  await mkdir(root, { recursive: true });
  execFileSync('tar', ['-x', '-C', root], { input: archive });
  const workspace = join(root, '.agents', 'pm');
  const client = new PmClient({ pmRoot: workspace, noExtensions: true, author: 'reuse-validation' });
  const corpus = (await createRlmContext({ workspace, budget: 1000000000 })).list().data;
  assert.ok(corpus.length >= 2);
  const ids = corpus.slice(0, 2).map(item => item.id);
  const slices = ids.map(id => partitionItems(corpus.filter(item => item.id === id), 1000)[0]);
  let requests = 0;
  const model: RlmModel = {
    name: 'scripted-protocol-fixture',
    /** Exercise the real recursive protocol on public data without inference quality claims. */
    async complete(request: ModelRequest) {
      requests++;
      const input = JSON.parse(request.prompt.split('\n').at(-1)!) as { question: string; transcript: unknown[] };
      const index = input.transcript.length;
      const action = input.question === 'Read both public items' && index < 2
        ? { action: 'spawn', subgoal: `Read public item ${index}`, slice: slices[index] }
        : { action: 'finish', answer: input.question === 'Read both public items' ? 'Both subanswers recorded' : 'Selected public item observed' };
      const text = JSON.stringify(action);
      return { text, tokens_in: Buffer.byteLength(request.prompt), tokens_out: Buffer.byteLength(text) };
    },
  };
  const reuse_identity = { tool_policy: 'snapshot-v1', model_policy: 'scripted-fixture-v1', consent: `public:${revision}` };
  const source = await runRlm('Read both public items', { workspace, model, reuse_identity, scope: { ids } });
  const state = await new RlmLedger(workspace).load(source.run);
  const baseline = requests;
  const options = { workspace, reuse_identity, scope: state.scope, settings: state.settings };
  const first = await reuseRlm('Read public item 0', { ...options, selection: { run: source.run, call: state.calls[1].id } });
  assert.equal(first.status, 'reused');
  if (first.status !== 'reused') throw new Error('Reuse validation failed');
  await replayRlm(workspace, first.run);
  await client.update(ids[0], { description: 'Public-copy revision probe' });
  await assert.rejects(reuseRlm('Read public item 0', { ...options, selection: { run: source.run, call: state.calls[1].id } }), { dimension: 'snapshot' });
  const independent = await reuseRlm('Read public item 1', { ...options, selection: { run: source.run, call: state.calls[2].id } });
  assert.equal(independent.status, 'reused');
  assert.equal(requests, baseline);
  const after = execFileSync('git', ['archive', revision, '.agents/pm'], { cwd: checkout, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(createHash('sha256').update(after).digest('hex'), fingerprint);
  console.log(JSON.stringify({ source: 'unbraind/pm-rlm', revision, source_archive_sha256: fingerprint, public_items: corpus.length, scoped_items: ids.length, original_logical_calls: source.calls, original_model_requests: baseline, reused_subanswers: 2, new_model_requests: requests - baseline, changed_source_revisions: 1, dependent_refusals: 1, unaffected_reuses: 1, new_tokens_in: first.tokens_in, new_tokens_out: first.tokens_out, new_reserved_tokens: first.reserved_tokens, compact_json_bytes: Buffer.byteLength(JSON.stringify(compactReuseResult(first))), git_required_at_runtime: false, source_bytes_unchanged: true, model: 'scripted protocol fixture; no inference quality or billing claim' }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
