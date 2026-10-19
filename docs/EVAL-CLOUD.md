# Cloud evaluation after two-phase settlement

Model: `glm-5.3:cloud`; completed at 2026-10-19T02:11:40.652Z. Seed: `pm-rlm-balanced-v2`. Exactly one authorized live invocation.

| Arm | Correct | Provider tokens / question | Seconds / question | Model requests / question | Reached a child |
| --- | ---: | ---: | ---: | ---: | ---: |
| RLM | 0/24 (0.00%) | 146296.92 | 183.78 | 19.17 | 0/24 |
| Complete-item stuffing | 0/24 (0.00%) | 18471.58 | 5.37 | 1.00 | — |

Most-common constant guess: 2/24 (8.33%). Constant zero: 1/24 (4.17%).

Outer refusal histograms: RLM {"budget":15,"model":9}; stuffing {"model":8}. Recorded RLM tool refusals: {"invalid":451}.

Mean RLM charged / recorded provider / pending / delivered-read tokens: 151634.96 / 146296.92 / 5338.04 / 0.00. Charged tokens include actual settled model usage, delivered-read estimates and outstanding reservations.

Both arms use the same model and 131072 context allocation, 512 output allocation and temperature 0. The conservative context estimator permits one UTF-8 byte per token, so effective provider context use can be lower than the configured ceiling. RLM limits are 300000 charged tokens, depth 2 and eight ledger calls. Wall time includes SDK work and concurrent host load. There is one invocation and no answer-based tuning, retries of the eval, or confidence interval. Refused runs count incorrect. Lost/unrecorded provider usage cannot be included; pending reservations are shown separately. This does not establish an RLM advantage.

Sources:

- `pm-vcs` at `f9283201108919939d0e1cfb489358c87ea8822b`: 145 items, 814268 JSON bytes.
- `pm-lint` at `f2c20efa78139f4071f3dd08d317bea05337fe28`: 12 items, 54941 JSON bytes.

Answer histogram:

| Answer | Count |
| --- | ---: |
| `0` | 1 |
| `1` | 1 |
| `4` | 2 |
| `32` | 1 |
| `68` | 1 |
| `167` | 1 |
| `208` | 1 |
| `277` | 1 |
| `1436` | 1 |
| `3154` | 1 |
| `3355` | 1 |
| `12196` | 1 |
| `pm-vcs-5m22` | 1 |
| `pm-vcs-6qva` | 1 |
| `pm-vcs-ag8y` | 1 |
| `pm-vcs-1v6x` | 1 |
| `pm-vcs-b7cb` | 1 |
| `pm-lint-8kis` | 2 |
| `pm-lint-trap` | 2 |
| `pm-lint-1c6j` | 1 |
| `pm-lint-epic` | 1 |

See [eval-results.json](../eval-results.json) for every exact question, truth, outcome digest and counter. Raw model responses and source bodies are not published.
