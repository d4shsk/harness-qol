import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { smartParseInput, splitCommandArgs, formatMcpArgs, validateMcpServerInput } from './mcp-input.js';
import { createMcpManager, registerMcpConnection, registerMcpHttp, registerMcp, MCP_PRESETS } from './mcp.js';
import { Readable } from 'node:stream';

const repo = 'https://github.com/vercel-labs/agent-browser';
const expectedArgs = ['-y', 'agent-browser@0.40.0', 'mcp'];
const unsupported = [
  'https://github.com/vercel/next.js',
  'https://github.com/not-real/mcp-server-made-up',
  'https://github.com/other/servers/tree/main/src/filesystem',
  'https://github.com/modelcontextprotocol/servers/tree/main/src/not-real',
  'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem/extra',
  'https://github.com/vercel-labs/agent-browser/issues',
  'https://github.com.evil.test/vercel-labs/agent-browser',
  'https://notgithub.com/vercel-labs/agent-browser',
  'https://github.com./vercel-labs/agent-browser',
  'https://www.github.com/vercel-labs/agent-browser',
  'https://github.com:1234/vercel-labs/agent-browser',
  'http://github.com/vercel-labs/agent-browser',
  'https://gitlab.com/group/repo',
  'https://bitbucket.org/group/repo',
  'https://codeberg.org/group/repo',
  'https://example.com/project.git',
];

test('agent-browser URLs and bare launchers use the documented, versioned MCP subcommand', () => {
  for (const input of [repo, repo + '/', repo + '.git', repo + '?tab=readme-ov-file#readme', 'agent-browser', 'npx agent-browser', 'npx -y agent-browser', 'npx --yes agent-browser']) {
    const parsed = smartParseInput(input);
    assert.equal(parsed.id, 'agent-browser', input);
    assert.equal(parsed.command, 'npx');
    assert.deepEqual(parsed.args, expectedArgs, input);
    assert.equal(parsed.transport, 'stdio');
    assert.match(parsed.tip, /Node.js 24/);
  }
  assert.deepEqual(MCP_PRESETS.find(p => p.id === 'agent-browser').args, expectedArgs);
});

test('unknown Git repositories, spoofed hosts and unknown subtrees cannot become guessed packages', () => {
  for (const input of unsupported) assert.throws(() => smartParseInput(input), { code: 'unsupportedRepository' }, input);
  for (const input of ['file:///tmp/server', 'ftp://github.com/vercel-labs/agent-browser', 'git+https://github.com/vercel-labs/agent-browser', 'https://github.com@evil.test/vercel-labs/agent-browser', 'https://user:pass@example.com/mcp', 'https://', 'github.com/vercel-labs/agent-browser']) {
    assert.throws(() => smartParseInput(input), { code: 'invalidUrl' }, input);
  }
});

test('URLs containing GitHub in query parameters are not matched as GitHub repositories', () => {
  const parsed = smartParseInput('https://example.com/mcp?repo=' + repo);
  assert.equal(parsed.command, undefined);
  assert.equal(parsed.transport, 'streamable-http');
  assert.match(parsed.type, /unverified/);
});

test('known Python subtrees use uvx instead of invented npm names', () => {
  for (const name of ['fetch', 'sqlite']) {
    const parsed = smartParseInput(`https://github.com/modelcontextprotocol/servers/tree/main/src/${name}`);
    assert.equal(parsed.command, 'uvx');
    assert.deepEqual(parsed.args, [`mcp-server-${name}`]);
  }
});

test('manual HTTP config and JSON cannot disguise a repository page as an MCP endpoint', () => {
  for (const input of unsupported.concat(repo)) {
    const config = { id: 'bad', url: input, transport: 'streamable-http' };
    assert.throws(() => validateMcpServerInput(config), { code: 'repositoryEndpoint' });
    for (const json of [config, { mcpServers: { bad: config } }, { bad: config }]) {
      assert.throws(() => smartParseInput(JSON.stringify(json)), { code: 'repositoryEndpoint' });
    }
  }
  assert.throws(() => smartParseInput('{"mcpServers":{"bad":{}}}'), { code: 'invalidConfig' });
});

test('argv form round-trip preserves spaces, quotes, empty args and Windows paths', () => {
  const args = ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me\\My Documents\\', '', 'a"b', "it's here", 'line\nbreak', 'tab\there'];
  assert.deepEqual(splitCommandArgs(formatMcpArgs(args)), args);
  assert.throws(() => splitCommandArgs('npx "unterminated'), { code: 'invalidCommand' });
});

async function tempManager(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hq-mcp-validation-'));
  const path = join(dir, 'servers.json');
  const manager = createMcpManager({ get() {} }, { isModuleEnabled: () => true }, path);
  t.after(async () => {
    manager.stopAll();
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('hq-mcp-validation-'));
    await rm(dir, { recursive: true, force: true });
  });
  return { manager, path };
}

