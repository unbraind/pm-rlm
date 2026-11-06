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
  const commands = await readFile(join(scratch, 'src/commands.ts'), 'utf8');
  const proofs = [
    { file: 'src/settings.ts', pattern: 'RLM section receipts', changed: fixed.replace("    return await readSettingsSection(workspace, 'rlm', { validate: resolveRlmSettings, defaultValue: resolveRlmSettings({}) });", "    const source = record(JSON.parse((await readFileIfExists(getSettingsPath(workspace))) ?? '{}'));\n  return { section: 'rlm', source: 'default', value: resolveRlmSettings(source.rlm ?? {}), revision: null };") },
    { file: 'src/settings.ts', pattern: 'RLM reads and writes preserve typed', changed: fixed.replace(/export async function readRlmSettings\([\s\S]*?\n}/, previous.match(/export async function readRlmSettings\([\s\S]*?\n}/)![0]) },
    { file: 'src/settings.ts', pattern: 'RLM automatic CAS|RLM section writes preserve|RLM command and library', changed: fixed.replace(/export async function writeRlmSettings\([\s\S]*?\n}/, previous.match(/export async function writeRlmSettings\([\s\S]*?\n}/)![0]) },
    { file: 'src/settings.ts', pattern: 'RLM settings write sanitizes', changed: fixed.replace("  try {\n    await writeSettingsSection(workspace, 'rlm', config, { expectedRevision: section.revision, validate: validateRlmSettings, author });\n  } catch (error) {\n    if (isPmCliExpectedError(error)) throw error;\n    throw new RlmError('incomplete', 'Workspace data could not be written completely');\n  }", "  await writeSettingsSection(workspace, 'rlm', config, { expectedRevision: section.revision, validate: validateRlmSettings, author });") },
    { file: 'src/commands.ts', pattern: 'RLM native CLI preserves', changed: commands.replace("    if (isPmCliExpectedError(error) && String(error.code).startsWith('settings_section_')) throw error;", '') },
    { file: 'src/settings.ts', pattern: 'RLM reads and writes preserve typed', changed: fixed.replace("    throw new RlmError('incomplete', 'Workspace data could not be read completely');", '    throw error;') },
  ];
  /** Run only the regression scenarios affected by one restored private mechanism. */
  const run = (pattern: string) => {
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=spec', '--test-name-pattern=' + pattern, 'test/settings-sections.test.ts'], { cwd: scratch, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    return result;
  };
  for (const proof of proofs) {
    const path = join(scratch, proof.file);
    const original = await readFile(path, 'utf8');
    assert.notEqual(proof.changed, original);
    const baseline = run(proof.pattern); assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    try {
      await writeFile(path, (proof.file === 'src/settings.ts' ? imports : '') + proof.changed);
      const broken = run(proof.pattern);
      assert.equal(broken.status, 1, broken.stdout + broken.stderr);
      assert.match(broken.stdout + broken.stderr, /AssertionError/);
      console.log(broken.stdout.split('\n').filter(line => line.startsWith('✖') && !line.includes('failing tests')).join('\n'));
    } finally { await writeFile(path, original); }
    const restored = run(proof.pattern); assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  }
  console.log('6/6 settings behavioral revert proofs (8 regression tests): fixed pass, private behavior fails, restored pass');
} finally { await rm(scratch, { recursive: true, force: true }); }
