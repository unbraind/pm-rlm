# Adaptive decomposition with a declared budget

```ts
import { adaptiveRlm, RlmAdaptiveError } from 'pm-rlm';

try {
  const receipt = await adaptiveRlm('Explain the selected issues', {
    workspace: '.agents/pm',
    scope: { type: 'Issue', status: 'open' },
    structure: [
      { name: 'summary', question: 'What do these issues describe?' },
      { name: 'cause', question: 'Which causes do the sources establish?' },
      { name: 'outcome', question: 'Which outcomes do the sources establish?' },
    ],
    remaining_tokens: 50000,
    settings: { max_calls: 6, max_depth: 1 },
    author: 'planning-agent',
  });
  console.log(receipt.status, receipt.stop_reason, receipt.components);
} catch (error) {
  if (!(error instanceof RlmAdaptiveError)) throw error;
  console.log(error.code, error.remedy);
}
```

`pm rlm adaptive` uses the same SDK implementation:

```sh
pm rlm adaptive 'Explain the selected issues' \
  --structure '[{"name":"summary","question":"What do they describe?"},{"name":"cause","question":"Which causes are established?"}]' \
  --scope '{"type":"Issue","status":"open"}' \
  --budget-tokens 50000 --max-calls 6 --max-depth 1 --json
```

`--budget-tokens` is required, including when it is zero. Structure contains
1–16 unique names (256 UTF-8 bytes each) and nonblank questions (4096 bytes
each). The overall question is also capped at 4096 bytes. Additional structure
keys refuse rather than silently invent dependencies or change the scope.
The caller owns the semantic decomposition and completeness of the question.

Three fixed candidates group all parts, adjacent pairs, or individual parts in
declaration order. Comparisons make zero model requests. For each candidate,
the engine's exact initial prompt, context check and worst-case output
reservation determine the affordable prefix, subject to available call slots.
The selected candidate maximizes admitted components, then admitted groups,
then minimizes the attempted first-step charge. Exact ties retain the order
`whole`, `pairs`, `components`. `first_step_tokens` includes the first rejected
group when budget prevents further admission; `admitted_groups` counts only
accepted groups. A context refusal does not add an unavailable charge.

These are admission comparisons, not experiments executing three models, a
prediction of answer quality, or a guarantee that a child can finish. The
first child can use surplus budget, while the first-step floors of subsequent
groups stay reserved. Unused charges become available to the next child. The
effective accounting ceiling is the smaller of the caller's remaining tokens
and saved/overridden `budget_tokens`; the receipt exposes both `declared` and
`limit`. The existing byte estimator, pending reservations, provider usage
settlement and delivered-read charges apply. Total logical calls across all
groups, including recursive descendants, share `max_calls`. Each child uses
the ordinary per-run `max_depth` and context limits. No training, policy
promotion, concurrent inference or automatic retry is performed.

The controller reads one complete certified source snapshot and freezes it
for all children. Optional `source_workspace` reads a separate tracker and
writes only the destination `workspace`. It does not open linked files or
hosted data. All execution paths work in a plain directory with no Git binary.

Output contains at most three comparisons, sixteen child references and
sixteen component statuses. Source text and answers remain in child ledgers;
`tree --full`, `evidence`, and `replay` inspect successful child run ids. The
controller id is an ordinary SDK Task, with plan and result comments. Every
component is `supported`, `unsupported`, `unknown`, `deferred`, or `failed`.
Only all-supported results are `complete`. Unattempted and failed components
carry typed refusal codes and remedies. Stop reasons identify declared leaves,
budget, call slots, context, or child failure. A partial receipt exits zero
because it is the requested bounded result; invalid input or infrastructure
refusals exit nonzero and print a remedy.

Each child uses the existing witnessed component answer contract; the compact
receipt's status refers to that child's component with the same name. The
child ledger retains the full answer, witness digests, observations and usage.
A child failure seals unfinished calls with sanitized terminal refusals,
preserves existing terminal descendants, records comments, closes and releases
the call items, then continues with any affordable remaining groups. Pending
model reservations remain charged. SDK persistence failures refuse the entire
operation instead of claiming durable terminal evidence.

Controller plan, per-child checkpoints and the final receipt are append-only
SDK comments. A process interruption may leave an in-progress controller;
inspect its comments and child ledgers before starting a new adaptive run.
Controller Tasks do not support `resume`/`replay`; those commands accept native
child run ids. Completed child responses retain native recovery semantics.

See [the measured public-tracker fixture](adaptive-validation.json). It checks
execution and accounting using scripted responses over real public source
records; it does not measure model reasoning quality or provider billing.
