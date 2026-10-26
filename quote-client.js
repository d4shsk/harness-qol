// Harness-QOL Quote: highlight agent responses, quote via context menu, and add context to next prompt.
// Concatenate inside Client ModuleLoader factory, then call registerQuoteClient(ctx, React, t).

function formatQuoteMarkdown(quoteText, userDraft) {
  const quote = typeof quoteText === 'string' ? quoteText.trim() : '';
  if (!quote) return typeof userDraft === 'string' ? userDraft : '';
  const lines = quote.split(/\r?\n/).map(line => `> ${line}`).join('\n');
  const draft = typeof userDraft === 'string' ? userDraft.trim() : '';
  return draft ? `${lines}\n\n${draft}` : `${lines}\n\n`;
}

function truncateQuotePreview(text, maxLines = 2) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + '…';
  }
  return trimmed;
}

function splitQuoteAndText(text) {
  if (typeof text !== 'string') return null;
  const trimmedStart = text.trimStart();
  if (!trimmedStart.startsWith('>')) return null;

  const lines = text.split(/\r?\n/);
  const quoteLines = [];
  const bodyLines = [];
  let inQuote = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inQuote) {
      if (line.trimStart().startsWith('>')) {
        quoteLines.push(line.replace(/^\s*>\s?/, ''));
      } else if (line.trim() === '') {
        inQuote = false;
      } else {
        inQuote = false;
        bodyLines.push(line);
      }
    } else {
      bodyLines.push(line);
    }
  }

  if (quoteLines.length === 0) return null;

  return {
    quote: quoteLines.join('\n').trim(),
    body: bodyLines.join('\n').trim(),
  };
}

function clampMenuPosition(x, y, menuWidth = 160, menuHeight = 84, environment = globalThis) {
  const winWidth = environment.innerWidth || 1024;
  const winHeight = environment.innerHeight || 768;
  const safeX = Math.max(8, Math.min(x, winWidth - menuWidth - 8));
  const safeY = Math.max(8, Math.min(y, winHeight - menuHeight - 8));
  return { x: safeX, y: safeY };
}

