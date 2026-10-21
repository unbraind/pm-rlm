/** Behavioral storage regressions with exact restoration; all tests import authored source directly. */
import { proveRevert } from './revert-source.ts';

const testFile = 'test/ledger-storage.test.ts';
proveRevert({ name: 'legacy inline writer', file: 'src/blobs.ts', before: "    return JSON.stringify({ version: 2, run: state.run, reserved_tokens, snapshot: snapshotRef, transcript });", after: '    return JSON.stringify(state);', pattern: 'content addressed manifests' }, testFile);
proveRevert({ name: 'digest verification', file: 'src/blobs.ts', before: "    if (bytes === null || blobDigest(bytes) !== digest) throw new RlmError('incomplete', 'Ledger blob is missing or corrupt');", after: "    if (bytes === null) throw new RlmError('incomplete', 'Ledger blob is missing or corrupt');", pattern: 'blob reads refuse' }, testFile);
proveRevert({ name: 'reachable blob collection', file: 'src/blobs.ts', before: '        await removeFileIfExists(path);', after: '        void path;', pattern: 'GC removes orphans' }, testFile);
proveRevert({ name: 'non-git content-addressed publication', file: 'src/blobs.ts', before: "    return JSON.stringify({ version: 2, run: state.run, reserved_tokens, snapshot: snapshotRef, transcript });", after: '    return JSON.stringify(state);', pattern: 'non-git tracker with no git' }, testFile);

console.log('4/4 storage revert proofs passed');
