import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('./instructions-client.js', import.meta.url), 'utf8');

test('instructions client: registers settings.section slot and cleans up', () => {
  let registeredSlot = null;
  let injectedName = null;
  let active = true;

  const mockCtx = {
    slots: {
      inject(name, cb) {
        injectedName = name;
        cb();
        return () => { active = false; };
      },
      register(spec, comp) {
        registeredSlot = { spec, comp };
        return () => { active = false; };
      },
    },
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => 'en',
    },
  };

  const React = {
    createElement: () => null,
    useState: init => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useSyncExternalStore: () => 'en',
  };

  const t = k => k;
  let enabled = true;
  const subscribers = new Set();
  const mockStore = {
    isEnabled: () => enabled,
    subscribe: fn => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };

  const sandbox = { console };
  const fn = vm.runInNewContext(`${code}\n;registerInstructionsClient;`, sandbox);

  const cleanup = fn(mockCtx, React, t, mockStore);

  assert.equal(injectedName, 'settings.section');
  assert.ok(registeredSlot);
  assert.equal(registeredSlot.spec.name, 'settings.section');
  assert.equal(registeredSlot.spec.id, 'instructions');
  assert.equal(registeredSlot.spec.order, 13);
  assert.equal(typeof registeredSlot.comp, 'function');

  // Disable module -> slot should be disposed
  enabled = false;
  subscribers.forEach(fn => fn());
  assert.equal(active, false);

  cleanup();
});
