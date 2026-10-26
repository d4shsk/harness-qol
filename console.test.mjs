import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsoleOperations, registerConsole, CONSOLE_KIND, consoleParameters } from './console.js';

function fixture(options = {}) {
  const rows = new Map(), handles = [], specs = [], writes = [], disposers = [], commands = [], tools = [];
  let counter = 0, enabled = true, mode = 'danger-full-access', root = '/work';
  const owner = { id: 'owner', session: { id: 'owner' } };
  const check = (id, caller) => {
    const row = rows.get(id);
    if (!row || (row.owner && row.owner !== caller)) throw new Error('Unknown or foreign job');
    return row;
  };
  const jobs = {
    attachController: () => () => {},
    start(spec) {
      const id = `job-${++counter}`;
      const hooks = spec.run({ id });
      rows.set(id, { id, owner: spec.owner, kind: spec.kind, label: spec.label, status: 'running', output: { total: 0, earliest: 0 }, spec, hooks });
      hooks.done.then(outcome => { Object.assign(rows.get(id), outcome); });
      return id;
    },
    get(id, caller) { const { spec, hooks, ...row } = check(id, caller); return row; },
    list(caller) { return [...rows.values()].filter(row => !row.owner || row.owner === caller).map(row => jobs.get(row.id, caller)); },
    kill(id, caller) { const row = check(id, caller); if (row.status !== 'running') return 'already-finished'; row.hooks.cancel(); row.status = 'stopping'; return 'requested'; },
    readAt(id, from, caller) {
      const row = check(id, caller);
      if (options.output) return options.output(from);
      let at = 0; const chunks = [];
      for (const source of row.spec.output) {
        const read = source.read(0);
        const size = Buffer.byteLength(read.text);
        if (at + size > from) chunks.push({ at, text: read.text, channel: source.channel });
        at += size;
      }
      return { chunks, next: at, lossy: false };
    },
  };
  const subprocess = {
    async resolveExecutable(value) { return value; },
    spawn(spec) {
      specs.push(spec);
      if (options.spawnError) throw new Error('Spawn rejected');
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const stdin = new Writable({ write(chunk, encoding, cb) { writes.push(chunk.toString()); cb(options.writeError ? new Error('EPIPE') : undefined); } });
      const child = { stdin, collected: { stdout: { readFrom: () => ({ text: 'output\n', nextOffset: 7, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        done, terminate() { child.killed = true; finish({ exitCode: null, signal: 'SIGTERM' }); }, finish };
      handles.push(child); return child;
    },
  };
  let confined = 0;
  const services = {
    jobs, subprocess: options.subprocess ?? subprocess,
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: root }) },
    sandbox: { async confine(argv, policy) { confined++; return { argv: ['confined', ...argv], enforcement: options.partial ? 'partial' : 'full' }; } },
    workingDirectory: { ensure: async () => '/work' },
    fs: { resolve: async path => ({ displayPath: path }), stat: async () => ({ type: options.missingCwd ? 'file' : 'directory' }), processPath: target => target.displayPath },
    commands: { register(def) { commands.push(def); return () => {}; } },
    tools: { register(def) { tools.push(def); return () => {}; } },
  };
  const ctx = { ...services, get: key => services[key], effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose); } };
  const settings = { isModuleEnabled: () => enabled };
  const operations = createConsoleOperations(ctx, settings);
  return { ctx, settings, operations, jobs, owner, rows, handles, specs, writes, disposers, commands, tools,
    mode(value) { mode = value; }, root(value) { root = value; }, enable(value) { enabled = value; },
    get confined() { return confined; },
    run: (request, agent = owner, signal) => operations.run(agent, request, signal),
  };
}
const start = f => f.run({ action: 'start', argv: ['java', '-jar', 'my server.jar', 'nogui'] });

test('console: launches exact argv without shell; sends Unicode and exactly one newline', async t => {
  const f = fixture(); t.after(() => f.operations.dispose());
  const result = await start(f); assert.equal(result.ok, true);
  const id = result.data.job.id;
  assert.equal(result.data.job.kind, CONSOLE_KIND);
  assert.equal(result.data.job.inputSupported, true);
  assert.equal(f.specs[0].stdio.stdin, 'pipe');
  assert.deepEqual(f.specs[0].argv, ['java', '-jar', 'my server.jar', 'nogui']);
  assert.equal((await f.run({ action: 'send', jobId: id, text: 'say Привет; $not-a-shell' })).ok, true);
  assert.deepEqual(f.writes, ['say Привет; $not-a-shell\n']);
  assert.equal((await f.run({ action: 'send', jobId: id, text: '' })).ok, true);
  assert.equal(f.writes[1], '\n');
});

