import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import {
  registerTools,
  inferSubsystemFromPath,
  truncate,
  normalizeName,
  normalizeTestName,
  classifyChanges,
  parseGitStatusPorcelain,
  parseTestLog,
} from './tools.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node');
const PKG_JSON = relative(REPO_ROOT, resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));

let devBinExists = false;
try { await access(join(REPO_ROOT, 'node')); devBinExists = true; } catch {}
const skipIfNoBin = !devBinExists && 'dev binary not built — run npm run setup';

function createMock() {
  const handlers = new Map();
  const mock = {
    tool(name, _desc, _schema, handler) { handlers.set(name, handler); },
    async call(name, args = {}) {
      const h = handlers.get(name);
      if (!h) throw new Error(`No tool registered: ${name}`);
      return h(args);
    },
  };
  registerTools(mock, REPO_ROOT);
  return mock;
}

// ── inferSubsystemFromPath ────────────────────────────────────────────────

test('inferSubsystemFromPath: lib/internal/url.js → url', () => {
  assert.strictEqual(inferSubsystemFromPath('lib/internal/url.js'), 'url');
});

test('inferSubsystemFromPath: lib/fs.js → fs', () => {
  assert.strictEqual(inferSubsystemFromPath('lib/fs.js'), 'fs');
});

test('inferSubsystemFromPath: src/node_url.cc → url', () => {
  assert.strictEqual(inferSubsystemFromPath('src/node_url.cc'), 'url');
});

test('inferSubsystemFromPath: test/parallel/test-whatwg-url-foo.js → whatwg', () => {
  assert.strictEqual(inferSubsystemFromPath('test/parallel/test-whatwg-url-foo.js'), 'whatwg');
});

test('inferSubsystemFromPath: doc/api/stream.md → stream', () => {
  assert.strictEqual(inferSubsystemFromPath('doc/api/stream.md'), 'stream');
});

test('inferSubsystemFromPath: tools/foo.js → tools', () => {
  assert.strictEqual(inferSubsystemFromPath('tools/foo.js'), 'tools');
});

// ── truncate ─────────────────────────────────────────────────────────────

test('truncate: short string passes through unchanged', () => {
  assert.strictEqual(truncate('hello'), 'hello');
});

test('truncate: long string is cut at limit with annotation', () => {
  const s = 'x'.repeat(100);
  const result = truncate(s, 10);
  assert.strictEqual(result.length > 10, true);
  assert.ok(result.includes('[truncated'));
  assert.ok(result.startsWith('x'.repeat(10)));
});

// ── normalizeName ────────────────────────────────────────────────────────

test('normalizeName: strips hyphens and lowercases', () => {
  assert.strictEqual(normalizeName('fast-utf8-stream'), 'fastutf8stream');
  assert.strictEqual(normalizeName('Fast_UTF8.Stream'), 'fastutf8stream');
});

// ── normalizeTestName ────────────────────────────────────────────────────

test('normalizeTestName: handles bare names, paths, and rerun commands', () => {
  assert.strictEqual(normalizeTestName('test-fs-watch'), 'test-fs-watch');
  assert.strictEqual(normalizeTestName('parallel/test-fs-watch.js'), 'test-fs-watch');
  assert.strictEqual(normalizeTestName('./node test/parallel/test-fs-watch.js'), 'test-fs-watch');
});

// ── classifyChanges ──────────────────────────────────────────────────────

test('classifyChanges: buckets files by build impact', () => {
  const cls = classifyChanges([
    'src/node_url.cc',
    'node.gyp',
    'lib/fs.js',
    'lib/internal/streams/fast-utf8-stream.js',
    'test/parallel/test-fs-watch.js',
    'doc/api/fs.md',
    'README.md',
  ]);
  assert.deepStrictEqual(cls.native, ['src/node_url.cc', 'node.gyp']);
  assert.deepStrictEqual(cls.js, ['lib/fs.js', 'lib/internal/streams/fast-utf8-stream.js']);
  assert.deepStrictEqual(cls.test, ['test/parallel/test-fs-watch.js']);
  assert.deepStrictEqual(cls.doc, ['doc/api/fs.md']);
  assert.deepStrictEqual(cls.other, ['README.md']);
});

// ── parseGitStatusPorcelain ──────────────────────────────────────────────

test('parseGitStatusPorcelain: parses modified, untracked, and renamed entries', () => {
  const out = ' M lib/fs.js\n?? lib/internal/new-thing.js\nR  lib/old.js -> lib/new.js\n';
  const files = parseGitStatusPorcelain(out);
  assert.deepStrictEqual(files, [
    { status: 'M', path: 'lib/fs.js' },
    { status: '??', path: 'lib/internal/new-thing.js' },
    { status: 'R', path: 'lib/new.js' },
  ]);
});

