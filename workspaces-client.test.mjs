import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = await readFile(new URL('./workspaces-client.js', import.meta.url), 'utf8');

// Shallow hook renderer: exercise the real Editor reached through public slots,
// leaving Modal/icons as elements rather than pretending to implement a DOM.
function createRenderer() {
  let view, tree, cursor = 0, hooks = [], effects = [], mounted = false, rendering = false, dirty = false;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  function flush() {
    if (!mounted || rendering) return;
    rendering = true;
    try {
      let passes = 0;
      while (dirty) {
        assert.ok(++passes < 50, 'render must settle');
        dirty = false; cursor = 0; effects = [];
        tree = view();
        for (const effect of effects) effect();
      }
    } finally { rendering = false; }
  }
  const React = {
    createElement(type, props, ...children) {
      children = children.flat(Infinity).filter(child => child != null && typeof child !== 'boolean');
      return { type, props: { ...props, children }, children };
    },
    useState(initial) {
      const i = cursor++;
      if (!hooks[i]) hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
      const hook = hooks[i];
      return [hook.value, next => {
        if (!mounted) return;
        const value = typeof next === 'function' ? next(hook.value) : next;
        if (!Object.is(value, hook.value)) { hook.value = value; dirty = true; flush(); }
      }];
    },
    useRef(value) {
      const i = cursor++;
      return hooks[i] ??= { current: value };
    },
    useEffect(effect, dependencies) {
      const i = cursor++;
      const previous = hooks[i];
      if (previous && same(previous.dependencies, dependencies)) return;
      const hook = hooks[i] = { dependencies, cleanup: previous?.cleanup };
      effects.push(() => { hook.cleanup?.(); hook.cleanup = effect(); });
    },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  };
  return {
    React,
    mount(component) { assert.equal(mounted, false); view = component; mounted = true; dirty = true; flush(); },
    unmount() { mounted = false; for (const hook of hooks) hook.cleanup?.(); hooks = []; },
    get tree() { return tree; },
  };
}

const descendants = (node, predicate) => !node || typeof node !== 'object' ? []
  : [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => descendants(child, predicate))];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : node?.children.map(text).join('') ?? '';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function fixture({ initial, picker = async () => null, save = async () => ({ path: '/saved' }), externalBusy = false } = {}) {
  const renderer = createRenderer();
  const slots = new Map(), dictionaries = new Map(), requests = [], picked = [], saved = [];
  let pickerCalls = 0, closed = 0;
  const ctx = {
    effect: effect => effect(),
    locale: {
      register: (_ns, language, dictionary) => dictionaries.set(language, dictionary),
      bind: () => key => dictionaries.get('en')[key],
      subscribe: () => () => {}, getSnapshot: () => 'en',
    },
    slots: {
      inject: (_name, register) => register(),
      register: (definition, component) => { slots.set(definition.name, component); return () => {}; },
    },
    get(name) {
      assert.equal(name, 'uiWorkspace');
      return { pickDirectory() { pickerCalls++; return picker(); } };
    },
  };
  const register = vm.runInNewContext(`${source}\nregisterWorkspacesClient`, {
    URL, console, AbortController, window: { location: { href: 'http://localhost:32628/' } },
    async fetch(url, options) {
      const request = JSON.parse(options.body);
      requests.push({ url: String(url), options, request });
      const data = request.action === 'read' ? initial : await save(request);
      return { ok: true, json: async () => ({ ok: true, data }) };
    },
  });
  const dispose = register(ctx, renderer.React, { isEnabled: () => true });
  let editor;
  if (initial) {
    const Menu = slots.get('sidebar.workspaces.session.menu.item');
    const menu = Menu({ sessionId: 'session-1', useWorkspaces: selector => selector({
      workspaces: [{ workspaceId: initial.id, sessionIds: ['session-1'] }],
    }) });
    await menu.props.onClick();
    const GlobalEditor = slots.get('shell.overlay');
    renderer.mount(() => GlobalEditor());
    const loader = renderer.tree;
    renderer.unmount();
    renderer.mount(() => loader.type(loader.props));
    // Drain the read request and JSON decoding before entering the real Editor.
    await new Promise(resolve => setImmediate(resolve));
    // The loader retains its Modal; isolate its embedded Editor for form tests.
    editor = renderer.tree.children[0].children[0];
    renderer.unmount();
  } else {
    const DirectoryFlow = slots.get('sidebar.workspaces.directoryFlow');
    editor = DirectoryFlow({ open: true, busy: externalBusy, onCancel: () => { closed++; }, onPicked: path => picked.push(path) });
  }
  // Keep the slot's callbacks while observing the actual saved workspace as well.
  const props = { ...editor.props, embedded: false, onBusyChange: undefined,
    onSaved(value) { saved.push(value); editor.props.onSaved(value); } };
  renderer.mount(() => editor.type(props));
  const nodes = predicate => descendants(renderer.tree, predicate);
  const one = predicate => { const matches = nodes(predicate); assert.equal(matches.length, 1); return matches[0]; };
  const byClass = className => nodes(node => node.props.className === className);
  return {
    renderer, requests, picked, saved, slots,
    get pickerCalls() { return pickerCalls; }, get closed() { return closed; },
    nodes, byClass,
    input: () => one(node => node.type === 'input'),
    add: () => one(node => node.props.className === 'hq-ws-add'),
    submit: () => one(node => node.type === 'button' && node.props.type === 'submit'),
    cancel: () => one(node => node.props.className === 'hq-ws-cancel'),
    alert: () => nodes(node => node.props.role === 'alert').map(text),
    remove: folder => one(node => node.props['aria-label'] === `Remove folder: ${folder}`),
    name(value) { this.input().props.onChange({ target: { value } }); },
    choose() { assert.equal(this.add().props.disabled, false); return this.add().props.onClick(); },
    send() { return one(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); },
    cleanup() { renderer.unmount(); dispose(); },
  };
}

