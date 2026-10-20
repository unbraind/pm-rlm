/** Seeded evaluation design, selected exclusively from exact tracker truth. */
import { createHash } from 'node:crypto';
import { RlmError } from '../src/errors.ts';
import type { RlmItem, RlmFilter } from '../src/types.ts';

/** One independently computed aggregation task. */
export interface EvalQuestion { question: string; answer: string; scope: RlmFilter }
/** Versioned seed shared by design auditing and the live harness. */
export const EVAL_SEED = 'pm-rlm-balanced-v2';
/** Generate twelve diverse exact aggregations with at most two occurrences of each answer. */
export function questions(items: RlmItem[]): EvalQuestion[] {
  const candidates: EvalQuestion[] = [];
  const ordered = [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  /** Add an exact task with the entire copied tracker as its environment. */
  const add = (question: string, answer: string | number): void => { candidates.push({ question, answer: String(answer), scope: {} }); };
  const groups = [{ label: 'all items', rows: ordered }];
  for (const type of [...new Set(ordered.map(item => item.type))].sort()) groups.push({ label: `items of type ${type}`, rows: ordered.filter(item => item.type === type) });
  for (const status of [...new Set(ordered.map(item => item.status))].sort()) groups.push({ label: `items with status ${status}`, rows: ordered.filter(item => item.status === status) });
  for (const { label, rows } of groups) {
    add(`How many ${label} are there?`, rows.length);
    for (const field of ['title', 'description', 'acceptance_criteria']) {
      const lengths = rows.map(item => ({ id: item.id, bytes: Buffer.byteLength(String(item[field] ?? ''), 'utf8') }));
      add(`What is the sum of UTF-8 byte lengths of ${field} across ${label}, treating missing values as empty strings?`, lengths.reduce((sum, item) => sum + item.bytes, 0));
      const ranked = [...lengths].sort((a, b) => b.bytes - a.bytes || (a.id < b.id ? -1 : 1));
      if (ranked.length) add(`Which of ${label} has the largest UTF-8 byte length of ${field}, treating missing values as empty strings and breaking ties by lexicographically smallest id?`, ranked[0].id);
    }
  }
  for (const type of ['Issue', 'Task', 'Feature']) for (const status of ['open', 'closed']) add(`How many items have type ${type} and status ${status}?`, ordered.filter(item => item.type === type && item.status === status).length);
  const epics = ordered.filter(item => item.type === 'Epic').map(item => ({ id: item.id, count: ordered.filter(child => child.parent === item.id && child.status === 'closed').length })).sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
  if (epics.length) add('Which Epic has the most direct closed children, breaking ties by lexicographically smallest id?', epics[0].id);
  /** Preserve historical hash inputs while keeping the model-facing question format-neutral. */
  const rank = (task: EvalQuestion): string => createHash('sha256').update(EVAL_SEED + task.question + ' Answer only the integer or id.').digest('hex');
  candidates.sort((a, b) => rank(a).localeCompare(rank(b)));
  const chosen: EvalQuestion[] = [];
  const histogram = new Map<string, number>();
  /** Select once, with a hard per-source answer-frequency ceiling. */
  const select = (task: EvalQuestion): void => { chosen.push(task); histogram.set(task.answer, (histogram.get(task.answer) ?? 0) + 1); };
  for (const [minimum, maximum] of [[1, 9], [10, 99], [100, 999], [1000, Infinity]]) {
    const task = candidates.find(task => /^\d+$/.test(task.answer) && Number(task.answer) >= minimum && Number(task.answer) <= maximum);
    if (!task) throw new RlmError('invalid', 'Eval corpus lacks required numeric magnitudes');
    select(task);
  }
  for (const task of candidates.filter(task => !/^\d+$/.test(task.answer))) {
    if ((histogram.get(task.answer) ?? 0) < 2) select(task);
    if (chosen.length === 6) break;
  }
  if (chosen.length !== 6) throw new RlmError('invalid', 'Eval corpus lacks id-valued answers');
  for (const task of candidates) {
    if (!chosen.includes(task) && (histogram.get(task.answer) ?? 0) < 2) select(task);
    if (Number(chosen.length) === 12) return chosen;
  }
  throw new RlmError('invalid', 'Eval corpus lacks diverse exact answers');
}
/** Compute answer frequencies and both constant-guess baselines without model inference. */
export function answerDistribution(tasks: EvalQuestion[]) {
  const histogram: Record<string, number> = {};
  for (const task of tasks) histogram[task.answer] = (histogram[task.answer] ?? 0) + 1;
  const counts = Object.values(histogram);
  return { questions: tasks.length, histogram, most_common: Math.max(0, ...counts), zero: histogram['0'] ?? 0 };
}