test('host rejects repository endpoints before saving, importing or opening any connection', async t => {
  const { manager, path } = await tempManager(t);
  const bad = { id: 'bad', url: repo, enabled: false };
  await assert.rejects(manager.saveServer(bad), { code: 'repositoryEndpoint' });
  await assert.rejects(manager.testServer(bad), { code: 'repositoryEndpoint' });
  await assert.rejects(manager.importConfig({ mcpServers: {
    good: { command: 'node', enabled: false }, bad,
  } }), { code: 'repositoryEndpoint' });
  assert.equal(manager.getServers().servers.length, 0, 'no partial import');
  await assert.rejects(readFile(path), { code: 'ENOENT' }, 'invalid input did not write config');
});

test('save reports a failed MCP startup and retains the error status', async t => {
  const { manager } = await tempManager(t);
  const result = await manager.saveServer({ id: 'not-mcp', command: process.execPath, args: ['-e', 'process.stderr.write("Not an MCP server"); process.exit(2)'] });
  assert.equal(result.ok, false);
  assert.equal(result.saved, true);
  assert.equal(result.status, 'error');
  assert.match(result.error, /Not an MCP server/);
  assert.equal(manager.getServers().servers[0].status, 'error');
});

test('stdio handshake still works without downloading external packages', async t => {
  const { manager } = await tempManager(t);
  const source = `require('node:readline').createInterface({input: process.stdin}).on('line', line => {
    const m = JSON.parse(line);
    if (m.id === undefined) return;
    const result = m.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}} : {tools:[{name:'fixture_tool', inputSchema:{type:'object'}}]};
    console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
  });`;
  const result = await manager.testServer({ id: 'fixture', command: process.execPath, args: ['-e', source] });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.tools[0].name, 'fixture_tool');
  assert.equal(manager.getServers().servers.length, 0, 'test does not save configuration');
});

test('Desktop exact routes and legacy Web routes use the same validated parser', async () => {
  const routes = [];
  const ctx = { get: name => name === 'connection' ? { fetch: { register(route) { routes.push(route); return () => {}; } } } : null, effect: f => f() };
  registerMcpConnection(ctx, {});
  const parse = routes.find(r => r.path === '/api/harness-qol/mcp/smart-parse');
  assert.ok(parse);
  for (const [input, status, code] of [[repo, 200, undefined], [unsupported[0], 400, 'unsupportedRepository']]) {
    const res = await parse.fetch(new Request('http://localhost' + parse.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }) }));
    const data = await res.json();
    assert.equal(res.status, status);
    assert.equal(data.code, code);
    if (status === 200) assert.deepEqual(data.parsed.args, expectedArgs);
  }
  assert.equal((await parse.fetch(new Request('http://localhost' + parse.path, { method: 'POST', body: '{}' }))).status, 415);
  let legacy;
  registerMcpHttp({ get: name => name === 'webServer' ? { register: r => { legacy = r; } } : null, effect: f => f() }, {}, {});
  const req = Readable.from([JSON.stringify({ input: unsupported[0] })]);
  Object.assign(req, { method: 'POST', url: '/harness-qol/mcp/smart-parse', headers: { 'content-type': 'application/json' } });
  let status, body;
  await legacy.handler(req, { writeHead: code => { status = code; }, end: text => { body = JSON.parse(text); } });
  assert.equal(status, 400);
  assert.equal(body.code, 'unsupportedRepository');
});

test('agent tool save/test use the same host validation', async t => {
  const { path } = await tempManager(t);
  let tool;
  const manager = registerMcp({
    inject() {}, effect: f => f(),
    get: name => name === 'tools' ? { register: definition => { tool = definition; return () => {}; } } : null,
  }, { isModuleEnabled: () => true }, path);
  t.after(() => manager.stopAll());
  for (const action of ['save', 'test']) {
    await assert.rejects(tool.execute({ action, server: { id: 'bad', url: repo } }), { code: 'repositoryEndpoint' });
  }
});

test('built Client contains exactly the shared parser and blocks stale forms on invalid links', async () => {
  const shared = (await readFile(new URL('./mcp-input.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
  const client = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  const source = await readFile(new URL('./mcp-client.js', import.meta.url), 'utf8');
  assert.ok(client.includes(shared));
  assert.doesNotMatch(source, /ghMatch|ghSubMatch|smartParseClient|onPaste:/);
  assert.equal((source.match(/if \(quickError \|\| testing\) return;/g) || []).length, 2);
  assert.match(source, /disabled: testing \|\| !!quickError/);
  assert.match(source, /'aria-invalid': !!quickError/);
  assert.match(source, /role: 'alert'/);
  assert.match(source, /transport\.fetch\(target, options\)/);
  const scope = new Function(`${source}; return requestMcp;`)();
  const old = globalThis.__DSH_TRANSPORT__;
  const calls = [];
  try {
    globalThis.__DSH_TRANSPORT__ = { fetch(path, options) { calls.push({ path, options }); return 'response'; } };
    assert.equal(scope('/harness-qol/mcp/test', { method: 'POST' }), 'response');
    assert.equal(calls[0].path, 'api/harness-qol/mcp/test');
  } finally { if (old === undefined) delete globalThis.__DSH_TRANSPORT__; else globalThis.__DSH_TRANSPORT__ = old; }
  for (const key of ['quickPlaceholder', 'quickHint', 'quickError.unsupportedRepository']) {
    assert.equal((client.match(new RegExp('"mcp\\.' + key.replaceAll('.', '\\.') + '":', 'g')) || []).length, 2, `${key} present in English and Russian`);
  }
});