async function useFixture(t, options) {
  const f = await fixture(options);
  t.after(() => f.cleanup());
  return f;
}

const initial = { id: 'workspace-1', revision: 'revision-7', title: 'Existing', folders: ['C:\\primary', 'D:\\extra'] };

test('manager keeps one unkeyed Modal across list, selection, cancel and save', async t => {
  const f = await useFixture(t, { initial });
  f.renderer.unmount();
  const buttonTree = f.slots.get('sidebar.footer.action')({ wide: true });
  descendants(buttonTree, node => node.type === 'button')[0].props.onClick({ currentTarget: null });
  f.renderer.mount(() => f.slots.get('shell.overlay')());
  const manager = f.renderer.tree;
  f.renderer.unmount();
  f.renderer.mount(() => manager.type(manager.props));
  const modal = f.renderer.tree.type;
  assert.equal(modal.name, 'Modal');
  assert.equal(f.renderer.tree.props.key, undefined);
  const screen = () => f.renderer.tree.children[0].children[0];
  assert.equal(screen().type.name, 'WorkspaceList');
  screen().props.onSelect(initial.id);
  assert.equal(f.renderer.tree.type, modal);
  assert.equal(f.renderer.tree.props.key, undefined);
  assert.equal(screen().type.name, 'WorkspaceEditorLoader');
  assert.equal(screen().props.embedded, true);
  screen().props.onBusyChange(true);
  assert.equal(f.renderer.tree.props.busy, true);
  screen().props.onBusyChange(false);
  screen().props.onClose();
  assert.equal(f.renderer.tree.type, modal);
  assert.equal(screen().type.name, 'WorkspaceList');
  screen().props.onSelect(initial.id);
  const loader = screen();
  loader.props.onSaved();
  assert.equal(f.renderer.tree.type, modal);
  assert.equal(screen().props.saved, true);
  f.renderer.unmount();

  // Embedded loader swaps only content, not the native top-layer dialog.
  f.renderer.mount(() => loader.type(loader.props));
  assert.equal(f.renderer.tree.type.name, 'RequestStatus');
  await new Promise(resolve => setImmediate(resolve));
  const editor = f.renderer.tree;
  assert.equal(editor.type.name, 'Editor');
  assert.equal(editor.props.embedded, true);
  f.renderer.unmount();
  let busy;
  f.renderer.mount(() => editor.type({ ...editor.props, onBusyChange: value => { busy = value; } }));
  assert.equal(f.renderer.tree.type, 'form');
  assert.equal(busy, false);
});

test('empty create UI has one name input and no manual path link, hint, badge, or folder row', async t => {
  const f = await useFixture(t);
  assert.equal(f.nodes(node => node.type === 'input').length, 1);
  assert.equal(f.input().props.value, '');
  assert.equal(f.input().props['aria-label'], 'Workspace name');
  assert.equal(f.input().props.required, true);
  assert.equal(f.input().props.maxLength, 200);
  assert.equal(f.input().props.autoFocus, true);
  assert.equal(f.byClass('hq-ws-folder').length, 0);
  assert.equal(f.nodes(node => node.type === 'a').length, 0);
  assert.doesNotMatch(text(f.renderer.tree), /manual|primary|preserve existing chats|paste|enter.*path/i);
  assert.equal(text(f.add()), 'Add folder');
  assert.equal(f.submit().props.disabled, true);
  assert.equal(f.cancel().props.disabled, false);
  assert.equal(f.byClass('hq-ws-source').map(text).join(), 'This computer');
  assert.deepEqual(f.alert(), []);
});

