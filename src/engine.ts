import { parseReuseIdentity, parseReuseSelection, parseReuseRequest, RlmReuseConflict, RlmReuseError } from './reuse-contract.ts';
import { applyPendingReuse, reuseTargetContract, validateReuseState } from './reuse.ts';
import { EVIDENCE_PROTOCOL, parseComponents, sourceWitness, validateAnswer, RlmEvidenceError } from './evidence.ts';
import { assertLedgerPrivacy, estimateTokens, RlmError, RlmTranscriptError, text } from './errors.ts';
import { matches, parseFilter, partitionItems, readCorpus, RlmContext } from './environment.ts';
import { HttpModel } from './adapters.ts';
import { promptDigest, reserveStep, settleStep, RlmLedger } from './ledger.ts';
import { parseAction, parseSlice, PROTOCOL } from './protocol.ts';
import { readRlmSettings } from './settings.ts';
import type { RlmReuseIdentity, RlmReuseSelection } from './reuse-contract.ts';
import type { RlmAction, RlmAnswerComponent, RlmEvidenceReport, RlmCall, RlmFilter, RlmItem, RlmModel, RlmResult, RlmSettings, RlmSlice, RlmState, RlmStep } from './types.ts';

/** Run creation parameters for third-party loops. Workspace is an explicit pm tracker root. */
export interface RlmRunOptions {
  workspace: string;
  /** Opt in before inference; exact opaque policy and consent revisions are caller-owned. */
  reuse_identity?: RlmReuseIdentity;
  /** Explicit durable reuse intent; recovery never falls back to model inference. */
  reuse_selection?: RlmReuseSelection;
  /** Optional read-only source snapshot; history actions and ledger writes use workspace. */
  source_workspace?: string;
  /** Refuse history reads outside the captured item snapshot. */
  snapshot_only?: true;
  scope?: RlmFilter;
  /** Require each recursive answer to cover these caller-declared components. */
  components?: string[];
  settings?: Partial<RlmSettings>;
  model?: RlmModel;
  author?: string;
  question_item?: string;
  on_call_complete?: (call: RlmCall) => void | Promise<void>;
}
/** Current producer policy shared with immutable child-contract verification. */
export const RLM_VERSIONS = { parser_version: 3, aggregate_version: 2 } as const;
/** Fresh empty slice for a root whose authorized scope lives outside its prompt. */
export function emptyRootSlice(): RlmSlice { return { fragments: [], estimated_tokens: estimateTokens([]) }; }
/** Construct prompts identically for reservation planning and live execution. */
function modelPrompt(call: RlmCall, components?: string[], observation?: unknown): string {
  return `${PROTOCOL}${components === undefined ? '' : '\n' + EVIDENCE_PROTOCOL + JSON.stringify(components)}\n${JSON.stringify({ question: call.subgoal, depth: call.depth, slice: call.slice, transcript: call.steps.map((step, index) => ({ action: step.response!.text, observation: index === call.steps.length - 1 && observation !== undefined ? observation : step.observation })) })}`;
}
/** Compute exact first-step admission through the engine's native reservation primitive. */
export function initialRlmCharge(question: string, components: string[], settings: RlmSettings): number {
  const call: RlmCall = { id: '', depth: 0, subgoal: question, slice: emptyRootSlice(), digest: '', steps: [] };
  const state = { settings, reserved_tokens: 0 };
  return reserveStep(state, call, modelPrompt(call, components)).reserved;
}
/** Summarize exact call counts and label model usage that can contain byte-based estimates. */
function result(state: RlmState): RlmResult {
  const responses = state.calls.flatMap(call => call.steps.flatMap(step => step.response === undefined ? [] : [step.response]));
  return { ...(state.reuse === undefined ? {} : { reuse: state.reuse }), ...(state.components === undefined ? {} : { components: JSON.parse(state.calls[0].result!) as RlmAnswerComponent[] }), token_usage: 'reported_or_estimated', run: state.run, answer: state.calls[0].result!, calls: state.calls.length, reserved_tokens: state.reserved_tokens, tokens_in: responses.reduce((sum, response) => sum + response.tokens_in, 0), tokens_out: responses.reduce((sum, response) => sum + response.tokens_out, 0) };
}
/** Authenticate call identities and depth before deriving any prompt or admitting a cached child. */
function validateCallGraph(state: RlmState): void {
  const calls = new Map(state.calls.map(call => [call.id, call]));
  if (state.calls[0]?.id !== state.run || state.calls[0].depth !== 0 || calls.size !== state.calls.length || state.calls.length > state.settings.max_calls || state.calls.some((call, index) => call.depth > state.settings.max_depth || (index > 0 && call.depth !== (calls.get(call.parent!)?.depth ?? -2) + 1))) throw new RlmTranscriptError('Recorded call graph differs from its declared bounds');
}
/** Authenticate one exact producer prompt against its call and completed transcript prefix. */
function authenticStepPrompt(state: RlmState, call: RlmCall, index: number): boolean {
  const prefix = call.steps.slice(0, index);
  return state.calls[0].subgoal === state.question && call.digest === promptDigest(call.subgoal, call.slice, state.settings) && prefix.every(step => step.response !== undefined && step.observation !== undefined)
    && call.steps[index].prompt === modelPrompt({ ...call, steps: prefix }, state.components);
}
/** Authenticate completed and pending proof records through the same prompt producer. */
function validateNativeTranscript(state: RlmState): void {
  validateCallGraph(state);
  for (const call of state.calls) {
    if (call.digest !== promptDigest(call.subgoal, call.slice, state.settings) || call.steps.some((_step, index) => !authenticStepPrompt(state, call, index))) throw new RlmTranscriptError('Recorded prompt differs from its declared call');
  }
}
/** Bind opted-in reuse identities to the same authenticated native transcript. */
export function validateReuseTranscript(state: RlmState): void {
  try { validateNativeTranscript(state); } catch { throw new RlmReuseError('provenance'); }
}
/** Derive every unsettled hold through the native reservation producer, without mutating the ledger. */
function validateStepReservation(state: RlmState, call: RlmCall, step: RlmStep): void {
  let expected: number;
  try { expected = reserveStep({ settings: state.settings, reserved_tokens: 0 }, { ...call, steps: [] }, step.prompt).reserved; }
  catch { throw new RlmTranscriptError('Recorded reservation cannot admit its model step'); }
  if (step.settled === true ? step.reserved > expected : step.reserved !== expected) throw new RlmTranscriptError('Recorded reservation differs from its required amount');
}
/** Require full producer holds; legacy counters may conservatively retain earlier charges. */
function validatePendingStep(state: RlmState, call: RlmCall, index: number): void {
  validateCallGraph(state);
  if (!authenticStepPrompt(state, call, index)) throw new RlmTranscriptError('Pending prompt differs from its declared call');
  validateStepReservation(state, call, call.steps[index]);
  const charged = state.calls.reduce((total, entry) => entry.steps.reduce((sum, step) => {
    const observation = step.observation;
    const read = typeof observation === 'object' && observation !== null && 'estimated_tokens' in observation ? observation.estimated_tokens : 0;
    return typeof read === 'number' && Number.isSafeInteger(read) && read >= 0 ? sum + step.reserved + read : NaN;
  }, total), 0);
  if (!Number.isSafeInteger(charged) || !Number.isSafeInteger(state.reserved_tokens) || charged > state.reserved_tokens || state.reserved_tokens > state.settings.budget_tokens) throw new RlmTranscriptError('Pending budget understates recorded charges or exceeds its limit');
}
/** Complete answers use one deterministic representation with no unchecked free-text summary. */
function completion(state: RlmState, call: RlmCall, action: Extract<RlmAction, { action: 'finish' | 'answer' }>, before: number): string {
  if (action.action === 'answer') return validateAnswer(state, call, action.components, before);
  if (state.components !== undefined) throw new RlmEvidenceError('Evidence contract requires component answers', 'Use the answer action with every declared component and source witnesses');
  return action.answer;
}
/** Recompute the exact bounded source read shared by live execution and replay. */
function witnessRead(state: RlmState, call: RlmCall, action: Extract<RlmAction, { action: 'witness' }>) {
  const data = sourceWitness(callItems(state, call), action.id, action.start, action.end);
  return { data, estimated_tokens: estimateTokens(data), complete_list: state.certificate };
}
/** Keep compact partition observations identical in production and verification. */
function partitionRead(state: RlmState, call: RlmCall, action: Extract<RlmAction, { action: 'partition' }>) {
  const data = partitionItems(callItems(state, call).filter(item => matches(item, action.filter)), action.maxTokens).map((slice, index) => ({ partition_step: call.steps.length - 1, index, estimated_tokens: slice.estimated_tokens }));
  return { data, estimated_tokens: estimateTokens(data), complete_list: state.certificate };
}
/** Return full items only when the child received their complete serialized representation. */
function callItems(state: RlmState, call: RlmCall): RlmItem[] {
  if (call.depth === 0) return state.snapshot;
  return state.snapshot.filter(item => {
    const fragments = call.slice.fragments.filter(fragment => fragment.id === item.id).sort((a, b) => a.start - b.start);
    return fragments.length > 0 && fragments[0].start === 0 && fragments.every((entry, index) => index === 0 || entry.start === fragments[index - 1].end) && fragments.map(entry => entry.text).join('') === JSON.stringify(item);
  });
}
/** Validate every slice against the caller's authorized fragments or full scoped items. */
function validateSlice(state: RlmState, parent: RlmCall, slice: RlmSlice): void {
  const items = callItems(state, parent);
  for (const fragment of slice.fragments) {
    const item = items.find(item => item.id === fragment.id);
    const covered = item !== undefined && JSON.stringify(item).slice(fragment.start, fragment.end) === fragment.text;
    const inherited = parent.slice.fragments.some(entry => entry.id === fragment.id && fragment.start >= entry.start && fragment.end <= entry.end && entry.text.slice(fragment.start - entry.start, fragment.end - entry.start) === fragment.text);
    if (!covered && !inherited) throw new RlmError('scope', 'Sub-call slice exceeds its parent scope');
  }
}
/** Apply spawn admission checks in live order before finding or allocating a child. */
function prepareSpawn(state: RlmState, parent: RlmCall | undefined, subgoal: string, slice: RlmSlice): RlmCall | undefined {
  text(subgoal); parseSlice(slice);
  if (parent === undefined) throw new RlmError('scope', 'Calling call was not found');
  validateSlice(state, parent, slice);
  const call = state.calls.find(call => call.parent === parent.id && call.digest === promptDigest(subgoal, slice, state.settings));
  if (call === undefined) {
    if (parent.depth + 1 > state.settings.max_depth) throw new RlmError('depth', 'Maximum recursion depth reached');
    if (state.calls.length >= state.settings.max_calls) throw new RlmError('calls', 'Maximum call count reached');
  }
  return call;
}
/** Resolve a compact partition reference deterministically against the frozen authorized snapshot. */
function resolveSlice(state: RlmState, call: RlmCall, slice: RlmSlice | { partition_step: number; index: number }): RlmSlice {
  if ('fragments' in slice) return slice;
  const step = call.steps[slice.partition_step];
  if (step?.response === undefined || step.observation === undefined || typeof step.observation !== 'object' || step.observation === null || 'refused' in step.observation) throw new RlmError('scope', 'Partition reference is unavailable');
  const action = parseAction(step.response.text, state.parser_version ?? 1);
  if (action.action !== 'partition') throw new RlmError('scope', 'Reference must select a partition step');
  const result = partitionItems(callItems(state, call).filter(item => matches(item, action.filter)), action.maxTokens)[slice.index];
  if (result === undefined) throw new RlmError('scope', 'Partition slice index is unavailable');
  return result;
}
/** Execute the read protocol identically for live runs and read-only replay. */
async function readAction(context: RlmContext, action: Exclude<RlmAction, { action: 'spawn' | 'finish' | 'answer' | 'witness' | 'partition' }>) {
  switch (action.action) {
    case 'list': return context.list(action.filter);
    default: return context.aggregate(action);
    case 'search': return context.search(action.query, action.limit);
    case 'get': return context.get(action.id, action.fields);
    case 'history': return context.history(action.id, action);
    case 'peek': return context.peek(action.id, action.field, action.start, action.end);
  }
}
/** Recompute successful reads without applying write-time privacy policy to historical data. */
async function producedRead(workspace: string, state: RlmState, call: RlmCall, index: number, action: Exclude<RlmAction, { action: 'spawn' | 'finish' | 'answer' }>) {
  if (state.snapshot_only === true && action.action === 'history') throw new RlmTranscriptError('Recorded history exceeds the immutable input boundary');
  const context = new RlmContext(workspace, callItems(state, call), state.certificate, state.settings.budget_tokens, state.aggregate_version ?? 1);
  const read = action.action === 'partition' ? partitionRead(state, { ...call, steps: call.steps.slice(0, index + 1) }, action)
    : action.action === 'witness' ? witnessRead(state, call, action) : await readAction(context, action);
  return read;
}
/** Compare recorded reads through the producer, retaining legacy partition serialization. */
async function recordedRead(workspace: string, state: RlmState, call: RlmCall, index: number, action: Exclude<RlmAction, { action: 'spawn' | 'finish' | 'answer' }>, observation: unknown) {
  const read = await producedRead(workspace, state, call, index, action);
  if (JSON.stringify(read) === JSON.stringify(observation)) return read;
  if (action.action === 'partition') {
    const legacy = await new RlmContext(workspace, callItems(state, call), state.certificate, state.settings.budget_tokens, state.aggregate_version ?? 1).partition(action.filter, action.maxTokens);
    if (JSON.stringify(legacy) === JSON.stringify(observation)) return legacy;
  }
  throw new RlmTranscriptError('Recorded environment observation differs');
}
/** Reconstruct interrupted read observations only in a copy used to authenticate later prompts. */
async function proofTranscript(workspace: string, state: RlmState): Promise<RlmState> {
  const copy = structuredClone(state);
  for (const call of copy.calls) for (const [index, step] of call.steps.entries()) {
    if (call.result !== undefined || step.observation !== undefined || step.response === undefined || index === call.steps.length - 1) continue;
    const action = parseAction(step.response.text, copy.parser_version ?? 1);
    if (action.action !== 'spawn' && action.action !== 'finish' && action.action !== 'answer') step.observation = await producedRead(workspace, copy, call, index, action);
  }
  return copy;
}
/** Recompute parser refusals before trusting their recorded code or corrective prompt text. */
function recordedAction(state: RlmState, call: RlmCall, step: RlmStep): RlmAction | undefined {
  try { return parseAction(step.response!.text, state.parser_version ?? 1); }
  catch (error) {
    // parseAction exposes only typed RlmError refusals for recorded string outputs.
    const refusal = error as RlmError;
    const observation = step.observation as { refused?: unknown; reason?: unknown; remedy?: unknown } | undefined;
    const legacyCodeOnly = (state.parser_version ?? 1) === 1 && observation?.reason === undefined;
    if (observation?.refused !== refusal.code || (!legacyCodeOnly && observation?.reason !== refusal.message) || observation!.remedy !== undefined) throw new RlmError('replay', `Recorded parse refusal differs at step ${call.id}:${call.steps.indexOf(step)}`);
    return undefined;
  }
}
/** Rebuild a terminal child refusal with its authenticated corrective text when present. */
function recordedChildRefusal(failure: NonNullable<RlmCall['failure']>): RlmError {
  const reason = failure.reason ?? 'Recorded child refusal';
  return failure.remedy === undefined ? new RlmError(failure.code, reason) : new RlmEvidenceError(reason, failure.remedy);
}
/** Bounded recursive loop backed by a durable SDK call graph. */
export class RlmEngine {
  private readonly ledger: RlmLedger;
  private readonly model: RlmModel;
  private state: RlmState;
  private readonly contract?: string;
  private readonly selection?: RlmReuseSelection;
  private readonly strictUsage: boolean;
  private readonly onComplete?: (call: RlmCall) => void | Promise<void>;
  /** Bind one recovered or new state to its transport and explicit tracker. */
  constructor(ledger: RlmLedger, state: RlmState, model: RlmModel, onComplete?: (call: RlmCall) => void | Promise<void>, strictUsage = false) { this.strictUsage = strictUsage; this.ledger = ledger; this.state = state; this.model = model; this.onComplete = onComplete; this.contract = state.reuse_identity === undefined ? undefined : reuseTargetContract(state); this.selection = state.reuse_selection === undefined ? undefined : { ...state.reuse_selection }; }
  /** Expose a durable copy for observational embedded tooling. */
  snapshot(): RlmState { return structuredClone(this.state); }
  /** Reserve a logical child before materialization; digest reuse survives process failure. */
  async spawn(parentId: string, subgoal: string, slice: RlmSlice): Promise<string> {
    const state = this.state;
    validateCallGraph(state);
    const parent = state.calls.find(call => call.id === parentId);
    let call = prepareSpawn(state, parent, subgoal, slice);
    if (call === undefined) {
      call = { id: `${state.run}-c${state.calls.length}`, parent: parent!.id, depth: parent!.depth + 1, subgoal, slice, digest: promptDigest(subgoal, slice, state.settings), steps: [] };
      state.calls.push(call);
      await this.ledger.save(state);
    }
    try { return await this.execute(call); }
    catch (error) {
      if (!(error instanceof RlmError)) throw error;
      const failure = { code: error.code, reason: error.message, ...(error instanceof RlmEvidenceError ? { remedy: error.remedy } : {}) };
      if (call.result === undefined) {
        call.failure = failure;
        await this.ledger.save(state);
        await this.ledger.complete(state, call);
      } else {
        call.completion_refusal = failure;
        await this.ledger.save(state);
      }
      throw error;
    }
  }
  /** Construct the exact prompt used by projection checks and the next inference. */
  private prompt(call: RlmCall, observation?: unknown): string {
    return modelPrompt(call, this.state.components, observation);
  }
  /** Execute one action, refusing oversized observations before charging or retaining data. */
  private async observe(action: Exclude<RlmAction, { action: 'finish' | 'answer' }>, call: RlmCall, state = this.state, spawn = (subgoal: string, slice: RlmSlice) => this.spawn(call.id, subgoal, slice)): Promise<unknown> {
    if (state.snapshot_only === true && action.action === 'history') throw new RlmEvidenceError('History is outside the immutable input boundary', 'Use get, peek or witness on captured items');
    let observation: unknown;
    let charge = 0;
    if (action.action === 'spawn') observation = { result: await spawn(action.subgoal, resolveSlice(state, call, action.slice)) };
    else if (action.action === 'partition') {
      const read = partitionRead(state, call, action);
      observation = read;
      charge = read.estimated_tokens;
      if (charge > state.settings.budget_tokens - state.reserved_tokens) throw new RlmError('budget', 'Partition index exceeds remaining budget');
    } else if (action.action === 'witness') {
      observation = witnessRead(state, call, action);
      charge = estimateTokens((observation as { data: unknown }).data);
      if (charge > state.settings.budget_tokens - state.reserved_tokens) throw new RlmError('budget', 'Witness exceeds remaining budget');
    } else {
      const context = new RlmContext(this.ledger.workspace, callItems(state, call), state.certificate, state.settings.budget_tokens - state.reserved_tokens, state.aggregate_version ?? 1);
      const read = await readAction(context, action);
      charge = read.estimated_tokens;
      observation = read;
    }
    if (estimateTokens(this.prompt(call, observation)) + state.settings.output_tokens > state.settings.context_tokens) throw new RlmError('budget', 'Observation does not fit the next model prompt');
    assertLedgerPrivacy(observation, this.ledger.workspace, state.settings.key_env);
    state.reserved_tokens += charge;
    return observation;
  }
  /** Verify execution without writes, optionally checking exact accounting reconstructed in call order. */
  async validateRecorded(strictUsage = this.strictUsage): Promise<void> {
    if (this.state.reuse !== undefined) { await validateReuseState(this.ledger.workspace, this.state); return; }
    validateCallGraph(this.state);
    const verifyingProof = strictUsage || this.state.components !== undefined || this.state.reuse_identity !== undefined;
    if (verifyingProof) validateNativeTranscript(await proofTranscript(this.ledger.workspace, this.state));
    const state = { ...this.state, reserved_tokens: 0 };
    const visited = new Set<string>();
    /** Charge each logical call once, including children reached before a parent observation. */
    const visit = async (call: RlmCall): Promise<void> => {
      if (visited.has(call.id)) return;
      visited.add(call.id);
      let completed = false;
      for (const [index, step] of call.steps.entries()) {
        if (step.response === undefined) validatePendingStep(this.state, call, index);
        else if (verifyingProof) validateStepReservation(this.state, call, step);
        if (verifyingProof && step.settled === true && step.reserved !== step.response!.tokens_in + step.response!.tokens_out) throw new RlmTranscriptError('Settled charge differs from recorded usage');
        state.reserved_tokens += step.response !== undefined && step.settled !== true
          ? step.response.tokens_in + step.response.tokens_out
          : step.reserved;
        if (step.response === undefined) continue;
        let action: RlmAction;
        try { action = parseAction(step.response.text, state.parser_version ?? 1); } catch { continue; }
        if (action.action === 'finish' && state.components === undefined) continue;
        if (action.action === 'finish' || action.action === 'answer') {
          if (step.observation === undefined && call.result === undefined) continue;
          let refusal: RlmError | undefined;
          let answer: string | undefined;
          try { answer = completion(state, call, action, index); } catch (error) { refusal = error as RlmError; }
          const recorded = step.observation as { refused?: string; reason?: string; remedy?: unknown } | undefined;
          const remedy = refusal instanceof RlmEvidenceError ? refusal.remedy : undefined;
          if (refusal !== undefined ? recorded?.refused !== refusal.code || recorded.reason !== refusal.message || recorded.remedy !== remedy : recorded !== undefined || call.result !== answer) throw new RlmError('replay', 'Recorded component completion differs');
          if (refusal === undefined) completed = true;
          continue;
        }
        const prefix = { ...call, steps: call.steps.slice(0, index + 1) };
        let spawnRefusal: RlmError | undefined;
        let validatingChild = false;
        let spawned: unknown;
        let completedSpawn = false;
        if (action.action === 'spawn') {
          try {
            spawned = await this.observe(action, prefix, state, async (subgoal, slice) => {
              const admitted = prepareSpawn({ ...state, calls: state.calls.filter(entry => visited.has(entry.id)) }, prefix, subgoal, slice);
              const child = admitted ?? state.calls.find(child => child.parent === call.id && child.digest === promptDigest(subgoal, slice, state.settings));
              if (child === undefined) throw new RlmError('incomplete', 'Recorded spawn has no child');
              const reused = visited.has(child.id);
              validatingChild = true;
              await visit(child);
              validatingChild = false;
              const failure = child.failure ?? (reused ? undefined : child.completion_refusal);
              if (failure !== undefined) throw recordedChildRefusal(failure);
              completedSpawn = child.result !== undefined;
              return child.result ?? '';
            });
          } catch (error) {
            if (validatingChild) throw error;
            spawnRefusal = error as RlmError;
          }
        }
        const observation = step.observation;
        if (observation === undefined) continue;
        if (typeof observation === 'object' && observation !== null && 'refused' in observation) {
          let refusal = spawnRefusal;
          if (action.action !== 'spawn') {
            try { await this.observe(action, prefix, state); }
            catch (error) { refusal = error as RlmError; }
          }
          const legacyCodeOnly = (state.parser_version ?? 1) === 1 && !('reason' in observation);
          const remedy = refusal instanceof RlmEvidenceError ? refusal.remedy : undefined;
          if (refusal === undefined || observation.refused !== refusal.code || (!legacyCodeOnly && (!('reason' in observation) || observation.reason !== refusal.message)) || (observation as { remedy?: unknown }).remedy !== remedy) throw new RlmError('replay', `Recorded execution refusal differs at step ${call.id}:${index}`);
        } else if (action.action === 'spawn') {
          if (!completedSpawn || JSON.stringify(spawned) !== JSON.stringify(observation)) throw new RlmTranscriptError('Recorded child observation differs');
        } else {
          const read = await recordedRead(this.ledger.workspace, this.state, call, index, action, observation);
          state.reserved_tokens += read.estimated_tokens;
        }
      }
      if (state.components !== undefined && call.result !== undefined && !completed) throw new RlmError('replay', 'Completed evidence call has no verified component answer');
    };
    await visit(state.calls[0]);
    if (verifyingProof && (this.state.reserved_tokens < state.reserved_tokens || this.state.reserved_tokens > this.state.settings.budget_tokens)) throw new RlmTranscriptError('Proof budget differs from its supported charges');
    if (strictUsage && visited.size !== this.state.calls.length) throw new RlmTranscriptError('Native call graph contains unreachable records');
    if (strictUsage && state.reserved_tokens !== this.state.reserved_tokens) throw new RlmTranscriptError('Recorded budget differs from its step charges');
  }
  /** Reuse persisted outputs and observations; unfinished inference alone is retried. */
  private async execute(call: RlmCall): Promise<string> {
    const state = this.state;
    await this.ledger.materialize(state, call);
    if (call.failure !== undefined) { await this.ledger.complete(state, call); throw recordedChildRefusal(call.failure); }
    if (call.result !== undefined) { await this.ledger.complete(state, call); return call.result; }
    let index = 0;
    for (;;) {
      let step = call.steps[index];
      if (step === undefined) {
        step = reserveStep(state, call, this.prompt(call));
        await this.ledger.save(state);
      }
      if (step.response === undefined) {
        if (state.reuse_identity !== undefined && this.model.name !== state.settings.model) throw new RlmReuseError('settings', 'invalid');
        validatePendingStep(state, call, index);
        const response = await this.model.complete({ prompt: step.prompt, max_output_tokens: state.settings.output_tokens, context_tokens: state.settings.context_tokens, parser_version: state.parser_version ?? 1 });
        if (typeof response.text !== 'string' || estimateTokens(response.text) > state.settings.output_tokens * 16 || !Number.isSafeInteger(response.tokens_in) || !Number.isSafeInteger(response.tokens_out) || response.tokens_in < 0 || response.tokens_out < 0) throw new RlmError('model', 'Invalid model response');
        assertLedgerPrivacy(response, this.ledger.workspace, state.settings.key_env);
        settleStep(state, step, response);
        await this.ledger.save(state);
      }
      if (step.observation === undefined) {
        let action: RlmAction | undefined;
        try {
          action = parseAction(step.response!.text, state.parser_version ?? 1);
          if (action.action === 'finish' || action.action === 'answer') completion(state, call, action, index);
          else step.observation = await this.observe(action, call);
        } catch (error) {
          if (!(error instanceof RlmError)) throw error;
          step.observation = { refused: error.code, reason: error.message, ...(error instanceof RlmEvidenceError ? { remedy: error.remedy } : {}) };
          action = undefined;
        }
        if (action?.action === 'finish' || action?.action === 'answer') {
          const answer = completion(state, call, action, index);
          Object.assign(call, { result: answer });
          await this.ledger.save(state);
          await this.ledger.complete(state, call);
          await this.onComplete?.(structuredClone(call));
          return answer;
        }
        await this.ledger.save(state);
      }
      index++;
    }
  }
  /** Run the root and reconcile completed child evidence before returning. */
  async run(): Promise<RlmResult> {
    const release = await this.ledger.lease(this.state.run);
    try {
      this.state = await this.ledger.load(this.state.run);
      let initial: RlmState | undefined;
      try { initial = await this.ledger.load(this.state.run, '1'); }
      catch (error) { if ((error as RlmError).code !== 'invalid') throw error; }
      const selected = this.selection ?? initial?.reuse_selection ?? this.state.reuse_selection;
      if (selected !== undefined && (initial === undefined || reuseTargetContract(initial) !== reuseTargetContract(this.state))) throw new RlmReuseConflict(this.state.run);
      if (initial?.reuse_identity !== undefined && this.state.reuse_identity === undefined) throw new RlmReuseError('original_opt_in');
      if (this.contract !== undefined && this.contract !== reuseTargetContract(this.state)) {
        if (selected !== undefined) throw new RlmReuseConflict(this.state.run);
        throw new RlmReuseError('settings', 'invalid');
      }
      if (selected !== undefined && this.state.reuse === undefined && this.state.calls[0].failure === undefined) {
        if (this.state.calls[0].result === undefined) {
          await applyPendingReuse(this.ledger, this.state);
        } else {
          try { await replayRlm(this.ledger.workspace, this.state.run); }
          catch { throw new RlmReuseError('target_state', 'replay'); }
        }
      }
      for (const call of this.state.calls) for (const step of call.steps) if (step.response !== undefined && step.observation !== undefined) recordedAction(this.state, call, step);
      await this.validateRecorded();
      const legacy = this.state.calls.flatMap(call => call.steps).filter(step => step.response !== undefined && step.settled !== true);
      for (const step of legacy) settleStep(this.state, step, step.response!);
      if (legacy.length > 0) await this.ledger.save(this.state);
      if (this.state.calls[0].result !== undefined && this.state.calls.some(call => call.result === undefined && call.failure === undefined)) throw new RlmError('incomplete', 'Completed run contains an unfinished call');
      for (const call of this.state.calls) if (call.result !== undefined || call.failure !== undefined) await this.ledger.complete(this.state, call);
      await this.execute(this.state.calls[0]);
      return result(this.state);
    } finally { await release(); }
  }
}
/** Prepare a native run before execution so controllers can retain its terminal id and evidence. */
export async function prepareRlmRun(question: string, options: RlmRunOptions, corpus?: Awaited<ReturnType<typeof readCorpus>>, runId?: string) {
  if (runId !== undefined && !/^[A-Za-z0-9_-]{1,160}$/.test(runId)) throw new RlmError('invalid', 'Invalid explicit run id');
  text(question);
  const reuse_identity = options.reuse_identity === undefined ? undefined : parseReuseIdentity(options.reuse_identity);
  const reuse_selection = options.reuse_selection === undefined ? undefined : parseReuseSelection(options.reuse_selection);
  if (reuse_selection !== undefined) {
    parseReuseRequest({ question, scope: options.scope ?? {}, identity: reuse_identity, selection: reuse_selection });
    if (options.source_workspace !== undefined) throw new RlmReuseError('source_workspace');
  }
  const components = options.components === undefined ? undefined : parseComponents(options.components);
  const settings = await readRlmSettings(options.workspace, options.settings);
  if (options.model !== undefined) settings.model = options.model.name;
  const scope = parseFilter(options.scope ?? {});
  corpus ??= await readCorpus(options.source_workspace ?? options.workspace);
  const snapshot = corpus.items.filter(item => matches(item, scope));
  assertLedgerPrivacy({ question, items: snapshot, settings }, options.workspace, settings.key_env);
  const ledger = new RlmLedger(options.workspace, options.author);
  await ledger.registerFields();
  const run = runId ?? await ledger.newRunId();
  const questionItem = options.question_item ?? (await ledger.client.create({ title: 'RLM question', type: 'Task', parent: 'none', tags: 'rlm:question', description: question, allowDuplicate: true })).item.id;
  const state: RlmState = { version: 1, ...RLM_VERSIONS, run, question, settings, scope, snapshot, certificate: corpus.complete_list, ...(options.snapshot_only === true || reuse_identity !== undefined ? { snapshot_only: true } : {}), ...(reuse_identity === undefined ? {} : { reuse_identity }), ...(reuse_selection === undefined ? {} : { reuse_selection }), calls: [], reserved_tokens: 0, ...(components === undefined ? {} : { components }) };
  const slice = emptyRootSlice();
  state.calls.push({ id: run, parent: questionItem, depth: 0, subgoal: question, slice, digest: promptDigest(question, slice, settings), steps: [] });
  const unlock = await ledger.lease(run);
  try { await ledger.materialize(state, state.calls[0]); } finally { await unlock(); }
  return { ledger, engine: new RlmEngine(ledger, state, options.model ?? new HttpModel(settings), options.on_call_complete), run };
}
/** Create and execute a new SDK ledger with the native reservation and recovery loop. */
export async function runRlm(question: string, options: RlmRunOptions): Promise<RlmResult> {
  return (await prepareRlmRun(question, options)).engine.run();
}
/** Recover run state from its ledger and reuse all completed call digests and model steps. */
export async function resumeRlm(workspace: string, run: string, model?: RlmModel, author?: string): Promise<RlmResult> {
  const ledger = new RlmLedger(workspace, author);
  const state = await ledger.load(run);
  if (model !== undefined && model.name !== state.settings.model) throw new RlmError('invalid', 'Resume model must match recorded model');
  return new RlmEngine(ledger, state, model ?? new HttpModel(state.settings)).run();
}
/** Replay the recorded call graph and actions, checking every child result and final answer byte-for-byte. */
export async function replayRlm(workspace: string, run: string): Promise<RlmResult> {
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(run);
  if (state.reuse !== undefined) { await validateReuseState(workspace, state); return result(state); }
  const visited = new Set<string>();
  /** Follow recorded spawn edges and finish actions without executing a model or writing the tracker. */
  async function replay(call: RlmCall): Promise<string | undefined> {
    visited.add(call.id);
    for (const step of call.steps) {
      if (step.response === undefined) continue;
      const action = recordedAction(state, call, step);
      if (action === undefined) continue;
      const refused = step.observation !== undefined && typeof step.observation === 'object' && step.observation !== null && 'refused' in step.observation;
      if (refused) {
        if (action.action === 'spawn') {
          let slice: RlmSlice;
          try { slice = resolveSlice(state, call, action.slice); }
          catch { continue; }
          const child = state.calls.find(child => child.parent === call.id && child.digest === promptDigest(action.subgoal, slice, state.settings));
          if (child !== undefined) await replay(child);
        }
        continue;
      }
      if (action.action === 'spawn') {
        if (typeof step.observation !== 'object' || step.observation === null || typeof (step.observation as { result?: unknown }).result !== 'string') throw new RlmError('replay', 'Recorded spawn step has no completed observation');
        const child = state.calls.find(child => child.parent === call.id && child.digest === promptDigest(action.subgoal, resolveSlice(state, call, action.slice), state.settings));
        if (child === undefined || await replay(child) !== (step.observation as { result: string }).result) throw new RlmError('replay', 'Recorded child result differs');
      }
      if (action.action !== 'finish' && action.action !== 'answer' && action.action !== 'spawn') {
        await recordedRead(workspace, state, call, call.steps.indexOf(step), action, step.observation);
      }
      if (action.action === 'finish' || action.action === 'answer') {
        const answer = completion(state, call, action, call.steps.indexOf(step));
        if (answer !== call.result) throw new RlmError('replay', 'Recorded answer differs');
        return answer;
      }
    }
    if (call.failure !== undefined) return undefined;
    throw new RlmError('replay', 'Run has no completed finish action');
  }
  await replay(state.calls[0]);
  if (visited.size !== state.calls.length) throw new RlmError('replay', 'Recorded call graph has unreachable calls');
  if (state.components !== undefined || state.reuse_identity !== undefined) await new RlmEngine(ledger, state, new HttpModel(state.settings)).validateRecorded();
  return result(state);
}
/** Read a compact, ordered call tree, retaining the full checkpoint only when explicitly requested. */
export async function treeRlm(workspace: string, run: string, full = false): Promise<Record<string, unknown>> {
  const state = await new RlmLedger(workspace).load(run);
  return full ? { state, token_usage: 'reported_or_estimated' } : { run, token_usage: 'reported_or_estimated', calls: state.calls.map(call => ({ id: call.id, parent: call.parent, depth: call.depth, status: call.failure !== undefined ? 'failed' : call.result === undefined ? 'in_progress' : 'closed', reserved_tokens: call.steps.reduce((sum, step) => sum + step.reserved, 0), used_tokens: call.steps.reduce((sum, step) => sum + (step.response?.tokens_in ?? 0) + (step.response?.tokens_out ?? 0), 0), result: (call.result ?? '').replace(/\s+/g, ' ').slice(0, 100) })) };
}

/** Read-only certified component report; validation performs zero model calls and no tracker writes. */
export async function evidenceRlm(workspace: string, run: string): Promise<RlmEvidenceReport> {
  const result = await replayRlm(workspace, run);
  if (result.components === undefined) throw new RlmEvidenceError('Run has no declared components', 'Start a new run with --components to obtain evidence coverage');
  return { run, verified: true, total: result.components.length, supported: result.components.filter(entry => entry.status === 'supported').length, unsupported: result.components.filter(entry => entry.status === 'unsupported').length, unknown: result.components.filter(entry => entry.status === 'unknown').length, components: result.components };
}
