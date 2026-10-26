import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelDefaultsOperations, registerModelDefaults } from './model-defaults.js';

const selection = { provider: 'test', model: 'm2' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  let main = { provider: 'old', model: 'old', reasoningEffort: 'high' };
  let admission = Promise.resolve();
  const writes = [], sessions = new Map(), cleanup = [];
  const services = {
    configEditor: { entries: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ ...main }),
      async saveSelection(s) { main = { ...s }; writes.push(s); }
    },
    llm: {
      listProviders: () => [{ id: 'test', name: 'Test' }],
      async listModels(provider) { return [{ provider, id: 'm2', name: 'Model 2' }]; },
      async resolveModelInfo(provider, id) { return { provider, id, reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }; },
      async resolveCallConfig(s) { if (s.reasoningEffort === 'bad') throw new Error('Unsupported effort'); return s; },
    },
  };
  // Match SessionCommandController: async admission, then an anonymous queued
  // callback that logs a local selection and starts background persistence.
  services.sessionController = {
    selectModel(request) {
      const result = admission.then(async () => {
        await services.llm.resolveCallConfig(request);
        const { sessionId, ...selected } = request;
        sessions.set(sessionId, selected);
        void services.agentDefaultModel.saveSelection(selected);
        return { selected };
      });
      admission = result.catch(() => {});
      return result;
    },
  };
  const ctx = {
    get: name => services[name],
    effect: factory => { const dispose = factory(); cleanup.push(dispose); return dispose; },
    inject: (names, factory) => { if (names.every(name => services[name])) factory(ctx); },
  };
  return { ctx, services, writes, sessions, cleanup, getMain: () => main,
    dispose: () => { while (cleanup.length) cleanup.pop()?.(); } };
}

test('operations read/catalog do not mutate; save-main uses canonical owner', async () => {
  const { ctx, writes, getMain } = harness();
  const operations = createModelDefaultsOperations(ctx);
  assert.equal((await operations.run({ action: 'read' })).data.main.model, 'old');
  assert.equal((await operations.run({ action: 'catalog' })).data.providers[0].id, 'test');
  assert.deepEqual(writes, []);
  assert.equal((await operations.run({ action: 'save-main', selection })).ok, true);
  assert.deepEqual(writes, [selection]);
  assert.equal(getMain().model, 'm2');
});

test('validation and cancellation perform no writes', async () => {
  const { ctx, writes } = harness();
  const operations = createModelDefaultsOperations(ctx);
  assert.equal((await operations.run({ action: 'save-main', selection: { ...selection, reasoningEffort: 'bad' } })).ok, false);
  assert.equal((await operations.run({ action: 'save-main', selection: null })).ok, false);
  const controller = new AbortController(); controller.abort();
  assert.equal((await operations.run({ action: 'save-main', selection }, controller.signal)).ok, false);
  assert.deepEqual(writes, []);
});

test('queued chat selections remain local even without stack traces; new chats keep the default', async t => {
  const fixture = harness();
  t.after(fixture.dispose);
  const { ctx, services, writes, sessions, getMain } = fixture;
  const operations = registerModelDefaults(ctx);
  const originalLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    await Promise.all([
      services.sessionController.selectModel({ sessionId: 'new-chat', ...selection }),
      services.sessionController.selectModel({ sessionId: 'other-chat', provider: 'another', model: 'm3', reasoningEffort: 'low' }),
      services.sessionController.selectModel({ sessionId: 'new-chat', ...selection, reasoningEffort: 'high' }),
    ]);
    assert.deepEqual(sessions.get('new-chat'), { ...selection, reasoningEffort: 'high' });
    assert.equal(sessions.get('other-chat').model, 'm3');
    assert.deepEqual(getMain(), { provider: 'old', model: 'old', reasoningEffort: 'high' });
    assert.deepEqual(writes, []);
    assert.deepEqual((await operations.run({ action: 'read' })).data.main, getMain());
    assert.equal((await operations.run({ action: 'save-main', selection })).ok, true);
    assert.deepEqual(writes, [selection]);
    assert.deepEqual(getMain(), selection);
  } finally { Error.stackTraceLimit = originalLimit; }
});

test('chat auto-save cannot leak through while an explicit default save is pending', async t => {
  const fixture = harness();
  t.after(fixture.dispose);
  const { ctx, services, writes, getMain } = fixture;
  const started = deferred(), finish = deferred();
  const originalSave = services.agentDefaultModel.saveSelection;
  services.agentDefaultModel.saveSelection = async function (next) {
    started.resolve();
    await finish.promise;
    return originalSave.call(this, next);
  };
  const operations = registerModelDefaults(ctx);
  const pending = operations.run({ action: 'save-main', selection });
  await started.promise;
  try {
    await services.sessionController.selectModel({ sessionId: 'chat', provider: 'local', model: 'local' });
    assert.deepEqual(writes, []);
  } finally { finish.resolve(); }
  assert.equal((await pending).ok, true);
  assert.deepEqual(writes, [selection]);
  assert.deepEqual(getMain(), selection);
});