test('picker cancellation leaves the editor unchanged and cancel closes without saving', async t => {
  const f = await useFixture(t, { picker: async () => null });
  await f.choose();
  assert.equal(f.pickerCalls, 1);
  assert.equal(f.input().props.value, '');
  assert.equal(f.byClass('hq-ws-folder').length, 0);
  assert.deepEqual(f.alert(), []);
  assert.equal(f.add().props.disabled, false);
  f.cancel().props.onClick();
  assert.equal(f.closed, 1);
  assert.equal(f.requests.length, 0);
});

test('picker error is visible, preserves folders, and Add folder retries successfully', async t => {
  let attempt = 0;
  const f = await useFixture(t, { picker: async () => {
    if (++attempt === 1) throw new Error('native picker failed');
    return '/projects/retried';
  } });
  await f.choose();
  assert.deepEqual(f.alert(), ['Could not open the folder picker. Please try again.\nnative picker failed']);
  assert.equal(f.add().props.disabled, false);
  assert.equal(f.byClass('hq-ws-folder').length, 0);
  await f.choose();
  assert.equal(f.pickerCalls, 2);
  assert.deepEqual(f.alert(), []);
  assert.equal(f.input().props.value, 'retried');
  assert.equal(f.byClass('hq-ws-folder').length, 1);
});

test('picking trims paths, defaults the name once, ignores exact duplicates, and permits removal', async t => {
  const choices = ['  C:\\projects\\first\\  ', 'C:\\projects\\first\\', '/other/second/'];
  const f = await useFixture(t, { picker: async () => choices.shift() });
  await f.choose();
  assert.equal(f.input().props.value, 'first');
  assert.equal(f.submit().props.disabled, false);
  const first = f.byClass('hq-ws-folder-name')[0];
  assert.equal(text(first), 'first');
  assert.equal(first.props.title, 'C:\\projects\\first\\');
  assert.equal(first.props['aria-label'], 'C:\\projects\\first\\ (Primary)');
  assert.doesNotMatch(text(f.byClass('hq-ws-folder')[0]), /Primary/);
  await f.choose();
  assert.equal(f.byClass('hq-ws-folder').length, 1);
  assert.deepEqual(f.alert(), []);
  await f.choose();
  assert.equal(f.input().props.value, 'first');
  assert.equal(f.byClass('hq-ws-folder').length, 2);
  assert.equal(f.remove('C:\\projects\\first\\').props.disabled, false);
  f.remove('C:\\projects\\first\\').props.onClick();
  assert.equal(f.byClass('hq-ws-folder-name')[0].props['aria-label'], '/other/second/ (Primary)');
  f.remove('/other/second/').props.onClick();
  assert.equal(f.byClass('hq-ws-folder').length, 0);
  assert.equal(f.submit().props.disabled, true);
  assert.equal(f.input().props.value, 'first');
});

test('first picked folder preserves a custom name and defaults a whitespace-only name', async t => {
  const f = await useFixture(t, { picker: async () => '/projects/first' });
  f.name('Custom workspace');
  await f.choose();
  assert.equal(f.input().props.value, 'Custom workspace');
  f.remove('/projects/first').props.onClick();
  f.name('  ');
  await f.choose();
  assert.equal(f.input().props.value, 'first');
  f.name('   ');
  assert.equal(f.submit().props.disabled, true);
});

test('root folder uses its path as the default name', async t => {
  const f = await useFixture(t, { picker: async () => '/' });
  await f.choose();
  assert.equal(f.input().props.value, '/');
  assert.equal(text(f.byClass('hq-ws-folder-name')[0]), '/');
});

test('initial edit locks the primary folder but permits removing secondary folders', async t => {
  const f = await useFixture(t, { initial });
  assert.equal(f.renderer.tree.props.title, 'Edit workspace');
  assert.equal(f.input().props.value, 'Existing');
  assert.equal(f.remove('C:\\primary').props.disabled, true);
  assert.equal(f.remove('C:\\primary').props.title, 'The primary folder stays fixed to preserve existing chats.');
  assert.equal(f.remove('D:\\extra').props.disabled, false);
  f.remove('D:\\extra').props.onClick();
  assert.equal(f.byClass('hq-ws-folder').length, 1);
  assert.equal(f.remove('C:\\primary').props.disabled, true);
  assert.deepEqual(initial.folders, ['C:\\primary', 'D:\\extra']);
});