test('console: fences foreign ids and never exposes ordinary jobs as writable', async t => {
  const f = fixture(); t.after(() => f.operations.dispose());
  const id = (await start(f)).data.job.id;
  const foreign = { id: 'other', session: { id: 'other' } };
  for (const action of ['send', 'read', 'stop', 'eof']) assert.equal((await f.run({ action, jobId: id, text: 'stop' }, foreign)).ok, false);
  assert.deepEqual((await f.run({}, foreign)).data.jobs, []);
  f.rows.set('ordinary', { id: 'ordinary', kind: 'bash', owner: f.owner.id, status: 'running', hooks: { cancel() {} } });
  assert.equal((await f.run({})).data.jobs.find(row => row.id === 'ordinary').inputSupported, false);
  assert.match((await f.run({ action: 'send', jobId: 'ordinary', text: 'test' })).error, /No stdin/);
  assert.deepEqual(f.writes, []);
});

test('console: validates argv, cwd, text and offsets before side effects', async t => {
  const f = fixture(); t.after(() => f.operations.dispose());
  for (const argv of [[], [''], [42], ['java', '\0'], ['java', 'a'.repeat(65536)]]) assert.equal((await f.run({ action: 'start', argv })).ok, false);
  assert.equal(f.specs.length, 0);
  const id = (await start(f)).data.job.id;
  for (const text of ['one\ntwo', 'one\rtwo', '\x03', '\x1b', '\0', 'я'.repeat(8193), 3]) assert.equal((await f.run({ action: 'send', jobId: id, text })).ok, false);
  assert.equal((await f.run({ action: 'read', jobId: id, from: -1 })).ok, false);
  assert.equal((await f.run({ action: 'read', jobId: id, from: 0.5 })).ok, false);
  assert.deepEqual(f.writes, []);
  const badCwd = fixture({ missingCwd: true });
  assert.equal((await start(badCwd)).ok, false); assert.equal(badCwd.specs.length, 0);
});

test('console: sandbox cannot silently degrade; policy changes block further input', async t => {
  const f = fixture(); t.after(() => f.operations.dispose());
  f.mode('workspace-write');
  const id = (await start(f)).data.job.id;
  assert.equal(f.confined, 1); assert.equal(f.specs[0].argv[0], 'confined');
  f.mode('read-only');
  assert.match((await f.run({ action: 'send', jobId: id, text: 'test' })).error, /policy changed/);
  assert.equal((await f.run({ action: 'eof', jobId: id })).ok, false);
  f.mode('workspace-write'); f.root('/different');
  assert.equal((await f.run({ action: 'send', jobId: id, text: 'test' })).ok, false);
  assert.deepEqual(f.writes, []);
  const partial = fixture({ partial: true }); partial.mode('read-only');
  assert.equal((await start(partial)).ok, false); assert.equal(partial.specs.length, 0);
});

test('console: disabling blocks start/input but preserves list/read/emergency stop', async t => {
  const f = fixture(); t.after(() => f.operations.dispose());
  const id = (await start(f)).data.job.id;
  f.enable(false);
  assert.equal((await start(f)).ok, false);
  assert.equal((await f.run({ action: 'send', jobId: id, text: 'test' })).ok, false);
  assert.equal((await f.run({})).ok, true);
  assert.equal((await f.run({ action: 'read', jobId: id })).ok, true);
  assert.equal((await f.run({ action: 'stop', jobId: id })).ok, true);
  assert.equal(f.handles[0].killed, true);
});

test('console: EOF, EPIPE and settled processes reject further input safely', async t => {
  const f = fixture(); t.after(() => f.operations.dispose());
  const id = (await start(f)).data.job.id;
  assert.equal((await f.run({ action: 'eof', jobId: id })).ok, true);
  assert.equal((await f.run({ action: 'send', jobId: id, text: 'test' })).ok, false);
  f.handles[0].finish({ exitCode: 0, signal: null }); await f.handles[0].done; await Promise.resolve(); await Promise.resolve();
  assert.equal((await f.run({ action: 'send', jobId: id, text: 'test' })).ok, false);
  const broken = fixture({ writeError: true }); t.after(() => broken.operations.dispose());
  const brokenId = (await start(broken)).data.job.id;
  assert.match((await broken.run({ action: 'send', jobId: brokenId, text: 'test' })).error, /EPIPE/);
});

