# Changelog

## 2026.10.18 - 2026-10-18

### Added

- Repair only unsupported answer components within a fresh budget ([pm-rlm-repair-runs](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-repair-runs.toon))
- Make the 2026.10.23 pm toolchain bump pass: regenerate the changelog with the new Closed section ([pm-rlm-tc1023](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/chores/pm-rlm-tc1023.toon))
- Reuse explicitly selected verified subanswers across runs ([pm-rlm-bx9v](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-bx9v.toon))
- Measured public tracker aggregation evaluation ([pm-rlm-umh4](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-umh4.toon))
- Compare recursive answers with shared-source evidence and reserved budgets ([pm-rlm-disagreement](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-disagreement.toon))
- Answer evidence coverage for declared question components ([pm-rlm-pdtc](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-pdtc.toon))
- Adaptive decomposition with declared budgets ([pm-rlm-b8cs](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-b8cs.toon))
- Bounded local and compatible model adapters ([pm-rlm-du86](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-du86.toon))
- Typed token-budgeted environment ([pm-rlm-nmny](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-nmny.toon))
- Durable SDK call ledger ([pm-rlm-6a8t](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-6a8t.toon))
- Native pm commands and SDK documentation ([pm-rlm-kaht](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-kaht.toon))
- Atomic budgets, crash resume and deterministic replay ([pm-rlm-kgwh](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-kgwh.toon))
- Tolerant action envelopes and corrective refusal feedback ([pm-rlm-v2parse](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-v2parse.toon))
- Typed snapshot aggregation and one measured cloud comparison ([pm-rlm-v2agg](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-v2agg.toon))

### Fixed

- Report unknown interrupted child counts and run validation portably ([pm-rlm-cu](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-cu.toon))
- Reduce full-snapshot ledger storage amplification for large repeated runs ([pm-rlm-3isb](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-3isb.toon))
- Record terminal typed failures for child calls ([pm-rlm-k7tv](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-k7tv.toon))
- Align empty response checkpoint validation with engine recovery ([pm-rlm-sr0b](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-sr0b.toon))

### Other

- Release readiness behind PM_RELEASE_APPROVED ([pm-rlm-release-gate](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/chores/pm-rlm-release-gate.toon))
- Verify SDK adoption boundaries for recursive run ownership and scoped reads ([pm-rlm-alp8](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/tasks/pm-rlm-alp8.toon))
- Reconcile stale in-progress tracker records (2026-10-23) ([pm-rlm-reconcile-1023](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/chores/pm-rlm-reconcile-1023.toon))

### Closed

- Closed: Checkpoint validation rejects engine-generated empty response steps and blocks recovery ([pm-rlm-github-dfe63798395a-5](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-github-dfe63798395a-5.toon))
- Closed: Failed recursive child leaves successful runs unreplayable and unrecovered ([pm-rlm-github-dfe63798395a-4](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-github-dfe63798395a-4.toon))
