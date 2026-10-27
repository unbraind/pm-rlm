# pm-rlm

pm is context management for agents. Recursive Language Models keep a large context in an environment, inspect it through tools, delegate subgoals, and compose the results. `pm-rlm` makes a pm workspace that environment and its durable execution ledger. Each recursive call is a visible Task with its parent, model, digest, usage, claim and result evidence.

This package is **unreleased**. Publication needs maintainer approval; the release workflow has no schedule and is guarded by `PM_RELEASE_APPROVED`. The deterministic model exists only in the test suite. Model weights are not bundled.

Install from a reviewed local artifact now:

```sh
npm ci
npm pack
pm package install ./pm-rlm-2026.10.18.tgz
```

After publication, the supported entry points are:

```sh
pm package install pm-rlm
npm install --save-dev @unbrained/pm-cli pm-rlm
npx pm package install pm-rlm
bun add --dev @unbrained/pm-cli pm-rlm
bunx pm package install pm-rlm
# Without a preinstalled host:
npx --package=@unbrained/pm-cli pm package install pm-rlm
bunx --package=@unbrained/pm-cli pm package install pm-rlm
```

The host requires Node 22.18 or newer. npm/npx and Bun/bunx packed consumers are verified by `npm run test:install`: each creates a real SDK run and queries its closed call through the installed `pm rlm tree --json` command. `pm package install` performs extension discovery; npm or Bun dependency installation alone is not the activation step.

| Command | Example | Result |
| --- | --- | --- |
| `run` | `pm rlm run "Count open Issues" --scope '{"type":"Issue"}' --max-depth 3 --max-calls 32 --budget-tokens 300000` | Answer, run id, calls, reservations and reported-or-estimated model usage |
| `tree` | `pm rlm tree run-id` | One compact row per call: parent, depth, status, tokens and result excerpt |
| `tree --full` | `pm rlm tree run-id --full --json` | Entire ledger checkpoint, including snapshot and recorded outputs |
| `resume` | `pm rlm resume run-id` | Recovered answer; completed digests and recorded model responses are reused |
| `replay` | `pm rlm replay run-id --json` | Re-executed recorded actions and verified byte-identical answer, without inference or writes |

## Install and release approval

The first npm release is pending the maintainer's interactive bootstrap. After
that first publish, the maintainer configures npm trusted publishing for
`release.yml` and sets the repository variable `PM_RELEASE_APPROVED` to `true`.
The daily workflow and manual dispatch both require this variable and `main`.
Publishing uses OIDC with provenance; no stored npm token is needed.

Once published, install the package and compatible pm host, then activate the
extension in an initialized pm project:

```sh
npm install pm-rlm @unbrained/pm-cli
npx --no-install pm package install ./node_modules/pm-rlm

bun add pm-rlm @unbrained/pm-cli
bunx --bun --no-install pm package install ./node_modules/pm-rlm

pm package install npm:pm-rlm
pm rlm --help
```

The package exports its SDK through `main` and `types` and registers commands
with pm. It has no standalone `bin`: use `npx pm` or `bunx --bun pm` through
the installed host. npm/Bun dependency installation alone does not activate it.

## Ledger storage

New root checkpoints contain a v2 manifest: run id, the single `reserved_tokens` coordinate, and SHA-256 references to snapshot and transcript blobs. Durable JSON payloads live in `rlm-blobs/` inside the tracker. Snapshots deduplicate across runs with identical scoped source bytes. Prompts, responses, observations, slices and call records are immutable separate payloads; unchanged strings are reused across checkpoint revisions. Every referenced blob is hashed as raw bytes before strict UTF-8 decoding and use. Missing, corrupt or invalid payloads refuse with `incomplete`.

Back up or transport the **whole tracker**, including `rlm-blobs/`. Copying only item rows and history is insufficient for v2 runs. Earlier package builds that understand only v1 cannot read new v2 roots; keep a complete tracker backup for rollback. Full tree, resume and replay hydrate the same public `RlmState` shape, preserving independent JSON values when different steps share a payload digest. Existing v1 checkpoints read without writes; the next explicit save migrates the active checkpoint, leaving append-only history unchanged. Parser and aggregate versions keep their original semantics.

For explicit garbage collection:

```ts
import { RlmLedger } from 'pm-rlm';
const collected = await new RlmLedger('.agents/pm').gc();
console.log(collected.removed, collected.bytes);
```

