# Behavioral revert proofs

The six proof scripts (`test/revert.ts`, `test/v2-revert.ts`,
`test/constrained-revert.ts`, `test/review-r3-revert.ts` and
`test/review-r4-revert.ts` and `test/review-r6-revert.ts`) replace exact fixed snippets in current source
with their pre-fix behavior. They never load historical source from Git.
Missing or unexpected snippet counts fail with a named assertion. Every
proof demands a targeted regression assertion failure and restores source
bytes in a `finally` block. Packed-consumer proofs also rebuild the package.

Run `node --test test/revert-shallow.test.ts` after committing proof changes.
This test clones HEAD using `git clone --depth 1` over file transport,
verifies the same HEAD and exactly one available commit, then runs all six
scripts sequentially inside that clone. It compares proof/helper bytes to
the working tree and checks that tracked source is restored after each
script. Locked dependencies are shared through a directory link; source,
build outputs and Git objects belong to the disposable clone. No historical
commit or network fetch is required by a proof.

The test also checks missing, ambiguous and repeated snippet replacements,
including literal replacement characters. Nested test processes clear
Node's inherited test context so the regression assertions execute. Clone
processes omit inherited coverage output to keep mutation runs out of the
release coverage report. Both release gates include this test without
changing the coverage or duplication thresholds.

Round six adds four independent reversions: remove the published measurement
artifacts, bypass replay execution-refusal validation, bypass resume validation,
and omit earlier model-step charges when reconstructing the remaining budget.
The regression checks exact refusal codes/messages on completed and interrupted
runs, absence of resumed inference or history writes after tampering, recursive
child reuse, prior delivered-read charges, and actual packed report link targets.

The clone runner allows thirty minutes per script and one hour for the full
sequence, accommodating packed installs on a busy host. Assertion requirements,
proof inventory and all release thresholds remain unchanged.

Round seven extends the round-six script with two independent reversions in
`validateRecorded()`: count original reservations instead of reported usage for
unsettled responses, and require a reason on legacy code-only refusals. Both
replay and resume regressions use real trackers with v1-compatible read actions,
missing or explicit v1 parser versions, original unsettled reservations and a
budget refusal. Replay preserves checkpoint and history bytes; resume settles
exactly once and retries only a missing finish. Altered codes or present reasons
remain invalid, and v2/v3 still require reasons.

Round eight adds seven independent reversions to the round-six script (13/13
in that script). The spawn matrix covers reversed slice ranges, text/offset
mismatches, incorrect slice token estimates, unavailable references, non-partition
references, absent partition indexes, inherited-scope refusals, depth, call count,
post-child observation budget, child model/context failures and completion-hook
failures. Both replay and resume reject altered codes, altered reasons and
missing modern reasons on completed and unfinished checkpoints before inference
or ledger-history writes. Separate reversions disable code/message comparison
and child failure-message persistence. Three report reversions cover the saved
evaluation-invocation wording, measured-commit wording and its formatter output.
The formatter regression uses a real measured Git commit followed by source
drift, without model requests. The full six-script inventory now has 94 proofs.

Paired reconciliation adds a tenth proof script with five independent
reversions: caller reservation admission, shared captured corpus, conflicting
answer labels, history boundary enforcement and immutable boundary flag
validation. Every protection produces a targeted assertion failure when reverted,
and the script restores exact source bytes. The depth-one clone inventory now
includes this script alongside the nine existing scripts.
