import { gitEnvironment } from '../scripts/environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyVerifiedRevision } from './live.ts';
import { tracker } from './helpers.ts';
import { readCorpus } from '../src/environment.ts';

/** Public revision copies exclude local dirty and untracked items, and reject tracked symlinks. */
test('eval copies only the verified revision using real Git and SDK data', async t => {
  const { root, workspace, client } = await tracker(t);
  await client.create({ id: 'public-item', title: 'Public revision', type: 'Task' });
  const env = gitEnvironment(process.env);
  /** Execute Git only in this isolated test repository with a synthetic public identity. */
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=noreply@github.com', ...args], { cwd: root, env, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('add', '.agents/pm'); git('commit', '-m', 'Public fixture');
  const revision = git('rev-parse', 'HEAD');
  await client.update('public-item', { title: 'Replacement content must stay private' });
  git('add', '.agents/pm'); git('commit', '-m', 'Replacement fixture');
  const alternate = git('rev-parse', 'HEAD');
  git('replace', revision, alternate);

  await client.update('public-item', { title: 'Private local edit' });
  await client.create({ title: 'Untracked private item', type: 'Issue' });
  const base = join(root, 'evaluation'); await mkdir(base);
  const copy = await copyVerifiedRevision(root, revision, base);
  const items = (await readCorpus(copy.workspace)).items;
  assert.equal(items.length, 1); assert.equal(items[0].title, 'Public revision');
  git('replace', '-d', revision);
  await writeFile(join(root, '.gitattributes'), '.agents/pm/attribute-data export-ignore\n');
  await writeFile(join(workspace, 'attribute-data'), '$Format:%H$\n');
  git('add', '.gitattributes', '.agents/pm/attribute-data'); git('commit', '-m', 'Ignored archive fixture');
  await assert.rejects(copyVerifiedRevision(root, git('rev-parse', 'HEAD'), join(root, 'ignored-archive')), { code: 'invalid', message: 'Public archive paths differ from verified revision' });
  await writeFile(join(root, '.gitattributes'), '.agents/pm/attribute-data export-subst\n');
  git('add', '.gitattributes'); git('commit', '-m', 'Substituted archive fixture');
  await assert.rejects(copyVerifiedRevision(root, git('rev-parse', 'HEAD'), join(root, 'substituted-archive')), { code: 'invalid', message: 'Public archive bytes differ from verified revision' });
  await writeFile(join(root, 'private.txt'), 'private fixture data');
  await symlink(join(root, 'private.txt'), join(workspace, 'private-link'));
  git('add', '.agents/pm/private-link'); git('commit', '-m', 'Symlink fixture');
  await assert.rejects(copyVerifiedRevision(root, git('rev-parse', 'HEAD'), join(root, 'rejected')), { code: 'invalid' });
});
