import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('./settings-client.js', import.meta.url), 'utf8');

const scope = {};
const fn = new Function('scope', `${code};
scope.createModulesStore = createModulesStore;
`);
fn(scope);

const { createModulesStore } = scope;
function memoryStore() {
  let modules = allModules(true);
  return createModulesStore(async payload => {
    modules = payload.modules ? { ...payload.modules } : payload.id ? { ...modules, [payload.id]: payload.enabled } : modules;
    return { ...modules };
  });
}

test('createModulesStore: initializes with all modules enabled', () => {
  const store = memoryStore();
  const state = store.get();
  assert.equal(state.workspaces, true);
  assert.equal(state.models, true);
  assert.equal(state.btw, true);
  assert.equal(state.quote, true);
  assert.equal(state.images, true);
  assert.equal(state.instructions, true);
  assert.equal(state.mcp, true);
  assert.equal(state.webSearch, true);
  assert.equal(store.isEnabled('workspaces'), true);
  assert.equal(store.isEnabled('images'), true);
  assert.equal(store.isEnabled('instructions'), true);
  assert.equal(store.isEnabled('mcp'), true);
  assert.equal(store.isEnabled('webSearch'), true);
});

test('createModulesStore: setModule updates module and notifies subscribers', async () => {
  const store = memoryStore();
  let latest = null;
  const unsub = store.subscribe(s => { latest = s; });

  await store.setModule('btw', false);
  assert.equal(store.isEnabled('btw'), false);
  assert.equal(latest?.btw, false);

  await store.setModule('btw', true);
  assert.equal(store.isEnabled('btw'), true);
  assert.equal(latest?.btw, true);

  unsub();
});

test('createModulesStore: setAll toggles all modules simultaneously', async () => {
  const store = memoryStore();
  await store.setAll(false);
  const allFalse = store.get();
  assert.equal(allFalse.workspaces, false);
  assert.equal(allFalse.models, false);
  assert.equal(allFalse.btw, false);
  assert.equal(allFalse.quote, false);
  assert.equal(allFalse.images, false);

  await store.setAll(true);
  const allTrue = store.get();
  assert.equal(allTrue.workspaces, true);
  assert.equal(allTrue.models, true);
  assert.equal(allTrue.btw, true);
  assert.equal(allTrue.quote, true);
  assert.equal(allTrue.images, true);
});

const moduleInfo = [
  { id: 'workspaces', title: 'Multi-folder Workspaces', description: 'Create and edit workspaces with multiple source folders.' },
  { id: 'models', title: 'Default Model', description: 'Keep a default model for new chats, independent of session changes.' },
  { id: 'btw', title: 'Side Questions (/btw)', description: 'Ask a read-only side question without interrupting the active task.' },
  { id: 'search', title: 'Chat Search', description: 'Find text in the current chat with ⌘F / Ctrl+F, highlighted matches and keyboard navigation.' },
  { id: 'quote', title: 'Reply Quoting', description: 'Quote selected assistant text in your next message.' },
  { id: 'images', title: 'Image Preview & Copy', description: 'Preview full-size images and copy them to the clipboard.' },
  { id: 'console', title: 'Interactive Process Console', description: 'Launch stdin-enabled background processes and send commands in the Processes chat view. Existing ordinary jobs stay read-only.' },
  { id: 'messages', title: 'Message Editing', description: 'Edit already sent messages in chat and queued messages before they are processed.' },
  { id: 'instructions', title: 'Agent Instructions (AGENTS.md)', description: 'Edit global and workspace AGENTS.md in Settings, and allow the agent to append guidelines on request.' },
  { id: 'mcp', title: 'MCP Servers Manager', description: 'Manage Model Context Protocol servers in Settings with connection status, tool inspection, and easy installation.' },
  { id: 'webSearch', title: 'Default Web Search', description: 'Built-in web_search tool. Disable to use web search via MCP instead.' },
];
const allModules = enabled => Object.fromEntries(moduleInfo.map(({ id }) => [id, enabled]));
const plain = value => JSON.parse(JSON.stringify(value));

