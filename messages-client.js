// Harness-QOL: Message editing for already sent messages in chat and queued messages in composer.
// Concatenate inside the Client ModuleLoader factory.

function createMessageEditsClientStore() {
  // The durable Session log is authoritative; old localStorage edits were only
  // cosmetic and must never masquerade as edits to the model's context.
  const state = {};
  const regenerations = {};

  const listeners = new Set();
  const notify = () => {
    listeners.forEach(fn => {
      try { fn(state); } catch (_e) {}
    });
  };

  return {
    get(sessionId, key) {
      if (!sessionId || key === undefined || key === null) return undefined;
      return state[sessionId]?.[String(key)];
    },
    has(sessionId, key) {
      if (!sessionId || key === undefined || key === null) return false;
      return typeof state[sessionId]?.[String(key)] === 'string';
    },
    set(sessionId, key, text) {
      if (!sessionId || key === undefined || key === null) return;
      if (!state[sessionId]) state[sessionId] = {};
      state[sessionId][String(key)] = String(text);
      notify();
    },
    remove(sessionId, key) {
      if (!sessionId || key === undefined || key === null) return;
      if (state[sessionId] && state[sessionId][String(key)] !== undefined) {
        delete state[sessionId][String(key)];
        notify();
      }
    },
    replace(sessionId, edits, ranges) {
      state[sessionId] = { ...edits };
      if (ranges !== undefined) regenerations[sessionId] = ranges;
      notify();
    },
    getRegenerations(sessionId) {
      return regenerations[sessionId] || [];
    },
    getAllForSession(sessionId) {
      return state[sessionId] ? { ...state[sessionId] } : {};
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const qolMessageEditsStore = createMessageEditsClientStore();

function qolExtractMessageText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
}

function qolExtractAttachments(content) {
  if (!Array.isArray(content)) return [];
  const list = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'image' && block.attachment) {
      list.push({ type: 'image', attachment: block.attachment });
    } else if (block.type === 'file' && block.attachment) {
      list.push({ type: 'file', attachment: block.attachment });
    }
  }
  return list;
}

// Presentation contract of conversation.chat.user.content, not Message content blocks.
// Images wrap a MessageImageSource; files use `file`. Passing raw attachments
// makes UserContent hand an undefined image to the gallery (or file to its card).
function qolPrepareUserContent(content, text = qolExtractMessageText(content), referenceLabels) {
  const attachments = [];
  const extraBlocks = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') continue;
    if (block?.type === 'image' && block.attachment) {
      attachments.push({ type: 'image', image: { attachment: block.attachment } });
    } else if (block?.type === 'file' && block.attachment) {
      attachments.push({ type: 'file', file: block.attachment });
    } else {
      extraBlocks.push(block);
    }
  }
  return { text, attachments, extraBlocks,
    ...(referenceLabels === undefined ? {} : { referenceLabels }) };
}

function qolBuildEditedContent(originalContent, newText) {
  const otherBlocks = Array.isArray(originalContent)
    ? originalContent.filter(b => b && b.type !== 'text')
    : [];
  return [{ type: 'text', text: newText }, ...otherBlocks];
}

// Use the retained Session face, not former per-slot callback props. This also
// preserves the controller's routing for continuable child Sessions.
async function qolUpdateQueue(ctx, sessionId, itemId, action) {
  const session = ctx.sessions?.binding(sessionId)?.session;
  if (!session) throw new Error('Queue unavailable / Очередь сообщений недоступна.');
  const reply = await session.updateQueue(itemId, action);
  if (reply?.ok !== true || reply.value?.accepted !== true) {
    throw new Error(reply?.error?.message || 'Queue update failed / Не удалось изменить очередь.');
  }
}

function qolSelectQueue(inbox, pendingSubmissions) {
  const submissions = pendingSubmissions || [];
  const inChat = new Set(submissions.filter(item => item.placement === 'transcript').map(item => item.requestId));
  const queue = (inbox?.['next-turn'] || []).filter(({ source }) =>
    source?.kind !== 'user' || !('rpcId' in source) || !inChat.has(source.rpcId));
  const admitted = new Set(queue.flatMap(({ source }) =>
    source?.kind === 'user' && 'rpcId' in source ? [source.rpcId] : []));
  const pending = submissions.filter(item => item.placement === 'queued' && !admitted.has(item.requestId));
  return [...queue, ...pending.map(item => ({
    id: item.requestId,
    pending: true,
    content: [
      { type: 'text', text: item.text },
      ...item.attachments.map(attachment => ({ type: attachment.type, attachment: attachment.value })),
    ],
  }))];
}

