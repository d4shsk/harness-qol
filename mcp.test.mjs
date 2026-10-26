import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  smartParseInput,
  splitCommandArgs,
  MCP_PRESETS,
  createMcpManager,
  registerMcpHttp,
  registerMcp,
} from './mcp.js';
import { createSettingsState } from './settings-state.js';

test('splitCommandArgs: splits arguments while preserving quotes and spaces', () => {
  assert.deepEqual(splitCommandArgs('npx -y mcp-searxng'), ['npx', '-y', 'mcp-searxng']);
  assert.deepEqual(splitCommandArgs('npx -y "@modelcontextprotocol/server-filesystem" "C:\\Users\\d4sh\\My Documents"'), [
    'npx',
    '-y',
    '@modelcontextprotocol/server-filesystem',
    'C:\\Users\\d4sh\\My Documents'
  ]);
  assert.deepEqual(splitCommandArgs("uvx 'mcp-server-sqlite' '--db-path' 'data base.db'"), [
    'uvx',
    'mcp-server-sqlite',
    '--db-path',
    'data base.db'
  ]);
  assert.deepEqual(splitCommandArgs(''), []);
  assert.deepEqual(splitCommandArgs(null), []);
});

test('smartParseInput: detects and parses GitHub repository', () => {
  const result = smartParseInput('https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem');
  assert.ok(result);
  assert.equal(result.id, 'filesystem');
  assert.equal(result.command, 'npx');
  assert.deepEqual(result.args, ['-y', '@modelcontextprotocol/server-filesystem']);
  assert.equal(result.transport, 'stdio');
});

test('smartParseInput: detects bare package names', () => {
  const result = smartParseInput('@modelcontextprotocol/server-filesystem');
  assert.ok(result);
  assert.equal(result.id, 'filesystem');
  assert.equal(result.command, 'npx');
  assert.deepEqual(result.args, ['-y', '@modelcontextprotocol/server-filesystem']);

  const pyResult = smartParseInput('mcp-server-sqlite');
  assert.ok(pyResult);
  assert.equal(pyResult.command, 'uvx');
});

test('smartParseInput: detects generic GitHub repository', () => {
  const result = smartParseInput('https://github.com/modelcontextprotocol/servers');
  assert.ok(result);
  assert.equal(result.id, 'servers');
  assert.equal(result.command, 'npx');
  assert.deepEqual(result.args, ['-y', 'servers']);
});

test('smartParseInput: detects HTTP and SSE endpoints', () => {
  const result = smartParseInput('http://127.0.0.1:8000/mcp');
  assert.ok(result);
  assert.equal(result.transport, 'streamable-http');
  assert.equal(result.url, 'http://127.0.0.1:8000/mcp');
  assert.equal(result.id, 'mcp');
});

test('smartParseInput: parses CLI command string', () => {
  const result = smartParseInput('npx -y @modelcontextprotocol/server-filesystem C:\\Users\\d4sh');
  assert.ok(result);
  assert.equal(result.command, 'npx');
  assert.deepEqual(result.args, ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\d4sh']);
  assert.equal(result.id, 'filesystem');
});

test('smartParseInput: parses Claude Desktop and Cursor mcpServers JSON', () => {
  const json = JSON.stringify({
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\d4sh'],
        env: { SOME_VAR: '1' }
      }
    }
  });
  const result = smartParseInput(json);
  assert.ok(result);
  assert.equal(result.id, 'filesystem');
  assert.equal(result.command, 'npx');
  assert.deepEqual(result.args, ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\d4sh']);
  assert.equal(result.env.SOME_VAR, '1');
});

test('MCP_PRESETS: provides verified presets including Filesystem, GitHub, SQLite, Memory', () => {
  assert.ok(Array.isArray(MCP_PRESETS));
  const fs = MCP_PRESETS.find(p => p.id === 'filesystem');
  assert.ok(fs);
  assert.equal(fs.command, 'npx');
  assert.deepEqual(fs.args[0], '-y');

  const gh = MCP_PRESETS.find(p => p.id === 'github');
  assert.ok(gh);
  assert.ok('GITHUB_PERSONAL_ACCESS_TOKEN' in gh.env);

  const sqlite = MCP_PRESETS.find(p => p.id === 'sqlite');
  assert.ok(sqlite);
  assert.equal(sqlite.command, 'uvx');
});

