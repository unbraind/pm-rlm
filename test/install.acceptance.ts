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
test('packed npm/npx and Bun/bunx install, discover and render the rlm command family', t => {
  const repository = resolve(import.meta.dirname, '..');
  const scratch = mkdtempSync(join(tmpdir(), 'rlm-consumer-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: string; devDependencies: Record<string, string> };
  const env = { ...process.env, HOME: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PM_AUTHOR: 'rlm-consumer', npm_config_userconfig: '/dev/null' };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete (env as NodeJS.ProcessEnv)[key];
  const packed = JSON.parse(execute(repository, ['pack', '--json', '--pack-destination', scratch, '--ignore-scripts'], 'npm', env)) as { filename: string; files: { path: string }[] }[];
  const allowed = /^(dist\/|manifest\.json$|eval-results\.json$|package\.json$|README\.md$|ARCHITECTURE\.md$|LICENSE$|CHANGELOG\.md$)/;
  assert.ok(packed[0].files.every(file => allowed.test(file.path)), 'Packed file allowlist');
  assert.ok(packed[0].files.some(file => file.path === 'dist/index.js'));
  for (const manager of ['npm', 'bun']) {
    const consumer = join(scratch, manager); mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'rlm-consumer-fixture', private: true, type: 'module', dependencies: { 'pm-rlm': `file:${join(scratch, packed[0].filename)}`, '@unbrained/pm-cli': manifest.devDependencies['@unbrained/pm-cli'] } }));
    execute(consumer, manager === 'npm' ? ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--ignore-scripts'], manager, env);
    const hostEnv = { ...env, PM_PATH: join(consumer, '.agents', 'pm') };
    const executable = manager === 'npm' ? 'npx' : 'bunx';
    const prefix = manager === 'npm' ? ['--no-install', 'pm'] : ['--bun', '--no-install', 'pm'];
    execute(consumer, [...prefix, 'init', '--prefix', 'rlm-consumer', '--defaults', '--agent-guidance', 'skip'], executable, hostEnv);
    execute(consumer, [...prefix, 'package', 'install', join(scratch, packed[0].filename)], executable, hostEnv);
    const help = execute(consumer, [...prefix, 'rlm', '--help'], executable, hostEnv);
    for (const command of ['run', 'tree', 'resume', 'replay']) assert.match(help, new RegExp(command));
    const description = execute(consumer, [...prefix, 'package', 'describe', 'pm-rlm', '--json'], executable, hostEnv);
    assert.ok(description.includes('pm-rlm'));
  }
});