async function qolExecuteMessageCommand(ctx, sessionId, request) {
  const scope = ctx.sessions ? ctx.sessions.scope(sessionId) : null;
  if (!scope || !scope.remote || !scope.remote.commands) {
    throw new Error('Commands unavailable for session / Команды недоступны для этой сессии.');
  }
  const reply = await scope.remote.commands.execute('/harness-qol-message-edit ' + JSON.stringify(request), []);
  if (reply?.ok === false) throw new Error(reply.error?.message ?? 'Command failed');
  const execution = reply?.ok === true ? reply.value : reply;
  const result = execution?.result;
  if (result?.kind === 'error') {
    let message = result.text || 'Command failed';
    try { message = JSON.parse(message).error || message; } catch (_e) {}
    throw new Error(message);
  }
  if (!result?.text) throw new Error('Command returned no result / Команда не вернула результат.');
  const parsed = JSON.parse(result.text);
  if (!parsed.ok) throw new Error(parsed.error || 'Command failed');
  return parsed.data;
}

function qolSentMessageIdentity(ctx, sessionId, node) {
  const data = node?.data || {};
  // Chat nodes expose anchorSeq and data.seq, NOT a top-level seq. Their id
  // is the durable message identity even before the event feed catches up.
  const seq = [data.seq, node?.anchorSeq, node?.seq].find(value => Number.isSafeInteger(value) && value >= 0);
  const event = seq === undefined ? undefined : ctx.sessions?.binding(sessionId)?.eventSource?.getSnapshot().entries
    ?.find(item => item.event?.seq === seq)?.event;
  const messageId = data.messageId ?? data.id ?? node?.id ?? event?.data?.id;
  return { seq, messageId: typeof messageId === 'string' && messageId ? messageId : undefined };
}

async function qolSaveSentMessage(ctx, sessionId, seq, messageId, text, generate = false) {
  if (seq === undefined && !messageId) throw new Error('Message is still sending / Сообщение ещё отправляется.');
  const result = await qolExecuteMessageCommand(ctx, sessionId, {
    action: 'edit_sent', sessionId, seq, messageId, text, ...(generate ? { generate: true } : {}),
  });
  if (result?.applied !== true) {
    throw new Error('Restart Harness to update the message editor / Перезапустите Harness для обновления редактора.');
  }
  qolMessageEditsStore.replace(sessionId, result.edits, result.regenerations);
  return result;
}

async function qolCreateEditedChat(ctx, sessionId, seq, messageId, text, attempt) {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Message boundary unavailable / Граница сообщения недоступна.');
  // Read through ctx.get: direct ctx.<service> access throws "without inject"
  // for anything not declared on the module, which used to kill the whole boot.
  const uiWorkspace = ctx.get?.('uiWorkspace');
  if (!ctx.sessions?.fork || !ctx.sessions?.using || !uiWorkspace?.openSession) {
    throw new Error('New chat unavailable / Создание нового чата недоступно.');
  }
  if (!attempt.inheritedEdits) {
    const snapshot = await qolExecuteMessageCommand(ctx, sessionId, { action: 'get_edits', sessionId });
    if (snapshot?.applied !== true) {
      throw new Error('Restart Harness to update the message editor / Перезапустите Harness для обновления редактора.');
    }
    attempt.inheritedEdits = snapshot.edits || {};
  }
  // Remember even a partially created fork, so retrying a failed edit/rename
  // cannot quietly create another duplicate chat.
  if (!attempt.childId) {
    attempt.childId = await ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true,
      onCreated: childId => { attempt.childId = childId; } });
  }
  await ctx.sessions.using(attempt.childId, { source: 'reference' }, async () => {
    // A historical fork cut precedes edits made later in the audit log, even
    // when they concern earlier messages. Carry those visible prefix edits too.
    for (const [key, editedText] of Object.entries(attempt.inheritedEdits)) {
      const earlierSeq = Number(key);
      if (Number.isSafeInteger(earlierSeq) && String(earlierSeq) === key && earlierSeq >= 0 && earlierSeq < seq) {
        await qolSaveSentMessage(ctx, attempt.childId, earlierSeq, undefined, editedText);
      }
    }
    await qolSaveSentMessage(ctx, attempt.childId, seq, messageId, text);
    uiWorkspace.openSession(attempt.childId);
  });
  return attempt.childId;
}

// Focus must not ask the browser to reveal the top of a tall message editor.
function qolFocusEditor(element) {
  element?.focus({ preventScroll: true });
}

async function qolEditQueuedMessage(ctx, sessionId, row, text) {
  if (row.pending) throw new Error('Message is still sending / Сообщение ещё отправляется.');
  if (row.content.some(block => block && block.type !== 'text')) {
    // The native queue edit accepts text blocks only. Preserve all attachments
    // through the same Host operation used by the message-edit agent tool.
    return qolExecuteMessageCommand(ctx, sessionId, {
      action: 'edit_queue', sessionId, itemId: row.id, text,
    });
  }
  return qolUpdateQueue(ctx, sessionId, row.id, { kind: 'edit', content: [{ type: 'text', text }] });
}