test('console: concurrent admission is bounded; unload awaits process completion', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => start(f)));
  assert.equal(results.filter(result => result.ok).length, 8);
  await f.operations.dispose();
  assert.ok(f.handles.every(handle => handle.killed));
  assert.equal((await start(f)).ok, false);
});

test('console: synchronous spawn failure leaves no job; pre-abort starts no process', async () => {
  const f = fixture({ spawnError: true });
  assert.match((await start(f)).error, /Spawn rejected/);
  assert.equal(f.rows.size, 0);
  const abort = new AbortController(); abort.abort();
  assert.equal((await f.run({ action: 'start', argv: ['java'] }, f.owner, abort.signal)).ok, false);
  assert.equal(f.specs.length, 1);
});

test('console: oversized output chunks are paged on UTF-8 boundaries without replay', async () => {
  const text = '🙂Привет\n'.repeat(20000);
  const total = Buffer.byteLength(text);
  const f = fixture({ output: () => ({ chunks: [{ at: 0, text }], next: total, lossy: false }) });
  f.rows.set('large', { id: 'large', owner: f.owner.id, kind: 'bash', status: 'completed' });
  let from = 0; let reconstructed = '';
  do {
    const { ok, data } = await f.run({ action: 'read', jobId: 'large', from });
    assert.equal(ok, true);
    const page = data.chunks.map(chunk => chunk.text).join('');
    assert.ok(Buffer.byteLength(page) <= 65536);
    assert.ok(data.next > from);
    reconstructed += page; from = data.next;
  } while (from < total);
  assert.equal(reconstructed, text);
});

test('console: UI command and model tool share operations and ownership', async () => {
  const f = fixture(); registerConsole(f.ctx, f.settings);
  const command = f.commands[0], tool = f.tools[0];
  assert.equal(tool.name, 'harness_qol_console');
  assert.equal(command.recordInput, true);
  const result = await tool.execute({ action: 'start', argv: ['java'] }, { agent: f.owner });
  const id = result.data.job.id;
  const response = await command.handler({ agent: f.owner, rawInput: JSON.stringify({ action: 'send', jobId: id, text: 'list' }) });
  assert.equal(response.kind, 'success'); assert.equal(JSON.parse(response.text).data.written, true);
  assert.deepEqual(f.writes, ['list\n']);
  assert.equal((await command.handler({ agent: f.owner, rawInput: '{' })).kind, 'error');
  for (const dispose of [...f.disposers].reverse()) await dispose();
  // New tool schema is one bounded descriptor, no new prompt section.
  assert.ok(JSON.stringify(consoleParameters).length < 2500);
});

test('console: real child accepts input, reports Unicode and exits on EOF', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hq-console-test-'));
  let child;
  t.after(async () => { if (child?.exitCode === null) child.kill(); if (child) await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('close', resolve)); await rm(directory, { recursive: true, force: true }); });
  const adapter = {
    resolveExecutable: async executable => executable,
    spawn(spec) {
      child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
      return { stdin: child.stdin, done, terminate: () => child.kill(), collected: {
        stdout: { readFrom: () => ({ text: stdout, nextOffset: Buffer.byteLength(stdout), lossy: false }) },
        stderr: { readFrom: () => ({ text: stderr, nextOffset: Buffer.byteLength(stderr), lossy: false }) },
      } };
    },
  };
  const f = fixture({ subprocess: adapter }); t.after(() => f.operations.dispose());
  const result = await f.run({ action: 'start', argv: [process.execPath, '-e', 'process.stdin.setEncoding("utf8"); process.stdin.on("data", data => process.stdout.write("received:" + data));'] });
  assert.equal(result.ok, true, result.error);
  const id = result.data.job.id;
  assert.equal((await f.run({ action: 'send', jobId: id, text: 'say Привет' })).ok, true);
  assert.equal((await f.run({ action: 'eof', jobId: id })).ok, true);
  await f.rows.get(id).hooks.done;
  const output = await f.run({ action: 'read', jobId: id });
  assert.equal(output.data.chunks.map(chunk => chunk.text).join(''), 'received:say Привет\n');
});
