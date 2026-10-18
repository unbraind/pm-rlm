# Architecture

The package has five boundaries: a certified SDK environment, a durable SDK call ledger, a bounded JSON action interpreter, model transports, and native pm host commands. The workspace argument is the explicit tracker root. No operation discovers an ancestor tracker, writes item documents directly, starts another coding agent, executes model-supplied code or opens linked file contents.

`readCorpus` calls `PmClient.listAllComplete({includeBody: true})` and independently certifies the result. All statuses, full metadata and bodies are read before applying the scope. Every source row except execution calls and generated questions is sorted by id and frozen in the root checkpoint. Environment operations intersect filters with that snapshot; result objects are copied before delivery. A complete-list certificate describes the source read, not the size of a filtered response. History is read through SDK history APIs, chain-verified, and bounded by the source item's snapshot timestamp. Missing or invalid history refuses.

## Ledger schema

Every call is a Task tagged `rlm:call`. Root depth is zero; its parent is a question item. Generated questions are tagged `rlm:question`. A child's parent is the calling call item, never the question. SDK claims identify active work; result evidence is an idempotently appended `RLM result:` comment. The engine closes and releases call items after completion. Development Features and the package Epic are separate records and stay open for orchestrator verification.

| Registered field | Type | Meaning |
| --- | --- | --- |
| `rlm_run` | string | Root call id |
| `rlm_depth` | number | Root zero, child parent plus one |
| `rlm_model` | string | Stable model identity |
| `rlm_prompt_digest` | string | SHA-256 of exact subgoal, slice and resolved settings |
| `rlm_tokens_in` | number | Sum of recorded provider input usage for this call |
| `rlm_tokens_out` | number | Sum of recorded provider output usage for this call |
| `rlm_state` | string | Root-only serialized checkpoint, schema version 1 |

Fields are registered with the extension API and persisted with SDK schema mutations. Standalone SDK consumers use the SDK's native schema-field options through `client.run`; the `--field` assignment path requires an active extension registration even when the schema is persisted. All item, claim, comment, status and settings changes use the public SDK.

The root checkpoint contains question, resolved limits/transport configuration, scope, immutable source snapshot, complete-read certificate, reserved token total and the ordered call graph. Each call contains deterministic id, parent, depth, subgoal, exact slice, digest, ordered model steps, and either an optional result or a terminal typed failure code. Each step contains its exact prompt and reservation, an optional model response with usage, and an optional tool observation. Settings store only a credential environment-variable name, never its value.

Every child of a successfully finished root reaches a terminal recorded state: completed with a result or failed with typed refusal evidence. A typed failure in a materialized child is checkpointed, recorded as an idempotent `RLM refusal:` evidence comment, closed and released before its parent receives the refusal. Raw transport messages are never persisted as refusal evidence.

Root failures remain resumable interruptions. Legacy or corrupted checkpoints with a completed root and an unterminated child fail closed as incomplete on resume; they are never silently reported as recovered.

## Reservation and recovery invariants

1. The root item is the single serialization point for graph and budget checkpoints. SDK item mutation provides atomic item/history publication. A process-owned runtime lease serializes execution of each run. Lease acquisition/recovery is protected by a short SDK lock; a live PID refuses competing execution. PID reuse fails closed. If a process dies inside that short lock, retry after its 60-second stale window. Runtime lease files are excluded from version control.
2. A child is inserted into the root call graph and checkpointed before materialization or inference. Its id is derived from the root id and graph position. Materialization first checks the certified corpus, so a crash between creation and later bookkeeping cannot duplicate an item.
3. Before each inference, the engine checks context and total budget and atomically saves a reservation with the step. It reserves prompt UTF-8 bytes plus sixteen bytes per allowed output token. It performs no inference until that reservation is durable. Resuming that step reuses its reservation.
4. Model responses are validated and checkpointed before their actions execute. Malformed action JSON and unknown actions are recorded refusals and retain their charge. Provider-reported usage is observational and separate from conservative reservations. A crash before a response is checkpointed can repeat that unfinished inference; external provider billing cannot be made exactly once without provider-side idempotency.
5. Successful reads charge their delivered data before storing the observation. Failed reads deliver no partial result. The budget includes read estimates as well as model reservations. No refunds depend on process survival. Maximum call count includes the root; maximum depth counts edges below it.
6. Child lookup uses calling parent plus prompt digest. A terminal failed digest rethrows its recorded typed refusal without inference; a completed digest returns its recorded result and repairs missing comment/status evidence through idempotent SDK operations. It never calls the model again. The SIGKILL test targets the interval after a child result is durable and before its parent observation is durable.
7. A finish result is checkpointed before comment, usage, closure and release. Resume reconciles all terminal call evidence before root execution. The runner reloads the checkpoint after acquiring its lease so a competing completed executor cannot leave it using stale state. Custom users of `RlmEngine.spawn` must hold the same lease around their entire state transaction and await calls sequentially.
8. Replay is read-only. It re-parses recorded model outputs, re-executes environment reads against the frozen item snapshot and timestamp-bounded history, traverses digest-selected children, checks recorded tool observations, terminal child refusal codes and child results, and requires the final finish answer to match the checkpoint byte-for-byte. Missing finishes, missing children, changed observations/results and unreachable call records fail replay. No model endpoint is contacted.

Partitioning serializes each full item, then packs escaped JSON fragments by binary search against the exact byte estimate of their envelope. A single oversized item can span slices; offsets and text reconstruct its original JSON exactly. Child scope validates every fragment against the parent's full authorized items or inherited fragments. Only completely represented items become child tool-readable items; partial fragments are prompt context and can be subdivided without widening scope.

The reservation bound applies to logical execution, not remote model billing or the source bytes read internally to certify a corpus. This implementation stores a full source snapshot and transcripts in a root item, so ledger/history size and certified scans grow with run count. It does not claim scale readiness. A future storage layout may distribute immutable snapshots while retaining the single atomic reservation coordinate; that change would need independent crash and replay proofs.

## Local verification

The scripted model lives only in tests. Its tracker is always a real SDK-created scratch workspace. Actual HTTP servers exercise Ollama and compatible wire formats. A real worker is killed with SIGKILL after one completed child checkpoint; a new process resumes and is compared with an uninterrupted run. Completed-child inference count, answer bytes, reservations and SDK parent/depth rows must agree. Separate destructive behavioral mutations are confined to the package's own source and restored byte-for-byte in `finally` blocks.

The live eval independently verifies public source visibility and the source revision, copies only committed regular tracker files from that revision, explicitly pins loopback Ollama transport, computes truth before any run, excludes generated ledger/question rows from context, and retains public aggregate measurements. It reports incorrect results and refusals honestly. CI, coverage, artifact contents, provider quality, remote reviews and publication are distinct claims; this package is not yet published or deployed.

The model protocol exposes compact partition references instead of repeating all fragment text in the parent transcript. References select a successful partition step and slice index; resolution recomputes exact fragments from the frozen parent scope. The exported environment partition API continues to return full lossless slices. Replay accepts the earlier full-slice partition receipt as well as the compact protocol receipt, comparing either exactly against the frozen source. Delivered observations, including completeness receipts and spawn results, must fit the exact projected next prompt before being charged or retained.
