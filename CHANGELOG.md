# Changelog

## Unreleased

### Other

- Keep published dependency updates in the generated changelog ([pm-rlm-sanx](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/chores/pm-rlm-sanx.toon))

### Dependencies

- Bump the pm-toolchain group with 3 updates

## 2026.11.23 - 2026-11-23

### Dependencies

- Bump the pm-toolchain group with 3 updates ([#90](https://github.com/unbraind/pm-rlm/pull/90))

## 2026.11.22 - 2026-11-22

### Dependencies

- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#88](https://github.com/unbraind/pm-rlm/pull/88))

## 2026.11.20 - 2026-11-20

### Dependencies

- Bump the pm-toolchain group with 2 updates ([#86](https://github.com/unbraind/pm-rlm/pull/86))
- Bump @unbrained/pm-cli ([#83](https://github.com/unbraind/pm-rlm/pull/83))

## 2026.11.19 - 2026-11-19

### Added

- Verify final answers with executable count membership and equality invariants ([pm-rlm-answer-invariants](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/features/pm-rlm-answer-invariants.toon))
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

### Changed

- Repair the ledger storage revert proof for the toolchain update ([pm-rlm-b602](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/chores/pm-rlm-b602.toon))

### Fixed

- Reconcile duplicate ownership of GitHub issue \#5 blocking gated tracker sync ([pm-rlm-9f0x](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-9f0x.toon))
- SDK commit fence delays dead-owner crash recovery beyond the default lock wait ([pm-rlm-sdk-dead-fence](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-sdk-dead-fence.toon))
- Report unknown interrupted child counts and run validation portably ([pm-rlm-cu](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-cu.toon))
- Reduce full-snapshot ledger storage amplification for large repeated runs ([pm-rlm-3isb](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-3isb.toon))
- Record terminal typed failures for child calls ([pm-rlm-k7tv](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-k7tv.toon))
- Align empty response checkpoint validation with engine recovery ([pm-rlm-sr0b](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-sr0b.toon))
- Keep sync changelog regeneration consistent with the release gate ([pm-rlm-sync-changelog](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-sync-changelog.toon))

### Other

- Adopt current pm-cli and regenerate toolchain changelog ([pm-rlm-toolchain-1114b](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/chores/pm-rlm-toolchain-1114b.toon))
- Release readiness behind PM_RELEASE_APPROVED ([pm-rlm-release-gate](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/chores/pm-rlm-release-gate.toon))
- Verify SDK adoption boundaries for recursive run ownership and scoped reads ([pm-rlm-alp8](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/tasks/pm-rlm-alp8.toon))
- Reconcile stale in-progress tracker records (2026-10-23) ([pm-rlm-reconcile-1023](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/chores/pm-rlm-reconcile-1023.toon))
- Adopt revision-safe SDK settings sections ([pm-rlm-sdk-settings](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/chores/pm-rlm-sdk-settings.toon))
- Adopt the November 4 pm toolchain contracts ([pm-rlm-toolchain-1104](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/chores/pm-rlm-toolchain-1104.toon))
- Keep packed npm evaluation within its unchanged subprocess bound ([pm-rlm-packed-timing](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/tasks/pm-rlm-packed-timing.toon))

### Closed

- Closed: Dead-owner retry can start a new mutation after its total retry budget expires ([pm-rlm-github-dfe63798395a-37](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-github-dfe63798395a-37.toon))
- Closed: Update fatal-child behavioral revert target after ledger retry wrapper change ([pm-rlm-github-dfe63798395a-38](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-github-dfe63798395a-38.toon))
- Closed: Plain replay skips execution-refusal integrity validation ([pm-rlm-github-dfe63798395a-42](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-github-dfe63798395a-42.toon))
- Closed: Checkpoint validation rejects engine-generated empty response steps and blocks recovery ([pm-rlm-github-dfe63798395a-5](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-github-dfe63798395a-5.toon))
- Closed: Failed recursive child leaves successful runs unreplayable and unrecovered ([pm-rlm-github-dfe63798395a-4](https://github.com/unbraind/pm-rlm/blob/main/.agents/pm/issues/pm-rlm-github-dfe63798395a-4.toon))

### Dependencies

- Bump the pm-toolchain group with 2 updates ([#80](https://github.com/unbraind/pm-rlm/pull/80))
- Bump eslint ([#79](https://github.com/unbraind/pm-rlm/pull/79))
- Bump @unbrained/pm-cli ([#78](https://github.com/unbraind/pm-rlm/pull/78))
- Bump @babel/eslint-parser ([#75](https://github.com/unbraind/pm-rlm/pull/75))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#72](https://github.com/unbraind/pm-rlm/pull/72))
- Bump jscpd ([#66](https://github.com/unbraind/pm-rlm/pull/66))
- Bump the pm-toolchain group with 3 updates ([#64](https://github.com/unbraind/pm-rlm/pull/64))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#62](https://github.com/unbraind/pm-rlm/pull/62))
- Bump the codeql-action group across 1 directory with 2 updates ([#61](https://github.com/unbraind/pm-rlm/pull/61))
- Bump the pm-toolchain group with 3 updates ([#63](https://github.com/unbraind/pm-rlm/pull/63))
- Bump the pm-toolchain group across 1 directory with 3 updates ([#58](https://github.com/unbraind/pm-rlm/pull/58))
- Bump eslint ([#56](https://github.com/unbraind/pm-rlm/pull/56))
- Bump @types/node ([#51](https://github.com/unbraind/pm-rlm/pull/51))
- Bump the pm-toolchain group with 3 updates ([#50](https://github.com/unbraind/pm-rlm/pull/50))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#48](https://github.com/unbraind/pm-rlm/pull/48))
- Bump the pm-toolchain group with 3 updates ([#46](https://github.com/unbraind/pm-rlm/pull/46))
- Bump @unbrained/pm-cli ([#44](https://github.com/unbraind/pm-rlm/pull/44))
- Bump the pm-toolchain group across 1 directory with 3 updates ([#35](https://github.com/unbraind/pm-rlm/pull/35))
- Bump jscpd ([#33](https://github.com/unbraind/pm-rlm/pull/33))
- Bump the pm-toolchain group with 3 updates ([#32](https://github.com/unbraind/pm-rlm/pull/32))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#25](https://github.com/unbraind/pm-rlm/pull/25))
- Bump the codeql-action group with 2 updates ([#24](https://github.com/unbraind/pm-rlm/pull/24))
- Bump fast-uri from 3.1.8 to 3.1.9 ([#21](https://github.com/unbraind/pm-rlm/pull/21))
- Bump the pm-toolchain group with 3 updates ([#17](https://github.com/unbraind/pm-rlm/pull/17))
- Bump the pm-toolchain group with 3 updates ([#16](https://github.com/unbraind/pm-rlm/pull/16))
- Bump the pm-toolchain group with 2 updates ([#12](https://github.com/unbraind/pm-rlm/pull/12))
- Bump eslint ([#11](https://github.com/unbraind/pm-rlm/pull/11))
- Bump pm-ops ([#10](https://github.com/unbraind/pm-rlm/pull/10))
- Bump the pm-toolchain group across 1 directory with 2 updates ([#1](https://github.com/unbraind/pm-rlm/pull/1))
- Bump the codeql-action group with 2 updates ([#3](https://github.com/unbraind/pm-rlm/pull/3))
