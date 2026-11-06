import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createExtensionCommandSdk, getSettingsPath, getWorkspaceHistoryPath, readSettingsSection, readHistoryEntries, WORKSPACE_HISTORY_ID, writeSettingsSection } from '@unbrained/pm-cli/sdk';
import { readRlmSettings, readRlmSettingsSection, writeRlmSettings } from '../src/settings.ts';
import { npmEnvironment, testEnvironment } from '../scripts/environment.ts';
import { installExtension, tracker } from './helpers.ts';
import { httpFixture } from './http.ts';

/** Run a competing package writer after the first writer read its revision, before persistence. */
function competingWrite(workspace: string): void {
  const child = spawnSync(process.execPath, [join(import.meta.dirname, 'settings-writer.ts'), workspace, 'peer-model'], {
    encoding: 'utf8', timeout: 30000, env: npmEnvironment(testEnvironment(process.env)),
  });
  assert.equal(child.status, 0, child.stderr);
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
  for (const raw of ['{', 'null', '[]', ...[null, [], { unexpected: true }, { endpoint: 'https://name:pass@example.invalid' }].map(rlm => JSON.stringify({ ...JSON.parse(original), rlm }))]) {
    await writeFile(path, raw);
    const code = ['{', 'null', '[]'].includes(raw) ? 'settings_section_document_malformed' : 'settings_section_invalid';
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
    const result = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'rlm', 'run', 'configured question', '--json', ...flags], {
      cwd: root, env: { ...npmEnvironment(testEnvironment(process.env)), PM_PATH: workspace, PM_AUTHOR: 'settings-author' }, timeout: 30000,
    });
    assert.equal((JSON.parse(result.stdout) as { answer: string }).answer, 'section-config');
  }
  assert.deepEqual(models, [(await readRlmSettings(workspace)).model, (await readRlmSettings(workspace, { model: 'explicit' })).model]);
  const history = await readHistoryEntries(getWorkspaceHistoryPath(workspace), WORKSPACE_HISTORY_ID);
  assert.ok(history.some(entry => entry.op === 'settings:section:write' && entry.author === 'settings-author'));
});
