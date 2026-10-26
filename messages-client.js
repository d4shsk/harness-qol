// Harness-QOL: Message editing for already sent messages in chat and queued messages in composer.
// Concatenate inside the Client ModuleLoader factory.

function createMessageEditsClientStore() {
  const STORAGE_KEY = 'harness_qol_message_edits';
  let state = {}; // { [sessionId]: { [key]: string } }

  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') state = parsed;
      }
    }
  } catch (_e) {}

  const listeners = new Set();
  const notify = () => {
    listeners.forEach(fn => {
      try { fn(state); } catch (_e) {}
    });
  };

  function persist() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }
    } catch (_e) {}
  }

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
      persist();
      notify();
    },
    remove(sessionId, key) {
      if (!sessionId || key === undefined || key === null) return;
      if (state[sessionId] && state[sessionId][String(key)] !== undefined) {
        delete state[sessionId][String(key)];
        persist();
        notify();
      }
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

function qolBuildEditedContent(originalContent, newText) {
  const otherBlocks = Array.isArray(originalContent)
    ? originalContent.filter(b => b && b.type !== 'text')
    : [];
  return [{ type: 'text', text: newText }, ...otherBlocks];
}

async function qolExecuteMessageCommand(ctx, sessionId, request) {
  const scope = ctx.sessions ? ctx.sessions.scope(sessionId) : null;
  if (!scope || !scope.remote || !scope.remote.commands) {
    throw new Error('Commands unavailable for session / Команды недоступны для этой сессии.');
  }
  const reply = await scope.remote.commands.execute('/harness-qol-message-edit ' + JSON.stringify(request), []);
  if (reply?.ok === false) throw new Error(reply.error?.message ?? 'Command failed');
  const execution = reply?.ok === true ? reply.value : reply;
  if (!execution?.result?.text) return null;
  try {
    const parsed = JSON.parse(execution.result.text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.data;
  } catch (e) {
    if (e.message) throw e;
    return null;
  }
}

function registerMessagesClient(ctx, React, modulesStore = qolModulesStore) {
  const h = React.createElement;
  const ns = 'harness-qol-messages';

  const dictionaries = {
    en: {
      'edit.action': 'Edit',
      'edit.title': 'Edit message',
      'edit.placeholder': 'Enter your message…',
      'edit.saveInPlace': 'Save in history',
      'edit.branchAndRun': 'Restart from here',
      'edit.toComposer': 'To composer',
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
    },
    ru: {
      'edit.action': 'Редактировать',
      'edit.title': 'Редактирование сообщения',
      'edit.placeholder': 'Введите текст сообщения…',
      'edit.saveInPlace': 'Сохранить в истории',
      'edit.branchAndRun': 'Перезапустить с этой правки',
      'edit.toComposer': 'В поле ввода',
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

  // Component: Enhanced User Message Row in Chat
  function QolUserMessageNodeView(props) {
    const {
      node,
      renderFactorySlot,
      loadImage,
      inputActions,
      forkAt,
      sessionId,
      useSession,
    } = props;

    const [isEditing, setIsEditing] = React.useState(false);
    const [draftText, setDraftText] = React.useState('');
    const [copied, setCopied] = React.useState(false);
    const [editsRev, setEditsRev] = React.useState(0);

    // Subscribe to in-place edits
    React.useEffect(() => {
      return qolMessageEditsStore.subscribe(() => {
        setEditsRev(r => r + 1);
      });
    }, []);

    const data = node?.data || {};
    const originalContent = data.content || [];
    const seq = node.seq;
    const messageId = data.id;

    // Check if an edit exists for this message
    const savedEdit = qolMessageEditsStore.get(sessionId, seq) || qolMessageEditsStore.get(sessionId, messageId);
    const isEdited = Boolean(savedEdit);
    const currentText = isEdited ? savedEdit : qolExtractMessageText(originalContent);
    const attachments = React.useMemo(() => qolExtractAttachments(originalContent), [originalContent]);

    // Effective content to render
    const effectiveContent = React.useMemo(() => {
      if (!isEdited) return originalContent;
      return qolBuildEditedContent(originalContent, savedEdit);
    }, [originalContent, isEdited, savedEdit]);

    const handleCopy = (e) => {
      e?.stopPropagation();
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(currentText).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    };

    const handleStartEdit = (e) => {
      e?.stopPropagation();
      setDraftText(currentText);
      setIsEditing(true);
    };

    const handleCancelEdit = () => {
      setIsEditing(false);
      setDraftText('');
    };

    const handleToComposer = () => {
      const trimmed = draftText.trim();
      if (trimmed && inputActions?.setDraft) {
        inputActions.setDraft(trimmed);
      }
      setIsEditing(false);
    };

    const handleBranchAndRun = async () => {
      const trimmed = draftText.trim();
      if (!trimmed) return;

      setIsEditing(false);

      // Inclusive cut boundary: the event immediately preceding this user message
      const cutSeq = typeof seq === 'number' && seq > 0 ? seq - 1 : undefined;

      try {
        if (typeof forkAt === 'function' && cutSeq !== undefined) {
          if (inputActions?.setDraft) {
            inputActions.setDraft(trimmed);
          }
          forkAt(cutSeq);
        } else if (ctx.sessions?.fork) {
          const childId = await ctx.sessions.fork({
            sessionId,
            atSeq: cutSeq,
            increaseTitle: true,
          });
          if (childId && ctx.uiWorkspace?.openSession) {
            ctx.uiWorkspace.openSession(childId);
            setTimeout(() => {
              const newScope = ctx.sessions?.scope(childId);
              if (newScope?.inputActions?.setDraft) {
                newScope.inputActions.setDraft(trimmed);
              } else if (inputActions?.setDraft) {
                inputActions.setDraft(trimmed);
              }
            }, 100);
          }
        } else {
          handleToComposer();
        }
      } catch (_e) {
        handleToComposer();
      }
    };

    // If module is disabled in settings, render native factory bubble
    if (!modulesStore.isEnabled('messages')) {
      const prepared = {
        text: currentText,
        attachments,
        extraBlocks: originalContent.filter(b => b.type !== 'text' && b.type !== 'image' && b.type !== 'file'),
      };
      return h('div', {
        className: 'userRow',
        style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginBottom: '16px' },
      }, [
        renderFactorySlot('conversation.chat.user.content', {
          content: prepared,
          loadImage,
          facts: {},
          interactive: true,
        }),
      ]);
    }

    // Editing mode: sleek, inline card
    if (isEditing) {
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          width: '100%',
          margin: '12px 0',
          boxSizing: 'border-box',
        },
      }, [
        h('div', {
          style: {
            boxSizing: 'border-box',
            width: '100%',
            maxWidth: '680px',
            backgroundColor: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 'var(--dsw-radius-md, 12px)',
            padding: '14px 16px',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
          },
        }, [
          // Header
          h('div', {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '10px',
            },
          }, [
            h('span', {
              style: {
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--dsw-alias-label-primary)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              },
            }, [
              h(EditIcon, { size: 14 }),
              mt('edit.title'),
            ]),
            attachments.length > 0 && h('span', {
              style: {
                fontSize: '11px',
                color: 'var(--dsw-alias-label-secondary)',
                backgroundColor: 'var(--dsw-alias-bg-layer-2)',
                padding: '2px 8px',
                borderRadius: '10px',
                border: '1px solid var(--dsw-alias-border-l1)',
              },
            }, mt('edit.attachmentsRetained', { count: attachments.length })),
          ]),

          // Textarea
          h('textarea', {
            value: draftText,
            placeholder: mt('edit.placeholder'),
            autoFocus: true,
            onChange: e => setDraftText(e.target.value),
            onKeyDown: e => {
              if (e.key === 'Escape') {
                e.preventDefault();
                handleCancelEdit();
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleBranchAndRun();
              }
            },
            onFocus: e => { e.currentTarget.style.borderColor = 'var(--dsw-alias-border-l2)'; },
            onBlur: e => { e.currentTarget.style.borderColor = 'var(--dsw-alias-border-l1)'; },
            style: {
              width: '100%',
              minHeight: '84px',
              maxHeight: '300px',
              boxSizing: 'border-box',
              backgroundColor: 'var(--dsw-alias-bg-base)',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 'var(--dsw-radius-sm, 8px)',
              padding: '10px 12px',
              fontSize: '14px',
              lineHeight: '22px',
              fontFamily: 'inherit',
              color: 'var(--dsw-alias-label-primary)',
              resize: 'vertical',
              outline: 'none',
              marginBottom: '12px',
              transition: 'border-color 0.15s ease',
            },
          }),

          // Button Actions
          h('div', {
            style: {
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'center',
              gap: '8px',
              flexWrap: 'wrap',
            },
          }, [
            // Cancel
            h('button', {
              type: 'button',
              onClick: handleCancelEdit,
              style: {
                backgroundColor: 'transparent',
                border: '1px solid var(--dsw-alias-border-l1)',
                color: 'var(--dsw-alias-label-secondary)',
                padding: '6px 14px',
                borderRadius: 'var(--dsw-radius-sm, 6px)',
                fontSize: '13px',
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
            }, mt('edit.cancel')),

            // To Composer
            h('button', {
              type: 'button',
              onClick: handleToComposer,
              style: {
                backgroundColor: 'var(--dsw-alias-bg-layer-2)',
                border: '1px solid var(--dsw-alias-border-l1)',
                color: 'var(--dsw-alias-label-primary)',
                padding: '6px 14px',
                borderRadius: 'var(--dsw-radius-sm, 6px)',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'background-color 0.15s, border-color 0.15s',
              },
              onMouseEnter: e => {
                e.currentTarget.style.borderColor = 'var(--dsw-alias-border-l2)';
                e.currentTarget.style.backgroundColor = 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))';
              },
              onMouseLeave: e => {
                e.currentTarget.style.borderColor = 'var(--dsw-alias-border-l1)';
                e.currentTarget.style.backgroundColor = 'var(--dsw-alias-bg-layer-2)';
              },
            }, [
              h(SendIcon, { size: 13 }),
              mt('edit.toComposer'),
            ]),

            // Restart from here (Branch & Run)
            h('button', {
              type: 'button',
              onClick: handleBranchAndRun,
              style: {
                backgroundColor: 'var(--dsw-alias-label-primary)',
                color: 'var(--dsw-alias-bg-base)',
                border: 'none',
                padding: '7px 16px',
                borderRadius: 'var(--dsw-radius-sm, 6px)',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                boxShadow: '0 1px 3px rgba(0, 0, 0, 0.12)',
                transition: 'opacity 0.15s ease',
              },
              onMouseEnter: e => { e.currentTarget.style.opacity = '0.88'; },
              onMouseLeave: e => { e.currentTarget.style.opacity = '1'; },
            }, [
              h(BranchIcon, { size: 13 }),
              mt('edit.branchAndRun'),
            ]),
          ]),
        ]),
      ]);
    }

    // Normal mode: Native bubble + Edit action
    const prepared = {
      text: currentText,
      attachments,
      extraBlocks: originalContent.filter(b => b.type !== 'text' && b.type !== 'image' && b.type !== 'file'),
    };

    return h('div', {
      className: 'userRow',
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        width: '100%',
        marginBottom: '16px',
        position: 'relative',
      },
    }, [
      // Bubble
      renderFactorySlot('conversation.chat.user.content', {
        content: prepared,
        loadImage,
        facts: {},
        interactive: true,
      }),

      // Actions under/beside bubble
      h('div', {
        className: 'qol-user-actions',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginTop: '4px',
          paddingRight: '4px',
        },
      }, [
        // Edited badge
        isEdited && h('span', {
          style: {
            fontSize: '11px',
            color: 'var(--dsw-alias-label-secondary)',
            fontStyle: 'italic',
            marginRight: '6px',
            opacity: 0.85,
          },
        }, `(${mt('edit.editedBadge')})`),

        // Copy button
        h('button', {
          type: 'button',
          title: copied ? 'Copied!' : 'Copy',
          onClick: handleCopy,
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
            transition: 'background-color 0.15s ease, color 0.15s ease',
          },
          onMouseEnter: e => {
            e.currentTarget.style.backgroundColor = 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))';
            e.currentTarget.style.color = 'var(--dsw-alias-label-primary)';
          },
          onMouseLeave: e => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.color = 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))';
          },
        }, [h(CopyIcon, { size: 14 })]),

        // Edit button
        h('button', {
          type: 'button',
          title: mt('edit.action'),
          onClick: handleStartEdit,
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
            transition: 'background-color 0.15s ease, color 0.15s ease',
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
      ]),
    ]);
  }

  // Component: Enhanced Queue Dock
  function QolQueueDock(props) {
    const {
      useSession,
      useProjection,
      updateQueue,
      notify,
      loadImage,
      sessionId,
    } = props;

    const inbox = useProjection('inbox');
    const pendingSubmissions = useSession ? useSession(s => s.pendingSubmissions || []) : [];
    const running = useSession ? useSession(s => s.running) : false;
    const queueMutable = useSession ? useSession(s => s.subagent === null || s.subagent?.address?.mode === 'continuable') : true;

    const [editing, setEditing] = React.useState(null); // { id, text }
    const [collapsed, setCollapsed] = React.useState(true);
    const [busyId, setBusyId] = React.useState(null);

    const queue = React.useMemo(() => {
      const rows = inbox?.['next-turn'] || [];
      const inChat = new Set(pendingSubmissions.filter(item => item.placement === 'transcript').map(item => item.requestId));
      return inChat.size === 0 ? rows : rows.filter(({ source }) => source?.kind !== 'user' || !('rpcId' in source) || !inChat.has(source.rpcId));
    }, [inbox, pendingSubmissions]);

    const pendingQueue = React.useMemo(() => {
      const admitted = new Set(queue.flatMap(({ source }) => source?.kind === 'user' && 'rpcId' in source ? [source.rpcId] : []));
      return pendingSubmissions.filter(submission => submission.placement === 'queued' && !admitted.has(submission.requestId));
    }, [pendingSubmissions, queue]);

    const rowCount = queue.length + pendingQueue.length;

    // Reset editing if row disappears
    React.useEffect(() => {
      if (editing && !queue.some(r => r.id === editing.id)) {
        setEditing(null);
      }
    }, [queue, editing]);

    if (rowCount === 0) return null;

    const expanded = !collapsed || editing !== null;
    const listVisible = rowCount === 1 || expanded;

    const handleSaveQueueEdit = async (row) => {
      if (!editing || !editing.text.trim()) return;
      const itemId = editing.id;
      const newText = editing.text.trim();
      setBusyId(itemId);

      try {
        const hasAttachments = Array.isArray(row.content) && row.content.some(b => b && b.type !== 'text');
        if (hasAttachments) {
          // If row has attachments, use our host command to preserve them!
          await qolExecuteMessageCommand(ctx, sessionId, {
            action: 'edit_queue',
            sessionId,
            itemId,
            text: newText,
          });
        } else if (typeof updateQueue === 'function') {
          // Native plain text update
          await updateQueue(itemId, {
            kind: 'edit',
            content: [{ type: 'text', text: newText }],
          });
        }
        setEditing(null);
      } catch (err) {
        if (typeof notify === 'function') {
          notify('error', err?.message || mt('edit.failed'));
        }
      } finally {
        setBusyId(null);
      }
    };

    const handleRemoveQueueItem = async (itemId) => {
      setBusyId(itemId);
      try {
        if (typeof updateQueue === 'function') {
          await updateQueue(itemId, { kind: 'remove' });
        }
      } catch (_e) {
      } finally {
        setBusyId(null);
      }
    };

    const handleSteerQueueItem = async (itemId) => {
      setBusyId(itemId);
      try {
        if (typeof updateQueue === 'function') {
          await updateQueue(itemId, { kind: 'steer' });
        }
      } catch (_e) {
      } finally {
        setBusyId(null);
      }
    };

    return h('div', {
      style: {
        width: '100%',
        boxSizing: 'border-box',
        marginBottom: '8px',
      },
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
            const isBusy = busyId === row.id;

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
                      onClick: () => handleSteerQueueItem(row.id),
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
                      onClick: () => handleRemoveQueueItem(row.id),
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
