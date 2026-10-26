import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createSettingsState, DEFAULT_MODULES, registerSettingsConnection } from './settings-state.js';

const source = await readFile(new URL('./settings-client.js', import.meta.url), 'utf8');
const { createModulesStore } = vm.runInNewContext(`${source}\n;({ createModulesStore });`);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hq-settings-regression-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('settings: desktop sends all reads and writes through its owned carrier, not native fetch', async () => {
  let modules = { ...DEFAULT_MODULES };
  const calls = [];
  const sandbox = {
    fetch() { throw new Error('Native fetch must not run in Desktop'); },
    __DSH_TRANSPORT__: { async fetch(path, options) {
      calls.push({ path, payload: JSON.parse(options.body) });
      const payload = JSON.parse(options.body);
      if (payload.id) modules[payload.id] = payload.enabled;
      return { ok: true, json: async () => ({ ok: true, modules: { ...modules } }) };
    } },
  };
  const store = vm.runInNewContext(`${source}\n;createModulesStore();`, sandbox);
  assert.equal(await store.sync(), true);
  assert.equal(await store.setModule('webSearch', false), true);
  assert.equal(store.isEnabled('webSearch'), false);
  assert.equal(calls[0].path, 'api/harness-qol/settings');
  assert.equal(calls[1].payload.enabled, false);
});

test('settings: failed HTTP save rolls back and surfaces an error instead of caching success', async () => {
  const cached = new Map();
  const sandbox = {
    localStorage: { getItem: key => cached.get(key), setItem: (key, value) => cached.set(key, value) },
    fetch: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: 'Unauthorized' }) }),
  };
  const store = vm.runInNewContext(`${source}\n;createModulesStore();`, sandbox);
  assert.equal(await store.setModule('webSearch', false), false);
  assert.equal(store.isEnabled('webSearch'), true);
  assert.equal(store.getStatus().error, 'Unauthorized');
  assert.equal(cached.size, 0);
});

test('settings: slow initial read cannot revert a newly saved toggle', async () => {
  const read = deferred();
  const store = createModulesStore(payload => payload.id ? Promise.resolve({ ...DEFAULT_MODULES, webSearch: false }) : read.promise);
  const sync = store.sync();
  await store.setModule('webSearch', false);
  read.resolve({ ...DEFAULT_MODULES });
  await sync;
  assert.equal(store.isEnabled('webSearch'), false);
});

test('settings: rapid writes are ordered and the last toggle survives reopening', async () => {
  let persisted = { ...DEFAULT_MODULES };
  const first = deferred();
  let calls = 0;
  const request = async payload => {
    if (!payload.id) return persisted;
    if (++calls === 1) await first.promise;
    persisted = { ...persisted, [payload.id]: payload.enabled };
    return persisted;
  };
  const store = createModulesStore(request);
  const one = store.setModule('webSearch', false);
  const two = store.setModule('webSearch', true);
  const three = store.setModule('webSearch', false);
  await Promise.resolve();
  assert.equal(calls, 1);
  first.resolve();
  await Promise.all([one, two, three]);
  await store.sync();
  assert.equal(store.isEnabled('webSearch'), false);
  assert.equal(store.getStatus().pending, false);
});

test('settings: persisted disabled value notifies already registered listeners on load', async t => {
  const file = join(await temp(t), 'settings.json');
  await createSettingsState(file).setModule('webSearch', false);
  const state = createSettingsState(file);
  let seen;
  state.subscribe(modules => { seen = modules.webSearch; });
  await state.load();
  assert.equal(seen, false);
});

test('settings: write failure reaches caller without publishing an unsaved setting', async t => {
  const directory = join(await temp(t), 'not-a-file');
  await mkdir(directory);
  const state = createSettingsState(directory);
  let notified = 0;
  state.subscribe(() => notified++);
  await assert.rejects(state.setModule('webSearch', false));
  assert.equal(state.isModuleEnabled('webSearch'), true);
  assert.equal(notified, 0);
});

test('settings: concurrent Host saves produce valid JSON and preserve every change', async t => {
  const file = join(await temp(t), 'settings.json');
  const state = createSettingsState(file);
  await Promise.all([state.setModule('webSearch', false), state.setModule('models', false), state.setModule('btw', false)]);
  const data = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(data.modules.webSearch, false);
  assert.equal(data.modules.models, false);
  assert.equal(data.modules.btw, false);
});

test('settings: Desktop-compatible exact route shares persisted operations and reports failures', async t => {
  const file = join(await temp(t), 'settings.json');
  const state = createSettingsState(file);
  let route;
  const ctx = { get: () => ({ fetch: { register(value) { route = value; return () => {}; } } }), effect: fn => fn() };
  registerSettingsConnection(ctx, state);
  assert.equal(route.path, '/api/harness-qol/settings');
  const run = payload => route.fetch(new Request('http://localhost/api/harness-qol/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }));
  const write = await run({ id: 'webSearch', enabled: false });
  assert.equal(write.status, 200);
  assert.equal((await write.json()).modules.webSearch, false);
  assert.equal((await (await run({})).json()).modules.webSearch, false);
  const fresh = createSettingsState(file);
  await fresh.load();
  assert.equal(fresh.isModuleEnabled('webSearch'), false);
  assert.equal((await run({ id: 'unknown', enabled: false })).status, 400);
});
