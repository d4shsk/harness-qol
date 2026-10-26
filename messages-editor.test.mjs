import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('./messages-client.js', import.meta.url), 'utf8');
function features() {
  return new Function(`${code}; return { qolSaveSentMessage, qolCreateEditedChat, qolFocusEditor, createSentEditsSync,
    createMessageEditsClientStore, registerMessagesClient, qolSentMessageIdentity, qolExecuteMessageCommand, registerQolRegeneratedHistory };`)();
}
function commandContext(execute) {
  // Mirror the runtime contract: services not declared in the module inject list
  // are NOT readable as ctx.<name> (the runner proxy throws); ctx.get(name) is the
  // sanctioned optional lookup and ctx.provide registers them.
  const services = Object.create(null);
  return {
    sessions: { scope: id => ({ remote: { commands: { execute: async line => ({ ok: true, value: {
      result: { kind: 'success', text: JSON.stringify({ ok: true, data: await execute(id, JSON.parse(line.slice(line.indexOf(' ') + 1))) }) },
    } }) } } }) },
    get: name => services[name],
    provide: (name, value) => { services[name] = value; },
  };
}

test('same-chat Edit sends one Host edit without fork, draft mutation or model prompt', async () => {
  const calls = [];
  const ctx = commandContext(async (id, request) => { calls.push([id, request]); return { applied: true, edits: { 5: request.text } }; });
  const result = await features().qolSaveSentMessage(ctx, 's1', 5, 'm1', '  revised\n');
  assert.equal(result.applied, true);
  assert.deepEqual(calls, [['s1', { action: 'edit_sent', sessionId: 's1', seq: 5, messageId: 'm1', text: '  revised\n' }]]);
  await assert.rejects(features().qolSaveSentMessage(commandContext(async () => ({ saved: true })), 's1', 5, 'm1', 'edit'), /Restart Harness/);
});

test('New chat awaits fork, retains child, applies edited text there and only then opens it', async () => {
  const calls = [];
  const ctx = commandContext(async (id, request) => {
    if (request.action === 'get_edits') { calls.push(['read', id]); return { applied: true, edits: { 1: 'Earlier edit', 'm0': 'Earlier edit' } }; }
    calls.push(['edit', id, request.seq, request.text]);
    return { applied: true, edits: { 5: request.text } };
  });
  ctx.sessions.fork = async request => { calls.push(['fork', request.sessionId, request.atSeq]); request.onCreated('child'); return 'child'; };
  ctx.sessions.using = async (id, options, operation) => { calls.push(['retain', id, options.source]); await operation(); calls.push(['release', id]); };
  ctx.provide('uiWorkspace', { openSession: id => { calls.push(['open', id]); } });
  assert.equal(await features().qolCreateEditedChat(ctx, 's1', 5, 'm1', 'new text', {}), 'child');
  assert.deepEqual(calls, [['read', 's1'], ['fork', 's1', 5], ['retain', 'child', 'reference'],
    ['edit', 'child', 1, 'Earlier edit'], ['edit', 'child', 5, 'new text'], ['open', 'child'], ['release', 'child']]);
});

test('retry after partial fork failure reuses the created chat; invalid boundaries fail closed', async () => {
  const ctx = commandContext(async () => ({ applied: true, edits: {} }));
  let forks = 0;
  ctx.sessions.fork = async request => { forks++; request.onCreated('partial-child'); throw new Error('rename failed'); };
  ctx.sessions.using = async (_id, _options, operation) => operation();
  const opened = [];
  ctx.provide('uiWorkspace', { openSession: id => opened.push(id) });
  const attempt = {};
  const { qolCreateEditedChat } = features();
  await assert.rejects(qolCreateEditedChat(ctx, 's1', 5, 'm1', 'new text', attempt), /rename failed/);
  assert.deepEqual(opened, []);
  assert.equal(await qolCreateEditedChat(ctx, 's1', 5, 'm1', 'new text', attempt), 'partial-child');
  assert.equal(forks, 1);
  for (const seq of [undefined, -1, 1.2, NaN]) await assert.rejects(qolCreateEditedChat(ctx, 's1', seq, 'm1', 'new', {}), /boundary/);
});

test('New chat checks Host support before creating any fork', async () => {
  const ctx = commandContext(async () => ({ edits: {} }));
  let forks = 0;
  ctx.sessions.fork = async () => { forks++; };
  ctx.sessions.using = async () => {};
  ctx.provide('uiWorkspace', { openSession() {} });
  await assert.rejects(features().qolCreateEditedChat(ctx, 's1', 5, 'm1', 'new', {}), /Restart Harness/);
  assert.equal(forks, 0);
});

