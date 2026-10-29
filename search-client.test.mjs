import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSettingsState, MODULE_IDS } from './settings-state.js';

const code = await readFile(new URL('./search-client.js', import.meta.url), 'utf8');
const { qolIsFindShortcut, qolFindTextMatches, qolMoveSearchIndex, qolLoadSearchHistory, registerSearchClient, createQolSearchOverlayStore } = new Function(`${code}; return { qolIsFindShortcut, qolFindTextMatches, qolMoveSearchIndex, qolLoadSearchHistory, registerSearchClient, createQolSearchOverlayStore };`)();

test('find shortcut accepts Command+F, Ctrl+F and a physical F in Russian layout', () => {
  for (const event of [{ key: 'f', metaKey: true }, { key: 'f', ctrlKey: true }, { key: 'а', code: 'KeyF', metaKey: true }, { key: 'а', code: 'KeyF', ctrlKey: true }]) {
    assert.equal(qolIsFindShortcut(event), true);
  }
});

test('find shortcut leaves plain F, other commands, IME and consumed events alone', () => {
  for (const event of [{ key: 'f' }, { key: 's', ctrlKey: true }, { key: 'f', ctrlKey: true, shiftKey: true }, { key: 'f', metaKey: true, altKey: true }, { key: 'f', ctrlKey: true, isComposing: true }, { key: 'f', metaKey: true, keyCode: 229 }, { key: 'f', ctrlKey: true, defaultPrevented: true }]) {
    assert.ok(!qolIsFindShortcut(event), JSON.stringify(event));
  }
});

test('literal case-insensitive search handles punctuation, Cyrillic and UTF-16 offsets', () => {
  assert.deepEqual(qolFindTextMatches('CHAT Chat chat', 'chat'), [{ start: 0, end: 4 }, { start: 5, end: 9 }, { start: 10, end: 14 }]);
  assert.deepEqual(qolFindTextMatches('ТЕКСТ и текст', 'текст'), [{ start: 0, end: 5 }, { start: 8, end: 13 }]);
  assert.deepEqual(qolFindTextMatches('.*+?^${}()|[]\\', '.*+?^${}()|[]\\'), [{ start: 0, end: 14 }]);
  assert.deepEqual(qolFindTextMatches('İ😀 match', 'match'), [{ start: 4, end: 9 }]);
  assert.deepEqual(qolFindTextMatches('abc', ' '), []);
  assert.deepEqual(qolFindTextMatches('abc', ''), []);
  assert.deepEqual(qolFindTextMatches('abc', 'not found'), []);
});

test('next and previous wrap safely, including zero results', () => {
  assert.equal(qolMoveSearchIndex(2, 3, 1), 0);
  assert.equal(qolMoveSearchIndex(0, 3, -1), 2);
  assert.equal(qolMoveSearchIndex(0, 1, -1), 0);
  assert.equal(qolMoveSearchIndex(0, 0, 1), -1);
});

function history(pages = 3, load = () => {}) {
  let revision = 0;
  let calls = 0;
  const binding = {
    session: {
      getSnapshot: () => ({ hasMore: revision < pages }),
      async loadOlder() { calls++; await load(); revision++; },
    },
    eventSource: { getSnapshot: () => ({ revision }) },
  };
  return { binding, calls: () => calls };
}

test('search loads all older pages of just its supplied session', async () => {
  const fixture = history();
  const other = history();
  await qolLoadSearchHistory(fixture.binding, () => false);
  assert.equal(fixture.calls(), 3);
  assert.equal(other.calls(), 0);
});

test('closing or switching chat stops paging after the in-flight page', async () => {
  let cancel = false;
  const fixture = history(5, () => { cancel = true; });
  await qolLoadSearchHistory(fixture.binding, () => cancel);
  assert.equal(fixture.calls(), 1);
});

test('failed or non-advancing history pages do not retry forever', async () => {
  const failed = history(3, () => { throw new Error('offline'); });
  await assert.rejects(qolLoadSearchHistory(failed.binding, () => false), /offline/);
  assert.equal(failed.calls(), 1);
  const stalled = history();
  stalled.binding.session.loadOlder = async () => {};
  await assert.rejects(qolLoadSearchHistory(stalled.binding, () => false), /did not advance/);
});

test('floating search target publishes readiness and clears only its own registration', () => {
  const store = createQolSearchOverlayStore();
  const snapshots = [];
  const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));
  assert.equal(store.getSnapshot(), null);
  const first = {}, second = {};
  const releaseFirst = store.attach(first);
  const releaseSecond = store.attach(second);
  releaseFirst();
  assert.equal(store.getSnapshot(), second);
  releaseSecond();
  assert.deepEqual(snapshots, [first, second, null]);
  unsubscribe();
  store.attach(first);
  assert.equal(snapshots.length, 3);
});

test('search stays a compact top overlay, not a full-width composer row', () => {
  assert.match(code, /position: 'fixed', top: 'max\(84px/);
  assert.match(code, /width: 'min\(420px, calc\(100vw - 32px\)\)'/);
  assert.match(code, /ReactDOM\.createPortal\(/);
  assert.match(code, /pointerEvents: 'none'/);
  assert.match(code, /pointer-events:auto/);
  assert.match(code, /style: \{ display: 'contents' \}/);
  assert.match(code, /panel\.current\?\.contains\(document\.activeElement\)/);
  assert.doesNotMatch(code, /hq-find-preview|input:focus-visible\{outline:2px/);
});

test('search is additive, localized, enabled by default and individually configurable', async () => {
  assert.ok(MODULE_IDS.includes('search'));
  const state = createSettingsState();
  assert.equal(state.isModuleEnabled('search'), true);
  const effects = [], entries = [], dictionaries = [];
  registerSearchClient({
    effect(fn) { effects.push(fn); fn(); },
    locale: { register(ns, language, dict) { dictionaries.push({ ns, language, dict }); }, bind: () => key => key },
    slots: { inject(name, fn) { fn(); }, register(options, view) { entries.push({ options, view }); } },
  }, { createElement() {} });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].options, { name: 'shell.overlay', id: 'harness-qol-search-overlay', order: 24 });
  assert.deepEqual(entries[1].options, { name: 'conversation.input.dock', id: 'harness-qol-search', order: 24 });
  assert.equal(typeof entries[0].view, 'function');
  assert.deepEqual(dictionaries.map(d => d.language), ['en', 'ru']);
  assert.match(dictionaries[1].dict.title, /текущем чате/);
  assert.doesNotMatch(code, /new MutationObserver|setInterval\(|innerHTML|appendChild\(|removeAttribute\(/);
  const bundle = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  assert.ok(bundle.includes(code));
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.files.includes('search-client.js'));
});
