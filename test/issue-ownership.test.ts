import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { assertOwnershipRead, readOwnershipItems, type OwnershipItem } from './issue-ownership-support.ts';

/** Exhaustive issue identities among package numbers 1..63, verified with GitHub on 2026-11-09. */
const issues = new Set([4, 5, 37, 38, 42, 49].map(number => `unbraind/pm-rlm#${number}`).concat('unbraind/pm-cli#1609'));

/** The same complete API snapshot identifies every other allocated package number as a PR.
 * Unknown future issues and other repositories remain allowed so automatic issue imports keep working.
 */
const pullRequests = new Set(Array.from({ length: 63 }, (_, index) => `unbraind/pm-rlm#${index + 1}`).filter(identity => !issues.has(identity)));

/** Check ownership declarations only; prose, comments and PR references remain historical evidence. */
function verifyOwnership(item: OwnershipItem): void {
  const identities = (item.tags ?? []).filter(tag => /^gh:/i.test(tag)).map(tag => tag.slice(3).toLowerCase());
  const declaration = /^(?:GitHub issue|GH issue #\d+:)\s+(https:\/\/github\.com\/\S+)/i.exec(item.description ?? '')?.[1];
  for (const url of [item.github_url, declaration]) {
    if (!url) continue;
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[.#?].*)?$/i.exec(url);
    assert.ok(match, `${item.id}: ownership URL must identify an issue: ${url}`);
    identities.push(`${match[1]}#${match[2]}`.toLowerCase());
    if (item.github_number !== undefined) assert.equal(item.github_number, Number(match[2]), `${item.id}: conflicting issue number`);
  }
  if (item.github_number !== undefined && !item.github_url) identities.push(`unbraind/pm-rlm#${item.github_number}`);
  for (const identity of identities) assert.ok(!pullRequests.has(identity), `${item.id}: pull request used as issue ownership ${identity}`);
}

test('every native tracker item excludes verified pull requests from issue ownership', () => {
  const root = new URL('../.agents/pm/', import.meta.url);
  const paths = readdirSync(root, { recursive: true }).map(String).filter(path => path.endsWith('.toon'));
  assert.ok(paths.length > 0);
  for (const path of paths) verifyOwnership(decodeToon(readFileSync(new URL(path, root), 'utf8')) as unknown as OwnershipItem);
});

test('ownership oracle rejects every PR number in every ownership field and allows historical references', () => {
  for (let number = 1; number <= 63; number++) {
    const identity = `unbraind/pm-rlm#${number}`;
    const variants: OwnershipItem[] = [
      { id: 'tag', tags: [`gh:${identity}`] },
      { id: 'url', github_url: `https://github.com/unbraind/pm-rlm/issues/${number}` },
      { id: 'number', github_number: number },
      { id: 'declaration', description: `GitHub issue https://github.com/unbraind/pm-rlm/issues/${number}` },
      { id: 'imported-description', description: `GH issue #${number}: https://github.com/unbraind/pm-rlm/issues/${number}` },
    ];
    for (const item of variants) {
      if (issues.has(identity)) assert.doesNotThrow(() => verifyOwnership(item));
      else assert.throws(() => verifyOwnership(item), /pull request used as issue ownership/);
    }
    assert.throws(() => verifyOwnership({ id: 'pull-url', github_url: `https://github.com/unbraind/pm-rlm/pull/${number}` }), /must identify an issue/);
    assert.throws(() => verifyOwnership({ id: 'pull-declaration', description: `GitHub issue https://github.com/unbraind/pm-rlm/pull/${number}` }), /must identify an issue/);
    assert.throws(() => verifyOwnership({ id: 'pull-imported-description', description: `GH issue #${number}: https://github.com/unbraind/pm-rlm/pull/${number}` }), /must identify an issue/);
    assert.doesNotThrow(() => verifyOwnership({ id: 'context', tags: [`pr:${identity}`], description: `Delivered by PR #${number}` }));
  }
  assert.doesNotThrow(() => verifyOwnership({ id: 'external', tags: ['gh:unbraind/pm-cli#1609'] }));
  assert.doesNotThrow(() => verifyOwnership({ id: 'future', tags: ['gh:unbraind/pm-rlm#64'], github_number: 64, github_url: 'https://github.com/unbraind/pm-rlm/issues/64' }));
  assert.throws(() => verifyOwnership({ id: 'conflict', github_number: 57, github_url: 'https://github.com/unbraind/pm-rlm/issues/4' }), /conflicting issue number/);
});

test('SDK and JSON and TOON CLI reads preserve issue ownership in a non-git tracker', async () => {
  const repository = join(import.meta.dirname, '..');
  const root = mkdtempSync(join(tmpdir(), 'issue-ownership-'));
  const pmRoot = join(root, '.agents/pm');
  try {
    mkdirSync(pmRoot, { recursive: true });
    cpSync(join(repository, '.agents/pm/settings.json'), join(pmRoot, 'settings.json'));
    const paths = readdirSync(join(repository, '.agents/pm'), { recursive: true }).map(String).filter(path => path.endsWith('.toon'));
    for (const path of paths) {
      mkdirSync(dirname(join(pmRoot, path)), { recursive: true });
      cpSync(join(repository, '.agents/pm', path), join(pmRoot, path));
    }
    assert.equal(existsSync(join(root, '.git')), false);
    const native = readOwnershipItems(pmRoot);
    const client = new PmClient({ cwd: root, pmRoot, noExtensions: true });
    const sdk = await client.listAllComplete();
    assert.equal(sdk.items.length, paths.length);
    sdk.items.forEach(verifyOwnership);
    assertOwnershipRead(native, sdk.items, 'SDK');
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/GIT_|^PM_|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|NPM_MEDIA_SERVER|^NODE_TEST_CONTEXT$/i.test(key)));
    const environment = { ...inherited, HOME: root, PM_PATH: pmRoot, GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', NPM_CONFIG_USERCONFIG: devNull };
    for (const format of ['json', 'toon']) {
      const child = spawnSync(process.execPath, [join(repository, 'node_modules/@unbrained/pm-cli/dist/cli.js'), 'list', '--all', '--full', '--strict-read', '--output-budget', 'unbounded', '--output-limit', 'unbounded', '--no-extensions', '--format', format], { cwd: root, env: environment, encoding: 'utf8', timeout: 60000 });
      assert.equal(child.status, 0, child.stderr);
      const result = (format === 'json' ? JSON.parse(child.stdout) : decodeToon(child.stdout)) as { items: OwnershipItem[] };
      assert.equal(result.items.length, sdk.items.length);
      result.items.forEach(verifyOwnership);
      assertOwnershipRead(native, result.items, format);
      const originals = new Map(sdk.items.map(item => [item.id, item]));
      for (const item of result.items) {
        const original = originals.get(item.id);
        assert.ok(original, `${format}: unknown item ${item.id}`);
        for (const key of ['tags', 'github_url', 'github_number', 'description'] as const) assert.deepEqual(item[key], original[key], `${format}: ${item.id}.${key}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every transport rejects ownership loss and same-count identity substitutions at every item position', () => {
  const native: OwnershipItem[] = ['first', 'constructor', '__proto__', 'last'].map((id, index) => ({
    id, tags: [`gh:unbraind/pm-rlm#${[4, 5, 37, 38][index]}`, 'fixture'],
    description: `Issue fixture ${index}`, github_number: [4, 5, 37, 38][index],
    github_url: `https://github.com/unbraind/pm-rlm/issues/${[4, 5, 37, 38][index]}`,
  }));
  const snapshot = structuredClone(native);
  for (const label of ['SDK', 'json', 'toon', 'packed npm', 'packed bun']) {
    const reordered = structuredClone(native).reverse();
    for (const item of reordered) item.tags = item.tags!.map(tag => ` ${tag.toUpperCase()} `).reverse();
    assert.doesNotThrow(() => assertOwnershipRead(native, reordered, label));
    for (let index = 0; index < native.length; index++) {
      for (const replacement of [native[(index + 1) % native.length].id, 'unknown']) {
        const corrupted = structuredClone(native);
        corrupted[index] = structuredClone(native.find(item => item.id === replacement) ?? { ...native[index], id: replacement });
        assert.equal(corrupted.length, native.length);
        assert.throws(() => assertOwnershipRead(native, corrupted, label), /item IDs differ/);
      }
      for (const key of ['tags', 'github_url', 'github_number', 'description'] as const) {
        const corrupted = structuredClone(native);
        delete corrupted[index][key];
        // The remaining values still pass the ownership-validity oracle: preservation is a separate invariant.
        corrupted.forEach(verifyOwnership);
        assert.throws(() => assertOwnershipRead(native, corrupted, label), new RegExp(`\\.${key}`));
      }
      for (const tags of [['fixture'], ['gh:unbraind/pm-rlm#42', 'fixture'], [...native[index].tags!, 'gh:unbraind/pm-rlm#42']]) {
        const corrupted = structuredClone(native);
        corrupted[index].tags = tags;
        corrupted.forEach(verifyOwnership);
        assert.throws(() => assertOwnershipRead(native, corrupted, label), /\.tags/);
      }
      const missing = native.filter((_, position) => position !== index);
      assert.throws(() => assertOwnershipRead(native, missing, label), /item IDs differ/);
    }
    assert.throws(() => assertOwnershipRead(native, [...native, native[0]], label), /item IDs differ/);
    // Even unanimous transport agreement cannot excuse a native issue tag disappearing.
    const commonLoss = native.map(item => ({ ...item, tags: ['fixture'] }));
    assert.throws(() => assertOwnershipRead(native, commonLoss, label), /\.tags/);
  }
  assert.deepEqual(native, snapshot, 'comparison must not mutate the independent oracle');
});
