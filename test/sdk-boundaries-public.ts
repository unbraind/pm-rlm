import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { copyVerifiedRevision, publicSource } from './live.ts';
import { gitEnvironment, testEnvironment } from '../scripts/environment.ts';

const root = resolve(import.meta.dirname, '..');
const missing = ['pm-rlm', 'pm-lint'].filter(repo => !existsSync(join(publicSource(repo), '.git')));
if (missing.length > 0) {
  console.log(`SKIP SDK public parity: missing fleet checkouts (${missing.join(', ')}). See README.md for fixture prerequisites; no parity evidence generated.`);
} else {
const scratch = await mkdtemp(join(tmpdir(), 'rlm-sdk-parity-'));
const env = { ...gitEnvironment(process.env), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const lockedDirectories: string[] = [];

/** Enumerate copied files so preservation checks also detect newly created caches. */
async function copiedFiles(workspace: string): Promise<string[]> {
  const listing = await readdir(workspace, { recursive: true, withFileTypes: true });
  return listing.flatMap(entry => entry.isFile() ? [resolve(entry.parentPath, entry.name)] : []).sort();
}

try {
  const baseline = join(scratch, 'baseline');
  await mkdir(baseline);
  const revision = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: root, env, encoding: 'utf8' }).trim();
  execFileSync('git', ['diff', '--exit-code', revision, '--', 'src', 'index.ts'], { cwd: root, env });
  const archive = execFileSync('git', ['archive', revision], { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', baseline], { input: archive });
  await symlink(join(root, 'node_modules'), join(baseline, 'node_modules'));
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], { cwd: baseline, env });
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], { cwd: root, env });
  await copyFile(join(root, 'test/sdk-boundaries-worker.ts'), join(baseline, 'test/sdk-boundaries-worker.ts'));
  for (const [name, build] of [['baseline', baseline], ['candidate', root]]) {
    const config = join(scratch, `${name}-worker.json`);
    await writeFile(config, JSON.stringify({ extends: join(build, 'tsconfig.json'), compilerOptions: { typeRoots: [join(root, 'node_modules/@types')] }, include: [join(build, 'test/sdk-boundaries-worker.ts')] }));
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', config], { cwd: build, env, encoding: 'utf8' });
  }
  const measurements = [];
  for (const source of [{ repo: 'pm-rlm', revision }, { repo: 'pm-lint', revision: 'f2c20efa78139f4071f3dd08d317bea05337fe28' }]) {
    const repository = `repos/unbraind/${source.repo}`;
    assert.equal(execFileSync('gh', ['api', repository, '--jq', '.private'], { encoding: 'utf8' }).trim(), 'false');
    const remoteRevision = execFileSync('gh', ['api', `${repository}/commits/${source.revision}`, '--jq', '.sha'], { encoding: 'utf8' }).trim();
    assert.equal(remoteRevision, source.revision);
    const copy = await copyVerifiedRevision(publicSource(source.repo), source.revision, join(scratch, source.repo));
    const entries = await copiedFiles(copy.workspace);
    const before = await Promise.all(entries.map(path => readFile(path)));
    for (const path of entries) await chmod(path, 0o444);
    const directories = [copy.workspace, ...(await readdir(copy.workspace, { recursive: true, withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(entry.parentPath, entry.name))];
    for (const path of directories) { await chmod(path, 0o555); lockedDirectories.push(path); }
    const runEnv = { ...testEnvironment(env), GIT_CEILING_DIRECTORIES: dirname(scratch), PATH: scratch };
    const outputs = [];
    for (const [name, build] of [['before', baseline], ['after', root]]) {
      outputs.push(execFileSync(process.execPath, [join(build, 'dist/test/sdk-boundaries-worker.js'), copy.workspace, join(scratch, `${source.repo}-${name}-ledger`)], { cwd: scratch, env: runEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    }
    const beforeOutput = JSON.parse(outputs[0]) as { corpus: { items: unknown[] } };
    assert.deepEqual(JSON.parse(outputs[1]), beforeOutput);
    const afterEntries = await copiedFiles(copy.workspace);
    assert.deepEqual(afterEntries, entries);
    assert.deepEqual(await Promise.all(entries.map(path => readFile(path))), before);
    measurements.push({ repository: `unbraind/${source.repo}`, revision: source.revision, items: beforeOutput.corpus.items.length, files: entries.length, source_files_unchanged: true, source_files_read_only: true, non_git: true, git_executable_available: false, cases: Object.keys(beforeOutput).length, identical_outputs: true, output_sha256: createHash('sha256').update(outputs[0]).digest('hex') });
  }
  const result = { baseline: revision, candidate_production_sources_unchanged: true, intentional_differences: [], measurements };
  await writeFile(join(root, 'docs/sdk-adoption-validation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const path of lockedDirectories) await chmod(path, 0o755);
  await rm(scratch, { recursive: true, force: true });
}
}
