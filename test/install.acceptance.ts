import { gitEnvironment, npmEnvironment } from '../scripts/environment.ts';
/** Packed npm/npx and Bun/bunx consumers exercise the real pm host. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/** Run a consumer process with private settings isolated from the current machine. */
function execute(cwd: string, args: string[], executable: string, env: NodeJS.ProcessEnv): string {
  const child = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 300000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  return child.stdout;
}
/** Install the actual packed distribution in independent package-manager consumers. */
for (const manager of ['npm', 'bun']) test(`packed ${manager} consumer installs, discovers and executes the rlm command`, t => {
  const repository = resolve(import.meta.dirname, '..');
  const scratch = mkdtempSync(join(tmpdir(), 'rlm-consumer-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: string; devDependencies: Record<string, string> };
  const env = { ...npmEnvironment(gitEnvironment(process.env)), HOME: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PM_AUTHOR: 'rlm-consumer' };
  const packed = JSON.parse(execute(repository, ['pack', '--json', '--pack-destination', scratch, '--ignore-scripts'], 'npm', env)) as { filename: string; files: { path: string }[] }[];
  const allowed = /^(dist\/|manifest\.json$|eval-results(?:-v2|-constrained)?\.json$|docs\/(?:EVAL-V2|EVAL-CONSTRAINED|EVAL-CLOUD|EVAL-DESIGN|ACTION-DIAGNOSIS)\.md$|package\.json$|README\.md$|ARCHITECTURE\.md$|LICENSE$|docs\/eval-design\.json$|CHANGELOG\.md$)/;
  assert.ok(packed[0].files.every(file => allowed.test(file.path)), 'Packed file allowlist');
  assert.ok(packed[0].files.some(file => file.path === 'dist/index.js'));
    const consumer = join(scratch, manager); mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'rlm-consumer-fixture', private: true, type: 'module', dependencies: { 'pm-rlm': `file:${join(scratch, packed[0].filename)}`, '@unbrained/pm-cli': manifest.devDependencies['@unbrained/pm-cli'] } }));
    execute(consumer, manager === 'npm' ? ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--ignore-scripts'], manager, env);
    const hostEnv = { ...env, PM_PATH: join(consumer, '.agents', 'pm') };
    const executable = manager === 'npm' ? 'npx' : 'bunx';
    const prefix = manager === 'npm' ? ['--no-install', 'pm'] : ['--bun', '--no-install', 'pm'];
    execute(consumer, [...prefix, 'init', '--prefix', 'rlm-consumer', '--defaults', '--agent-guidance', 'skip'], executable, hostEnv);
    execute(consumer, [...prefix, 'package', 'install', join(scratch, packed[0].filename)], executable, hostEnv);
    const help = execute(consumer, [...prefix, 'rlm', '--help'], executable, hostEnv);
    for (const command of ['run', 'tree', 'resume', 'replay']) assert.ok(help.includes(command));
    const description = execute(consumer, [...prefix, 'package', 'describe', 'pm-rlm', '--json'], executable, hostEnv);
    assert.ok(description.includes('pm-rlm'));
    writeFileSync(join(consumer, 'create-run.ts'), `import { runRlm } from 'pm-rlm';
import assert from 'node:assert/strict';
let step = 0;
const result = await runRlm('Packed tree fixture', { workspace: process.env.PM_PATH!, author: 'rlm-consumer', model: { name: 'packed-test-only', complete: async request => { if (step++ === 0) return { text: '{"action":"count","filter":{}}', tokens_in: 20, tokens_out: 10 }; assert.ok(request.prompt.includes('"data":0')); return { text: 'Answer: {"action":"finish","answer":"packed result"}', tokens_in: 20, tokens_out: 10 }; } } });
console.log(JSON.stringify(result));
`);
    const run = JSON.parse(execute(consumer, ['create-run.ts'], manager === 'npm' ? process.execPath : 'bun', hostEnv)) as { run: string; answer: string };
    assert.equal(run.answer, 'packed result');
    const tree = JSON.parse(execute(consumer, [...prefix, 'rlm', 'tree', run.run, '--json'], executable, hostEnv)) as { run: string; token_usage: string; calls: { id: string; parent: string; depth: number; status: string; result: string; used_tokens: number; reserved_tokens: number }[] };
    assert.equal(tree.token_usage, 'reported_or_estimated');
    assert.equal(tree.run, run.run); assert.equal(tree.calls.length, 1);
    assert.equal(tree.calls[0].id, run.run); assert.equal(tree.calls[0].depth, 0);
    assert.equal(tree.calls[0].status, 'closed'); assert.equal(tree.calls[0].result, 'packed result');
    assert.equal(tree.calls[0].reserved_tokens, 60); assert.equal(tree.calls[0].used_tokens, 60);
    assert.match(tree.calls[0].parent, /^rlm-consumer-/);

});
