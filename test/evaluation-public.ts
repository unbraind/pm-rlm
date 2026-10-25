/** Prepare reviewed public source copies and version exact SDK-computed tracker truth. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PmClient, getHistoryPath, readHistoryEntries, verifyHistoryEntries } from '@unbrained/pm-cli/sdk';
import { evalDigest } from '../src/evaluation.ts';
import { readCorpus } from '../src/environment.ts';
import type { RlmEvalSuite } from '../src/evaluation-types.ts';
import { copyVerifiedRevision, publicSource } from './live.ts';

const root = await mkdtemp(join(tmpdir(), 'rlm-measured-'));
const suite: RlmEvalSuite = { version: 1, id: 'public-trackers-v1', sources: [], questions: [] };
const sources: Record<string, string> = {};
for (const [repo, revision] of [['pm-rlm', '78a2e4d82ecb9cd4512250e8b1b5b7ef1b8e3c54'], ['pm-lint', 'f2c20efa78139f4071f3dd08d317bea05337fe28']]) {
  const visibility = JSON.parse(execFileSync('gh', ['repo', 'view', `unbraind/${repo}`, '--json', 'visibility'], { encoding: 'utf8' })) as { visibility: string };
  const published = execFileSync('gh', ['api', `repos/unbraind/${repo}/commits/${revision}`, '--jq', '.sha'], { encoding: 'utf8' }).trim();
  if (visibility.visibility !== 'PUBLIC' || published !== revision) throw new Error('Source public provenance could not be verified');
  const base = join(root, repo); await mkdir(base);
  const { workspace } = await copyVerifiedRevision(publicSource(repo), revision, base);
  const { items } = await readCorpus(workspace);
  sources[repo] = workspace;
  suite.sources.push({ id: repo, repository: `unbraind/${repo}`, revision, corpus_sha256: evalDigest(JSON.stringify(items)) });
  const client = new PmClient({ pmRoot: workspace, noExtensions: true });
  /** Keep each question format-neutral; answers use exact scalar strings. */
  const add = (question: string, gold: string | number): void => { suite.questions.push({ id: `${repo}-${suite.questions.length + 1}`, source: repo, question, gold: String(gold) }); };
  add('How many tracker items are there, across every status?', items.length);
  for (const status of ['open', 'closed', 'in_progress']) add(`How many items have status ${status}?`, items.filter(item => item.status === status).length);
  for (const type of ['Issue', 'Feature']) add(`How many items have type ${type}?`, items.filter(item => item.type === type).length);
  const item = items.find(item => item.dependencies?.some(edge => edge.kind === 'blocked_by')) ?? items[0];
  const metadata = (await client.get(item.id, { full: true })).item;
  add(`Who is the assignee of ${item.id}? Use the literal null when unassigned.`, metadata.assignee ?? 'null');
  add(`Who is the recorded author of ${item.id}?`, metadata.author!);
  const history = await readHistoryEntries(getHistoryPath(workspace, item.id), item.id);
  if (!verifyHistoryEntries(history).ok) throw new Error('Public history verification failed');
  add(`What is the exact updated_at timestamp of ${item.id}?`, metadata.updated_at!);
  const dependencies = item.dependencies ?? [];
  const blocker = dependencies.find(edge => edge.kind === 'blocked_by')?.id ?? items.find(other => other.id !== item.id)!.id;
  add(`Which item is the lexicographically first declared blocked_by dependency of ${item.id}? Include closed blockers; use none if absent.`, dependencies.filter(edge => edge.kind === 'blocked_by').map(edge => edge.id).sort()[0] ?? 'none');
  add(`How many declared blocked_by dependencies does ${item.id} have, including closed blockers?`, dependencies.filter(edge => edge.kind === 'blocked_by').length);
  const graph = await client.graph('paths', { id: item.id, target: blocker }, { kind: 'blocked_by', direction: 'outgoing', maxDepth: 20, maxPaths: 100, full: true });
  if (graph.subcommand !== 'paths' || graph.truncated) throw new Error('Dependency path gold is incomplete');
  add(`What is the shortest directed blocked_by dependency path from ${item.id} to ${blocker}? Include both endpoints joined by ->, without spaces; use none when no path exists.`, graph.paths?.[0]?.nodes.join('->') ?? 'none');
}
await writeFile('docs/public-eval-suite.json', JSON.stringify(suite, null, 2) + '\n');
await writeFile('evaluation-sources.local.json', JSON.stringify({ root, sources }, null, 2) + '\n');
console.log(JSON.stringify({ sources: suite.sources, questions: suite.questions.length }));