// A small hook renderer keeps these regressions dependency-free. Effects run after
// render, respect dependencies, and clean up on replacement and on unmount.
function createRenderer() {
  let component;
  let hooks = [];
  let cursor = 0;
  let pendingEffects = [];
  let mounted = false;
  let busy = false;
  let dirty = false;
  let tree;
  let renders = 0;

  const sameDependencies = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  function flush() {
    if (!mounted || busy) return;
    busy = true;
    try {
      let passes = 0;
      while (dirty) {
        assert.ok(++passes < 50, 'component must settle without a render loop');
        dirty = false;
        cursor = 0;
        pendingEffects = [];
        tree = component();
        renders++;
        for (const effect of pendingEffects) effect();
      }
    } finally {
      busy = false;
    }
  }
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity).filter(child => child != null && typeof child !== 'boolean') };
    },
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      const hook = hooks[index];
      return [hook.value, next => {
        if (!mounted) return;
        const value = typeof next === 'function' ? next(hook.value) : next;
        if (!Object.is(value, hook.value)) {
          hook.value = value;
          dirty = true;
          flush();
        }
      }];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (previous && sameDependencies(previous.dependencies, dependencies)) return;
      const hook = { dependencies, cleanup: previous?.cleanup };
      hooks[index] = hook;
      pendingEffects.push(() => {
        hook.cleanup?.();
        hook.cleanup = effect();
      });
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const [snapshot, setSnapshot] = React.useState(getSnapshot);
      React.useEffect(() => {
        const update = () => setSnapshot(getSnapshot());
        const unsubscribe = subscribe(update);
        update();
        return unsubscribe;
      }, [subscribe, getSnapshot]);
      return snapshot;
    },
  };
  return {
    React,
    mount(view) {
      assert.equal(mounted, false);
      component = view;
      hooks = [];
      mounted = true;
      dirty = true;
      flush();
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      for (const hook of hooks) hook.cleanup?.();
      hooks = [];
    },
    get tree() { return tree; },
    get renders() { return renders; },
  };
}

function descendants(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [ ...(predicate(node) ? [node] : []), ...node.children.flatMap(child => descendants(child, predicate)) ];
}
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node.children.map(text).join('');
const switches = fixture => descendants(fixture.renderer.tree, node => node.props.role === 'switch');
const byId = (fixture, id) => descendants(fixture.renderer.tree, node => node.props.id === id);
const status = fixture => text(descendants(fixture.renderer.tree, node => node.props.role === 'status')[0]);
const action = (fixture, label) => {
  const matches = descendants(fixture.renderer.tree, node => node.type === 'button' && text(node) === label);
  assert.equal(matches.length, 1, `one ${label} action`);
  return matches[0];
};

