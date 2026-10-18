import { randomUUID } from 'node:crypto';
import { createExtensionCommandSdk, PmClient, getSettingsPath, readFileIfExists } from '@unbrained/pm-cli/sdk';
import { assertLedgerPrivacy, integer, record, RlmError, text } from './errors.ts';
import type { RlmSettings } from './types.ts';

/** Resolve extension settings with explicit flags taking precedence over persisted defaults. */
export async function readRlmSettings(workspace: string, overrides: Partial<RlmSettings> = {}): Promise<RlmSettings> {
  const source = record(JSON.parse((await readFileIfExists(getSettingsPath(workspace))) ?? '{}'));
  const section = source.rlm === undefined ? {} : record(source.rlm);
  const config: RlmSettings = {
    model: 'gemma4:e4b', adapter: 'ollama', endpoint: 'http://localhost:11434', key_env: 'OPENAI_API_KEY',
    max_depth: 3, max_calls: 32, budget_tokens: 200000, output_tokens: 512, context_tokens: 8192, timeout_ms: 120000,
    ...section, ...overrides,
  };
  for (const key of Object.keys(section)) if (!['model', 'adapter', 'endpoint', 'key_env', 'max_depth', 'max_calls', 'budget_tokens', 'output_tokens', 'context_tokens', 'timeout_ms'].includes(key)) throw new RlmError('invalid', 'Unknown rlm setting');
  for (const key of ['model', 'endpoint', 'key_env'] as const) text(config[key]);
  if (!['ollama', 'openai'].includes(config.adapter)) throw new RlmError('invalid', 'Unknown model adapter');
  const url = new URL(config.endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new RlmError('invalid', 'Endpoint must be an HTTP URL without credentials, query or fragment');
  if (!/^[A-Z_][A-Z0-9_]*$/.test(config.key_env)) throw new RlmError('invalid', 'Invalid credential environment variable name');
  integer(config.max_depth, 0, 32);
  for (const key of ['max_calls', 'budget_tokens', 'output_tokens', 'context_tokens', 'timeout_ms'] as const) integer(config[key], 1, 1000000000);
  if (config.output_tokens >= config.context_tokens) throw new RlmError('invalid', 'Output allocation must be smaller than context');
  return config;
}

/** Validate and persist settings through the SDK's audited workspace-settings transaction. */
export async function writeRlmSettings(workspace: string, overrides: Partial<RlmSettings>, author: string): Promise<RlmSettings> {
  const config = await readRlmSettings(workspace, overrides);
  assertLedgerPrivacy(config, workspace, config.key_env);
  const sdk = createExtensionCommandSdk(workspace, new PmClient({ pmRoot: workspace, author, noExtensions: true }), author, 'rlm settings');
  await sdk.mutateWorkspaceSettings({ operationId: randomUUID(), mutate: current => ({ ...current, rlm: config }) });
  return config;
}
