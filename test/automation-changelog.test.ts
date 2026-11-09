import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';

/** Minimal caller-workflow projection for the gated sync job's reusable inputs. */
interface SyncWorkflow {
  jobs?: { 'gated-sync'?: { with?: { 'post-import-script'?: unknown } } };
}

/** Read the configured post-import script from workflow YAML, with the package default when it is absent. */
function postImportScript(workflow: string): string {
  const configured = (parse(workflow) as SyncWorkflow).jobs?.['gated-sync']?.with?.['post-import-script'];
  return typeof configured === 'string' ? configured : 'changelog:full';
}

test('the configured post-import script is read from every quoting style', () => {
  for (const configured of ['"changelog:automation"', "'changelog:automation'", 'changelog:automation']) {
    const workflow = `# Gated GitHub issues sync caller.\njobs:\n  gated-sync:\n    with:\n      post-import-script: ${configured}\n      pm-github-version: "2026.10.16"\n`;
    assert.equal(postImportScript(workflow), 'changelog:automation', configured);
  }
  assert.equal(postImportScript('jobs:\n  gated-sync:\n    with:\n      pm-github-version: "2026.10.16"\n'), 'changelog:full');
});

test('the changelog work item references the sync PR without claiming issue ownership', () => {
  const item = decodeToon(readFileSync(new URL('../.agents/pm/issues/pm-rlm-sync-changelog.toon', import.meta.url), 'utf8')) as {
    tags: string[];
    comments: { text: string }[];
  };
  assert.ok(!item.tags.includes('gh:unbraind/pm-rlm#57'), 'PR #57 must not be selected as an owned issue by GitHub refresh');
  assert.ok(item.comments.some(comment => comment.text.includes('PR #57')), 'retain the PR context in the audit trail');
});

test('the configured sync regeneration passes the package changelog check in a real temporary tracker', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest: { name: string; version: string; scripts: Record<string, string> } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const script = postImportScript(readFileSync(join(root, '.github/workflows/pm-github-sync.yml'), 'utf8'));
  const directory = mkdtempSync(join(tmpdir(), 'automation-changelog-'));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|PM_(?:PATH|GLOBAL_PATH)$|npm_config_(?:userconfig|allow_scripts)$|NODE_TEST_CONTEXT$)/i.test(key)));
  const environment: NodeJS.ProcessEnv = { ...inherited, HOME: join(directory, 'home'), PM_PATH: join(directory, '.agents/pm'), GIT_CEILING_DIRECTORIES: dirname(directory), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', NPM_CONFIG_USERCONFIG: devNull };
  for (const key of Object.keys(environment)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|NPM_MEDIA_SERVER/i.test(key)) delete environment[key];
  /** Run the real package tools and surface only their failed output. */
  function run(command: string, args: string[]): void {
    const result = spawnSync(command, args, { cwd: directory, env: environment, encoding: 'utf8', shell: process.platform === 'win32' && command === 'npm.cmd' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  try {
    mkdirSync(join(directory, 'home'));
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'junction');
    symlinkSync(join(root, 'scripts'), join(directory, 'scripts'), 'junction');
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: 'module', scripts: manifest.scripts }));
    // The npm shim directory holds platform launchers, not JavaScript; the package entrypoint runs under Node everywhere.
    run(process.execPath, [join(root, 'node_modules/@unbrained/pm-cli/dist/cli.js'), 'init', 'fixture', '--defaults', '--agent-guidance', 'skip', '--no-extensions']);
    run(process.execPath, [join(root, 'node_modules/@unbrained/pm-cli/dist/cli.js'), 'create', 'Synthetic delivered change', '--id', 'fixture-work', '--type', 'Task', '--status', 'closed', '--close-reason', 'Synthetic release evidence', '--release', manifest.version, '--create-mode', 'progressive', '--no-extensions']);
    run('git', ['init', '--quiet']);
    run('git', ['add', 'package.json', '.agents/pm/settings.json']);
    run('git', ['-c', 'user.name=SteveBot', '-c', 'user.email=1153461+unbraind@users.noreply.github.com', 'commit', '--quiet', '-m', 'Initialize synthetic changelog fixture']);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    // The pinned reusable workflow adds this flag only for its default script.
    run(npm, ['run', script, ...(script === 'changelog:full' ? ['--', '--no-pending-release'] : [])]);
    run(npm, ['run', 'changelog:check']);
    const changelog = readFileSync(join(directory, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /^# Changelog/m);
    assert.match(changelog, /Synthetic delivered change/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