Collection shares a process-owned storage lease with publication. Verified historical reachability pins committed versions, allowing hydration and replay without read-side lease writes. It verifies current and historical references before sweeping orphan blobs and abandoned blob temporary files. Verified history retains old payloads, so ordinary GC does not erase audit evidence or reclaim reachable historical transcripts. Invalid history, unknown storage versions or missing referenced data aborts collection before deletion. No background collector runs. Writers publish complete blobs before the atomic SDK manifest update; an interrupted prepublication write leaves the preceding coordinate intact. SIGKILL recovery does not establish power-loss durability. The pinned SDK retains killed item writers' TTL locks; resume must follow the tracker's existing stale-lock recovery policy. Crash fixtures use a one-second item-lock TTL with automatic stale recovery, without forcing locks.

The pinned SDK also leaves a fresh commit-fence cleanup gate when a writer is killed inside its lock fence (unbraind/pm-cli#1609); that gate blocks dead-owner lock takeover for about ten seconds while the default item-lock wait is three seconds. Every ledger mutation therefore treats a lock conflict whose recorded owner process is provably dead as retryable, with bounded backoff and jitter inside a fifteen-second budget configurable as `RlmLedgerOptions.deadOwnerRetryMs`; lock conflicts with live owners and every other error still fail fast with the SDK's typed error. This bounded retry is a package-side workaround and can be removed once the upstream fix ships.

See [the storage measurements](docs/LEDGER-STORAGE.md) for the public eval corpora at 10, 100 and 500 runs, methodology and remaining scale limits.

## Without git

Environment reads, recursive run, tree, resume, replay, lazy storage migration and blob GC work in a plain-directory tracker without a Git executable. They need no Git repository. The eval command works without Git; preparing verified public source revisions needs Git and GitHub; repository changelog and release tooling also use Git.

## Environment and execution

Every command uses the host's TOON renderer by default and supports `--json`. `--model` overrides the saved default on `run`. Scope is a JSON object supporting exact `type`, `status`, `parent`, `tag` and `ids` predicates plus a case-insensitive `text` substring over the complete item. Predicates intersect; omitted predicates match all. Ledger call and generated question items are excluded from source context.

CLI numeric operands use unsigned decimal digits and must fit the settings bounds; signs, exponent/hex forms, fractions, surrounding whitespace and unsafe integers are input errors. All string operands must contain non-whitespace text. Nonblank questions, model names and scope JSON are preserved verbatim; JSON may contain its normal surrounding whitespace.

The exported environment works independently of the built-in loop:

```ts
import { createRlmContext, RlmError } from 'pm-rlm';

const ctx = await createRlmContext({
  workspace: '.agents/pm',
  scope: { type: 'Issue', status: 'open' },
  budget: 50000,
});

try {
  const candidates = ctx.search('coverage', 10);
  for (const item of candidates.data) {
    const evidence = ctx.get(item.id, ['title', 'acceptance_criteria', 'comments']);
    // Feed selected typed evidence to your own recursive loop.
    console.log(evidence.data, evidence.estimated_tokens);
  }
} catch (error) {
  if (!(error instanceof RlmError)) throw error;
  console.log(error.code); // e.g. budget, scope, incomplete
}
```

| Environment API | Data and budget behavior |
| --- | --- |
| `list(filter = {})` | Every matching full item from a certified snapshot |
| `search(query, limit)` | Explicitly bounded text matches from that complete snapshot |
| `get(id, fields = [])` | Selected fields; empty selection returns the full item |
| `history(id, {start, end})` | Verified append-only history in a half-open version range, capped at the snapshot timestamp |
| `peek(id, field, start, end)` | Half-open UTF-16 substring of text or serialized structured data |
| `partition(filter, maxTokens)` | Lossless JSON fragments packed into slices; each slice fits its advertised estimate |
| `remaining` | Remaining budget for this environment instance |

Each read returns `{data, estimated_tokens, complete_list}`. The certificate describes the complete source corpus before scope and selection. SDK read and history parsing failures become typed `incomplete` refusals. Incomplete scans fail closed; budget refusal never silently truncates a complete read. Returned objects are copies. Linked file/doc metadata and comments are available through `get`; arbitrary linked file contents are not opened. That keeps reads inside the selected tracker.

Token estimates use **one token per UTF-8 byte**, minimum one, as a conservative and reproducible accounting unit, not a model tokenizer. The estimate covers the operation's `data`; its receipt is control metadata. A slice's estimate covers the serialized fragments including ids and offsets, excluding the estimate field. A complete partition response must also fit the environment's remaining budget. Oversized items split into escaped JSON fragments with exact UTF-16 offsets; concatenate fragments in order to recover the original item. A budget too small for a fragment header refuses.

The built-in model loop is accessible through `runRlm(question, options)`, `resumeRlm(workspace, run)`, `replayRlm(workspace, run)` and `treeRlm(workspace, run, full)`. `RlmLedger`, `RlmEngine`, `reserveStep`, `promptDigest`, `estimateTokens`, typed contracts and errors are also exported for embedded tooling. Pass `question_item` to link an existing question; otherwise a generated question Task is created. `RlmEngine.spawn(parentId, subgoal, slice)` provides digest-based child reuse for custom orchestrators; custom orchestration must hold `ledger.lease(run)` for its entire read/modify/write sequence and await calls sequentially. `snapshot()` returns an independent state copy. The built-in runner acquires that lease automatically and reloads the checkpoint after acquisition.

Run and tree outputs include `token_usage: reported_or_estimated`: input/output counters come from the provider when supplied and conservative byte estimates otherwise. Reserved totals are accounting charges that also include pending worst-case reservations and delivered-read byte estimates. Call/depth counters are exact ledger values; settings numbers are configured limits. These values do not establish provider billing.

Implement `RlmModel` to supply a third-party model. Its `complete({prompt, max_output_tokens, context_tokens})` method returns `{text, tokens_in, tokens_out}` and its stable `name` is recorded in the ledger. The JSON action protocol supports `list`, `search`, `get`, `history`, `peek`, `partition`, `spawn`, and `finish`. For example:

```json
{"action":"search","query":"coverage","limit":5}
```

```json
{"action":"finish","answer":"3"}
```

The model receives the protocol, subgoal, selected slice and recorded observations. `partition` returns compact `{partition_step,index,estimated_tokens}` references in the model protocol. `spawn` takes `{subgoal,slice:{partition_step:0,index:0}}`, where the step is the zero-based transcript index of a successful partition. The engine resolves the reference to lossless authorized fragments without requiring the parent to copy their text. Explicit fragment slices are also accepted. The exported environment API continues to return full slices. Child tools can access only whole items completely represented by their slice; partial JSON fragments remain visible in the child prompt and can be subdivided for descendants. Invalid JSON, unknown actions, invalid ranges and denied reads become recorded refusals and consume a reserved model step. Depth, call count, total estimated tokens and per-prompt context all bound execution. There is no unrestricted shell, JavaScript execution, filesystem tool or hidden agent delegation.

Configure the model with the audited SDK settings API:

```ts
import { writeRlmSettings } from 'pm-rlm';

await writeRlmSettings('.agents/pm', {
  adapter: 'ollama',
  endpoint: 'http://localhost:11434',
  model: 'gemma4:e4b',
  max_depth: 3,
  max_calls: 32,
  budget_tokens: 300000,
  context_tokens: 32768,
  output_tokens: 512,
  timeout_ms: 120000,
}, 'my-agent');
```

`readRlmSettings` resolves defaults, the `rlm` section in workspace settings, then explicit overrides. The compatible adapter uses `adapter: 'openai'`, an endpoint ending in the provider's version prefix, and `key_env` naming an environment variable. It appends `/chat/completions`; Ollama appends `/api/generate`. Credentials are read only at request time and never put in settings. Endpoints cannot contain URL credentials, query strings or fragments. Remote OpenAI endpoints require HTTPS; loopback HTTP is allowed. Successful response bodies are capped at 8 MiB before JSON parsing, separately from the model output limit. Redirects are rejected before forwarding prompts, and non-OK bodies are canceled. Transport diagnostics omit raw responses, keys and paths; ledger creation and model-response checkpoints reject disclosure of the active scratch workspace or configured credential.

A model step reserves prompt bytes plus `16 × output_tokens` before inference. When validated usage arrives, the response, actual input-plus-output charge and `settled` marker are saved in the same atomic checkpoint, releasing the unused reservation. Pending steps keep one worst-case reservation across a crash; completed responses settle once and are never inferred again. The tree exposes `reserved_tokens` (settled usage plus pending allowance) and `used_tokens` per call. Delivered-read estimates remain charged separately, and the output byte ceiling remains enforced. A process can die between an HTTP response and its durable checkpoint; that unfinished inference may be repeated by resume. Its logical reservation is reused. Completed model outputs and terminal child outcomes are never inferred again. A typed child failure is checkpointed as a failure code, recorded in an `RLM refusal:` evidence comment, closed and released. Resume and replay accept that terminal refusal when its parent finishes successfully. This is not an exactly-once guarantee for a remote provider's billing. Observations are checked against the exact next prompt before charging, so oversized reads become recoverable tool refusals. Large complete reads and growing transcripts can legitimately hit the conservative context or total budget and refuse; use narrower filters, `get`, `peek`, suitable partitions and explicit limits.

`npm run test:live` is the once-only constrained cloud comparison on the original 24 tasks. Its exclusive marker refuses another invocation after inference starts. It verifies public repository visibility and a published revision, archives only tracked regular files from that revision, then copies the tracker with `cp -a` into a scratch project. Dirty and untracked local records are excluded; symlinks refuse evaluation. Extracted archive paths and bytes must match the verified Git blobs, so export-ignore or export-subst changes refuse evaluation. The copied workspace cannot select the transport: the harness explicitly uses Ollama at a validated loopback URL with no authorization header. Git replacement objects are disabled, including during tree, archive and blob verification. It never reads hosted data.

```sh
PM_RLM_LIVE_MODEL=glm-5.3:cloud PM_RLM_LIVE_BASE_URL=http://127.0.0.1:11434 npm run test:live
```

The seeded v2 design computes truth exactly through the SDK before inference. Its twenty-four questions include counts, UTF-8 field-length sums and id-valued argmax aggregations. Selection uses tracker truth and a fixed seed, with no model-output tuning. Each twelve-question source spans numeric ranges 1–9, 10–99, 100–999 and 1000+, includes id answers, and caps any answer at two occurrences. Both arms use the same local model, context allocation and output allowance. Stuffing selects complete items that fit and supplies a valid JSON array; its JSON answer envelope is parsed before exact scoring. Refusals and endpoint failures count as incorrect. Defaults are calibrated independently on synthetic long context to fit the protocol, two partitions and two child calls.

| Seeded v2 design audit | Result |
| --- | ---: |
| Questions / distinct answers | 24 / 21 |
| Numeric / id answers | 13 / 11 |
| Numeric range | 0–12196 |
| Most-common answer frequency and constant baseline | 2/24 (8.33%) |
| Zero frequency and constant baseline | 1/24 (4.17%) |
| Model measurements on v2 | Completed 24-question [v2 measurement](#v2-measurement): RLM 1/24, stuffing 1/24 |

Histogram: `4`, `pm-lint-8kis`, `pm-lint-trap` occur twice each; `0`, `1`, `32`, `68`, `167`, `208`, `277`, `1436`, `3154`, `3355`, `12196`, `pm-vcs-5m22`, `pm-vcs-6qva`, `pm-vcs-ag8y`, `pm-vcs-1v6x`, `pm-vcs-b7cb`, `pm-lint-1c6j`, `pm-lint-epic` occur once each. See [the design audit](docs/EVAL-DESIGN.md) and [exact questions and histogram](docs/eval-design.json). Run `node test/eval-design.ts` to audit public copies without inference. `PM_RLM_LIVE_MODEL` is passed unchanged to Ollama.

<!-- eval-table:start -->
**Invalidated by an instruction conflict.** The recorded questions requested a bare integer or id while both arms required JSON, so correct bare answers could be scored wrong; these numbers are retained for history and require a new measurement before interpretation.

Measured once with `glm-5.3:cloud` at a shared 131072 context allocation after two-phase settlement.

| Arm | Exact correct | Reported-or-estimated model tokens / question | Measured seconds / question | Observed model requests / question | Observed child reach |
| --- | ---: | ---: | ---: | ---: | ---: |
| RLM | 0/24 (0.00%) | 146296.92 | 183.78 | 19.17 | 0/24 |
| Complete-item stuffing | 0/24 (0.00%) | 18471.58 | 5.37 | 1.00 | — |

Most-common constant guess: 2/24 (8.33%). Constant zero: 1/24 (4.17%).

Outer refusal histograms: RLM {"budget":15,"model":9}; stuffing {"model":8}. Recorded RLM tool refusals: {"invalid":451}.

Provider-reported counters when present; conservative UTF-8 byte estimates otherwise. Per-response provenance was not retained, so totals are reported-or-estimated, not measured-only provider usage. Exact scoring, baselines, observed counts and corpus byte lengths are computed from recorded data; wall time is measured. Allocations and ceilings are configured limits. Both arms use the same model and 131072 context allocation, 512 output allocation and temperature 0. The conservative context estimator permits one UTF-8 byte per token, so effective provider context use can be lower than the configured ceiling. RLM limits are 300000 charged tokens, depth 2 and eight ledger calls. Wall time includes SDK work and concurrent host load. There is one invocation and no answer-based tuning, retries of the eval, or confidence interval. Refused runs count incorrect. Lost/unrecorded response counters cannot be included; pending reservations are shown separately. This does not establish an RLM advantage. See [the cloud evaluation report](docs/EVAL-CLOUD.md) and [per-question results](eval-results.json).

Historical superseded v1 small-model measurement: RLM 7/24, stuffing 2/24, child reach 0/24, constant zero 12/24. Its [original artifact](https://github.com/unbraind/pm-rlm/blob/aa3787b2c1a2d66ed784a4b0d824eb7341581bc0/eval-results.json) remains available. Those scores do not measure this design.
<!-- eval-table:end -->

Validation commands:

```sh
npm test
npm run coverage
node test/revert.ts
npm run test:install
PM_RLM_LIVE_MODEL=glm-5.3:cloud nice -n 10 npm run test:live
npm run release:check
bun run release:check
```

Regression subprocess limits use `PM_RLM_TEST_TIMEOUT_SCALE`, a positive finite multiplier (default `1`). For a CPU-saturated host, run `PM_RLM_TEST_TIMEOUT_SCALE=3 npm run release:check` (or `bun run release:check`). The ordinary per-regression limit remains 120000 ms and existing explicit limits (for example 300000 ms for crash proofs) scale by the same factor, as do the enclosing shallow-clone proof deadlines. A timed-out child stops validation with `timed out` and missing assertion evidence; it is never accepted or labelled as a regression proof. Genuine assertion failures are checked immediately without retries or waiting out the deadline.

`node test/sdk-boundaries-public.ts` is an optional public-corpus parity audit. It requires Git, tar, authenticated `gh` access for public provenance checks, and fleet-relative `fleet/pm-rlm` and `fleet/pm-lint` Git checkouts at the paths resolved by `publicSource` in `test/live.ts`. Fetch `origin/main` for pm-rlm and the pinned pm-lint revision `f2c20efa78139f4071f3dd08d317bea05337fe28`. The candidate production sources must match `origin/main`. In a standalone clone without those fixtures, the runner exits successfully with a clear `SKIP SDK public parity` message before setup or output writes; a skip supplies no parity evidence. Normal unit tests and the npm/Bun release gates work without fleet checkouts.

Coverage includes every authored source, script, entry point and ESLint configuration, with unchanged 100% statement, branch, function and line thresholds. The suite uses real scratch trackers built through the SDK; its scripted double replaces only the LM. SIGKILL recovery, exact budget refusal, depth/call limits, partition reconstruction, replay tamper detection, native TOON/JSON and credential/path privacy are verified. The behavioral revert proofs remove SDK read boundaries, fatal evidence-write classification, metric provenance labels and independent npm/Bun packed dispatch, as well as environment casing guards, CLI numeric/string/root validation, root-ancestor and Windows privacy matching, identity path matching and marker-based report replacement, as well as two-phase settlement, pre-response crash accounting, empty-response recovery, redirect rejection, rejected-body cancellation, typed replay observations, Git replacement isolation, checkpoint validation, transport byte and HTTPS guards, scope diagnostics, escaped privacy checks, verified archive checks and seeded answer caps, alongside the calibration, terminal child refusal, observation, scoped privacy, reservation, digest reuse and partition checks. Each regression must fail before exact source bytes are restored.

Exit codes: `0` success; `2` invalid command, scope, model, integrity, replay or executor-conflict failure; `3` exhausted token, depth or call budget. Tool-level refusals can be recovered within a run; an exhausted outer budget ends the command. `test:live` counts refused answers rather than presenting them as successes.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the ledger schema and resume invariants. The design follows the environment-and-recursion approach of [Recursive Language Models](https://arxiv.org/abs/2512.24601) by Alex L. Zhang, Tim Kraska and Omar Khattab (2025); the tracker ledger, reservations and recovery protocol are this package's implementation.

## v2 measurement

<!-- eval-v2:start -->
RLM v2 was not better than stuffing on this single fixed set.

| Arm | Correct | Tokens / question | Seconds / question | Requests / question |
| --- | ---: | ---: | ---: | ---: |
| RLM v2 | 1/24 | 231491.58 | 204.60 | 32.00 |
| Complete-item stuffing | 1/24 | 23623.29 | 6.70 | 1.00 |

Child reach: 0/24. Delivered reads: 0; delivered aggregates: 13. Delivered responses requiring envelope extraction: 10. Successful read-only replays: 1. Tool refusals: `{"invalid":754}`. Outer failures: RLM `{"budget":23}`; stuffing `{}`.

Most-common constant guess: 2/24; constant zero: 1/24. Omitted to conserve owner quota: another complete arm requires 24 additional cloud requests. See [the v2 report](docs/EVAL-V2.md).
<!-- eval-v2:end -->

## constrained measurement

<!-- eval-constrained:start -->
RLM constrained request scored higher on this single fixed set.

| Arm | Correct | Tokens / question | Seconds / question | Requests / question |
| --- | ---: | ---: | ---: | ---: |
| RLM constrained request | 2/24 | 237461.75 | 131.26 | 37.46 |
| Complete-item stuffing | 1/24 | 23630.46 | 8.94 | 1.00 |

Child reach: 0/24. Delivered reads: 1; delivered aggregates: 13. Delivered responses requiring envelope extraction: 8. Successful read-only replays: 2. Tool refusals: `{"invalid":883}`. Outer failures: RLM `{"budget":22}`; stuffing `{}`.

Most-common constant guess: 2/24; constant zero: 1/24. Omitted to conserve owner quota: another complete arm requires 24 additional cloud requests. See [the constrained report](docs/EVAL-CONSTRAINED.md).
<!-- eval-constrained:end -->

## Answer evidence coverage

Declare the parts of a question with `--components` (a JSON array of unique
names), or `runRlm(question, { workspace, components })`. Every successfully completed recursive call
returns each declared component exactly once, in declaration order, as
`supported`, `unsupported`, or `unknown`. Legacy runs without declarations keep
the execution-only contract; the evidence command refuses to certify them.
A call that terminates in a typed refusal before producing an answer returns no
components. A completion-hook refusal preserves an answer already recorded in
the ledger.

```sh
pm rlm run 'Give the title and explain its cause' \
  --components '["title","cause"]' --scope '{"ids":["item-id"]}' --json
pm rlm evidence run-id --json
pm rlm evidence run-id
```

The model requests a `witness` action with an item id and a nonempty UTF-16
`start`/`end` range in the item's JSON representation. Each witness contains at
most 1024 UTF-8 bytes and a SHA-256 digest binding its id, offsets, and exact
text. An `answer` action supplies a nonempty answer and 1–8 distinct prior
witness step/digest references for each supported component. Unsupported and
unknown components require an empty answer, no witnesses, and a reason.
There are at most 16 components (256 bytes per name) and 32768 bytes in the
complete component answer. Unchecked free-text `finish` actions are refused.
Children inherit declarations and must acquire their own witnesses from full
items in their authorized slice; a child result alone cannot support a parent.

Replay verifies every witness, including unused ones, against the frozen
snapshot. Missing observations, wrong digests, missing components and unsupported
claims cannot establish coverage. `pm rlm evidence` performs read-only replay
with **zero model calls**, returning compact counts and component references in
native TOON or JSON. `RlmEvidenceError` exposes code `evidence` and a `remedy`;
model refusals carry both reason and remedy. CLI refusals print the remedy and
exit 2; existing resource-limit refusals retain exit 3.

Coverage certifies declared component coverage and source provenance. It does
not prove that an excerpt semantically entails the answer, or that the caller
declared every part of the natural-language question. See the
[SDK and protocol example](docs/ANSWER-EVIDENCE.md) and
[measured public-tracker acceptance](docs/answer-evidence-validation.json).

## Without git

Run, resume, replay, tree and evidence inspection work with plain-directory
trackers and require no git executable. The SDK's optional `source_workspace`
reads a separate source tracker without writing it; `workspace` receives the
ledger. This captures source items only; history actions use the ledger tracker.
Git is used only by development workflows that select committed public
revisions for reproducible validation.

## Adaptive decomposition with declared budgets

`adaptiveRlm(question, { workspace, structure, remaining_tokens })` compares
whole-question, paired-part and individual-part strategies without model calls,
then executes the selected plan through the native RLM engine. Each declared
part is `{name, question}`. Native reservations, one frozen certified source
snapshot, witnessed component answers and total call limits bound execution.
There is no automatic training or promotion.

```sh
pm rlm adaptive 'Explain the issues' \
  --structure '[{"name":"summary","question":"What do they describe?"},{"name":"cause","question":"Which causes are established?"}]' \
  --budget-tokens 50000 --max-calls 6 --json
```

Zero or tiny budgets return typed partial receipts with deferred components,
stop reasons and remedies, without inference. Failed children retain terminal
ledger evidence. TOON/JSON output contains compact statuses and child run ids;
full answers stay in the child ledgers. This command also works without Git.
See the [SDK example, strategy rules and recovery boundaries](docs/ADAPTIVE-DECOMPOSITION.md)
and [public-tracker measurements](docs/adaptive-validation.json).

## Disagreement-guided answer reconciliation

`reconcileRlm` and `pm rlm reconcile` compare two explicitly budgeted recursive
decompositions against one immutable certified input boundary. The result keeps
both answers, witness citations and native costs, labeling each component
`disagreement`, `equal_text` or `unresolved`. Matching answers never establish
truth. Fixed arm allowances and reserved future group floors keep execution
within the caller's reservation; comparison adds no inference.

```sh
pm rlm reconcile 'Explain the documented incident' \
  --plan "$(cat examples/reconciliation-plan.json)" --budget-tokens 200000 --json
```

Native TOON is the default. The typed SDK, partial receipts, remedies and
[CLI plan example](examples/reconciliation-plan.json) are described in the
[reconciliation guide](docs/RECONCILIATION.md). Reconciliation also works without
Git, using a separate read-only source tracker when requested.

## Measured public tracker evaluation

`pm rlm eval suite.json --sources '{"sample":"copies/sample/pm"}' --id trial-1 --model gemma3:4b --json` compares the native recursive engine with a truncated single-call baseline using the same installed local Ollama model. A reviewed suite contains at least twenty exact questions and gold answers bound to complete public source snapshots. Gold answers never enter model prompts. Default TOON/JSON is compact; `--full` includes every paired observation. The SDK exports `evaluateRlm`, suite/result types and `RlmEvalError` with remedies.

See the [24-question suite](docs/public-eval-suite.json), [methodology and SDK example](docs/PUBLIC-EVALUATION.md) and [measured results](docs/public-eval-results.json). Failed or interrupted attempts remain in the denominator, and unavailable usage is explicitly unknown. Unobserved child counts are `null` in typed SDK results, including reused interrupted receipts; native CLI JSON and TOON render missing counters as `"unknown"` so host null compaction cannot hide them. Each arm summary reports unknown `children` if any count is unknown, plus `unknown_children_arms` with the number of such arms; observed zero-child arms remain `0`. Reusing an evaluation ID preserves completed evidence without repeating inference. Historical invalidated measurements remain separate.

The completed local `functiongemma:270m` trial scored 0/24 in both arms: truncated 53125 reported-or-estimated tokens, 24 requests, 28.542 seconds; recursive engine 521496 tokens, 384 requests, 386.805 seconds, zero children. All refusals remain in the denominator. This single small-model result does not establish an RLM advantage; see the methodology for limits and source provenance.

## Reuse a verified subanswer across runs

Opt in **before the original inference** by supplying `reuse_identity` to
`runRlm`, or `--identity` to `pm rlm run`. Its three opaque identities name the
exact tool policy, pinned model policy and consent revision. Each is 1–128 ASCII
letters, digits or `_.:/+-`, beginning with a letter or digit. The caller owns
these revisions: change them when model weights, tool permissions, authorization
or consent change. Reuse never infers consent from public visibility. Opted-in
runs use snapshot-only reads; live history access is refused. Each opted-in
model request rechecks its transport name against the settings read inside the
run lease, so a peer cannot relabel inference with changed model settings.

```sh
pm rlm run 'Count the scoped issues' --scope '{"type":"Issue"}' \
  --identity '{"tool_policy":"snapshot-v1","model_policy":"pinned-model-v1","consent":"public-review:1"}' --json
pm rlm reuse 'Count the scoped issues' --from original-run --call original-call \
  --scope '{"type":"Issue"}' \
  --identity '{"tool_policy":"snapshot-v1","model_policy":"pinned-model-v1","consent":"public-review:1"}' --json
```

Supply the same model and execution settings as the original run, including any
nondefault limits. `reuseRlm(question, {workspace, selection: {run, call}, scope,
settings, reuse_identity})` is the typed SDK equivalent. Select either the
original root or a recursive child. The exact question must equal that call's
subgoal. Scope predicates, settings, parser/aggregate versions and all three
identity strings must match. Object property order is immaterial; question text,
array order, whitespace and source revision fields are exact SDK values. Questions
are nonblank and at most 4096 Unicode code points; each scope string is 1–4096
code points and
`ids` is a dense array of at most 10000 strings. Unknown fields, holes, coercions
and counters outside 0–1000000000 refuse at the boundary. Completed call counts
are 1–1000000000; reused results require exactly one logical call and zero new
usage. Every emitted accounting coordinate is validated before success.

Every reuse reads the native creation checkpoint through the SDK to prove that
opt-in and the source contract predate inference. Imported completed answers and
retroactively added consent refuse. It authenticates call digests and recorded
model prompts (including question, depth, slice and evidence declarations),
replays the original graph before creating a new native run, then revalidates
its captured source dependencies before checkpoint publication. A
root depends on every item in its scoped snapshot, including membership. A child
depends conservatively on the complete SDK row for each supplied fragment,
including revision metadata and relationships. Changing an unrelated row does
not invalidate that child. Changed, missing or unreadable dependencies refuse;
there is no automatic fallback to paid inference. Existing reused runs retain
their frozen snapshot when live sources later change.

Success has `status: reused` and `model_calls: 0`. New `tokens_in`, `tokens_out`
and `reserved_tokens` are zero. `calls: 1` describes the new logical root, not a
model request. `reuse` names the original run/call, checkpoint, call, scope,
snapshot and policy digests, plus the selected subtree's original model counters
and settled/reserved step charge. Those original counters are informational and
are never added to the new run. Resume and replay verify this provenance again;
the original complete tracker, blobs and history must remain available. Reusing
an already reused run is deliberately refused: select the original call instead.
Replay verifies execution and source provenance, not semantic entailment or
provider billing. Legacy runs without recorded opt-in cannot be reused.

Default CLI TOON/JSON includes the provenance, a SHA-256 answer digest, byte count
and at most 160 UTF-16 units of answer preview; `answer_complete` reports whether
the preview is the whole answer. `--full` returns the answer and any evidence
components. SDK results retain the complete answer. Foreign records return
`status: skipped`, `reason: foreign`, and a remedy without mutation. Other
refusals are `RlmReuseError` with a stable `code`, `dimension`, and `remedy`;
CLI refusals exit nonzero and include the remedy. A target completed by a peer
with new inference or a different verified origin is returned as `peer_completed`
with its actual usage and provenance. If a peer changes the original target
scope, identities or selection intent, the result is `skipped` with only the
target id and remedy; its answer and provenance are withheld. A started target
is never overwritten. Source and target leases serialize package writers, and checkpoint
publication uses the native SDK compare-and-set. The initial checkpoint records
the selected origin as durable intent: interrupted reuse resumes by revalidating
the source and target, and never falls back to inference. The SDK can also
prepare this intent with `prepareRlmRun` and `reuse_selection`; reuse sources
must be in the same tracker. Creation history also preserves intent when a
later checkpoint loses its selection flag. `RlmLedger.load(run, '1')` exposes
the read-only creation checkpoint; historical reads never grant write authority.
No source path is persisted.

This command, its checkpoint round trips, resume and replay work **without Git**.
No answer cache, discovery index, new sync format or background promotion exists.
Copy the whole tracker for transport, as described in the ledger storage section.
The [public-data example](examples/verified-subanswer-reuse.ts) extracts committed
public tracker bytes into a disposable non-git directory, runs a deterministic
protocol fixture, changes one copied source revision and measures dependent
refusal and independent reuse. Build with `npm run build`, then run `node examples/verified-subanswer-reuse.ts`
from a checkout containing `origin/main`. Its report makes no inference-quality
claim and fingerprints the original archive before and after.

Every workflow job granted write permissions, including CodeQL, Dependabot and
reusable workflow calls, requires the exact repository `unbraind/pm-rlm`.
The approval variable controls GitHub releases; it does not impose a local npm
publishing hold. Maintainers run the prepublish checks and authenticate with npm
for local publication. The first local publish uses `--provenance=false`; daily
GitHub OIDC releases keep provenance enabled.
