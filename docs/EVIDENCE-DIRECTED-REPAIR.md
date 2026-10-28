# Evidence-directed repair

Every unmaterialized child needs current token and call headroom, including a
child whose intent was saved before an interruption. A saved allowance does not
authorize execution after an earlier child's usage becomes unverifiable.
Recovery retains supported components, marks the affected child with a `budget`
or `calls` gap, and creates no new native child or inference request. Completed
native peers remain eligible for verification even when new execution is blocked.

`repairRlm(request, options)` and `pm rlm repair` complete declared gaps in an
existing evidence answer. They retain still-valid supported components and use
one native child run per targeted component. Evidence coverage diagnoses gaps;
adaptive decomposition chooses initial work; reconciliation compares answers.
Repair does none of that discovery or comparison implicitly.

```sh
pm rlm repair original-run-id --parts '[{"name":"diagnosis","question":"What is established?","depends_on":[],"sources":["source-item-id"]},{"name":"remedy","question":"Which remedy follows?","depends_on":["diagnosis"],"sources":["source-item-id"]}]' --budget-tokens 50000 --json
pm rlm repair-resume repair-run-id --json
pm rlm repair partial-repair-run-id --parts '[{"name":"diagnosis","question":"What is established?","depends_on":[],"sources":["source-item-id"]},{"name":"remedy","question":"Which remedy follows?","depends_on":["diagnosis"],"sources":["source-item-id"]}]' --budget-tokens 100000 --json
```

See the [typed SDK example](../examples/evidence-directed-repair.ts).

Declare all original component names exactly once, in the original order.
Each part supplies a question, the component names it depends on, and its
complete source-item dependency set. Dependencies form an acyclic graph.
Every original witness source must be included. Source ids must belong to the
original frozen scope. A caller must declare all semantic dependencies: witness
provenance alone cannot establish semantic entailment or discover omitted
dependencies. Original `unsupported` and `unknown` parts, changed source rows,
and their downstream dependents are repair targets. Other components incur no
model calls. The child prompt contains only its part and declared prerequisite
answers; its tools can read only that part's declared source rows.

The fresh budget is an integer from 0 through 1,000,000,000, capped at the
original run's configured budget. The original model, context, recursion and
call limits remain binding. Prior inference charges remain in the original
ledger and are never charged again. The controller sums actual native child
reservations, including unfinished worst-case reservations. Admission and all
budget decisions use exact integer accounting. Counters are validated before
success. Exhaustion returns `partial`, preserving supported answers and one
named gap for every unavailable component, with reasons and remedies.

To add a fresh budget, use a stopped partial repair id as the next `source` with
the same part declarations. Completed native children retain their original
evidence run identities and are reused; only remaining gaps and invalidated
dependents run again. An interrupted controller must be resumed first. Source
chains are bounded to sixteen records. Each damaged child contributes only its
own gap and downstream gaps, leaving other verified answers available.

Inputs use a closed schema: 1–16 components; dense arrays; distinct names and
dependencies; bounded nonblank names (256 Unicode characters), questions
(4096 characters), and at most 1000 source ids per part. Unknown properties,
unsafe or fractional numbers, nonfinite values, cycles and missing parts refuse
before writes. Names and questions retain their exact bytes, including CRLF.
`constructor` and `__proto__` are ordinary component names.

Recovery holds the controller's process-owned lease for the complete
read/modify/write sequence. Native child execution uses its own lease and
checkpoint verification. Completion reconciles a dead SDK checkpoint writer
through the native lock policy before materializing command metadata. Controller checkpoints compare the actual SDK history revision inside the SDK
item lock. Native append-only history records each operation with an identity
bound to that history head; importing an older serialized counter cannot reuse
a newer operation. Initial declarations and source coordinates remain immutable. Continued native
proofs must match the same producer-owned question, model policy and allowance.
Pending child identities are persisted before materialization. Retry reads
current SDK rows and verified growing history coordinates, including ABA edits,
before inference. Changed sources skip the target and every downstream part;
a new repair is required for new source revisions or additional budget. A peer's
completed child is reused without inference. Foreign records are skipped without
mutation; an unverifiable child conservatively consumes the remaining allowance
so unrelated work cannot overspend it. Already completed peers retain their
verified answers, and resuming a stopped receipt rechecks later native peer
completion. Call counts include verified native calls. Child recovery uses the native engine
accounting verifier to match the stored total to reconstructed step charges and
settled reservations to their recorded usage.
No source item or original ledger is updated. Complete checkpoints
are retained in append-only native item history; copy the entire tracker,
including native ledger blobs, for recovery.

The SDK returns full supported answers, witness references and their origin
run ids. Witness step numbers belong to that named origin run. The CLI uses
the host TOON renderer or `--json`, retains every component and named gap, and
omits answer text and witnesses by default; answer digests and byte counts
remain. `--full` returns full answers. `RlmRepairError` carries a stable `code`
and a machine-readable `remedy`. Invalid input and integrity failures exit 2;
expected budget exhaustion is a successful partial receipt.

All runtime paths work in plain-directory trackers without Git. An SDK caller
may pass `source_workspace` for a separate read-only source tracker; pass it
again during recovery. The path stays operational context and is never saved
in a checkpoint. The saved source mode and exact source revision coordinates
prevent accidentally recovering against a different tracker. CLI commands use
their explicit host tracker. Preparing the public measurement needs Git and
GitHub only for public provenance checks; measured runtime uses neither.

The [public measurement](repair-validation.json) uses deterministic protocol
adapters and a pinned read-only public tracker copy. It measures selective
execution, retained answers, accounting and recovery, not inference quality or
provider billing. Native checkpoint v1/v2 interchange remains covered by the
existing 500-sequence SDK state test; repair journals add 500 seeded sequences
over real producer checkpoints, including completed native children and zero-budget
receipts, replaying older inputs and recovering each
through the package. CRLF and whitespace variants, native relationships and
fields are compared after fresh SDK read-back against an independent state model. Interleaving tests compete at every observable controller
transition on one non-git tracker and exercise native child peer completion.
