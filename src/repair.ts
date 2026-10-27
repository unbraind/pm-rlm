import { getHistoryPath, hashDocument, hashHistoryStream, locateItem, mutateItemWithHistoryContext, normalizeItemId, readHistoryEntries, readLocatedItem, readSettings, resolveItemTypeRegistry, resolveTransactionSchema, verifyHistoryEntries } from '@unbrained/pm-cli/sdk';
import { blobDigest } from './blobs.ts';
import { emptyRootSlice, initialRlmCharge, prepareRlmRun, replayRlm, RlmEngine, RLM_VERSIONS } from './engine.ts';
import { HttpModel } from './adapters.ts';
import { readCorpus } from './environment.ts';
import { assertLedgerPrivacy, RlmError } from './errors.ts';
import { promptDigest, RlmLedger } from './ledger.ts';
import { reuseTargetContract } from './reuse.ts';
import { parseRepairCheckpoint, parseRepairRequest, repairOrder, RlmRepairError, validateRepairResult } from './repair-contract.ts';
import type { RlmRepairCheckpoint, RlmRepairComponent, RlmRepairOptions, RlmRepairPart, RlmRepairRequest, RlmRepairResult, RlmRepairSkipped } from './repair-contract.ts';
import type { RlmAnswerComponent, RlmItem, RlmSettings, RlmState } from './types.ts';

