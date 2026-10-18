# pm-rlm

pm is context management for agents. Recursive Language Models keep a large context in an environment, inspect it through tools, delegate subgoals, and compose the results. `pm-rlm` makes a pm workspace that environment and its durable execution ledger. Each recursive call is a visible Task with its parent, model, digest, usage, claim and result evidence.

This package is **unreleased**. Publication needs maintainer approval; the release workflow has no schedule and is guarded by `PM_RLM_RELEASE_ENABLED`. The deterministic model exists only in the test suite. Model weights are not bundled.

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

The host requires Node 22.18 or newer. npm/npx and Bun/bunx packed consumers are verified by `npm run test:install`. `pm package install` performs extension discovery; npm or Bun dependency installation alone is not the activation step.

| Command | Example | Result |
| --- | --- | --- |
| `run` | `pm rlm run "Count open Issues" --scope '{"type":"Issue"}' --max-depth 3 --max-calls 32 --budget-tokens 300000` | Answer, run id, calls, reservations and measured usage |
| `tree` | `pm rlm tree run-id` | One compact row per call: parent, depth, status, tokens and result excerpt |
| `tree --full` | `pm rlm tree run-id --full --json` | Entire ledger checkpoint, including snapshot and recorded outputs |
| `resume` | `pm rlm resume run-id` | Recovered answer; completed digests and recorded model responses are reused |
| `replay` | `pm rlm replay run-id --json` | Re-executed recorded actions and verified byte-identical answer, without inference or writes |

Every command uses the host's TOON renderer by default and supports `--json`. `--model` overrides the saved default on `run`. Scope is a JSON object supporting exact `type`, `status`, `parent`, `tag` and `ids` predicates plus a case-insensitive `text` substring over the complete item. Predicates intersect; omitted predicates match all. Ledger call and generated question items are excluded from source context.

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

Each read returns `{data, estimated_tokens, complete_list}`. The certificate describes the complete source corpus before scope and selection. Incomplete scans fail closed; budget refusal never silently truncates a complete read. Returned objects are copies. Linked file/doc metadata and comments are available through `get`; arbitrary linked file contents are not opened. That keeps reads inside the selected tracker.

Token estimates use **one token per UTF-8 byte**, minimum one, as a conservative and reproducible accounting unit, not a model tokenizer. The estimate covers the operation's `data`; its receipt is control metadata. A slice's estimate covers the serialized fragments including ids and offsets, excluding the estimate field. A complete partition response must also fit the environment's remaining budget. Oversized items split into escaped JSON fragments with exact UTF-16 offsets; concatenate fragments in order to recover the original item. A budget too small for a fragment header refuses.

The built-in model loop is accessible through `runRlm(question, options)`, `resumeRlm(workspace, run)`, `replayRlm(workspace, run)` and `treeRlm(workspace, run, full)`. `RlmLedger`, `RlmEngine`, `reserveStep`, `promptDigest`, `estimateTokens`, typed contracts and errors are also exported for embedded tooling. Pass `question_item` to link an existing question; otherwise a generated question Task is created. `RlmEngine.spawn(parentId, subgoal, slice)` provides digest-based child reuse for custom orchestrators; custom orchestration must hold `ledger.lease(run)` for its entire read/modify/write sequence and await calls sequentially. `snapshot()` returns an independent state copy. The built-in runner acquires that lease automatically and reloads the checkpoint after acquisition.

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

`readRlmSettings` resolves defaults, the `rlm` section in workspace settings, then explicit overrides. The compatible adapter uses `adapter: 'openai'`, an endpoint ending in the provider's version prefix, and `key_env` naming an environment variable. It appends `/chat/completions`; Ollama appends `/api/generate`. Credentials are read only at request time and never put in settings. Endpoints cannot contain URL credentials, query strings or fragments. Transport diagnostics omit raw responses, keys and paths; ledger creation and model-response checkpoints reject disclosure of the active scratch workspace or configured credential.

A model step reserves prompt bytes plus `16 × output_tokens` before inference. The output byte ceiling is enforced, and reservations are not refunded. Provider-reported tokens are retained separately. A process can die between an HTTP response and its durable checkpoint; that unfinished inference may be repeated by resume. Its logical reservation is reused. Completed model outputs and terminal child outcomes are never inferred again. A typed child failure is checkpointed as a failure code, recorded in an `RLM refusal:` evidence comment, closed and released. Resume and replay accept that terminal refusal when its parent finishes successfully. This is not an exactly-once guarantee for a remote provider's billing. Observations are checked against the exact next prompt before charging, so oversized reads become recoverable tool refusals. Large complete reads and growing transcripts can legitimately hit the conservative context or total budget and refuse; use narrower filters, `get`, `peek`, suitable partitions and explicit limits.

