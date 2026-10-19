/** Revert one behavior at a time, demand its assertion failure, and restore exact source bytes. */
import { proveRevert } from './revert-source.ts';

const portableFile = 'test/constrained.test.ts';
const currentPortable = `  const base = pathToFileURL(resolve('workspace/package space % é/worktrees/pm-rlm-v2/test/live-v2.ts'));
  assert.equal(publicSource('pm-vcs', base.href), fileURLToPath(new URL('../../../fleet/pm-vcs/', base)));
  assert.ok(publicSource('pm-vcs', base.href).includes('package space % é'));
  assert.ok(publicSource('pm-vcs').endsWith(join('fleet', 'pm-vcs') + sep));`;
const oldPortable = `  assert.equal(publicSource('pm-vcs', pathToFileURL('/workspace/package space % é/worktrees/pm-rlm-v2/test/live-v2.ts').href), '/workspace/package space % é/fleet/pm-vcs/');
  assert.ok(publicSource('pm-vcs').endsWith('/fleet/pm-vcs/'));`;
const proofs = [
  { name: 'numeric type/value ordering', file: 'src/aggregates.ts', before: '[...groups.values()].sort((a, b) => compareScalars(a.value, b.value))', after: '[...groups.keys()].sort().map(key => groups.get(key)!)', pattern: '^review r4 scalar' },
  { name: 'new checkpoint version', file: 'src/engine.ts', before: 'aggregate_version: 2, ', after: '', pattern: '^review r4 checkpoint' },
  { name: 'legacy replay version selection', file: 'src/engine.ts', before: 'state.settings.budget_tokens, state.aggregate_version ?? 1)', after: 'state.settings.budget_tokens, 2)', pattern: '^review r4 checkpoint' },
  { name: 'legacy resume version selection', file: 'src/engine.ts', before: 'state.settings.budget_tokens - state.reserved_tokens, state.aggregate_version ?? 1)', after: 'state.settings.budget_tokens - state.reserved_tokens, 2)', pattern: '^review r4 checkpoint' },
  { name: 'unknown checkpoint version refusal', file: 'src/ledger.ts', before: "      if (decoded.aggregate_version !== undefined && ![1, 2].includes(decoded.aggregate_version as number)) throw new Error('Invalid aggregate version');\n", after: '', pattern: '^review r4 checkpoint' },
  { name: 'portable assertions', file: portableFile, before: currentPortable, after: oldPortable, pattern: '^review r4 portable' },
  { name: 'empty history filtering', file: 'test/report-v2.ts', before: ".split('\\n').filter(line => line !== '')", after: ".trim().split('\\n')", pattern: '^review r4 report' },
];
for (const proof of proofs) proveRevert(proof, 'test/review-r4.test.ts', 180000);
console.log(`${proofs.length}/${proofs.length} round-four behavioral revert proofs; source restored byte-for-byte`);