function createSettingsFixture({ language = 'en', cached = allModules(true), server = cached } = {}) {
  const renderer = createRenderer();
  const requests = [];
  const writes = [];
  const forbiddenAccesses = [];
  const storage = new Map([['harness_qol_modules', JSON.stringify(cached)]]);
  let serverModules = { ...server };
  const sandbox = {
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) {
        writes.push({ key, value });
        storage.set(key, value);
      },
    },
    async fetch(url, options) {
      requests.push({ url, options });
      if (options?.method === 'POST') {
        const payload = JSON.parse(options.body);
        if (payload.modules) serverModules = { ...payload.modules };
        else if (payload.id) serverModules = { ...serverModules, [payload.id]: payload.enabled };
      }
      const modules = { ...serverModules };
      return { ok: true, json: async () => ({ ok: true, modules }) };
    },
  };
  for (const name of ['document', 'window', 'MutationObserver', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'requestAnimationFrame']) {
    Object.defineProperty(sandbox, name, { get() {
      forbiddenAccesses.push(name);
      throw new Error(`Settings must not access ${name}`);
    } });
  }
  const exports = vm.runInNewContext(`${code}\n;({ registerSettingsClient, createModulesStore, qolModuleInfo });`, sandbox);
  const store = exports.createModulesStore();
  const subscriptions = { active: 0, added: 0, removed: 0 };
  const subscribe = store.subscribe;
  store.subscribe = callback => {
    subscriptions.active++;
    subscriptions.added++;
    const unsubscribe = subscribe(callback);
    let active = true;
    return () => {
      assert.equal(active, true, 'store subscription must only be disposed once');
      active = false;
      subscriptions.active--;
      subscriptions.removed++;
      unsubscribe();
    };
  };
  const dictionaries = new Map();
  const localeListeners = new Set();
  const effects = [];
  const injections = [];
  const registrations = [];
  let currentLanguage = language;
  const ctx = {
    effect(effect) { effects.push(effect()); },
    locale: {
      register(namespace, locale, dictionary) {
        const key = `${namespace}:${locale}`;
        dictionaries.set(key, dictionary);
        return () => dictionaries.delete(key);
      },
      bind(namespace) { return key => dictionaries.get(`${namespace}:${currentLanguage}`)?.[key] ?? key; },
      subscribe(callback) {
        localeListeners.add(callback);
        return () => localeListeners.delete(callback);
      },
      getSnapshot: () => currentLanguage,
    },
    slots: {
      inject(name, callback) { injections.push({ name, callback }); },
      register(slot, component) {
        const registration = { slot: plain(slot), component, active: true };
        registrations.push(registration);
        return () => { registration.active = false; };
      },
    },
  };
  for (const name of ['settings', 'dom']) {
    Object.defineProperty(ctx, name, { get() {
      forbiddenAccesses.push(`ctx.${name}`);
      throw new Error(`Legacy ctx.${name} must not be used`);
    } });
  }
  exports.registerSettingsClient(ctx, renderer.React, key => `Переведено: ${key}`, store);
  let slotCleanup;
  return {
    renderer, store, requests, writes, storage, subscriptions, injections, registrations, forbiddenAccesses,
    moduleInfo: plain(exports.qolModuleInfo),
    get localeSubscribers() { return localeListeners.size; },
    registerSlot() {
      assert.equal(injections.length, 1);
      slotCleanup = injections[0].callback();
    },
    open() {
      if (!registrations.length) this.registerSlot();
      renderer.mount(registrations[0].component);
    },
    close: () => renderer.unmount(),
    setLanguage(next) {
      currentLanguage = next;
      // Snapshot the listeners because a re-render may replace a subscription.
      for (const callback of [...localeListeners]) callback();
    },
    setServer(modules) { serverModules = { ...modules }; },
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
    dispose() {
      renderer.unmount();
      slotCleanup?.();
      for (const cleanup of effects.reverse()) cleanup?.();
      assert.deepEqual(forbiddenAccesses, [], 'no legacy settings, DOM, observer, or timer integration');
    },
  };
}

function assertAccessibleModules(fixture, expected) {
  const buttons = switches(fixture);
  assert.equal(buttons.length, moduleInfo.length);
  for (const [index, info] of moduleInfo.entries()) {
    const button = buttons[index];
    assert.equal(button.type, 'button');
    assert.equal(button.props.type, 'button');
    assert.equal(button.props['aria-checked'], expected[info.id]);
    const labels = byId(fixture, button.props['aria-labelledby']);
    const descriptions = byId(fixture, button.props['aria-describedby']);
    assert.equal(labels.length, 1, `${info.id} has a unique accessible label`);
    assert.equal(descriptions.length, 1, `${info.id} has a unique accessible description`);
    assert.equal(text(labels[0]), info.title);
    assert.equal(text(descriptions[0]), info.description);
    const rows = descendants(fixture.renderer.tree, node => node.props['data-module'] === info.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].props['data-enabled'], String(expected[info.id]));
    const copy = descendants(rows[0], node => node.props.className === 'hq-set-copy');
    assert.equal(copy.length, 1);
    assert.equal(copy[0].props.lang, 'en');
    assert.equal(button.props.title.startsWith(`${info.title}: `), true);
  }
}

