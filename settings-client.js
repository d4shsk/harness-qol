// Harness-QOL Settings & Module Management Client
// Concatenate inside the Client ModuleLoader factory, then call registerSettingsClient(ctx, React, t, store).

function createModulesStore() {
  const DEFAULT_MODULES = {
    workspaces: true,
    models: true,
    btw: true,
    quote: true,
    images: true,
  };

  let state = { ...DEFAULT_MODULES };
  try {
    const cached = typeof localStorage !== 'undefined' ? localStorage.getItem('harness_qol_modules') : null;
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed === 'object') {
        state = { ...DEFAULT_MODULES, ...parsed };
      }
    }
  } catch (_e) {}

  const listeners = new Set();
  const notify = () => {
    listeners.forEach(fn => {
      try { fn(state); } catch (_e) {}
    });
  };

  async function sync() {
    try {
      if (typeof fetch === 'undefined') return;
      const res = await fetch('/harness-qol/settings');
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok && data.modules) {
          state = { ...DEFAULT_MODULES, ...data.modules };
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem('harness_qol_modules', JSON.stringify(state));
            }
          } catch (_e) {}
          notify();
        }
      }
    } catch (_e) {}
  }

  async function setModule(id, enabled) {
    state = { ...state, [id]: !!enabled };
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('harness_qol_modules', JSON.stringify(state));
      }
    } catch (_e) {}
    notify();

    try {
      if (typeof fetch !== 'undefined') {
        await fetch('/harness-qol/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, enabled: !!enabled }),
        });
      }
    } catch (_e) {}
  }

  async function setAll(enabled) {
    const next = {};
    for (const key of Object.keys(DEFAULT_MODULES)) {
      next[key] = !!enabled;
    }
    state = next;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('harness_qol_modules', JSON.stringify(state));
      }
    } catch (_e) {}
    notify();

    try {
      if (typeof fetch !== 'undefined') {
        await fetch('/harness-qol/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ modules: next }),
        });
      }
    } catch (_e) {}
  }

  return {
    get() {
      return state;
    },
    isEnabled(id) {
      return state[id] !== false;
    },
    setModule,
    setAll,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    sync,
  };
}

const qolModulesStore = createModulesStore();

