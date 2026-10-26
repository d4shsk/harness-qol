// Workspace UI: public directory-flow slots, session menu action, and sidebar manager.
function registerWorkspacesClient(ctx, React, store) {
  const h = React.createElement;
  const ns = 'harness-qol-workspaces';
  const dictionaries = {
    en: {
      manage: 'Workspaces', create: 'Create workspace', edit: 'Edit workspace', name: 'Workspace name',
      roots: 'Source folders', add: 'Add folder', remove: 'Remove folder', primary: 'Primary',
      source: 'Add a folder on this computer', chooseFolder: 'Choose folder…', manualLink: 'or enter path manually',
      path: 'Absolute folder path', cancel: 'Cancel', save: 'Save changes', saving: 'Saving…', close: 'Close',
      hint: 'The first folder is the primary workspace directory. Other folders are added as reference contexts for the AI agent.',
      primaryHint: 'The primary folder stays fixed to preserve existing chats.', loading: 'Loading…', retry: 'Retry',
      folders: 'folders', editWorkspaceMenu: 'Edit workspace…',
      duplicate: 'This folder is already in the list.',
      nativeFailed: 'Native picker unavailable. Enter an absolute path below.',
      unavailable: 'Workspace service unavailable. Restart Harness after updating the plugin.',
    },
    ru: {
      manage: 'Workspaces', create: 'Создать workspace', edit: 'Редактировать workspace', name: 'Название workspace',
      roots: 'Исходные папки', add: 'Добавить папку', remove: 'Убрать папку', primary: 'Основная',
      source: 'Добавить папку на этом компьютере', chooseFolder: 'Выбрать папку…', manualLink: 'или указать путь вручную',
      path: 'Абсолютный путь к папке', cancel: 'Отменить', save: 'Сохранить изменения', saving: 'Сохранение…', close: 'Закрыть',
      hint: 'Первая папка является основной рабочей директорией. Остальные папки добавляются как контекст для AI-агента.',
      primaryHint: 'Основная папка закреплена для совместимости с существующими чатами.', loading: 'Загрузка…', retry: 'Повторить',
      folders: 'папок', editWorkspaceMenu: 'Редактировать workspace…',
      duplicate: 'Эта папка уже добавлена.',
      nativeFailed: 'Системный выбор недоступен. Укажите абсолютный путь ниже.',
      unavailable: 'Сервис workspace недоступен. Перезапустите Harness после обновления плагина.',
    },
  };
  for (const [language, dictionary] of Object.entries(dictionaries)) ctx.effect(() => ctx.locale.register(ns, language, dictionary));
  const t = ctx.locale.bind(ns);
  const useLocale = () => React.useSyncExternalStore(callback => ctx.locale.subscribe(callback), () => ctx.locale.getSnapshot());

  const editorTarget = {
    current: null,
    listeners: new Set(),
    open(target) {
      this.current = target;
      for (const cb of this.listeners) cb();
    },
    close() {
      this.current = null;
      for (const cb of this.listeners) cb();
    },
  };

  async function run(request, signal) {
    const response = await fetch(new URL('/harness-qol/workspaces', window.location.href), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request), signal,
    });
    let result;
    try { result = await response.json(); } catch { throw new Error(t('unavailable')); }
    if (!response.ok || !result?.ok) throw new Error(result?.error ?? t('unavailable'));
    return result.data;
  }

  const css = `
.hq-ws-dialog{box-sizing:border-box;width:min(580px,calc(100vw - 32px));max-height:calc(100dvh - 48px);padding:24px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;overflow:auto;box-shadow:0 16px 48px rgba(0,0,0,0.2)}
.hq-ws-dialog::backdrop{background:color-mix(in srgb,var(--dsw-alias-bg-base) 72%,transparent)}
.hq-ws-dialog *{box-sizing:border-box}.hq-ws-dialog h2{margin:0;font-size:20px;font-weight:600}.hq-ws-dialog h3{margin:0 0 8px 0;font-size:14px;font-weight:600}
.hq-ws-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
.hq-ws-grid{display:grid;gap:14px}
.hq-ws-dialog button{font:inherit;cursor:pointer;color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:8px 16px}
.hq-ws-dialog button:hover{border-color:var(--dsw-alias-border-l2)}.hq-ws-dialog button:disabled{opacity:.45;cursor:default}
.hq-ws-dialog :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.hq-ws-dialog .hq-ws-icon{border:0;background:none;padding:4px 8px;font-size:18px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:6px}
.hq-ws-dialog .hq-ws-icon:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.hq-ws-name{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 14px;background:var(--dsw-alias-bg-layer-1)}.hq-ws-name:focus-within{border-color:var(--dsw-alias-brand-primary)}
.hq-ws-name input{border:0;background:none;padding:0;outline:none!important;font-size:15px;color:var(--dsw-alias-label-primary);width:100%}.hq-ws-name svg{flex:none;color:var(--dsw-alias-brand-primary)}
.hq-ws-roots{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.hq-ws-add{display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px 16px;color:var(--dsw-alias-label-secondary)}
.hq-ws-btn-choose{display:inline-flex;align-items:center;gap:8px;padding:8px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;cursor:pointer}
.hq-ws-btn-choose:hover{border-color:var(--dsw-alias-border-l2)}
.hq-ws-link{background:none!important;border:none!important;font-size:12px;color:var(--dsw-alias-label-secondary)!important;cursor:pointer;text-decoration:underline;padding:0!important}
.hq-ws-link:hover{color:var(--dsw-alias-label-primary)!important}
.hq-ws-folder{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.hq-ws-folder svg{flex:none;color:var(--dsw-alias-brand-primary)}
.hq-ws-folder-text{min-width:0;flex:1}
.hq-ws-folder-name{font-size:14px;font-weight:600;display:flex;align-items:center;overflow-wrap:anywhere}
.hq-ws-path{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin-top:2px}
.hq-ws-badge{font-size:11px;font-weight:500;margin-left:8px;padding:2px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.hq-ws-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin:0}
.hq-ws-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px;flex-wrap:wrap}
.hq-ws-dialog .hq-ws-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border:0;font-weight:500}
.hq-ws-dialog .hq-ws-cancel{background:transparent}
.hq-ws-error{color:var(--dsw-alias-state-error-primary);font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.hq-ws-inline{display:flex;gap:8px;align-items:center;width:100%}
.hq-ws-inline input{font:inherit;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 12px;width:100%}
.hq-ws-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:transparent;border:0;border-radius:6px;cursor:pointer;text-align:left}
.hq-ws-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}
.hq-ws-menu-item svg{flex:none;color:var(--dsw-alias-label-secondary)}
@media(max-width:480px){.hq-ws-dialog{padding:18px}.hq-ws-dialog h2{font-size:18px}.hq-ws-actions button{flex:1}}
`;

  function FolderIcon({ plus = false } = {}) {
    return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true },
      h('path', { d: 'M3 8V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8h18' }),
      plus && h('path', { d: 'M12 11v7m-3.5-3.5h7' }));
  }

  function Modal({ title, children, onClose, busy }) {
    const ref = React.useRef(null);
    const titleId = React.useId();
    React.useEffect(() => {
      const element = ref.current;
      const previous = document.activeElement;
      element.showModal();
      return () => { element.close(); if (previous?.isConnected) previous.focus(); };
    }, []);
    return h(React.Fragment, null, h('style', null, css),
      h('dialog', { ref, className: 'hq-ws-dialog', 'aria-labelledby': titleId, 'aria-busy': !!busy,
        onCancel: event => { event.preventDefault(); if (!busy) onClose(); } },
        h('header', { className: 'hq-ws-header' }, h('h2', { id: titleId }, title),
          h('button', { className: 'hq-ws-icon', type: 'button', 'aria-label': t('close'), disabled: busy, onClick: onClose }, '×')),
        children));
  }

  function Editor({ initial, onSaved, onClose, externalBusy = false }) {
    const [title, setTitle] = React.useState(initial?.title ?? '');
    const [folders, setFolders] = React.useState(initial?.folders ?? []);
    const [path, setPath] = React.useState('');
    const [showManual, setShowManual] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [picking, setPicking] = React.useState(false);
    const [error, setError] = React.useState('');
    const mounted = React.useRef(true);
    const pending = React.useRef(false);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const disabled = busy || picking || externalBusy;

    const add = value => {
      const folder = value.trim();
      if (!folder) return;
      setFolders(previous => {
        if (previous.includes(folder)) return previous;
        const next = [...previous, folder];
        if (!title.trim() && next.length === 1) {
          const segs = folder.split(/[\\/]/).filter(Boolean);
          const name = segs.pop() || folder;
          setTitle(name);
        }
        return next;
      });
      setPath(''); setError(''); setShowManual(false);
    };

    const choose = async () => {
      if (pending.current) return;
      pending.current = true; setPicking(true); setError('');
      try {
        const value = await ctx.get('uiWorkspace').pickDirectory();
        if (mounted.current && value) add(value);
      } catch (failure) {
        if (mounted.current) { setShowManual(true); setError(t('nativeFailed') + '\n' + failure.message); }
      } finally {
        pending.current = false;
        if (mounted.current) setPicking(false);
      }
    };

    const submit = async event => {
      event.preventDefault(); if (pending.current || disabled) return;
      pending.current = true; setBusy(true); setError('');
      try {
        const value = await run({ action: initial ? 'update' : 'create', title, folders,
          ...(initial ? { workspaceId: initial.id, revision: initial.revision } : {}) });
        if (mounted.current) onSaved(value);
      } catch (failure) { if (mounted.current) setError(failure.message); }
      finally { pending.current = false; if (mounted.current) setBusy(false); }
    };

    return h(Modal, { title: t(initial ? 'edit' : 'create'), busy: disabled, onClose },
      h('form', { onSubmit: submit, className: 'hq-ws-grid' },
        h('label', { className: 'hq-ws-name' }, h(FolderIcon),
          h('input', { value: title, autoFocus: true, maxLength: 200, required: true,
            placeholder: t('name'), 'aria-label': t('name'), disabled,
            onChange: event => setTitle(event.target.value) })),
        h('h3', null, t('roots')),
        h('div', { className: 'hq-ws-roots' },
          ...folders.map((folder, index) => h('div', { key: folder, className: 'hq-ws-folder' },
            h(FolderIcon),
            h('div', { className: 'hq-ws-folder-text' },
              h('div', { className: 'hq-ws-folder-name' }, folder.split(/[\\/]/).filter(Boolean).pop() || folder,
                index === 0 && h('span', { className: 'hq-ws-badge' }, t('primary'))),
              h('div', { className: 'hq-ws-path' }, folder)),
            h('button', { type: 'button', className: 'hq-ws-icon', 'aria-label': t('remove') + ': ' + folder,
              title: initial && index === 0 ? t('primaryHint') : t('remove'),
              disabled: disabled || (!!initial && index === 0),
              onClick: () => setFolders(previous => previous.filter(item => item !== folder)) }, '×'))),
          h('div', { className: 'hq-ws-add' },
            h('span', null, t('source')),
            h('button', { type: 'button', className: 'hq-ws-btn-choose', disabled: disabled || folders.length >= 32, onClick: choose },
              h(FolderIcon, { plus: true }), t(picking ? 'loading' : 'chooseFolder')),
            !showManual && h('button', { type: 'button', className: 'hq-ws-link', onClick: () => setShowManual(true) }, t('manualLink')),
            showManual && h('div', { className: 'hq-ws-inline' },
              h('input', { value: path, 'aria-label': t('path'), placeholder: t('path'), disabled,
                onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); add(path); } },
                onChange: event => setPath(event.target.value) }),
              h('button', { type: 'button', disabled: disabled || !path.trim() || folders.length >= 32, onClick: () => add(path) }, t('add'))))),
        h('p', { className: 'hq-ws-hint' }, t('hint'), initial && ' ' + t('primaryHint')),
        error && h('p', { role: 'alert', className: 'hq-ws-error' }, error),
        h('footer', { className: 'hq-ws-actions' },
          h('button', { type: 'button', className: 'hq-ws-cancel', disabled, onClick: onClose }, t('cancel')),
          h('button', { type: 'submit', className: 'hq-ws-primary', disabled: disabled || !title.trim() || !folders.length },
            t(busy ? 'saving' : initial ? 'save' : 'create')))));
  }

  function DirectoryFlow(props) {
    useLocale();
    if (!props.open || (store && !store.isEnabled('workspaces'))) return null;
    return h(Editor, { externalBusy: props.busy, onClose: props.onCancel, onSaved: value => props.onPicked(value.path) });
  }

  function GlobalWorkspaceEditor() {
    useLocale();
    const [target, setTarget] = React.useState(editorTarget.current);
    React.useEffect(() => {
      const cb = () => setTarget(editorTarget.current);
      editorTarget.listeners.add(cb);
      return () => editorTarget.listeners.delete(cb);
    }, []);
    if (!target || (store && !store.isEnabled('workspaces'))) return null;
    return h(Editor, {
      initial: target.workspace,
      onClose: () => { editorTarget.close(); target.onClose?.(); },
      onSaved: value => { editorTarget.close(); target.onSaved?.(value); },
    });
  }

  function SessionWorkspaceEditMenuItem(props) {
    useLocale();
    if (store && !store.isEnabled('workspaces')) return null;
    const [, setMenuOpen] = props.useMenuOpenState?.() ?? [];
    const workspaces = props.useWorkspaces?.(snapshot => snapshot.workspaces) ?? [];
    const workspace = workspaces.find(w => w.sessionIds?.includes(props.sessionId));
    if (!workspace) return null;
    return h('button', {
      type: 'button', role: 'menuitem', className: 'hq-ws-menu-item',
      onClick: async () => {
        setMenuOpen?.(false);
        try {
          const full = await run({ action: 'read', workspaceId: workspace.id });
          editorTarget.open({ workspace: full });
        } catch (err) { console.error(err); }
      },
    }, h(FolderIcon), h('span', null, t('editWorkspaceMenu')));
  }

  let disposers = [];
  function update() {
    const enabled = !store || store.isEnabled('workspaces');
    if (enabled && disposers.length === 0) {
      const d1 = ctx.slots.inject('sidebar.workspaces.directoryFlow', () => ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', priority: -30 }, DirectoryFlow));
      const d2 = ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', priority: -30 }, DirectoryFlow));
      const d3 = ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'harness-qol-workspace-editor' }, GlobalWorkspaceEditor));
      const d4 = ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item', id: 'harness-qol-edit-workspace', order: 250, label: () => t('editWorkspaceMenu'),
      }, SessionWorkspaceEditMenuItem));
      disposers = [d1, d2, d3, d4];
    } else if (!enabled && disposers.length > 0) {
      for (const d of disposers.reverse()) d();
      disposers = [];
    }
  }

  update();
  const unsub = store?.subscribe ? store.subscribe(update) : null;
  return () => {
    if (unsub) unsub();
    for (const d of disposers.reverse()) d();
    disposers = [];
  };
}
