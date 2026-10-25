import { proveRevert } from './revert-source.ts';

const file = 'test/sdk-boundaries.test.ts';
proveRevert({ name: 'authoritative history verification after cache priming', file: 'src/environment.ts', before: 'history.length === 0 || !verifyHistoryEntries(history).ok', after: 'history.length === 0', pattern: '^history rejects same-size corruption' }, file);
proveRevert({ name: 'verified collection before sweeping blobs', file: 'src/ledger.ts', before: "if (!verifyHistoryEntries(history).ok) throw new RlmError('incomplete', 'History chain is invalid; collection refused');", after: 'verifyHistoryEntries(history);', pattern: '^collection retains orphans' }, file);
proveRevert({ name: 'literal frozen filter semantics', file: 'src/environment.ts', before: 'item.type === filter.type', after: "filter.type.split(',').includes(item.type)", pattern: '^SDK adoption preserves frozen' }, file);
