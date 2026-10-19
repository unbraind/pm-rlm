/** Audit the seeded public question set without contacting a model endpoint. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicCorpus } from './live.ts';
import { questions, answerDistribution, EVAL_SEED } from './eval-questions.ts';

const root = await mkdtemp(join(tmpdir(), 'rlm-design-'));
try {
  const sources = [];
  const tasks = [];
  for (const repo of ['pm-vcs', 'pm-lint']) {
    const { revision, corpus } = await publicCorpus(repo, root);
    const generated = questions(corpus.items);
    sources.push({ repo, revision, items: corpus.items.length, bytes: Buffer.byteLength(JSON.stringify(corpus.items)) });
    tasks.push(...generated.map(task => ({ repo, ...task })));
  }
  const distribution = answerDistribution(tasks);
  if (distribution.most_common > tasks.length / 6) throw new Error('Answer distribution exceeds frequency cap');
  await mkdir('docs', { recursive: true });
  await writeFile('docs/eval-design.json', JSON.stringify({ design: EVAL_SEED, sources, ...distribution, tasks, model_runs: 0 }, null, 2) + '\n');
  console.log(JSON.stringify({ sources, ...distribution }));
} finally { await rm(root, { recursive: true, force: true }); }
