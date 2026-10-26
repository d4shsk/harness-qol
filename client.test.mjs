import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('plugin manifest loads Plugins UI and exposes concise English component metadata', async () => {
  const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'));
  for (const directory of ['locale', 'workspaces-locale']) {
    const en = JSON.parse(await readFile(new URL(`./${directory}/en.json`, import.meta.url), 'utf8'));
    const ru = JSON.parse(await readFile(new URL(`./${directory}/ru.json`, import.meta.url), 'utf8'));
    assert.deepEqual(ru.meta, en.meta, 'component names and descriptions remain English');
    assert.ok(en.meta.description.length <= 110, 'component description stays short');
    assert.doesNotMatch(en.meta.description, /toggles in Settings/);
  }
});

test('client.js: successfully generated, valid syntax, and registers module loader', async () => {
  const code = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  const settings = await readFile(new URL('./settings-client.js', import.meta.url), 'utf8');
  assert.ok(code.includes(settings), 'generated bundle contains the current Plugins settings implementation');

  // Must not have leaked unexpanded template string placeholders
  assert.equal(code.includes('${settings}'), false, 'client.js must not contain literal ${settings}');
  assert.equal(code.includes('${images}'), false, 'client.js must not contain literal ${images}');
  assert.equal(code.includes('${models}'), false, 'client.js must not contain literal ${models}');
  assert.equal(code.includes('${btw}'), false, 'client.js must not contain literal ${btw}');
  assert.equal(code.includes('${quote}'), false, 'client.js must not contain literal ${quote}');
  assert.equal(code.includes('${workspaces}'), false, 'client.js must not contain literal ${workspaces}');

  let moduleDef = null;
  const mockWindow = {
    __ModuleLoader__: {
      load(def) { moduleDef = def; },
    },
    location: { href: 'http://localhost/' },
    addEventListener() {},
    setInterval() {},
  };
  const context = {
    window: mockWindow,
    document: { documentElement: {}, body: {} },
    MutationObserver: class { observe() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    fetch() {},
    console,
  };

  vm.createContext(context);
  assert.doesNotThrow(() => {
    vm.runInContext(code, context);
  });

  assert.ok(moduleDef, 'ModuleLoader.load was called');
  assert.equal(moduleDef.id, '@local/harness-qol');
  assert.equal(typeof moduleDef.factory, 'function');

  const React = {
    createElement() {},
    useState() {},
    useEffect() {},
    useRef() {},
    useSyncExternalStore() {},
  };
  const plugin = moduleDef.factory(() => React);
  assert.ok(plugin);
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale', 'sessions', 'remote']);
  assert.equal(typeof plugin.apply, 'function');
});
