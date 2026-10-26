import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('./settings-client.js', import.meta.url), 'utf8');

const scope = {};
const fn = new Function('scope', `${code};
scope.createModulesStore = createModulesStore;
`);
fn(scope);

const { createModulesStore } = scope;

test('createModulesStore: initializes with all modules enabled', () => {
  const store = createModulesStore();
  const state = store.get();
  assert.equal(state.workspaces, true);
  assert.equal(state.models, true);
  assert.equal(state.btw, true);
  assert.equal(state.quote, true);
  assert.equal(state.images, true);
  assert.equal(store.isEnabled('workspaces'), true);
  assert.equal(store.isEnabled('images'), true);
});

test('createModulesStore: setModule updates module and notifies subscribers', async () => {
  const store = createModulesStore();
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
  const store = createModulesStore();
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