test('parseGitStatusPorcelain: survives trimmed leading whitespace on the first line', () => {
  const files = parseGitStatusPorcelain('M lib/fs.js'.trim());
  assert.deepStrictEqual(files, [{ status: 'M', path: 'lib/fs.js' }]);
});

// ── parseTestLog ─────────────────────────────────────────────────────────

test('parseTestLog: extracts failures and rerun commands', () => {
  const log = 'not ok 1 - test/parallel/test-foo.js\n# AssertionError: nope\n';
  const { failures, rerunCommands } = parseTestLog(log);
  assert.strictEqual(failures.length, 1);
  assert.strictEqual(rerunCommands[0], './node test/parallel/test-foo.js');
});

// ── explain_test_failure ─────────────────────────────────────────────────

test('explain_test_failure: parses TAP not-ok line', async () => {
  const mock = createMock();
  const log = [
    'TAP version 13',
    '1..2',
    'not ok 1 - test/parallel/test-foo.js',
    '# AssertionError: expected 1 to equal 2',
    'ok 2 - test/parallel/test-bar.js',
  ].join('\n');
  const res = await mock.call('explain_test_failure', { log });
  const data = JSON.parse(res.content[0].text);
  assert.strictEqual(data.failureCount, 1);
  assert.strictEqual(data.failures[0].test, 'test/parallel/test-foo.js');
  assert.ok(data.failures[0].details.includes('AssertionError'));
  assert.ok(data.rerunCommands[0].includes('test/parallel/test-foo.js'));
});

test('explain_test_failure: parses tools/test.py FAIL line', async () => {
  const mock = createMock();
  const log = 'FAIL test/parallel/test-baz.js\n';
  const res = await mock.call('explain_test_failure', { log });
  const data = JSON.parse(res.content[0].text);
  assert.strictEqual(data.failureCount, 1);
  assert.strictEqual(data.failures[0].test, 'test/parallel/test-baz.js');
});

test('explain_test_failure: parses tools/test.py === block format', async () => {
  const mock = createMock();
  const log = [
    '=== release test-fastutf8stream-sync ===',
    'Path: parallel/test-fastutf8stream-sync',
    "TypeError: Cannot read properties of undefined (reading 'fd')",
    '    at new FastUtf8Stream (node:internal/streams/fast-utf8-stream:120:5)',
    'Command: out/Release/node /home/x/node/test/parallel/test-fastutf8stream-sync.js',
    '[01:23|% 100|+ 4023|-   1]: Done',
  ].join('\n');
  const res = await mock.call('explain_test_failure', { log });
  const data = JSON.parse(res.content[0].text);
  assert.strictEqual(data.failureCount, 1);
  assert.strictEqual(data.failures[0].test, 'parallel/test-fastutf8stream-sync');
  assert.ok(data.failures[0].details.includes('TypeError'));
  assert.ok(data.errorMessages.some((m) => m.includes('TypeError')));
  assert.strictEqual(data.rerunCommands[0], 'tools/test.py parallel/test-fastutf8stream-sync');
});

test('explain_test_failure: reports no failures for passing log', async () => {
  const mock = createMock();
  const res = await mock.call('explain_test_failure', { log: 'ok 1 - test-foo\nok 2 - test-bar\n' });
  assert.strictEqual(res.content[0].text, 'No test failures detected in the provided log.');
});

// ── find_subsystem ────────────────────────────────────────────────────────

test('find_subsystem: url files return url subsystem', async () => {
  const mock = createMock();
  const res = await mock.call('find_subsystem', {
    files: ['lib/internal/url.js', 'test/parallel/test-whatwg-url-custom-searchparams.js'],
  });
  const data = JSON.parse(res.content[0].text);
  assert.ok(data.subsystem, 'missing subsystem');
  assert.ok(data.labels.includes('test'));
  assert.ok(Array.isArray(data.likelyReviewers));
});

// ── list_relevant_tests ───────────────────────────────────────────────────

test('list_relevant_tests: returns commands array and reason string', async () => {
  const mock = createMock();
  const res = await mock.call('list_relevant_tests', { changedFiles: ['lib/internal/url.js'] });
  const data = JSON.parse(res.content[0].text);
  assert.ok(Array.isArray(data.commands));
  assert.ok(typeof data.reason === 'string');
});