test('session edit hydration is shared, follows live replacements, and cannot overwrite them with a stale read', async () => {
  const { createSentEditsSync, createMessageEditsClientStore } = features();
  const store = createMessageEditsClientStore();
  let settle;
  let reads = 0;
  let snapshot = { change: { entries: [] } };
  let listener;
  let stopped = 0;
  const ctx = commandContext(async () => { reads++; return new Promise(resolve => { settle = resolve; }); });
  ctx.sessions.binding = () => ({ eventSource: {
    getSnapshot: () => snapshot,
    subscribe: fn => { listener = fn; return () => stopped++; },
  } });
  const sync = createSentEditsSync(ctx, store);
  const off1 = sync('s1');
  const off2 = sync('s1');
  assert.equal(reads, 1);
  snapshot = { change: { entries: [{ event: { type: 'user/message', surfaceOp: { op: 'replace' }, data: {
    id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'live edit' }],
  } } }] } };
  listener();
  assert.equal(store.get('s1', 'm1'), 'live edit');
  settle({ applied: true, edits: { m1: 'stale edit', 5: 'stale edit' } });
  // Drain the small command/JSON/then chain without timers or polling.
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(store.get('s1', 'm1'), 'live edit');
  off1(); assert.equal(stopped, 0);
  off2(); assert.equal(stopped, 1);
});

function editorFixture(execute = async () => ({ applied: true, edits: { 5: 'edited' } }), running = false, options = {}) {
  const exports = features();
  let hook = 0;
  const hooks = [];
  const layout = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = hook++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef(value) { const i = hook++; return hooks[i] ??= { current: value }; },
    useMemo(fn, deps) {
      const i = hook++;
      if (!hooks[i] || deps.some((value, index) => !Object.is(value, hooks[i].deps[index]))) hooks[i] = { deps, value: fn() };
      return hooks[i].value;
    },
    useEffect() { hook++; },
    useLayoutEffect(fn) { hook++; layout.push(fn); },
  };
  const components = {};
  const dicts = {};
  const ctx = commandContext(execute);
  // Real ChatNode shape: id + anchorSeq + data.seq, never top-level seq.
  // Deliberately leave the event feed empty to reproduce immediate editing.
  ctx.sessions.binding = () => ({ eventSource: { getSnapshot: () => ({ entries: options.entries || [] }) } });
  ctx.locale = { register: (_ns, lang, dict) => { dicts[lang] = dict; }, bind: () => key => dicts.en[key] || key };
  ctx.effect = fn => fn();
  ctx.slots = { inject: (_name, fn) => fn(), register: (slot, component) => { components[slot.key || slot.id] = component; } };
  exports.registerMessagesClient(ctx, React, { isEnabled: () => true });
  const props = { sessionId: 's1', node: options.node || {
    id: 'm1', anchorSeq: 5, data: { seq: 5, content: [{ type: 'text', text: 'old' }] },
  },
    useSession: select => select({ running }), renderFactorySlot: (_slot, content) => ({ type: 'native', props: content, children: [] }) };
  function render() { hook = 0; layout.length = 0; return components.user(props); }
  return { render, layout, props };
}
function all(tree) { return tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(all)] : []; }
function button(tree, title) { return all(tree).find(el => el.type === 'button' && (el.props.title === title || el.children.includes(title))); }
function openEditor(fixture) {
  const row = fixture.render();
  row.props.ref.current = { getBoundingClientRect: () => ({ height: 900 }) };
  button(row, 'Edit').props.onClick({ preventDefault() {}, stopPropagation() {} });
  return fixture.render();
}

test('inline editor keeps row height, focuses without scrolling, removes old actions and binds Ctrl+Enter to same-chat Edit', async () => {
  const calls = [];
  const fixture = editorFixture(async (id, request) => { calls.push([id, request]); return { applied: true, edits: { 5: request.text } }; });
  let tree = openEditor(fixture);
  assert.equal(tree.props.style.minHeight, 900);
  assert.equal(tree.props.style.justifyContent, 'flex-end');
  const input = all(tree).find(el => el.type === 'textarea');
  assert.equal(input.props.autoFocus, undefined);
  const focus = [];
  input.props.ref.current = { style: {}, scrollHeight: 56, focus: options => focus.push(options) };
  fixture.layout.forEach(fn => fn());
  assert.deepEqual(focus, [{ preventScroll: true }]);
  assert.ok(button(tree, 'Edit'));
  assert.ok(button(tree, 'New chat'));
  assert.equal(button(tree, 'To composer'), undefined);
  assert.equal(button(tree, 'Restart from here'), undefined);
  input.props.onChange({ target: { value: 'updated' } });
  tree = fixture.render();
  const updated = all(tree).find(el => el.type === 'textarea');
  // IME composition must never submit a half-written edit.
  updated.props.onKeyDown({ key: 'Enter', ctrlKey: true, isComposing: true, stopPropagation() {} });
  assert.equal(calls.length, 0);
  // Prevent scroll-restoration callbacks from requiring a real browser here.
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0;
  try {
    updated.props.onKeyDown({ key: 'Enter', ctrlKey: true, stopPropagation() {}, preventDefault() {} });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].action, 'edit_sent');
    assert.equal(calls[0][1].messageId, 'm1'); // Native node has no data.id.
    assert.equal(calls[0][1].text, 'updated');
    assert.equal(all(fixture.render()).some(el => el.type === 'textarea'), false);
  } finally { globalThis.requestAnimationFrame = previous; }
});

