/** Small deterministic LM used only by settlement tests and their runtime worker. */
import { PROTOCOL } from '../src/protocol.ts';
import type { RlmModel } from '../src/types.ts';
/** Emit twenty steps with explicit actual usage; tracker calls always use the real SDK. */
export const smallModel: RlmModel = { name: 'settlement-test', complete: async request => {
  const input = JSON.parse(request.prompt.slice(PROTOCOL.length + 1)) as { transcript: unknown[] };
  return { text: JSON.stringify(input.transcript.length === 19 ? { action: 'finish', answer: 'settled' } : { action: 'unknown' }), tokens_in: 40, tokens_out: 4 };
} };
