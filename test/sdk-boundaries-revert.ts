import { proveRevert } from './revert-source.ts';

const file = 'test/sdk-boundaries.test.ts';
proveRevert({ name: 'authoritative history verification after cache priming', file: 'src/environment.ts', before: 'history.length === 0 || !verifyHistoryEntries(history).ok', after: 'history.length === 0', pattern: '^history rejects same-size corruption' }, file);
proveRevert({ name: 'verified collection before sweeping blobs', file: 'src/ledger.ts', before: "if (!verifyHistoryEntries(history).ok) throw new RlmError('incomplete', 'History chain is invalid; collection refused');", after: 'verifyHistoryEntries(history);', pattern: '^collection retains orphans' }, file);
proveRevert({ name: 'literal frozen filter semantics', file: 'src/environment.ts', before: 'item.type === filter.type', after: "filter.type.split(',').includes(item.type)", pattern: '^SDK adoption preserves frozen' }, file);
const portability = 'test/validation-portability.test.ts';
proveRevert({ name: 'standalone parity preflight', file: 'test/sdk-boundaries-public.ts', before: 'if (missing.length > 0)', after: 'if (false)', pattern: '^public parity skips' }, portability);
proveRevert({ name: 'scaled regression deadlines', file: 'test/revert-source.ts', before: 'Math.ceil(milliseconds * scale)', after: 'milliseconds', pattern: '^regression deadlines' }, portability);
proveRevert({ name: 'timeout is missing evidence', file: 'test/revert-source.ts', before: "if (result.error?.code === 'ETIMEDOUT')", after: 'if (false)', pattern: '^regression deadlines' }, portability);
console.log('6/6 SDK boundary revert proofs passed');
