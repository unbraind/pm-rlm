import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import type { RlmAnswerReport } from '../src/answer-contract.ts';

/** Exercise shipped SDK producers and every host transport on the exact packed distribution. */
export function verifyPackedInvariants(project: string, script: (args: string[]) => string, transports: ((args: string[]) => string)[]): void {
  writeFileSync(join(project, 'invariants-fixture.mjs'), `import { PmClient } from '@unbrained/pm-cli/sdk';
import { verifyRlmAnswer, parseAnswerContract } from 'pm-rlm';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const client = new PmClient({ pmRoot: process.env.PM_PATH, noExtensions: true });
const item = (await client.create({ title: 'Packed invariant source', parent: 'none', assignee: 'none', sprint: 'none', release: 'none' })).item;
const environment = await client.listAllComplete({ includeBody: true });
const contract = parseAnswerContract({ version: 'answer-invariants-v1', answer: 'One cited source.', scope: { ids: [item.id] }, checks: [
  { id: 'count', kind: 'count', filter: {}, expected: 1 },
  { id: 'member', kind: 'membership', filter: {}, field: 'id', value: item.id, expected: 'present' },
  { id: 'equal', kind: 'equals', item: item.id, field: 'title', expected: item.title }
] });
assert.equal((await verifyRlmAnswer(contract, { environment })).status, 'passed');
writeFileSync('invariants-environment.json', JSON.stringify(environment));
writeFileSync('invariants-contract.json', JSON.stringify(contract));
writeFileSync('invariants-false.json', JSON.stringify({ ...contract, checks: [{ ...contract.checks[0], expected: 99 }] }));
`);
  script(['invariants-fixture.mjs']);
  for (const invoke of transports) {
    for (const format of [[], ['--json']]) {
      const output = invoke(['rlm', 'verify-answer', 'invariants-contract.json', '--environment', 'invariants-environment.json', ...format]);
      const report = (format.length === 0 ? decodeToon(output) : JSON.parse(output)) as RlmAnswerReport;
      assert.equal(report.status, 'passed'); assert.equal(report.checks.length, 3);
      assert.equal(report.answer.verification, 'not_evaluated'); assert.equal(report.model_calls, 0); assert.equal(report.writes, 0);
      assert.ok(Buffer.byteLength(output) < 3000);
    }
    const failed = JSON.parse(invoke(['rlm', 'verify-answer', 'invariants-false.json', '--environment', 'invariants-environment.json', '--json'])) as RlmAnswerReport;
    assert.equal(failed.status, 'failed'); assert.equal(failed.source.status, 'complete'); assert.equal(failed.checks[0].actual, 1);
  }
}
