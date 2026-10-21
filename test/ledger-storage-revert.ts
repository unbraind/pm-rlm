/** Behavioral storage regressions with exact restoration; all tests import authored source directly. */
import { proveRevert } from './revert-source.ts';

const testFile = 'test/ledger-storage.test.ts';
proveRevert({ name: 'legacy inline writer', file: 'src/blobs.ts', before: "    return JSON.stringify({ version: 2, run: state.run, reserved_tokens, snapshot: snapshotRef, transcript });", after: '    return JSON.stringify(state);', pattern: 'content addressed manifests' }, testFile);
proveRevert({ name: 'digest verification', file: 'src/blobs.ts', before: "    if (bytes === null || blobDigest(bytes) !== digest) throw new RlmError('incomplete', 'Ledger blob is missing or corrupt');", after: "    if (bytes === null) throw new RlmError('incomplete', 'Ledger blob is missing or corrupt');", pattern: 'blob reads refuse' }, testFile);
proveRevert({ name: 'reachable blob collection', file: 'src/blobs.ts', before: '        await removeFileIfExists(path);', after: '        void path;', pattern: 'GC removes orphans' }, testFile);
proveRevert({ name: 'non-git content-addressed publication', file: 'src/blobs.ts', before: "    return JSON.stringify({ version: 2, run: state.run, reserved_tokens, snapshot: snapshotRef, transcript });", after: '    return JSON.stringify(state);', pattern: 'non-git tracker with no git' }, testFile);

proveRevert({ name: 'lease-free hydration', file: 'src/ledger.ts', before: "    // Historical manifests pin every committed version, including one read before a concurrent save.\n    const blobs = new RlmBlobs(this.workspace);", after: "    return this.storage(async blobs => this.loadCheckpoint(run, blobs));\n  }\n  /** Restore the prior read-side storage lease for this behavioral proof. */\n  private async loadCheckpoint(run: string, blobs: RlmBlobs): Promise<RlmState> {", pattern: 'load and replay preserve lease-free' }, testFile);
proveRevert({ name: 'unknown storage GC refusal', file: 'src/blobs.ts', before: "    if (manifest.version === 1) return manifest;\n    if (manifest.version !== 2) throw new RlmError('incomplete', 'Unsupported ledger storage version');", after: "    if (manifest.version !== 2) return manifest;", pattern: 'GC refuses unknown storage versions' }, testFile);
console.log('6/6 storage revert proofs passed');
