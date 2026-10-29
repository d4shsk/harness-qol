// Harness-QOL module controls, rendered on the bundle's Plugins detail page.
// Concatenate inside the Client ModuleLoader factory.

async function requestQolSettings(payload) {
  // Desktop owns its carrier (and authentication); native fetch bypasses it.
  // Use an exact /api route so the same operation works in Web and Desktop.
  const transport = globalThis.__DSH_TRANSPORT__;
  const response = await (transport?.fetch ? transport.fetch('api/harness-qol/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }) : fetch('api/harness-qol/settings', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }));
  let data;
  try { data = await response.json(); } catch { throw new Error(`Settings: HTTP ${response.status}`); }
  if (!response.ok || !data?.ok || !data.modules) throw new Error(data?.error || `Settings: HTTP ${response.status}`);
  return data.modules;
}

function createModulesStore(request = requestQolSettings) {
  const DEFAULT_MODULES = {
    workspaces: true, models: true, btw: true, quote: true, images: true,
    console: true, messages: true, instructions: true, mcp: true, webSearch: true, search: true,
  };
  function normalize(value) {
    return Object.fromEntries(Object.entries(DEFAULT_MODULES).map(([id, fallback]) =>
      [id, typeof value?.[id] === 'boolean' ? value[id] : fallback]));
  }
  let state = { ...DEFAULT_MODULES };
  try {
    const cached = typeof localStorage !== 'undefined' ? localStorage.getItem('harness_qol_modules') : null;
    if (cached) state = normalize(JSON.parse(cached));
  } catch (_e) {}
  let confirmed = { ...state };
  let revision = 0;
  let syncRevision = 0;
  let pending = 0;
  let error = '';
  let queue = Promise.resolve();
  const listeners = new Set();
  function notify() {
    for (const fn of listeners) { try { fn({ ...state }); } catch (_e) {} }
  }
  function cache() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('harness_qol_modules', JSON.stringify(confirmed));
    } catch (_e) {}
  }
  async function sync() {
    const version = revision;
    const read = ++syncRevision;
    if (pending) return false;
    try {
      const modules = await request({});
      // Opening the panel must not overwrite a click made while GET was pending.
      if (version !== revision || read !== syncRevision || pending) return false;
      confirmed = normalize(modules);
      state = { ...confirmed };
      error = '';
      cache();
      notify();
      return true;
    } catch (err) {
      if (version === revision && read === syncRevision && !pending) {
        error = err.message || String(err);
        notify();
      }
      return false;
    }
  }
  function update(patch, payload) {
    const version = ++revision;
    pending++;
    error = '';
    state = { ...state, ...patch };
    notify();
    const operation = queue.then(async () => {
      try {
        confirmed = normalize(await request(payload));
        cache();
        if (version === revision) state = { ...confirmed };
        return true;
      } catch (err) {
        if (version === revision) {
          state = { ...confirmed };
          error = err.message || String(err);
        }
        return false;
      } finally {
        pending--;
        notify();
      }
    });
    queue = operation;
    return operation;
  }
  return {
    get: () => ({ ...state }),
    getStatus: () => ({ pending: pending > 0, error }),
    isEnabled: id => state[id] !== false,
    setModule(id, enabled) {
      if (!Object.hasOwn(DEFAULT_MODULES, id)) return Promise.resolve(false);
      return update({ [id]: !!enabled }, { id, enabled: !!enabled });
    },
    setAll(enabled) {
      const modules = Object.fromEntries(Object.keys(DEFAULT_MODULES).map(id => [id, !!enabled]));
      return update(modules, { modules });
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    sync,
  };
}

const qolModulesStore = createModulesStore();

// Feature names and descriptions intentionally stay in English in every UI locale.
const qolModuleInfo = [
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

function registerSettingsClient(ctx, React, t, store = qolModulesStore) {
  const h = React.createElement;
  const ns = 'harness-qol-settings';
  const dictionaries = {
    en: {
      title: 'Modules',
      enabledCount: '{count} of {total} enabled',
      enableAll: 'Enable all', disableAll: 'Disable all',
      statusEnabled: 'Enabled', statusDisabled: 'Disabled',
      saving: 'Saving…', saveFailed: 'Could not save or load settings:', retry: 'Retry',
      saveHint: 'Changes are saved automatically. Model defaults can be configured in Settings → Models.',
    },
    ru: {
      title: 'Модули',
      enabledCount: 'Включено {count} из {total}',
      enableAll: 'Включить все', disableAll: 'Выключить все',
      statusEnabled: 'Включён', statusDisabled: 'Отключён',
      saving: 'Сохранение…', saveFailed: 'Не удалось сохранить или загрузить настройки:', retry: 'Повторить',
      saveHint: 'Изменения сохраняются автоматически. Модель по умолчанию настраивается в Настройки → Модели.',
    },
  };
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    ctx.effect(() => ctx.locale.register(ns, language, dictionary));
  }
  const st = ctx.locale.bind(ns);
  const css = `
.hq-set-wrap{box-sizing:border-box;width:100%;min-width:0;color:var(--dsw-alias-label-primary);font-family:inherit}
.hq-set-wrap *{box-sizing:border-box}
.hq-set-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.hq-set-heading{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.hq-set-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.hq-set-counter,.hq-set-footer{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.hq-set-counter{font-variant-numeric:tabular-nums}
.hq-set-actions{display:flex;gap:8px;flex-wrap:wrap}
.hq-set-btn{padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.hq-set-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.hq-set-btn:disabled,.hq-set-switch:disabled{opacity:.4;cursor:default}
.hq-set-error{color:var(--dsw-alias-state-error-primary);font-size:13px;overflow-wrap:anywhere}
.hq-set-list{border-top:1px solid var(--dsw-alias-border-l2)}
.hq-set-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.hq-set-copy{min-width:0}
.hq-set-name{margin:0;font-size:14px;line-height:22px;font-weight:500;overflow-wrap:anywhere}
.hq-set-desc{margin:3px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.hq-set-row[data-enabled=false] .hq-set-name{color:var(--dsw-alias-label-secondary)}
.hq-set-switch{display:inline-flex;align-items:center;flex:none;width:38px;height:22px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s}
.hq-set-switch[aria-checked=true]{background:var(--dsw-alias-label-primary)}
.hq-set-thumb{width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s}
.hq-set-switch[aria-checked=true] .hq-set-thumb{transform:translateX(16px)}
.hq-set-btn:focus-visible,.hq-set-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:3px}
.hq-set-footer{margin:12px 0 0}
@media(prefers-reduced-motion:reduce){.hq-set-switch,.hq-set-thumb{transition:none}}
`;

  function HarnessQolModulesView() {
    React.useSyncExternalStore(callback => ctx.locale.subscribe(callback), () => ctx.locale.getSnapshot());
    const [modules, setModules] = React.useState(() => store.get());
    React.useEffect(() => {
      const unsubscribe = store.subscribe(next => setModules({ ...next }));
      setModules(store.get());
      store.sync();
      return unsubscribe;
    }, []);
    const { pending, error } = store.getStatus();
    const enabledCount = qolModuleInfo.filter(({ id }) => modules[id] !== false).length;
    const countText = st('enabledCount').replace('{count}', String(enabledCount)).replace('{total}', String(qolModuleInfo.length));
    return h('section', { className: 'hq-set-wrap', 'data-harness-qol-settings': true, 'aria-label': st('title'), 'aria-busy': pending },
      h('style', null, css),
      h('div', { className: 'hq-set-header' },
        h('div', { className: 'hq-set-heading' },
          h('h3', { className: 'hq-set-title' }, st('title')),
          h('span', { className: 'hq-set-counter', role: 'status', 'aria-live': 'polite' }, countText)),
        h('div', { className: 'hq-set-actions' },
          h('button', { type: 'button', className: 'hq-set-btn', disabled: pending || enabledCount === qolModuleInfo.length, onClick: () => store.setAll(true) }, st('enableAll')),
          h('button', { type: 'button', className: 'hq-set-btn', disabled: pending || enabledCount === 0, onClick: () => store.setAll(false) }, st('disableAll')))),
      error && h('div', { className: 'hq-set-error', role: 'alert' }, `${st('saveFailed')} ${error} `,
        h('button', { type: 'button', className: 'hq-set-btn', disabled: pending, onClick: () => store.sync() }, st('retry'))),
      h('div', { className: 'hq-set-list' }, qolModuleInfo.map(({ id, title, description }) => {
        const enabled = modules[id] !== false;
        const titleId = `hq-module-${id}-title`;
        const descriptionId = `hq-module-${id}-description`;
        return h('div', { key: id, className: 'hq-set-row', 'data-module': id, 'data-enabled': String(enabled) },
          h('div', { className: 'hq-set-copy', lang: 'en' },
            h('h4', { id: titleId, className: 'hq-set-name' }, title),
            h('p', { id: descriptionId, className: 'hq-set-desc' }, description)),
          h('button', {
            type: 'button', role: 'switch', className: 'hq-set-switch', disabled: pending,
            'aria-checked': enabled, 'aria-labelledby': titleId, 'aria-describedby': descriptionId,
            title: `${title}: ${st(enabled ? 'statusEnabled' : 'statusDisabled')}`,
            onClick: () => store.setModule(id, !enabled),
          }, h('span', { className: 'hq-set-thumb', 'aria-hidden': true })));
      })),
      h('p', { className: 'hq-set-footer' }, pending ? st('saving') : st('saveHint')));
  }

  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: '@local/harness-qol',
  }, HarnessQolModulesView));
}
