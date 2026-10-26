/* Concatenate inside the Client ModuleLoader factory, then call registerBtwClient(ctx, React).
 * Public commandview owner is { node: CommandNode }; node.args comes from command/run,
 * and node.outcome from command/done. The existing log owns all retained state.
 * No internal Harness imports, HTML injection, DOM access, or session-event folding.
 */
function qolBtwSafeHref(value) {
  if (typeof value !== 'string') return null;
  const href = value.trim().replace(/^<(.+)>$/, '$1');
  if (/[\u0000-\u0020\u007f]/u.test(href) || !/^(https?:\/\/|mailto:)/i.test(href)) return null;
  try {
    const parsed = new URL(href);
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}

// Intentionally limited Markdown: unrecognized syntax remains readable literal text.
// Text nodes are passed to React, never interpreted as HTML. Links are opt-in protocols.
function qolBtwInline(text) {
  const value = typeof text === 'string' ? text : '';
  const tokens = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\[\]\n]+)\]\(([^()[\]\s]+)\)/g;
  let end = 0;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > end) tokens.push({ kind: 'text', text: value.slice(end, match.index) });
    if (match[1] !== undefined) tokens.push({ kind: 'code', text: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: 'strong', text: match[2] });
    else {
      const href = qolBtwSafeHref(match[4]);
      tokens.push(href === null ? { kind: 'text', text: match[0] } : { kind: 'link', text: match[3], href });
    }
    end = pattern.lastIndex;
  }
  if (end < value.length) tokens.push({ kind: 'text', text: value.slice(end) });
  return tokens;
}

function qolBtwMarkdown(text) {
  const lines = (typeof text === 'string' ? text : '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  const fence = line => /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const list = line => /^\s{0,3}(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(line);
  const heading = line => /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
  const special = line => !line.trim() || fence(line) || list(line) || heading(line);
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const start = fence(line);
    if (start) {
      const body = [];
      index++;
      while (index < lines.length) {
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[index]);
        if (close && close[1][0] === start[1][0] && close[1].length >= start[1].length) { index++; break; }
        body.push(lines[index++]);
      }
      blocks.push({ kind: 'code', language: start[2].trim(), text: body.join('\n') });
      continue;
    }
    const title = heading(line);
    if (title) {
      blocks.push({ kind: 'heading', level: title[1].length, content: qolBtwInline(title[2]) });
      index++; continue;
    }
    const first = list(line);
    if (first) {
      const ordered = first[2] !== undefined;
      const items = [];
      while (index < lines.length) {
        const item = list(lines[index]);
        if (!item || (item[2] !== undefined) !== ordered) break;
        items.push(qolBtwInline(item[3])); index++;
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? Number(first[2]) : 1, items });
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && !special(lines[index])) paragraph.push(lines[index++]);
    blocks.push({ kind: 'paragraph', content: qolBtwInline(paragraph.join('\n')) });
  }
  return blocks;
}

function qolBtwPresentation(node) {
  const outcome = node?.outcome;
  let rawText = typeof outcome?.text === 'string'
    ? outcome.text.replace(/\r?\n(?:\r?\n)?— \/btw · [^\r\n]+ · снимок до события \d+\. Основная задача не прерывалась\.\s*$/u, '').trimEnd()
    : '';

  // Clean up any inline <think> tags from model thinking output
  if (rawText.includes('<think>') || rawText.includes('</think>')) {
    const thinkMatch = /<think>([\s\S]*?)<\/think>/i.exec(rawText);
    const outside = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (outside) {
      rawText = outside;
    } else if (thinkMatch) {
      rawText = thinkMatch[1].trim();
    } else {
      rawText = rawText.replace(/<\/?think>/gi, '').trim();
    }
  }

  return {
    question: typeof node?.args === 'string' && node.args.trim() ? node.args : null,
    state: outcome == null ? 'pending' : outcome.kind === 'error' ? 'error' : 'success',
    answer: rawText,
  };
}

