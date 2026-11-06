import { isPmCliExpectedError, readSettingsSection, writeSettingsSection } from '@unbrained/pm-cli/sdk';
import type { SettingsSectionReadResult } from '@unbrained/pm-cli/sdk';
import { assertLedgerPrivacy, integer, record, RlmError, text } from './errors.ts';
import type { RlmSettings } from './types.ts';

/** Apply package defaults and validate the RLM policy the host does not define. */
function resolveRlmSettings(section: unknown): RlmSettings {
  return validateRlmSettings({
    model: 'gemma4:e4b', adapter: 'ollama', endpoint: 'http://localhost:11434', key_env: 'OPENAI_API_KEY',
    max_depth: 3, max_calls: 32, budget_tokens: 300000, output_tokens: 512, context_tokens: 32768, timeout_ms: 120000,
    ...record(section),
  });
}

/** Read validated defaults or stored settings with the host's source and revision receipt. */
export async function readRlmSettingsSection(workspace: string): Promise<SettingsSectionReadResult<RlmSettings>> {
  try {
    return await readSettingsSection(workspace, 'rlm', { validate: resolveRlmSettings, defaultValue: resolveRlmSettings({}) });
  } catch (error) {
    if (isPmCliExpectedError(error)) throw error;
    throw new RlmError('incomplete', 'Workspace data could not be read completely');
  }
}

/** Resolve extension settings with explicit flags taking precedence over persisted defaults. */
export async function readRlmSettings(workspace: string, overrides: Partial<RlmSettings> = {}): Promise<RlmSettings> {
  const section = await readRlmSettingsSection(workspace);
  return validateRlmSettings({ ...section.value, ...overrides });
}

/** Validate complete settings, including checkpoints, before selecting any credential transport. */
export function validateRlmSettings(value: unknown): RlmSettings {
  const config = record(value);
  for (const key of Object.keys(config)) if (!['model', 'adapter', 'endpoint', 'key_env', 'max_depth', 'max_calls', 'budget_tokens', 'output_tokens', 'context_tokens', 'timeout_ms'].includes(key)) throw new RlmError('invalid', 'Unknown rlm setting');
  for (const key of ['model', 'endpoint', 'key_env'] as const) text(config[key]);
  if (config.adapter !== 'ollama' && config.adapter !== 'openai') throw new RlmError('invalid', 'Unknown model adapter');
  let url: URL;
  try { url = new URL(text(config.endpoint)); } catch { throw new RlmError('invalid', 'Endpoint must be a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new RlmError('invalid', 'Endpoint must be an HTTP URL without credentials, query or fragment');
  if (config.adapter === 'openai' && url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new RlmError('invalid', 'Remote OpenAI endpoints require HTTPS');
  if (!/^[A-Z_][A-Z0-9_]*$/.test(text(config.key_env))) throw new RlmError('invalid', 'Invalid credential environment variable name');
  integer(config.max_depth, 0, 32);
  for (const key of ['max_calls', 'budget_tokens', 'output_tokens', 'context_tokens', 'timeout_ms'] as const) integer(config[key], 1, 1000000000);
  if (Number(config.output_tokens) >= Number(config.context_tokens)) throw new RlmError('invalid', 'Output allocation must be smaller than context');
  return config as unknown as RlmSettings;
}

/** Persist validated settings using the read revision; competing writes refuse without retry. */
export async function writeRlmSettings(workspace: string, overrides: Partial<RlmSettings>, author: string): Promise<RlmSettings> {
  const section = await readRlmSettingsSection(workspace);
  const config = validateRlmSettings({ ...section.value, ...overrides });
  assertLedgerPrivacy(config, workspace, config.key_env);
  await writeSettingsSection(workspace, 'rlm', config, { expectedRevision: section.revision, validate: validateRlmSettings, author });
  return config;
}