test('failed edit retains the draft and exposes an error; double clicks submit only once', async () => {
  let reject;
  let calls = 0;
  const fixture = editorFixture(async () => { calls++; return new Promise((_resolve, fail) => { reject = fail; }); });
  let tree = openEditor(fixture);
  all(tree).find(el => el.type === 'textarea').props.onChange({ target: { value: 'unsaved draft' } });
  tree = fixture.render();
  const save = button(tree, 'Edit');
  const pending = save.props.onClick();
  await save.props.onClick();
  assert.equal(calls, 1);
  assert.equal(all(fixture.render()).find(el => el.type === 'textarea').props.disabled, true);
  reject(new Error('disk failure'));
  await pending;
  tree = fixture.render();
  assert.equal(all(tree).find(el => el.type === 'textarea').props.value, 'unsaved draft');
  assert.ok(all(tree).find(el => el.props.role === 'alert').children.includes('disk failure'));
});

test('compact editor has no explanatory text and all three buttons have equal dimensions', () => {
  const fixture = editorFixture(undefined, false, { node: {
    id: 'm1', anchorSeq: 5, data: { seq: 5, content: [
      { type: 'text', text: 'short' }, { type: 'image', attachment: { attachmentId: 'img1' } },
    ] },
  } });
  const tree = openEditor(fixture);
  const elements = all(tree);
  const card = elements.find(el => el.props.role === 'group');
  assert.equal(card.props.style.maxWidth, '560px');
  const input = elements.find(el => el.type === 'textarea');
  assert.equal(input.props.style.minHeight, '56px');
  const buttons = elements.filter(el => el.type === 'button');
  assert.deepEqual(buttons.map(el => el.children[0]), ['Cancel', 'New chat', 'Edit']);
  for (const prop of ['width', 'height', 'padding', 'boxSizing', 'fontSize']) {
    assert.equal(new Set(buttons.map(el => el.props.style[prop])).size, 1);
  }
  const grid = elements.find(el => el.props.style?.display === 'grid');
  assert.equal(grid.props.style.gridTemplateColumns, 'repeat(3, minmax(0, 1fr))');
  const visible = elements.flatMap(el => el.children.filter(child => typeof child === 'string')).join(' ');
  assert.equal(visible, 'Cancel New chat Edit');
  // Short and wrapped/long content both use bounded auto-height.
  const element = { style: {}, scrollHeight: 500, focus() {} };
  input.props.ref.current = element;
  fixture.layout.forEach(fn => fn());
  assert.equal(element.style.height, '160px');
});

test('native message identity is available before its event feed and supports seq zero', () => {
  const { qolSentMessageIdentity } = features();
  assert.deepEqual(qolSentMessageIdentity({}, 's1', {
    id: 'm1', anchorSeq: 5, data: { seq: 5 },
  }), { seq: 5, messageId: 'm1' });
  assert.deepEqual(qolSentMessageIdentity({}, 's1', {
    id: 'm0', anchorSeq: 9, data: { seq: 0 },
  }), { seq: 0, messageId: 'm0' });
  assert.deepEqual(qolSentMessageIdentity({}, 's1', { anchorSeq: 7, data: { messageId: 'steer' } }), { seq: 7, messageId: 'steer' });
});

