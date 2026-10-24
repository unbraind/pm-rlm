# Checkpoint write audit

A writable state must be loaded by the same ledger instance after acquiring the run lease. `load` captures the lease token before its first asynchronous read, then records that token and the exact persisted manifest as a content revision. `save`, existing-call materialization and completion refuse snapshots from outside that lease, a released lease, a different ledger, or a superseded revision. This provenance stays outside serialized state. Observational load, replay, tree and evidence operations remain lease-free and never produce writable state for a later lease.

Checkpoint publication uses the pinned pm SDK's `commitItemMutations` with `match: { key: 'rlm_state', value: expected }`. The SDK rechecks that revision under the item lock before updating; a conflicting write between the package comparison and publication is refused. Per-call usage updates also use native lock-held matching against the row's `updated_at`. Native SDK updates retain append-only history and transaction journals. Run and blob-store leases continue using the existing SDK lock-backed process ownership, with no new locking implementation.

| Write path | Read and exclusion | Publication guard |
| --- | --- | --- |
| New root (`prepareRlmRun` / `materialize`) | Acquire run lease; construct a new run, never overwrite an existing state | SDK create refuses an existing deterministic ID; an existing root requires lease-scoped provenance |
| Child reservation / digest allocation (`spawn`) | Engine owns run lease; state loaded inside `run`, or supplied by an embedded caller that holds the lease | `save` checks provenance plus native manifest match; materialization creates only a missing ID |
| Model-step reservation, response settlement and observation charging (`execute`) | Same engine lease and recovered state for the entire recursive execution | Every checkpoint passes the same native manifest match; response and released reservation publish together |
| Finish / answer success and nested failure / completion-hook refusal | Same engine critical section; save precedes terminal evidence | Checkpoint CAS; completion reloads canonical saved calls and uses row CAS for usage |
| Resume and legacy budget settlement (`run`) | Reload after acquiring lease, then validate before changing state | Checkpoint CAS; completed calls reuse recorded inference |
| Reconciliation failure cleanup | `failUnfinished` acquires lease before load | Preserve result/failure calls, return skipped IDs, save only if unfinished calls changed; CAS and guarded terminal evidence |
| Adaptive failure cleanup | Same shared `failUnfinished` critical section | Never replace a completed root with a refusal; skipped IDs recorded in parent comments |
| Parent adaptive / paired receipts | New workflow-owned item with SDK claim; append new comments from the local execution receipt | SDK audited append and close/release primitives; no prior checkpoint is read and replaced |
| Replay / tree / evidence | Certified read only | No checkpoint, step, usage or budget writes |
| Cancel / abort | There is no cancellation mutation API; inference interruption leaves the last checkpoint | Resume reloads within its lease; HTTP response cancellation only closes transport |
| Settings | SDK `mutateWorkspaceSettings` callback reads current settings within its transaction | Native audited settings transaction |
| Blob publication / GC | Independent immutable payloads; shared storage lease serializes publication and collection | Content digests verified on reuse; atomic file creation; current and historical manifests pin roots |

Direct embedded `spawn`, `save`, `materialize` of an existing call, and `complete` require a caller-held run lease and a state loaded inside it. A refusal requires reacquisition and a fresh load; the package never retries a stale state as a blind overwrite. Corruption tests deliberately use `replaceCheckpointFixture` to install arbitrary evidence through the real SDK, including invalid checkpoints that the production API must refuse.

The non-git regressions in `test/checkpoint-concurrency.test.ts` are:

- `cleanup resume interleavings preserve completed answer steps and token charges at every boundary`: before/after lease, load, complete and unlock. Resume completes the pending run immediately before lease acquisition; at owned-lease boundaries a second resume is refused. Completed answer bytes, full steps, charges, materialized counters and skipped IDs are checked on the same tracker.
- `cleanup save boundaries exclude competing resume and report already terminal nested calls`: before/after save with an unfinished root and a completed nested call. The nested result, all transcripts and total charges survive; cleanup reports the skipped child, then reports both calls skipped on retry.
- `ledger refuses pre-lease reads expired leases and superseded checkpoint writes`: save, existing materialization and completion reject stale revisions without changing current state.
- `completion materialization uses durable answer and usage and refuses nonterminal calls`: uncommitted caller mutations cannot supply answer comments or usage totals.
- `SDK compare-and-set refuses a checkpoint changed between comparison and publication`: inject a real competing SDK update after encoding, then require native lock-held refusal and exact competing-state preservation.

`test/reconcile-revert.ts` reverts only each fixed invariant, demands a targeted assertion failure, and restores exact source bytes. It covers lease-before-read cleanup, terminal preservation, the SDK match guard and canonical completion counters and read-start provenance alongside the existing paired evidence proofs.

Two further non-git regressions cover reads begun before lease acquisition
(`load captures lease provenance before its first asynchronous read`) and stale
release callbacks plus replaced/missing/corrupt lease tokens
(`ledger verifies current lease token and keeps newer lease ownership on repeated release`).
