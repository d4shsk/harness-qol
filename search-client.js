// Harness-QOL: ephemeral, current-transcript find. No session-log or DOM mutations.
// Concatenate inside the Client ModuleLoader factory.
function qolIsFindShortcut(event) {
  return !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 &&
    !event.altKey && !event.shiftKey && (event.metaKey || event.ctrlKey) &&
    (event.code === 'KeyF' || String(event.key).toLowerCase() === 'f');
}

function qolFindTextMatches(text, query) {
  if (!query.trim()) return [];
  // Unicode regex preserves original UTF-16 offsets (lowercasing İ does not).
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(text.matchAll(new RegExp(literal, 'giu')), match => ({
    start: match.index, end: match.index + match[0].length,
  }));
}

function qolMoveSearchIndex(index, count, direction) {
  return count ? ((index + direction) % count + count) % count : -1;
}

// Read rendered text only, including the Host's stable hidden-until-found rows.
// The semantic Chat markers keep controls, composer, sidebar and other chats out.
function qolCollectSearchText(root) {
  const groups = [];
  let current;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.nodeValue || parent.closest('button, input, textarea, select, script, style, [aria-hidden="true"], [contenteditable="true"]')) continue;
    const hidden = parent.closest('[hidden]:not([hidden="until-found"])');
    if (hidden) continue;
    const row = parent.closest('[data-chat-node-key], [data-chat-flow-key]');
    if (!row || !root.contains(row)) continue;
    const block = parent.closest('p, pre, li, td, th, h1, h2, h3, h4, h5, h6, div');
    if (!current || current.row !== row) {
      current = { row, text: '', parts: [], block };
      groups.push(current);
    } else if (current.block !== block) {
      current.text += '\n';
      current.block = block;
    }
    const start = current.text.length;
    current.text += node.nodeValue;
    current.parts.push({ node, start, end: current.text.length });
  }
  return groups;
}

function qolSearchRanges(groups, query, doc) {
  const matches = [];
  for (const group of groups) {
    for (const { start, end } of qolFindTextMatches(group.text, query)) {
      const first = group.parts.find(part => part.end > start);
      const last = group.parts.find(part => part.end >= end);
      if (!first || !last) continue;
      const range = doc.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      matches.push({ range, row: group.row,
        preview: group.text.slice(Math.max(0, start - 45), Math.min(group.text.length, end + 65)).replace(/\s+/g, ' ') });
    }
  }
  return matches;
}

async function qolLoadSearchHistory(binding, cancelled) {
  while (!cancelled() && binding.session.getSnapshot().hasMore) {
    const revision = binding.eventSource.getSnapshot().revision;
    await binding.session.loadOlder();
    if (cancelled()) return;
    // A refused/failed page must not turn into an unbounded retry loop.
    if (binding.session.getSnapshot().hasMore && binding.eventSource.getSnapshot().revision === revision) {
      throw new Error('History page did not advance');
    }
  }
}

function createQolSearchOverlayStore() {
  let target = null;
  const listeners = new Set();
  const publish = value => { target = value; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => target,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    attach(element) {
      publish(element);
      return () => { if (target === element) publish(null); };
    },
  };
}

