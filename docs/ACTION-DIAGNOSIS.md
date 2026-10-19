# Action diagnosis before v2

The PR #2 cloud run recorded 451 `invalid` observations and zero delivered reads. Its `test/live.ts` deleted the scratch tracker in `finally`; the published artifacts keep only SHA-256 output digests. The cloud response strings are unavailable. A hash cannot establish whether the failures were fences, prose, reasoning, multiple objects, wrong keys or bare answers. No cloud shape count is inferred from tracker descriptions.

| Evidence | Exact retained output or shape | Count | Diagnosis |
| --- | --- | ---: | --- |
| Historical glm-5.3 cloud run | Response strings unavailable; hashes only | 451 invalid observations | Cannot classify parser versus model shape failures |
| Older surviving local-model ledger (`gemma4-local:e2b-q3km`) | `{"action":"finish","answer":0}` | 6 | Wrong answer type; remains a refusal under the unchanged string answer schema |
| Historical question/protocol pair | Question: `Answer only the integer or id.`; protocol: `Return ONLY one JSON action per response.` | All 24 questions | Prompt conflict; main already removed the question suffix before v2 |

Regression tests preserve the exact retained numeric-answer shape. Fence, prose, reasoning, duplicate-key, multiple-object and truncation cases are synthetic boundary tests, not reconstructed glm outputs. v2 retains exact new responses in an ignored local artifact. The short workspace-free first response is also preserved in `test/fixtures/glm-5.3-orphan-think.txt`; full workspace bodies are not published. Its report adds observed new shapes after the single authorized run.

The parser extracts the first balanced JSON object, respecting escaped quotes and braces inside strings. It ignores presentation fences/prose and removes complete reasoning blocks outside the object. It refuses multiple objects, array envelopes, duplicate keys, truncated objects and unterminated reasoning. It never repairs key names, coerces numbers into answers, or changes the existing action operand schema. A failed step remains charged; the next prompt includes the typed refusal and specific reason.

## New v2 response shape

The first new cloud response is preserved byte-for-byte in the text fixture. Its structure is prose, a count JSON example, more prose, an unmatched closing `</think>`, and a second identical count object. It contains no workspace body or truth answer. The strict parser refuses the two candidates and unmatched delimiter. A regression also demonstrates that prepending an explicit opening `<think>` boundary makes the exact same response parse: its reasoning/example is then unambiguously outside the final action. The final report provides counts from the complete frozen run. This new evidence does not reconstruct the deleted historical strings.

The production parser and protocol remain unchanged throughout measurement. Provider output with an implicit reasoning start remains an explicit limitation; inferring a missing boundary would loosen the requested ambiguity refusal. The existing compliance follow-up tracks transport-level reasoning separation.
