import { httpFixture } from './http.ts';
import assert from 'node:assert/strict';
import { writeRlmSettings } from '../src/settings.ts';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { activateExtensionForTest, decodeToon } from '@unbrained/pm-cli/sdk/testing';
import extension from '../index.ts';
import { runCommand } from '../src/commands.ts';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { runRlm } from '../src/engine.ts';
import { ScriptedModel, tracker } from './helpers.ts';

/** Register the real package in a scratch tracker for host CLI acceptance. */
export async function installExtension(workspace: string): Promise<void> {
  const dir = join(workspace, 'extensions', 'pm-rlm');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'pm-rlm', version: '2026.10.18', entry: 'entry.js', capabilities: ['commands', 'schema'] }));
  await writeFile(join(dir, 'entry.js'), `export { default } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};\n`);
}
/** Invoke the actual host CLI rather than simulating its output renderer. */
function cli(root: string, workspace: string, args: string[]) {
  return spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'rlm', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PM_PATH: workspace, PM_AUTHOR: 'rlm-test' } });
}
/** Verify extension metadata and host-produced TOON/JSON command rendering. */
test('real host tree and replay commands emit native TOON and JSON', async t => {
  const { workspace, root } = await tracker(t);
  await installExtension(workspace);
  const run = await runRlm('Host output', { workspace, model: new ScriptedModel(() => '{"action":"finish","answer":"host"}'), author: 'rlm-test' });
  const json = cli(root, workspace, ['tree', run.run, '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).calls.length, 1);
  const toon = cli(root, workspace, ['tree', run.run]);
  assert.equal(toon.status, 0, toon.stderr);
  const decoded = decodeToon(toon.stdout) as { calls: { depth: number }[] };
  assert.equal(decoded.calls[0].depth, 0);
  const replay = cli(root, workspace, ['replay', run.run, '--json']);
  assert.equal(replay.status, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).answer, 'host');
  const activation = await activateExtensionForTest(extension, { capabilities: ['commands', 'schema'] });
  assert.equal(activation.failed.length, 0);
});

/** Command validation maps expected failures to documented process exit codes. */
test('command dispatcher rejects invalid inputs, unknown names and over-budget runs', async t => {
  const { workspace } = await tracker(t);
  const context = { command: 'rlm run', pm_root: workspace, args: ['question'], options: {}, global: { author: 'rlm-test' } } as CommandHandlerContext;
  await assert.rejects(runCommand('unknown', context));
  await assert.rejects(runCommand('tree', { ...context, args: [] }));
  await assert.rejects(runCommand('run', { ...context, options: { scope: '{' } }));
  await assert.rejects(runCommand('run', { ...context, options: { model: 'local', maxDepth: '0', maxCalls: '1', budgetTokens: '1', scope: '{}' } }), { exitCode: 3 });
  await assert.rejects(runCommand('resume', { ...context, args: ['absent'] }), { exitCode: 2 });
});

/** Successful native dispatch uses saved SDK settings and the actual Ollama wire format. */
test('run, resume and full tree dispatch share configured real HTTP execution', async t => {
  const { workspace } = await tracker(t);
  const { endpoint } = await httpFixture(t, (_request, response) => { response.end(JSON.stringify({ response: '{"action":"finish","answer":"configured"}', prompt_eval_count: 20, eval_count: 5 })); });
  await writeRlmSettings(workspace, { endpoint: endpoint }, 'rlm-test');
  const ctx = { command: 'rlm run', pm_root: workspace, args: ['configured question'], options: { maxDepth: '1', maxCalls: '2', budgetTokens: '30000', model: 'http-test' }, global: { author: 'rlm-test' } } as CommandHandlerContext;
  const run = await runCommand('run', ctx);
  assert.equal(run.answer, 'configured');
  assert.equal((await runCommand('resume', { ...ctx, args: [String(run.run)] })).answer, 'configured');
  assert.ok('state' in await runCommand('tree', { ...ctx, args: [String(run.run)], options: { full: true } }));
});
