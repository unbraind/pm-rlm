import { createPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { defineCommand } from '@unbrained/pm-cli/sdk/authoring';
import type { CommandHandlerContext, ExtensionApi } from '@unbrained/pm-cli/sdk/authoring';
import { parseFilter } from './environment.ts';
import { resumeRlm, replayRlm, runRlm, treeRlm } from './engine.ts';
import { RlmError, text } from './errors.ts';
import { RLM_FIELDS } from './ledger.ts';
import type { RlmSettings } from './types.ts';

/** Dispatch commands through the same SDK engine used by embedded clients. */
export async function runCommand(command: string, ctx: CommandHandlerContext): Promise<Record<string, unknown>> {
  try {
    const argument = text(ctx.args[0]);
    if (command === 'tree') return await treeRlm(ctx.pm_root, argument, ctx.options.full === true);
    if (command === 'resume') return { ...await resumeRlm(ctx.pm_root, argument, undefined, ctx.global.author) };
    if (command === 'replay') return { ...await replayRlm(ctx.pm_root, argument) };
    if (command !== 'run') throw new RlmError('invalid', 'Unknown rlm command');
    const settings: Partial<RlmSettings> = {};
    for (const [option, setting] of [['maxDepth', 'max_depth'], ['maxCalls', 'max_calls'], ['budgetTokens', 'budget_tokens']] as const) {
      if (ctx.options[option] !== undefined) settings[setting] = Number(text(ctx.options[option]));
    }
    if (ctx.options.model !== undefined) settings.model = text(ctx.options.model);
    let scope = {};
    if (ctx.options.scope !== undefined) {
      let decoded: unknown;
      try { decoded = JSON.parse(text(ctx.options.scope)); }
      catch (error) { if (error instanceof SyntaxError) throw new RlmError('invalid', 'Invalid --scope JSON'); throw error; }
      scope = parseFilter(decoded);
    }
    return { ...await runRlm(argument, { workspace: ctx.pm_root, scope, settings, author: ctx.global.author }) };
  } catch (error) {
    const code = error instanceof RlmError ? error.code : 'invalid';
    throw createPmCliExpectedError(`rlm ${code}: ${error instanceof RlmError ? error.message : 'Command failed; check inputs and tracker integrity'}`, { exitCode: code === 'budget' || code === 'depth' || code === 'calls' ? 3 : 2 });
  }
}
/** Register ledger fields and native commands, preserving host TOON and JSON rendering. */
export function register(api: ExtensionApi): void {
  api.registerItemFields(RLM_FIELDS);
  for (const name of ['run', 'tree', 'resume', 'replay']) {
    const options = name === 'run' ? ['scope', 'model', 'max-depth', 'max-calls', 'budget-tokens'] : [];
    api.registerCommand(defineCommand({
      name: `rlm ${name}`, description: `${name} a durable recursive language model run`,
      intent: 'Project management = context management for recursive agents',
      arguments: [{ name: name === 'run' ? 'question' : 'run', required: true }],
      flags: [...options.map(option => ({ long: `--${option}`, description: option, value_name: 'value', value_type: 'string' as const })), ...(name === 'tree' ? [{ long: '--full', description: 'Include the complete checkpoint', value_type: 'boolean' as const }] : [])],
      examples: [`pm rlm ${name} ${name === 'run' ? '"Count open Issues"' : 'run-id'} --json`],
      run: ctx => runCommand(name, ctx),
    }));
  }
}
