import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createExtensionCommandSdk, getSettingsPath, getWorkspaceHistoryPath, readSettingsSection, readHistoryEntries, WORKSPACE_HISTORY_ID, writeSettingsSection } from '@unbrained/pm-cli/sdk';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { runCommand } from '../src/commands.ts';
import { readRlmSettings, readRlmSettingsSection, writeRlmSettings } from '../src/settings.ts';
import { npmEnvironment, testEnvironment } from '../scripts/environment.ts';
import { installExtension, tracker } from './helpers.ts';
import { httpFixture, requestBody } from './http.ts';

/** Run a competing package writer after the first writer read its revision, before persistence. */
function competingWrite(workspace: string): void {
  const child = spawnSync(process.execPath, [join(import.meta.dirname, 'settings-writer.ts'), workspace, 'peer-model'], {
    encoding: 'utf8', timeout: 30000, env: npmEnvironment(testEnvironment(process.env)),
  });
  assert.equal(child.status, 0, child.stderr);
}

/** Invoke the actual host asynchronously so its local model endpoint can respond. */
async function nativeRun(root: string, workspace: string, flags: string[]): Promise<Record<string, unknown>> {
  const result = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'rlm', 'run', 'configured question', '--json', ...flags], {
    cwd: root, env: { ...npmEnvironment(testEnvironment(process.env)), PM_PATH: workspace, PM_AUTHOR: 'settings-author' }, timeout: 30000,
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** Receipts retain the host source/revision while package defaults validate partial stored sections. */
test('RLM section receipts distinguish absent defaults from normalized stored settings', async t => {
  const { workspace } = await tracker(t);
  const absent = await readRlmSettingsSection(workspace);
  assert.equal(absent.source, 'default'); assert.equal(absent.revision, null);
  assert.equal(absent.value?.max_depth, 3);
  await writeSettingsSection(workspace, 'rlm', { model: 'saved-model' }, { author: 'settings-test' });
  const stored = await readRlmSettingsSection(workspace);
  assert.equal(stored.source, 'stored');
  assert.equal(stored.revision, (await readSettingsSection(workspace, 'rlm')).revision);
  assert.equal(stored.value?.model, 'saved-model'); assert.equal(stored.value?.max_depth, 3);
  assert.equal((await readRlmSettings(workspace, { model: 'explicit' })).model, 'explicit');
});

/** Malformed documents and invalid package sections keep the SDK's typed refusal codes. */
test('RLM reads and writes preserve typed SDK refusals without changing invalid documents', async t => {
  const { workspace } = await tracker(t);
  const path = getSettingsPath(workspace); const original = await readFile(path, 'utf8');
  const document = JSON.parse(original) as Record<string, unknown>;
  const cases = [
    ...['{', 'null', '[]'].map(raw => ({ raw, code: 'settings_section_document_malformed' })),
    ...[null, []].map(rlm => ({ raw: JSON.stringify({ ...document, rlm }), code: 'settings_section_invalid' })),
    ...[{ unexpected: true }, { endpoint: 'https://name:pass@example.invalid' }].map(rlm => ({ raw: JSON.stringify({ ...document, rlm }), code: 'invalid' })),
  ];
  for (const { raw, code } of cases) {
    await writeFile(path, raw);
    await assert.rejects(readRlmSettings(workspace), { code });
    await assert.rejects(writeRlmSettings(workspace, { model: 'override' }, 'settings-test'), { code });
    assert.equal(await readFile(path, 'utf8'), raw);
  }
  await rm(path); await mkdir(path);
  for (const operation of [() => readRlmSettings(workspace), () => writeRlmSettings(workspace, {}, 'settings-test')]) {
    await assert.rejects(operation(), error => {
      assert.ok(error instanceof Error && 'code' in error);
      assert.equal(error.code, 'incomplete'); assert.ok(!error.message.includes(workspace)); return true;
    });
  }

});

for (const stored of [false, true]) {
  /** Null and stored revisions both refuse a winner from another process without appending history. */
  test(`RLM automatic CAS refuses an OS-process competitor (${stored ? 'stored' : 'absent'} section)`, async t => {
    const { workspace } = await tracker(t);
    if (stored) await writeRlmSettings(workspace, { model: 'initial' }, 'settings-test');
    let winnerBytes = ''; let winnerHistory = '';
    await assert.rejects(writeRlmSettings(workspace, {
      get model() {
        competingWrite(workspace);
        winnerBytes = readFileSync(getSettingsPath(workspace), 'utf8');
        winnerHistory = readFileSync(getWorkspaceHistoryPath(workspace), 'utf8');
        return 'stale-model';
      },
    }, 'stale-writer'), { code: 'settings_section_revision_conflict' });
    assert.equal(await readFile(getSettingsPath(workspace), 'utf8'), winnerBytes);
    assert.equal(await readFile(getWorkspaceHistoryPath(workspace), 'utf8'), winnerHistory);
    assert.equal((await readRlmSettings(workspace)).model, 'peer-model');
  });
}

/** The section writer leaves customized core schema and independent extension policies intact. */
test('RLM section writes preserve customized core and sibling settings with attributable history', async t => {
  const { workspace, client } = await tracker(t);
  const sdk = createExtensionCommandSdk(workspace, client, 'settings-test');
  await sdk.mutateWorkspaceSettings({ operationId: 'custom-core', mutate: current => ({ ...current, schema: { ...current.schema, statuses: [...current.schema.statuses, { id: 'queued-custom', aliases: ['waiting-custom'] }] } }) });
  await writeSettingsSection(workspace, 'sibling', { enabled: false, nested: { limit: 7 } }, { author: 'settings-test' });
  const before = JSON.parse(await readFile(getSettingsPath(workspace), 'utf8')) as Record<string, unknown>;
  await writeRlmSettings(workspace, { model: 'new-model' }, 'settings-author');
  const after = JSON.parse(await readFile(getSettingsPath(workspace), 'utf8')) as Record<string, unknown>;
  delete after.rlm; assert.deepEqual(after, before);
  const history = await readHistoryEntries(getWorkspaceHistoryPath(workspace), WORKSPACE_HISTORY_ID);
  assert.equal(history.at(-1)?.op, 'settings:section:write');
  assert.equal(history.at(-1)?.author, 'settings-author');
});

/** Command execution uses the same saved configuration and explicit precedence as library reads. */
test('RLM command and library share SDK section defaults, policy and model precedence', async t => {
  const { root, workspace } = await tracker(t);
  await installExtension(workspace);
  const models: string[] = [];
  const { endpoint } = await httpFixture(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      models.push((JSON.parse(Buffer.concat(chunks).toString()) as { model: string }).model);
      response.end(JSON.stringify({ response: '{"action":"finish","answer":"section-config"}' }));
    });
  });
  await writeRlmSettings(workspace, { endpoint, model: 'saved-model' }, 'settings-author');
  for (const flags of [[], ['--model', 'explicit']]) {
    assert.equal((await nativeRun(root, workspace, flags)).answer, 'section-config');
  }
  assert.deepEqual(models, [(await readRlmSettings(workspace)).model, (await readRlmSettings(workspace, { model: 'explicit' })).model]);
  const history = await readHistoryEntries(getWorkspaceHistoryPath(workspace), WORKSPACE_HISTORY_ID);
  assert.ok(history.some(entry => entry.op === 'settings:section:write' && entry.author === 'settings-author'));
});

