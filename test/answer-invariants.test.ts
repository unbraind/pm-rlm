import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readSettings, resolveRuntimeStatusRegistry } from '@unbrained/pm-cli/sdk';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { parseAnswerContract, RlmInvariantError, validateAnswerReport, ANSWER_INVARIANT_SCHEMA } from '../src/answer-contract.ts';
import type { RlmAnswerContract, RlmAnswerReport, RlmAnswerField, RlmAnswerScalar } from '../src/answer-contract.ts';
import { readAnswerContract, verifyRlmAnswer } from '../src/answer-invariants.ts';
import { runCommand } from '../src/commands.ts';
import { acceptsSchema } from '../src/action-schema.ts';
import { tracker, installExtension } from './helpers.ts';

/** A count declaration retains arbitrary cited prose without treating it as evidence. */
function contract(expected = 0): RlmAnswerContract {
  return { version: 'answer-invariants-v1', answer: 'There are 99 items [source citation].', scope: {}, checks: [{ id: 'count', kind: 'count', filter: {}, expected }] };
}

/** Read every tracker file as exact bytes; directory names are part of the comparison. */
async function bytes(root: string): Promise<[string, string][]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const file = join(entry.parentPath, entry.name);
    return [file.slice(root.length), (await readFile(file)).toString('hex')] as [string, string];
  })).then(rows => rows.sort(([a], [b]) => a.localeCompare(b)));
}

test('cited false counts fail independently of complete sources and unchecked prose', async t => {
  const { workspace, client } = await tracker(t);
  const source = (await client.create({ title: 'Cited source', parent: 'none', assignee: 'none', sprint: 'none', release: 'none' })).item;
  const input = contract(99);
  input.checks.push({ id: 'source-is-present', kind: 'membership', filter: {}, field: 'id', value: source.id, expected: 'present' });
  const environment = await client.listAllComplete({ includeBody: true });
  const before = await bytes(workspace);
  const report = await verifyRlmAnswer(input, { environment });
  assert.equal(report.status, 'failed');
  assert.equal(report.source.status, 'complete');
  assert.equal(report.source.items, 1);
  assert.equal(report.checks[0].actual, 1);
  assert.equal(report.checks[0].reason, 'mismatch');
  assert.deepEqual(report.verified_fact_ids, ['source-is-present']);
  assert.deepEqual(report.answer, { text: input.answer, verification: 'not_evaluated' });
  assert.equal(report.model_calls, 0); assert.equal(report.writes, 0);
  assert.deepEqual(await bytes(workspace), before);
  assert.deepEqual(validateAnswerReport(JSON.parse(JSON.stringify(report))), report);
});

test('empty complete scope, excluded ledger rows and incomplete source remain distinct', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Foreign ledger record', tags: 'rlm:call', parent: 'none' });
  const environment = await client.listAllComplete({ includeBody: true });
  const before = await bytes(workspace);
  const empty = await verifyRlmAnswer(contract(), { environment });
  assert.equal(empty.status, 'passed'); assert.equal(empty.source.items, 0);
  const incomplete = await verifyRlmAnswer(contract(), { environment: { ...environment, completeness: { ...environment.completeness, status: 'partial' } } });
  assert.equal(incomplete.status, 'incomplete'); assert.equal(incomplete.source.status, 'incomplete');
  assert.equal(incomplete.source.items, 'unknown'); assert.equal(incomplete.checks[0].actual, null);
  assert.equal(incomplete.checks[0].reason, 'source_incomplete');
  assert.deepEqual(await bytes(workspace), before);
  assert.equal((await verifyRlmAnswer(contract(), { environment: {} })).status, 'incomplete');
});

