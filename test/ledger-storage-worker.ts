import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RlmLedger } from '../src/ledger.ts';
import { runRlm, replayRlm, resumeRlm } from '../src/engine.ts';
import { ScriptedModel } from './helpers.ts';

const [workspace, mode, run] = process.argv.slice(2);
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
  state.calls[0].steps.push({ prompt: 'x'.repeat(32 * 1024 * 1024), reserved: 17 });
  state.reserved_tokens += 17;
  const directory = join(workspace, mode === 'blob' ? 'rlm-blobs' : 'tasks');
  await mkdir(directory, { recursive: true });
  const watcher = watch(directory, (_event, name) => {
    if (name?.endsWith('.tmp')) {
      process.send!({ run, temporary: name });
      process.kill(process.pid, 'SIGSTOP');
    }
  });
  await ledger.save(state);
  watcher.close();
  throw new Error('Crash window was not reached');
}