test('create saves the current ordered paths and title and forwards the saved path to directory flow', async t => {
  const choices = ['/projects/one', '/projects/two'];
  const result = { id: 'new-workspace', path: '/projects/one', title: 'Chosen name' };
  const f = await useFixture(t, { picker: async () => choices.shift(), save: async () => result });
  await f.choose(); await f.choose();
  f.name('Chosen name');
  await f.send();
  assert.equal(f.requests.length, 1);
  const { url, options, request } = f.requests[0];
  assert.equal(url, 'http://localhost:32628/harness-qol/workspaces');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers['content-type'], 'application/json');
  assert.deepEqual(request, { action: 'create', title: 'Chosen name', folders: ['/projects/one', '/projects/two'] });
  assert.deepEqual(f.saved, [result]);
  assert.deepEqual(f.picked, ['/projects/one']);
});

test('edit saves workspace identity and revision with the remaining folders', async t => {
  const f = await useFixture(t, { initial });
  f.name('Renamed');
  f.remove('D:\\extra').props.onClick();
  await f.send();
  assert.deepEqual(f.requests.map(item => item.request), [
    { action: 'read', workspaceId: 'workspace-1' },
    { action: 'update', title: 'Renamed', folders: ['C:\\primary'], workspaceId: 'workspace-1', revision: 'revision-7' },
  ]);
  assert.equal(f.saved.length, 1);
});

test('pending picker disables controls and prevents duplicate picker and save requests', async t => {
  const pending = deferred();
  const f = await useFixture(t, { picker: () => pending.promise });
  const staleChoose = f.add().props.onClick;
  const operation = f.choose();
  assert.equal(f.renderer.tree.props.busy, true);
  assert.equal(text(f.add()), 'Loading…');
  assert.equal(f.input().props.disabled, true);
  assert.ok(f.nodes(node => node.type === 'button').every(node => node.props.disabled));
  await staleChoose();
  await f.send();
  assert.equal(f.pickerCalls, 1);
  assert.equal(f.requests.length, 0);
  pending.resolve('/projects/picked');
  await operation;
  assert.equal(f.renderer.tree.props.busy, false);
  assert.equal(f.add().props.disabled, false);
});

test('pending save disables every editor control and rejects repeated submits', async t => {
  const pending = deferred();
  const f = await useFixture(t, { initial, save: () => pending.promise });
  const operation = f.send();
  assert.equal(f.renderer.tree.props.busy, true);
  assert.equal(text(f.submit()), 'Saving…');
  assert.equal(f.input().props.disabled, true);
  assert.ok(f.nodes(node => node.type === 'button').every(node => node.props.disabled));
  await f.send();
  assert.equal(f.requests.filter(item => item.request.action === 'update').length, 1);
  pending.resolve({ path: 'C:\\primary' });
  await operation;
  assert.equal(f.renderer.tree.props.busy, false);
});

test('save failure is visible and can be retried without losing edits', async t => {
  let attempt = 0;
  const f = await useFixture(t, { initial, save: async () => {
    if (++attempt === 1) throw new Error('Workspace changed; reload it');
    return { path: 'C:\\primary' };
  } });
  f.name('Keep my edit');
  await f.send();
  assert.deepEqual(f.alert(), ['Workspace changed; reload it']);
  assert.equal(f.input().props.value, 'Keep my edit');
  assert.equal(f.byClass('hq-ws-folder').length, 2);
  assert.equal(f.submit().props.disabled, false);
  await f.send();
  assert.deepEqual(f.alert(), []);
  assert.equal(f.saved.length, 1);
});

test('external busy disables empty directory-flow editor and blocks save', async t => {
  const f = await useFixture(t, { externalBusy: true });
  assert.equal(f.renderer.tree.props.busy, true);
  assert.equal(f.input().props.disabled, true);
  assert.ok(f.nodes(node => node.type === 'button').every(node => node.props.disabled));
  await f.send();
  assert.equal(f.requests.length, 0);
});

test('32-folder UI limit disables adding and removal re-enables it', async t => {
  const folders = Array.from({ length: 32 }, (_, i) => `/projects/folder-${i}`);
  const f = await useFixture(t, { initial: { ...initial, folders }, picker: async () => '/projects/replacement' });
  assert.equal(f.byClass('hq-ws-folder').length, 32);
  assert.equal(f.add().props.disabled, true);
  f.remove(folders[31]).props.onClick();
  assert.equal(f.add().props.disabled, false);
  await f.choose();
  assert.equal(f.byClass('hq-ws-folder').length, 32);
  assert.equal(f.add().props.disabled, true);
  assert.equal(f.byClass('hq-ws-folder-name').at(-1).props.title, '/projects/replacement');
});

test('picker settlement after unmount does not save or notify directory flow', async t => {
  const pending = deferred();
  const f = await useFixture(t, { picker: () => pending.promise });
  const operation = f.choose();
  f.renderer.unmount();
  pending.resolve('/projects/too-late');
  await operation;
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.picked, []);
  assert.deepEqual(f.saved, []);
});
