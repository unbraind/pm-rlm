# v2 cloud measurement

RLM v2 was not better than stuffing on this single fixed set.

Model: `glm-5.3:cloud`; seed: `pm-rlm-balanced-v2`; completed: 2026-10-19T07:27:10.280Z.

| Arm | Correct | Tokens / question | Seconds / question | Requests / question |
| --- | ---: | ---: | ---: | ---: |
| RLM v2 | 1/24 | 231491.58 | 204.60 | 32.00 |
| Complete-item stuffing | 1/24 | 23623.29 | 6.70 | 1.00 |

Child reach: 0/24. Delivered reads: 0; delivered aggregates: 13. Delivered responses requiring envelope extraction: 10. Successful read-only replays: 1. Tool refusals: `{"invalid":754}`. Outer failures: RLM `{"budget":23}`; stuffing `{}`.

Most-common constant guess: 2/24; constant zero: 1/24.

One authorized evaluation invocation, sequential stuffing-first arms, no retries of the evaluation and no answer-based tuning. Both arms share tolerant envelope extraction and retain their string answer schemas. Configured limits: 131072 context, 512 output, 300000 RLM budget, depth 2, calls 8, temperature 0. Questions are format-neutral. The historical suffix remains only in the hash input, preserving the original seeded task selection. Both source revisions, full corpus item/byte counts and all truths were verified before the first request. A preflight initially refused changed task selection before any inference; the exclusive marker was absent until the successful preflight. Omitted to conserve owner quota: another complete arm requires 24 additional cloud requests.

Tokens are provider-reported or conservative byte estimates, not measured-only usage. Pending reservations (0 tokens total) are separate from settled usage; observation charges total 266 byte-estimated tokens. Lost transport counters cannot be recovered. Incorrect stuffing answers are not separately classified as format versus content failures. Seconds include wall time and host load; the RLM arm includes SDK bookkeeping and replay verification for successful runs. Complete-item stuffing selects only whole items that fit the same conservative byte-based context ceiling. No confidence interval, recursive-quality claim or general model ranking follows from one fixed set. This run cannot isolate parser effects from aggregation effects.

## Invalid-action evidence

The historical 451 strings were deleted, so their shapes remain unknown. New exact responses are retained locally in an ignored artifact. New shape counts: `{"unmatched closing think tag with reasoning/prose":340,"other prose or malformed JSON":413,"unclosed reasoning block":1}`. Exact refusal reasons: `{"Unterminated reasoning block":294,"Ambiguous action envelope: return exactly one object":292,"Unterminated JSON action object":61,"Expected one JSON action object":26,"Ambiguous action envelope":76,"Model output is not valid JSON":4,"Unknown model action":1}`. See [the diagnosis](ACTION-DIAGNOSIS.md) for recorded versus synthetic cases.

## Reproducibility

Measured source commit: `4be91f0cf0e079b33912ad6768c25d43dfea51c5`. Measured implementation SHA-256: `54f7b0cf5e59b70ca51a7493f8586058ffd578c1477cdeb3bec86cb068cdd701`. The artifact records every hashed source path; the formatter finds and verifies the immutable commit reproducing every measured byte. These results describe the measured commit, rather than the current implementation. [Per-question results](../eval-results-v2.json) retain exact tasks, truths, source revisions, digests and counters. The original invalidated results remain in [eval-results.json](../eval-results.json).

- `pm-vcs` at `f9283201108919939d0e1cfb489358c87ea8822b`: 145 items, 814268 JSON bytes.
- `pm-lint` at `f2c20efa78139f4071f3dd08d317bea05337fe28`: 12 items, 54941 JSON bytes.
