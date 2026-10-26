import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = await readFile(new URL('./workspaces-client.js', import.meta.url), 'utf8');
const register = vm.runInNewContext(`${source}\nregisterWorkspacesClient`);

// Registration lifetimes only; no React/DOM renderer or mock visual preview.
function fixture(enabled = true) {
  const active = new Map();
  const listeners = new Set();
  const store = {
    isEnabled: () => enabled,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(value) { enabled = value; for (const fn of listeners) fn(); },
  };
  const dictionaries = {};
  const ctx = {
    effect: callback => callback(),
    locale: {
      register(ns, language, dictionary) { dictionaries[language] = dictionary; return () => {}; },
      bind: () => key => dictionaries.en[key],
    },
    slots: {
      inject(name, callback) { return callback(); },
      register(options, component) {
        const key = options.name + ':' + (options.id ?? 'single');
        assert.equal(active.has(key), false, 'no duplicate registrations');
        active.set(key, { options, component });
        return () => active.delete(key);
      },
    },
  };
  const dispose = register(ctx, {}, store);
  return { active, store, dispose, dictionaries, listeners };
}

test('Workspaces footer action is additive and owns an overlay editor', () => {
  const f = fixture();
  const footer = f.active.get('sidebar.footer.action:harness-qol-workspaces');
  assert.ok(footer);
  assert.equal(footer.options.order, 20);
  assert.equal(footer.options.label(), 'Workspaces');
  assert.equal(footer.component.name, 'WorkspacesButton');
  assert.ok(f.active.has('shell.overlay:harness-qol-workspace-editor'));
  assert.equal(f.dictionaries.ru.manage, 'Workspaces');
  assert.ok(f.dictionaries.ru.chooseWorkspace.includes('список папок'));
  f.dispose();
  assert.equal(f.active.size, 0);
  assert.equal(f.listeners.size, 0);
});

test('module toggling removes footer and dialogs and does not duplicate entries', () => {
  const f = fixture(false);
  assert.equal(f.active.size, 0);
  f.store.set(true);
  assert.equal(f.active.size, 5);
  f.store.set(true);
  assert.equal(f.active.size, 5);
  f.store.set(false);
  assert.equal(f.active.size, 0);
  f.store.set(true);
  assert.equal(f.active.size, 5);
  f.dispose();
  assert.equal(f.active.size, 0);
  f.store.set(true);
  assert.equal(f.active.size, 0);
});

test('manager reads a fresh revision and handles errors, cancellation and keyboard dismissal', () => {
  assert.match(source, /useWorkspaceRequest\('list', \{ action: 'list' \}\)/);
  assert.match(source, /useWorkspaceRequest\(workspaceId, \{ action: 'read', workspaceId \}\)/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /if \(!controller\.signal\.aborted\)/);
  assert.match(source, /onClick: retry/);
  assert.match(source, /role: 'alert'/);
  assert.match(source, /onSaved: \(\) => \{ setSelected\(null\); setSaved\(true\); \}/);
  assert.match(source, /aria-haspopup': 'dialog'/);
  assert.match(source, /event\.key === 'Escape'\) event\.stopPropagation\(\)/);
  assert.doesNotMatch(source, /require\(|appendChild|createPortal|querySelector|rgba?\(/);
});
