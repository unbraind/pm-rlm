import { PmClient } from '@unbrained/pm-cli/sdk';
import { HttpModel } from './adapters.ts';
import { initialRlmCharge, prepareRlmRun } from './engine.ts';
import type { RlmRunOptions } from './engine.ts';
import { readCorpus, parseFilter, matches } from './environment.ts';
import { assertLedgerPrivacy, estimateTokens, integer, record, RlmError } from './errors.ts';
import { parseComponents } from './evidence.ts';
import { readRlmSettings } from './settings.ts';
import type { RlmAnswerComponent, RlmSettings } from './types.ts';

/** Caller-owned semantic decomposition; the planner never invents question parts. */
export interface RlmQuestionPart { name: string; question: string }
/** Fixed, ordered strategies; comparisons execute no model and do not train policies. */
export type RlmStrategy = 'whole' | 'pairs' | 'components';
/** Admission comparison, using exact native first-step reservations rather than predicted quality. */
export interface RlmStrategyComparison {
  strategy: RlmStrategy;
  groups: number;
  first_step_tokens: number;
  admitted_components: number;
  admitted_groups: number;
  reason: 'fits' | 'budget' | 'calls' | 'context';
}
/** Recoverable planner refusal independent of untrusted input or provider diagnostics. */
export class RlmAdaptiveError extends RlmError {
  /** Action available to an automated caller. */
  readonly remedy: string;
  /** Preserve the underlying stable refusal category. */
  constructor(code: RlmError['code'], reason: string, remedy: string) { super(code, reason); this.remedy = remedy; }
}
/** Compact component output; full answers and witness excerpts stay in the child ledger. */
export interface RlmAdaptiveComponent {
  component: string;
  status: RlmAnswerComponent['status'] | 'deferred' | 'failed';
  run?: string;
  refusal?: RlmError['code'];
  remedy?: string;
}
/** Bounded plan and execution receipt, durably attached to its SDK controller item. */
export interface RlmAdaptiveResult {
  run: string;
  status: 'complete' | 'partial';
  selected: RlmStrategy;
  stop_reason: 'declared_leaves' | 'budget' | 'calls' | 'context' | 'child_failure';
  comparisons: RlmStrategyComparison[];
  budget: { declared: number; limit: number; charged: number; remaining: number };
  calls: number;
  children: { run: string; status: 'complete' | 'failed'; charged: number; calls: number; refusal?: RlmError['code'] }[];
  components: RlmAdaptiveComponent[];
}
/** Explicit question structure and remaining accounting budget; ordinary RLM settings still apply. */
export interface RlmAdaptiveOptions extends Omit<RlmRunOptions, 'components' | 'question_item' | 'on_call_complete'> {
  structure: RlmQuestionPart[];
  remaining_tokens: number;
}
/** Validate untrusted declarations before any tracker writes or model requests. */
export function parseQuestionStructure(value: unknown): RlmQuestionPart[] {
  try {
    if (!Array.isArray(value)) throw new Error();
    const parts = value.map(entry => {
      const part = record(entry);
      if (Object.keys(part).some(key => key !== 'name' && key !== 'question') || typeof part.question !== 'string' || part.question.trim().length === 0 || estimateTokens(part.question) > 4096) throw new Error();
      return { name: part.name as string, question: part.question };
    });
    parseComponents(parts.map(part => part.name));
    return parts;
  } catch { throw new RlmAdaptiveError('invalid', 'Invalid question structure', 'Supply 1 to 16 unique {name,question} parts; names <=256 and questions <=4096 UTF-8 bytes'); }
}
/** Preserve declaration order within each bounded candidate. */
function groups(parts: RlmQuestionPart[], strategy: RlmStrategy): RlmQuestionPart[][] {
  const width = strategy === 'whole' ? parts.length : strategy === 'pairs' ? 2 : 1;
  return Array.from({ length: Math.ceil(parts.length / width) }, (_, index) => parts.slice(index * width, (index + 1) * width));
}
/** Bind the caller's overall question and exact part questions into each child subgoal. */
function subgoal(question: string, parts: RlmQuestionPart[]): string {
  return JSON.stringify({ question, parts });
}
/** Compare three candidates against the same remaining budget and call slots, without inference. */
function compare(question: string, parts: RlmQuestionPart[], settings: RlmSettings, budget: number): RlmStrategyComparison[] {
  return (['whole', 'pairs', 'components'] as const).map(strategy => {
    const plan = groups(parts, strategy);
    let first_step_tokens = 0;
    let admitted_components = 0;
    let admitted_groups = 0;
    let reason: RlmStrategyComparison['reason'] = 'fits';
    for (const group of plan) {
      let cost: number;
      try { cost = initialRlmCharge(subgoal(question, group), group.map(part => part.name), settings); }
      catch (error) { reason = error instanceof RlmError && error.message.includes('context') ? 'context' : 'budget'; break; }
      first_step_tokens += cost;
      if (first_step_tokens > budget) { reason = 'budget'; break; }
      if (admitted_groups >= settings.max_calls) { reason = 'calls'; break; }
      admitted_components += group.length;
      admitted_groups++;
    }
    return { strategy, groups: plan.length, first_step_tokens, admitted_components, admitted_groups, reason };
  });
}
/** Return a safe, stable action for every operational child refusal. */
function remedy(code: RlmError['code']): string {
  if (code === 'budget') return 'Increase remaining_tokens or reduce question parts and source scope';
  if (code === 'calls' || code === 'depth') return 'Increase the corresponding call or depth limit';
  return 'Inspect the child ledger, correct the source or model configuration, and start a new adaptive run';
}
/** Execute only the selected decomposition with shared accounting and durable native child evidence. */
async function executeAdaptive(question: string, options: RlmAdaptiveOptions): Promise<RlmAdaptiveResult> {
  const parts = parseQuestionStructure(options.structure);
  if (typeof question !== 'string' || question.trim().length === 0 || estimateTokens(question) > 4096) throw new RlmAdaptiveError('invalid', 'Invalid overall question', 'Supply a nonblank question of at most 4096 UTF-8 bytes');
  integer(options.remaining_tokens, 0, 1000000000);
  const settings = await readRlmSettings(options.workspace, options.settings);
  const budget = Math.min(options.remaining_tokens, settings.budget_tokens);
  const scope = parseFilter(options.scope ?? {});
  const corpus = await readCorpus(options.source_workspace ?? options.workspace);
  corpus.items = corpus.items.filter(item => matches(item, scope));
  assertLedgerPrivacy({ question, parts, settings, corpus }, options.workspace, settings.key_env);
  const comparisons = compare(question, parts, settings, budget);
  const selected = [...comparisons].sort((a, b) => b.admitted_components - a.admitted_components || b.admitted_groups - a.admitted_groups || a.first_step_tokens - b.first_step_tokens)[0];
  const client = new PmClient({ pmRoot: options.workspace, author: options.author ?? 'pm-rlm', noExtensions: true });
  const parent = (await client.create({ title: 'RLM adaptive plan', type: 'Task', tags: 'rlm:question', description: JSON.stringify({ question, parts, comparisons, selected: selected.strategy, budget }), allowDuplicate: true })).item.id;
  await client.claim(parent);
  const result: RlmAdaptiveResult = { run: parent, status: 'partial', selected: selected.strategy, stop_reason: selected.reason === 'fits' ? 'declared_leaves' : selected.reason, comparisons, budget: { declared: options.remaining_tokens, limit: budget, charged: 0, remaining: budget }, calls: 0, children: [], components: parts.map(part => ({ component: part.name, status: 'deferred', refusal: 'budget', remedy: remedy('budget') })) };
  const model = options.model ?? new HttpModel(settings);
  try {
    await client.comments(parent, { add: `RLM adaptive checkpoint:\n${JSON.stringify(result)}` });
    const plan = groups(parts, selected.strategy).slice(0, selected.admitted_groups);
    for (const [index, group] of plan.entries()) {
      const remainingCalls = settings.max_calls - result.calls;
      const remainingTokens = budget - result.budget.charged;
      const futureFloor = plan.slice(index + 1).reduce((sum, next) => sum + initialRlmCharge(subgoal(question, next), next.map(part => part.name), settings), 0);
      const allowance = remainingTokens - futureFloor;
      if (remainingCalls === 0) { result.stop_reason = 'calls'; break; }
      const child = await prepareRlmRun(subgoal(question, group), { ...options, scope, model, components: group.map(part => part.name), question_item: parent, settings: { ...settings, budget_tokens: allowance, max_calls: remainingCalls } }, corpus);
      let answers: RlmAnswerComponent[] | undefined;
      let refusal: RlmError['code'] | undefined;
      try { answers = (await child.engine.run()).components!; }
      catch (error) {
        refusal = error instanceof RlmError ? error.code : 'model';
        const cleanup = await child.ledger.failUnfinished(child.run, { code: refusal, reason: 'Adaptive child terminated before completion' });
        await client.comments(parent, { add: `RLM adaptive cleanup skipped terminal calls: ${JSON.stringify(cleanup.skipped)}` });
        result.stop_reason = 'child_failure';
      }
      const state = await child.ledger.load(child.run);
      result.calls += state.calls.length;
      result.budget.charged += state.reserved_tokens;
      result.budget.remaining = budget - result.budget.charged;
      result.children.push({ run: child.run, status: refusal === undefined ? 'complete' : 'failed', charged: state.reserved_tokens, calls: state.calls.length, ...(refusal === undefined ? {} : { refusal }) });
      for (const part of group) {
        const target = result.components.find(entry => entry.component === part.name)!;
        const answer = answers?.find(entry => entry.component === part.name);
        Object.assign(target, answer === undefined ? { status: 'failed', run: child.run, refusal: refusal!, remedy: remedy(refusal!) } : { status: answer.status, run: child.run });
        if (answer !== undefined) { delete target.refusal; delete target.remedy; }
      }
      await client.comments(parent, { add: `RLM adaptive checkpoint:\n${JSON.stringify(result)}` });
    }
    for (const entry of result.components.filter(entry => entry.status === 'deferred')) {
      entry.refusal = result.stop_reason === 'calls' ? 'calls' : 'budget';
      entry.remedy = result.stop_reason === 'context' ? 'Increase context_tokens or shorten the declared questions' : remedy(entry.refusal);
    }
    result.status = result.components.every(entry => entry.status === 'supported') ? 'complete' : 'partial';
    await client.comments(parent, { add: `RLM adaptive result:\n${JSON.stringify(result)}` });
    await client.close(parent, 'Adaptive execution stopped; typed result recorded', { validateClose: 'off' });
    return result;
  } finally { await client.release(parent); }
}

/** Sanitize all SDK, configuration and execution refusals into machine-actionable errors. */
export async function adaptiveRlm(question: string, options: RlmAdaptiveOptions): Promise<RlmAdaptiveResult> {
  try { return await executeAdaptive(question, options); }
  catch (error) {
    if (error instanceof RlmAdaptiveError) throw error;
    const code = error instanceof RlmError ? error.code : 'incomplete';
    throw new RlmAdaptiveError(code, 'Adaptive execution refused; inspect inputs and tracker integrity', remedy(code));
  }
}
