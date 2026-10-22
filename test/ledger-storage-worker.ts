import { statSync, watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RlmLedger } from '../src/ledger.ts';
import { blobDigest } from '../src/blobs.ts';
import { runRlm, replayRlm, resumeRlm } from '../src/engine.ts';
import { ScriptedModel } from './helpers.ts';

const [workspace, mode, run, attempt = '0'] = process.argv.slice(2);
const ledger = new RlmLedger(workspace);
if (mode === 'no-git') {
  const model = new ScriptedModel(() => '{"action":"finish","answer":"without git"}');
  const result = await runRlm('non-git execution', { workspace, model });
  await resumeRlm(workspace, result.run, model);
  await ledger.gc();
  const root = (await ledger.client.listAllComplete({ includeBody: true })).items.find(item => item.id === result.run)!;
  if (JSON.parse(String(root.rlm_state)).version !== 2) throw new Error('Expected content-addressed storage without git');
  process.send!({ answer: (await replayRlm(workspace, result.run)).answer });
} else {
  const state = await ledger.load(run);
  const prompt = 'x'.repeat(32 * 1024 * 1024) + attempt;
  state.calls[0].steps.push({ prompt, reserved: 17 });
  state.reserved_tokens += 17;
  const directory = join(workspace, mode === 'blob' ? 'rlm-blobs' : 'tasks');
  await mkdir(directory, { recursive: true });
  const prefix = mode === 'blob' ? `.${blobDigest(JSON.stringify(prompt))}.json.` : `.${run}.toon.`;
  let signaled = false;
  const watcher = watch(directory, (_event, name) => {
    const temporary = !signaled && name?.startsWith(prefix) && name.endsWith('.tmp') ? statSync(join(directory, name), { throwIfNoEntry: false }) : undefined;
    if (temporary !== undefined && temporary.size > 0 && temporary.size < 32 * 1024 * 1024) {
      signaled = true;
      process.send!({ run, temporary: name });
      process.kill(process.pid, 'SIGSTOP');
    }
  });
  await ledger.save(state);
  watcher.close();
  process.send!({ missed: true });
}
