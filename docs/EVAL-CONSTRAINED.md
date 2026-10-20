# constrained cloud measurement

RLM constrained request scored higher on this single fixed set.

Model: `glm-5.3:cloud`; seed: `pm-rlm-balanced-v2`; completed: 2026-10-19T11:25:50.230Z.

| Arm | Correct | Tokens / question | Seconds / question | Requests / question |
| --- | ---: | ---: | ---: | ---: |
| RLM constrained request | 2/24 | 237461.75 | 131.26 | 37.46 |
| Complete-item stuffing | 1/24 | 23630.46 | 8.94 | 1.00 |

Child reach: 0/24. Delivered reads: 1; delivered aggregates: 13. Delivered responses requiring envelope extraction: 8. Successful read-only replays: 2. Tool refusals: `{"invalid":883}`. Outer failures: RLM `{"budget":22}`; stuffing `{}`.

Most-common constant guess: 2/24; constant zero: 1/24.

One authorized evaluation invocation, sequential stuffing-first arms, no retries of the evaluation and no answer-based tuning. Both arms share tolerant envelope extraction and retain their string answer schemas. This constrained round sends the generated action schema as Ollama format and the separate answer schema for stuffing. Configured limits: 131072 context, 512 output, 300000 RLM budget, depth 2, calls 8, temperature 0. Questions are format-neutral. The historical suffix remains only in the hash input, preserving the original seeded task selection. Both source revisions, full corpus item/byte counts and all truths were verified before the first request. Omitted to conserve owner quota: another complete arm requires 24 additional cloud requests.

Tokens are provider-reported or conservative byte estimates, not measured-only usage. Pending reservations (0 tokens total) are separate from settled usage; observation charges total 9693 byte-estimated tokens. Lost transport counters cannot be recovered. Incorrect stuffing answers are not separately classified as format versus content failures. Seconds include wall time and host load; the RLM arm includes SDK bookkeeping and replay verification for successful runs. Complete-item stuffing selects only whole items that fit the same conservative byte-based context ceiling. No confidence interval, recursive-quality claim or general model ranking follows from one fixed set. This run cannot isolate parser effects from aggregation effects.

## Invalid-action evidence

The historical 451 strings were deleted, so their shapes remain unknown. New exact responses are retained locally in an ignored artifact. New shape counts: `{"other prose or malformed JSON":883}`. Exact refusal reasons: `{"Ambiguous action envelope: return exactly one object":797,"Unterminated JSON action object":17,"Expected one JSON action object":1,"Ambiguous action envelope":66,"Model output is not valid JSON":1,"Action does not match the action JSON Schema":1}`. See [the diagnosis](ACTION-DIAGNOSIS.md) for recorded versus synthetic cases.

## Reproducibility

Measured source commit: `495a156824ce0631c52292ecb744671491698089`. Measured implementation SHA-256: `1b04b87807ff61eb35263a3b1c81dcf50124b227e6fbbb27c94ea143f72d0a47`. The artifact records every hashed source path; the formatter finds and verifies the immutable commit reproducing every measured byte. [Per-question results](../eval-results-constrained.json) retain exact tasks, truths, source revisions, digests and counters. The original invalidated results remain in [eval-results.json](../eval-results.json).

- `pm-vcs` at `f9283201108919939d0e1cfb489358c87ea8822b`: 145 items, 814268 JSON bytes.
- `pm-lint` at `f2c20efa78139f4071f3dd08d317bea05337fe28`: 12 items, 54941 JSON bytes.

Ollama Cloud currently documents structured outputs as unsupported ([official documentation](https://docs.ollama.com/capabilities/structured-outputs)). Sending the schema does not prove enforcement; the recorded ambiguous and truncated envelopes show that this endpoint did not enforce the action contract. Model errors are sanitized, so the precise provider rejection cause and lost usage cannot be inferred from them. The OpenAI-compatible path is unit-tested with real local HTTP endpoints, not live-measured here. After this native run, its strict union conversion was corrected to omit redundant object types on union nodes; the native action and stuffing schemas remain byte-identical to measured commit 495a156. The native action schema SHA-256 is b5d25da2e58658a436e101bcf6bf9e5fb4177405d61f7898c0cdee5b3e3e0c5a; the answer schema hash is 8aa6b8e71d80a6b3ca100683098234c23e868630d5c69ef66163e67d8ecb9a7d. Earlier v2 results remain in [EVAL-V2.md](EVAL-V2.md).
