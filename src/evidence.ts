import { parseAction } from './protocol.ts';
import { blobDigest } from './blobs.ts';
import { estimateTokens, RlmError } from './errors.ts';
import type { RlmAnswerComponent, RlmCall, RlmItem, RlmState, RlmWitness } from './types.ts';

/** Stable evidence refusal with a machine-readable corrective action. */
export class RlmEvidenceError extends RlmError {
  /** Corrective action safe to show to automated callers. */
  readonly remedy: string;
  /** Keep diagnostics independent of untrusted source text. */
  constructor(message: string, remedy: string) { super('evidence', message); this.remedy = remedy; }
}
/** Refuse malformed or oversized evidence without exposing source material. */
function requireEvidence(condition: boolean, message: string, remedy: string): asserts condition {
  if (!condition) throw new RlmEvidenceError(message, remedy);
}
/** Validate and copy immutable caller-declared question components. */
export function parseComponents(value: unknown): string[] {
  requireEvidence(Array.isArray(value) && value.length > 0 && value.length <= 16, 'Declare 1 to 16 components', 'Supply a nonempty components array with at most 16 entries');
  requireEvidence(value.every(entry => typeof entry === 'string' && entry.trim().length > 0 && estimateTokens(entry) <= 256) && new Set(value).size === value.length, 'Components must be unique bounded text', 'Use distinct nonblank component names of at most 256 UTF-8 bytes');
  return [...value] as string[];
}
/** Bind bounded UTF-16 offsets and exact snapshot text into a SHA-256 witness. */
export function sourceWitness(items: readonly RlmItem[], id: string, start: number, end: number): RlmWitness {
  const item = items.find(item => item.id === id);
  requireEvidence(item !== undefined, 'Witness source is outside this call', 'Select an item in the current authorized scope');
  const serialized = JSON.stringify(item);
  requireEvidence(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= serialized.length, 'Witness offsets are invalid', 'Select a nonempty UTF-16 range inside the serialized source item');
  const text = serialized.slice(start, end);
  requireEvidence(estimateTokens(text) <= 1024, 'Witness exceeds 1024 UTF-8 bytes', 'Request a smaller source range');
  const source = { id, start, end, text };
  return { ...source, digest: blobDigest(JSON.stringify(source)) };
}
/** Verify complete coverage using only earlier successful observations in the same call. */
export function validateAnswer(state: RlmState, call: RlmCall, components: RlmAnswerComponent[], before: number): string {
  requireEvidence(state.components !== undefined, 'This run has no evidence contract', 'Declare components when starting the run');
  const declared = parseComponents(state.components);
  requireEvidence(estimateTokens(components) <= 32768 && components.length === declared.length && components.every((entry, index) => entry.component === declared[index]), 'Answer does not cover the declared components', 'Return each declared component exactly once in declaration order');
  for (const entry of components) {
    requireEvidence(entry.status === 'supported' || entry.status === 'unsupported' || entry.status === 'unknown', 'Invalid component status', 'Use supported, unsupported or unknown');
    requireEvidence(typeof entry.answer === 'string' && typeof entry.reason === 'string' && Array.isArray(entry.witnesses) && entry.witnesses.length <= 8, 'Invalid component evidence', 'Supply bounded answer, reason and at most 8 witness references');
    if (entry.status !== 'supported') {
      requireEvidence(entry.answer === '' && entry.reason.trim().length > 0 && entry.witnesses.length === 0, 'Unavailable evidence cannot support an answer', 'Leave answer and witnesses empty and explain the unsupported or unknown result');
      continue;
    }
    requireEvidence(entry.answer.trim().length > 0 && entry.reason === '' && entry.witnesses.length > 0, 'Supported answer requires source witnesses', 'Request a witness, then cite its prior step and digest');
    const seen = new Set<number>();
    for (const reference of entry.witnesses) {
      requireEvidence(Number.isSafeInteger(reference.step) && reference.step >= 0 && reference.step < before && !seen.has(reference.step), 'Witness reference is unavailable or repeated', 'Cite distinct earlier successful witness steps from this call');
      seen.add(reference.step);
      const step = call.steps[reference.step];
      const observation = step?.observation as { data?: RlmWitness } | undefined;
      const witness = observation?.data;
      requireEvidence(witness !== undefined && typeof witness.digest === 'string', 'Witness observation is missing', 'Request source evidence before answering; omitted observations cannot support answers');
      const expected = sourceWitness(state.snapshot, witness.id, witness.start, witness.end);
      requireEvidence(JSON.stringify(witness) === JSON.stringify(expected) && reference.digest === expected.digest, 'Witness digest differs from its source', 'Re-run with an intact frozen source snapshot and exact witness digest');
      // A read/aggregate observation must never masquerade as a witness action.
      requireEvidence(step.response !== undefined && parseAction(step.response.text, state.parser_version ?? 1).action === 'witness', 'Reference is not a witness step', 'Cite a source witness action');
    }
  }
  return JSON.stringify(components);
}

/** Additional protocol for opt-in coverage runs; legacy prompts remain byte-for-byte stable. */
export const EVIDENCE_PROTOCOL = `Evidence contract: every recursive call must answer every declared component in order. Use these extra actions:
{"action":"witness","id":"item-id","start":0,"end":100}
{"action":"answer","components":[{"component":"declared name","status":"supported","answer":"answer text","reason":"","witnesses":[{"step":0,"digest":"64 lowercase SHA-256 hex characters"}]}]}
witness reads JSON-serialized source items with UTF-16 offsets and a maximum 1024-byte excerpt. Its digest binds id, offsets and text. Cite at most 8 distinct earlier witness steps per supported component. unknown/unsupported require answer:"", witnesses:[] and a nonblank reason. Include every component, at most 32768 UTF-8 bytes total. finish is refused. Child calls inherit the declarations and may cite only their own observations. Evidence verifies provenance and declared coverage, not semantic entailment.
Declared components: `;