`npm run test:live` verifies public repository visibility and a published revision, archives only tracked regular files from that revision, then copies the tracker with `cp -a` into a scratch project. Dirty and untracked local records are excluded; symlinks refuse evaluation. The copied workspace cannot select the transport: the harness explicitly uses Ollama at a validated loopback URL with no authorization header. It never reads hosted data.

```sh
PM_RLM_LIVE_MODEL=gemma4-local:e2b-q3km PM_RLM_LIVE_BASE_URL=http://127.0.0.1:11434 npm run test:live
```

Twenty-four questions cover type/status counts, acceptance-criterion substrings and the Epic with most closed direct children. Truth is computed exactly through the SDK before inference. Both arms use the same local model, context allocation and output allowance. Stuffing selects complete items that fit and always supplies a valid JSON array; its explicit JSON answer envelope is parsed before exact scoring. RLM refusals and endpoint failures count as incorrect. This is one deterministic-temperature run per question, not a statistical performance claim. Defaults are calibrated independently on synthetic long context to fit the protocol, two partition operations and two child calls; they do not guarantee that a model chooses recursion or answers correctly.

<!-- eval-table:start -->
Model: `gemma4-local:e2b-q3km`; 32768 context tokens, 512 output tokens, temperature 0, one run per question, 24 questions. RLM limits: 300000 estimated tokens, depth 2, 8 ledger calls. Source snapshots: pm-vcs 145 items / 814268 JSON bytes; pm-lint 12 items / 54941 JSON bytes. Published revision hashes are recorded in the artifact. Ollama reported GPU execution during the run.

| Arm | Accuracy | Provider tokens / question | Model requests / question | Wall seconds / question |
| --- | ---: | ---: | ---: | ---: |
| RLM | 7/24 (29.17%) | 14151.71 | 10.58 | 67.60 |
| Complete-item context stuffing | 2/24 (8.33%) | 9998.92 | 1.00 | 41.72 |

RLM had 8 outer budget refusals, all counted incorrect. **0/24 runs reached a child call**: there were 24 ledger roots and 254 model requests. The independent synthetic calibration test successfully executes two partitions and two children, but this small model's measured runs do not establish recursive aggregation quality. Twelve ground truths are zero; a constant-zero answer would match 12/24, outperforming both measured arms. These results do **not** establish an RLM advantage.

All per-question averages include failures. Provider usage is separate from conservative byte reservations. Wall time includes SDK ledger overhead and concurrent host load; the arms ran sequentially, stuffing first. Results are single-run measurements with no confidence interval. See [eval-results.json](eval-results.json) for source revisions, exact truth, usage, calls, timing and response digests; raw source content and model responses are not published.
<!-- eval-table:end -->

Validation commands:

```sh
npm test
npm run coverage
node test/revert.ts
npm run test:install
npm run test:live
npm run release:check
bun run release:check
```

Coverage includes every authored source, script, entry point and ESLint configuration, with unchanged 100% statement, branch, function and line thresholds. The suite uses real scratch trackers built through the SDK; its scripted double replaces only the LM. SIGKILL recovery, exact budget refusal, depth/call limits, partition reconstruction, replay tamper detection, native TOON/JSON and credential/path privacy are verified. The behavioral revert proofs remove the calibrated eval limits, terminal child refusal, projected observation and scoped privacy guards as well as the reservation guard, digest reuse and partition budget check separately and require the regression to fail before restoring exact source bytes.

Exit codes: `0` success; `2` invalid command, scope, model, integrity, replay or executor-conflict failure; `3` exhausted token, depth or call budget. Tool-level refusals can be recovered within a run; an exhausted outer budget ends the command. `test:live` counts refused answers rather than presenting them as successes.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the ledger schema and resume invariants. The design follows the environment-and-recursion approach of [Recursive Language Models](https://arxiv.org/abs/2512.24601) by Alex L. Zhang, Tim Kraska and Omar Khattab (2025); the tracker ledger, reservations and recovery protocol are this package's implementation.
