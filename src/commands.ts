import { compactReuseResult, reuseRlm } from './reuse.ts';
import { compactRepairResult, repairRlm, resumeRepairRlm } from './repair.ts';
import { parseRepairRequest, RlmRepairError } from './repair-contract.ts';
import { parseReuseIdentity, RlmReuseError } from './reuse-contract.ts';
import { readFile } from 'node:fs/promises';
import type { RlmEvalMetrics, RlmEvalResult, RlmEvalSummary } from './evaluation-types.ts';
import { evaluateRlm, RlmEvalError } from './evaluation.ts';
import { reconcileRlm, parseReconcileArms, RlmReconcileError } from './reconcile.ts';
import { adaptiveRlm, parseQuestionStructure, RlmAdaptiveError } from './adaptive.ts';
import { parseComponents, RlmEvidenceError } from './evidence.ts';
import { createPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { defineCommand } from '@unbrained/pm-cli/sdk/authoring';
import type { CommandHandlerContext, ExtensionApi } from '@unbrained/pm-cli/sdk/authoring';
import { parseFilter } from './environment.ts';
import { evidenceRlm, resumeRlm, replayRlm, runRlm, treeRlm } from './engine.ts';
import { integer, RlmError, RlmTranscriptError, text } from './errors.ts';
import { RLM_FIELDS } from './ledger.ts';
import type { RlmReuseIdentity } from './reuse-contract.ts';
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

/** Keep unknown counters explicit even when host TOON compaction omits object nulls. */
function evaluationOutput(result: RlmEvalResult): Record<string, unknown> {
  /** Convert only metric nulls; known numbers and nonnumeric provenance remain intact. */
  const metrics = (value: RlmEvalMetrics | RlmEvalSummary): Record<string, unknown> => Object.fromEntries(Object.entries(value).map(([key, count]) => [key, count === null ? 'unknown' : count]));
  return { ...result, summary: { truncated: metrics(result.summary.truncated), recursive: metrics(result.summary.recursive) }, ...(result.rows === undefined ? {} : { rows: result.rows.map(row => ({ ...row, truncated: metrics(row.truncated), recursive: metrics(row.recursive) })) }) };
}

/** Dispatch commands through the same SDK engine used by embedded clients. */
export async function runCommand(command: string, ctx: CommandHandlerContext): Promise<Record<string, unknown>> {
  try {
    const argument = operand(ctx.args[0]);
    if (command === 'repair' || command === 'repair-resume') {
      const options = { workspace: ctx.pm_root, author: ctx.global.author };
      let result;
      if (command === 'repair-resume') result = await resumeRepairRlm(argument, options);
      else {
        let parts: unknown;
        try { parts = JSON.parse(operand(ctx.options.parts)); } catch { throw new RlmRepairError(); }
        result = await repairRlm(parseRepairRequest({ source: argument, parts, budget_tokens: numericOperand(ctx.options.budgetTokens) }), options);
      }
      return ctx.options.full === true ? { ...result } : compactRepairResult(result);
    }
    if (command === 'eval') {
      let suite: unknown; let sources: Record<string, string>;
      try {
        suite = JSON.parse(await readFile(argument, 'utf8')) as unknown;
        const input: unknown = JSON.parse(operand(ctx.options.sources));
        if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.values(input).some(value => typeof value !== 'string')) throw new Error();
        sources = input as Record<string, string>;
      } catch { throw new RlmEvalError('invalid', 'Invalid evaluation input', 'Supply a readable suite JSON file and --sources as a JSON object of source id to tracker root'); }
      return evaluationOutput(await evaluateRlm(suite, { workspace: ctx.pm_root, sources, id: operand(ctx.options.id), model: operand(ctx.options.model), full: ctx.options.full === true, endpoint: ctx.options.endpoint === undefined ? undefined : operand(ctx.options.endpoint), author: ctx.global.author }));
    }
    if (command === 'evidence') return { ...await evidenceRlm(ctx.pm_root, argument) };
    if (command === 'tree') return await treeRlm(ctx.pm_root, argument, ctx.options.full === true);
    if (command === 'resume') return { ...await resumeRlm(ctx.pm_root, argument, undefined, ctx.global.author) };
    if (command === 'replay') return { ...await replayRlm(ctx.pm_root, argument) };
    if (command !== 'reuse' && command !== 'run' && command !== 'adaptive' && command !== 'reconcile') throw new RlmError('invalid', 'Unknown rlm command');
    const settings: Partial<RlmSettings> = {};
    for (const [option, setting] of [['maxDepth', 'max_depth'], ['maxCalls', 'max_calls'], ['budgetTokens', 'budget_tokens']] as const) {
      if (ctx.options[option] !== undefined && !(['adaptive', 'reconcile'].includes(command) && setting === 'budget_tokens')) settings[setting] = numericOperand(ctx.options[option]);
    }
    if (ctx.options.model !== undefined) settings.model = operand(ctx.options.model);
    let scope = {};
    if (ctx.options.scope !== undefined) {
      let decoded: unknown;
      try { decoded = JSON.parse(operand(ctx.options.scope)); }
      catch (error) { if (error instanceof SyntaxError) throw new RlmError('invalid', 'Invalid --scope JSON'); throw error; }
      scope = parseFilter(decoded);
    }
    let reuse_identity: RlmReuseIdentity | undefined;
    if (ctx.options.identity !== undefined) {
      try { reuse_identity = parseReuseIdentity(JSON.parse(operand(ctx.options.identity))); }
      catch { throw new RlmReuseError('identity'); }
    }
    if (command === 'reuse') {
      const result = await reuseRlm(argument, { workspace: ctx.pm_root, scope, settings, reuse_identity: parseReuseIdentity(reuse_identity), selection: { run: operand(ctx.options.from), call: operand(ctx.options.call) }, author: ctx.global.author });
      return ctx.options.full === true ? { ...result } : compactReuseResult(result);
    }
    if (command === 'reconcile') {
      let declaration: Record<string, unknown>;
      try { declaration = JSON.parse(operand(ctx.options.plan)) as Record<string, unknown>; }
      catch { throw new RlmReconcileError('invalid', 'Invalid --plan JSON', 'Supply --plan with structure and two arms'); }
      const structure = parseQuestionStructure(declaration?.structure);
      return { ...await reconcileRlm(argument, { workspace: ctx.pm_root, structure, arms: parseReconcileArms(declaration.arms, structure.map(part => part.name)), reserved_tokens: numericOperand(ctx.options.budgetTokens), scope, settings, author: ctx.global.author }) };
    }
    if (command === 'adaptive') {
      let structure: unknown;
      try { structure = JSON.parse(operand(ctx.options.structure)); }
      catch { throw new RlmAdaptiveError('invalid', 'Invalid --structure JSON', 'Supply --structure as an array of {name,question} parts'); }
      if (ctx.options.budgetTokens === undefined) throw new RlmAdaptiveError('invalid', 'Missing declared budget', 'Supply --budget-tokens as an unsigned decimal integer, including zero');
      return { ...await adaptiveRlm(argument, { workspace: ctx.pm_root, structure: parseQuestionStructure(structure), remaining_tokens: numericOperand(ctx.options.budgetTokens), scope, settings, author: ctx.global.author }) };
    }
    return { ...await runRlm(argument, { workspace: ctx.pm_root, scope, settings, reuse_identity, ...(ctx.options.components === undefined ? {} : { components: componentOperand(ctx.options.components) }), author: ctx.global.author }) };
  } catch (error) {
    const code = error instanceof RlmError ? error.code : 'invalid';
    const remedy = error instanceof RlmRepairError || error instanceof RlmReuseError || error instanceof RlmEvidenceError || error instanceof RlmAdaptiveError || error instanceof RlmReconcileError || error instanceof RlmEvalError || error instanceof RlmTranscriptError ? error.remedy : ['repair', 'repair-resume'].includes(command) ? 'Supply --parts JSON and unsigned --budget-tokens for repair, or a repair id for repair-resume; inspect tracker integrity' : ['adaptive', 'reconcile'].includes(command) ? 'Supply valid declarations (--structure or --plan), unsigned --budget-tokens, scope and model settings; inspect tracker integrity' : undefined;
    throw createPmCliExpectedError(`rlm ${code}: ${error instanceof RlmError ? error.message + (remedy === undefined ? '' : '; remedy: ' + remedy) : 'Command failed; check inputs and tracker integrity'}`, { exitCode: code === 'budget' || code === 'depth' || code === 'calls' ? 3 : 2 });
  }
}
/** Register ledger fields and native commands, preserving host TOON and JSON rendering. */
export function register(api: ExtensionApi): void {
  for (const name of ['repair', 'repair-resume']) api.registerCommand(defineCommand({
    name: `rlm ${name}`, description: 'Repair declared evidence gaps with a fresh explicit budget',
    arguments: [{ name: 'run', required: true }],
    flags: [...(name === 'repair' ? ['parts', 'budget-tokens'].map(option => ({ long: `--${option}`, description: option, value_name: 'value', value_type: 'string' as const })) : []), { long: '--full', description: 'Include full supported answers and witness references', value_type: 'boolean' as const }],
    examples: [name === 'repair' ? `pm rlm repair run-id --parts '[{"name":"summary","question":"What is documented?","depends_on":[],"sources":["source-item-id"]}]' --budget-tokens 50000 --json` : 'pm rlm repair-resume run-id --json'], run: ctx => runCommand(name, ctx),
  }));
  api.registerItemFields(RLM_FIELDS);
  api.registerCommand(defineCommand({
    name: 'rlm eval', description: 'Measure recursive and truncated answers on a frozen public question suite',
    arguments: [{ name: 'suite', required: true }],
    flags: [...['sources', 'id', 'model', 'endpoint'].map(name => ({ long: `--${name}`, description: name, value_name: 'value', value_type: 'string' as const })), { long: '--full', description: 'Include per-question metrics', value_type: 'boolean' as const }],
    examples: [`pm rlm eval suite.json --sources '{"sample":"source/.agents/pm"}' --id trial-1 --model gemma3:4b --json`],
    run: ctx => runCommand('eval', ctx),
  }));
  for (const name of ['run', 'reuse', 'adaptive', 'reconcile', 'tree', 'resume', 'replay', 'evidence']) {
    const starts = name === 'reuse' || name === 'run' || name === 'adaptive' || name === 'reconcile';
    const options = starts ? ['scope', ...(name === 'reuse' ? [] : [name === 'reconcile' ? 'plan' : name === 'adaptive' ? 'structure' : 'components']), 'model', 'max-depth', 'max-calls', 'budget-tokens', ...(['run', 'reuse'].includes(name) ? ['identity'] : []), ...(name === 'reuse' ? ['from', 'call'] : [])] : [];
    api.registerCommand(defineCommand({
      name: `rlm ${name}`, description: `${name} a durable recursive language model run`,
      intent: 'Project management = context management for recursive agents',
      arguments: [{ name: starts ? 'question' : 'run', required: true }],
      flags: [...options.map(option => ({ long: `--${option}`, description: option, value_name: 'value', value_type: 'string' as const })), ...(['tree', 'reuse'].includes(name) ? [{ long: '--full', description: 'Include the complete checkpoint', value_type: 'boolean' as const }] : [])],
      examples: name === 'reuse' ? [`pm rlm reuse "Count scoped issues" --from original-run --call original-call --identity '{"tool_policy":"snapshot-v1","model_policy":"pinned-model-v1","consent":"public-review:1"}' --json`] : name === 'reconcile' ? [`pm rlm reconcile "Explain issues" --plan '{"structure":[{"name":"summary","question":"What is documented?"}],"arms":[{"groups":[["summary"]],"budget_tokens":25000},{"groups":[["summary"]],"budget_tokens":25000}]}' --budget-tokens 50000 --json`] : name === 'adaptive' ? [`pm rlm adaptive "Explain issues" --structure '[{"name":"summary","question":"What do the issues describe?"}]' --budget-tokens 50000 --json`] : [`pm rlm ${name} ${starts ? '"Count open Issues"' : 'run-id'} --json`],
      run: ctx => runCommand(name, ctx),
    }));
  }
}
