import { execFile } from 'node:child_process';
import { readFile, readdir, access, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT = 32_000;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[node-core-mcp] ${ts} ${msg}\n`);
}

export function truncate(str, limit = MAX_OUTPUT) {
  if (str.length <= limit) return str;
  log(`truncated output: ${str.length} -> ${limit} chars`);
  return str.slice(0, limit) + `\n...[truncated ${str.length - limit} chars]`;
}

export function inferSubsystemFromPath(file) {
  const parts = file.replace(/\\/g, '/').split('/');
  if (parts[0] === 'lib') {
    const idx = parts[1] === 'internal' ? 2 : 1;
    return parts[idx]?.replace(/\.m?js$/, '') || null;
  }
  if (parts[0] === 'src') {
    return parts[1]?.replace(/^node_/, '').replace(/\.(cc|h)$/, '') || null;
  }
  if (parts[0] === 'test') {
    const name = parts[parts.length - 1]?.replace(/^test-/, '').replace(/\.m?js$/, '');
    return name?.split('-')[0] || null;
  }
  if (parts[0] === 'doc' && parts[1] === 'api') return parts[2]?.replace(/\.md$/, '') || null;
  if (parts[0] === 'tools') return 'tools';
  if (parts[0] === 'benchmark') return 'benchmark';
  if (parts[0] === 'deps') return 'deps';
  return null;
}

export function normalizeName(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function classifyChanges(files) {
  const result = { native: [], js: [], test: [], doc: [], other: [] };
  for (const file of files) {
    const p = file.replace(/\\/g, '/');
    if (/\.(cc|h|gyp|gypi)$/.test(p) || p.startsWith('src/') || p.startsWith('deps/') ||
        p === 'configure' || p === 'configure.py') {
      result.native.push(file);
    } else if (p.startsWith('lib/') && p.endsWith('.js')) {
      result.js.push(file);
    } else if (p.startsWith('test/')) {
      result.test.push(file);
    } else if (p.startsWith('doc/')) {
      result.doc.push(file);
    } else {
      result.other.push(file);
    }
  }
  return result;
}

// Tolerates trimmed leading whitespace (exec() trims stdout, which drops the
// leading space of the first " M path" line), so the XY field cannot be read
// at a fixed offset.
export function parseGitStatusPorcelain(output) {
  const files = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*([A-Z?!]{1,2})\s+(.+)$/);
    if (!m) continue;
    let path = m[2];
    if (path.includes(' -> ')) path = path.split(' -> ')[1];
    path = path.replace(/^"|"$/g, '');
    files.push({ status: m[1], path });
  }
  return files;
}

export function parseTestLog(log) {
  const failures = [];
  const lines = log.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tap = line.match(/^not ok \d+ - (.+)/);
    if (tap) {
      const diagnostics = [];
      for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
        if (lines[j].startsWith('#') || lines[j].startsWith('  ')) {
          diagnostics.push(lines[j].replace(/^#\s*/, '').trim());
        } else if (/^(ok|not ok)\s/.test(lines[j])) break;
      }
      failures.push({ test: tap[1].trim(), details: diagnostics.join('\n').trim() });
      continue;
    }
    const py = line.match(/^(?:FAIL|FAILED)\s+(test\/\S+)/);
    if (py) {
      failures.push({ test: py[1], details: '' });
      continue;
    }
    // tools/test.py failure blocks: "=== release test-foo ===" followed by
    // "Path: parallel/test-foo", the error output, and a "Command: ..." line.
    const block = line.match(/^=== \S+ (\S+) ===/);
    if (block) {
      let test = block[1];
      const diagnostics = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^=== \S+ \S+ ===/.test(lines[j]) || /^\[[\d:|%+ -]+\]/.test(lines[j])) break;
        const path = lines[j].match(/^Path:\s*(\S+)/);
        if (path) {
          test = path[1];
        } else if (lines[j].trim() && !lines[j].startsWith('Command:')) {
          diagnostics.push(lines[j].trim());
        }
      }
      failures.push({ test, details: diagnostics.slice(0, 30).join('\n').trim() });
    }
  }

  const errorMessages = lines
    .filter((l) => /^\s*([A-Z][a-zA-Z]*Error|assert\.)/.test(l))
    .slice(0, 5)
    .map((l) => l.trim());

  const rerunCommands = [...new Set(
    failures.map((f) => (f.test.startsWith('test/') ? `./node ${f.test}` : `tools/test.py ${f.test}`)),
  )].slice(0, 10);

  return { failures, errorMessages, rerunCommands };
}

// Accepts 'test-fs-watch', 'parallel/test-fs-watch.js', or a full rerun
// command like './node test/parallel/test-fs-watch.js'.
export function normalizeTestName(test) {
  return test.trim().split(/\s+/).pop().split('/').pop().replace(/\.m?js$/, '');
}

export function registerTools(server, root) {
  async function exec(cmd, args, { cwd = root, timeout = 30_000, env } = {}) {
    const label = `${cmd} ${args[0] ?? ''}`.trim();
    const t0 = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '0', ...env },
      });
      const out = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim();
      log(`exec ok [${Date.now() - t0}ms]: ${label}`);
      return { ok: true, output: truncate(out) };
    } catch (err) {
      const out = [
        err.stdout,
        err.stderr ? `STDERR:\n${err.stderr}` : '',
        err.killed ? `[killed: timeout or signal]` : `[exit code: ${err.code}]`,
      ].filter(Boolean).join('\n').trim();
      log(`exec fail [${Date.now() - t0}ms] (${err.killed ? 'killed' : `exit ${err.code}`}): ${label}`);
      return { ok: false, output: truncate(out) };
    }
  }

  async function getNodeBin() {
    const devBin = join(root, 'node');
    try {
      await access(devBin);
      return devBin;
    } catch {
      return process.execPath;
    }
  }

  // ── Indexes (built lazily, cached for the server's lifetime) ────────────

  let testIndexPromise = null;
  let requireGraphPromise = null;

  async function getTestIndex() {
    testIndexPromise ??= (async () => {
      const t0 = Date.now();
      const entries = [];
      for (const dir of ['parallel', 'sequential']) {
        let names;
        try { names = await readdir(join(root, 'test', dir)); } catch { continue; }
        for (const n of names) {
          const m = n.match(/^test-(.+)\.m?js$/);
          if (m) entries.push({ rel: `test/${dir}/${n}`, dir, name: m[1], norm: normalizeName(m[1]) });
        }
      }
      log(`test name index built: ${entries.length} entries [${Date.now() - t0}ms]`);
      return entries;
    })();
    return testIndexPromise;
  }

  async function walkJsFiles(dir, prefix, acc) {
    let entries;
    try { entries = await readdir(join(root, dir), { withFileTypes: true }); } catch { return acc; }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) await walkJsFiles(rel, prefix, acc);
      else if (e.name.endsWith('.js')) acc.push(rel);
    }
    return acc;
  }

  // Maps each lib file to the set of lib files that require it directly.
  async function getRequireGraph() {
    requireGraphPromise ??= (async () => {
      const t0 = Date.now();
      const files = await walkJsFiles('lib', 'lib', []);
      const fileSet = new Set(files);
      const reverse = new Map();
      const contents = await Promise.all(
        files.map((rel) => readFile(join(root, rel), 'utf8').catch(() => '')),
      );
      for (let i = 0; i < files.length; i++) {
        for (const m of contents[i].matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
          const id = m[1].replace(/^node:/, '');
          if (!/^[a-z0-9_/-]+$/.test(id)) continue;
          const target = `lib/${id}.js`;
          if (!fileSet.has(target) || target === files[i]) continue;
          if (!reverse.has(target)) reverse.set(target, new Set());
          reverse.get(target).add(files[i]);
        }
      }
      log(`require graph built: ${files.length} files, ${reverse.size} targets [${Date.now() - t0}ms]`);
      return reverse;
    })();
    return requireGraphPromise;
  }

  // Walk the reverse require graph from a lib file up to the public modules
  // (lib/*.js outside internal/) that ultimately expose it. Stops at the
  // public boundary so a change to internal/util does not fan out to every
  // module that requires 'util'.
  function publicModulesFor(relPath, reverse) {
    const seen = new Set([relPath]);
    const queue = [relPath];
    const modules = new Set();
    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur.startsWith('lib/internal/')) {
        modules.add(cur.slice(4, -3));
        continue;
      }
      for (const requirer of reverse.get(cur) ?? []) {
        if (!seen.has(requirer)) {
          seen.add(requirer);
          queue.push(requirer);
        }
      }
    }
    return [...modules];
  }

  // Match test files whose normalized name (hyphens stripped) starts with or
  // contains the changed file's normalized basename. This is what catches
  // lib/internal/streams/fast-utf8-stream.js -> test-fastutf8stream-*.
  function matchTestsByName(index, baseNorm) {
    if (baseNorm.length < 4) return [];
    return index.filter((e) =>
      e.norm === baseNorm ||
      e.norm.startsWith(baseNorm) ||
      (baseNorm.length >= 6 && e.norm.includes(baseNorm)),
    );
  }

  function commonTestPattern(entries) {
    const names = entries.map((e) => e.name);
    let prefix = names[0];
    for (const n of names.slice(1)) {
      while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
    }
    const cut = prefix.lastIndexOf('-');
    return cut > 0 ? prefix.slice(0, cut + 1) : prefix;
  }

  // Selects tests for a set of changed files. Returns structured runs so
  // verify_change can execute them and list_relevant_tests can display them.
  // runs: specific tests worth running automatically.
  // broader: subsystem-wide patterns (may be large; informational).
  async function selectTests(changedFiles) {
    const index = await getTestIndex();
    const runs = [];
    const broader = [];
    const reasons = [];
    const seen = new Set();

    function addRun(run) {
      if (!seen.has(run.display)) { seen.add(run.display); runs.push(run); }
    }

    for (const file of changedFiles) {
      if (file.startsWith('test/') && /\.m?js$/.test(file)) {
        addRun({ display: `./node ${file}`, kind: 'node', files: [file] });
      }
    }

    const modules = new Set();
    const libChanged = changedFiles.filter((f) => f.startsWith('lib/') && f.endsWith('.js'));

    if (libChanged.length > 0) {
      const reverse = await getRequireGraph();
      for (const file of libChanged) {
        const base = file.split('/').pop().replace(/\.js$/, '');
        const matched = matchTestsByName(index, normalizeName(base));
        if (matched.length > 0) {
          reasons.push(`${matched.length} tests match "${base}" by name`);
          if (matched.length > 4) {
            const pattern = commonTestPattern(matched);
            addRun({
              display: `tools/test.py -J ${matched[0].dir}/test-${pattern}*`,
              kind: 'testpy',
              specs: [`${matched[0].dir}/test-${pattern}*`],
            });
          } else {
            for (const e of matched) addRun({ display: `./node ${e.rel}`, kind: 'node', files: [e.rel] });
          }
        }
        for (const mod of publicModulesFor(file, reverse)) modules.add(mod);
      }
    }

    for (const file of changedFiles) {
      if (file.startsWith('src/')) {
        const s = inferSubsystemFromPath(file);
        if (s) modules.add(s);
      }
    }

    if (modules.size > 8) {
      reasons.push(`change fans out to ${modules.size} public modules — run the full suite (tools/test.py -J parallel) instead of per-module patterns`);
    } else {
      for (const mod of modules) {
        const top = mod.split('/')[0];
        const hasTests = index.some((e) => e.name === top || e.name.startsWith(`${top}-`));
        if (hasTests) broader.push(`tools/test.py -J parallel/test-${top}-*`);
      }
    }

    return { runs, broader: [...new Set(broader)], reasons, modules: [...modules] };
  }

  // ── Build ───────────────────────────────────────────────────────────────

  server.tool('configure',
              'Run ./configure to set build flags. Required before the first build or when changing flags.',
              {
                type: 'object',
                properties: {
                  debug: {
                    type: 'boolean',
                    description: 'Build in debug mode (passes --debug)',
                    default: false,
                  },
                  extra_flags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Additional flags, e.g. ["--with-intl=full-icu", "--ninja"]',
                    default: [],
                  },
                },
              },
              async ({ debug = false, extra_flags: extraFlags = [] }) => {
                const args = [];
                if (debug) args.push('--debug');
                args.push(...extraFlags);
                const { ok, output } = await exec('./configure', args, { timeout: 120_000 });
                return {
                  content: [{ type: 'text', text: ok ? `Configure succeeded.\n\n${output}` : `Configure failed.\n\n${output}` }],
                  isError: !ok,
                };
              },
  );

  server.tool('build',
              'Build Node.js. Pass target="" for the default release build (equivalent to `make -j4`).',
              {
                type: 'object',
                properties: {
                  target: {
                    type: 'string',
                    description: 'Make target (e.g. "", "test-only", "lint", "doc-only")',
                    default: '',
                  },
                  jobs: {
                    type: 'integer',
                    description: 'Parallel jobs (-j). Default: 4.',
                    default: 4,
                  },
                },
              },
              async ({ target = '', jobs = 4 }) => {
                const args = [`-j${jobs}`];
                if (target) args.push(target);
                const { ok, output } = await exec('make', args, { timeout: 300_000 });
                return {
                  content: [{ type: 'text', text: ok ? `Build succeeded.\n\n${output}` : `Build failed.\n\n${output}` }],
                  isError: !ok,
                };
              },
  );

  server.tool('run_lint',
              'Run the Node.js linter. Use target "js" (default), "cpp", or "all" (make lint).',
              {
                type: 'object',
                properties: {
                  target: {
                    type: 'string',
                    enum: ['js', 'cpp', 'all'],
                    description: 'Which linter to run. Default: "js".',
                    default: 'js',
                  },
                },
              },
              async ({ target = 'js' }) => {
                const makeTarget = target === 'all' ? 'lint' : `lint-${target}`;
                const { ok, output } = await exec('make', [makeTarget], { timeout: 120_000 });
                return {
                  content: [{ type: 'text', text: ok ? `Lint passed.\n\n${output}` : `Lint failed.\n\n${output}` }],
                  isError: !ok,
                };
              },
  );

  server.tool('get_node_version',
              'Get the version string of the local dev build. Falls back to the system Node.js if no dev binary exists.',
              { type: 'object', properties: {} },
              async () => {
                const nodeBin = await getNodeBin();
                const { ok, output } = await exec(nodeBin, ['--version'], { timeout: 10_000 });
                return {
                  content: [{ type: 'text', text: ok ? output : `Failed to get version: ${output}` }],
                  isError: !ok,
                };
              },
  );

  // ── Test ────────────────────────────────────────────────────────────────

  server.tool('run_test',
              'Run a single test file with the dev Node.js binary (fast, no test runner overhead).',
              {
                type: 'object',
                properties: {
                  file: {
                    type: 'string',
                    description: 'Test file path relative to repo root, e.g. "test/parallel/test-stream2-transform.js"',
                  },
                  flags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Extra Node.js flags, e.g. ["--expose-internals"]',
                    default: [],
                  },
                },
                required: ['file'],
              },
              async ({ file, flags = [] }) => {
                const nodeBin = await getNodeBin();
                const abs = join(root, file);
                const { ok, output } = await exec(nodeBin, [...flags, abs], { cwd: root, timeout: 60_000 });
                return {
                  content: [{ type: 'text', text: ok ? `Test passed.\n\n${output}` : `Test failed.\n\n${output}` }],
                  isError: !ok,
                };
              },
  );

  server.tool('run_tests',
              'Run tests matching a pattern or subsystem using tools/test.py.',
              {
                type: 'object',
                properties: {
                  pattern: {
                    type: 'string',
                    description: 'Glob pattern or subsystem name, e.g. "parallel/test-stream-*" or "child-process"',
                  },
                  timeout: {
                    type: 'integer',
                    description: 'Per-test timeout in seconds. Default: 60.',
                    default: 60,
                  },
                },
                required: ['pattern'],
              },
              async ({ pattern, timeout: perTestTimeout = 60 }) => {
                const args = [join(root, 'tools/test.py'), `--timeout=${perTestTimeout}`, '--no-progress', pattern];
                const { ok, output } = await exec('python3', args, { timeout: 300_000 });
                return {
                  content: [{ type: 'text', text: ok ? `Tests passed.\n\n${output}` : `Tests failed.\n\n${output}` }],
                  isError: !ok,
                };
              },
  );

  server.tool('run_benchmark',
              'Run a benchmark file with the dev Node.js binary.',
              {
                type: 'object',
                properties: {
                  file: {
                    type: 'string',
                    description: 'Benchmark file path relative to repo root, e.g. "benchmark/buffers/buffer-creation.js"',
                  },
                  flags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Extra Node.js flags',
                    default: [],
                  },
                },
                required: ['file'],
              },
              async ({ file, flags = [] }) => {
                const nodeBin = await getNodeBin();
                const { ok, output } = await exec(nodeBin, [...flags, join(root, file)], { timeout: 120_000 });
                return {
                  content: [{ type: 'text', text: ok ? `Benchmark completed.\n\n${output}` : `Benchmark failed.\n\n${output}` }],
                  isError: !ok,
                };
              },
  );

  // ── Verify ────────────────────────────────────────────────────────────────

  async function detectBuiltinModulesPath() {
    try {
      const gypi = await readFile(join(root, 'config.gypi'), 'utf8');
      const m = gypi.match(/'node_builtin_modules_path':\s*'([^']+)'/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  server.tool('verify_change',
              'Verify local changes end-to-end: detect changed files via git, rebuild only when actually required ' +
              '(JS-only changes need no rebuild if the binary was configured with --node-builtin-modules-path), ' +
              'run the relevant tests, and return parsed results. This is the fastest edit-verify loop.',
              {
                type: 'object',
                properties: {
                  files: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Changed file paths relative to repo root. Auto-detected via git status if omitted.',
                  },
                  skip_build: {
                    type: 'boolean',
                    description: 'Skip the build step even if a rebuild appears necessary.',
                    default: false,
                  },
                  jobs: {
                    type: 'integer',
                    description: 'Parallel build jobs (-j). Default: 4.',
                    default: 4,
                  },
                  max_test_runs: {
                    type: 'integer',
                    description: 'Maximum number of test commands to execute. Default: 5.',
                    default: 5,
                  },
                },
              },
              async ({ files, skip_build: skipBuild = false, jobs = 4, max_test_runs: maxTestRuns = 5 }) => {
                const added = new Set();
                let changed = files;
                if (!changed) {
                  const { ok, output } = await exec('git', ['status', '--porcelain'], { timeout: 15_000 });
                  if (!ok) {
                    return { content: [{ type: 'text', text: `git status failed:\n${output}` }], isError: true };
                  }
                  const parsed = parseGitStatusPorcelain(output);
                  changed = parsed.map((f) => f.path);
                  for (const f of parsed) {
                    if (f.status.includes('A') || f.status === '??') added.add(f.path);
                  }
                }
                if (changed.length === 0) {
                  return { content: [{ type: 'text', text: 'No local changes detected (git status is clean).' }] };
                }

                const cls = classifyChanges(changed);
                const result = {
                  changedFiles: changed,
                  classification: Object.fromEntries(
                    Object.entries(cls).filter(([, v]) => v.length > 0).map(([k, v]) => [k, v]),
                  ),
                };

                const build = { ran: false, ok: true };
                if (skipBuild) {
                  build.skipped = 'skip_build requested';
                } else if (cls.native.length > 0) {
                  build.required = 'native sources changed';
                } else if (cls.js.length > 0) {
                  const builtinPath = await detectBuiltinModulesPath();
                  const newJs = cls.js.filter((f) => added.has(f));
                  if (builtinPath && resolve(builtinPath) === resolve(root) && newJs.length === 0) {
                    build.skipped = 'binary loads lib/ from disk (--node-builtin-modules-path) — JS changes take effect without rebuilding';
                  } else {
                    build.required = newJs.length > 0 ?
                      `new lib/ files (${newJs.join(', ')}) must be compiled into the binary` :
                      'binary embeds lib/ — JS changes require a rebuild';
                    if (!builtinPath) {
                      build.hint = 'Reconfigure once with ./configure --node-builtin-modules-path="$(pwd)" to skip rebuilds for JS-only changes.';
                    }
                  }
                } else {
                  build.skipped = 'no native or lib/ changes';
                }

                if (build.required) {
                  const t0 = Date.now();
                  const { ok, output } = await exec('make', [`-j${jobs}`, 'node'], { timeout: 600_000 });
                  build.ran = true;
                  build.ok = ok;
                  build.seconds = Math.round((Date.now() - t0) / 1000);
                  if (!ok) {
                    build.output = truncate(output, 8_000);
                    result.build = build;
                    result.verdict = 'build-failed';
                    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: true };
                  }
                }
                result.build = build;

                const sel = await selectTests(changed);
                let runs = sel.runs;
                if (runs.length === 0 && sel.broader.length > 0) {
                  const display = sel.broader[0];
                  runs = [{ display, kind: 'testpy', specs: [display.replace('tools/test.py -J ', '')] }];
                }
                const skippedRuns = runs.slice(maxTestRuns).map((r) => r.display);
                runs = runs.slice(0, maxTestRuns);

                const nodeBin = await getNodeBin();
                const testResults = [];
                let allPassed = true;
                for (const run of runs) {
                  const res = run.kind === 'node' ?
                    await exec(nodeBin, run.files.map((f) => join(root, f)), { timeout: 120_000 }) :
                    await exec('python3', [join(root, 'tools/test.py'), '-J', '--no-progress', ...run.specs], { timeout: 300_000 });
                  const entry = { command: run.display, ok: res.ok };
                  if (!res.ok) {
                    allPassed = false;
                    const { failures, errorMessages } = parseTestLog(res.output);
                    entry.failures = failures.slice(0, 10);
                    entry.errorMessages = errorMessages;
                    if (failures.length === 0) entry.output = truncate(res.output, 4_000);
                  }
                  testResults.push(entry);
                }

                result.tests = { ran: testResults, skipped: skippedRuns, broader: sel.broader };
                if (runs.length === 0) {
                  result.tests.note = 'No relevant tests identified for these changes.';
                  result.verdict = 'no-tests-run';
                } else {
                  result.verdict = allPassed ? 'pass' : 'tests-failed';
                }
                return {
                  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                  isError: !allPassed,
                };
              },
  );

  // ── Code Search ─────────────────────────────────────────────────────────

  server.tool('search_code',
              'Search for a pattern in the Node.js source (grep -rn). Searches lib/, src/, test/ by default.',
              {
                type: 'object',
                properties: {
                  pattern: {
                    type: 'string',
                    description: 'Search pattern (extended regex)',
                  },
                  dir: {
                    type: 'string',
                    description: 'Directory to search in, relative to repo root. Default: searches lib/, src/, test/.',
                    default: '',
                  },
                  include: {
                    type: 'string',
                    description: 'File glob filter, e.g. "*.js" or "*.cc"',
                    default: '',
                  },
                  ignore_case: {
                    type: 'boolean',
                    description: 'Case-insensitive search',
                    default: false,
                  },
                },
                required: ['pattern'],
              },
              async ({ pattern, dir = '', include = '', ignore_case: ignoreCase = false }) => {
                const args = ['-rn', '--include=*.js', '--include=*.cc', '--include=*.h'];
                if (ignoreCase) args.push('-i');
                if (include) {
                  const idx = args.indexOf('--include=*.js');
                  args.splice(idx, 3, `--include=${include}`);
                }
                args.push('--', pattern);
                const targets = dir ?
                  [join(root, dir)] :
                  [join(root, 'lib'), join(root, 'src'), join(root, 'test')];
                args.push(...targets);
                const { ok, output } = await exec('grep', args, { timeout: 15_000 });
                if (!ok && !output) return { content: [{ type: 'text', text: 'No matches found.' }] };
                return { content: [{ type: 'text', text: truncate(output, 8_000) }] };
              },
  );

  server.tool('read_file',
              'Read a source file from the Node.js repo.',
              {
                type: 'object',
                properties: {
                  file: {
                    type: 'string',
                    description: 'File path relative to repo root, e.g. "lib/fs.js"',
                  },
                  offset: {
                    type: 'integer',
                    description: 'Line number to start reading from (1-based). Default: 1.',
                    default: 1,
                  },
                  limit: {
                    type: 'integer',
                    description: 'Number of lines to read. Reads the whole file if omitted.',
                  },
                },
                required: ['file'],
              },
              async ({ file, offset = 1, limit }) => {
                try {
                  const raw = await readFile(join(root, file), 'utf8');
                  let lines = raw.split('\n');
                  if (offset > 1) lines = lines.slice(offset - 1);
                  if (limit != null) lines = lines.slice(0, limit);
                  return { content: [{ type: 'text', text: truncate(lines.join('\n'), 16_000) }] };
                } catch (err) {
                  return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
                }
              },
  );

  server.tool('git_log',
              'Show recent git commit history, optionally filtered by path.',
              {
                type: 'object',
                properties: {
                  path: {
                    type: 'string',
                    description: 'File or directory path relative to repo root (optional)',
                    default: '',
                  },
                  limit: {
                    type: 'integer',
                    description: 'Number of commits to show. Default: 20.',
                    default: 20,
                  },
                  format: {
                    type: 'string',
                    enum: ['oneline', 'short'],
                    description: 'Output format. Default: "oneline".',
                    default: 'oneline',
                  },
                },
              },
              async ({ path: filePath = '', limit = 20, format = 'oneline' }) => {
                const args = ['log', `--pretty=${format}`, `-${limit}`];
                if (filePath) args.push('--', filePath);
                const { ok, output } = await exec('git', args, { timeout: 15_000 });
                if (!ok && !output) return { content: [{ type: 'text', text: 'No commits found.' }] };
                return { content: [{ type: 'text', text: truncate(output, 8_000) }] };
              },
  );

  // ── Documentation ───────────────────────────────────────────────────────

  server.tool('list_docs',
              'List available API documentation files in doc/api/.',
              { type: 'object', properties: {} },
              async () => {
                try {
                  const files = await readdir(join(root, 'doc/api'));
                  const sorted = files.filter((f) => f.endsWith('.md')).sort().join('\n');
                  return { content: [{ type: 'text', text: sorted }] };
                } catch (err) {
                  return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
                }
              },
  );

  server.tool('read_doc',
              'Read an API documentation file from doc/api/.',
              {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Doc filename, e.g. "mcp.md" or "stream.md"',
                  },
                },
                required: ['name'],
              },
              async ({ name }) => {
                const filename = name.endsWith('.md') ? name : `${name}.md`;
                try {
                  const content = await readFile(join(root, 'doc/api', filename), 'utf8');
                  return { content: [{ type: 'text', text: truncate(content, 16_000) }] };
                } catch {
                  try {
                    const files = await readdir(join(root, 'doc/api'));
                    const match = files.find((f) => f.toLowerCase() === filename.toLowerCase());
                    if (match) {
                      const content = await readFile(join(root, 'doc/api', match), 'utf8');
                      return { content: [{ type: 'text', text: truncate(content, 16_000) }] };
                    }
                  } catch {
                    // Fall through to not-found return below
                  }
                  return { content: [{ type: 'text', text: `Doc not found: ${filename}` }], isError: true };
                }
              },
  );

  // ── Subsystem / Review ──────────────────────────────────────────────────

  server.tool('find_subsystem',
              'Given changed files, identify the primary Node.js subsystem, reviewers, and PR labels.',
              {
                type: 'object',
                properties: {
                  files: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'File paths relative to repo root',
                  },
                },
                required: ['files'],
              },
              async ({ files }) => {
                const counts = {};
                const labels = new Set();

                for (const file of files) {
                  const s = inferSubsystemFromPath(file);
                  if (s) counts[s] = (counts[s] || 0) + 1;
                  if (file.startsWith('test/')) labels.add('test');
                  if (file.startsWith('doc/')) labels.add('doc');
                  if (file.startsWith('benchmark/')) labels.add('benchmark');
                }

                for (const file of files.slice(0, 5)) {
                  const { ok, output } = await exec('git', ['log', '--oneline', '-10', '--', file], { timeout: 8_000 });
                  if (!ok || !output) continue;
                  for (const line of output.split('\n')) {
                    const m = line.match(/^[a-f0-9]+ ([a-z][a-z0-9_/-]*(?:,[a-z][a-z0-9_/-]*)*):/);
                    if (m) {
                      for (const s of m[1].split(',').map((x) => x.trim())) {
                        counts[s] = (counts[s] || 0) + 2;
                      }
                    }
                  }
                }

                const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([s]) => s);
                const subsystem = sorted[0] || 'unknown';
                labels.add(subsystem);

                return {
                  content: [{
                    type: 'text',
                    text: JSON.stringify({
                      subsystem,
                      likelyReviewers: sorted.slice(0, 3),
                      labels: [...labels].sort(),
                    }, null, 2),
                  }],
                };
              },
  );

  server.tool('list_relevant_tests',
              'Given changed files, suggest which tests to run. Uses the lib/ require graph and test name matching, not just path heuristics.',
              {
                type: 'object',
                properties: {
                  changedFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Changed file paths relative to repo root',
                  },
                },
                required: ['changedFiles'],
              },
              async ({ changedFiles }) => {
                const { runs, broader, reasons, modules } = await selectTests(changedFiles);
                const commands = runs.map((r) => r.display);
                return {
                  content: [{
                    type: 'text',
                    text: JSON.stringify({
                      commands: commands.length > 0 ? commands : broader,
                      broader,
                      affectedModules: modules,
                      reason: reasons.length > 0 ? reasons.join('; ') : 'Selected via require graph and test name index.',
                    }, null, 2),
                  }],
                };
              },
  );

  server.tool('explain_test_failure',
              'Parse a test failure log (TAP or tools/test.py) and return failures and re-run commands.',
              {
                type: 'object',
                properties: {
                  log: {
                    type: 'string',
                    description: 'Raw test output log',
                  },
                  platform: {
                    type: 'string',
                    enum: ['linux', 'darwin', 'win32'],
                    description: 'Platform the test ran on (optional context)',
                    default: 'linux',
                  },
                },
                required: ['log'],
              },
              async ({ log }) => {
                const { failures, errorMessages, rerunCommands } = parseTestLog(log);

                return {
                  content: [{
                    type: 'text',
                    text: failures.length === 0 ?
                      'No test failures detected in the provided log.' :
                      JSON.stringify({
                        failureCount: failures.length,
                        failures: failures.slice(0, 20),
                        errorMessages,
                        rerunCommands,
                      }, null, 2),
                  }],
                };
              },
  );

  server.tool('search_docs',
              'Search Node.js documentation (doc/api, doc/contributing, test/README.md) for a query.',
              {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Search pattern (extended regex)',
                  },
                  section: {
                    type: 'string',
                    enum: ['api', 'contributing', 'all'],
                    description: 'Which docs to search. Default: "all"',
                    default: 'all',
                  },
                },
                required: ['query'],
              },
              async ({ query, section = 'all' }) => {
                const targets = [];
                if (section !== 'contributing') targets.push(join(root, 'doc/api'));
                if (section !== 'api') targets.push(join(root, 'doc/contributing'));
                if (section === 'all') targets.push(join(root, 'test/README.md'));

                const args = ['-rn', '-i', '--include=*.md', '--', query, ...targets];
                const { ok, output } = await exec('grep', args, { timeout: 10_000 });
                if (!ok && !output) return { content: [{ type: 'text', text: 'No documentation matches found.' }] };
                return { content: [{ type: 'text', text: truncate(output, 8_000) }] };
              },
  );

  // ── Jenkins CI (via ncu-ci from node-core-utils) ────────────────────────

  server.tool('start_ci',
              'Start a Jenkins CI run (node-test-pull-request) for a nodejs/node PR via ncu-ci. ' +
              'Requires node-core-utils configured with a Jenkins API token (~/.ncurc).',
              {
                type: 'object',
                properties: {
                  pr: {
                    type: 'string',
                    description: 'PR number or full GitHub PR URL',
                  },
                },
                required: ['pr'],
              },
              async ({ pr }) => {
                const prNum = String(pr).match(/(\d+)\/?$/)?.[1] ?? String(pr);
                const { ok, output } = await exec('ncu-ci', ['run', prNum], { timeout: 120_000 });
                return {
                  content: [{
                    type: 'text',
                    text: ok ?
                      `CI started for PR #${prNum}.\n\n${output}` :
                      `Failed to start CI for PR #${prNum}.\n\n${output}`,
                  }],
                  isError: !ok,
                };
              },
  );

  server.tool('get_ci_status',
              'Fetch parsed Jenkins CI results for a nodejs/node PR or a Jenkins job URL via ncu-ci. ' +
              'Returns structured failures when available. Feed failing test names to classify_failure ' +
              'to tell known flakes from real regressions.',
              {
                type: 'object',
                properties: {
                  pr: {
                    type: 'string',
                    description: 'PR number or full GitHub PR URL',
                  },
                  url: {
                    type: 'string',
                    description: 'Jenkins job URL (alternative to pr)',
                  },
                },
              },
              async ({ pr, url }) => {
                if (!pr && !url) {
                  return { content: [{ type: 'text', text: 'Provide either "pr" or "url".' }], isError: true };
                }
                let target = url;
                if (!target) {
                  const prNum = String(pr).match(/(\d+)\/?$/)?.[1] ?? String(pr);
                  target = `https://github.com/nodejs/node/pull/${prNum}`;
                }
                const jsonPath = join(tmpdir(), `ncu-ci-${process.pid}-${Date.now()}.json`);
                const { ok, output } = await exec('ncu-ci', ['url', target, '--json', jsonPath], { timeout: 180_000 });
                let parsed = null;
                try {
                  parsed = JSON.parse(await readFile(jsonPath, 'utf8'));
                  await unlink(jsonPath);
                } catch {
                  // ncu-ci did not produce JSON (e.g. no CI run found) — fall back to text output
                }
                const text = parsed ?
                  truncate(JSON.stringify(parsed, null, 2), 16_000) :
                  (output || 'ncu-ci produced no output.');
                return { content: [{ type: 'text', text }], isError: !ok && !parsed };
              },
  );

  server.tool('classify_failure',
              'Classify a failing CI test as a known flake or a likely real regression by cross-referencing ' +
              'open nodejs/node "flaky-test" issues and recent nodejs/reliability reports (via gh).',
              {
                type: 'object',
                properties: {
                  test: {
                    type: 'string',
                    description: 'Failing test, e.g. "test-fs-watch", "parallel/test-fs-watch.js", or a rerun command',
                  },
                },
                required: ['test'],
              },
              async ({ test }) => {
                const name = normalizeTestName(test);
                const evidence = [];
                const errors = [];

                const flaky = await exec('gh', [
                  'issue', 'list', '-R', 'nodejs/node', '-l', 'flaky-test', '-s', 'all',
                  '-S', name, '--json', 'number,title,url,state', '-L', '10',
                ], { timeout: 30_000 });
                if (flaky.ok) {
                  try {
                    // gh -S matches loosely (body text included); only issues
                    // naming the test in the title count as flake evidence.
                    const matching = JSON.parse(flaky.output)
                      .filter((issue) => issue.title.includes(name))
                      .slice(0, 5);
                    for (const issue of matching) {
                      evidence.push({ source: 'nodejs/node flaky-test issue', title: issue.title, url: issue.url, state: issue.state });
                    }
                  } catch (e) {
                    errors.push(`flaky-test issue parse: ${e.message}`);
                  }
                } else {
                  errors.push(`gh issue list failed: ${truncate(flaky.output, 200)}`);
                }

                const reliability = await exec('gh', [
                  'search', 'issues', name, '--repo', 'nodejs/reliability',
                  '--json', 'title,url,createdAt,state', '-L', '10',
                ], { timeout: 30_000 });
                if (reliability.ok) {
                  try {
                    const reports = JSON.parse(reliability.output)
                      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
                      .slice(0, 5);
                    for (const issue of reports) {
                      evidence.push({ source: 'nodejs/reliability report', title: issue.title, url: issue.url, date: issue.createdAt?.slice(0, 10) });
                    }
                  } catch (e) {
                    errors.push(`reliability search parse: ${e.message}`);
                  }
                } else {
                  errors.push(`gh search failed: ${truncate(reliability.output, 200)}`);
                }

                const recentCutoff = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString().slice(0, 10);
                const openFlakeIssue = evidence.some((e) => e.state === 'OPEN');
                const recentReport = evidence.some((e) => e.date && e.date >= recentCutoff);
                const knownFlake = openFlakeIssue || recentReport;

                const result = {
                  test: name,
                  knownFlake,
                  confidence: openFlakeIssue && recentReport ? 'high' : (knownFlake ? 'medium' : 'low'),
                  evidence,
                  recommendation: knownFlake ?
                    'Likely a known flake — resume the CI run rather than debugging your change.' :
                    'No known flake found — treat this as a real failure and investigate your change first.',
                };
                if (errors.length > 0) result.errors = errors;

                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
              },
  );

  // ── PR Metadata ─────────────────────────────────────────────────────────

  server.tool('get_pr_metadata',
              'Fetch PR metadata: labels, CI status, reviews, and commits for a nodejs/node PR.',
              {
                type: 'object',
                properties: {
                  pr: {
                    type: 'string',
                    description: 'PR number or full GitHub PR URL',
                  },
                  repo: {
                    type: 'string',
                    description: 'GitHub repo in owner/repo format. Default: "nodejs/node"',
                    default: 'nodejs/node',
                  },
                  include_landing_metadata: {
                    type: 'boolean',
                    description: 'Also run `git node metadata` to get the Reviewed-By / PR-URL block',
                    default: false,
                  },
                },
                required: ['pr'],
              },
              async ({ pr, repo = 'nodejs/node', include_landing_metadata: includeLandingMetadata = false }) => {
                const prNum = String(pr).match(/(\d+)\/?$/)?.[1] ?? String(pr);
                const result = { pr: prNum, repo };

                const { ok, output } = await exec('gh', [
                  'pr', 'view', prNum, '--repo', repo,
                  '--json', 'number,title,state,labels,reviews,statusCheckRollup,commits,author,url',
                ], { timeout: 30_000 });

                if (ok) {
                  try {
                    const d = JSON.parse(output);
                    result.title = d.title;
                    result.state = d.state;
                    result.url = d.url;
                    result.author = d.author?.login;
                    result.labels = (d.labels ?? []).map((l) => l.name);

                    const approved = (d.reviews ?? [])
                      .filter((r) => r.state === 'APPROVED')
                      .map((r) => r.author?.login);
                    const changes = (d.reviews ?? [])
                      .filter((r) => r.state === 'CHANGES_REQUESTED')
                      .map((r) => r.author?.login);
                    result.reviews = { approved, changesRequested: changes };

                    const checks = d.statusCheckRollup ?? [];
                    result.ci = {
                      total: checks.length,
                      passed: checks.filter((c) => c.conclusion === 'SUCCESS').length,
                      failed: checks.filter((c) => c.conclusion === 'FAILURE').length,
                      pending: checks.filter((c) => !c.conclusion || c.conclusion === 'PENDING').length,
                    };

                    const commits = d.commits ?? [];
                    result.commitCount = commits.length;
                    if (commits.length > 0) {
                      const last = commits[commits.length - 1];
                      result.latestCommit = { sha: last.oid?.slice(0, 10), message: last.messageHeadline };
                    }
                  } catch (e) {
                    result.error = `gh parse error: ${e.message}`;
                  }
                } else {
                  result.error = truncate(output, 300);
                }

                if (includeLandingMetadata) {
                  const { ok: mOk, output: mOut } = await exec('git', ['node', 'metadata', prNum], { timeout: 20_000 });
                  result.landingMetadata = mOk ? mOut : `git node metadata failed: ${truncate(mOut, 200)}`;
                }

                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
              },
  );
}