test('scope intersection, exact scalar equality and unavailable items keep independent verdicts', async t => {
  const { workspace, client } = await tracker(t);
  const first = (await client.create({ title: 'Exact text', parent: 'none', priority: 2, tags: 'sample' })).item;
  const second = (await client.create({ title: 'Outside scope', parent: 'none' })).item;
  const input = contract(1); input.scope = { ids: [first.id] };
  input.checks.push(
    { id: 'not-broadened', kind: 'count', filter: { ids: [second.id] }, expected: 0 },
    { id: 'title', kind: 'equals', item: first.id, field: 'title', expected: first.title },
    { id: 'priority', kind: 'equals', item: first.id, field: 'priority', expected: 2 },
    { id: 'no-parent', kind: 'equals', item: first.id, field: 'parent', expected: null },
    { id: 'absent-value', kind: 'membership', filter: {}, field: 'id', value: second.id, expected: 'absent' },
    { id: 'wrong-title', kind: 'equals', item: first.id, field: 'title', expected: 'Other' },
    { id: 'outside-item', kind: 'equals', item: second.id, field: 'title', expected: 'Outside scope' },
  );
  const report = await verifyRlmAnswer(input, { environment: await client.listAllComplete({ includeBody: true }) });
  assert.deepEqual(report.checks.map(check => check.status), ['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'failed', 'unknown']);
  assert.equal(report.status, 'failed');
  const partial = await verifyRlmAnswer({ ...input, checks: [input.checks[7]] }, { environment: await client.listAllComplete({ includeBody: true }) });
  assert.equal(partial.status, 'incomplete'); assert.equal(partial.source.status, 'complete');
});

test('long historical native values refuse one equality check while counts and membership still run', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'x'.repeat(300), parent: 'none' })).item;
  const input = contract(1);
  input.checks.push({ id: 'long-title', kind: 'equals', item: item.id, field: 'title', expected: 'x' });
  const report = await verifyRlmAnswer(input, { environment: await client.listAllComplete({ includeBody: true }) });
  assert.equal(report.checks[0].status, 'passed'); assert.equal(report.checks[1].reason, 'value_out_of_domain');
  assert.deepEqual(report.verified_fact_ids, ['count']);
  const membership = await verifyRlmAnswer({ ...input, checks: [{ id: 'long-member', kind: 'membership', filter: {}, field: 'title', value: 'x', expected: 'present' }] }, { environment: await client.listAllComplete({ includeBody: true }) });
  assert.equal(membership.checks[0].reason, 'value_out_of_domain');
});

test('SDK optional undefined fields and JSON omission have identical equality verdicts', async t => {
  const { client } = await tracker(t);
  const item = (await client.create({ title: 'Optional scalar source', parent: 'none', assignee: 'none', sprint: 'none', release: 'none' })).item;
  const environment = await client.listAllComplete({ includeBody: true });
  const fields = ['parent', 'assignee', 'sprint', 'release'] as const;
  const input = { ...contract(), checks: fields.map(field => ({ id: field, kind: 'equals', item: item.id, field, expected: null })) };
  const native = await verifyRlmAnswer(input, { environment });
  for (const field of fields) environment.items[0][field] = undefined;
  const withUndefined = await verifyRlmAnswer(input, { environment });
  const roundTrip = await verifyRlmAnswer(input, { environment: JSON.parse(JSON.stringify(environment)) });
  assert.deepEqual(withUndefined, native); assert.deepEqual(roundTrip, native);
  assert.equal(native.status, 'passed');
});

test('strict contract refuses executable syntax, sparse arrays, extremes and unknown fields before reads', async t => {
  const { workspace } = await tracker(t);
  const invalid: unknown[] = [null, [], {}, { ...contract(), extra: 1 }, { ...contract(), checks: [] }, { ...contract(), checks: Array(1) }, { ...contract(), checks: Array(65).fill(contract().checks[0]) }, { ...contract(), checks: [contract().checks[0], contract().checks[0]] }, { ...contract(), scope: { ids: Array(1) } }, { ...contract(), scope: { ids: Array(1001).fill('id') } }, { ...contract(), scope: { predicate: 'process.exit()' } }, { ...contract(), answer: 'x'.repeat(8193) }, { ...contract(), scope: { text: 'x'.repeat(257) } }];
  for (const expected of [NaN, Infinity, -Infinity, -1, 0.5, 1000000001, Number.MAX_VALUE, Number.MIN_VALUE, '1']) invalid.push({ ...contract(), checks: [{ ...contract().checks[0], expected }] });
  for (const field of ['__proto__', 'constructor', 'title.length', 'process.exit()', 'tags']) invalid.push({ ...contract(), checks: [{ id: 'x', kind: 'equals', item: 'item', field, expected: 0 }] });
  invalid.push({ ...contract(), checks: [{ id: 'x', kind: 'equals', item: 'item', field: 'title', expected: true }] });
  const huge = contract(); huge.checks = Array.from({ length: 64 }, (_, i) => ({ id: String(i), kind: 'count', filter: { text: '🙂'.repeat(120), ids: Array(1000).fill('x') }, expected: 0 })); invalid.push(huge);
  const seeded = random();
  for (let iteration = 0; iteration < 500; iteration++) {
    const value = [NaN, Infinity, -Infinity, -Number.MAX_SAFE_INTEGER, 1000000001, 0.5, '0'][seeded() % 7];
    invalid.push({ ...contract(), checks: [{ ...contract().checks[0], expected: value }] });
  }
  const before = await bytes(workspace);
  for (const value of invalid) {
    assert.throws(() => parseAnswerContract(value), RlmInvariantError);
    await assert.rejects(verifyRlmAnswer(value, { environment: {} }), RlmInvariantError);
  }
  assert.deepEqual(await bytes(workspace), before);
  const allowed = contract(1000000000);
  assert.deepEqual(parseAnswerContract(allowed), allowed);
  assert.equal(parseAnswerContract({ ...contract(), checks: [{ id: 'constructor', kind: 'equals', item: 'legacy id', field: 'title', expected: ' \r\n ' }] }).checks[0].id, 'constructor');
  const detached = parseAnswerContract(allowed); allowed.checks[0].id = 'changed'; assert.equal(detached.checks[0].id, 'count');
});

