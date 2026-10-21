import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileIfExists, removeFileIfExists, writeFileAtomic } from '@unbrained/pm-cli/sdk';
import { record, RlmError, sdkRead, text } from './errors.ts';
import type { RlmState } from './types.ts';

/** SHA-256 over the exact UTF-8 JSON bytes stored on disk. */
export function blobDigest(bytes: string): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Immutable payload store; callers hold the ledger storage lock across publication or collection. */
export class RlmBlobs {
  private readonly directory: string;
  private readonly cache = new Map<string, unknown>();
  /** Digests read during this operation, used to mark the complete reachable graph. */
  readonly reachable = new Set<string>();
  /** Keep durable blobs outside runtime/cache directories, so tracker backups include them. */
  constructor(workspace: string) { this.directory = join(workspace, 'rlm-blobs'); }
  /** Resolve a validated digest without allowing path traversal. */
  private path(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new RlmError('incomplete', 'Invalid ledger blob digest');
    return join(this.directory, `${digest}.json`);
  }
  /** Verify existing bytes before reuse; a corrupt immutable blob must never be silently repaired. */
  async put(value: unknown): Promise<string> {
    const bytes = JSON.stringify(value);
    const digest = blobDigest(bytes);
    const path = this.path(digest);
    const previous = await sdkRead(() => readFileIfExists(path));
    if (previous === null) await writeFileAtomic(path, bytes);
    else if (previous !== bytes) throw new RlmError('incomplete', 'Ledger blob digest mismatch');
    return digest;
  }
  /** Read and hash before parsing; cache only verified bytes for this locked operation. */
  async get(reference: unknown): Promise<unknown> {
    const digest = text(reference);
    const path = this.path(digest);
    this.reachable.add(digest);
    if (this.cache.has(digest)) return this.cache.get(digest);
    const bytes = await sdkRead(() => readFileIfExists(path));
    if (bytes === null || blobDigest(bytes) !== digest) throw new RlmError('incomplete', 'Ledger blob is missing or corrupt');
    const value: unknown = JSON.parse(bytes);
    this.cache.set(digest, value);
    return value;
  }
  /** Encode independent payloads once; reservations remain exclusively in the atomic root manifest. */
  async encode(state: RlmState): Promise<string> {
    const { snapshot, calls, reserved_tokens, ...metadata } = state;
    const snapshotRef = await this.put(snapshot);
    const storedCalls = [];
    for (const call of calls) {
      const { slice, steps, ...header } = call;
      const storedSteps = [];
      for (const step of steps) {
        const { prompt, response, observation, ...accounting } = step;
        storedSteps.push({ ...accounting, prompt: await this.put(prompt),
          ...(response === undefined ? {} : { response: await this.put(response) }),
          ...(observation === undefined ? {} : { observation: await this.put(observation) }) });
      }
      storedCalls.push(await this.put({ ...header, slice: await this.put(slice), steps: storedSteps }));
    }
    const transcript = await this.put({ ...metadata, calls: storedCalls });
    return JSON.stringify({ version: 2, run: state.run, reserved_tokens, snapshot: snapshotRef, transcript });
  }
  /** Hydrate v2 references, or pass v1 JSON through unchanged for the existing checkpoint validator. */
  async decode(raw: string): Promise<Record<string, unknown>> {
    const manifest = record(JSON.parse(raw));
    if (manifest.version !== 2) return manifest;
    const transcript = record(await this.get(manifest.transcript));
    if (transcript.version !== 1 || transcript.run !== manifest.run || !Array.isArray(transcript.calls)) throw new RlmError('incomplete', 'Invalid ledger transcript');
    const calls = [];
    for (const reference of transcript.calls) {
      const call = record(await this.get(reference));
      if (!Array.isArray(call.steps)) throw new RlmError('incomplete', 'Invalid ledger steps');
      const steps = [];
      for (const entry of call.steps) {
        const step = record(entry);
        steps.push({ ...step, prompt: await this.get(step.prompt),
          ...(step.response === undefined ? {} : { response: await this.get(step.response) }),
          ...(step.observation === undefined ? {} : { observation: await this.get(step.observation) }) });
      }
      calls.push({ ...call, slice: await this.get(call.slice), steps });
    }
    return { ...transcript, snapshot: await this.get(manifest.snapshot), calls, reserved_tokens: manifest.reserved_tokens };
  }
  /** Sweep only owned blob and abandoned atomic-temp names after every root has been marked. */
  async sweep(): Promise<{ removed: number; bytes: number }> {
    const result = { removed: 0, bytes: 0 };
    const entries = await sdkRead(async () => {
      try { return await readdir(this.directory); }
      catch (error) { if (record(error).code === 'ENOENT') return []; throw error; }
    });
    for (const name of entries) {
      const blob = /^([a-f0-9]{64})\.json$/.exec(name);
      const temporary = /^\.[a-f0-9]{64}\.json\.\d+\.\d+\.[a-f0-9]+\.tmp$/.test(name);
      if ((blob !== null && !this.reachable.has(blob[1])) || temporary) {
        const path = join(this.directory, name);
        const bytes = await sdkRead(() => readFileIfExists(path));
        await removeFileIfExists(path);
        result.removed++; result.bytes += Buffer.byteLength(bytes ?? '');
      }
    }
    return result;
  }
}
