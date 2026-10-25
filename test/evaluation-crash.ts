/** Real process-crash worker; the parent kills it after each durable controller boundary. */
import { readFile } from 'node:fs/promises';
import { evaluateRlm } from '../src/evaluation.ts';
import type { ModelRequest } from '../src/types.ts';
process.on('message', () => {});
const [workspace, file, boundary, encodedSources] = process.argv.slice(2);
const suite: unknown = JSON.parse(await readFile(file, 'utf8'));
const sources = JSON.parse(encodedSources) as Record<string, string>;
await evaluateRlm(suite, { workspace, sources, id: 'trial', model: 'scripted-test-only', mode: 'stub', stub: {
  name: 'scripted-test-only', async complete(request: ModelRequest) {
    const text = request.response_kind === 'answer' ? '{"answer":"1"}' : '{"action":"finish","answer":"1"}';
    return { text, tokens_in: Buffer.byteLength(request.prompt), tokens_out: Buffer.byteLength(text) };
  },
}, on_boundary: async step => {
  if (step === boundary) { process.send?.({ run: 'trial' }); await new Promise<void>(() => {}); }
} });
