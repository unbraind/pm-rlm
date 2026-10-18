# Seeded evaluation design v2

This is a truth-only design audit. No model endpoint was contacted. The historical model measurements in `eval-results.json` used the old unbalanced question set and do not score this design.

Seed: `pm-rlm-balanced-v2`. Selection is independent of model outputs: generate exact counts, UTF-8 field-length sums and id-valued argmax tasks from certified complete public tracker copies; hash-sort candidates with the seed; require numeric ranges 1–9, 10–99, 100–999 and 1000+, then id answers and remaining diverse candidates. Ties use lexicographic id order. Each source supplies twelve tasks and allows at most two occurrences of an answer, guaranteeing a combined frequency ceiling of 4/24. Insufficiently diverse corpora refuse generation.

Public snapshots:

- `pm-vcs` at `f9283201108919939d0e1cfb489358c87ea8822b`: 145 items, 814268 JSON bytes.
- `pm-lint` at `f2c20efa78139f4071f3dd08d317bea05337fe28`: 12 items, 54941 JSON bytes.

| Design measure | Exact result |
| --- | ---: |
| Questions | 24 |
| Distinct answers | 21 |
| Numeric / id answers | 13 / 11 |
| Numeric range | 0–12196 |
| Most-common constant guess | 2/24 (8.33%) |
| Constant zero | 1/24 (4.17%) |
| New model runs | 0; pending orchestrator |

Answer histogram (answer → count):

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

Reproduce without inference: `node test/eval-design.ts`. The script verifies current public revisions before copying and writes `docs/eval-design.json`; its recorded revisions identify this audit. Future public revision changes can change truths and selection. `npm run test:live` uses this same generator and accepts `PM_RLM_LIVE_MODEL` verbatim. It never reads this artifact or model outputs to select questions.

See [eval-design.json](eval-design.json) for every exact question, answer, source and full histogram.
