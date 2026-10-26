import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('client.js: successfully generated, valid syntax, and registers module loader', async () => {
  const code = await readFile(new URL('./client.js', import.meta.url), 'utf8');

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
