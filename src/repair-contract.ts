import { acceptsSchema } from './action-schema.ts';
import type { ActionSchema } from './action-schema.ts';
import { RlmError } from './errors.ts';
import type { RlmAnswerComponent, RlmModel } from './types.ts';

/** Explicit semantic and source dependencies; declarations must cover the original answer. */
export interface RlmRepairPart { name: string; question: string; depends_on: string[]; sources: string[] }
/** Fresh accounting budget; zero produces a retained answer with named gaps. */
export interface RlmRepairRequest { source: string; parts: RlmRepairPart[]; budget_tokens: number }
/** Persist only execution intent; answers are always reconstructed from verified native ledgers. */
export interface RlmRepairCheckpoint {
  version: 'repair-v1'; revision: number; request: RlmRepairRequest; source_mode: 'tracker' | 'external';
  source_revision: string; revisions: { id: string; revision: string }[];
  targets: { component: string; kind: 'reuse' | 'repair'; phase: 'pending' | 'running' | 'complete' | 'gap' | 'skipped'; child: string; allowance: number; reason: string }[];
}
/** Stable refusals never include untrusted text or operational paths. */
export class RlmRepairError extends RlmError {
  readonly remedy: string;
  /** Keep the reason machine-readable and the corrective action safe for agents. */
  constructor(code: RlmError['code'] = 'invalid') {
    super(code, 'Evidence-directed repair refused');
    this.remedy = code === 'scope' ? 'Keep every source inside the original scope and supply source_workspace again for external sources'
      : code === 'busy' ? 'Let the peer finish, then resume the same repair id; start a fresh repair if its source revision changed'
      : 'Supply complete acyclic parts, an intact evidence source, the original model and a fresh integer budget; resume an interrupted source first';
  }
}
/** Public run controls; the workspace is operational context rather than serialized content. */
export interface RlmRepairOptions {
  workspace: string; author?: string; model?: RlmModel;
  /** Explicit read-only source tracker; must be supplied again when recovering an external-source run. */
  source_workspace?: string;
  /** Durable boundary observer for crash and competing-executor diagnostics. */
  on_transition?: (boundary: string, run: string) => void | Promise<void>;
}
/** Answers retain explicit run identities for their witness step references. */
export interface RlmRepairComponent extends RlmAnswerComponent { run: string; disposition: 'reused' | 'repaired' | 'gap'; remedy: string }
/** Bounded agent receipt; full answers are available through the SDK and --full. */
export interface RlmRepairResult {
  run: string; source: string; status: 'complete' | 'partial';
  budget: { limit: number; charged: number; remaining: number }; calls: number;
  scheduled: string[]; reused: number; gaps: string[]; components: RlmRepairComponent[];
}
/** Unknown or foreign rows are never interpreted as repair controllers. */
export interface RlmRepairSkipped { status: 'skipped'; reason: 'foreign'; remedy: string }
/** Closed definitions shared by request, checkpoint and output validation. */
function closed(properties: Record<string, ActionSchema>): ActionSchema { return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }; }
const count: ActionSchema = { type: 'integer', minimum: 0, maximum: 1000000000 };
const name: ActionSchema = { type: 'string', pattern: '^(?=[\\s\\S]{1,256}$)[\\s\\S]*\\S[\\s\\S]*$' };
const id: ActionSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,160}$' };
const hash: ActionSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const names: ActionSchema = { type: 'array', maxItems: 16, items: name };
const request = closed({ source: id, parts: { type: 'array', maxItems: 16, items: closed({ name, question: { ...name, pattern: '^(?=[\\s\\S]{1,4096}$)[\\s\\S]*\\S[\\s\\S]*$' }, depends_on: names, sources: { type: 'array', maxItems: 1000, items: id } }) }, budget_tokens: count });
/** A single schema family validates both producers and consumers without coercion. */
export const REPAIR_SCHEMA = {
  request,
  checkpoint: closed({ version: { type: 'string', enum: ['repair-v1'] }, revision: count, request, source_mode: { type: 'string', enum: ['tracker', 'external'] }, source_revision: hash, revisions: { type: 'array', maxItems: 16000, items: closed({ id, revision: hash }) }, targets: { type: 'array', maxItems: 16, items: closed({ component: name, kind: { type: 'string', enum: ['reuse', 'repair'] }, phase: { type: 'string', enum: ['pending', 'running', 'complete', 'gap', 'skipped'] }, child: { type: 'string', pattern: '^[A-Za-z0-9_-]{0,160}$' }, allowance: count, reason: { type: 'string', pattern: '^[a-z_]{0,32}$' } }) } }),
  accounting: closed({ limit: count, charged: count, remaining: count, calls: count, reused: { ...count, maximum: 16 } }),
};
/** Give producer and consumer object keys one order while preserving text and array identity. */
function normalizedRequest(input: RlmRepairRequest): RlmRepairRequest {
  return { source: input.source, parts: input.parts.map(part => ({ name: part.name, question: part.question, depends_on: [...part.depends_on], sources: [...part.sources] })), budget_tokens: input.budget_tokens };
}
/** Validate once before effects and copy exact strings; topology uses Map for arbitrary names. */
export function parseRepairRequest(value: unknown): RlmRepairRequest {
  if (!acceptsSchema(REPAIR_SCHEMA.request, value)) throw new RlmRepairError();
  const input = structuredClone(value) as RlmRepairRequest;
  repairOrder(input.parts);
  return normalizedRequest(input);
}
/** Resolve a complete DAG without changing the caller's component or source identity. */
export function repairOrder(parts: RlmRepairPart[]): RlmRepairPart[] {
  const byName = new Map(parts.map(part => [part.name, part]));
  if (parts.length === 0 || byName.size !== parts.length) throw new RlmRepairError();
  const visited = new Set<string>(); const active = new Set<string>(); const result: RlmRepairPart[] = [];
  /** Visit declared prerequisites first and reject missing, repeated or cyclic dependencies. */
  function visit(part: RlmRepairPart): void {
    if (visited.has(part.name)) return;
    if (active.has(part.name) || new Set(part.depends_on).size !== part.depends_on.length || new Set(part.sources).size !== part.sources.length || part.sources.length === 0) throw new RlmRepairError();
    active.add(part.name);
    for (const dependency of part.depends_on) { const target = byName.get(dependency); if (target === undefined) throw new RlmRepairError(); visit(target); }
    active.delete(part.name); visited.add(part.name); result.push(part);
  }
  for (const part of parts) visit(part);
  return result;
}
/** Strict checkpoint interchange preserves declaration ordering and validates producer output. */
export function parseRepairCheckpoint(value: unknown): RlmRepairCheckpoint {
  if (!acceptsSchema(REPAIR_SCHEMA.checkpoint, value)) throw new RlmRepairError('incomplete');
  const checkpoint = structuredClone(value) as RlmRepairCheckpoint;
  checkpoint.request = normalizedRequest(checkpoint.request);
  repairOrder(checkpoint.request.parts);
  const ids = [...new Set(checkpoint.request.parts.flatMap(part => part.sources))];
  const revisions = new Map(checkpoint.revisions.map(entry => [entry.id, entry]));
  if (revisions.size !== checkpoint.revisions.length || ids.length !== revisions.size || ids.some(id => !revisions.has(id))) throw new RlmRepairError('incomplete');
  checkpoint.revisions = ids.map(id => revisions.get(id)!);
  if (checkpoint.targets.length !== checkpoint.request.parts.length || checkpoint.targets.some((target, index) => target.component !== checkpoint.request.parts[index].name)) throw new RlmRepairError('incomplete');
  return checkpoint;
}
/** Refuse nonfinite counters and inconsistent budgets before returning success. */
export function validateRepairResult(result: RlmRepairResult): RlmRepairResult {
  if (!acceptsSchema(REPAIR_SCHEMA.accounting, { ...result.budget, calls: result.calls, reused: result.reused }) || result.budget.charged + result.budget.remaining !== result.budget.limit) throw new RlmRepairError('incomplete');
  return result;
}
