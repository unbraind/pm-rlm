/** Real process interrupted after reservation durability and before a response is recorded. */
import { appendFile } from 'node:fs/promises';
import { PmClient, certifyCompleteListResult } from '@unbrained/pm-cli/sdk';
import { runRlm, resumeRlm } from '../src/engine.ts';
import { smallModel } from './settlement-model.ts';
import type { RlmModel } from '../src/types.ts';
const [workspace, mode, log, run] = process.argv.slice(2);
const model: RlmModel = {
  name: 'settlement-test',
  /** Return twenty small steps while exposing exactly one pre-response crash point. */
  async complete(request) {
    await appendFile(log, 'request\n');
    if (mode === 'kill') {
      const rows = certifyCompleteListResult(await new PmClient({ pmRoot: workspace, noExtensions: true }).listAllComplete()).items;
      process.send!({ run: rows.find(item => typeof item.rlm_state === 'string')!.id });
      await new Promise<void>(() => { setInterval(() => {}, 1000); });
    }
    return smallModel.complete(request);
  },
};
try {
  const result = mode === 'resume' ? await resumeRlm(workspace, run, model) : await runRlm('settlement', { workspace, model, settings: { budget_tokens: 16000 } });
  process.send!({ result });
} catch (error) { process.send!({ error: { code: error instanceof Error && 'code' in error ? error.code : 'unexpected' } }); }
process.disconnect!();
