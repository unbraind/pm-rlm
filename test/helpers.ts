import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { PmClient } from '@unbrained/pm-cli/sdk';
import type { ModelRequest, ModelResponse, RlmModel } from '../src/types.ts';

/** Make a real SDK tracker with cleanup registered before initialization. */
export async function tracker(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rlm-test-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const workspace = join(root, '.agents', 'pm');
  const client = new PmClient({ cwd: root, pmRoot: workspace, author: 'rlm-test', noExtensions: true });
  await client.init('rlm-test', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  return { root, workspace, client };
}
/** Deterministic LM double only; all tracker operations still use the real SDK. */
export class ScriptedModel implements RlmModel {
  name = 'scripted-test-only';
  requests: ModelRequest[] = [];
  private readonly respond: (request: ModelRequest, index: number) => string | Promise<string>;
  /** Receive a response function whose only input is the real model request. */
  constructor(respond: (request: ModelRequest, index: number) => string | Promise<string>) { this.respond = respond; }
  /** Record exact requests and provide deterministic usage derived from bytes. */
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const index = this.requests.length;
    this.requests.push(request);
    const output = await this.respond(request, index);
    return { text: output, tokens_in: Buffer.byteLength(request.prompt), tokens_out: Buffer.byteLength(output) };
  }
}

/** Fork a real recovery worker with coverage inheritance and explicit tracker arguments. */
export function crashProcess(script: string, workspace: string, mode: string, log: string, run = '') {
  return fork(join(import.meta.dirname, script), [workspace, mode, log, run], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, NODE_TEST_CONTEXT: '' } });
}
/** Kill precisely after the worker announces a durable checkpoint, then verify signal termination. */
export async function killAtCheckpoint(t: TestContext, child: ChildProcess): Promise<{ run: string }> {
  t.after(() => { child.kill('SIGKILL'); });
  const [message] = await once(child, 'message') as [{ run: string }];
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  assert.deepEqual(await exit, [null, 'SIGKILL']);
  return message;
}
