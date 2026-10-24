# Compare evidence across two recursive decompositions

`reconcileRlm` runs exactly two caller-declared partitions of the same named
question parts. Each group is a native recursive RLM execution with the existing
component evidence contract, call ledger, reservations, settlement and replay.
Both arms receive independently copied values from one certified complete-list
read, captured before any controller writes. The boundary digest binds the
question, part questions, scope, captured items and complete-list certificate.
Caller declarations are copied before asynchronous work begins. History actions
refuse with a remedy because live history is outside this captured boundary.

```ts
import { reconcileRlm } from 'pm-rlm';

const receipt = await reconcileRlm('Explain the documented incident', {
  workspace: trackerRoot,
  source_workspace: readOnlySourceRoot, // optional, separate from ledger writes
  structure: [
    { name: 'cause', question: 'What cause is stated?' },
    { name: 'outcome', question: 'What outcome is documented?' },
  ],
  arms: [
    { groups: [['cause', 'outcome']], budget_tokens: 100000 },
    { groups: [['cause'], ['outcome']], budget_tokens: 100000 },
  ],
  reserved_tokens: 200000,
  settings: { budget_tokens: 200000, max_calls: 12 },
});
console.log(receipt.comparisons, receipt.budget);
```

The [example CLI plan](../examples/reconciliation-plan.json) has the same schema:

```sh
pm rlm reconcile 'Explain the documented incident' \
  --plan "$(cat examples/reconciliation-plan.json)" \
  --scope '{"type":"Issue"}' --budget-tokens 200000 --json
```

Omit `--json` for native TOON. CLI `--budget-tokens` is the explicit reservation;
the configured RLM budget remains an additional ceiling. SDK clients can set
both explicitly. No model requests occur when declarations, first-step floors,
call slots or budget admission fail. Arms cannot borrow each other's allowance.
Each group reserves the first-step floors of its later groups. Recursive calls
share the caller's global `max_calls`, reserving one slot for every future group.
Costs include settled native model usage, delivered reads and pending worst-case
reservations. `token_usage: reported_or_estimated` is not provider billing.
The deterministic comparison performs zero additional inference.

The compact receipt preserves answers, availability statuses, run ids, witness
step/digest references, per-run costs and per-arm totals. A witness reference
resolves within that run's root call. `pm rlm tree RUN --full --json` exposes its
source excerpt and offsets; `pm rlm evidence RUN --json` replays and verifies
provenance without inference. Checkpoint and final receipts are SDK comments on
the controller item. Back up the entire tracker, including immutable RLM blobs.

Each component is `disagreement` when two supported answers differ byte for byte,
`equal_text` when supported strings match, or `unresolved` if either answer is
unavailable or a group failed. Equality establishes neither truth nor semantic
equivalence. A `complete` receipt means both arms produced supported component
answers, including disagreements. Witness validity proves provenance, not
entailment. This workflow does not pick a winner, learn a policy, measure labeled
accuracy or replace pm-jev's typed local decisions.

`RlmReconcileError` preserves a stable `code` and corrective `remedy`. CLI input
and integrity refusals exit 2; admission budget/call/depth refusals exit 3.
Operational group failures return a `partial` receipt with a typed refusal and
preserved cost; callers must inspect `status` and `comparisons`, even on exit 0.
Do not treat unavailable answers as agreement. An interrupted controller is not
automatically resumed; retained native runs remain inspectable, and completion
requires starting a new explicitly budgeted comparison. Tracker storage failures
refuse the controller; its last checkpoint remains available when storage permits.

Without git, SDK and CLI reconciliation, evidence and replay work in a plain
tracker. The public validation harness needs Git and GitHub only to verify the
published source before running with Git absent from PATH. See the measured
[public-tracker receipt](reconciliation-validation.json). It uses deterministic
protocol responses with an intentional conflict, so it validates execution,
evidence and accounting, without claiming model quality or cloud billing.
