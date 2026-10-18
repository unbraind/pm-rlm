/** Real process worker used solely for SIGKILL recovery verification. */
import { appendFile } from 'node:fs/promises';
import { resumeRlm, runRlm } from '../src/engine.ts';
import { PROTOCOL } from '../src/protocol.ts';
import { ScriptedModel } from './helpers.ts';
const [workspace, mode, requestLog, runId] = process.argv.slice(2);
const model = new ScriptedModel(async request => {
  const input = JSON.parse(request.prompt.slice(PROTOCOL.length + 1)) as { question: string; transcript: { observation?: { result: string } }[] };
  await appendFile(requestLog, `${input.question}\n`);
  if (input.question === 'first') return JSON.stringify({ action: 'finish', answer: '7' });
  if (input.question === 'second') return JSON.stringify({ action: 'finish', answer: '11' });
  const step = input.transcript.length;
  return JSON.stringify(step < 2 ? { action: 'spawn', subgoal: step === 0 ? 'first' : 'second', slice: { fragments: [], estimated_tokens: 2 } } : { action: 'finish', answer: input.transcript.map(entry => entry.observation!.result).join('+') });
});
const result = mode === 'resume' ? await resumeRlm(workspace, runId, model, 'rlm-test') : await runRlm('sum', { workspace, model, author: 'rlm-test', on_call_complete: async call => {
  if (mode === 'kill' && call.subgoal === 'first') {
    process.send!({ run: call.id.slice(0, call.id.lastIndexOf('-c')), completed: call.id });
    await new Promise<void>(() => { setInterval(() => {}, 1000); });
  }
} });
process.send!({ result });
process.disconnect!();
