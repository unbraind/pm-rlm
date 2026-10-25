# Measured recursive versus truncated evaluation

`evaluateRlm` and `pm rlm eval` compare the native recursive engine with one truncated request per exact question. The same local Ollama model, temperature zero, context allocation and output allowance serve both arms. Gold answers stay outside both prompts. The baseline receives a UTF-8 prefix of the sorted full-item SDK JSON, including an explicit truncation notice. The recursive engine receives its normal environment protocol and the entire frozen source snapshot. It may use tools or children; child calls are measured rather than forced. This comparison measures the engine policy, including any failure to recurse.

The reviewed [suite](public-eval-suite.json) freezes 24 questions, gold strings, public repository identities, commit revisions and complete corpus SHA-256 digests. Questions cover counts, ownership, authorship, declared blockers (including closed blockers), directed dependency paths and exact `updated_at` timestamps. An unassigned owner is `null`; an absent blocker or path is `none`. Match scoring trims outer whitespace only and otherwise requires exact text. The authoring script verifies public visibility and published commit identity with GitHub, then verifies every archived path and blob against that revision. Local edits, untracked files and Git replacement objects are excluded. Never construct a manifest from a private tracker merely by labeling it public: suite provenance is a reviewed author responsibility. Runtime digest validation binds a supplied copy to that reviewed manifest; it does not independently contact GitHub.

Prepare the public copies with `node test/evaluation-public.ts` in a development checkout with the public source clones available. The generated source map is ignored local data. This preparation needs Git and GitHub access; evaluation itself works without Git. Use a separate scratch tracker for receipts and ledger records. Source copies are read-only: list certification and native lookup/history/graph queries establish gold during authoring; evaluation only reads their full SDK snapshots. The engine records snapshots in the receipt tracker and refuses history outside those snapshots, so both arms see the same captured data.

```sh
pm init eval --defaults
pm rlm eval docs/public-eval-suite.json \
  --sources '{"pm-rlm":"copies/pm-rlm/pm","pm-lint":"copies/pm-lint/pm"}' \
  --id local-trial-1 --model gemma3:4b --json
```

Use `--full` for per-question metrics; default JSON/TOON contains only provenance, configured limits and aggregate metrics. `--endpoint` supports a loopback Ollama server on a different port. Remote endpoints, cloud aliases and inventory entries carrying remote metadata are refused before inference. SDK clients can supply an explicit deterministic `stub` with `mode: 'stub'` for offline harness validation. Such receipts are labeled stub and are never live model evidence. CLI evaluation requires a local model.

```ts
import { evaluateRlm } from 'pm-rlm';
const result = await evaluateRlm(suite, {
  workspace: receiptTracker,
  sources: publicTrackerCopies,
  id: 'local-trial-1',
  model: 'gemma3:4b',
  full: true,
});
```

Every evaluation ID is bound to its suite, model, transport and limits. Reusing it returns completed measurements without inference. Another configuration requires a new ID. The controller reads its receipt inside the native process lease, publishes SDK description compare-and-set transactions, and releases the lease last. Competing evaluators receive `busy`; a later peer receives the completed receipt exactly. Native edits that bypass the evaluation lease still meet the description CAS. Foreign records are preserved with `status: skipped` and `reason: foreign_record_preserved`. The harness has no deletion, sweep or drainer path.

A durable reservation precedes either inference arm. After interruption, a rerun preserves completed rows and records the pending row as interrupted without repeating inference. Completed baseline evidence is retained when available. An arm whose response was not checkpointed has unknown calls, tokens and wall time (`null`), and counts incorrect. This is convergence of the receipt, not exactly-once external inference: a killed process can lose a response or fail before sending its reserved request. Unfinished native run checkpoints remain available for inspection; they are never silently relabeled completed. Create a new evaluation ID for a fresh trial.

Accuracy always uses the full question count, including refusals. Calls count observed model transport attempts, not ledger nodes. Children count observed child nodes separately. Wall time measures each arm including SDK work and host contention. Token counters are provider-reported when available and conservative byte estimates otherwise, as in the existing model adapter. A failed transport can have unreported usage; those token totals become unknown rather than zero. Unknown rows propagate unknown totals. These are single sequential trials with the baseline first, no confidence interval and no claimed recursive advantage. Historical invalidated evaluations are preserved unchanged.

`RlmEvalError` exposes a stable native `code` plus `remedy`. Invalid suites or reused IDs require corrected declarations or a new ID; source drift requires recreating the verified copy; model errors require local Ollama or explicitly labeled SDK stub mode; busy work should be retried with the same ID after the peer stops. The host renders expected errors with exit 2 (budget admission uses exit 3). Inspect receipts before choosing a new trial ID.