const FOREIGN: RlmRepairSkipped = { status: 'skipped', reason: 'foreign', remedy: 'Select a native pm-rlm evidence run or repair controller in this tracker' };
const MARKER = 'RLM repair v1\n';
/** Per-component native provenance survives any number of explicit fresh-budget continuations. */
interface RepairSource {
  state: RlmState; answers: RlmAnswerComponent[]; revision: string;
  proofs: Map<string, { run: string; state: RlmState }>;
  parts?: RlmRepairPart[];
}
/** Native item history is the revision authority even when an older checkpoint is imported. */
interface RepairWriteHead { description: string; length: number; digest: string }
/** Controller-specific consent stays bounded even for long native identifiers. */
function repairIdentity(run: string) { return { tool_policy: 'repair-v1', model_policy: 'original-model', consent: blobDigest(run) }; }
/** Compare settings through the native canonical context contract, allowing only allocated limits. */
function childPolicy(state: RlmState, settings: RlmSettings): boolean {
  return state.settings.max_calls <= settings.max_calls && reuseTargetContract(state) === reuseTargetContract({ ...state, settings: { ...settings, budget_tokens: state.settings.budget_tokens, max_calls: state.settings.max_calls } });
}
/** Use the same native ownership markers for planning, execution and continuation. */
function ownedCall(item: RlmItem | undefined, id: string, parent?: string): boolean { return item?.rlm_run === id && item.tags.includes('rlm:call') && (parent === undefined || item.parent === parent); }
/** A tag alone cannot grant a foreign row authority as a repair journal. */
function ownedRepair(item: RlmItem | undefined): boolean { return item?.tags.includes('rlm:repair') === true && item.description?.startsWith(MARKER) === true; }
/** Progress may replay, but declarations, source coordinates and initial scheduling decisions cannot change. */
async function readCheckpoint(ledger: RlmLedger, run: string, description: string): Promise<RlmRepairCheckpoint> {
  const checkpoint = parseRepairCheckpoint(JSON.parse(description.slice(MARKER.length)));
  const initialNative = (await ledger.client.get(run, { at: '1', fields: 'description' })).item;
  const initial = parseRepairCheckpoint(JSON.parse(initialNative.description!.slice(MARKER.length)));
  /** Select only producer-owned immutable intent; current target progress is reconstructed separately. */
  const intent = (value: RlmRepairCheckpoint) => JSON.stringify([value.request, value.source_mode, value.source_revision, value.revisions, value.targets.map(target => [target.component, target.kind])]);
  if (intent(initial) !== intent(checkpoint)) throw new RlmRepairError('evidence');
  return checkpoint;
}
/** Read complete native rows; an unrelated malformed row cannot poison another run. */
async function row(ledger: RlmLedger, id: string): Promise<(RlmItem & { body: string }) | undefined> {
  const settings = await readSettings(ledger.workspace);
  const schema = await resolveTransactionSchema(ledger.workspace, settings);
  const registry = resolveItemTypeRegistry({ ...settings, item_types: { definitions: [...settings.item_types.definitions, ...schema.typeDefinitionsFromFile] } });
  const located = await locateItem(ledger.workspace, id, settings.id_prefix, settings.item_format, registry.type_to_folder);
  if (located === null) return undefined;
  const { document } = await readLocatedItem(located, { schema: schema.schema });
  return { ...document.metadata, body: document.body };
}
/** Bind current SDK state and its growing verified history coordinate, including ABA edits. */
async function revision(ledger: RlmLedger, id: string): Promise<string> {
  const current = await row(ledger, id);
  if (current === undefined) return blobDigest('missing');
  const history = await readHistoryEntries(getHistoryPath(ledger.workspace, id), id);
  const { body, ...metadata } = current;
  if (history.length === 0 || !verifyHistoryEntries(history).ok) throw new RlmRepairError('incomplete');
  return blobDigest(JSON.stringify([hashDocument({ metadata, body }), hashHistoryStream(history)]));
}
/** Verify source provenance using the established replay engine, under its existing run lease. */
async function source(ledger: RlmLedger, run: string, options: RlmRepairOptions, ancestors = new Set<string>()): Promise<RepairSource> {
  if (ancestors.has(run) || ancestors.size >= 16) throw new RlmRepairError('evidence');
  ancestors = new Set([...ancestors, run]);
  const unlock = await ledger.lease(run);
  try {
    const expected = await revision(ledger, run);
    await boundary(options, 'source:read', run);
    const native = await row(ledger, run);
    if (ownedRepair(native)) {
      const checkpoint = await readCheckpoint(ledger, run, native!.description!);
      const result = await priorSource(ledger, run, checkpoint, options, ancestors);
      if (await revision(ledger, run) !== expected) throw new RlmRepairError('busy');
      return { ...result, revision: expected };
    }
    const state = await ledger.load(run);
    const answer = await replayRlm(ledger.workspace, run);
    if (answer.components === undefined) throw new RlmRepairError('evidence');
    let initial: RlmState | undefined;
    try { initial = await ledger.load(run, '1'); } catch (error) { if (!(error instanceof RlmError) || error.code !== 'invalid') throw error; }
    if (initial !== undefined && reuseTargetContract(initial) !== reuseTargetContract(state)) throw new RlmRepairError('evidence');
    if (await revision(ledger, run) !== expected) throw new RlmRepairError('busy');
    return { state, answers: answer.components, revision: expected, proofs: new Map(answer.components.map(part => [part.component, { run, state }])) };
  } finally { await unlock(); }
}
/** Bind component execution and continuation to one producer-owned prompt format. */
function repairQuestion(question: string, part: RlmRepairPart, dependencies: RlmRepairComponent[]): string {
  return JSON.stringify({ question, part: { name: part.name, question: part.question }, dependencies });
}
/** Read a stopped repair without inference or writes; each bad child becomes only its named gap. */
async function priorSource(ledger: RlmLedger, run: string, checkpoint: RlmRepairCheckpoint, options: RlmRepairOptions, ancestors: Set<string>): Promise<RepairSource> {
  if (checkpoint.targets.some(target => target.phase === 'pending' || target.phase === 'running')) throw new RlmRepairError('evidence');
  if ((checkpoint.source_mode === 'external') !== (options.source_workspace !== undefined)) throw new RlmRepairError('scope');
  const base = await source(ledger, checkpoint.request.source, options, ancestors);
  if (base.revision !== checkpoint.source_revision) throw new RlmRepairError('evidence');
  if (JSON.stringify(base.answers.map(part => part.component)) !== JSON.stringify(checkpoint.request.parts.map(part => part.name))) throw new RlmRepairError('evidence');
  const sourceLedger = options.source_workspace === undefined ? ledger : new RlmLedger(options.source_workspace);
  const answers = new Map<string, RlmAnswerComponent>();
  const proofs = new Map(base.proofs);
  for (const part of repairOrder(checkpoint.request.parts)) {
    const target = checkpoint.targets.find(target => target.component === part.name)!;
    let answer = base.answers.find(answer => answer.component === part.name)!;
    if (target.phase !== 'complete' || await changedSources(sourceLedger, checkpoint, part.sources) || part.depends_on.some(name => answers.get(name)!.status !== 'supported')) answer = gap(part.name, 'prior_gap');
    else if (target.kind === 'repair') {
      try {
        const native = await row(ledger, target.child);
        if (!ownedCall(native, target.child, run)) throw new RlmRepairError('evidence');
        const state = await childCheckpoint(ledger, target.child);
        if (state === undefined || state.calls[0].parent !== run || JSON.stringify(state.scope) !== JSON.stringify({ ids: part.sources })) throw new RlmRepairError('evidence');
        const dependencies = part.depends_on.map((name): RlmRepairComponent => ({ ...answers.get(name)!, run: proofs.get(name)!.run, disposition: checkpoint.targets.find(target => target.component === name)!.kind === 'reuse' ? 'reused' : 'repaired', remedy: '' }));
        if (state.calls[0].subgoal !== repairQuestion(base.state.question, part, dependencies) || !childPolicy(state, base.state.settings) || state.settings.budget_tokens !== target.allowance || target.allowance > Math.min(checkpoint.request.budget_tokens, base.state.settings.budget_tokens)) throw new RlmRepairError('evidence');
        const completed = await replayRlm(ledger.workspace, target.child);
        if (completed.components?.length !== 1 || completed.components[0].component !== part.name) throw new RlmRepairError('evidence');
        answer = completed.components[0]; proofs.set(part.name, { run: target.child, state });
      } catch { answer = gap(part.name, 'prior_child_unavailable'); }
    }
    answers.set(part.name, answer);
  }
  return { state: base.state, answers: checkpoint.request.parts.map(part => answers.get(part.name)!), proofs, revision: '', parts: checkpoint.request.parts };
}
/** Trace boundaries after durable transitions, allowing crash injection without replacing SDK behavior. */
async function boundary(options: RlmRepairOptions, name: string, run: string): Promise<void> { await options.on_transition?.(name, run); }
/** Read the SDK's append-only coordinate without deriving a revision from content alone. */
async function itemHead(ledger: RlmLedger, run: string): Promise<{ length: number; digest: string }> {
  const entries = await readHistoryEntries(getHistoryPath(ledger.workspace, run), run);
  if (entries.length === 0 || !verifyHistoryEntries(entries).ok) throw new RlmRepairError('incomplete');
  return { length: entries.length, digest: hashHistoryStream(entries) };
}
/** Publish under the SDK item lock; operation identity binds the actual target history revision. */
async function save(ledger: RlmLedger, run: string, checkpoint: RlmRepairCheckpoint, expected: RepairWriteHead, options: RlmRepairOptions): Promise<RepairWriteHead> {
  checkpoint.revision++;
  const description = MARKER + JSON.stringify(parseRepairCheckpoint(checkpoint));
  const settings = await readSettings(ledger.workspace);
  const schema = await resolveTransactionSchema(ledger.workspace, settings);
  const hydrated = { ...settings, schema: schema.schema, item_types: { definitions: [...settings.item_types.definitions, ...schema.typeDefinitionsFromFile] } };
  await boundary(options, 'journal:before', run);
  await mutateItemWithHistoryContext({ pmRoot: ledger.workspace, id: run, settings: hydrated, typeToFolder: resolveItemTypeRegistry(hydrated).type_to_folder, op: 'update', author: options.author ?? 'pm-rlm', message: 'Checkpoint evidence-directed repair', historyContext: { operation_id: `repair-${blobDigest(JSON.stringify([run, expected.digest]))}`, expected_history_length: expected.length },
    mutate: async document => {
      await boundary(options, 'journal:locked', run);
      const current = await itemHead(ledger, run);
      await boundary(options, 'journal:ready', run);
      if (!ownedRepair(document.metadata) || document.metadata.description !== expected.description || current.length !== expected.length || current.digest !== expected.digest) throw new RlmRepairError('busy');
      document.metadata.description = description;
      return { changedFields: ['description'] };
    },
  });
  await boundary(options, 'journal:written', run);
  const current = await itemHead(ledger, run);
  if (current.length !== expected.length + 1) throw new RlmRepairError('busy');
  await boundary(options, 'journal:applied', run);
  return { description, ...current };
}
/** Re-read each declared source through the SDK rather than replaying a frozen plan. */
async function changedSources(ledger: RlmLedger, checkpoint: RlmRepairCheckpoint, ids: string[]): Promise<boolean> {
  for (const id of ids) if (await revision(ledger, id) !== checkpoint.revisions.find(entry => entry.id === id)?.revision) return true;
  return false;
}
/** One damaged native child contributes a named gap rather than invalidating unrelated answers. */
async function childCheckpoint(ledger: RlmLedger, run: string): Promise<RlmState | undefined> {
  try {
    const current = await ledger.load(run);
    const initial = await ledger.load(run, '1');
    if (initial.calls[0].parent === undefined || current.reuse !== undefined || initial.reuse !== undefined) return undefined;
    const slice = emptyRootSlice();
    const expected: RlmState = { ...initial, ...RLM_VERSIONS, question: initial.calls[0].subgoal, snapshot_only: true, reuse_selection: undefined, reuse_identity: repairIdentity(initial.calls[0].parent), calls: [{ ...initial.calls[0], id: run, depth: 0, slice, digest: promptDigest(initial.calls[0].subgoal, slice, initial.settings) }] };
    if (reuseTargetContract(initial) !== reuseTargetContract(expected) || reuseTargetContract(current) !== reuseTargetContract(initial)) return undefined;
    await new RlmEngine(ledger, current, new HttpModel(current.settings), undefined, true).validateRecorded();
    return current;
  } catch { return undefined; }
}
/** Construct gaps without erasing any original component name or inventing evidence. */
function gap(component: string, reason: string): RlmRepairComponent {
  return { component, status: 'unsupported', answer: '', witnesses: [], reason, run: '', disposition: 'gap', remedy: 'Start a fresh repair with current sources and sufficient budget; resolve named prerequisites first' };
}
/** Initial invalidation includes explicit gaps, changed sources, and their transitive dependents. */
async function plan(request: RlmRepairRequest, origin: Awaited<ReturnType<typeof source>>, sourceLedger: RlmLedger, external: boolean): Promise<RlmRepairCheckpoint> {
  if (JSON.stringify(origin.answers.map(answer => answer.component)) !== JSON.stringify(request.parts.map(part => part.name))) throw new RlmRepairError();
  const snapshots = new Map(origin.state.snapshot.map(item => [item.id, item]));
  if (request.parts.some(part => part.sources.some(id => !snapshots.has(id)))) throw new RlmRepairError('scope');
  const revisions = [];
  for (const id of new Set(request.parts.flatMap(part => part.sources))) revisions.push({ id, revision: await revision(sourceLedger, id) });
  const live = (await readCorpus(sourceLedger.workspace)).items;
  const current = new Map(live.map(item => [item.id, item]));
  const invalid = new Set<string>();
  const answers = new Map(origin.answers.map(answer => [answer.component, answer]));
  for (const part of repairOrder(request.parts)) {
    const answer = answers.get(part.name)!;
    const proof = origin.proofs.get(part.name)!;
    for (const reference of answer.witnesses) {
      const observation = proof.state.calls[0].steps[reference.step].observation as { data: { id: string } };
      if (!part.sources.includes(observation.data.id)) throw new RlmRepairError('scope');
    }
    if (answer.status !== 'supported' || part.sources.some(id => JSON.stringify(proof.state.snapshot.find(item => item.id === id)) !== JSON.stringify(current.get(id))) || part.depends_on.some(name => invalid.has(name))) invalid.add(part.name);
  }
  return parseRepairCheckpoint({ version: 'repair-v1', revision: 0, request, source_mode: external ? 'external' : 'tracker', source_revision: origin.revision, revisions, targets: request.parts.map(part => ({ component: part.name, kind: invalid.has(part.name) ? 'repair' : 'reuse', phase: 'pending', child: '', allowance: 0, reason: '' })) });
}
/** Create a fresh repair intent before inference; no source item is mutated. */
async function start(input: unknown, options: RlmRepairOptions): Promise<RlmRepairResult | RlmRepairSkipped> {
  const request = parseRepairRequest(input);
  const ledger = new RlmLedger(options.workspace, options.author);
  const prefix = (await readSettings(options.workspace)).id_prefix;
  const sourcePrefix = (await readSettings(options.source_workspace ?? options.workspace)).id_prefix;
  request.source = normalizeItemId(request.source, prefix);
  for (const part of request.parts) part.sources = part.sources.map(id => normalizeItemId(id, sourcePrefix));
  repairOrder(request.parts);
  const native = await row(ledger, request.source);
  if (!ownedCall(native, request.source) && !ownedRepair(native)) return { ...FOREIGN };
  const origin = await source(ledger, request.source, options);
  if (origin.parts !== undefined && JSON.stringify(origin.parts) !== JSON.stringify(request.parts)) throw new RlmRepairError();
  if (options.model !== undefined && options.model.name !== origin.state.settings.model) throw new RlmRepairError();
  const checkpoint = await plan(request, origin, options.source_workspace === undefined ? ledger : new RlmLedger(options.source_workspace), options.source_workspace !== undefined);
  assertLedgerPrivacy(checkpoint, options.workspace, origin.state.settings.key_env);
  const run = (await ledger.client.create({ type: 'Task', title: 'RLM evidence-directed repair', parent: 'none', tags: 'rlm:question,rlm:repair', description: MARKER + JSON.stringify(checkpoint), allowDuplicate: true })).item.id;
  await boundary(options, 'created', run);
  return resumeRepairRlm(run, options);
}
/** Schedule only declared gaps and invalidated dependents within a separate explicit budget. */
export async function repairRlm(request: RlmRepairRequest, options: RlmRepairOptions): Promise<RlmRepairResult | RlmRepairSkipped> {
  try { return await start(request, options); }
  catch (error) { if (error instanceof RlmRepairError) throw error; throw new RlmRepairError(error instanceof RlmError ? error.code : 'incomplete'); }
}
/** Execute a journal while holding its run lease; all current state is read after acquisition. */
async function execute(run: string, options: RlmRepairOptions): Promise<RlmRepairResult | RlmRepairSkipped> {
  const ledger = new RlmLedger(options.workspace, options.author);
  run = normalizeItemId(run, (await readSettings(options.workspace)).id_prefix);
  const unlock = await ledger.lease(run);
  try {
    await boundary(options, 'leased', run);
    let native = await row(ledger, run);
    if (!ownedRepair(native)) return { ...FOREIGN };
    const initialHead = await itemHead(ledger, run);
    await boundary(options, 'head', run);
    native = await row(ledger, run);
    if (!ownedRepair(native)) return { ...FOREIGN };
    await boundary(options, 'native', run);
    if ((await itemHead(ledger, run)).digest !== initialHead.digest) throw new RlmRepairError('busy');
    const checkpoint = await readCheckpoint(ledger, run, native!.description!);
    await boundary(options, 'read', run);
    if ((checkpoint.source_mode === 'external') !== (options.source_workspace !== undefined)) throw new RlmRepairError('scope');
    const sourceLedger = options.source_workspace === undefined ? ledger : new RlmLedger(options.source_workspace);
    const origin = await source(ledger, checkpoint.request.source, options);
    if (origin.revision !== checkpoint.source_revision) throw new RlmRepairError('evidence');
    if (options.model !== undefined && options.model.name !== origin.state.settings.model) throw new RlmRepairError();
    await boundary(options, 'validated', run);
    const limit = Math.min(checkpoint.request.budget_tokens, origin.state.settings.budget_tokens);
    const outputs = new Map<string, RlmRepairComponent>();
    const originals = new Map(origin.answers.map(answer => [answer.component, answer]));
    let charged = 0; let calls = 0; let expected: RepairWriteHead = { description: native!.description!, ...initialHead }; let uncertain = false;
    for (const part of repairOrder(checkpoint.request.parts)) {
      const target = checkpoint.targets.find(target => target.component === part.name)!;
      const previous = JSON.stringify(target);
      let accountedTokens = 0; let accountedCalls = 0;
      await boundary(options, `before:${part.name}`, run);
      const changed = await changedSources(sourceLedger, checkpoint, part.sources);
      const blocked = part.depends_on.some(name => outputs.get(name)!.status !== 'supported');
      const childRow = target.child === '' ? undefined : await row(ledger, target.child);
      const foreign = childRow !== undefined && !ownedCall(childRow, target.child, run);
      if (foreign) { target.phase = 'skipped'; target.reason = 'foreign'; charged = limit; uncertain = true; }
      if (target.child !== '' && childRow === undefined && (await readHistoryEntries(getHistoryPath(ledger.workspace, target.child), target.child)).length > 0) { target.phase = 'skipped'; target.reason = 'missing_child'; charged = limit; uncertain = true; }
      if (childRow !== undefined && !foreign) {
        const state = await childCheckpoint(ledger, target.child);
        if (state === undefined || state.calls[0].parent !== run || state.components?.length !== 1 || state.components[0] !== part.name || state.settings.budget_tokens !== target.allowance || target.allowance > (uncertain ? limit : limit - charged) || state.settings.max_calls > origin.state.settings.max_calls - (uncertain ? 0 : calls) || state.reserved_tokens > target.allowance || state.calls.length > state.settings.max_calls || !childPolicy(state, origin.state.settings)) { target.phase = 'skipped'; target.reason = 'child_evidence'; charged = limit; uncertain = true; }
        else {
          if (!uncertain) { accountedTokens = state.reserved_tokens; charged += accountedTokens; }
          accountedCalls = state.calls.length; calls += accountedCalls;
          if (state.calls[0].result !== undefined && !changed && !blocked) { target.phase = 'complete'; target.reason = ''; }
          if (uncertain && state.calls[0].result === undefined) { target.phase = 'skipped'; target.reason = 'budget'; }
        }
      }
      if (changed || blocked || target.phase === 'skipped') {
        target.phase = 'skipped'; target.reason = changed ? 'source_changed' : blocked ? 'dependency_gap' : target.reason;
        outputs.set(part.name, gap(part.name, target.reason));
      } else if (target.kind === 'reuse') {
        outputs.set(part.name, { ...originals.get(part.name)!, run: origin.proofs.get(part.name)!.run, disposition: 'reused', remedy: '' });
      } else if (target.phase === 'gap') outputs.set(part.name, gap(part.name, target.reason));
      else {
        const question = repairQuestion(origin.state.question, part, part.depends_on.map(name => outputs.get(name)!));
        const settings = { ...origin.state.settings, budget_tokens: limit - charged, max_calls: origin.state.settings.max_calls - calls };
        if (target.child === '') {
          try {
            if (settings.max_calls <= 0) throw new RlmRepairError('calls');
            initialRlmCharge(question, [part.name], settings);
            target.child = `${run}-r${checkpoint.targets.indexOf(target)}`; target.allowance = settings.budget_tokens; target.phase = 'running';
            expected = await save(ledger, run, checkpoint, expected, options);
            await boundary(options, `intent:${part.name}`, run);
          } catch (error) {
            if (!(error instanceof RlmError) || !['budget', 'calls'].includes(error.code)) throw error;
            target.phase = 'gap'; target.reason = error.code;
          }
        }
        if (target.phase === 'gap') outputs.set(part.name, gap(part.name, target.reason));
        else {
          const existing = await row(ledger, target.child);
          if (existing !== undefined && !ownedCall(existing, target.child, run)) {
            target.phase = 'skipped'; target.reason = 'foreign'; charged = limit; uncertain = true; outputs.set(part.name, gap(part.name, target.reason));
          } else if (await changedSources(sourceLedger, checkpoint, part.sources)) {
            target.phase = 'skipped'; target.reason = 'source_changed'; outputs.set(part.name, gap(part.name, target.reason));
          } else {
            if (existing === undefined) await prepareRlmRun(question, { workspace: options.workspace, author: options.author, source_workspace: options.source_workspace, model: options.model, snapshot_only: true, reuse_identity: repairIdentity(run), question_item: run, scope: { ids: part.sources }, components: [part.name], settings }, undefined, target.child);
            await boundary(options, `prepared:${part.name}`, run);
            const before = await childCheckpoint(ledger, target.child);
            const live = (await readCorpus(sourceLedger.workspace)).items.filter(item => part.sources.includes(item.id));
            const changedBefore = await changedSources(sourceLedger, checkpoint, part.sources);
            if (before === undefined || (!changedBefore && (before.settings.budget_tokens !== target.allowance || target.allowance > (uncertain ? limit : limit - charged + accountedTokens) || before.settings.max_calls > origin.state.settings.max_calls - (uncertain ? 0 : calls - accountedCalls) || before.reserved_tokens > target.allowance || before.calls.length > before.settings.max_calls || before.calls[0].parent !== run || before.components?.length !== 1 || before.components[0] !== part.name || before.calls[0].subgoal !== question || JSON.stringify(before.scope) !== JSON.stringify({ ids: part.sources }) || JSON.stringify(before.snapshot) !== JSON.stringify(live) || !childPolicy(before, origin.state.settings)))) {
              target.phase = 'skipped'; target.reason = 'child_evidence'; charged = limit; uncertain = true; outputs.set(part.name, gap(part.name, target.reason));
            } else {
            let answer: RlmAnswerComponent | undefined;
            let lostOwnership = false;
            if (changedBefore) target.reason = 'source_changed';
            else try { answer = (await new RlmEngine(ledger, before, options.model ?? new HttpModel(before.settings), undefined, true).run()).components![0]; }
            catch (error) {
              if (!(error instanceof RlmError)) throw error;
              lostOwnership = !ownedCall(await row(ledger, target.child), target.child, run);
              if (!lostOwnership && error.code === 'busy') throw error;
              target.reason = lostOwnership ? 'foreign' : error.code;
            }
            await boundary(options, `executed:${part.name}`, run);
            if (lostOwnership) { target.phase = 'skipped'; charged = limit; uncertain = true; outputs.set(part.name, gap(part.name, target.reason)); }
            else {
              const after = await childCheckpoint(ledger, target.child);
              if (after === undefined || after.reserved_tokens > target.allowance || after.calls.length > after.settings.max_calls) { target.phase = 'skipped'; target.reason = 'child_evidence'; charged = limit; uncertain = true; outputs.set(part.name, gap(part.name, target.reason)); }
              else {
              if (!uncertain) charged += after.reserved_tokens - accountedTokens;
              calls += after.calls.length - accountedCalls;
              target.phase = answer?.status === 'supported' ? 'complete' : 'gap';
              if (target.phase === 'gap' && target.reason === '') target.reason = 'evidence';
              outputs.set(part.name, answer?.status === 'supported' ? { ...answer, run: target.child, disposition: 'repaired', remedy: '' } : gap(part.name, target.reason));
              }
            }
            }
          }
        }
      }
      if (target.kind === 'reuse' && target.phase === 'pending') target.phase = 'complete';
      if (await changedSources(sourceLedger, checkpoint, part.sources)) { target.phase = 'skipped'; target.reason = 'source_changed'; outputs.set(part.name, gap(part.name, target.reason)); }
      if (JSON.stringify(target) !== previous) expected = await save(ledger, run, checkpoint, expected, options);
      await boundary(options, `saved:${part.name}`, run);
    }
    for (const part of repairOrder(checkpoint.request.parts)) if (outputs.get(part.name)!.status === 'supported' && (await changedSources(sourceLedger, checkpoint, part.sources) || part.depends_on.some(name => outputs.get(name)!.status !== 'supported'))) outputs.set(part.name, gap(part.name, 'source_or_dependency_changed'));
    const components = checkpoint.request.parts.map(part => {
      const answer = outputs.get(part.name)!;
      const target = checkpoint.targets.find(target => target.component === part.name)!;
      return answer.disposition === 'gap' ? { ...answer, run: target.child || origin.proofs.get(part.name)!.run } : answer;
    });
    const gaps = components.filter(part => part.status !== 'supported').map(part => part.component);
    if ((await row(ledger, run))?.description !== expected.description || (await itemHead(ledger, run)).digest !== expected.digest) throw new RlmRepairError('busy');
    if (await revision(ledger, checkpoint.request.source) !== checkpoint.source_revision) throw new RlmRepairError('evidence');
    return validateRepairResult({ run, source: checkpoint.request.source, status: gaps.length === 0 ? 'complete' : 'partial', budget: { limit, charged, remaining: limit - charged }, calls, scheduled: checkpoint.targets.filter(target => target.kind === 'repair').map(target => target.component), reused: components.filter(part => part.disposition === 'reused').length, gaps, components });
  } finally {
    try { await boundary(options, 'releasing', run); } finally { await unlock(); }
    await boundary(options, 'released', run);
  }
}
/** Recover pending child intents and validate current revisions before any further model execution. */
export async function resumeRepairRlm(run: string, options: RlmRepairOptions): Promise<RlmRepairResult | RlmRepairSkipped> {
  try { return await execute(run, options); }
  catch (error) { if (error instanceof RlmRepairError) throw error; throw new RlmRepairError(error instanceof RlmError ? error.code : 'incomplete'); }
}
/** Compact output retains every component identity, gap and evidence origin without answer payloads. */
export function compactRepairResult(result: RlmRepairResult | RlmRepairSkipped): Record<string, unknown> {
  if (result.status === 'skipped') return { ...result };
  validateRepairResult(result);
  return { ...result, components: result.components.map(({ answer, witnesses: _witnesses, ...part }) => ({ ...part, answer_digest: blobDigest(answer), answer_bytes: Buffer.byteLength(answer) })) };
}
