import { PmClient } from '@unbrained/pm-cli/sdk';
import { parseQuestionStructure } from './adaptive.ts';
import type { RlmQuestionPart } from './adaptive.ts';
import { HttpModel } from './adapters.ts';
import { blobDigest } from './blobs.ts';
import { initialRlmCharge, prepareRlmRun, replayRlm } from './engine.ts';
import type { RlmRunOptions } from './engine.ts';
import { matches, parseFilter, readCorpus } from './environment.ts';
import { assertLedgerPrivacy, estimateTokens, integer, record, RlmError } from './errors.ts';
import { readRlmSettings } from './settings.ts';
import type { RlmAnswerComponent } from './types.ts';

/** One explicit partition of the common question components, with its own hard allowance. */
export interface RlmReconcileArm { groups: string[][]; budget_tokens: number }
/** Native recursive runs with common semantics and independently declared decompositions. */
export interface RlmReconcileOptions extends Omit<RlmRunOptions, 'components' | 'question_item' | 'on_call_complete'> {
  structure: RlmQuestionPart[];
  arms: [RlmReconcileArm, RlmReconcileArm];
  reserved_tokens: number;
}
/** Typed admission or integrity refusal with a safe corrective action. */
export class RlmReconcileError extends RlmError {
  readonly remedy: string;
  /** Preserve a stable category without exposing provider diagnostics. */
  constructor(code: RlmError['code'], message: string, remedy: string) { super(code, message); this.remedy = remedy; }
}
/** One native ledger outcome; witness step/digest references resolve within this run's root call. */
export interface RlmReconcileGroup {
  run: string;
  charged: number;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  components: RlmAnswerComponent[];
  refusal?: { code: RlmError['code']; remedy: string };
}
/** Compact paired evidence receipt; equality never asserts truth or semantic equivalence. */
export interface RlmReconcileResult {
  run: string;
  boundary: { digest: string; items: number };
  status: 'complete' | 'partial';
  interpretation: 'exact_answer_comparison_not_truth';
  token_usage: 'reported_or_estimated';
  budget: { reserved: number; allocated: number; charged: number; remaining: number };
  arms: { budget_tokens: number; charged: number; groups: RlmReconcileGroup[] }[];
  comparisons: { component: string; relation: 'disagreement' | 'equal_text' | 'unresolved' }[];
}
/** Validate two bounded exact partitions, rejecting missing, repeated and unknown components. */
export function parseReconcileArms(value: unknown, names: string[]): [RlmReconcileArm, RlmReconcileArm] {
  try {
    if (!Array.isArray(value) || value.length !== 2) throw new Error();
    const arms = value.map(entry => {
      const arm = record(entry);
      integer(arm.budget_tokens, 1, 1000000000);
      if (Object.keys(arm).some(key => key !== 'groups' && key !== 'budget_tokens') || !Array.isArray(arm.groups) || arm.groups.length === 0 || arm.groups.length > names.length) throw new Error();
      const groups = arm.groups.map(group => {
        if (!Array.isArray(group) || group.length === 0 || group.some(name => !names.includes(name as string))) throw new Error();
        return [...group] as string[];
      });
      const flat = groups.flat();
      if (flat.length !== names.length || new Set(flat).size !== names.length) throw new Error();
      return { groups, budget_tokens: arm.budget_tokens as number };
    });
    return arms as [RlmReconcileArm, RlmReconcileArm];
  } catch { throw new RlmReconcileError('invalid', 'Invalid paired decomposition', 'Supply two {groups,budget_tokens} arms; each groups partition must cover every declared component exactly once'); }
}
/** Bind the common question and exact caller questions into every group subgoal. */
function groupQuestion(question: string, parts: RlmQuestionPart[], names: string[]): string {
  return JSON.stringify({ question, parts: names.map(name => parts.find(part => part.name === name)!) });
}
/** Execute paired plans sequentially with disjoint allowances and one certified snapshot. */
async function executeReconciliation(question: string, options: RlmReconcileOptions): Promise<RlmReconcileResult> {
  const parts = parseQuestionStructure(options.structure);
  if (typeof question !== 'string' || question.trim().length === 0 || estimateTokens(question) > 4096) throw new RlmReconcileError('invalid', 'Invalid overall question', 'Supply a nonblank question of at most 4096 UTF-8 bytes');
  const arms = parseReconcileArms(options.arms, parts.map(part => part.name));
  integer(options.reserved_tokens, 0, 1000000000);
  const settings = await readRlmSettings(options.workspace, options.settings);
  const allocated = arms.reduce((sum, arm) => sum + arm.budget_tokens, 0);
  if (allocated > Math.min(options.reserved_tokens, settings.budget_tokens)) throw new RlmReconcileError('budget', 'Arm allocations exceed reserved budget', 'Reduce arm budgets or increase both reserved_tokens and the configured budget_tokens limit');
  if (arms.reduce((sum, arm) => sum + arm.groups.length, 0) > settings.max_calls) throw new RlmReconcileError('calls', 'Decompositions exceed call slots', 'Increase max_calls or combine groups');
  const floors = arms.map(arm => arm.groups.map(names => initialRlmCharge(groupQuestion(question, parts, names), names, settings)));
  if (arms.some((arm, index) => floors[index].reduce((sum, cost) => sum + cost, 0) > arm.budget_tokens)) throw new RlmReconcileError('budget', 'Arm cannot reserve all first steps', 'Increase the arm budget, shorten questions or reduce output_tokens');
  const scope = parseFilter(options.scope ?? {});
  const captured = await readCorpus(options.source_workspace ?? options.workspace);
  const corpus = { ...captured, items: captured.items.filter(item => matches(item, scope)) };
  assertLedgerPrivacy({ question, parts, arms, corpus, settings }, options.workspace, settings.key_env);
  const boundary = { digest: blobDigest(JSON.stringify({ question, parts, scope, corpus })), items: corpus.items.length };
  const client = new PmClient({ pmRoot: options.workspace, author: options.author ?? 'pm-rlm', noExtensions: true });
  const run = (await client.create({ type: 'Task', title: 'RLM paired reconciliation', tags: 'rlm:question', description: JSON.stringify({ question, parts, arms, boundary }), allowDuplicate: true })).item.id;
  await client.claim(run);
  const receipt: RlmReconcileResult = { run, boundary, status: 'partial', interpretation: 'exact_answer_comparison_not_truth', token_usage: 'reported_or_estimated', budget: { reserved: options.reserved_tokens, allocated, charged: 0, remaining: options.reserved_tokens }, arms: arms.map(arm => ({ budget_tokens: arm.budget_tokens, charged: 0, groups: [] })), comparisons: [] };
  const model = options.model ?? new HttpModel(settings);
  let calls = 0;
  try {
    await client.comments(run, { add: `RLM reconciliation checkpoint:\n${JSON.stringify(receipt)}` });
    for (const [armIndex, arm] of arms.entries()) {
      const target = receipt.arms[armIndex];
      for (const [index, names] of arm.groups.entries()) {
        const futureCalls = arms.slice(armIndex + 1).reduce((sum, future) => sum + future.groups.length, 0) + arm.groups.length - index - 1;
        const futureFloor = floors[armIndex].slice(index + 1).reduce((sum, cost) => sum + cost, 0);
        const child = await prepareRlmRun(groupQuestion(question, parts, names), { workspace: options.workspace, author: options.author, scope, model, components: names, question_item: run, snapshot_only: true, settings: { ...settings, budget_tokens: arm.budget_tokens - target.charged - futureFloor, max_calls: settings.max_calls - calls - futureCalls } }, structuredClone(corpus));
        let components: RlmAnswerComponent[] = [];
        let refusal: RlmReconcileGroup['refusal'];
        try { components = (await child.engine.run()).components!; await replayRlm(options.workspace, child.run); }
        catch (error) {
          refusal = { code: error instanceof RlmError ? error.code : 'model', remedy: 'Inspect the native run ledger; correct configuration or increase the reserved arm budget before starting a new comparison' };
        }
        const state = await child.ledger.load(child.run);
        if (refusal !== undefined) {
          const unlock = await child.ledger.lease(child.run);
          try {
            for (const call of state.calls) {
              if (call.result === undefined && call.failure === undefined) call.failure = { code: refusal.code, reason: 'Paired execution stopped' };
            }
            await child.ledger.save(state);
            for (const call of state.calls) await child.ledger.complete(state, call);
          } finally { await unlock(); }
        }
        const responses = state.calls.flatMap(call => call.steps.flatMap(step => step.response === undefined ? [] : [step.response]));
        const group: RlmReconcileGroup = { run: child.run, charged: state.reserved_tokens, calls: state.calls.length, tokens_in: responses.reduce((sum, response) => sum + response.tokens_in, 0), tokens_out: responses.reduce((sum, response) => sum + response.tokens_out, 0), components: refusal === undefined ? components : [], ...(refusal === undefined ? {} : { refusal }) };
        target.groups.push(group);
        target.charged += group.charged;
        calls += group.calls;
        receipt.budget.charged += group.charged;
        receipt.budget.remaining = options.reserved_tokens - receipt.budget.charged;
        await client.comments(run, { add: `RLM reconciliation checkpoint:\n${JSON.stringify(receipt)}` });
      }
    }
    const comparisons: RlmReconcileResult['comparisons'] = parts.map(part => {
      const answers = receipt.arms.map(arm => arm.groups.flatMap(group => group.components).find(component => component.component === part.name));
      const relation = answers.some(answer => answer?.status !== 'supported') ? 'unresolved' : answers[0]!.answer === answers[1]!.answer ? 'equal_text' : 'disagreement';
      return { component: part.name, relation };
    });
    Object.assign(receipt, { comparisons, status: comparisons.every(entry => entry.relation !== 'unresolved') ? 'complete' : 'partial' });
    await client.comments(run, { add: `RLM reconciliation result:\n${JSON.stringify(receipt)}` });
    await client.close(run, 'Paired comparison stopped; evidence receipt recorded', { validateClose: 'off' });
    return receipt;
  } finally { await client.release(run); }
}
/** Return a paired evidence workflow or a sanitized typed refusal with a remedy. */
export async function reconcileRlm(question: string, options: RlmReconcileOptions): Promise<RlmReconcileResult> {
  try {
    const { model, ...declarations } = options;
    return await executeReconciliation(question, { ...structuredClone(declarations), model });
  }
  catch (error) {
    if (error instanceof RlmReconcileError) throw error;
    throw new RlmReconcileError(error instanceof RlmError ? error.code : 'incomplete', 'Reconciliation refused; inspect declarations and tracker integrity', 'Use valid bounded declarations and settings; inspect native run ledgers before retrying');
  }
}