function createQuoteStore() {
  const quotes = new Map();
  const listeners = new Set();
  let activeSessionId = null;

  return {
    get(sessionId) {
      return sessionId ? quotes.get(sessionId) || null : null;
    },
    set(sessionId, text) {
      if (!sessionId || !text) return;
      quotes.set(sessionId, text);
      listeners.forEach(fn => {
        try { fn(); } catch (_e) {}
      });
    },
    clear(sessionId) {
      if (!sessionId) return;
      if (quotes.delete(sessionId)) {
        listeners.forEach(fn => {
          try { fn(); } catch (_e) {}
        });
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getActiveSessionId() {
      return activeSessionId;
    },
    setActiveSessionId(id) {
      activeSessionId = id;
    },
  };
}

function createMenuStore() {
  let state = { open: false, x: 0, y: 0, text: '', sessionId: null };
  const listeners = new Set();

  return {
    get() {
      return state;
    },
    open(payload) {
      state = { open: true, ...payload };
      listeners.forEach(fn => {
        try { fn(); } catch (_e) {}
      });
    },
    close() {
      if (!state.open) return;
      state = { open: false, x: 0, y: 0, text: '', sessionId: null };
      listeners.forEach(fn => {
        try { fn(); } catch (_e) {}
      });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function getAssistantSelection(environment = globalThis) {
  const selection = environment.getSelection ? environment.getSelection() : null;
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString().trim();
  if (!text) return null;

  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const el = container?.nodeType === 1 ? container : container?.parentElement;
  if (!el) return null;

  const assistantEl = el.closest ? el.closest('[data-chat-flow-kind="assistant-step"], [data-slot="conversation.chat.node"][data-key="assistant-step"]') : null;
  if (!assistantEl) return null;

  return { text, assistantEl, range };
}

const qolQuoteStore = createQuoteStore();
const qolMenuStore = createMenuStore();

function registerQuoteClient(ctx, React, t, store) {
  const h = React.createElement;

  const css = `
.hq-quote-menu{position:fixed;z-index:10000;min-width:150px;max-width:calc(100vw - 16px);padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 6px 24px color-mix(in srgb,var(--dsw-alias-bg-base) 80%,transparent);pointer-events:auto}
.hq-quote-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer;user-select:none}
.hq-quote-menu-item:hover,.hq-quote-menu-item:focus-visible{background:var(--dsw-alias-bg-layer-2);outline:none}
.hq-quote-menu-icon{display:flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;color:var(--dsw-alias-brand-primary)}
.hq-quote-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,24px) * 2);max-width:var(--dsh-composer-card-max-width,768px);margin:0 auto 8px auto;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 2px 8px color-mix(in srgb,var(--dsw-alias-bg-base) 88%,transparent);overflow:hidden;animation:hqQuoteFade .12s ease-out}
@keyframes hqQuoteFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.hq-quote-dock-inner{display:flex;align-items:flex-start;padding:8px 12px;gap:10px}
.hq-quote-dock-bar{flex:none;width:3px;min-height:28px;align-self:stretch;background:var(--dsw-alias-brand-primary);border-radius:2px}
.hq-quote-dock-content{flex:1;min-width:0;cursor:text}
.hq-quote-dock-header{display:flex;align-items:center;gap:6px;margin-bottom:2px}
.hq-quote-dock-icon{display:flex;align-items:center;color:var(--dsw-alias-brand-primary);flex:none}
.hq-quote-dock-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--dsw-alias-brand-primary)}
.hq-quote-dock-text{font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;max-height:36px}
.hq-quote-dock-close{flex:none;display:flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary,#888);cursor:pointer;font-size:16px;line-height:1;transition:background .1s,color .1s}
.hq-quote-dock-close:hover,.hq-quote-dock-close:focus-visible{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);outline:none}
.hq-user-quote-bubble{display:flex;flex-direction:column;gap:8px;width:100%}
.hq-user-quote-bubble-card{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border-radius:var(--dsw-radius-sm,6px);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 65%,transparent);border-left:3px solid var(--dsw-alias-brand-primary);font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.hq-user-quote-bubble-content{flex:1;min-width:0}
.hq-user-quote-bubble-header{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--dsw-alias-brand-primary);margin-bottom:2px}
.hq-user-quote-bubble-text{white-space:pre-wrap;word-break:break-word;max-height:140px;overflow-y:auto}
.hq-user-quote-bubble-body{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}
.hq-user-text-plain{white-space:pre-wrap;word-break:break-word}
`;

  const tagId = 'harness-qol-quote';
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = '@local/harness-qol';
    tag.dataset.pluginCss = tagId;
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // Quote SVG icon definition (reusable)
  const QuoteIcon = () => h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'currentColor' },
    h('path', { d: 'M3.5 12h2l1.5-3V4H2v5h2zm7 0h2l1.5-3V4H9v5h2z' })
  );

  // Copy SVG icon definition (reusable)
  const CopyIcon = () => h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'currentColor' },
    h('path', { d: 'M4 2h8a1 1 0 0 1 1 1v1H3V3a1 1 0 0 1 1-1zm-2 3h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v5h10V7H3z' })
  );

  // Floating Context Menu in shell.overlay
  function QuoteContextMenu() {
    const [menu, setMenu] = React.useState(() => qolMenuStore.get());
    const menuRef = React.useRef(null);
    const firstButton = React.useRef(null);

    React.useEffect(() => {
      return qolMenuStore.subscribe(() => {
        setMenu(qolMenuStore.get());
      });
    }, []);

    React.useLayoutEffect(() => {
      if (menu.open) {
        firstButton.current?.focus();
      }
    }, [menu.open]);

    React.useEffect(() => {
      if (!menu.open) return;

      const handlePointerDown = (e) => {
        if (!menuRef.current?.contains(e.target)) {
          qolMenuStore.close();
        }
      };

      const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          qolMenuStore.close();
        }
      };

      const handleDismiss = () => {
        qolMenuStore.close();
      };

      window.addEventListener('pointerdown', handlePointerDown, true);
      window.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('scroll', handleDismiss, true);
      window.addEventListener('resize', handleDismiss);

      return () => {
        window.removeEventListener('pointerdown', handlePointerDown, true);
        window.removeEventListener('keydown', handleKeyDown, true);
        window.removeEventListener('scroll', handleDismiss, true);
        window.removeEventListener('resize', handleDismiss);
      };
    }, [menu.open]);

    if (!menu.open || (store && !store.isEnabled('quote'))) return null;

    const handleQuote = (e) => {
      e.stopPropagation();
      const targetSession = menu.sessionId || qolQuoteStore.getActiveSessionId();
      if (targetSession && menu.text) {
        qolQuoteStore.set(targetSession, menu.text);
      }
      qolMenuStore.close();
      try {
        const sel = window.getSelection();
        if (sel) sel.removeAllRanges();
      } catch (_e) {}
      setTimeout(() => {
        const editor = document.querySelector('[data-composer-card] [contenteditable]');
        if (editor) editor.focus();
      }, 20);
    };

    const handleCopy = (e) => {
      e.stopPropagation();
      const text = menu.text;
      qolMenuStore.close();
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
    };

    return h('div', {
      ref: menuRef,
      className: 'hq-quote-menu',
      role: 'menu',
      'aria-label': t('quote.title'),
      style: { left: menu.x, top: menu.y },
      onClick: (e) => e.stopPropagation(),
      onContextMenu: (e) => e.preventDefault(),
    },
      h('button', {
        ref: firstButton,
        type: 'button',
        role: 'menuitem',
        className: 'hq-quote-menu-item',
        onClick: handleQuote,
      },
        h('span', { className: 'hq-quote-menu-icon', 'aria-hidden': true }, h(QuoteIcon, null)),
        h('span', null, t('quote.action'))
      ),
      h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'hq-quote-menu-item',
        onClick: handleCopy,
      },
        h('span', { className: 'hq-quote-menu-icon', 'aria-hidden': true }, h(CopyIcon, null)),
        h('span', null, t('quote.copy'))
      )
    );
  }

  // Visual Quote Dock rendered in conversation.input.dock right above the composer card
  function QuoteDock(props) {
    if (store && !store.isEnabled('quote')) return null;
    const sessionId = props.sessionId;
    const [quote, setQuote] = React.useState(() => qolQuoteStore.get(sessionId));

    React.useEffect(() => {
      if (sessionId) {
        qolQuoteStore.setActiveSessionId(sessionId);
      }
      setQuote(qolQuoteStore.get(sessionId));
      return qolQuoteStore.subscribe(() => {
        setQuote(qolQuoteStore.get(sessionId));
      });
    }, [sessionId]);

    // Keep submit interception listeners registered for the active session
    React.useEffect(() => {
      if (!sessionId || !props.inputActions) return;

      const applyQuoteIfActive = () => {
        if (store && !store.isEnabled('quote')) return false;
        const activeQuote = qolQuoteStore.get(sessionId);
        if (!activeQuote) return false;
        const editor = document.querySelector('[data-composer-card] [contenteditable]');
        const currentText = editor ? (editor.innerText || editor.textContent || '') : '';
        const finalDraft = formatQuoteMarkdown(activeQuote, currentText);
        props.inputActions.setDraft(finalDraft);
        qolQuoteStore.clear(sessionId);
        return true;
      };

      const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          const target = e.target;
          if (target?.closest?.('[data-composer-card]')) {
            applyQuoteIfActive();
            const editor = target.closest('[data-composer-card]')?.querySelector('[contenteditable]');
            const currentText = editor ? (editor.innerText || editor.textContent || '') : '';
            if (currentText.trimStart().startsWith('/')) {
              setTimeout(() => {
                props.inputActions?.setDraft('');
              }, 20);
            }
          }
        }
      };

      const handlePointerDown = (e) => {
        const target = e.target;
        const btn = target?.closest?.('button');
        if (btn && btn.closest?.('[data-composer-card]')) {
          const isSendButton = btn.querySelector('svg') || /send|отправить/i.test(btn.getAttribute('aria-label') || '');
          if (isSendButton) {
            applyQuoteIfActive();
            const card = btn.closest('[data-composer-card]');
            const editor = card?.querySelector('[contenteditable]');
            const currentText = editor ? (editor.innerText || editor.textContent || '') : '';
            if (currentText.trimStart().startsWith('/')) {
              setTimeout(() => {
                props.inputActions?.setDraft('');
              }, 20);
            }
          }
        }
      };

      window.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('pointerdown', handlePointerDown, true);

      return () => {
        window.removeEventListener('keydown', handleKeyDown, true);
        window.removeEventListener('pointerdown', handlePointerDown, true);
      };
    }, [sessionId, props.inputActions]);

    if (!quote) return null;

    const onClose = (e) => {
      e.stopPropagation();
      e.preventDefault();
      qolQuoteStore.clear(sessionId);
      const editor = document.querySelector('[data-composer-card] [contenteditable]');
      if (editor) editor.focus();
    };

    const onClickCard = () => {
      const editor = document.querySelector('[data-composer-card] [contenteditable]');
      if (editor) editor.focus();
    };

    const preview = truncateQuotePreview(quote, 2);

    return h('div', {
      className: 'hq-quote-dock',
      role: 'region',
      'aria-label': t('quote.title'),
      onClick: onClickCard,
    },
      h('div', { className: 'hq-quote-dock-inner' },
        h('div', { className: 'hq-quote-dock-bar', 'aria-hidden': true }),
        h('div', { className: 'hq-quote-dock-content' },
          h('div', { className: 'hq-quote-dock-header' },
            h('span', { className: 'hq-quote-dock-icon', 'aria-hidden': true }, h(QuoteIcon, null)),
            h('span', { className: 'hq-quote-dock-title' }, t('quote.title'))
          ),
          h('div', { className: 'hq-quote-dock-text', title: quote }, preview)
        ),
        h('button', {
          type: 'button',
          className: 'hq-quote-dock-close',
          title: t('quote.remove'),
          'aria-label': t('quote.remove'),
          onClick: onClose,
        }, '×')
      )
    );
  }

  // Styled renderer for user message text in chat bubbles
  function QolUserTextNode({ node, raw }) {
    const text = node?.data?.display ?? node?.data?.text ?? raw ?? '';
    if (store && !store.isEnabled('quote')) {
      return h('span', { className: 'hq-user-text-plain' }, text);
    }
    const parsed = splitQuoteAndText(text);

    if (!parsed) {
      return h('span', { className: 'hq-user-text-plain' }, text);
    }

    return h('div', { className: 'hq-user-quote-bubble' },
      h('div', { className: 'hq-user-quote-bubble-card' },
        h('div', { className: 'hq-user-quote-bubble-content' },
          h('div', { className: 'hq-user-quote-bubble-header' },
            h('span', { className: 'hq-quote-dock-icon', 'aria-hidden': true }, h(QuoteIcon, null)),
            h('span', null, t('quote.title'))
          ),
          h('div', { className: 'hq-user-quote-bubble-text' }, parsed.quote)
        )
      ),
      parsed.body && h('div', { className: 'hq-user-quote-bubble-body' }, parsed.body)
    );
  }

  // Register slots
  let disposers = [];
  function update() {
    const enabled = !store || store.isEnabled('quote');
    if (enabled && disposers.length === 0) {
      const d1 = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'harness-qol-quote-menu',
      }, QuoteContextMenu));

      const d2 = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'harness-qol-quote-dock',
        order: 25,
      }, QuoteDock));

      const d3 = ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
        name: 'conversation.user.text.node',
        key: 'text',
        priority: 0,
      }, QolUserTextNode));
      disposers = [d1, d2, d3];
    } else if (!enabled && disposers.length > 0) {
      for (const d of disposers.reverse()) d();
      disposers = [];
    }
  }

  update();
  const unsub = store?.subscribe ? store.subscribe(update) : null;

  // Global event listener for context menu on assistant message selection
  ctx.effect(() => {
    const onContextMenu = (event) => {
      if (store && !store.isEnabled('quote')) return;
      const sel = getAssistantSelection();
      if (!sel) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const targetAssistant = target.closest('[data-chat-flow-kind="assistant-step"], [data-slot="conversation.chat.node"][data-key="assistant-step"]');
      if (!targetAssistant && !sel.assistantEl.contains(target)) return;

      event.preventDefault();
      event.stopPropagation();

      const pos = clampMenuPosition(event.clientX, event.clientY);
      qolMenuStore.open({
        x: pos.x,
        y: pos.y,
        text: sel.text,
        sessionId: qolQuoteStore.getActiveSessionId(),
      });
    };

    const onKeyDown = (event) => {
      if (store && !store.isEnabled('quote')) return;
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        const sel = getAssistantSelection();
        if (!sel) return;

        event.preventDefault();
        event.stopPropagation();

        const rect = sel.range.getBoundingClientRect();
        const pos = clampMenuPosition(rect.left + rect.width / 2, rect.bottom);
        qolMenuStore.open({
          x: pos.x,
          y: pos.y,
          text: sel.text,
          sessionId: qolQuoteStore.getActiveSessionId(),
        });
      }
    };

    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  });

  return () => {
    if (unsub) unsub();
    for (const d of disposers.reverse()) d();
    disposers = [];
  };
}
