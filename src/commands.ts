import { adaptiveRlm, parseQuestionStructure, RlmAdaptiveError } from './adaptive.ts';
import { parseComponents, RlmEvidenceError } from './evidence.ts';
import { createPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { defineCommand } from '@unbrained/pm-cli/sdk/authoring';
import type { CommandHandlerContext, ExtensionApi } from '@unbrained/pm-cli/sdk/authoring';
import { parseFilter } from './environment.ts';
import { evidenceRlm, resumeRlm, replayRlm, runRlm, treeRlm } from './engine.ts';
import { integer, RlmError, text } from './errors.ts';
import { RLM_FIELDS } from './ledger.ts';
import type { RlmSettings } from './types.ts';

/** Validate a CLI string without changing the supplied question, model or JSON. */
function operand(value: unknown): string {
  const result = text(value);
  if (result.trim().length === 0) throw new RlmError('invalid', 'Expected nonblank operand');
  return result;
}
/** Accept decimal integers only, before the settings validator applies tighter limits. */
function numericOperand(value: unknown): number {
  const result = operand(value);
  if (!/^\d+$/.test(result)) throw new RlmError('invalid', 'Expected an unsigned decimal integer');
  return integer(Number(result), 0);
}

/** Decode component declarations with a typed remedy for invalid CLI JSON. */
function componentOperand(value: unknown): string[] {
  let decoded: unknown;
  try { decoded = JSON.parse(operand(value)); }
  catch { throw new RlmEvidenceError('Invalid --components JSON', 'Supply a JSON array of unique nonblank component names'); }
  return parseComponents(decoded);
}

/** Dispatch commands through the same SDK engine used by embedded clients. */
export async function runCommand(command: string, ctx: CommandHandlerContext): Promise<Record<string, unknown>> {
  try {
    const argument = operand(ctx.args[0]);
    if (command === 'evidence') return { ...await evidenceRlm(ctx.pm_root, argument) };
    if (command === 'tree') return await treeRlm(ctx.pm_root, argument, ctx.options.full === true);
    if (command === 'resume') return { ...await resumeRlm(ctx.pm_root, argument, undefined, ctx.global.author) };
    if (command === 'replay') return { ...await replayRlm(ctx.pm_root, argument) };
    if (command !== 'run' && command !== 'adaptive') throw new RlmError('invalid', 'Unknown rlm command');
    const settings: Partial<RlmSettings> = {};
    for (const [option, setting] of [['maxDepth', 'max_depth'], ['maxCalls', 'max_calls'], ['budgetTokens', 'budget_tokens']] as const) {
      if (ctx.options[option] !== undefined && !(command === 'adaptive' && setting === 'budget_tokens')) settings[setting] = numericOperand(ctx.options[option]);
    }
    if (ctx.options.model !== undefined) settings.model = operand(ctx.options.model);
    let scope = {};
    if (ctx.options.scope !== undefined) {
      let decoded: unknown;
      try { decoded = JSON.parse(operand(ctx.options.scope)); }
      catch (error) { if (error instanceof SyntaxError) throw new RlmError('invalid', 'Invalid --scope JSON'); throw error; }
      scope = parseFilter(decoded);
    }
    if (command === 'adaptive') {
      let structure: unknown;
      try { structure = JSON.parse(operand(ctx.options.structure)); }
      catch { throw new RlmAdaptiveError('invalid', 'Invalid --structure JSON', 'Supply --structure as an array of {name,question} parts'); }
      if (ctx.options.budgetTokens === undefined) throw new RlmAdaptiveError('invalid', 'Missing declared budget', 'Supply --budget-tokens as an unsigned decimal integer, including zero');
      return { ...await adaptiveRlm(argument, { workspace: ctx.pm_root, structure: parseQuestionStructure(structure), remaining_tokens: numericOperand(ctx.options.budgetTokens), scope, settings, author: ctx.global.author }) };
    }
    return { ...await runRlm(argument, { workspace: ctx.pm_root, scope, settings, ...(ctx.options.components === undefined ? {} : { components: componentOperand(ctx.options.components) }), author: ctx.global.author }) };
  } catch (error) {
    const code = error instanceof RlmError ? error.code : 'invalid';
    const remedy = error instanceof RlmEvidenceError || error instanceof RlmAdaptiveError ? error.remedy : command === 'adaptive' ? 'Supply a valid --structure, unsigned --budget-tokens, scope and model settings; inspect tracker integrity' : undefined;
    throw createPmCliExpectedError(`rlm ${code}: ${error instanceof RlmError ? error.message + (remedy === undefined ? '' : '; remedy: ' + remedy) : 'Command failed; check inputs and tracker integrity'}`, { exitCode: code === 'budget' || code === 'depth' || code === 'calls' ? 3 : 2 });
  }
}
/** Register ledger fields and native commands, preserving host TOON and JSON rendering. */
export function register(api: ExtensionApi): void {
  api.registerItemFields(RLM_FIELDS);
  for (const name of ['run', 'adaptive', 'tree', 'resume', 'replay', 'evidence']) {
    const starts = name === 'run' || name === 'adaptive';
    const options = starts ? ['scope', name === 'adaptive' ? 'structure' : 'components', 'model', 'max-depth', 'max-calls', 'budget-tokens'] : [];
    api.registerCommand(defineCommand({
      name: `rlm ${name}`, description: `${name} a durable recursive language model run`,
      intent: 'Project management = context management for recursive agents',
      arguments: [{ name: starts ? 'question' : 'run', required: true }],
      flags: [...options.map(option => ({ long: `--${option}`, description: option, value_name: 'value', value_type: 'string' as const })), ...(name === 'tree' ? [{ long: '--full', description: 'Include the complete checkpoint', value_type: 'boolean' as const }] : [])],
      examples: name === 'adaptive' ? [`pm rlm adaptive "Explain issues" --structure '[{"name":"summary","question":"What do the issues describe?"}]' --budget-tokens 50000 --json`] : [`pm rlm ${name} ${starts ? '"Count open Issues"' : 'run-id'} --json`],
      run: ctx => runCommand(name, ctx),
    }));
  }
}
