# Component evidence example

```ts
import { runRlm, evidenceRlm, RlmEvidenceError } from 'pm-rlm';

try {
  const result = await runRlm('Give the title and explain its cause', {
    workspace: ledgerTracker,
    source_workspace: readOnlySourceTracker,
    scope: { ids: ['item-id'] },
    components: ['title', 'cause'],
    model,
  });
  const report = await evidenceRlm(ledgerTracker, result.run);
  console.log(report.supported, report.unsupported, report.unknown);
} catch (error) {
  if (error instanceof RlmEvidenceError) console.log(error.code, error.remedy);
  else throw error;
}
```

`ledgerTracker`, `readOnlySourceTracker` and `model` are supplied by the caller.
The model receives a protocol with the immutable declarations and can first
issue this bounded source action:

```json
{"action":"witness","id":"item-id","start":0,"end":100}
```

Use actual offsets within the JSON-serialized item; an out-of-range request is
refused. The observation contains `data: {id,start,end,text,digest}`, the charged
`estimated_tokens`, and a complete-list certificate. Copy its exact digest into
the final action. For example, when step 0 establishes the title but the source
does not establish causality:

```json
{
  "action": "answer",
  "components": [
    {
      "component": "title",
      "status": "supported",
      "answer": "The witnessed title",
      "reason": "",
      "witnesses": [{"step": 0, "digest": "COPY_THE_ACTUAL_64_HEX_DIGEST"}]
    },
    {
      "component": "cause",
      "status": "unsupported",
      "answer": "",
      "reason": "The selected sources do not establish a cause",
      "witnesses": []
    }
  ]
}
```

Use `unknown` when the component has not been established, and `unsupported`
when the selected sources do not support it. Neither status asserts a negative
answer about the world. The engine renders `answer` as the canonical JSON
component array and exposes that same typed array as `result.components`.
The evidence report omits source text and transcript prompts; exact excerpts
remain in the durable ledger (`pm rlm tree run-id --full`). References are local
to each call. A parent must request its own source witness even after a child
has returned a supported result.

`sourceWitness(items, id, start, end)` is also exported for independent SDK loops.
Constructing a witness with that helper does not make it eligible evidence in
an engine run: the model must have received it through a successful earlier
`witness` step. Validation uses deterministic source reads and SHA-256 only.
There is no inference-based judge or hidden provider request.

Run `node test/evidence-public.ts` to reproduce the offline public-tracker
acceptance. It verifies the source repository's public visibility and pinned
revision, copies committed tracker files to a plain directory, makes the source
files read-only, writes an independent scratch ledger, runs with git absent from
PATH, and checks all source file bytes afterward. The deterministic protocol
fixture uses real public data and makes no external inference calls; it measures
contract acceptance, not model quality. Its sanitized measurements are in
`docs/answer-evidence-validation.json`.