function registerSettingsClient(ctx, React, t, store = qolModulesStore) {
  const h = React.createElement;
  const ns = 'harness-qol-settings';

  const dictionaries = {
    en: {
      tabTitle: 'Harness QOL',
      title: 'Harness QOL Settings',
      subtitle: 'Manage modules and quality-of-life enhancements. You can toggle each module individually without restarting.',
      enabledCount: '{count} of {total} modules enabled',
      enableAll: 'Enable all',
      disableAll: 'Disable all',
      statusEnabled: 'Enabled',
      statusDisabled: 'Disabled',
      saveHint: 'Changes take effect immediately across all sessions.',
      modules: {
        workspaces: {
          title: 'Multi-folder Workspaces',
          desc: 'Create and edit workspaces with multiple source folders (up to 32 roots). Provides native folder selection, session context menu "Edit workspace…", and agent dynamic context.',
        },
        models: {
          title: 'Default Model & Session Protection',
          desc: 'Persistent default model for new chats in Settings → Models. Protects global default from being overwritten when changing models inside an individual chat session.',
        },
        btw: {
          title: 'Side Questions (/btw)',
          desc: 'Quick read-only questions to the model with /btw command without interrupting the active agent turn, polluting chat context, or triggering subagents.',
        },
        quote: {
          title: 'Quote Assistant Replies',
          desc: 'Context menu "Quote" when selecting assistant message text (right-click or Shift+F10) with a floating quote dock above prompt input and markdown blockquote insertion.',
        },
        images: {
          title: 'Image Viewer & Copying',
          desc: 'Full-resolution image preview lightbox and right-click context menu "Copy image" to copy PNG pixels directly into the clipboard.',
        },
      },
    },
    ru: {
      tabTitle: 'Harness QOL',
      title: 'Настройки Harness QOL',
      subtitle: 'Управление модулями и улучшениями плагина. Вы можете включать и выключать отдельные модули по необходимости.',
      enabledCount: 'Включено {count} из {total} модулей',
      enableAll: 'Включить все',
      disableAll: 'Выключить все',
      statusEnabled: 'Включён',
      statusDisabled: 'Отключён',
      saveHint: 'Изменения применяются мгновенно и действуют для всех сессий.',
      modules: {
        workspaces: {
          title: 'Мультипапочные воркспейсы',
          desc: 'Создание и редактирование воркспейсов с несколькими папками (до 32 папок). Добавляет системный выбор папок, пункт «Редактировать workspace…» в меню сессии и контекст для агента.',
        },
        models: {
          title: 'Модель по умолчанию и изоляция сессий',
          desc: 'Настройка постоянной модели по умолчанию для новых сессий в Настройки → Модели. Защищает глобальную модель от перезаписи при смене модели внутри отдельного чата.',
        },
        btw: {
          title: 'Фоновые вопросы (/btw)',
          desc: 'Быстрые изолированные вопросы к модели по текущему чату командой /btw без прерывания основной задачи, без засорения контекста агента и без лишних шагов.',
        },
        quote: {
          title: 'Цитирование ответов ассистента',
          desc: 'Контекстное меню «Цитировать» при выделении текста ответа (ПКМ или Shift+F10), карточка цитаты над полем ввода и автоматическая вставка цитаты в промпт.',
        },
        images: {
          title: 'Просмотр и копирование изображений',
          desc: 'Полноэкранный просмотрщик (Lightbox) и пункт контекстного меню «Копировать изображение» для копирования в буфер обмена реальных пикселей PNG в полном разрешении.',
        },
      },
    },
  };

  for (const [language, dictionary] of Object.entries(dictionaries)) {
    ctx.effect(() => ctx.locale.register(ns, language, dictionary));
  }
  const st = ctx.locale.bind(ns);

  const css = `
.hq-set-wrap{box-sizing:border-box;width:100%;max-width:820px;padding:0 0 36px;color:var(--dsw-alias-label-primary,#1f1e1b);font-family:inherit}
.hq-set-wrap *,.hq-set-wrap *::before,.hq-set-wrap *::after{box-sizing:border-box}
.hq-set-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.hq-set-header-text{flex:1;min-width:240px}
.hq-set-title{margin:0 0 6px 0;font-size:22px;font-weight:700;letter-spacing:-.3px;color:inherit;display:flex;align-items:center;gap:10px}
.hq-set-subtitle{margin:0;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary,#6c675d)}
.hq-set-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;padding:12px 16px;border:1px solid var(--dsw-alias-border-l1,#e7e3d8);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);flex-wrap:wrap}
.hq-set-counter{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f1e1b)}
.hq-set-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#10b981);display:inline-block}
.hq-set-dot-partial{background:var(--dsw-alias-brand-primary,#3b82f6)}
.hq-set-actions{display:flex;align-items:center;gap:8px}
.hq-set-btn{display:inline-flex;align-items:center;justify-content:center;padding:6px 12px;font:inherit;font-size:12px;font-weight:500;border:1px solid var(--dsw-alias-border-l2,#d7d1c3);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f3ec);color:inherit;cursor:pointer;transition:background .12s,border-color .12s}
.hq-set-btn:hover{background:var(--dsw-alias-bg-layer-1,#fff);border-color:var(--dsw-alias-brand-primary,#3b82f6)}
.hq-set-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px}
.hq-set-list{display:grid;gap:12px}
.hq-set-card{display:flex;flex-direction:column;gap:10px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1,#e7e3d8);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);transition:border-color .15s,box-shadow .15s}
.hq-set-card:hover{border-color:var(--dsw-alias-border-l2,#d7d1c3);box-shadow:0 2px 10px color-mix(in srgb,var(--dsw-alias-bg-base,#000) 4%,transparent)}
.hq-set-card[data-enabled="false"]{opacity:.72;background:var(--dsw-alias-bg-layer-2,#f6f3ec)}
.hq-set-card-top{display:flex;align-items:center;justify-content:space-between;gap:14px}
.hq-set-card-lead{display:flex;align-items:center;gap:12px;min-width:0;flex:1}
.hq-set-card-icon{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;flex:none}
.hq-set-card-title-wrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.hq-set-card-title{font-size:15px;font-weight:600;margin:0;color:inherit}
.hq-set-badge{display:inline-flex;align-items:center;padding:2px 8px;font-size:11px;font-weight:600;border-radius:99px;line-height:1.4}
.hq-set-badge[data-status="on"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 15%,transparent);color:var(--dsw-alias-state-success-primary,#059669)}
.hq-set-badge[data-status="off"]{background:color-mix(in srgb,var(--dsw-alias-label-secondary,#6c675d) 15%,transparent);color:var(--dsw-alias-label-secondary,#6c675d)}
.hq-set-card-desc{margin:0;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary,#6c675d);padding-left:52px}
@media(max-width:540px){.hq-set-card-desc{padding-left:0}}
.hq-set-switch{position:relative;display:inline-flex;align-items:center;width:42px;height:24px;border-radius:999px;border:1px solid transparent;padding:2px;cursor:pointer;transition:background-color .2s,border-color .2s;outline:none;background-color:var(--dsw-alias-border-l2,#d7d1c3);flex:none}
.hq-set-switch[aria-checked="true"]{background-color:var(--dsw-alias-brand-primary,#3b82f6)}
.hq-set-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px}
.hq-set-switch-thumb{display:inline-block;width:18px;height:18px;border-radius:50%;background-color:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.25);transition:transform .2s cubic-bezier(0.4,0,0.2,1)}
.hq-set-switch[aria-checked="true"] .hq-set-switch-thumb{transform:translateX(18px)}
.hq-set-switch[aria-checked="false"] .hq-set-switch-thumb{transform:translateX(0)}
.hq-set-footer{margin-top:20px;font-size:12px;color:var(--dsw-alias-label-secondary,#6c675d);text-align:center}
`;

  const tagId = 'harness-qol-settings-style';
  if (typeof document !== 'undefined' && !document.getElementById(tagId)) {
    const style = document.createElement('style');
    style.id = tagId;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Icons for each module
  const Icons = {
    workspaces: () => h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true },
      h('path', { d: 'M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z' })),
    models: () => h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true },
      h('path', { d: 'M12 2a4 4 0 0 1 4 4c0 1.5-.8 2.8-2 3.5V11h-4V9.5C8.8 8.8 8 7.5 8 6a4 4 0 0 1 4-4z' }),
      h('rect', { x: 4, y: 11, width: 16, height: 11, rx: 2 }),
      h('circle', { cx: 9, cy: 16, r: 1.5 }),
      h('circle', { cx: 15, cy: 16, r: 1.5 })),
    btw: () => h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true },
      h('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }),
      h('path', { d: 'M12 8v4m0 4h.01' })),
    quote: () => h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
      h('path', { d: 'M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z' })),
    images: () => h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true },
      h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
      h('circle', { cx: 8.5, cy: 8.5, r: 1.5 }),
      h('polyline', { points: '21 15 16 10 5 21' })),
  };

  const Colors = {
    workspaces: { bg: 'color-mix(in srgb, #3b82f6 14%, transparent)', fg: '#2563eb' },
    models: { bg: 'color-mix(in srgb, #8b5cf6 14%, transparent)', fg: '#7c3aed' },
    btw: { bg: 'color-mix(in srgb, #10b981 14%, transparent)', fg: '#059669' },
    quote: { bg: 'color-mix(in srgb, #f59e0b 14%, transparent)', fg: '#d97706' },
    images: { bg: 'color-mix(in srgb, #ec4899 14%, transparent)', fg: '#db2777' },
  };

  function Switch({ checked, onChange, title, id }) {
    return h('button', {
      type: 'button',
      role: 'switch',
      id,
      'aria-checked': checked,
      className: 'hq-set-switch',
      title,
      onClick: (e) => {
        e.stopPropagation();
        onChange(!checked);
      },
    }, h('span', { className: 'hq-set-switch-thumb' }));
  }

  function ModuleCard({ id, enabled, onToggle }) {
    const title = st(`modules.${id}.title`);
    const desc = st(`modules.${id}.desc`);
    const iconFn = Icons[id] || Icons.workspaces;
    const color = Colors[id] || Colors.workspaces;

    return h('div', { className: 'hq-set-card', 'data-enabled': String(enabled) },
      h('div', { className: 'hq-set-card-top' },
        h('div', { className: 'hq-set-card-lead' },
          h('div', {
            className: 'hq-set-card-icon',
            style: { background: color.bg, color: color.fg },
          }, h(iconFn, null)),
          h('div', { className: 'hq-set-card-title-wrap' },
            h('h4', { className: 'hq-set-card-title' }, title),
            h('span', {
              className: 'hq-set-badge',
              'data-status': enabled ? 'on' : 'off',
            }, st(enabled ? 'statusEnabled' : 'statusDisabled'))
          )
        ),
        h(Switch, {
          checked: enabled,
          id: `hq-switch-${id}`,
          title: `${title}: ${st(enabled ? 'statusEnabled' : 'statusDisabled')}`,
          onChange: onToggle,
        })
      ),
      h('p', { className: 'hq-set-card-desc' }, desc)
    );
  }

  function HarnessQolSettingsView() {
    React.useSyncExternalStore(
      callback => ctx.locale.subscribe(callback),
      () => ctx.locale.getSnapshot()
    );

    const [modules, setModules] = React.useState(() => store.get());

    React.useEffect(() => {
      setModules(store.get());
      return store.subscribe(next => setModules({ ...next }));
    }, []);

    const moduleKeys = ['workspaces', 'models', 'btw', 'quote', 'images'];
    const totalCount = moduleKeys.length;
    const enabledCount = moduleKeys.filter(k => modules[k] !== false).length;

    const countText = st('enabledCount')
      .replace('{count}', String(enabledCount))
      .replace('{total}', String(totalCount));

    return h('div', { className: 'hq-set-wrap' },
      h('div', { className: 'hq-set-header' },
        h('div', { className: 'hq-set-header-text' },
          h('h2', { className: 'hq-set-title' }, st('title')),
          h('p', { className: 'hq-set-subtitle' }, st('subtitle'))
        )
      ),
      h('div', { className: 'hq-set-toolbar' },
        h('div', { className: 'hq-set-counter' },
          h('span', { className: enabledCount === totalCount ? 'hq-set-dot' : 'hq-set-dot hq-set-dot-partial' }),
          h('span', null, countText)
        ),
        h('div', { className: 'hq-set-actions' },
          h('button', {
            type: 'button',
            className: 'hq-set-btn',
            disabled: enabledCount === totalCount,
            onClick: () => store.setAll(true),
          }, st('enableAll')),
          h('button', {
            type: 'button',
            className: 'hq-set-btn',
            disabled: enabledCount === 0,
            onClick: () => store.setAll(false),
          }, st('disableAll'))
        )
      ),
      h('div', { className: 'hq-set-list' },
        moduleKeys.map(key => h(ModuleCard, {
          key,
          id: key,
          enabled: modules[key] !== false,
          onToggle: (nextVal) => store.setModule(key, nextVal),
        }))
      ),
      h('p', { className: 'hq-set-footer' }, st('saveHint'))
    );
  }

  // Observer to patch Settings navigation button with Harness QOL SVG icon
  const SVG_PATH = 'M16 18v28m19-28v28M16 32h19';
  function patchNavIcon() {
    if (typeof document === 'undefined') return;
    const spans = document.querySelectorAll('span');
    for (const span of spans) {
      const text = (span.textContent || '').trim();
      if (text === 'Harness QOL' || text === 'Harness-QOL') {
        const btn = span.closest('button');
        if (btn) {
          const svg = btn.querySelector('svg');
          if (svg) {
            svg.setAttribute('viewBox', '0 0 64 64');
            svg.setAttribute('width', '16');
            svg.setAttribute('height', '16');
            svg.setAttribute('fill', 'none');
            const path = svg.querySelector('path');
            if (!path || path.getAttribute('d') !== SVG_PATH) {
              svg.innerHTML = `
                <rect x="3" y="3" width="58" height="58" rx="15" fill="#4868dc"/>
                <path d="${SVG_PATH}" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
                <path d="m46 13 2.2 7.8L56 23l-7.8 2.2L46 33l-2.2-7.8L36 23l7.8-2.2Z" fill="#f2d676"/>
                <path d="m43 40 4 4 8-10" fill="none" stroke="#b9f6d1" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
              `;
            }
          }
        }
      }
    }
  }

  function initNavObserver() {
    if (typeof window === 'undefined') return;
    patchNavIcon();
    if (window.__harnessQolNavObserver) return;
    const observer = new MutationObserver(patchNavIcon);
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    window.addEventListener('click', patchNavIcon, true);
    window.setInterval(patchNavIcon, 400);
    window.__harnessQolNavObserver = observer;
  }

  initNavObserver();

  // Register settings section
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'harness-qol',
    order: 15,
    label: () => st('tabTitle'),
  }, (props) => h(HarnessQolSettingsView, { ...props, ctx })));
}