test('createMcpManager: save, toggle, delete, and import servers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-qol-mcp-test-'));
  const configPath = join(dir, 'mcp-servers.json');

  const mockCtx = {
    get(name) {
      if (name === 'tools') {
        return {
          register() {
            return () => {};
          }
        };
      }
      return null;
    }
  };

  const settings = createSettingsState(join(dir, 'settings.json'));
  const manager = createMcpManager(mockCtx, settings, configPath);

  // Override config file path for testing
  manager.getMcpConfigPath = () => configPath;

  try {
    // 1. Initially empty
    await manager.loadConfig();
    let res = manager.getServers();
    assert.equal(res.servers.length, 0);

    // 2. Save new server
    await manager.saveServer({
      id: 'test-server',
      name: 'Test Server',
      command: 'npx',
      args: ['-y', 'my-mcp-server'],
      env: { TEST_VAR: '1' },
      enabled: false, // keep disabled in unit test to avoid spawning npx
    });

    res = manager.getServers();
    assert.equal(res.servers.length, 1);
    assert.equal(res.servers[0].id, 'test-server');
    assert.equal(res.servers[0].enabled, false);
    assert.equal(res.servers[0].status, 'disabled');

    // 3. Toggle server
    await manager.toggleServer('test-server', false);
    res = manager.getServers();
    assert.equal(res.servers[0].enabled, false);

    // 4. Import servers from JSON
    const importPayload = {
      mcpServers: {
        sqlite: {
          command: 'uvx',
          args: ['mcp-server-sqlite', '--db-path', './test.db'],
          enabled: false,
        }
      }
    };
    const importRes = await manager.importConfig(JSON.stringify(importPayload));
    assert.equal(importRes.ok, true);

    res = manager.getServers();
    assert.equal(res.servers.length, 2);
    assert.ok(res.servers.some(s => s.id === 'sqlite'));

    // 5. Delete server
    await manager.deleteServer('sqlite');
    res = manager.getServers();
    assert.equal(res.servers.length, 1);
    assert.equal(res.servers[0].id, 'test-server');

    manager.stopAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('registerMcpHttp: handles GET, POST endpoints and smart parsing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-qol-mcp-http-test-'));
  const settings = createSettingsState(join(dir, 'settings.json'));

  let registeredRoute = null;
  const mockWebServer = {
    register(route) {
      registeredRoute = route;
    }
  };

  const mockCtx = {
    inject(deps, fn) {
      if (deps.includes('webServer')) {
        fn({
          get(name) {
            if (name === 'webServer') return mockWebServer;
            return null;
          },
          effect(cb) { cb(); }
        });
      }
    },
    get(name) {
      if (name === 'webServer') return mockWebServer;
      return null;
    },
    effect(cb) { cb(); }
  };

  const manager = createMcpManager(mockCtx, settings);
  manager.getMcpConfigPath = () => join(dir, 'mcp-servers.json');

  registerMcpHttp(mockCtx, settings, manager);
  assert.ok(registeredRoute);
  assert.equal(registeredRoute.path, '/harness-qol/mcp');

  function fakeReq(method, path, body = null) {
    const stream = new Readable({
      read() {
        if (body) {
          this.push(typeof body === 'string' ? body : JSON.stringify(body));
        }
        this.push(null);
      }
    });
    stream.method = method;
    stream.url = path;
    stream.headers = { 'content-type': 'application/json' };
    return stream;
  }

  function fakeRes() {
    let statusCode = 200;
    let headers = {};
    let body = '';
    return {
      writeHead(code, h) {
        statusCode = code;
        headers = h;
      },
      end(data) {
        if (data) body += data;
      },
      getStatusCode: () => statusCode,
      getBody: () => (body ? JSON.parse(body) : null),
    };
  }

  // 1. GET /harness-qol/mcp/presets
  const reqPresets = fakeReq('GET', '/harness-qol/mcp/presets');
  const resPresets = fakeRes();
  await registeredRoute.handler(reqPresets, resPresets);
  assert.equal(resPresets.getStatusCode(), 200);
  assert.ok(resPresets.getBody().presets.length > 0);

  // 2. GET /harness-qol/mcp/list
  const reqList = fakeReq('GET', '/harness-qol/mcp/list');
  const resList = fakeRes();
  await registeredRoute.handler(reqList, resList);
  assert.equal(resList.getStatusCode(), 200);
  assert.ok(Array.isArray(resList.getBody().servers));

  // 3. POST /harness-qol/mcp/smart-parse
  const reqParse = fakeReq('POST', '/harness-qol/mcp/smart-parse', {
    input: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem'
  });
  const resParse = fakeRes();
  await registeredRoute.handler(reqParse, resParse);
  assert.equal(resParse.getStatusCode(), 200);
  assert.equal(resParse.getBody().parsed.id, 'filesystem');

  await rm(dir, { recursive: true, force: true });
});

test('registerMcp: registers tool and slash command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-qol-mcp-reg-test-'));
  const settings = createSettingsState(join(dir, 'settings.json'));

  const registeredTools = [];
  const registeredCommands = [];

  const mockCtx = {
    inject() {},
    get(name) {
      if (name === 'tools') {
        return {
          register(t) {
            registeredTools.push(t);
            return () => {};
          }
        };
      }
      if (name === 'commands') {
        return {
          register(c) {
            registeredCommands.push(c);
            return () => {};
          }
        };
      }
      return null;
    },
    effect(cb) { cb(); }
  };

  const manager = registerMcp(mockCtx, settings, join(dir, 'mcp-servers.json'));
  assert.ok(manager);

  const mcpTool = registeredTools.find(t => t.name === 'harness_qol_mcp');
  assert.ok(mcpTool);

  const mcpCmd = registeredCommands.find(c => c.name === 'mcp');
  assert.ok(mcpCmd);

  // Test tool list execution
  const listResult = await mcpTool.execute({ action: 'list' });
  assert.ok(listResult.ok);
  assert.ok(Array.isArray(listResult.servers));

  // Test command execution
  const cmdResult = await mcpCmd.handler({ rawInput: 'list' });
  assert.equal(cmdResult.kind, 'success');
  assert.match(cmdResult.text, /MCP Servers/);

  manager.stopAll();
  await rm(dir, { recursive: true, force: true });
});
