# RLM SDK adoption audit, 2026-10-25

Tracker: [pm-rlm-alp8](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/tasks/pm-rlm-alp8.toon).
Related delivered SDK ledger: [pm-rlm-6a8t](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-6a8t.toon).

Both findings were assessed against main `e8315c0ab33cb7edc067ec1ba5954cad6ad3a57b`.
Production code and dependency versions remain unchanged: **zero replacements and zero deleted production lines**.

| Audit finding | Disposition | Evidence |
| --- | --- | --- |
| `src/ledger.ts:240-269`: PID-only runtime ownership around `acquireLock` | Blocked by pinned SDK availability. The package pins `@unbrained/pm-cli` **2026.10.20**, which exports `acquireLock` but neither `acquireLockLease` nor `LockLease.fence`. The current 2026.10.25 host exports the requested capability; the task rules prohibit dependency bumps. No host-installation import or compatibility reimplementation was added. | Installed SDK namespace and declaration inspection; `package.json`; public parity for exclusion, repeated release, reacquisition and collection. |
| `src/environment.ts:20-28`: predicates over the immutable snapshot | Retained as the audit recommends. `parseMultiValueFilter` introduces comma/OR input grammar, while current predicates compare literal strings. Querying a live SDK corpus would also violate the frozen consent boundary. No equivalent replacement was established; no new core API defect is claimed for this intentional package behavior. | Literal comma and frozen-view regression; public parity for corpus/list/filter/search/get/peek/history/partition/count. |

The remaining ownership risk is the existing PID-only liveness check. After a dependency update supplies the public lease API, adoption must define how ownership survives arbitrarily long model calls, how expired or stolen ownership refuses effects, and how `LockLease.fence` encloses checkpoint publication. A short TTL alone would allow a second executor while inference is still running. This evidence-only change makes no new concurrency guarantee.

## Integrity before decisions

`RlmContext.history` still reads authoritative streams and invokes `verifyHistoryEntries` before delivery or budget charging. `RlmLedger.gc` still certifies the full corpus, decodes current checkpoints, reads and verifies every historical stream, marks historical references, and only then sweeps blobs. The SDK event index is not substituted for either verification path.

`node --test test/sdk-boundaries.test.ts` covers three cases on real SDK-created non-git trackers. Two prime the real SDK mutation-event index, alter a valid JSON history patch with equal-length text, restore its previous mtime, and require an `incomplete` refusal. The collection case also proves an orphan blob remains byte-identical after refusal. The third locks down literal comma filters and the frozen view after a live SDK update. No SDK is mocked.

`node test/sdk-boundaries-revert.ts` independently bypasses the history verifier, bypasses the collection verifier, and changes the exact type predicate to comma alternatives. Each mutation produces an assertion failure in its targeted regression; the helper restores the original source bytes after each probe. These are behavioral guard proofs; replacement revert proofs are not applicable because neither finding was replaced.

## Public differential proof

Run `node test/sdk-boundaries-public.ts` after dependency installation. It builds origin/main in an isolated archive and the candidate locally, then runs the same worker against each build. It independently verifies public repository visibility and exact source revisions before copying committed tracker bytes. Source files and directories are read-only; the entire filename set and every file's bytes must remain unchanged. Workers run in non-git directories with a Git discovery ceiling and no git executable in PATH. Ownership checks use separate disposable writable ledgers because acquiring a lease is inherently a write.

[sdk-adoption-validation.json](sdk-adoption-validation.json) records 26 matching cases across two public trackers: 22 pm-rlm items and 12 pm-lint items, with 80 source files preserved. Compared values include complete-list receipts and token charges as well as data. There are no intentional output differences. This proves retained behavior; it does not claim SDK lease adoption occurred.

Release evidence is recorded on the tracker item and PR: targeted tests, typecheck, lint, unchanged per-file 100/100/100/100 coverage, npm and Bun release gates, and CI on the published head.
