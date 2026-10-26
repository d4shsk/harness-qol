import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const MODULE_IDS = Object.freeze(['workspaces', 'models', 'btw', 'quote', 'images', 'console', 'messages', 'instructions', 'mcp']);

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
});

const SETTINGS_FILE = join(homedir(), '.dsh', 'harness-qol-settings.json');

export function createSettingsState(customFilePath) {
  const filePath = customFilePath || SETTINGS_FILE;
  let modules = { ...DEFAULT_MODULES };
  const listeners = new Set();

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

  async function load() {
    try {
      if (existsSync(filePath)) {
        const raw = await readFile(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object' && data.modules) {
          const sanitized = sanitize(data.modules);
          modules = { ...DEFAULT_MODULES, ...sanitized };
        }
      }
    } catch (err) {
      console.warn('[harness-qol] Could not load settings file:', err);
    }
    return { ...modules };
  }

  async function save() {
    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      const data = {
        modules: { ...modules },
        updatedAt: new Date().toISOString(),
      };
      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[harness-qol] Could not save settings file:', err);
    }
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
      modules[id] = !!enabled;
      notify();
      await save();
      return { ...modules };
    },
    async setModules(nextModules) {
      const sanitized = sanitize(nextModules);
      modules = { ...modules, ...sanitized };
      notify();
      await save();
      return { ...modules };
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
  if (!globalThis[globalKey]) {
    const instance = createSettingsState();
    instance.load().catch(() => {});
    globalThis[globalKey] = instance;
  }
  return globalThis[globalKey];
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
