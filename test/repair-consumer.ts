import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import type { RlmRepairResult } from '../src/repair-contract.ts';

/** Exercise current-budget admission through the installed SDK and every supplied real host. */
export function verifyPackedRepairBudget(repository: string, consumer: string, artifact: string, runtime: (args: string[], workspace: string) => string, hosts: ((args: string[], workspace: string) => string)[]): void {
  const project = join(consumer, 'isolated-repair');
  mkdirSync(project);
  const workspace = join(project, '.agents', 'pm');
  hosts[0](['init', '--prefix', 'repair-consumer', '--defaults', '--agent-guidance', 'skip'], workspace);
  hosts[0](['package', 'install', artifact], workspace);
  const script = 'repair-budget-consumer.ts';
  const source = readFileSync(join(repository, 'test', script), 'utf8');
  assert.equal(source.split("'../index.ts'").length, 3);
  writeFileSync(join(consumer, script), source.replaceAll("'../index.ts'", "'pm-rlm'"));
  const baselines = JSON.parse(runtime([script], workspace)) as RlmRepairResult[];
  assert.equal(baselines.length, 4);
  assert.equal(baselines[0].reused, 1); assert.equal(baselines[0].components[2].reason, 'budget');
  for (const baseline of baselines) for (const host of hosts) for (const json of [false, true]) {
    const output = host(['rlm', 'repair-resume', baseline.run, ...(json ? ['--json'] : [])], workspace);
    const receipt = (json ? JSON.parse(output) : decodeToon(output)) as RlmRepairResult;
    assert.equal(receipt.status, 'partial'); assert.deepEqual(receipt.gaps, baseline.gaps);
    assert.deepEqual(receipt.components.map(part => [part.component, part.status, part.reason]), baseline.components.map(part => [part.component, part.status, part.reason]));
    assert.equal(receipt.reused, baseline.reused); assert.equal(receipt.budget.remaining, 0);
    for (const part of receipt.components) if (part.status !== 'supported') { assert.equal(part.disposition, 'gap'); assert.ok(part.remedy.length > 0); }
  }
}
