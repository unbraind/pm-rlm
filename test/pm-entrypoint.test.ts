import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * The npm shim directory holds platform launchers: shell scripts on Windows,
 * symlinks on Unix. A Node subprocess cannot execute the shim as an argument
 * to `process.execPath`, and spawning it as a command without a shell fails
 * there too, so every direct subprocess must invoke the pm CLI through the
 * package's JavaScript entrypoint instead.
 */

/** Match literal launcher paths and adjacent path-join parts, including Windows separators. */
const shimPattern = /\.bin(?:['"]?\s*,\s*['"]?|[\\/]+)pm\b/;

/** The package's JavaScript bin target, valid as a Node argument on every platform. */
const entrypoint = 'node_modules/@unbrained/pm-cli/dist/cli.js';

/** The forbidden shim suffix and directory part, assembled to keep this corpus self-clean. */
const segment = ['.bin', '/pm'].join('');
const directoryPart = JSON.stringify('.b' + 'in');

test('every package source invokes the pm CLI through its JavaScript entrypoint', () => {
  // Must-refuse corpus: each historical spelling of the shim reference matches.
  assert.ok(shimPattern.test(`run(process.execPath, [join(root, 'node_modules${segment}'), 'init'])`), 'path segment passed to a Node subprocess');
  assert.ok(shimPattern.test(`join(consumer, 'node_modules', ${directoryPart}, 'pm')`), 'adjacent join parts');
  assert.ok(shimPattern.test(`node_modules${segment.replace('/', '\\\\')}.cmd`), 'Windows launcher path');
  // Must-allow corpus: method binds, PATH construction and package-manager args never reference the shim.
  assert.ok(!shimPattern.test('const save = prepared.ledger.save.bind(prepared.ledger);'));
  assert.ok(!shimPattern.test('const hostPath = `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`;'));
  assert.ok(!shimPattern.test("const prefix = manager === 'npm' ? ['--no-install', 'pm'] : ['--bun', '--no-install', 'pm'];"));
  const root = join(import.meta.dirname, '..');
  assert.ok(existsSync(join(root, entrypoint)), 'the pm JavaScript entrypoint must be installed');
  const scanned: string[] = [];
  for (const directory of ['test', 'scripts', 'src', 'examples']) {
    for (const path of readdirSync(join(root, directory), { recursive: true }).map(String).filter(path => path.endsWith('.ts'))) {
      const source = readFileSync(join(root, directory, path), 'utf8');
      assert.ok(!shimPattern.test(source), `${join(directory, path)}: the npm shim path must not invoke the pm CLI; use the JavaScript entrypoint (${entrypoint}) with process.execPath`);
      scanned.push(join(directory, path));
    }
  }
  for (const path of readdirSync(root).filter(path => path.endsWith('.ts'))) {
    assert.ok(!shimPattern.test(readFileSync(join(root, path), 'utf8')), `${path}: use the package JavaScript entrypoint`);
    scanned.push(path);
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  for (const [name, command] of Object.entries(manifest.scripts)) {
    assert.ok(!shimPattern.test(command), `${name}: allow pm-changelog to resolve the installed JavaScript entrypoint`);
  }
  assert.ok(scanned.length > 100, 'the source scan must cover the whole package test suite');
});