function assertPersistence(fixture, payloads, states) {
  const posts = fixture.requests.filter(request => request.options?.body !== '{}');
  assert.equal(posts.length, payloads.length);
  posts.forEach(({ url, options }, index) => {
    assert.equal(url, 'api/harness-qol/settings');
    assert.equal(options.method, 'POST');
    assert.deepEqual(plain(options.headers), { 'content-type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), payloads[index]);
  });
  assert.deepEqual(fixture.writes.map(({ key, value }) => ({ key, modules: JSON.parse(value) })),
    states.map(modules => ({ key: 'harness_qol_modules', modules })));
  assert.deepEqual(JSON.parse(fixture.storage.get('harness_qol_modules')), states.at(-1));
}

test('settings UI: registers only the package-keyed Plugins bundle slot', t => {
  const fixture = createSettingsFixture();
  t.after(() => fixture.dispose());
  assert.deepEqual(fixture.moduleInfo, moduleInfo);
  assert.deepEqual(fixture.injections.map(({ name }) => name), ['plugins.bundle.config']);
  assert.equal(fixture.registrations.length, 0, 'registration is deferred to slot injection');
  assert.equal(fixture.requests.length, 0, 'registration must not start a background sync');
  assert.equal(fixture.subscriptions.active, 0);
  assert.equal(fixture.localeSubscribers, 0);
  fixture.registerSlot();
  assert.equal(fixture.registrations.length, 1);
  assert.deepEqual(fixture.registrations[0].slot, { name: 'plugins.bundle.config', key: '@local/harness-qol' });
  assert.equal(typeof fixture.registrations[0].component, 'function');
});

test('settings UI: eleven accessible English module names and descriptions survive Russian UI', async t => {
  const modules = { workspaces: true, models: false, btw: true, quote: false, images: true, console: true, messages: true, instructions: true, mcp: true, webSearch: true, search: true };
  const fixture = createSettingsFixture({ cached: modules });
  t.after(() => fixture.dispose());
  fixture.open();
  await fixture.settle();
  const section = fixture.renderer.tree;
  assert.equal(section.type, 'section');
  assert.equal(section.props['data-harness-qol-settings'], true);
  assert.equal(section.props['aria-label'], 'Modules');
  const styles = descendants(section, node => node.type === 'style');
  assert.equal(styles.length, 1, 'styles are rendered inside the section');
  assert.match(text(styles[0]), /\.hq-set-switch\[aria-checked=true\]/);
  assertAccessibleModules(fixture, modules);
  assert.equal(status(fixture), '9 of 11 enabled');

  fixture.setLanguage('ru');
  assert.equal(fixture.renderer.tree.props['aria-label'], 'Модули');
  assert.equal(status(fixture), 'Включено 9 из 11');
  assert.equal(action(fixture, 'Включить все').props.disabled, false);
  assert.equal(action(fixture, 'Выключить все').props.disabled, false);
  assertAccessibleModules(fixture, modules);
  assert.equal(switches(fixture)[1].props.title, 'Default Model: Отключён');
  assert.equal(switches(fixture)[0].props.title, 'Multi-folder Workspaces: Включён');
  assert.equal(fixture.localeSubscribers, 1);
});

test('settings UI: individual switches use the original store and single-module persistence payload', async t => {
  const fixture = createSettingsFixture({ language: 'ru' });
  t.after(() => fixture.dispose());
  fixture.open();
  await fixture.settle();
  fixture.writes.length = 0;
  await switches(fixture)[1].props.onClick();
  const disabledModel = { ...allModules(true), models: false };
  assert.deepEqual(plain(fixture.store.get()), disabledModel);
  assert.equal(fixture.store.isEnabled('models'), false);
  assertAccessibleModules(fixture, disabledModel);
  assert.equal(status(fixture), 'Включено 10 из 11');
  assert.equal(action(fixture, 'Включить все').props.disabled, false);

  await switches(fixture)[1].props.onClick();
  assert.deepEqual(plain(fixture.store.get()), allModules(true));
  assertAccessibleModules(fixture, allModules(true));
  assert.equal(action(fixture, 'Включить все').props.disabled, true);
  assertPersistence(fixture, [{ id: 'models', enabled: false }, { id: 'models', enabled: true }],
    [disabledModel, allModules(true)]);
});

test('settings UI: disable/enable all persist the original complete modules payloads', async t => {
  const fixture = createSettingsFixture();
  t.after(() => fixture.dispose());
  fixture.open();
  await fixture.settle();
  fixture.writes.length = 0;
  assert.equal(action(fixture, 'Enable all').props.disabled, true);
  assert.equal(action(fixture, 'Disable all').props.disabled, false);

  await action(fixture, 'Disable all').props.onClick();
  assert.deepEqual(plain(fixture.store.get()), allModules(false));
  assertAccessibleModules(fixture, allModules(false));
  assert.equal(status(fixture), '0 of 11 enabled');
  assert.equal(action(fixture, 'Enable all').props.disabled, false);
  assert.equal(action(fixture, 'Disable all').props.disabled, true);

  await action(fixture, 'Enable all').props.onClick();
  assert.deepEqual(plain(fixture.store.get()), allModules(true));
  assertAccessibleModules(fixture, allModules(true));
  assert.equal(status(fixture), '11 of 11 enabled');
  assert.equal(action(fixture, 'Enable all').props.disabled, true);
  assert.equal(action(fixture, 'Disable all').props.disabled, false);
  assertPersistence(fixture, [{ modules: allModules(false) }, { modules: allModules(true) }],
    [allModules(false), allModules(true)]);
});

test('settings UI: cleans up subscriptions and syncs persisted settings on each reopening', async t => {
  const initialServer = { ...allModules(true), quote: false };
  const fixture = createSettingsFixture({ server: initialServer });
  t.after(() => fixture.dispose());
  fixture.open();
  assertAccessibleModules(fixture, allModules(true));
  await fixture.settle();
  assertAccessibleModules(fixture, initialServer);
  assert.equal(fixture.subscriptions.active, 1);
  assert.equal(fixture.localeSubscribers, 1);
  const getRequests = () => fixture.requests.filter(({ options }) => options?.body === '{}');
  assert.deepEqual(getRequests().map(({ url }) => url), ['api/harness-qol/settings']);

  await fixture.store.setModule('images', false);
  assertAccessibleModules(fixture, { ...initialServer, images: false });
  assert.equal(getRequests().length, 1, 'store updates must not rerun the mount sync');
  fixture.close();
  assert.equal(fixture.subscriptions.active, 0);
  assert.equal(fixture.subscriptions.removed, 1);
  assert.equal(fixture.localeSubscribers, 0);
  const closedRenders = fixture.renderer.renders;
  await fixture.store.setModule('btw', false);
  fixture.setLanguage('ru');
  assert.equal(fixture.renderer.renders, closedRenders, 'closed views do not react to store or locale updates');

  const reopenedServer = { ...allModules(false), models: true };
  fixture.setServer(reopenedServer);
  fixture.open();
  assertAccessibleModules(fixture, { ...initialServer, images: false, btw: false });
  await fixture.settle();
  assertAccessibleModules(fixture, reopenedServer);
  assert.equal(status(fixture), 'Включено 1 из 11');
  assert.deepEqual(plain(fixture.store.get()), reopenedServer);
  assert.deepEqual(JSON.parse(fixture.storage.get('harness_qol_modules')), reopenedServer);
  assert.equal(getRequests().length, 2, 'reopening reconciles with persisted server settings');
  assert.equal(fixture.subscriptions.active, 1);
  assert.equal(fixture.subscriptions.added, 2);
  assert.equal(fixture.localeSubscribers, 1);
  fixture.close();
  assert.equal(fixture.subscriptions.active, 0);
  assert.equal(fixture.subscriptions.removed, 2);
  assert.equal(fixture.localeSubscribers, 0);
});
