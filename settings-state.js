import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const MODULE_IDS = Object.freeze(['workspaces', 'models', 'btw', 'quote', 'images', 'console', 'messages', 'instructions', 'mcp', 'webSearch', 'search']);

export const DEFAULT_MODULES = Object.freeze({
  workspaces: true,
  models: true,
  btw: true,
  quote: true,
  images: true,
  console: true,
  messages: true,
  instructions: true,
  mcp: true,
  webSearch: true,
  search: true,
});

const SETTINGS_FILE = join(homedir(), '.dsh', 'harness-qol-settings.json');

export function createSettingsState(customFilePath) {
  const filePath = customFilePath || SETTINGS_FILE;
  let modules = { ...DEFAULT_MODULES };
  const listeners = new Set();
  let loading;
  let queue = Promise.resolve();
  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  function sanitize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const sanitized = {};
    for (const key of MODULE_IDS) {
      if (typeof input[key] === 'boolean') {
        sanitized[key] = input[key];
      }
    }
    return sanitized;
  }

  function load() {
    return loading ||= enqueue(async () => {
      try {
        const data = JSON.parse(await readFile(filePath, 'utf8'));
        modules = { ...DEFAULT_MODULES, ...sanitize(data?.modules) };
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      // Listeners may already be mounted while the singleton initializes.
      notify();
      return { ...modules };
    });
  }

  async function persist(next) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      modules: next, updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  }

  function save() {
    return enqueue(() => persist({ ...modules }));
  }

  function update(patch) {
    return enqueue(async () => {
      const next = { ...modules, ...patch };
      // Publish only after a successful write; errors must reach the caller.
      await persist(next);
      modules = next;
      notify();
      return { ...modules };
    });
  }

  function notify() {
    const snapshot = { ...modules };
    for (const fn of listeners) {
      try { fn(snapshot); } catch (e) { console.error(e); }
    }
  }

  return {
    getModules() {
      return { ...modules };
    },
    isModuleEnabled(id) {
      if (!MODULE_IDS.includes(id)) return true;
      return modules[id] !== false;
    },
    async setModule(id, enabled) {
      if (!MODULE_IDS.includes(id)) {
        throw new Error(`Unknown module: ${id}`);
      }
      return update({ [id]: !!enabled });
    },
    async setModules(nextModules) {
      return update(sanitize(nextModules));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    load,
    save,
  };
}

// Global singleton instance across all plugin files/entries
const globalKey = Symbol.for('harness_qol_settings_state');
export function getSettingsState() {
  // A live bundle upgrade may add modules while the former singleton survives.
  // Reload committed settings into the new schema rather than retaining methods
  // whose closed-over MODULE_IDS reject the new switches.
  if (!globalThis[globalKey] || MODULE_IDS.some(id => !Object.hasOwn(globalThis[globalKey].getModules(), id))) {
    const instance = createSettingsState();
    instance.load().catch(() => {});
    globalThis[globalKey] = instance;
  }
  return globalThis[globalKey];
}

export async function settingsOperation(state, payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid settings payload');
  if (Object.hasOwn(payload, 'id')) {
    if (typeof payload.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    return state.setModule(payload.id, payload.enabled);
  }
  if (Object.hasOwn(payload, 'modules')) {
    if (!payload.modules || typeof payload.modules !== 'object' || Array.isArray(payload.modules)) throw new Error('Invalid modules');
    return state.setModules(payload.modules);
  }
  if (Object.keys(payload).length) throw new Error('Invalid settings payload');
  return state.getModules();
}

export function registerSettingsConnection(ctx, state) {
  const connection = ctx.get('connection');
  ctx.effect(() => connection.fetch.register({
    path: '/api/harness-qol/settings', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const send = (status, data) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
      if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return send(415, { ok: false, error: 'JSON required' });
      try {
        const text = await request.text();
        if (Buffer.byteLength(text) > 64 * 1024) return send(413, { ok: false, error: 'Payload too large' });
        const modules = await settingsOperation(state, JSON.parse(text));
        return send(200, { ok: true, modules });
      } catch (error) {
        return send(400, { ok: false, error: error.message });
      }
    },
  }));
}

export function registerSettingsHttp(ctx, state) {
  const webServer = ctx.get('webServer');
  if (!webServer) return;

  const connection = ctx.get('connection');

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/harness-qol/settings',
    async handler(request, response) {
      const send = (status, data) => {
        response.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        response.end(JSON.stringify(data));
      };

      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        return response.end();
      }

      if (connection) {
        const rejection = connection.requestRejection(request);
        if (rejection) return send(rejection, { ok: false, error: 'Unauthorized' });
      }

      if (request.method === 'GET') {
        return send(200, { ok: true, modules: state.getModules() });
      }

      if (request.method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
          return send(415, { ok: false, error: 'JSON required' });
        }
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of request) {
            size += Buffer.byteLength(chunk);
            if (size > 64 * 1024) return send(413, { ok: false, error: 'Payload too large' });
            chunks.push(Buffer.from(chunk));
          }
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));

          if (payload.id && typeof payload.enabled === 'boolean') {
            const modules = await state.setModule(payload.id, payload.enabled);
            return send(200, { ok: true, modules });
          } else if (payload.modules && typeof payload.modules === 'object') {
            const modules = await state.setModules(payload.modules);
            return send(200, { ok: true, modules });
          } else {
            return send(400, { ok: false, error: 'Invalid payload: expected { id, enabled } or { modules }' });
          }
        } catch (error) {
          return send(400, { ok: false, error: error.message });
        }
      }

      return send(405, { ok: false, error: 'GET or POST required' });
    },
  }));
}
