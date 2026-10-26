// Pipe-backed console view. All styling is component-owned React style props:
// no inline stylesheet tags (which may be blocked by the application's CSP).
function qolConsoleText(text) {
  return String(text ?? '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
function qolConsoleLabel(job) {
  try {
    const argv = JSON.parse(job.label);
    if (Array.isArray(argv) && argv.length && argv.every(arg => typeof arg === 'string')) {
      const basename = path => path.split(/[\\/]/).pop();
      const target = argv.find(arg => /\.(?:jar|bat|cmd|ps1|sh)$/i.test(arg));
      return target ? `${basename(target)} · ${basename(argv[0])}` : basename(argv[0]);
    }
  } catch {}
  return String(job.label ?? job.id).slice(0, 140);
}
function qolConsoleLogLine(line) {
  const match = /^(\[[^\]\r\n]+\]\s+\[[^\]\r\n]+\/(INFO|WARN|ERROR|FATAL|DEBUG|TRACE)\]\s*)(.*)$/.exec(line);
  return match ? { prefix: match[1], body: match[3], level: match[2] } : { prefix: '', body: line, level: '' };
}
async function qolConsoleRequest(ctx, sessionId, request) {
  const scope = ctx.sessions.scope(sessionId);
  if (!scope) throw new Error('Session unavailable / Сессия недоступна.');
  const reply = await scope.remote.commands.execute('/harness-qol-console ' + JSON.stringify(request), []);
  if (reply?.ok === false) throw new Error(reply.error?.message ?? 'Request failed');
  const execution = reply?.ok === true ? reply.value : reply;
  if (!execution?.result?.text) throw new Error('Console command unavailable / Команда Console недоступна. Перезапустите Harness после обновления.');
  let result;
  try { result = JSON.parse(execution.result.text); } catch { throw new Error(execution.result.text); }
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

// Header lifetimes, not the selected view, drive visibility. An empty session must
// still watch its roster so its first new job can reveal the tab without a reload.
function createQolConsoleVisibility(ctx, render, label) {
  const owners = new Map();
  let enabled = true, disposed = false, withdraw;
  function update() {
    const visible = enabled && !disposed && [...owners.values()].some(Boolean);
    if (visible && !withdraw) withdraw = ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view', id: 'harness-qol-console', order: 20, label,
    }, render));
    else if (!visible && withdraw) { const remove = withdraw; withdraw = null; remove(); }
  }
  return {
    retain(visible) {
      if (disposed) return () => {};
      const key = Symbol(); owners.set(key, visible); update();
      return () => { owners.delete(key); update(); };
    },
    setEnabled(value) { enabled = value; update(); },
    dispose() { disposed = true; owners.clear(); update(); },
  };
}
function qolConsoleLayout() {
  return {
    // The shell already excludes the resident chat composer from this View.
    // Fill that allocated area; do not reserve the footer band a second time.
    panel: { boxSizing: 'border-box', display: 'flex', flexDirection: 'column', height: '100%', maxHeight: '100%', minHeight: 0, overflow: 'hidden', padding: '16px 20px' },
    card: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, overflow: 'auto' },
    log: { flex: '1 1 0', minHeight: 64, height: 'auto', overflow: 'auto' },
    fixed: { flexShrink: 0 },
  };
}
function registerConsoleClient(ctx, React, store) {
  const h = React.createElement;
  const ns = 'harness-qol-console';
  const dictionaries = {
    en: {
      title: 'Processes', console: 'Process console', subtitle: 'Live output and console commands', help: 'Console help',
      intro: 'This is a line-based stdin console, not a full terminal. Ordinary jobs are read-only. For Minecraft, send commands without a leading slash; send “stop” to save the world and shut down safely.',
      executable: 'Executable', args: 'Arguments (JSON array)', cwd: 'Working directory (optional)', start: 'Start process',
      launch: 'New process', empty: 'No background jobs in this session.', select: 'Process', output: 'Output', details: 'Command & details',
      input: 'Console command', placeholder: 'Enter a command…', send: 'Send', sent: 'Written to stdin. Check the output for the result.',
      readonly: 'This job has no writable stdin. Relaunch it as an interactive process to send commands.',
      eof: 'Close input', stop: 'Stop process', confirm: 'Stop now', cancel: 'Cancel',
      warning: 'Force-stopping may lose unsaved data. For Minecraft, send “stop” instead.',
      gap: 'Earlier output is no longer retained.', follow: 'Auto-scroll', stoppedInput: 'Input is closed.', history: '↑ ↓ History · Enter to send',
      stdin: 'Interactive', readOnlyBadge: 'Read-only', failed: 'Request failed', running: 'Running', stopping: 'Stopping', completed: 'Completed', killed: 'Stopped', failedState: 'Failed',
    },
    ru: {
      title: 'Процессы', console: 'Консоль процессов', subtitle: 'Вывод в реальном времени и команды', help: 'Как пользоваться консолью',
      intro: 'Это строковая stdin-консоль, не полноценный терминал. Обычные задачи доступны только для чтения. В Minecraft вводите команды без начального слеша; команда «stop» сохранит мир и безопасно остановит сервер.',
      executable: 'Программа', args: 'Аргументы (JSON-массив)', cwd: 'Рабочая папка (необязательно)', start: 'Запустить процесс',
      launch: 'Новый процесс', empty: 'В этой сессии нет фоновых задач.', select: 'Процесс', output: 'Вывод', details: 'Команда и сведения',
      input: 'Команда консоли', placeholder: 'Введите команду…', send: 'Отправить', sent: 'Записано в stdin. Результат смотрите в выводе.',
      readonly: 'У этой задачи нет доступного stdin. Чтобы отправлять команды, запустите её как интерактивный процесс.',
      eof: 'Закрыть ввод', stop: 'Остановить процесс', confirm: 'Остановить', cancel: 'Отмена',
      warning: 'Принудительная остановка может потерять несохранённые данные. Для Minecraft лучше отправить «stop».',
      gap: 'Ранний вывод больше не хранится.', follow: 'Автопрокрутка', stoppedInput: 'Ввод закрыт.', history: '↑ ↓ История · Enter — отправить',
      stdin: 'Интерактивный', readOnlyBadge: 'Только чтение', failed: 'Не удалось выполнить запрос', running: 'Работает', stopping: 'Останавливается', completed: 'Завершён', killed: 'Остановлен', failedState: 'Ошибка',
    },
  };
  for (const [language, dictionary] of Object.entries(dictionaries)) ctx.effect(() => ctx.locale.register(ns, language, dictionary));
  const t = ctx.locale.bind(ns);
  const jobs = ctx.jobs;
  const layout = qolConsoleLayout();
  const EMPTY_ROWS = Object.freeze([]);
  const token = name => `var(--dsw-alias-${name})`;
  const muted = token('label-secondary');
  const border = `1px solid ${token('border-l1')}`;
  const row = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 };
  const field = { display: 'grid', gap: 7, minWidth: 0, fontSize: 12, fontWeight: 500, color: muted };
  const input = { boxSizing: 'border-box', width: '100%', minWidth: 0, font: 'inherit', fontSize: 13, color: token('label-primary'), background: token('bg-base'), border: `1px solid ${token('border-l2')}`, borderRadius: 9, padding: '10px 12px', outlineOffset: 3 };
  const button = { ...row, flexWrap: 'nowrap', justifyContent: 'center', boxSizing: 'border-box', font: 'inherit', fontSize: 12, fontWeight: 500, color: token('label-primary'), background: token('bg-layer-1'), border, borderRadius: 9, padding: '9px 12px', cursor: 'pointer', minHeight: 36, whiteSpace: 'nowrap' };
  const primary = { background: token('label-primary'), color: token('bg-base'), borderColor: token('label-primary') };
  const message = { ...layout.fixed, margin: 0, fontSize: 12, lineHeight: 1.6, padding: '10px 14px', borderTop: border };
  function icon(kind, size = 16) {
    const paths = { terminal: 'm4 6 5 6-5 6m9 0h7', plus: 'M12 5v14M5 12h14', send: 'm5 12 14-7-4 14-3-7-7 0Zm7 0 7-7', stop: 'M6 6h12v12H6z', help: 'M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01', chevron: 'm9 5 7 7-7 7' };
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { flexShrink: 0 } }, h('path', { d: paths[kind] }));
  }
  function actionButton(label, onClick, options = {}) {
    const { disabled = false, kind, style, ...rest } = options;
    return h('button', { type: 'button', ...rest, disabled, onClick, style: { ...button, ...style, ...(disabled ? { opacity: .45, cursor: 'default' } : {}) } }, kind && icon(kind), label);
  }
  function Output({ sessionId, id, follow }) {
    const view = React.useSyncExternalStore(fn => jobs.state.subscribe(fn), () => jobs.state.getSnapshot().observed[id]);
    const output = React.useRef(null);
    React.useEffect(() => jobs.observe(sessionId, id), [sessionId, id]);
    React.useEffect(() => { if (follow && output.current) output.current.scrollTop = output.current.scrollHeight; }, [view?.text, follow]);
    const lines = React.useMemo(() => qolConsoleText(view?.text).split('\n').map(qolConsoleLogLine), [view?.text]);
    return h(React.Fragment, null,
      view?.gapBefore && h('p', { role: 'status', style: { ...message, color: muted, fontSize: 11, padding: '7px 16px' } }, t('gap')),
      view?.error && h('p', { role: 'alert', style: { ...message, color: token('state-error-primary') } }, view.error),
      h('div', { ref: output, role: 'log', 'aria-live': 'off', tabIndex: 0, 'aria-label': t('output'), style: {
        ...layout.log, boxSizing: 'border-box', padding: '14px 18px', borderTop: border,
        background: token('bg-base'), font: '12px/1.85 ui-monospace, SFMono-Regular, Consolas, monospace', tabSize: 4,
      } }, lines.map((line, index) => h('div', { key: index, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minHeight: '1.85em', color:
        /ERROR|FATAL/.test(line.level) ? token('state-error-primary') : line.level === 'WARN' ? token('state-warn-primary') : /DEBUG|TRACE/.test(line.level) ? muted : token('label-primary') } },
      line.prefix && h('span', { style: { color: muted } }, line.prefix), line.body))));
  }
  function ProcessView({ sessionId }) {
    React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
    const rows = React.useSyncExternalStore(fn => jobs.state.subscribe(fn), () => jobs.state.getSnapshot().rows[sessionId] ?? EMPTY_ROWS);
    const [selected, setSelected] = React.useState('');
    const [executable, setExecutable] = React.useState('java');
    const [args, setArgs] = React.useState('["-Xmx2G", "-jar", "server.jar", "nogui"]');
    const [cwd, setCwd] = React.useState('');
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const [closed, setClosed] = React.useState({});
    const [confirm, setConfirm] = React.useState('');
    const [follow, setFollow] = React.useState(true);
    const [launch, setLaunch] = React.useState(false);
    const [help, setHelp] = React.useState(false);
    const history = React.useRef([]), historyIndex = React.useRef(0), lock = React.useRef(false), mounted = React.useRef(true);
    const launchId = React.useId(), helpId = React.useId(), commandId = React.useId();
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    React.useEffect(() => jobs.watchRows(sessionId), [sessionId]);
    const id = rows.some(job => job.id === selected) ? selected : rows[0]?.id ?? '';
    const job = rows.find(candidate => candidate.id === id);
    const live = job?.status === 'running';
    const interactive = job?.kind === 'qol-console' && job?.owner === sessionId;
    React.useEffect(() => { setText(''); setConfirm(''); setNotice(''); setError(''); history.current = []; historyIndex.current = 0; }, [id]);
    async function act(request, success) {
      if (lock.current) return;
      lock.current = true; setBusy(true); setError(''); setNotice('');
      try {
        const data = await qolConsoleRequest(ctx, sessionId, request);
        if (mounted.current) success?.(data);
      } catch (failure) { if (mounted.current) setError(failure.message ?? t('failed')); }
      finally { lock.current = false; if (mounted.current) setBusy(false); }
    }
    const stateColor = live ? token('state-success-primary') : job?.status === 'failed' ? token('state-error-primary') : job?.status === 'stopping' ? token('state-warn-primary') : muted;
    const badge = { ...row, gap: 6, fontSize: 11, fontWeight: 500, padding: '5px 9px', borderRadius: 20, border, whiteSpace: 'nowrap' };
    return h('section', { 'data-harness-qol-console': '3', style: {
      ...layout.panel, width: '100%', maxWidth: 1160, margin: '0 auto', color: token('label-primary'), font: 'inherit', fontSize: 13,
    } },
    h('header', { style: { ...row, ...layout.fixed, justifyContent: 'space-between', marginBottom: 12 } },
      h('div', { style: row }, h('span', { style: { ...row, padding: 10, border, borderRadius: 12, background: token('bg-layer-1') } }, icon('terminal', 20)),
        h('div', null, h('h2', { style: { margin: 0, fontSize: 17, lineHeight: 1.5, fontWeight: 600 } }, t('console')),
          h('p', { style: { margin: '2px 0 0', color: muted, fontSize: 12 } }, t('subtitle')))),
      h('div', { style: row },
        actionButton(icon('help'), () => setHelp(value => !value), { title: t('help'), 'aria-label': t('help'), 'aria-expanded': help, 'aria-controls': helpId, style: { width: 36, padding: 8 } }),
        actionButton(t('launch'), () => setLaunch(value => !value), { kind: 'plus', 'aria-expanded': launch, 'aria-controls': launchId }))),
    help && h('aside', { id: helpId, style: { ...layout.fixed, marginBottom: 16, padding: '12px 16px', border, borderRadius: 12, color: muted, fontSize: 12, lineHeight: 1.7, background: token('bg-layer-1') } }, t('intro')),
    launch && h('form', { id: launchId, style: { ...layout.fixed, maxHeight: '35%', overflow: 'auto', display: 'grid', gap: 14, padding: 18, border, borderRadius: 14, background: token('bg-layer-1'), marginBottom: 18 }, onSubmit: event => {
      event.preventDefault();
      let argv;
      try {
        const parsed = JSON.parse(args);
        if (!Array.isArray(parsed) || parsed.some(arg => typeof arg !== 'string')) throw new Error(t('args'));
        argv = [executable, ...parsed];
      } catch (failure) { setError(failure.message); return; }
      act({ action: 'start', argv, ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }, data => { setSelected(data.job.id); setLaunch(false); });
    } },
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 14 } },
      h('label', { style: field }, t('executable'), h('input', { style: input, value: executable, required: true, disabled: busy, onChange: e => setExecutable(e.target.value), autoComplete: 'off' })),
      h('label', { style: field }, t('cwd'), h('input', { style: input, value: cwd, disabled: busy, onChange: e => setCwd(e.target.value), autoComplete: 'off' }))),
    h('label', { style: field }, t('args'), h('textarea', { style: { ...input, resize: 'vertical', fontFamily: 'ui-monospace, Consolas, monospace' }, value: args, rows: 2, disabled: busy, onChange: e => setArgs(e.target.value), spellCheck: false })),
    h('div', { style: { ...row, justifyContent: 'flex-end' } }, actionButton(t('cancel'), () => setLaunch(false)),
      h('button', { type: 'submit', disabled: busy, style: { ...button, ...primary, opacity: busy ? .45 : 1 } }, t('start')))),
    h('div', { style: { ...layout.card, border, borderRadius: 14, background: token('bg-layer-1') } },
      h('div', { style: { ...row, ...layout.fixed, gap: 14, padding: '12px 18px', justifyContent: 'space-between' } },
        h('label', { style: { ...field, flex: '1 1 240px' } }, t('select'),
          h('select', { value: id, disabled: busy || !rows.length, style: { ...input, background: token('bg-layer-1'), fontWeight: 500 }, onChange: event => setSelected(event.target.value) },
            rows.length ? rows.map(candidate => h('option', { key: candidate.id, value: candidate.id }, qolConsoleLabel(candidate))) : h('option', { value: '' }, t('empty')))),
        job && h('div', { style: row },
          h('span', { style: { ...badge, color: stateColor } }, h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 } }), t(job.status === 'failed' ? 'failedState' : job.status)),
          h('span', { style: { ...badge, color: muted } }, icon('terminal', 12), t(interactive ? 'stdin' : 'readOnlyBadge')))),
      job && h('details', { style: { ...layout.fixed, maxHeight: '22%', overflow: 'auto', borderTop: border, fontSize: 11, color: muted } },
        h('summary', { style: { cursor: 'pointer', padding: '9px 18px', userSelect: 'none' } }, t('details')),
        h('div', { style: { padding: '0 18px 12px', display: 'grid', gap: 6 } }, h('code', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11, lineHeight: 1.6, color: token('label-primary') } }, job.label),
          h('span', { style: { overflowWrap: 'anywhere' } }, job.id), job.detail && h('span', null, job.detail))),
      job && h(React.Fragment, null,
        h('div', { style: { ...row, ...layout.fixed, justifyContent: 'space-between', padding: '8px 18px', borderTop: border, color: muted, fontSize: 11 } },
          h('span', { style: { ...row, gap: 6 } }, icon('terminal', 13), t('output')),
          h('label', { style: { ...row, gap: 7, cursor: 'pointer' } }, h('input', { type: 'checkbox', checked: follow, style: { margin: 0, accentColor: token('brand-primary') }, onChange: e => setFollow(e.target.checked) }), t('follow'))),
        h(Output, { key: id, sessionId, id, follow }),
        error && h('p', { role: 'alert', style: { ...message, color: token('state-error-primary') } }, error),
        notice && h('p', { role: 'status', style: { ...message, color: muted } }, notice),
        live && interactive && !closed[id] && h('form', { style: { ...layout.fixed, padding: '12px 18px 10px', borderTop: border }, onSubmit: event => {
          event.preventDefault();
          const sent = text;
          act({ action: 'send', jobId: id, text: sent }, () => {
            history.current = [...history.current, sent].slice(-100); historyIndex.current = history.current.length;
            setText(''); setNotice(t('sent'));
          });
        } }, h('label', { htmlFor: commandId, style: { ...field, marginBottom: 8 } }, t('input')),
        h('div', { style: { ...row, flexWrap: 'nowrap', gap: 8 } },
          h('div', { style: { ...row, flexWrap: 'nowrap', flex: 1, gap: 0, border: `1px solid ${token('border-l2')}`, borderRadius: 10, background: token('bg-base') } },
            h('span', { 'aria-hidden': true, style: { display: 'flex', paddingLeft: 12, color: muted } }, icon('chevron', 14)),
            h('input', { id: commandId, style: { ...input, flex: 1, border: 'none', background: 'transparent', paddingLeft: 6 }, value: text, disabled: busy, placeholder: t('placeholder'), autoComplete: 'off', spellCheck: false,
              onChange: e => setText(e.target.value), onKeyDown: event => {
                if (event.nativeEvent?.isComposing) return;
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                historyIndex.current = Math.max(0, Math.min(history.current.length, historyIndex.current + (event.key === 'ArrowUp' ? -1 : 1)));
                setText(history.current[historyIndex.current] ?? '');
              } })),
          h('button', { type: 'submit', disabled: busy, style: { ...button, ...primary, minHeight: 40, opacity: busy ? .45 : 1 } }, icon('send', 14), t('send'))),
        h('p', { style: { margin: '7px 0 0', color: muted, fontSize: 10 } }, t('history'))),
        live && !interactive && h('p', { style: { ...message, color: muted } }, t('readonly')),
        closed[id] && h('p', { style: { ...message, color: muted } }, t('stoppedInput')),
        live && h('footer', { style: { ...row, ...layout.fixed, justifyContent: 'flex-end', padding: '8px 18px', borderTop: border } },
          confirm !== id ? h(React.Fragment, null,
            interactive && !closed[id] && actionButton(t('eof'), () => act({ action: 'eof', jobId: id }, () => setClosed(value => ({ ...value, [id]: true }))), { disabled: busy, style: { border: 'none', background: 'transparent', color: muted } }),
            actionButton(t('stop'), () => setConfirm(id), { disabled: busy, kind: 'stop', style: { color: token('state-error-primary') } })) :
            h(React.Fragment, null, h('p', { style: { margin: 0, fontSize: 12, color: token('state-warn-primary'), flex: '1 1 260px', lineHeight: 1.5 } }, t('warning')),
              actionButton(t('cancel'), () => setConfirm(''), { disabled: busy }),
              actionButton(t('confirm'), () => act({ action: 'stop', jobId: id }, () => setConfirm('')), { disabled: busy, kind: 'stop', style: { color: token('state-error-primary') } }))))),
    !job && error && h('p', { role: 'alert', style: { ...message, color: token('state-error-primary') } }, error));
  }
  const visibility = createQolConsoleVisibility(ctx, props => h(ProcessView, { key: props.sessionId, sessionId: props.sessionId }), () => t('title'));
  function VisibilityBridge({ sessionId }) {
    const rows = React.useSyncExternalStore(fn => jobs.state.subscribe(fn), () => jobs.state.getSnapshot().rows[sessionId] ?? EMPTY_ROWS);
    React.useEffect(() => jobs.watchRows(sessionId), [sessionId]);
    React.useEffect(() => visibility.retain(rows.length > 0), [sessionId, rows.length > 0]);
    return null;
  }
  let bridge;
  function update() {
    const enabled = store.isEnabled('console');
    visibility.setEnabled(enabled);
    if (enabled && !bridge) bridge = ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions', id: 'harness-qol-console-visibility', order: 21,
    }, VisibilityBridge));
    else if (!enabled && bridge) { const remove = bridge; bridge = null; remove(); }
  }
  update();
  const unsubscribe = store.subscribe(update);
  return () => { unsubscribe(); visibility.dispose(); bridge?.(); };
}
