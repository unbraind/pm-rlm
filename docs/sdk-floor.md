# Published pm SDK capability floor

Audited main: `b4e6e2f7f7ec904db552f8f551b7fa6cec16fb55`. Required API floor: **2026.9.30**.

Declared host floor: `2026.10.18`. npm peer: `>=2026.10.18`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: acquireLock` | 2026.5.14 | 2026.5.12 | [src/ledger.ts:7](../src/ledger.ts#L7) |
| `@unbrained/pm-cli/sdk :: certifyCompleteListResult` | 2026.8.18 | 2026.8.17 | [src/environment.ts:1](../src/environment.ts#L1), [src/ledger.ts:7](../src/ledger.ts#L7), [src/reuse.ts:1](../src/reuse.ts#L1) |
| `@unbrained/pm-cli/sdk :: commitItemMutations` | 2026.7.20 | 2026.7.19 | [src/ledger.ts:7](../src/ledger.ts#L7), [src/evaluation.ts:2](../src/evaluation.ts#L2) |
| `@unbrained/pm-cli/sdk :: createExtensionCommandSdk` | 2026.8.2 | 2026.8.1 | [src/settings.ts:2](../src/settings.ts#L2) |
| `@unbrained/pm-cli/sdk :: createPmCliExpectedError` | 2026.6.5 | 2026.5.31 | [src/commands.ts:8](../src/commands.ts#L8) |
| `@unbrained/pm-cli/sdk :: getHistoryPath` | 2026.5.14 | 2026.5.12 | [src/environment.ts:1](../src/environment.ts#L1), [src/ledger.ts:7](../src/ledger.ts#L7) |
| `@unbrained/pm-cli/sdk :: getSettingsPath` | 2026.5.14 | 2026.5.12 | [src/settings.ts:2](../src/settings.ts#L2) |
| `@unbrained/pm-cli/sdk :: isPmCliExpectedError` | 2026.6.5 | 2026.5.31 | [src/ledger.ts:7](../src/ledger.ts#L7) |
| `@unbrained/pm-cli/sdk :: locateItem` | 2026.5.14 | 2026.5.12 | [src/evaluation.ts:2](../src/evaluation.ts#L2) |
| `@unbrained/pm-cli/sdk :: PmClient` | 2026.7.6 | 2026.7.5 | [src/environment.ts:1](../src/environment.ts#L1), [src/settings.ts:2](../src/settings.ts#L2), [src/ledger.ts:7](../src/ledger.ts#L7), [src/adaptive.ts:1](../src/adaptive.ts#L1), [src/reconcile.ts:1](../src/reconcile.ts#L1) |
| `@unbrained/pm-cli/sdk :: readFileIfExists` | 2026.5.14 | 2026.5.12 | [src/settings.ts:2](../src/settings.ts#L2), [src/ledger.ts:7](../src/ledger.ts#L7) |
| `@unbrained/pm-cli/sdk :: readHistoryEntries` | 2026.7.15 | 2026.7.14 | [src/environment.ts:1](../src/environment.ts#L1), [src/ledger.ts:7](../src/ledger.ts#L7) |
| `@unbrained/pm-cli/sdk :: readSettings` | 2026.5.14 | 2026.5.12 | [src/ledger.ts:7](../src/ledger.ts#L7), [src/evaluation.ts:2](../src/evaluation.ts#L2) |
| `@unbrained/pm-cli/sdk :: removeFileIfExists` | 2026.5.14 | 2026.5.12 | [src/blobs.ts:4](../src/blobs.ts#L4), [src/ledger.ts:7](../src/ledger.ts#L7) |
| `@unbrained/pm-cli/sdk :: resolveRuntimeStatusRegistry` | 2026.5.14 | 2026.5.12 | [src/ledger.ts:7](../src/ledger.ts#L7) |
| `@unbrained/pm-cli/sdk :: verifyHistoryEntries` | 2026.7.24 | 2026.7.23 | [src/environment.ts:1](../src/environment.ts#L1), [src/ledger.ts:7](../src/ledger.ts#L7) |
| `@unbrained/pm-cli/sdk :: writeFileAtomic` | 2026.5.14 | 2026.5.12 | [src/blobs.ts:4](../src/blobs.ts#L4), [src/ledger.ts:7](../src/ledger.ts#L7) |
| `@unbrained/pm-cli/sdk/authoring :: defineCommand` | 2026.7.26 | 2026.7.25 | [src/commands.ts:9](../src/commands.ts#L9) |
| `@unbrained/pm-cli/sdk/authoring :: defineExtension` | 2026.7.26 | 2026.7.25 | [index.ts:5](../index.ts#L5) |
| `CommandHandlerContext.args` | 2026.5.1 | 2026.3.12 | [src/commands.ts:42](../src/commands.ts#L42) |
| `CommandHandlerContext.global` | 2026.5.1 | 2026.3.12 | [src/commands.ts:51](../src/commands.ts#L51), [src/commands.ts:55](../src/commands.ts#L55), [src/commands.ts:76](../src/commands.ts#L76), [src/commands.ts:84](../src/commands.ts#L84), [src/commands.ts:91](../src/commands.ts#L91), [src/commands.ts:93](../src/commands.ts#L93) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [src/commands.ts:47](../src/commands.ts#L47), [src/commands.ts:51](../src/commands.ts#L51), [src/commands.ts:54](../src/commands.ts#L54), [src/commands.ts:60](../src/commands.ts#L60), [src/commands.ts:62](../src/commands.ts#L62), [src/commands.ts:64](../src/commands.ts#L64), [src/commands.ts:66](../src/commands.ts#L66), [src/commands.ts:71](../src/commands.ts#L71), [src/commands.ts:72](../src/commands.ts#L72), [src/commands.ts:76](../src/commands.ts#L76), [src/commands.ts:77](../src/commands.ts#L77), [src/commands.ts:81](../src/commands.ts#L81), [src/commands.ts:84](../src/commands.ts#L84), [src/commands.ts:88](../src/commands.ts#L88), [src/commands.ts:90](../src/commands.ts#L90), [src/commands.ts:91](../src/commands.ts#L91), [src/commands.ts:93](../src/commands.ts#L93) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [src/commands.ts:51](../src/commands.ts#L51), [src/commands.ts:53](../src/commands.ts#L53), [src/commands.ts:54](../src/commands.ts#L54), [src/commands.ts:55](../src/commands.ts#L55), [src/commands.ts:56](../src/commands.ts#L56), [src/commands.ts:76](../src/commands.ts#L76), [src/commands.ts:84](../src/commands.ts#L84), [src/commands.ts:91](../src/commands.ts#L91), [src/commands.ts:93](../src/commands.ts#L93) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [src/commands.ts:103](../src/commands.ts#L103), [src/commands.ts:113](../src/commands.ts#L113) |
| `ExtensionApi.registerItemFields` | 2026.5.1 | 2026.3.12 | [src/commands.ts:102](../src/commands.ts#L102) |
| `ExtensionCommandSdk.mutateWorkspaceSettings` | 2026.9.30 | 2026.9.29 | [src/settings.ts:40](../src/settings.ts#L40) |
| `PmClient.claim` | 2026.7.7 | 2026.7.6 | [src/ledger.ts:159](../src/ledger.ts#L159), [src/adaptive.ts:120](../src/adaptive.ts#L120), [src/reconcile.ts:92](../src/reconcile.ts#L92) |
| `PmClient.close` | 2026.7.6 | 2026.7.5 | [src/ledger.ts:183](../src/ledger.ts#L183), [src/adaptive.ts:161](../src/adaptive.ts#L161), [src/reconcile.ts:129](../src/reconcile.ts#L129) |
| `PmClient.comments` | 2026.7.9 | 2026.7.8 | [src/ledger.ts:171](../src/ledger.ts#L171), [src/adaptive.ts:124](../src/adaptive.ts#L124), [src/adaptive.ts:139](../src/adaptive.ts#L139), [src/adaptive.ts:153](../src/adaptive.ts#L153), [src/adaptive.ts:160](../src/adaptive.ts#L160), [src/reconcile.ts:97](../src/reconcile.ts#L97), [src/reconcile.ts:119](../src/reconcile.ts#L119), [src/reconcile.ts:128](../src/reconcile.ts#L128) |
| `PmClient.create` | 2026.7.6 | 2026.7.5 | [src/engine.ts:379](../src/engine.ts#L379), [src/adaptive.ts:119](../src/adaptive.ts#L119), [src/evaluation.ts:138](../src/evaluation.ts#L138), [src/reconcile.ts:91](../src/reconcile.ts#L91) |
| `PmClient.get` | 2026.7.6 | 2026.7.5 | [src/ledger.ts:78](../src/ledger.ts#L78), [src/evaluation.ts:130](../src/evaluation.ts#L130) |
| `PmClient.listAllComplete` | 2026.8.18 | 2026.8.17 | [src/environment.ts:148](../src/environment.ts#L148), [src/ledger.ts:77](../src/ledger.ts#L77), [src/ledger.ts:149](../src/ledger.ts#L149), [src/ledger.ts:172](../src/ledger.ts#L172), [src/ledger.ts:189](../src/ledger.ts#L189), [src/ledger.ts:230](../src/ledger.ts#L230), [src/reuse.ts:88](../src/reuse.ts#L88) |
| `PmClient.release` | 2026.7.7 | 2026.7.6 | [src/ledger.ts:185](../src/ledger.ts#L185), [src/adaptive.ts:163](../src/adaptive.ts#L163), [src/reconcile.ts:131](../src/reconcile.ts#L131) |
| `PmClient.run` | 2026.7.6 | 2026.7.5 | [src/ledger.ts:155](../src/ledger.ts#L155) |
| `PmClient.schemaAddField` | 2026.7.9 | 2026.7.8 | [src/ledger.ts:64](../src/ledger.ts#L64) |
| `PmClient.schemaListFields` | 2026.7.9 | 2026.7.8 | [src/ledger.ts:60](../src/ledger.ts#L60) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.5.31 | `d3b4a795704588e414070a22a4034d7fbd7a290a050509cc4852e0051c0969a7` |
| 2026.6.5 | `bb47c85bb2ce1a8ba858651af8d1f4ca6888bc731d0aaaa63a4b97427219cd89` |
| 2026.7.5 | `4a6664f68120cace5648faf48d51b08c14e969d9c7e185e592f1a0fceae57274` |
| 2026.7.6 | `0d6e446cf93a0f0660ce4e21943adf1e0c21381010ef67369f40cc9834b8d158` |
| 2026.7.7 | `c455dbda90d6f5aff55b23517683376ea6ab74d4a1540f3f8274590b1687c47e` |
| 2026.7.8 | `b892cce02e555decd3f0d09af0d2a5d8817494fe577e357ffaea84ef385a9b6a` |
| 2026.7.9 | `87600f77a82d5e66c8ac05f120b435a0fb22b5fad42ae5db4540bb4ca45a01ea` |
| 2026.7.14 | `4a42de258a3b1cabff1112dd90ae4f3cc272e25ada229d818becae0f2845e128` |
| 2026.7.15 | `1c5d8e7427d74af157577ff58e0692a986016ee355eaf3a6b5ccebca5a9779aa` |
| 2026.7.19 | `513e0aead42767a113a26b8b2e2cbb8a22879d0cb0500d4d3cdd16d21d9f7a39` |
| 2026.7.20 | `6fbc1d789477491e007d03396dbf1dd2f09376220059887faf6f9d50668a6b08` |
| 2026.7.23 | `caf1a21b0b587dc55c3509654466dd1e20383e30f2d17b47678887a15a5490af` |
| 2026.7.24 | `ae7757c7e4b02bf5c0908a7bcfd487926912bc2f71332c68c9e1be4017d796ab` |
| 2026.7.25 | `20dfec2ca4ddfcebd484af686b76aebcb1f479a7b81c781380a7fe6b6f8506f5` |
| 2026.7.26 | `b10b647a7fce423106dfb964934ac2d43b8770f8f085df89a13c9a04e75569cc` |
| 2026.8.1 | `242013e81ed2c4329a3cb20d3e70fa58f6dbb627d00c2c1e883562e786850f80` |
| 2026.8.2 | `c9f8e516319ba4d6609ea0272e4fa70360668531c379ec54b29df8aa418293e3` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |
| 2026.9.29 | `fa52ca1b2512ee2ed15d348d393383706705f94479ba7432079bd8e14d57b97d` |
| 2026.9.30 | `a966b19b5d0e845bdc46df61f89d7c89800606821bcf1e061d619dfcfd0dc7db` |