test('supplied source boundaries reject sparse or oversized environments and isolate malformed scalar records', async t => {
  const { client } = await tracker(t);
  const item = (await client.create({ title: 'Source', parent: 'none' })).item;
  const environment = await client.listAllComplete({ includeBody: true });
  for (const input of [{}, { ...environment, items: Array(1) }, { ...environment, items: Array(100001) }, { ...environment, padding: 'x'.repeat(16777217) }]) {
    assert.equal((await verifyRlmAnswer(contract(), { environment: input })).source.status, 'incomplete');
  }
  const malformed = structuredClone(environment);
  (malformed.items[0] as unknown as Record<string, unknown>).priority = Infinity;
  const checks = { ...contract(1), checks: [contract(1).checks[0], { id: 'bad-priority', kind: 'membership' as const, filter: {}, field: 'priority' as const, value: 2, expected: 'present' as const }] };
  const report = await verifyRlmAnswer(checks, { environment: malformed });
  assert.equal(report.checks[0].status, 'passed'); assert.equal(report.checks[1].reason, 'value_out_of_domain');
  const withGap = await verifyRlmAnswer({ ...contract(), checks: [{ id: 'gone', kind: 'equals', item: item.id + '-absent', field: 'title', expected: 'Source' }] }, { environment });
  const invalidUnknown = structuredClone(withGap); invalidUnknown.checks[0].reason = 'matched';
  assert.throws(() => validateAnswerReport(invalidUnknown), RlmInvariantError);
  invalidUnknown.checks[0].reason = 'item_unavailable'; invalidUnknown.checks[0].remedy = '';
  assert.throws(() => validateAnswerReport(invalidUnknown), RlmInvariantError);
  const incomplete = await verifyRlmAnswer(contract(), { environment: {} });
  const badSource = structuredClone(incomplete); badSource.checks[0].reason = 'item_unavailable';
  assert.throws(() => validateAnswerReport(badSource), RlmInvariantError);
  badSource.checks[0].reason = 'source_incomplete'; badSource.checks[0].status = 'failed'; badSource.checks[0].reason = 'mismatch'; badSource.status = 'failed';
  assert.throws(() => validateAnswerReport(badSource), RlmInvariantError);
});

test('bounded file boundary closes handles and sanitizes missing, invalid, oversized and non-UTF8 inputs', async t => {
  const { workspace, root } = await tracker(t);
  const file = join(root, 'contract.json');
  const input = contract();
  for (const text of [JSON.stringify(input), JSON.stringify(input, null, 2).replaceAll('\n', '\r\n')]) {
    await writeFile(file, text); assert.deepEqual(await readAnswerContract(file), input);
  }
  for (const content of ['{', '{"x":1,"x":2}', 'prefix ' + JSON.stringify(input), '{} trailing', 'x'.repeat(65537), Buffer.from([0xff])]) {
    await writeFile(file, content); await assert.rejects(readAnswerContract(file), RlmInvariantError);
  }
  await assert.rejects(readAnswerContract(root), RlmInvariantError);
  await assert.rejects(readAnswerContract(join(root, 'missing')), RlmInvariantError);
  const ctx = { command: 'rlm verify-answer', pm_root: workspace, args: [file], options: { environment: file }, global: {} } as CommandHandlerContext;
  await assert.rejects(runCommand('verify-answer', ctx), /remedy:/);
  await assert.rejects(runCommand('verify-answer', { ...ctx, options: {} }), /remedy:/);
  await assert.rejects(runCommand('verify-answer', { ...ctx, args: [] }), /remedy:/);
});

