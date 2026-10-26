import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createSettingsState, registerSettingsHttp, DEFAULT_MODULES, MODULE_IDS } from './settings-state.js';
import { createWorkspaceOperations, folderRecordSchema } from './workspaces.js';
import { createModelDefaultsOperations, registerModelDefaults } from './model-defaults.js';
import { createBtwRuntime } from './btw.js';

async function tempFilePath(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hq-settings-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'settings.json');
}

test('settingsState: defaults all modules to true and returns copies', async t => {
  const file = await tempFilePath(t);
  const state = createSettingsState(file);
  const modules = state.getModules();
  assert.deepEqual(modules, DEFAULT_MODULES);
  for (const id of MODULE_IDS) {
    assert.equal(state.isModuleEnabled(id), true);
  }
  // Mutating returned object does not affect internal state
  modules.btw = false;
  assert.equal(state.isModuleEnabled('btw'), true);
});

test('settingsState: setModule persists to disk and notifies subscribers', async t => {
  const file = await tempFilePath(t);
  const state = createSettingsState(file);
  let notified = null;
  const unsub = state.subscribe(snapshot => { notified = snapshot; });

  await state.setModule('images', false);
  assert.equal(state.isModuleEnabled('images'), false);
  assert.equal(notified?.images, false);

  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.modules.images, false);
  assert.equal(parsed.modules.workspaces, true);
  assert.ok(parsed.updatedAt);

  unsub();
});

test('settingsState: setModules updates multiple modules at once', async t => {
  const file = await tempFilePath(t);
  const state = createSettingsState(file);

  await state.setModules({ quote: false, models: false, unknownModule: false });
  assert.equal(state.isModuleEnabled('quote'), false);
  assert.equal(state.isModuleEnabled('models'), false);
  assert.equal(state.isModuleEnabled('workspaces'), true);
  assert.equal(state.getModules().unknownModule, undefined);

  // Reloading from disk restores exact state
  const reloaded = createSettingsState(file);
  await reloaded.load();
  assert.equal(reloaded.isModuleEnabled('quote'), false);
  assert.equal(reloaded.isModuleEnabled('models'), false);
  assert.equal(reloaded.isModuleEnabled('workspaces'), true);
});

test('settingsState: rejects unknown module id', async t => {
  const file = await tempFilePath(t);
  const state = createSettingsState(file);
  await assert.rejects(
    () => state.setModule('non_existent', false),
    /Unknown module: non_existent/
  );
});

test('workspaces: perform and contextText respect workspaces enabled/disabled', async t => {
  const file = await tempFilePath(t);
  const state = createSettingsState(file);

  const entities = new Map();
  const records = new Map();
  const registry = {
    list: () => [...entities.values()],
    get: id => entities.get(id),
    async create(path, title) {
      const ws = { id: 'ws-1', path, title, updatedAt: 'time-1', sessionIds: [] };
      entities.set(ws.id, ws);
      return ws;
    },
  };
  const table = {
    get: id => records.get(id),
    async put(id, val) { records.set(id, folderRecordSchema.parse(val)); },
    async delete(id) { return records.delete(id); },
  };

  const ops = createWorkspaceOperations(registry, table, state);

  // Enabled: list succeeds
  const list1 = await ops.run({ action: 'list' });
  assert.equal(list1.ok, true);

  // Disable workspaces module
  await state.setModule('workspaces', false);

  // Disabled: perform fails with explicit error
  const list2 = await ops.run({ action: 'list' });
  assert.equal(list2.ok, false);
  assert.match(list2.error, /Workspaces module is disabled in Harness QOL settings/);

  // Disabled: contextText returns empty string
  const agent = { session: { header: { cwd: '/test' } } };
  assert.equal(ops.contextText(agent), '');
});

test('btw: ask respects btw enabled/disabled state', async t => {
  const file = await tempFilePath(t);
  const state = createSettingsState(file);

  const ctx = {
    sessions: new Map(),
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };

  const runtime = createBtwRuntime(ctx, state);

  await state.setModule('btw', false);
  const result = await runtime.ask({ agent: { id: 'a1' }, rawInput: 'test question', signal: new AbortController().signal });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Модуль \/btw отключён в настройках Harness QOL/);
});

test('model-defaults: save-main respects models enabled/disabled state', async t => {
  const file = await tempFilePath(t);
  const state = createSettingsState(file);

  let currentMain = { provider: 'old', model: 'old' };
  const ctx = {
    get: name => {
      if (name === 'agentDefaultModel') return {
        currentSelection: () => currentMain,
        saveSelection: async s => { currentMain = s; },
      };
      if (name === 'configEditor') return {};
      if (name === 'llm') return {
        resolveCallConfig: async s => s,
      };
      return null;
    },
  };

  const ops = createModelDefaultsOperations(ctx, state);

  // Read still works
  const read = await ops.run({ action: 'read' });
  assert.equal(read.ok, true);

  // Disable models module
  await state.setModule('models', false);

  const saveRes = await ops.run({ action: 'save-main', selection: { provider: 'new', model: 'new' } });
  assert.equal(saveRes.ok, false);
  assert.match(saveRes.error, /Module "models" is disabled in Harness QOL settings/);
});

test('registerSettingsHttp: handles GET, POST and OPTIONS requests', async t => {
  const file = await tempFilePath(t);
  const state = createSettingsState(file);

  let routeHandler;
  const ctx = {
    get: name => {
      if (name === 'webServer') {
        return {
          register: reg => {
            if (reg.path === '/harness-qol/settings') routeHandler = reg.handler;
          },
        };
      }
      return null;
    },
    effect: fn => fn(),
  };

  registerSettingsHttp(ctx, state);
  assert.ok(routeHandler, 'Route handler should be registered');

  function mockRequest(method, body = null, headers = {}) {
    const stream = new Readable({
      read() {
        if (body) this.push(typeof body === 'string' ? body : JSON.stringify(body));
        this.push(null);
      },
    });
    stream.method = method;
    stream.headers = { 'content-type': 'application/json', ...headers };
    return stream;
  }

  function mockResponse() {
    return {
      statusCode: 200,
      headers: {},
      body: '',
      writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h); },
      end(chunk) { if (chunk) this.body += chunk; },
    };
  }

  // 1. OPTIONS request
  const optReq = mockRequest('OPTIONS');
  const optRes = mockResponse();
  await routeHandler(optReq, optRes);
  assert.equal(optRes.statusCode, 204);

  // 2. GET request
  const getReq = mockRequest('GET');
  const getRes = mockResponse();
  await routeHandler(getReq, getRes);
  assert.equal(getRes.statusCode, 200);
  const getData = JSON.parse(getRes.body);
  assert.equal(getData.ok, true);
  assert.equal(getData.modules.btw, true);

  // 3. POST single toggle
  const postReq1 = mockRequest('POST', { id: 'btw', enabled: false });
  const postRes1 = mockResponse();
  await routeHandler(postReq1, postRes1);
  assert.equal(postRes1.statusCode, 200);
  const postData1 = JSON.parse(postRes1.body);
  assert.equal(postData1.ok, true);
  assert.equal(postData1.modules.btw, false);
  assert.equal(state.isModuleEnabled('btw'), false);

  // 4. POST multiple modules
  const postReq2 = mockRequest('POST', { modules: { btw: true, images: false } });
  const postRes2 = mockResponse();
  await routeHandler(postReq2, postRes2);
  assert.equal(postRes2.statusCode, 200);
  const postData2 = JSON.parse(postRes2.body);
  assert.equal(postData2.ok, true);
  assert.equal(postData2.modules.btw, true);
  assert.equal(postData2.modules.images, false);
});
