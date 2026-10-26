import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsState } from './settings-state.js';
import { registerWebSearch } from './web-search.js';

async function createTestState(t, initialModules = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hq-web-search-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'settings.json');
  const state = createSettingsState(file);
  if (Object.keys(initialModules).length > 0) {
    await state.setModules(initialModules);
  }
  return state;
}

function createMockCordis(toolsMap = new Map()) {
  const listeners = new Map();
  const injectedServices = new Map();
  const effects = [];

  const agents = new Map();
  const guards = [];

  const toolsService = {
    view(agent) {
      const allNames = new Set(toolsMap.keys());
      const denied = agent?._deniedTools || new Set();
      const visible = new Map();
      for (const [k, v] of toolsMap.entries()) {
        if (!denied.has(k)) visible.set(k, v);
      }
      return {
        visible,
        restrictableNames: allNames,
      };
    },
    get(name, agent) {
      return this.view(agent).visible.get(name);
    },
    restrict(filter) {
      const scope = this._currentScope;
      if (!scope) throw new Error('Scope required');
      scope._deniedTools = scope._deniedTools || new Set();
      for (const d of filter.deny || []) {
        scope._deniedTools.add(d);
      }
      return () => {
        for (const d of filter.deny || []) {
          scope._deniedTools.delete(d);
        }
      };
    },
    guard(fn) {
      guards.push(fn);
      return () => {
        const idx = guards.indexOf(fn);
        if (idx !== -1) guards.splice(idx, 1);
      };
    },
  };

  const agentsService = {
    list() {
      return [...agents.values()];
    },
    get(id) {
      return agents.get(id);
    },
  };

  injectedServices.set('tools', toolsService);
  injectedServices.set('agents', agentsService);

  const ctx = {
    get(name) {
      return injectedServices.get(name);
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    emit(event, payload) {
      for (const h of listeners.get(event) || []) {
        try { h(payload); } catch (e) { console.error(e); }
      }
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') effects.push(cleanup);
      return cleanup;
    },
    inject(deps, callback) {
      return callback(ctx);
    },
    dispose() {
      for (const e of effects.reverse()) {
        try { e(); } catch (_) {}
      }
    },
  };

  function createAgent(id) {
    const agent = {
      id,
      _deniedTools: new Set(),
      ctx: {
        get(name) {
          if (name === 'tools') {
            return {
              ...toolsService,
              _currentScope: agent,
              view: a => toolsService.view(a || agent),
              get: (n, a) => toolsService.get(n, a || agent),
            };
          }
          return ctx.get(name);
        },
      },
    };
    agents.set(id, agent);
    return agent;
  }

  function disposeAgent(id) {
    const agent = agents.get(id);
    if (agent) {
      agents.delete(id);
      ctx.emit('agent/disposed', { agent });
    }
  }

  return {
    ctx,
    toolsService,
    agentsService,
    guards,
    createAgent,
    disposeAgent,
    checkGuard(toolName) {
      for (const g of guards) {
        const reason = g({ name: toolName });
        if (reason) return reason;
      }
      return null;
    },
  };
}

test('web-search: enabled by default, does not restrict tools or block with guard', async t => {
  const state = await createTestState(t);
  const toolsMap = new Map([['web_search', { name: 'web_search' }], ['web_fetch', { name: 'web_fetch' }]]);
  const mock = createMockCordis(toolsMap);
  t.after(() => mock.ctx.dispose());

  const agent = mock.createAgent('session-1');
  const webSearch = registerWebSearch(mock.ctx, state);

  assert.equal(state.isModuleEnabled('webSearch'), true);
  assert.equal(webSearch.getActiveRestrictions().size, 0);
  assert.equal(agent.ctx.get('tools').get('web_search') !== undefined, true);
  assert.equal(mock.checkGuard('web_search'), null);
});

test('web-search: disabling module restricts web_search on active agents and installs guard', async t => {
  const state = await createTestState(t);
  const toolsMap = new Map([['web_search', { name: 'web_search' }], ['web_fetch', { name: 'web_fetch' }]]);
  const mock = createMockCordis(toolsMap);
  t.after(() => mock.ctx.dispose());

  const agent1 = mock.createAgent('session-1');
  const agent2 = mock.createAgent('session-2');
  const webSearch = registerWebSearch(mock.ctx, state);

  // Disable webSearch in settings
  await state.setModule('webSearch', false);

  assert.equal(state.isModuleEnabled('webSearch'), false);
  assert.equal(webSearch.getActiveRestrictions().size, 2);

  // web_search is hidden from agent views
  assert.equal(agent1.ctx.get('tools').get('web_search'), undefined);
  assert.equal(agent2.ctx.get('tools').get('web_search'), undefined);

  // web_fetch remains untouched
  assert.equal(agent1.ctx.get('tools').get('web_fetch') !== undefined, true);

  // Guard denies direct calls
  const guardReason = mock.checkGuard('web_search');
  assert.ok(guardReason);
  assert.match(guardReason, /disabled in Harness QOL settings/);

  // Other tools are not guarded
  assert.equal(mock.checkGuard('web_fetch'), null);
});

test('web-search: re-enabling module removes restrictions and unblocks guard', async t => {
  const state = await createTestState(t, { webSearch: false });
  const toolsMap = new Map([['web_search', { name: 'web_search' }]]);
  const mock = createMockCordis(toolsMap);
  t.after(() => mock.ctx.dispose());

  const agent = mock.createAgent('session-1');
  const webSearch = registerWebSearch(mock.ctx, state);

  assert.equal(webSearch.getActiveRestrictions().size, 1);
  assert.equal(agent.ctx.get('tools').get('web_search'), undefined);

  // Re-enable
  await state.setModule('webSearch', true);

  assert.equal(webSearch.getActiveRestrictions().size, 0);
  assert.equal(agent.ctx.get('tools').get('web_search') !== undefined, true);
  assert.equal(mock.checkGuard('web_search'), null);
});

test('web-search: restricts new agents created while module is disabled', async t => {
  const state = await createTestState(t, { webSearch: false });
  const toolsMap = new Map([['web_search', { name: 'web_search' }]]);
  const mock = createMockCordis(toolsMap);
  t.after(() => mock.ctx.dispose());

  const webSearch = registerWebSearch(mock.ctx, state);

  // Agent created after registration
  const newAgent = mock.createAgent('session-late');
  mock.ctx.emit('agent/created', { agent: newAgent });

  assert.equal(webSearch.getActiveRestrictions().size, 1);
  assert.equal(newAgent.ctx.get('tools').get('web_search'), undefined);
});

test('web-search: agent disposal cleans up active restriction', async t => {
  const state = await createTestState(t, { webSearch: false });
  const toolsMap = new Map([['web_search', { name: 'web_search' }]]);
  const mock = createMockCordis(toolsMap);
  t.after(() => mock.ctx.dispose());

  const agent = mock.createAgent('session-temp');
  const webSearch = registerWebSearch(mock.ctx, state);

  assert.equal(webSearch.getActiveRestrictions().size, 1);

  mock.disposeAgent('session-temp');

  assert.equal(webSearch.getActiveRestrictions().size, 0);
});

test('web-search: tools/change event reconciles agents if web_search was registered later', async t => {
  const state = await createTestState(t, { webSearch: false });
  const toolsMap = new Map(); // empty initially
  const mock = createMockCordis(toolsMap);
  t.after(() => mock.ctx.dispose());

  const agent = mock.createAgent('session-1');
  const webSearch = registerWebSearch(mock.ctx, state);

  assert.equal(webSearch.getActiveRestrictions().size, 0);

  // Now web_search is added to tools
  toolsMap.set('web_search', { name: 'web_search' });
  mock.ctx.emit('tools/change');

  assert.equal(webSearch.getActiveRestrictions().size, 1);
  assert.equal(agent.ctx.get('tools').get('web_search'), undefined);
});

test('web-search: plugin context dispose removes all restrictions', async t => {
  const state = await createTestState(t, { webSearch: false });
  const toolsMap = new Map([['web_search', { name: 'web_search' }]]);
  const mock = createMockCordis(toolsMap);

  const agent = mock.createAgent('session-1');
  const webSearch = registerWebSearch(mock.ctx, state);

  assert.equal(webSearch.getActiveRestrictions().size, 1);
  assert.equal(agent.ctx.get('tools').get('web_search'), undefined);

  mock.ctx.dispose();

  assert.equal(webSearch.getActiveRestrictions().size, 0);
  assert.equal(agent.ctx.get('tools').get('web_search') !== undefined, true);
});