// The dock slot spans the conversation column, not the composer card. Match
// the native Todo/Goal dock geometry and inherit the user's live width setting.
const qolQueueDockLayout = {
  width: 'calc(100% - var(--dsh-composer-side-clearance, 12px) - var(--dsh-composer-side-clearance, 12px) - var(--dsh-composer-dock-inset, 10px) - var(--dsh-composer-dock-inset, 10px) - var(--dsh-composer-dock-inset, 10px) - var(--dsh-composer-dock-inset, 10px))',
  maxWidth: 'calc(var(--dsh-composer-card-max-width, 720px) - var(--dsh-composer-dock-inset, 10px) - var(--dsh-composer-dock-inset, 10px) - var(--dsh-composer-dock-inset, 10px) - var(--dsh-composer-dock-inset, 10px))',
  minWidth: 0,
  boxSizing: 'border-box',
  flex: 'none',
  margin: '0 auto 8px',
};

// The normal Chat is an audit transcript, so surface replacements alone do
// not remove old answers there. Claim only superseded events for the Chat
// target; Trajectory/audit history and the native event source stay untouched.
function registerQolRegeneratedHistory(ctx, store = qolMessageEditsStore) {
  const hidden = new WeakSet();
  let disposeDefinition;
  let disposed = false;
  const getRegistry = () => ctx.get?.('uiConversation')?.events;
  const attach = registry => {
    if (!registry?.register || disposed) return;
    disposeDefinition?.();
    disposeDefinition = registry.register({
      kind: 'harness-qol-superseded-response', target: 'chat',
      match: event => hidden.has(event) || event.type === 'user/message' && event.data?.source?.kind === 'harness-qol-edit'
        ? { id: String(event.seq), role: 'start', exclusive: true } : null,
      start: () => null,
      update: context => context.state,
      buildViewNode: () => null,
    });
  };
  const initial = getRegistry();
  if (initial) attach(initial);
  ctx.inject?.(['uiConversation'], scope => {
    const reg = (scope.uiConversation || scope.get?.('uiConversation'))?.events;
    if (reg) attach(reg);
  });
  const refresh = () => {
    if (disposed) return;
    const reg = getRegistry();
    if (reg) attach(reg);
  };
  ctx.effect?.(() => () => { disposed = true; disposeDefinition?.(); });
  return {
    watch(sessionId, source) {
      if (!source) return () => {};
      const ranges = [];
      const keys = new Set();
      const absorb = range => {
        if (!range || !Number.isSafeInteger(range.startSeq) || !Number.isSafeInteger(range.endSeq) ||
            range.startSeq < 0 || range.endSeq < range.startSeq) return false;
        const key = `${range.startSeq}:${range.endSeq}`;
        if (keys.has(key)) return false;
        keys.add(key);
        ranges.push(range);
        return true;
      };
      const mark = entries => {
        let changed = false;
        for (const item of entries) {
          const event = item.event;
          if (event && !hidden.has(event) && ranges.some(range => event.seq >= range.startSeq && event.seq <= range.endSeq)) {
            hidden.add(event);
            changed = true;
          }
        }
        if (changed) refresh(); // A registry change reclassifies existing nodes, not only new events.
      };
      const complete = () => source.getSnapshot().entries || source.getSnapshot().change?.entries || [];
      const update = (initial = false) => {
        const entries = initial ? complete() : source.getSnapshot().change?.entries || [];
        let newRanges = false;
        for (const item of entries) newRanges = absorb(item.event?.data?.source?.qolRegeneration) || newRanges;
        for (const range of store.getRegenerations(sessionId)) newRanges = absorb(range) || newRanges;
        mark(newRanges || initial ? complete() : entries);
      };
      const stopSource = source.subscribe(() => update());
      const stopStore = store.subscribe(() => update());
      update(true);
      return () => { stopSource(); stopStore(); };
    },
  };
}

function createSentEditsSync(ctx, store = qolMessageEditsStore, history) {
  const sessions = new Map();
  return sessionId => {
    let entry = sessions.get(sessionId);
    if (!entry) {
      entry = { count: 0, alive: true, patches: {} };
      sessions.set(sessionId, entry);
      const source = ctx.sessions?.binding(sessionId)?.eventSource;
      entry.stopHistory = history?.watch(sessionId, source);
      const update = () => {
        for (const item of source?.getSnapshot().change.entries || []) {
          const event = item.event;
          if (event?.type === 'user/message' && event.surfaceOp?.op === 'replace' && event.data?.source?.kind === 'user') {
            const text = qolExtractMessageText(event.data.content);
            entry.patches[event.data.id] = text;
            store.set(sessionId, event.data.id, text);
          }
        }
      };
      entry.stop = source?.subscribe(update);
      update();
      entry.patches = {}; // Only changes arriving after the read starts can supersede it.
      // One Host read per mounted session, not one command per message bubble.
      qolExecuteMessageCommand(ctx, sessionId, { action: 'get_edits', sessionId }).then(result => {
        if (entry.alive && result?.applied === true) store.replace(sessionId, { ...result.edits, ...entry.patches });
      }).catch(() => {}); // Explicit saves report failures in the editor.
    }
    entry.count++;
    return () => {
      if (--entry.count === 0) {
        entry.alive = false;
        entry.stop?.();
        entry.stopHistory?.();
        sessions.delete(sessionId);
      }
    };
  };
}