test('explicit saves still work while chat admission is pending; unrelated saves are preserved', async t => {
  const fixture = harness();
  t.after(fixture.dispose);
  const { ctx, services, writes, getMain } = fixture;
  const started = deferred(), finish = deferred();
  const resolveCallConfig = services.llm.resolveCallConfig;
  services.llm.resolveCallConfig = async request => {
    if (request.sessionId) { started.resolve(); await finish.promise; }
    return resolveCallConfig(request);
  };
  const operations = registerModelDefaults(ctx);
  const pending = services.sessionController.selectModel({ sessionId: 'chat', provider: 'local', model: 'local' });
  await started.promise;
  try {
    assert.equal((await operations.run({ action: 'save-main', selection })).ok, true);
    // Other explicit callers, including default initialization, retain the normal API.
    await services.agentDefaultModel.saveSelection({ ...selection, reasoningEffort: 'low' });
  } finally { finish.resolve(); }
  await pending;
  assert.deepEqual(writes, [selection, { ...selection, reasoningEffort: 'low' }]);
  assert.deepEqual(getMain(), { ...selection, reasoningEffort: 'low' });
});

test('failed explicit saves and rejected chat selections do not break later saves', async t => {
  const fixture = harness();
  t.after(fixture.dispose);
  const { ctx, services, writes } = fixture;
  const originalSave = services.agentDefaultModel.saveSelection;
  services.agentDefaultModel.saveSelection = async function (next) {
    if (next.model === 'fail') throw new Error('Persistence failed');
    return originalSave.call(this, next);
  };
  const operations = registerModelDefaults(ctx);
  const result = await operations.run({ action: 'save-main', selection: { ...selection, model: 'fail' } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Persistence failed');
  await assert.rejects(services.sessionController.selectModel({ sessionId: 'chat', ...selection, reasoningEffort: 'bad' }), /Unsupported effort/);
  assert.equal((await operations.run({ action: 'save-main', selection })).ok, true);
  await services.sessionController.selectModel({ sessionId: 'chat', ...selection, model: 'local' });
  assert.deepEqual(writes, [selection]);
});

test('unload restores exact methods and a fresh registration does not stack wrappers', async () => {
  const fixture = harness();
  const { ctx, services, writes } = fixture;
  // A real service exposes prototype methods; preserve both their receiver and descriptor.
  const originalSelect = services.sessionController.selectModel;
  const originalSave = services.agentDefaultModel.saveSelection;
  services.sessionController = Object.create({ selectModel: originalSelect });
  services.agentDefaultModel = Object.create({ ...services.agentDefaultModel,
    async saveSelection(next) { assert.equal(this, services.agentDefaultModel); return originalSave(next); } });
  const inheritedSave = services.agentDefaultModel.saveSelection;
  for (let generation = 0; generation < 2; generation++) {
    registerModelDefaults(ctx);
    await services.sessionController.selectModel({ sessionId: 'chat', ...selection });
    assert.deepEqual(writes, []);
    fixture.dispose();
    assert.equal(services.sessionController.selectModel, originalSelect);
    assert.equal(services.agentDefaultModel.saveSelection, inheritedSave);
    assert.equal(Object.hasOwn(services.sessionController, 'selectModel'), false);
    assert.equal(Object.hasOwn(services.agentDefaultModel, 'saveSelection'), false);
  }
  await services.sessionController.selectModel({ sessionId: 'chat', ...selection });
  assert.deepEqual(writes, [selection]);
});

test('unload restores methods through Cordis-style context proxies', async () => {
  const fixture = harness();
  const { ctx, services, writes } = fixture;
  const targets = {};
  for (const name of ['sessionController', 'agentDefaultModel']) {
    targets[name] = services[name];
    services[name] = new Proxy(services[name], {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        // Cordis createTraceable creates a new function proxy per method read.
        return typeof value === 'function' ? new Proxy(value, {}) : value;
      },
    });
  }
  const selectDescriptor = Object.getOwnPropertyDescriptor(targets.sessionController, 'selectModel');
  const saveDescriptor = Object.getOwnPropertyDescriptor(targets.agentDefaultModel, 'saveSelection');
  registerModelDefaults(ctx);
  try {
    await services.sessionController.selectModel({ sessionId: 'chat', ...selection });
    assert.deepEqual(writes, []);
  } finally { fixture.dispose(); }
  assert.deepEqual(Object.getOwnPropertyDescriptor(targets.sessionController, 'selectModel'), selectDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(targets.agentDefaultModel, 'saveSelection'), saveDescriptor);
  await services.sessionController.selectModel({ sessionId: 'chat', ...selection });
  assert.deepEqual(writes, [selection]);
});

test('command and tool execute the same operation and unload cleanly', async () => {
  const { ctx, services } = harness();
  let tool, command, removed = 0;
  services.tools = { register(def) { tool = def; return () => { removed++; }; } };
  services.commands = { register(def) { command = def; return () => { removed++; }; } };
  const cleanup = [];
  ctx.effect = factory => cleanup.push(factory());
  registerModelDefaults(ctx);
  const fromTool = await tool.execute({ action: 'read' }, {});
  const fromCommand = await command.handler({ rawInput: '{"action":"read"}' });
  assert.deepEqual(JSON.parse(fromCommand.text), fromTool);
  cleanup.forEach(dispose => dispose?.());
  assert.equal(removed, 2);
});
