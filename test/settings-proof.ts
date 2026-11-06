/** Prove settings regressions fail with private reader/writer behavior in disposable source copies. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gitEnvironment, npmEnvironment, testEnvironment } from '../scripts/environment.ts';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'rlm-settings-proof-'));
try {
  const entries = ['package.json', 'manifest.json', 'index.ts', 'scripts', 'test', 'src'];
  for (const entry of entries) {
    const destination = join(scratch, entry);
    await cp(join(root, entry), destination, { recursive: true });
  }
  await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'junction');
  const env = npmEnvironment(gitEnvironment(testEnvironment(process.env)));
  delete env.NODE_V8_COVERAGE;
  const path = join(scratch, 'src/settings.ts');
  const fixed = await readFile(path, 'utf8');
  // Preserve the replaced function bodies so the proof also works in shallow checkouts.
  const previous = `export async function readRlmSettings(workspace: string, overrides: Partial<RlmSettings> = {}): Promise<RlmSettings> {
  const source = await sdkRead(async () => record(JSON.parse((await readFileIfExists(getSettingsPath(workspace))) ?? '{}')));
  const section = source.rlm === undefined ? {} : record(source.rlm);
  const config: RlmSettings = {
    model: 'gemma4:e4b', adapter: 'ollama', endpoint: 'http://localhost:11434', key_env: 'OPENAI_API_KEY',
    max_depth: 3, max_calls: 32, budget_tokens: 300000, output_tokens: 512, context_tokens: 32768, timeout_ms: 120000,
    ...section, ...overrides,
  };
  return validateRlmSettings(config);
}
export async function writeRlmSettings(workspace: string, overrides: Partial<RlmSettings>, author: string): Promise<RlmSettings> {
  const config = await readRlmSettings(workspace, overrides);
  assertLedgerPrivacy(config, workspace, config.key_env);
  const sdk = createExtensionCommandSdk(workspace, new PmClient({ pmRoot: workspace, author, noExtensions: true }), author, 'rlm settings');
  await sdk.mutateWorkspaceSettings({ operationId: randomUUID(), mutate: current => ({ ...current, rlm: config }) });
  return config;
}`;
  const imports = "import { randomUUID } from 'node:crypto';\nimport { createExtensionCommandSdk, PmClient, getSettingsPath, readFileIfExists } from '@unbrained/pm-cli/sdk';\nimport { sdkRead } from './errors.ts';\n";
  const proofs = [
    { pattern: 'RLM section receipts', changed: fixed.replace("    return await readSettingsSection(workspace, 'rlm', { validate: resolveRlmSettings, defaultValue: resolveRlmSettings({}) });", "    const source = record(JSON.parse((await readFileIfExists(getSettingsPath(workspace))) ?? '{}'));\n  return { section: 'rlm', source: 'default', value: resolveRlmSettings(source.rlm ?? {}), revision: null };") },
    { pattern: 'RLM reads and writes preserve typed', changed: fixed.replace(/export async function readRlmSettings\([\s\S]*?\n}/, previous.match(/export async function readRlmSettings\([\s\S]*?\n}/)![0]) },
    { pattern: 'RLM automatic CAS|RLM section writes preserve|RLM command and library', changed: fixed.replace(/export async function writeRlmSettings\([\s\S]*?\n}/, previous.match(/export async function writeRlmSettings\([\s\S]*?\n}/)![0]) },
  ];
  /** Run only the regression scenarios affected by one restored private mechanism. */
  const run = (pattern: string) => {
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=spec', '--test-name-pattern=' + pattern, 'test/settings-sections.test.ts'], { cwd: scratch, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    return result;
  };
  for (const proof of proofs) {
    assert.notEqual(proof.changed, fixed);
    const baseline = run(proof.pattern); assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    try {
      await writeFile(path, imports + proof.changed);
      const broken = run(proof.pattern);
      assert.equal(broken.status, 1, broken.stdout + broken.stderr);
      assert.match(broken.stdout + broken.stderr, /AssertionError/);
      console.log(broken.stdout.split('\n').filter(line => line.startsWith('✖') && !line.includes('failing tests')).join('\n'));
    } finally { await writeFile(path, fixed); }
    const restored = run(proof.pattern); assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  }
  console.log('3/3 settings behavioral revert proofs (6 regression tests): fixed pass, private behavior fails, restored pass');
} finally { await rm(scratch, { recursive: true, force: true }); }