test('native no-git command emits compact TOON and JSON with no git executable', async t => {
  const { workspace, root, client } = await tracker(t);
  await installExtension(workspace);
  const file = join(root, 'answer.json'); await writeFile(file, JSON.stringify(contract()));
  const sourceFile = join(root, 'environment.json'); await writeFile(sourceFile, JSON.stringify(await client.listAllComplete({ includeBody: true })));
  const noGit = join(root, 'bin'); await mkdir(noGit);
  const node = join(noGit, 'node'); await writeFile(node, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`); await chmod(node, 0o755);
  const before = await bytes(workspace);
  let expected: unknown;
  for (const encoded of [await readFile(sourceFile, 'utf8'), '{}']) {
    await writeFile(sourceFile, encoded);
    for (const json of [true, false]) {
      const result = spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'rlm', 'verify-answer', file, '--environment', sourceFile, ...(json ? ['--json'] : [])], { cwd: root, encoding: 'utf8', env: { ...process.env, PM_PATH: workspace, PATH: noGit, GIT_CEILING_DIRECTORIES: root } });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const report = json ? JSON.parse(result.stdout) : decodeToon(result.stdout);
      if (json) expected = report; else assert.deepEqual(report, expected);
      assert.equal((report as RlmAnswerReport).status, encoded === '{}' ? 'incomplete' : 'passed');
      assert.deepEqual(validateAnswerReport(report), report);
      assert.ok(Buffer.byteLength(result.stdout) < 2000);
    }
  }
  assert.deepEqual(await bytes(workspace), before);
  const dispatched = await runCommand('verify-answer', { command: 'rlm verify-answer', pm_root: workspace, args: [file], options: { environment: sourceFile }, global: {} } as CommandHandlerContext);
  assert.deepEqual(dispatched, expected);
});

/** Portable fixed-seed arithmetic provides reproducible operation selection. */
function random(): () => number {
  let seed = 0x526c6d31;
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
}

test('500 seeded contract operation sequences compare SDK read-back state including older replays and CRLF', async t => {
  const { workspace, client } = await tracker(t);
  const next = random();
  const parents = await Promise.all([0, 1].map(i => client.create({ title: `Parent ${i}`, parent: 'none' })));
  const statuses: string[] = [];
  for (let i = 0; i < 4; i++) {
    const status = `custom_${next().toString(16)}`;
    await client.schemaAddStatus(status, { role: [['active'], ['blocked'], ['terminal_done', 'terminal'], ['terminal_canceled', 'terminal']][i] }); statuses.push(status);
  }
  const registry = resolveRuntimeStatusRegistry((await readSettings(workspace)).schema);
  assert.ok(registry);
  await client.focus(parents[next() % 2].item.id);
  const native = (await client.create({ title: 'Source', parent: 'none', assignee: 'none', sprint: 'none', release: 'none' })).item;
  await client.update(native.id, { dep: [`id=${parents[0].item.id},kind=related`] });
  const archive: RlmAnswerContract[] = [];
  const fields: RlmAnswerField[] = ['id', 'title', 'type', 'status', 'priority', 'parent', 'assignee', 'sprint', 'release'];
  let olderReplays = 0;
  let environment = await client.listAllComplete({ includeBody: true });
  for (let sequence = 0; sequence < 500; sequence++) {
    if (sequence % 25 === 0) {
      await client.focus(parents[next() % 2].item.id);
      await client.update(native.id, { title: `  Source ${next() % 5}\r\n title  `, status: statuses[next() % 4], closeReason: 'Model fixture', parent: sequence % 50 === 0 ? parents[0].item.id : 'none', priority: next() % 5, assignee: `agent-${next() % 3}`, sprint: `sprint-${next() % 4}`, release: `release-${next() % 3}`, tags: `sample,tag-${next() % 3}` });
      environment = await client.listAllComplete({ includeBody: true });
    }
    const rows = environment.items;
    const source = rows.find(item => item.id === native.id)!;
    const field = fields[sequence % fields.length];
    const expected = (Object.hasOwn(source, field) ? source[field] : null) as RlmAnswerScalar;
    let input: RlmAnswerContract = { ...contract(1), answer: sequence % 2 === 0 ? '  Claim\r\n exact  ' : 'Claim\nexact', scope: { ids: [source.id] }, checks: [
      { id: '__proto__', kind: 'count', filter: { type: source.type, status: source.status, tag: 'sample' }, expected: 1 },
      { id: 'constructor', kind: 'equals', item: source.id, field, expected },
      { id: 'membership', kind: 'membership', filter: {}, field, value: expected, expected: 'present' },
    ] };
    archive.push(structuredClone(input));
    if (sequence > 0 && next() % 3 === 0) { input = archive[next() % sequence]; olderReplays++; }
    const text = JSON.stringify(input, null, 2).replaceAll('\n', sequence % 2 === 0 ? '\r\n' : '\n');
    const decoded = parseAnswerContract(JSON.parse(text)); assert.deepEqual(decoded, input);
    const scoped = rows.filter(item => input.scope.ids!.includes(item.id));
    const report = await verifyRlmAnswer(decoded, { environment });
    const variant = structuredClone(environment);
    for (const row of variant.items) for (const field of ['parent', 'assignee', 'sprint', 'release'] as const) if (row[field] === undefined) row[field] = undefined;
    assert.deepEqual(await verifyRlmAnswer(decoded, { environment: variant }), report);
    assert.deepEqual(await verifyRlmAnswer(decoded, { environment: JSON.parse(JSON.stringify(variant)) }), report);
    for (let i = 0; i < input.checks.length; i++) {
      const check = input.checks[i];
      const actual = check.kind === 'count' ? scoped.filter(item => item.type === check.filter.type && item.status === check.filter.status && item.tags.includes(check.filter.tag!)).length
        : check.kind === 'equals' ? (Object.hasOwn(scoped[0], check.field) ? scoped[0][check.field] : null)
          : scoped.some(item => (Object.hasOwn(item, check.field) ? item[check.field] : null) === check.value) ? 'present' : 'absent';
      assert.equal(report.checks[i].actual, actual);
      assert.equal(report.checks[i].status, actual === check.expected ? 'passed' : 'failed');
      assert.equal(acceptsSchema(ANSWER_INVARIANT_SCHEMA.result, report.checks[i]), true);
    }
    assert.deepEqual(validateAnswerReport(JSON.parse(JSON.stringify(report))), report);
    if (sequence % 25 === 0) assert.deepEqual((await client.get(native.id, { depth: 'full' })).item.dependencies, source.dependencies);
  }
  assert.ok(olderReplays > 100);
});

test('concurrent verification owns no shared tracker state and detaches supplied inputs', async t => {
  const { client, workspace } = await tracker(t);
  const item = (await client.create({ title: 'Before peer mutation', parent: 'none' })).item;
  const environment = await client.listAllComplete({ includeBody: true });
  const input = { ...contract(1), checks: [{ id: 'title', kind: 'equals', item: item.id, field: 'title', expected: item.title }] };
  const before = await bytes(workspace);
  const first = verifyRlmAnswer(input, { environment });
  const second = verifyRlmAnswer(input, { environment });
  input.checks[0].expected = 'Caller changed after invocation'; environment.items[0].title = 'Peer changed supplied object';
  const reports = await Promise.all([first, second]);
  assert.deepEqual(reports[0], reports[1]); assert.equal(reports[0].checks[0].actual, item.title);
  assert.equal(reports[0].status, 'passed'); assert.deepEqual(await bytes(workspace), before);
});

test('500 seeded output mutations reject nonfinite counters and contradictory success receipts', async t => {
  const { client } = await tracker(t);
  const valid = await verifyRlmAnswer(contract(), { environment: await client.listAllComplete() });
  const next = random();
  const values: unknown[] = [Infinity, -Infinity, NaN, -1, 1.5, Number.MAX_VALUE, '0', null, undefined, []];
  for (let i = 0; i < 500; i++) {
    const copy = structuredClone(valid) as unknown as Record<string, unknown>;
    const field = ['model_calls', 'writes', 'source', 'checks', 'verified_fact_ids', 'status'][i % 6];
    copy[field] = values[next() % values.length];
    assert.throws(() => validateAnswerReport(copy as unknown as RlmAnswerReport), RlmInvariantError);
  }
  for (const number of [-1, 0.5, Infinity, NaN, 1000000001]) { const copy = structuredClone(valid); copy.checks[0].actual = number; assert.throws(() => validateAnswerReport(copy), RlmInvariantError); }
  const edits = [
    (copy: RlmAnswerReport) => { copy.checks = []; },
    (copy: RlmAnswerReport) => { copy.checks.push(copy.checks[0]); },
    (copy: RlmAnswerReport) => { copy.verified_fact_ids = []; },
    (copy: RlmAnswerReport) => { copy.status = 'incomplete'; },
    (copy: RlmAnswerReport) => { copy.checks[0].reason = 'mismatch'; },
    (copy: RlmAnswerReport) => { copy.checks[0].remedy = 'unnecessary'; },
  ];
  for (const edit of edits) { const copy = structuredClone(valid); edit(copy); assert.throws(() => validateAnswerReport(copy), RlmInvariantError); }
});
