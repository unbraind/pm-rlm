import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toImportTags } from '@unbrained/pm-cli/sdk';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';

/** Ownership fields shared by native documents, full SDK rows and CLI projections. */
export interface OwnershipItem {
  id: string;
  tags?: string[];
  description?: string;
  github_url?: string;
  github_number?: number;
}

/** Read independent native documents rather than deriving expectations from another projection. */
export function readOwnershipItems(pmRoot: string): OwnershipItem[] {
  return readdirSync(pmRoot, { recursive: true }).map(String).filter(path => path.endsWith('.toon'))
    .map(path => decodeToon(readFileSync(join(pmRoot, path), 'utf8')) as unknown as OwnershipItem);
}

/** Require complete identity and normalized ownership preservation for every read transport. */
export function assertOwnershipRead(native: readonly OwnershipItem[], actual: readonly OwnershipItem[], label: string): void {
  assert.deepEqual(actual.map(item => item.id).sort(), native.map(item => item.id).sort(), `${label}: item IDs differ from native documents`);
  const originals = new Map(native.map(item => [item.id, item]));
  assert.equal(originals.size, native.length, 'native documents contain duplicate IDs');
  for (const item of actual) {
    const original = originals.get(item.id);
    assert.ok(original, `${label}: unknown item ${item.id}`);
    assert.deepEqual(toImportTags(item.tags).sort(), toImportTags(original.tags).sort(), `${label}: ${item.id}.tags`);
    for (const key of ['github_url', 'github_number'] as const) assert.deepEqual(item[key], original[key], `${label}: ${item.id}.${key}`);
    assert.equal(item.description ?? '', original.description ?? '', `${label}: ${item.id}.description`);
  }
}