/** Force a real SDK I/O failure without permission assumptions, restoring the original file in finally. */
test('RLM settings write sanitizes unexpected I/O failures', async t => {
  const { root, workspace } = await tracker(t);
  const path = getSettingsPath(workspace);
  const saved = join(root, 'settings-before-write.json');
  const mode = (await stat(path)).mode & 0o7777;
  const before = await readFile(path, 'utf8');
  let displaced = false;
  try {
    await assert.rejects(writeRlmSettings(workspace, {
      get model() {
        renameSync(path, saved); displaced = true;
        mkdirSync(path);
        return 'io-fault';
      },
    }, 'settings-test'), error => {
      assert.ok(error instanceof Error && 'code' in error);
      assert.equal(error.code, 'incomplete');
      assert.equal(error.message, 'Workspace data could not be written completely');
      assert.ok(!error.message.includes(workspace)); return true;
    });
  } finally {
    if (displaced) { await rm(path, { recursive: true, force: true }); await rename(saved, path); }
  }
  assert.equal((await stat(path)).mode & 0o7777, mode);
  assert.equal(await readFile(path, 'utf8'), before);
});

/** Native command handling retains the same section refusals as direct library configuration. */
test('RLM native CLI preserves SDK section refusals', async t => {
  const { workspace } = await tracker(t);
  const context = { command: 'rlm run', pm_root: workspace, args: ['q'], options: {}, global: { author: 'settings-test' } } as CommandHandlerContext;
  await writeSettingsSection(workspace, 'rlm', null, { author: 'settings-test' });
  for (const code of ['settings_section_invalid', 'settings_section_document_malformed']) {
    await assert.rejects(readRlmSettings(workspace), { code });
    await assert.rejects(runCommand('run', context), { code, exitCode: 2 });
    await writeFile(getSettingsPath(workspace), '{');
  }
});

/** Legacy saved defaults remain overridable before domain validation, including cross-field limits. */
test('RLM explicit overrides repair stored defaults through library and native CLI', async t => {
  const { root, workspace, client } = await tracker(t);
  await installExtension(workspace);
  const models: string[] = [];
  const { endpoint } = await httpFixture(t, async (request, response) => {
    models.push(String((await requestBody(request)).model));
    response.end(JSON.stringify({ response: '{"action":"finish","answer":"compatible"}' }));
  });
  // The previous workspace-settings API could persist this opaque extension section.
  await createExtensionCommandSdk(workspace, client, 'legacy-settings').mutateWorkspaceSettings({
    operationId: 'legacy-override-fixture', mutate: current => ({ ...current, rlm: { model: '', endpoint, context_tokens: 65536 } }),
  });
  const overrides = { model: 'library-override', output_tokens: 40000 };
  await assert.doesNotReject(() => readRlmSettings(workspace, overrides));
  const resolved = await readRlmSettings(workspace, overrides);
  assert.equal(resolved.model, 'library-override'); assert.equal(resolved.output_tokens, 40000); assert.equal(resolved.context_tokens, 65536);
  const receipt = await readRlmSettingsSection(workspace, overrides);
  assert.equal(receipt.source, 'stored'); assert.equal(receipt.revision, (await readSettingsSection(workspace, 'rlm')).revision);
  await assert.rejects(readRlmSettings(workspace), { code: 'invalid' });
  await assert.doesNotReject(async () => { assert.equal((await nativeRun(root, workspace, ['--model', 'cli-override'])).answer, 'compatible'); });
  assert.deepEqual(models, ['cli-override']);
  assert.equal(((await readSettingsSection<Record<string, unknown>>(workspace, 'rlm')).value)?.model, '');
  await assert.doesNotReject(() => writeRlmSettings(workspace, { ...overrides, model: 'repaired' }, 'settings-compat'));
  assert.equal((await readRlmSettings(workspace)).model, 'repaired');
  const history = await readHistoryEntries(getWorkspaceHistoryPath(workspace), WORKSPACE_HISTORY_ID);
  assert.equal(history.at(-1)?.op, 'settings:section:write'); assert.equal(history.at(-1)?.author, 'settings-compat');
});
