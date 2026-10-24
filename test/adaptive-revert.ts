/** Targeted behavioral reverts restore exact source bytes after each proof. */
import { proveRevert } from './revert-source.ts';
const file = 'test/adaptive.test.ts';
proveRevert({ name: 'tiny-budget typed component coverage', file: 'src/adaptive.ts', before: "status: 'deferred', refusal: 'budget'", after: "status: 'unknown', refusal: 'budget'", pattern: '^tiny budgets return typed partials' }, file);
proveRevert({ name: 'deterministic decomposition selection', file: 'src/adaptive.ts', before: 'b.admitted_groups - a.admitted_groups', after: 'a.admitted_groups - b.admitted_groups', pattern: '^strategy comparisons and stopped splitting' }, file);
proveRevert({ name: 'terminal child evidence', file: 'src/adaptive.ts', before: "await child.ledger.failUnfinished(child.run, { code: refusal, reason: 'Adaptive child terminated before completion' })", after: '{ skipped: [] }', pattern: '^child failures preserve terminal evidence' }, file);
console.log('3/3 adaptive behavioral revert proofs passed');
