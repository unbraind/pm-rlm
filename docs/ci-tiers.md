# CI tiers

Required checks remain `test (22)`, `test (26)` and `codeql`. PR/dispatch CI uses
quick depth, hosted Ubuntu, superseded-PR cancellation and a 30-minute ceiling.
CodeQL remains unfiltered because it is required, including on docs-only PRs.
Its existing weekly schedule and repository guard are unchanged.

| Check | Code PR 22 | Code PR 26 | Docs/tracker PR (both) | Deep |
| --- | --- | --- | --- | --- |
| npm ci / prepare merge drivers | yes | yes | yes | four legs |
| Strict tracker health / required merge drivers | — | yes | yes | four legs |
| Commit identity and private-path audit | yes | yes | yes | full gate |
| Build + build:test + tests | quick | quick via coverage | applicable docs tests | full |
| Typecheck, lint, duplication, docstrings | — | yes | — | full gate |
| Coverage: unchanged 100% statements/lines/branches/functions | — | quick | — | full |
| Production dependency audit | — | yes | — | full gate |
| Package file list and pack dry-run (ships README/docs fixtures) | — | yes | yes | full gate |
| Changelog regeneration consistency | — | yes | yes | full gate |
| Publish attestation / canonical caller verification | — | yes | yes | full gate |
| Tooling, automation changelog, release docs, README evidence and evaluation-report docs | suite | suite | yes | full suite |
| Packed npm/npx and Bun/bunx plus global npm/Bun repair acceptance | — | yes | — | full gate |
| Bun package-graph install smoke | — | yes | — | four legs |
| Source-only revert proofs against a depth-one clone | quick suite | quick suite | — | full suite |
| CodeQL | separate required workflow | same | required, no filters | matching main pushes + weekly scan |

Deep runs main pushes, dispatch and daily at 02:53 UTC, avoiding release
(03:23 daily and minute 41 hourly) and CodeQL (01:47 Monday). Four distinct
`deep (22, npm)`, `deep (22, bun)`, `deep (26, npm)`, `deep (26, bun)` jobs each
run one original full release gate at full depth and time scale 3. Each has a
120-minute ceiling and per-ref cancellation. The local pool is selected unless
`PM_LOCAL_DEEP=off`; local jobs retain persistent npm cache and image Bun.
Hosted fallback restores cache and installs Bun; every leg logs Bun's version.
Literal conditional npm/Bun commands keep the attestation scanner effective.

Unset depth remains full. All nine repetitive 500-case property loops retain
the same deterministic first 50 cases in quick mode, never reducing fixed
input-size limits or operation contracts. Reuse cases precompute the same four
PRNG draws per sequence, derive counters from actual generated cases and retain
the full 246/179/321 totals. Other replay/adversarial thresholds derive from
generated sequence counts and stay positive. Coverage thresholds never change.

Packed command watchdogs use validated positive finite integer scale factors.
The existing revert helper recognizes PM_TEST_TIME_SCALE, preserving an explicit
PM_RLM_TEST_TIMEOUT_SCALE override for existing callers. Configuration validates
before an importing test starts children. Every testTimeout call guards a test
runner, build or proof subprocess; no product budget is scaled. Product retry
budgets, the exact fake-clock 300ms exhaustion, the 1500ms retry floor and the
live-owner 10000ms contract stay unscaled; the outer runner watchdog scales.
Packed acceptance already proves Bun install/bunx CLI and native global hosts.

Successful main run 43744417817 measured shallow revert proofs at 284.7 seconds,
500-case repair identity at 135.1 seconds and repair journal at 97.5 seconds.
The Node 22 coverage step took 17m06s; Node 26's repeated full Bun gate took
11m39s, after separate audits, packing and install acceptance. These actual
scripts, rather than a sibling's gate assumptions, define the table above.
Owner fleet measurements were 39,929 runner-minutes/day and 45–90 minute PR wall
time including about 28 minutes queueing. Quick timings are recorded in the
tracker/PR when available; cross-host measurements are not a speedup claim.
The exhaustive local coverage/revert/install combination is left to PR/deep CI
on this overloaded host. No full local test depth is run. Release workflow,
caller workflows and release verifier scripts remain unchanged.