function registerSearchClient(ctx, React, ReactDOM) {
  const h = React.createElement;
  const overlay = createQolSearchOverlayStore();
  function SearchOverlayTarget() {
    const ref = React.useRef(null);
    React.useEffect(() => overlay.attach(ref.current), []);
    // Only the compact panel accepts pointer events; the rest stays click-through.
    return h('div', { ref, 'data-hq-search-overlay': true, style: {
      position: 'fixed', top: 'max(84px, env(safe-area-inset-top))',
      right: 'max(16px, env(safe-area-inset-right))',
      width: 'min(420px, calc(100vw - 32px))', pointerEvents: 'none',
    } });
  }
  const ns = 'harness-qol-search';
  for (const [language, dictionary] of Object.entries({
    en: { title: 'Find in this chat', placeholder: 'Find in this chat…', previous: 'Previous match (Shift+Enter)', next: 'Next match (Enter)', close: 'Close search (Esc)', empty: 'No matches', count: '{current} of {total}', loading: 'Loading older messages…', failed: 'Could not load all history. Results may be incomplete.', retry: 'Retry', hint: 'Enter / Shift+Enter · Esc' },
    ru: { title: 'Поиск в текущем чате', placeholder: 'Найти в этом чате…', previous: 'Предыдущее совпадение (Shift+Enter)', next: 'Следующее совпадение (Enter)', close: 'Закрыть поиск (Esc)', empty: 'Совпадений нет', count: '{current} из {total}', loading: 'Загружаются старые сообщения…', failed: 'Не удалось загрузить всю историю. Результаты могут быть неполными.', retry: 'Повторить', hint: 'Enter / Shift+Enter · Esc' },
  })) ctx.effect(() => ctx.locale.register(ns, language, dictionary));
  const t = ctx.locale.bind(ns);

  function SearchPanel(props) {
    const [enabled, setEnabled] = React.useState(() => qolModulesStore.isEnabled('search'));
    const [open, setOpen] = React.useState(false);
    const [focusVersion, setFocusVersion] = React.useState(0);
    const anchor = React.useRef(null);
    const panel = React.useRef(null);
    const target = React.useSyncExternalStore(overlay.subscribe, overlay.getSnapshot);
    const previousFocus = React.useRef(null);
    React.useEffect(() => qolModulesStore.subscribe(() => {
      const next = qolModulesStore.isEnabled('search');
      setEnabled(next);
      if (!next) setOpen(false);
    }), []);
    const close = React.useCallback(() => {
      setOpen(false);
      if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    }, []);
    React.useEffect(() => { setOpen(false); previousFocus.current = null; }, [props.sessionId]);
    React.useEffect(() => {
      if (!enabled) return;
      const onKeyDown = event => {
        if (open && event.key === 'Escape' && !event.isComposing && panel.current?.contains(document.activeElement)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          close();
          return;
        }
        if (!qolIsFindShortcut(event)) return;
        const scroll = anchor.current?.closest('[data-conversation-scroll]');
        if (!scroll?.getClientRects().length || !scroll.querySelector('[data-chat-flow]')) return;
        // Leave native find alone in a separate dialog/editor or non-Chat view.
        const dialog = document.activeElement?.closest('[role="dialog"], [aria-modal="true"]');
        if (dialog && !dialog.contains(anchor.current)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!open) previousFocus.current = document.activeElement;
        setOpen(true);
        setFocusVersion(value => value + 1);
      };
      window.addEventListener('keydown', onKeyDown, true);
      return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [enabled, open, close]);
    return h('div', { ref: anchor, 'data-hq-search-seat': props.sessionId, style: { display: 'contents' } },
      enabled && open && target ? ReactDOM.createPortal(
        h(SearchContents, { ...props, key: props.sessionId, anchor, panel, close, focusVersion }), target,
      ) : null);
  }

  function SearchContents({ sessionId, useChat, anchor, panel, close, focusVersion }) {
    // Subscribe only while open. The Conversation projection owns live revisions;
    // no MutationObserver, timer, raw-event fold or global transcript scan.
    const chat = useChat(snapshot => snapshot);
    const [query, setQuery] = React.useState('');
    const [matches, setMatches] = React.useState([]);
    const [index, setIndex] = React.useState(0);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(false);
    const [retry, setRetry] = React.useState(0);
    const input = React.useRef(null);
    const names = React.useId().replace(/[^a-zA-Z0-9]/g, '');
    const allName = `hq-find-${names}`;
    const activeName = `${allName}-active`;
    const doc = anchor.current.ownerDocument;
    const highlights = doc.defaultView.CSS?.highlights;
    const HighlightClass = doc.defaultView.Highlight;
    React.useEffect(() => {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }, [focusVersion]);
    const hasQuery = !!query.trim();
    React.useEffect(() => {
      if (!hasQuery) return;
      const binding = ctx.sessions.binding(sessionId);
      if (!binding) { setError(true); return; }
      let cancelled = false;
      setLoading(binding.session.getSnapshot().hasMore);
      setError(false);
      qolLoadSearchHistory(binding, () => cancelled).catch(() => {
        if (!cancelled) setError(true);
      }).finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }, [sessionId, hasQuery, retry]);
    React.useEffect(() => {
      const frame = doc.defaultView.requestAnimationFrame(() => {
        const root = anchor.current?.closest('[data-conversation-scroll]')?.querySelector('[data-chat-flow]');
        const next = root && hasQuery ? qolSearchRanges(qolCollectSearchText(root), query, doc) : [];
        setMatches(next);
        setIndex(value => Math.min(value, Math.max(0, next.length - 1)));
        if (highlights && HighlightClass) {
          const highlight = new HighlightClass();
          for (const match of next) highlight.add(match.range);
          highlights.set(allName, highlight);
        }
      });
      return () => { doc.defaultView.cancelAnimationFrame(frame); highlights?.delete(allName); };
    }, [chat, query, hasQuery, loading, allName]);
    React.useEffect(() => {
      const match = matches[index];
      if (!match) { highlights?.delete(activeName); return; }
      if (highlights && HighlightClass) highlights.set(activeName, new HighlightClass(match.range));
      // Ask the Host's own disclosure callbacks to reveal until-found content.
      // Never remove hidden attributes or rewrite another component's text.
      const hidden = [];
      for (let element = match.range.startContainer.parentElement; element; element = element.parentElement) {
        if (element.getAttribute('hidden') === 'until-found') hidden.unshift(element);
      }
      for (const element of hidden) element.dispatchEvent(new doc.defaultView.Event('beforematch'));
      const frame = doc.defaultView.requestAnimationFrame(() => {
        if (!match.row.isConnected) return;
        const scroll = anchor.current?.closest('[data-conversation-scroll]');
        if (!scroll) return;
        const rect = match.range.getBoundingClientRect();
        const viewport = scroll.getBoundingClientRect();
        // A beforematch intent also interrupts streaming auto-follow in Chat.
        match.row.dispatchEvent(new doc.defaultView.Event('beforematch', { bubbles: true }));
        scroll.scrollBy({ top: rect.top - viewport.top - viewport.height / 2, behavior: 'instant' });
      });
      return () => { doc.defaultView.cancelAnimationFrame(frame); highlights?.delete(activeName); };
    }, [matches, index, activeName]);
    const move = direction => setIndex(value => qolMoveSearchIndex(value, matches.length, direction));
    const button = (label, glyph, onClick, disabled = false) => h('button', { type: 'button', title: label, 'aria-label': label, disabled, onClick }, glyph);
    return h('section', { ref: panel, className: 'hq-find', role: 'search', 'aria-label': t('title'), onKeyDown: event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Enter' && event.target === input.current) { event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1); }
    } },
      h('style', null, `.hq-find{box-sizing:border-box;width:100%;pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);font:inherit}.hq-find-row{display:flex;align-items:center;gap:4px}.hq-find input{box-sizing:border-box;width:0;min-width:0;flex:1;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;padding:5px 8px;outline:none}.hq-find button{display:grid;place-items:center;flex-shrink:0;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:16px}.hq-find button:hover{background:var(--dsw-alias-bg-layer-2)}.hq-find button:disabled{opacity:.4;cursor:default}.hq-find button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}.hq-find:focus-within{border-color:var(--dsw-alias-brand-primary)}.hq-find-count{font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}.hq-find-status{font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 6px;overflow-wrap:anywhere}.hq-find-status button{display:inline;width:auto;font:inherit;text-decoration:underline}::highlight(${allName}){background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}::highlight(${activeName}){background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}`),
      h('div', { className: 'hq-find-row' },
        h('input', { ref: input, type: 'text', value: query, placeholder: t('placeholder'), 'aria-label': t('title'), onChange: event => { setQuery(event.target.value); setIndex(0); } }),
        h('span', { className: 'hq-find-count', role: 'status', 'aria-live': 'polite' }, !hasQuery ? '' : matches.length ? t('count', { current: index + 1, total: matches.length }) : loading ? '…' : t('empty')),
        button(t('previous'), '↑', () => move(-1), !matches.length),
        button(t('next'), '↓', () => move(1), !matches.length),
        button(t('close'), '×', close)),
      loading ? h('div', { className: 'hq-find-status', role: 'status' }, t('loading')) : null,
      error ? h('div', { className: 'hq-find-status', role: 'alert' }, t('failed'), ' ', h('button', { type: 'button', onClick: () => setRetry(value => value + 1) }, t('retry'))) : null);
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'harness-qol-search-overlay', order: 24,
  }, SearchOverlayTarget));
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'harness-qol-search', order: 24,
  }, SearchPanel));
}