test('unidentified messages cannot send empty edit commands; admission enables the existing editor', async t => {
  const { qolSaveSentMessage } = features();
  await assert.rejects(qolSaveSentMessage({}, 's1', undefined, undefined, 'new'), /still sending/);
  const calls = [];
  const fixture = editorFixture(async (_id, request) => { calls.push(request); return { applied: true, edits: { 5: request.text } }; }, false, {
    node: { data: { content: [{ type: 'text', text: 'pending' }] } },
  });
  let tree = openEditor(fixture);
  assert.equal(button(tree, 'Edit').props.disabled, true);
  assert.equal(button(tree, 'New chat').props.disabled, true);
  await button(tree, 'Edit').props.onClick();
  assert.equal(calls.length, 0);
  all(tree).find(el => el.type === 'textarea').props.onChange({ target: { value: 'edited immediately' } });
  fixture.props.node = { id: 'admitted', anchorSeq: 5, data: { seq: 5, content: [{ type: 'text', text: 'pending' }] } };
  tree = fixture.render();
  assert.equal(button(tree, 'Edit').props.disabled, false);
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0;
  t.after(() => { globalThis.requestAnimationFrame = previous; });
  await button(tree, 'Edit').props.onClick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].seq, 5);
  assert.equal(calls[0].messageId, 'admitted');
  assert.equal(calls[0].text, 'edited immediately');
  assert.equal(all(fixture.render()).some(el => el.props.role === 'alert'), false);
});

test('Host errors are shown as readable messages, not JSON envelopes', async () => {
  const ctx = { sessions: { scope: () => ({ remote: { commands: {
    execute: async () => ({ ok: true, value: { result: { kind: 'error', text: '{"ok":false,"error":"Message is still sending"}' } } }),
  } } }) } };
  await assert.rejects(features().qolExecuteMessageCommand(ctx, 's1', {}), error => error.message === 'Message is still sending');
});

test('running session disables same-chat save but leaves explicit New chat available', () => {
  const tree = openEditor(editorFixture(undefined, true));
  assert.equal(button(tree, 'Edit').props.disabled, true);
  assert.equal(button(tree, 'New chat').props.disabled, false);
});

test('registerQolRegeneratedHistory registers an exclusive chat definition hiding superseded events', () => {
  const { registerQolRegeneratedHistory, createMessageEditsClientStore } = features();
  const store = createMessageEditsClientStore();
  let registeredDef;
  const uiConversation = {
    events: {
      register: def => {
        registeredDef = def;
        return () => { registeredDef = undefined; };
      },
    },
  };
  const ctx = {
    get: name => (name === 'uiConversation' ? uiConversation : undefined),
    effect: fn => fn(),
  };

  const history = registerQolRegeneratedHistory(ctx, store);
  assert.ok(registeredDef);
  assert.equal(registeredDef.target, 'chat');
  assert.equal(registeredDef.buildViewNode(), null);

  const listeners = [];
  const entries = [
    { event: { seq: 5, type: 'user/message', data: { id: 'u1', source: { kind: 'user' } } } },
    { event: { seq: 6, type: 'step/start', data: {} } },
    { event: { seq: 7, type: 'assistant/message', data: {} } },
  ];
  const source = {
    getSnapshot: () => ({ entries }),
    subscribe: fn => { listeners.push(fn); return () => {}; },
  };

  const unwatch = history.watch('s1', source);

  // Before any regeneration, nothing is matched
  assert.equal(registeredDef.match(entries[0].event), null);
  assert.equal(registeredDef.match(entries[1].event), null);
  assert.equal(registeredDef.match(entries[2].event), null);

  // Set regeneration range covering 6..7
  store.replace('s1', {}, [{ startSeq: 6, endSeq: 7 }]);

  // Now superseded events 6 and 7 are matched exclusively to hide them from chat
  assert.equal(registeredDef.match(entries[0].event), null);
  assert.deepEqual(registeredDef.match(entries[1].event), { id: '6', role: 'start', exclusive: true });
  assert.deepEqual(registeredDef.match(entries[2].event), { id: '7', role: 'start', exclusive: true });

  unwatch();
});

test('registration reads undeclared services only via ctx.get: direct reads throw at runtime', () => {
  // Regression: dsh-cordis-client-runner proxies ctx so that any service not in
  // the module inject list throws "cannot get property ... without inject" on a
  // DIRECT read. A stray ctx.uiConversation read once aborted the whole boot.
  const { registerMessagesClient } = features();
  const DECLARED = new Set(['slots', 'locale', 'sessions', 'remote']);
  const VERBS = new Set(['effect', 'inject', 'on', 'once', 'provide', 'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce']);
  const services = {
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: () => () => {}, register: () => () => {} },
    sessions: {},
    // Present in the runtime, but deliberately NOT declared: direct reads must throw.
    uiConversation: { events: { register: () => () => {} } },
    uiWorkspace: { openSession() {} },
  };
  const ctx = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'get') return name => services[name];
      if (prop === 'effect') return fn => { fn(); return () => {}; };
      if (DECLARED.has(prop)) return services[prop];
      if (prop in services) throw new Error(`cannot get property "${prop}" without inject`);
      if (VERBS.has(prop)) return () => () => {};
      return undefined;
    },
  });
  assert.doesNotThrow(() => registerMessagesClient(ctx, { createElement: () => null }, { isEnabled: () => true }));
});