function registerBtwClient(ctx, React, store) {
  const h = React.createElement;
  const namespace = 'harness-qol-btw';
  const dictionaries = {
    en: {
      title: 'Side question', readOnly: 'Read-only aside', question: 'Your question',
      missingQuestion: 'The question text was not recorded in this older command.',
      pending: 'Answering separately…', success: 'Side answer', error: 'Side question failed',
      emptyAnswer: 'The command finished without answer text.',
    },
    ru: {
      title: 'Вопрос в сторону', readOnly: 'Отдельно · только чтение', question: 'Ваш вопрос',
      missingQuestion: 'Текст вопроса не был записан в этой старой команде.',
      pending: 'Отвечаю отдельно…', success: 'Отдельный ответ', error: 'Не удалось ответить',
      emptyAnswer: 'Команда завершилась без текста ответа.',
    },
  };
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    ctx.effect(() => ctx.locale.register(namespace, language, dictionary));
  }
  const css = `
.hq-btw{box-sizing:border-box;min-width:0;max-width:100%;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:1.65;overflow-wrap:anywhere}
.hq-btw-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.hq-btw-title{font-weight:600}
.hq-btw-pill{display:inline-flex;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:99px;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);font-size:11px}
.hq-btw-caption{margin:0 0 4px;color:var(--dsw-alias-label-secondary);font-size:12px}
.hq-btw-question{margin:0;white-space:pre-wrap;font:inherit}
.hq-btw-answer{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.hq-btw-status{display:flex;align-items:center;gap:7px;margin:0 0 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hq-btw-status:before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.hq-btw[data-state=pending] .hq-btw-status:before{background:var(--dsw-alias-state-idle-primary)}
.hq-btw[data-state=error] .hq-btw-status{color:var(--dsw-alias-state-error-primary)}
.hq-btw[data-state=error] .hq-btw-status:before{background:var(--dsw-alias-state-error-primary)}
.hq-btw-prose{min-width:0;font:inherit}
.hq-btw-prose p{margin:0 0 12px;white-space:pre-wrap}
.hq-btw-prose ul,.hq-btw-prose ol{margin:0 0 12px;padding-left:24px}
.hq-btw-prose li{margin:4px 0;white-space:pre-wrap}
.hq-btw-prose h3{margin:12px 0 6px;font:inherit;font-weight:600}
.hq-btw-prose strong{font-weight:600}
.hq-btw-prose code{font-family:ui-monospace,monospace;font-size:.92em;padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2)}
.hq-btw-prose pre{box-sizing:border-box;max-width:100%;margin:0 0 12px;padding:10px 12px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);white-space:pre;font-size:13px;line-height:1.5}
.hq-btw-prose pre code{padding:0;font-size:inherit}
.hq-btw-prose a{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:2px}
.hq-btw-prose a:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
`;
  function inline(tokens) {
    return tokens.map((token, key) => {
      if (token.kind === 'code') return h('code', { key }, token.text);
      if (token.kind === 'strong') return h('strong', { key }, token.text);
      if (token.kind === 'link') return h('a', { key, href: token.href, target: '_blank', rel: 'noopener noreferrer' }, token.text);
      return token.text;
    });
  }
  function Markdown({ text }) {
    const blocks = React.useMemo(() => qolBtwMarkdown(text), [text]);
    return h('div', { className: 'hq-btw-prose' }, ...blocks.map((block, key) => {
      if (block.kind === 'code') return h('pre', { key }, h('code', null, block.text));
      if (block.kind === 'heading') return h('h3', { key }, ...inline(block.content));
      if (block.kind === 'list') return h(block.ordered ? 'ol' : 'ul', { key, ...(block.ordered ? { start: block.start } : {}) },
        ...block.items.map((item, itemKey) => h('li', { key: itemKey }, ...inline(item))));
      return h('p', { key }, ...inline(block.content));
    }));
  }
  function BtwCard({ node, t }) {
    if (store && !store.isEnabled('btw')) return null;
    const view = qolBtwPresentation(node);
    return h('aside', { className: 'hq-btw', 'data-state': view.state, 'aria-label': t('title') },
      h('style', null, css),
      h('header', { className: 'hq-btw-header' }, h('span', { className: 'hq-btw-title' }, '/btw · ', t('title')),
        h('span', { className: 'hq-btw-pill' }, t('readOnly'))),
      h('p', { className: 'hq-btw-caption' }, t('question')),
      h('p', { className: 'hq-btw-question' }, view.question ?? t('missingQuestion')),
      h('div', { className: 'hq-btw-answer', 'aria-busy': view.state === 'pending' },
        h('p', { className: 'hq-btw-status', role: 'status', 'aria-live': 'polite' }, t(view.state)),
        view.answer ? h(Markdown, { text: view.answer }) : view.state !== 'pending' ? h('p', { className: 'hq-btw-caption' }, t('emptyAnswer')) : null));
  }

  let dispose = null;
  function update() {
    const enabled = !store || store.isEnabled('btw');
    if (enabled && !dispose) {
      dispose = ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
        name: 'conversation.chat.commandview', key: 'btw', locale: namespace,
      }, BtwCard));
    } else if (!enabled && dispose) {
      dispose();
      dispose = null;
    }
  }
  update();
  const unsub = store?.subscribe ? store.subscribe(update) : null;
  return () => {
    if (unsub) unsub();
    if (dispose) dispose();
    dispose = null;
  };
}
