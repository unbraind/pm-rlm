# Behavioral revert proofs

The five proof scripts (`test/revert.ts`, `test/v2-revert.ts`,
`test/constrained-revert.ts`, `test/review-r3-revert.ts` and
`test/review-r4-revert.ts`) replace exact fixed snippets in current source
with their pre-fix behavior. They never load historical source from Git.
Missing or unexpected snippet counts fail with a named assertion. Every
proof demands a targeted regression assertion failure and restores source
bytes in a `finally` block. Packed-consumer proofs also rebuild the package.

Run `node --test test/revert-shallow.test.ts` after committing proof changes.
This test clones HEAD using `git clone --depth 1` over file transport,
verifies the same HEAD and exactly one available commit, then runs all five
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