test('list_relevant_tests: finds test-fastutf8stream-* for lib/internal/streams/fast-utf8-stream.js', async () => {
  const mock = createMock();
  const res = await mock.call('list_relevant_tests', {
    changedFiles: ['lib/internal/streams/fast-utf8-stream.js'],
  });
  const data = JSON.parse(res.content[0].text);
  assert.ok(
    data.commands.some((c) => c.includes('fastutf8stream')),
    `expected a fastutf8stream command, got: ${JSON.stringify(data.commands)}`,
  );
  assert.ok(data.affectedModules.includes('fs'), `expected fs in ${JSON.stringify(data.affectedModules)}`);
});

test('list_relevant_tests: changed test file is run directly', async () => {
  const mock = createMock();
  const res = await mock.call('list_relevant_tests', {
    changedFiles: ['test/parallel/test-assert.js'],
  });
  const data = JSON.parse(res.content[0].text);
  assert.ok(data.commands.includes('./node test/parallel/test-assert.js'));
});

// ── verify_change ─────────────────────────────────────────────────────────

test('verify_change: empty file list reports clean state', async () => {
  const mock = createMock();
  const res = await mock.call('verify_change', { files: [] });
  assert.ok(res.content[0].text.includes('No local changes'));
});

test('verify_change: doc-only change skips build and runs no tests', async () => {
  const mock = createMock();
  const res = await mock.call('verify_change', { files: ['doc/api/fs.md'] });
  const data = JSON.parse(res.content[0].text);
  assert.strictEqual(data.build.ran, false);
  assert.ok(data.build.skipped);
  assert.strictEqual(data.verdict, 'no-tests-run');
});

test('verify_change: js change without builtin-modules-path requires rebuild', async () => {
  const mock = createMock();
  const res = await mock.call('verify_change', {
    files: ['lib/internal/streams/fast-utf8-stream.js'],
    skip_build: true,
    max_test_runs: 0,
  });
  const data = JSON.parse(res.content[0].text);
  assert.strictEqual(data.build.skipped, 'skip_build requested');
  assert.ok(data.tests.skipped.some((c) => c.includes('fastutf8stream')),
            `expected fastutf8stream in skipped runs: ${res.content[0].text}`);
});

test('verify_change: test-only change runs the test directly', { skip: skipIfNoBin }, async () => {
  const mock = createMock();
  const res = await mock.call('verify_change', { files: ['test/parallel/test-assert.js'] });
  const data = JSON.parse(res.content[0].text);
  assert.strictEqual(data.build.ran, false);
  assert.strictEqual(data.verdict, 'pass', res.content[0].text);
  assert.strictEqual(data.tests.ran[0].command, './node test/parallel/test-assert.js');
});

// ── get_node_version ─────────────────────────────────────────────────────

test('get_node_version: returns a version string from dev binary', { skip: skipIfNoBin }, async () => {
  const mock = createMock();
  const res = await mock.call('get_node_version', {});
  assert.ok(res.content[0].text.match(/^v\d+\.\d+/), `unexpected output: ${res.content[0].text}`);
});

// ── run_test ──────────────────────────────────────────────────────────────

test('run_test: runs a parallel test with dev binary', { skip: skipIfNoBin }, async () => {
  const mock = createMock();
  const res = await mock.call('run_test', { file: 'test/parallel/test-assert.js' });
  assert.ok(!res.isError, res.content[0].text);
});

// ── read_file ─────────────────────────────────────────────────────────────

test('read_file: returns file contents', async () => {
  const mock = createMock();
  const res = await mock.call('read_file', { file: PKG_JSON });
  assert.ok(!res.isError, res.content[0].text);
  assert.ok(res.content[0].text.includes('node-core-mcp'));
});

test('read_file: offset and limit slice lines', async () => {
  const mock = createMock();
  const res = await mock.call('read_file', { file: PKG_JSON, offset: 2, limit: 1 });
  assert.ok(!res.isError, res.content[0].text);
  assert.strictEqual(res.content[0].text.split('\n').length, 1);
});

test('read_file: nonexistent file returns isError', async () => {
  const mock = createMock();
  const res = await mock.call('read_file', { file: '__nonexistent__/file.js' });
  assert.strictEqual(res.isError, true);
});

// ── git_log ───────────────────────────────────────────────────────────────

test('git_log: returns commit history', async () => {
  const mock = createMock();
  const res = await mock.call('git_log', { limit: 5 });
  assert.ok(typeof res.content[0].text === 'string');
});

test('git_log: accepts path filter', async () => {
  const mock = createMock();
  const res = await mock.call('git_log', { path: 'lib', limit: 5 });
  assert.ok(typeof res.content[0].text === 'string');
});

// ── list_docs ─────────────────────────────────────────────────────────────

test('list_docs: returns .md file names', async () => {
  const mock = createMock();
  const res = await mock.call('list_docs', {});
  assert.ok(res.content[0].text.includes('.md'));
});
