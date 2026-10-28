import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import type { RlmRepairResult } from '../src/repair-contract.ts';

/** Exercise current-budget admission through the installed SDK and every supplied real host. */
export function verifyPackedRepairBudget(repository: string, consumer: string, runtime: (args: string[]) => string, hosts: ((args: string[]) => string)[]): void {
  const script = 'repair-budget-consumer.ts';
  const source = readFileSync(join(repository, 'test', script), 'utf8');
  assert.equal(source.split("'../index.ts'").length, 3);
  writeFileSync(join(consumer, script), source.replaceAll("'../index.ts'", "'pm-rlm'"));
  const baseline = JSON.parse(runtime([script])) as RlmRepairResult;
  for (const host of hosts) for (const json of [false, true]) {
    const output = host(['rlm', 'repair-resume', baseline.run, ...(json ? ['--json'] : [])]);
    const receipt = (json ? JSON.parse(output) : decodeToon(output)) as RlmRepairResult;
    assert.equal(receipt.status, 'partial'); assert.deepEqual(receipt.gaps, baseline.gaps);
    assert.deepEqual(receipt.components.map(part => [part.component, part.status, part.reason]), baseline.components.map(part => [part.component, part.status, part.reason]));
    assert.equal(receipt.reused, 1); assert.equal(receipt.budget.remaining, 0);
    assert.equal(receipt.components[2].reason, 'budget');
  }
}