function registerMessagesClient(ctx, React, modulesStore = qolModulesStore) {
  const h = React.createElement;
  const ns = 'harness-qol-messages';

  const dictionaries = {
    en: {
      'edit.action': 'Edit',
      'edit.title': 'Edit message',
      'edit.placeholder': 'Enter your message…',
      'edit.saveInPlace': 'Edit',
      'edit.newChat': 'New chat',
      'edit.branchHint': 'Copy history up to this message into a separate chat, with your edit.',
      'edit.busy': 'Wait for the response to finish before editing this chat.',
      'edit.saving': 'Saving…',
      'edit.creating': 'Creating…',
      'edit.cancel': 'Cancel',
      'edit.editedBadge': 'edited',
      'edit.attachmentsRetained': '{count} attachment(s) will be kept',
      'edit.failed': 'Could not save message edit.',
      'queue.title': 'Queued message',
      'queue.save': 'Save',
      'queue.cancel': 'Cancel',
      'queue.editTooltip': 'Edit queued message',
      'queue.removeTooltip': 'Remove from queue',
      'queue.steerTooltip': 'Send as steering',
      'queue.count': '{n} in queue',
      'queue.sending': 'Sending…',
      'queue.failed': 'Could not update queued message.',
      'queue.dismissError': 'Dismiss error',
    },
    ru: {
      'edit.action': 'Редактировать',
      'edit.title': 'Редактирование сообщения',
      'edit.placeholder': 'Введите текст сообщения…',
      'edit.saveInPlace': 'Редактировать',
      'edit.newChat': 'Новый чат',
      'edit.branchHint': 'Скопировать историю до этого сообщения в отдельный чат с вашей правкой.',
      'edit.busy': 'Дождитесь завершения ответа, чтобы изменить этот чат.',
      'edit.saving': 'Сохранение…',
      'edit.creating': 'Создание…',
      'edit.cancel': 'Отмена',
      'edit.editedBadge': 'отредактировано',
      'edit.attachmentsRetained': 'Вложений сохранится: {count}',
      'edit.failed': 'Не удалось сохранить правку сообщения.',
      'queue.title': 'Сообщение в очереди',
      'queue.save': 'Сохранить',
      'queue.cancel': 'Отмена',
      'queue.editTooltip': 'Редактировать сообщение в очереди',
      'queue.removeTooltip': 'Удалить из очереди',
      'queue.steerTooltip': 'Отправить как steering',
      'queue.count': 'В очереди: {n}',
      'queue.sending': 'Отправка…',
      'queue.failed': 'Не удалось изменить сообщение в очереди.',
      'queue.dismissError': 'Закрыть ошибку',
    },
  };

  for (const [language, dictionary] of Object.entries(dictionaries)) {
    ctx.effect(() => ctx.locale.register(ns, language, dictionary));
  }
  const mt = ctx.locale.bind(ns);

  // SVG Icons
  const EditIcon = ({ size = 14 }) => h('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'inline-block', verticalAlign: 'middle' },
  }, [
    h('path', { key: 'p1', d: 'M11.5 2.5a1.414 1.414 0 0 1 2 2L4.5 13.5l-3 1 1-3 9-9z' }),
  ]);

  const CopyIcon = ({ size = 14 }) => h('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'inline-block', verticalAlign: 'middle' },
  }, [
    h('rect', { key: 'r1', x: 5, y: 5, width: 9, height: 9, rx: 1.5 }),
    h('path', { key: 'p1', d: 'M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3' }),
  ]);

  const BranchIcon = ({ size = 14 }) => h('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'inline-block', verticalAlign: 'middle' },
  }, [
    h('circle', { key: 'c1', cx: 4, cy: 3.5, r: 1.5 }),
    h('circle', { key: 'c2', cx: 4, cy: 12.5, r: 1.5 }),
    h('circle', { key: 'c3', cx: 12, cy: 6.5, r: 1.5 }),
    h('path', { key: 'p1', d: 'M4 5v6' }),
    h('path', { key: 'p2', d: 'M4 8a4 4 0 0 0 4-4v0a4 4 0 0 1 4 2.5' }),
  ]);

  const SendIcon = ({ size = 14 }) => h('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'inline-block', verticalAlign: 'middle' },
  }, [
    h('path', { key: 'p1', d: 'M14.5 1.5l-6 13-2.5-5.5L.5 6.5l14-5z' }),
    h('path', { key: 'p2', d: 'M14.5 1.5L6 9' }),
  ]);

  const TrashIcon = ({ size = 14 }) => h('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'inline-block', verticalAlign: 'middle' },
  }, [
    h('path', { key: 'p1', d: 'M2 4h12M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4M3.5 4l.8 10a1.5 1.5 0 0 0 1.5 1.5h4.4a1.5 1.5 0 0 0 1.5-1.5l.8-10' }),
  ]);

  // Component: inline editor with explicit same-chat and new-chat actions.
  const qolHistory = registerQolRegeneratedHistory(ctx);
  const syncSentEdits = createSentEditsSync(ctx, qolMessageEditsStore, qolHistory);
  function QolUserMessageNodeView(props) {
    const { node, renderFactorySlot, loadImage, sessionId, useSession } = props;
    const [isEditing, setIsEditing] = React.useState(false);
    const [draftText, setDraftText] = React.useState('');
    const [copied, setCopied] = React.useState(false);
    const [, setEditsRev] = React.useState(0);
    const [busy, setBusy] = React.useState(null);
    const [error, setError] = React.useState(null);
    const rowRef = React.useRef(null);
    const editorRef = React.useRef(null);
    const editButtonRef = React.useRef(null);
    const rowHeight = React.useRef(0);
    const busyRef = React.useRef(false);
    const branchAttempt = React.useRef({});
    const running = useSession ? useSession(s => s.running) : false;
    const enabled = modulesStore.isEnabled('messages');

    React.useEffect(() => qolMessageEditsStore.subscribe(() => setEditsRev(r => r + 1)), []);
    React.useEffect(() => enabled ? syncSentEdits(sessionId) : undefined, [sessionId, enabled]);
    React.useLayoutEffect(() => {
      if (isEditing) qolFocusEditor(editorRef.current);
    }, [isEditing]);
    React.useLayoutEffect(() => {
      const input = editorRef.current;
      if (!isEditing || !input) return;
      input.style.height = 'auto';
      input.style.height = `${Math.min(160, Math.max(56, input.scrollHeight))}px`;
    }, [isEditing, draftText]);

    const data = node?.data || {};
    const originalContent = data.content || [];
    const { seq, messageId } = qolSentMessageIdentity(ctx, sessionId, node);
    const targetReady = seq !== undefined || messageId !== undefined;
    const savedEdit = qolMessageEditsStore.get(sessionId, messageId) ?? qolMessageEditsStore.get(sessionId, seq);
    const isEdited = typeof savedEdit === 'string';
    const currentText = isEdited ? savedEdit : qolExtractMessageText(originalContent);
    const prepared = React.useMemo(() => qolPrepareUserContent(
      originalContent, currentText, data.referenceLabels,
    ), [originalContent, currentText, data.referenceLabels]);
    const facts = React.useMemo(() => ({
      ...(data.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels }),
      ...(data.skillNames === undefined ? {} : { skillNames: data.skillNames }),
    }), [data.referenceLabels, data.skillNames]);

    const handleCopy = e => {
      e?.stopPropagation();
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(currentText).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }
    };
    const handleStartEdit = e => {
      e?.preventDefault();
      e?.stopPropagation();
      rowHeight.current = rowRef.current?.getBoundingClientRect().height || 0;
      branchAttempt.current = {};
      setDraftText(currentText);
      setError(null);
      setIsEditing(true);
    };
    const handleCancelEdit = () => {
      if (busyRef.current) return;
      setIsEditing(false);
      setDraftText('');
      setError(null);
      // Return keyboard focus after the normal row has mounted, without scrolling.
      requestAnimationFrame(() => qolFocusEditor(editButtonRef.current));
    };
    const handleSave = async (newChat = false) => {
      if (busyRef.current || !draftText.trim() || (!newChat && running)) return;
      // Re-resolve at click time; a just-sent message may have been admitted
      // after the editor was opened. Never send an identity-less edit command.
      const target = qolSentMessageIdentity(ctx, sessionId, node);
      if (target.seq === undefined && !target.messageId) {
        setError(mt('queue.sending'));
        return;
      }
      busyRef.current = true;
      setBusy(newChat ? 'branch' : 'edit');
      setError(null);
      try {
        if (newChat) {
          await qolCreateEditedChat(ctx, sessionId, target.seq, target.messageId, draftText, branchAttempt.current);
        } else {
          await qolSaveSentMessage(ctx, sessionId, target.seq, target.messageId, draftText, true);
        }
        setIsEditing(false);
        if (!newChat) requestAnimationFrame(() => qolFocusEditor(editButtonRef.current));
      } catch (err) {
        setError(err?.message || mt('edit.failed'));
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    };

    const rowStyle = {
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
      width: '100%', minWidth: 0, marginBottom: '16px', position: 'relative', boxSizing: 'border-box',
    };
    if (!enabled) {
      return h('div', { className: 'userRow', style: rowStyle }, [
        renderFactorySlot('conversation.chat.user.content', { content: prepared, loadImage, facts, interactive: true }),
      ]);
    }
    if (isEditing) {
      const button = (label, onClick, { primary = false, disabled = false, title } = {}) => h('button', {
        key: label, type: 'button', onClick, disabled, title,
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '100%', minWidth: 0, height: '30px', boxSizing: 'border-box',
          padding: '0 8px', borderRadius: '7px', font: 'inherit', fontSize: '12px', lineHeight: '18px',
          fontWeight: 500, cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.45 : 1, transition: 'background-color 0.15s, opacity 0.15s',
          border: primary ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l1)',
          backgroundColor: primary ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-base)',
          color: primary ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
        },
      }, label);
      return h('div', {
        ref: rowRef, className: 'userRow qol-message-edit',
        style: { ...rowStyle, minHeight: rowHeight.current, justifyContent: 'flex-end' },
      }, [
        h('div', {
          key: 'editor', role: 'group', 'aria-label': mt('edit.title'), 'aria-busy': busy !== null,
          style: {
            width: '100%', maxWidth: '560px', minWidth: 0, boxSizing: 'border-box', padding: '8px',
            backgroundColor: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '12px', overflow: 'hidden',
          },
        }, [
          h('textarea', {
            key: 'input', ref: editorRef, value: draftText, 'aria-label': mt('edit.title'),
            placeholder: mt('edit.placeholder'), disabled: busy !== null,
            onChange: e => setDraftText(e.target.value),
            onKeyDown: e => {
              e.stopPropagation();
              if (e.nativeEvent?.isComposing || e.isComposing) return;
              if (e.key === 'Escape') { e.preventDefault(); handleCancelEdit(); }
              else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSave(); }
            },
            style: {
              display: 'block', width: '100%', margin: 0, minHeight: '56px', height: '56px',
              maxHeight: 'min(160px, 35vh)', boxSizing: 'border-box', resize: 'vertical',
              padding: '8px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l1)',
              backgroundColor: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
              font: 'inherit', fontSize: '14px', lineHeight: '20px', outlineOffset: '-2px',
            },
          }),
          error && h('div', { key: 'error', role: 'alert', style: {
            marginTop: '8px', padding: '6px 8px', borderRadius: '6px', fontSize: '12px',
            backgroundColor: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere',
          } }, error),
          h('div', { key: 'buttons', style: {
            display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: '6px', width: 'min(100%, 348px)', margin: '8px 0 0 auto',
          } }, [
            button(mt('edit.cancel'), handleCancelEdit, { disabled: busy !== null }),
            button(mt(busy === 'branch' ? 'edit.creating' : 'edit.newChat'), () => handleSave(true), {
              disabled: busy !== null || !draftText.trim() || seq === undefined,
              title: seq === undefined ? mt('queue.sending') : mt('edit.branchHint'),
            }),
            button(mt(busy === 'edit' ? 'edit.saving' : 'edit.saveInPlace'), () => handleSave(), {
              primary: true, disabled: busy !== null || !draftText.trim() || running || !targetReady,
              title: !targetReady ? mt('queue.sending') : running ? mt('edit.busy') : undefined,
            }),
          ]),
        ]),
      ]);
    }
    const iconButton = (icon, label, onClick, ref) => h('button', {
      key: label, type: 'button', title: label, 'aria-label': label, onClick, ref,
      onMouseDown: e => e.preventDefault(),
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px',
        backgroundColor: 'transparent', border: 'none', color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer', borderRadius: '7px', padding: 0, transition: 'background-color 0.15s',
      },
      onMouseEnter: e => { e.currentTarget.style.backgroundColor = 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))'; },
      onMouseLeave: e => { e.currentTarget.style.backgroundColor = 'transparent'; },
    }, h(icon, { size: 14 }));
    return h('div', { ref: rowRef, className: 'userRow', style: rowStyle }, [
      renderFactorySlot('conversation.chat.user.content', { content: prepared, loadImage, facts, interactive: true }),
      h('div', { key: 'actions', className: 'qol-user-actions', style: {
        display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px', paddingRight: '4px',
      } }, [
        isEdited && h('span', { key: 'edited', style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginRight: '5px' } }, mt('edit.editedBadge')),
        iconButton(CopyIcon, copied ? 'Copied!' : 'Copy', handleCopy),
        iconButton(EditIcon, mt('edit.action'), handleStartEdit, editButtonRef),
      ]),
    ]);
  }

  // Component: Enhanced Queue Dock
  function QolQueueDock(props) {
    const {
      useSession,
      useProjection,
      sessionId,
    } = props;

    const inbox = useProjection('inbox');
    const pendingSubmissions = useSession ? useSession(s => s.pendingSubmissions || []) : [];
    const running = useSession ? useSession(s => s.running) : false;
    const queueMutable = useSession ? useSession(s => s.subagent === null || s.subagent?.address?.mode === 'continuable') : true;

    const [editing, setEditing] = React.useState(null); // { id, text }
    const [collapsed, setCollapsed] = React.useState(true);
    const [busyId, setBusyId] = React.useState(null);
    const [queueError, setQueueError] = React.useState(null);

    const queue = React.useMemo(() => qolSelectQueue(inbox, pendingSubmissions), [inbox, pendingSubmissions]);
    const rowCount = queue.length;
    const hasPending = queue.some(row => row.pending);

    // Reset editing if row disappears
    React.useEffect(() => {
      if (editing && !queue.some(r => r.id === editing.id)) {
        setEditing(null);
      }
    }, [queue, editing]);

    if (rowCount === 0 && !queueError) return null;

    const expanded = !collapsed || editing !== null;
    const listVisible = rowCount === 1 || expanded;

    const handleSaveQueueEdit = async (row) => {
      if (!editing || !editing.text.trim() || row.pending || busyId !== null) return;
      const itemId = editing.id;
      const newText = editing.text;
      setBusyId(itemId);
      setQueueError(null);

      try {
        await qolEditQueuedMessage(ctx, sessionId, row, newText);
        setEditing(null);
      } catch (err) {
        setQueueError(err?.message || mt('edit.failed'));
      } finally {
        setBusyId(null);
      }
    };

    const handleQueueAction = async (itemId, kind) => {
      if (busyId !== null) return;
      setBusyId(itemId);
      setQueueError(null);
      try {
        await qolUpdateQueue(ctx, sessionId, itemId, { kind });
      } catch (err) {
        setQueueError(err?.message || mt('queue.failed'));
      } finally {
        setBusyId(null);
      }
    };

    return h('div', {
      'data-harness-qol-queue': true,
      style: qolQueueDockLayout,
    }, [
      h('div', {
        style: {
          backgroundColor: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 'var(--dsw-radius-md, 10px)',
          overflow: 'hidden',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
        },
      }, [
        queueError && h('div', {
          role: 'alert',
          style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', color: 'var(--dsw-alias-label-primary)' },
        }, [
          h('span', { style: { flex: 1 } }, queueError),
          h('button', {
            type: 'button', title: mt('queue.dismissError'), 'aria-label': mt('queue.dismissError'),
            onClick: () => setQueueError(null),
            style: { color: 'inherit', background: 'transparent', border: 'none', cursor: 'pointer' },
          }, '×'),
        ]),
        // Header when multiple rows
        rowCount > 1 && h('button', {
          type: 'button',
          onClick: () => setCollapsed(v => !v),
          style: {
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            backgroundColor: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: '12px',
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, [
          h('span', { style: { fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '6px' } }, [
            h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--dsw-alias-brand-primary)' } }),
            mt('queue.count', { n: rowCount }),
            hasPending && h('span', { role: 'status', style: { fontWeight: 400 } }, mt('queue.sending')),
          ]),
          h('span', { style: { fontSize: '11px', opacity: 0.8 } }, expanded ? '▲' : '▼'),
        ]),

        // List
        listVisible && h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '1px',
            backgroundColor: 'var(--dsw-alias-border-l1)',
          },
        }, [
          ...queue.map((row) => {
            const rowAttachments = qolExtractAttachments(row.content);
            const rowText = qolExtractMessageText(row.content);
            const isRowEditing = editing?.id === row.id;
            const isBusy = row.pending === true || busyId !== null;

            return h('div', {
              key: row.id,
              style: {
                backgroundColor: 'var(--dsw-alias-bg-layer-1)',
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              },
            }, [
              isRowEditing ? (
                // Inline Queue Editor
                h('div', {
                  style: { display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' },
                }, [
                  h('textarea', {
                    value: editing.text,
                    onChange: e => setEditing({ ...editing, text: e.target.value }),
                    onKeyDown: e => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditing(null);
                      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        handleSaveQueueEdit(row);
                      }
                    },
                    onFocus: e => { e.currentTarget.style.borderColor = 'var(--dsw-alias-border-l2)'; },
                    onBlur: e => { e.currentTarget.style.borderColor = 'var(--dsw-alias-border-l1)'; },
                    autoFocus: true,
                    style: {
                      width: '100%',
                      minHeight: '52px',
                      boxSizing: 'border-box',
                      backgroundColor: 'var(--dsw-alias-bg-base)',
                      border: '1px solid var(--dsw-alias-border-l1)',
                      borderRadius: 'var(--dsw-radius-sm, 6px)',
                      padding: '8px 10px',
                      fontSize: '13px',
                      lineHeight: '18px',
                      fontFamily: 'inherit',
                      color: 'var(--dsw-alias-label-primary)',
                      resize: 'vertical',
                      outline: 'none',
                      transition: 'border-color 0.15s ease',
                    },
                  }),
                  rowAttachments.length > 0 && h('div', {
                    style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
                  }, mt('edit.attachmentsRetained', { count: rowAttachments.length })),
                  h('div', {
                    style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
                  }, [
                    h('button', {
                      type: 'button',
                      disabled: isBusy,
                      onClick: () => setEditing(null),
                      style: {
                        padding: '5px 12px',
                        fontSize: '12px',
                        backgroundColor: 'transparent',
                        border: '1px solid var(--dsw-alias-border-l1)',
                        color: 'var(--dsw-alias-label-secondary)',
                        borderRadius: 'var(--dsw-radius-sm, 6px)',
                        cursor: 'pointer',
                        transition: 'background-color 0.15s, color 0.15s',
                      },
                      onMouseEnter: e => {
                        e.currentTarget.style.backgroundColor = 'var(--dsw-alias-bg-layer-2)';
                        e.currentTarget.style.color = 'var(--dsw-alias-label-primary)';
                      },
                      onMouseLeave: e => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                        e.currentTarget.style.color = 'var(--dsw-alias-label-secondary)';
                      },
                    }, mt('queue.cancel')),
                    h('button', {
                      type: 'button',
                      disabled: isBusy || !editing.text.trim(),
                      onClick: () => handleSaveQueueEdit(row),
                      style: {
                        padding: '5px 14px',
                        fontSize: '12px',
                        backgroundColor: 'var(--dsw-alias-label-primary)',
                        color: 'var(--dsw-alias-bg-base)',
                        border: 'none',
                        borderRadius: 'var(--dsw-radius-sm, 6px)',
                        cursor: 'pointer',
                        fontWeight: 500,
                        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.08)',
                        transition: 'opacity 0.15s ease',
                      },
                      onMouseEnter: e => { e.currentTarget.style.opacity = '0.88'; },
                      onMouseLeave: e => { e.currentTarget.style.opacity = '1'; },
                    }, isBusy ? '…' : mt('queue.save')),
                  ]),
                ])
              ) : (
                // Normal Queue Row
                h('div', {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                    width: '100%',
                  },
                }, [
                  // Text and attachments info
                  h('div', {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      flex: 1,
                      minWidth: 0,
                    },
                  }, [
                    rowAttachments.length > 0 && h('span', {
                      style: {
                        fontSize: '11px',
                        backgroundColor: 'var(--dsw-alias-bg-layer-2)',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        color: 'var(--dsw-alias-label-secondary)',
                        flexShrink: 0,
                      },
                    }, `📎 ${rowAttachments.length}`),
                    h('span', {
                      style: {
                        fontSize: '13px',
                        color: 'var(--dsw-alias-label-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    }, rowText || '—'),
                    row.pending && h('span', {
                      role: 'status',
                      style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', flexShrink: 0 },
                    }, mt('queue.sending')),
                  ]),

                  // Actions
                  queueMutable && h('div', {
                    style: { display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 },
                  }, [
                    // Edit button (ALWAYS AVAILABLE!)
                    h('button', {
                      type: 'button',
                      title: mt('queue.editTooltip'),
                      disabled: isBusy,
                      onClick: () => setEditing({ id: row.id, text: rowText }),
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '28px',
                        height: '28px',
                        backgroundColor: 'transparent',
                        border: 'none',
                        color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
                        cursor: 'pointer',
                        borderRadius: 'var(--dsw-radius-sm, 6px)',
                        padding: 0,
                        transition: 'background-color 0.15s, color 0.15s',
                      },
                      onMouseEnter: e => {
                        e.currentTarget.style.backgroundColor = 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))';
                        e.currentTarget.style.color = 'var(--dsw-alias-label-primary)';
                      },
                      onMouseLeave: e => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                        e.currentTarget.style.color = 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))';
                      },
                    }, [h(EditIcon, { size: 14 })]),

                    // Steer button (if running)
                    running && h('button', {
                      type: 'button',
                      title: mt('queue.steerTooltip'),
                      disabled: isBusy,
                      onClick: () => handleQueueAction(row.id, 'steer'),
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '28px',
                        height: '28px',
                        backgroundColor: 'transparent',
                        border: 'none',
                        color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
                        cursor: 'pointer',
                        borderRadius: 'var(--dsw-radius-sm, 6px)',
                        padding: 0,
                        transition: 'background-color 0.15s, color 0.15s',
                      },
                      onMouseEnter: e => {
                        e.currentTarget.style.backgroundColor = 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))';
                        e.currentTarget.style.color = 'var(--dsw-alias-label-primary)';
                      },
                      onMouseLeave: e => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                        e.currentTarget.style.color = 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))';
                      },
                    }, [h(SendIcon, { size: 13 })]),

                    // Remove button
                    h('button', {
                      type: 'button',
                      title: mt('queue.removeTooltip'),
                      disabled: isBusy,
                      onClick: () => handleQueueAction(row.id, 'remove'),
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '28px',
                        height: '28px',
                        backgroundColor: 'transparent',
                        border: 'none',
                        color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
                        cursor: 'pointer',
                        borderRadius: 'var(--dsw-radius-sm, 6px)',
                        padding: 0,
                        transition: 'background-color 0.15s, color 0.15s',
                      },
                      onMouseEnter: e => {
                        e.currentTarget.style.backgroundColor = 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))';
                        e.currentTarget.style.color = 'var(--dsw-alias-label-primary)';
                      },
                      onMouseLeave: e => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                        e.currentTarget.style.color = 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))';
                      },
                    }, [h(TrashIcon, { size: 14 })]),
                  ]),
                ])
              ),
            ]);
          }),
        ]),
      ]),
    ]);
  }

  // Register in Slots
  // 1. User message in Chat
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user',
  }, QolUserMessageNodeView));

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'steering',
  }, QolUserMessageNodeView));

  // 2. Queue in Input Dock
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'queue',
    order: 20,
  }, QolQueueDock));
}
