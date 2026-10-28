/** Global host symlinks must resolve the packed SDK through ordinary package imports. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { npmEnvironment } from '../scripts/environment.ts';
import { verifyPackedRepairBudget } from './repair-consumer.ts';

/** Run one isolated consumer command; all diagnostics stay local to the disposable fixture. */
function invoke(executable: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(executable, argv, { cwd, env, encoding: 'utf8', timeout: 300000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.error, undefined);
  return result.stdout;
}

/** Each manager owns a private global prefix and executes its real installed host binary. */
for (const manager of ['npm', 'bun']) test(`packed repair works through ${manager} global pm symlink`, t => {
  const repository = resolve(import.meta.dirname, '..');
  const scratch = mkdtempSync(join(tmpdir(), 'repair-global-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const prefix = join(scratch, 'prefix');
  const globalDir = manager === 'npm' ? join(prefix, 'lib') : join(prefix, 'install', 'global');
  const bin = join(prefix, 'bin');
  const env = { ...npmEnvironment(process.env), HOME: scratch, BUN_INSTALL: prefix, BUN_INSTALL_GLOBAL_DIR: globalDir, BUN_INSTALL_BIN: bin, PM_AUTHOR: 'repair-packed', GIT_CEILING_DIRECTORIES: scratch };
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
  const archive = JSON.parse(invoke('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], repository, env)) as { filename: string }[];
  const artifact = join(scratch, archive[0].filename);
  const host = `@unbrained/pm-cli@${manifest.devDependencies['@unbrained/pm-cli']}`;
  invoke(manager, manager === 'npm' ? ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', host, artifact] : ['add', '--global', '--ignore-scripts', host, artifact], scratch, env);
  const binary = join(bin, 'pm');
  assert.equal(lstatSync(binary).isSymbolicLink(), true);
  const project = join(scratch, 'project'); mkdirSync(project);
  const workspace = join(project, '.agents', 'pm');
  const projectEnv = { ...env, PM_PATH: workspace };
  invoke(binary, ['init', '--prefix', 'repair-packed', '--defaults', '--agent-guidance', 'skip'], project, projectEnv);
  invoke(binary, ['package', 'install', artifact], project, projectEnv);
  symlinkSync(join(globalDir, 'node_modules'), join(project, 'node_modules'), 'junction');
  writeFileSync(join(project, 'package.json'), '{"type":"module"}');
  writeFileSync(join(project, 'fixture.ts'), `import { runRlm, repairRlm } from 'pm-rlm';
import { PmClient } from '@unbrained/pm-cli/sdk';
const workspace = process.env.PM_PATH!;
const source = (await new PmClient({ pmRoot: workspace, noExtensions: true }).create({ title: 'Global packed source', parent: 'none' })).item.id;
const result = await runRlm('Complete the source component', { workspace, scope: { ids: [source] }, components: ['source'], model: { name: 'packed-repair', complete: async () => ({ text: JSON.stringify({ action: 'answer', components: [{ component: 'source', status: 'unsupported', answer: '', reason: 'Fixture gap', witnesses: [] }] }), tokens_in: 20, tokens_out: 10 }) } });
const parts = [{ name: 'source', question: 'What is established?', sources: [source], depends_on: [] }];
const receipt = await repairRlm({ source: result.run, parts, budget_tokens: 0 }, { workspace });
if (receipt.status !== 'partial' || receipt.calls !== 0) throw new Error('Packed SDK repair failed');
console.log(JSON.stringify({ run: result.run, parts }));
`);
  const setup = JSON.parse(invoke(manager === 'npm' ? process.execPath : 'bun', ['fixture.ts'], project, projectEnv)) as { run: string; parts: unknown[] };
  const receipt = JSON.parse(invoke(binary, ['rlm', 'repair', setup.run, '--parts', JSON.stringify(setup.parts), '--budget-tokens', '0', '--json'], project, projectEnv)) as { run: string; status: string; gaps: string[] };
  assert.equal(receipt.status, 'partial'); assert.deepEqual(receipt.gaps, ['source']);
  const resumed = JSON.parse(invoke(binary, ['rlm', 'repair-resume', receipt.run, '--json'], project, projectEnv)) as { gaps: string[] };
  assert.deepEqual(resumed.gaps, receipt.gaps);
  verifyPackedRepairBudget(repository, project, args => invoke(manager === 'npm' ? process.execPath : 'bun', args, project, projectEnv), [args => invoke(binary, args, project, projectEnv)]);
});
