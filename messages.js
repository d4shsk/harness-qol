// Message editing operations for harness-qol:
// Supports editing queued messages (preserving all attachments) and managing sent message edits.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const EDITS_FILE = join(homedir(), '.dsh', 'harness-qol-edits.json');

export function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
}

export function attachmentsOfContent(content) {
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

export function createMessageEditsStore(customPath) {
  const filePath = customPath || EDITS_FILE;
  let edits = {}; // { [sessionId]: { [key]: string } }

  async function load() {
    try {
      if (existsSync(filePath)) {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          edits = parsed;
        }
      }
    } catch (_e) {}
    return edits;
  }

  async function save() {
    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      await writeFile(filePath, JSON.stringify(edits, null, 2), 'utf8');
    } catch (_e) {}
  }

  return {
    get(sessionId) {
      return edits[sessionId] ? { ...edits[sessionId] } : {};
    },
    async set(sessionId, key, text) {
      if (!sessionId || !key) return;
      if (!edits[sessionId]) edits[sessionId] = {};
      edits[sessionId][String(key)] = String(text);
      await save();
      return { ...edits[sessionId] };
    },
    async clear(sessionId) {
      if (!sessionId || !edits[sessionId]) return;
      delete edits[sessionId];
      await save();
    },
    all() {
      return { ...edits };
    },
    load,
  };
}

// Edits replace one model-visible surface node, never append another prompt.
// Originals remain in the audit log. UI edits can regenerate the latest request.
export function sentMessageState(session) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.log || [];
  const roots = new Map();
  const messages = [];
  const edits = {};
  const regenerations = [];
  for (const event of events) {
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') continue;
    const range = event.data.source.qolRegeneration;
    if (range && Number.isSafeInteger(range.startSeq) && Number.isSafeInteger(range.endSeq) &&
        range.startSeq >= 0 && range.endSeq >= range.startSeq) regenerations.push(range);
    if (event.surfaceOp === 'append') {
      const row = { original: event, current: event };
      roots.set(event.seq, row);
      messages.push(row);
    } else if (event.surfaceOp?.op === 'replace') {
      const row = roots.get(event.surfaceOp.startSeq);
      if (!row || row.current.seq !== event.surfaceOp.startSeq || row.original.data.id !== event.data.id) continue;
      row.current = event;
      roots.set(event.seq, row);
      edits[String(row.original.seq)] = textOfContent(event.data.content);
      edits[row.original.data.id] = textOfContent(event.data.content);
    }
  }
  return { messages, edits, regenerations };
}

export const messageEditParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['list_queue', 'edit_queue', 'list_sent', 'edit_sent', 'get_edits'],
      description: 'Operation to perform: list_queue, edit_queue (preserves attachments), list_sent, edit_sent, or get_edits.',
    },
    sessionId: {
      type: 'string',
      description: 'Session id. If omitted, uses the current agent session.',
    },
    itemId: {
      type: 'string',
      description: 'For edit_queue: message id of the queued item.',
    },
    seq: {
      type: 'integer',
      description: 'For edit_sent: sequence number of the sent user message.',
    },
    messageId: {
      type: 'string',
      description: 'For edit_sent: message id of the sent user message.',
    },
    text: {
      type: 'string',
      description: 'For edit_queue / edit_sent: replacement text.',
    },
    generate: {
      type: 'boolean',
      description: 'For edit_sent: regenerate the latest user request in this session, replacing its previous answer. Earlier messages are only saved. Defaults to false.',
    },
  },
};

export function createMessageOperations(ctx, settings, customEditsStore) {
  const editsStore = customEditsStore || createMessageEditsStore();
  editsStore.load().catch(() => {});

  function resolveAgent(targetSessionId, defaultAgent) {
    if (targetSessionId && ctx.agents) {
      const found = ctx.agents.get(targetSessionId);
      if (found) return found;
    }
    if (defaultAgent?.session && (!targetSessionId || defaultAgent.session.id === targetSessionId)) return defaultAgent;
    if (targetSessionId && ctx.sessions) {
      // In case session exists without active agent
      const session = ctx.sessions.get(targetSessionId);
      if (session) return { id: targetSessionId, session };
    }
    return null;
  }

  async function perform(agent, request) {
    if (!settings.isModuleEnabled('messages')) {
      throw new Error('Message editing module is disabled / Модуль редактирования сообщений отключён.');
    }
    const action = request.action || 'list_queue';
    const targetSessionId = request.sessionId || agent?.session?.id || agent?.id;
    const resolvedAgent = resolveAgent(targetSessionId, agent);

    if (action === 'list_queue') {
      if (!resolvedAgent || !resolvedAgent.inbox) {
        return { queue: [] };
      }
      const nextTurn = (resolvedAgent.inbox.nextTurn || []).map(m => ({
        id: m.id,
        placement: 'next-turn',
        text: textOfContent(m.content),
        attachments: attachmentsOfContent(m.content),
      }));
      const nextStep = (resolvedAgent.inbox.nextStep || []).map(m => ({
        id: m.id,
        placement: 'next-step',
        text: textOfContent(m.content),
        attachments: attachmentsOfContent(m.content),
      }));
      return { queue: [...nextTurn, ...nextStep] };
    }

    if (action === 'edit_queue') {
      if (!resolvedAgent || !resolvedAgent.inbox) {
        throw new Error('Agent or queue is unavailable / Очередь сообщений недоступна.');
      }
      const itemId = request.itemId;
      if (!itemId) throw new Error('itemId is required for edit_queue.');
      const newText = typeof request.text === 'string' ? request.text.trim() : '';
      if (!newText) throw new Error('New message text cannot be empty / Текст сообщения не может быть пустым.');

      const nextTurn = resolvedAgent.inbox.nextTurn || [];
      const nextStep = resolvedAgent.inbox.nextStep || [];
      const existing = nextTurn.find(m => m.id === itemId) || nextStep.find(m => m.id === itemId);
      if (!existing) {
        throw new Error('Queued message not found or already consumed / Сообщение в очереди не найдено.');
      }

      // Preserve non-text blocks (images, files, references) and replace/insert text block
      const nonTextBlocks = Array.isArray(existing.content)
        ? existing.content.filter(b => b && b.type !== 'text')
        : [];
      const updatedContent = [{ type: 'text', text: newText }, ...nonTextBlocks];

      // Update in inbox
      const updatedMessage = Object.freeze({
        ...existing,
        content: updatedContent,
      });
      resolvedAgent.inbox.replace(itemId, updatedMessage);

      return {
        id: itemId,
        text: newText,
        attachments: attachmentsOfContent(updatedContent),
        accepted: true,
      };
    }

    if (action === 'list_sent') {
      return { messages: sentMessageState(resolvedAgent?.session).messages.map(({ original, current }) => ({
        seq: original.seq,
        messageId: original.data.id,
        time: original.time,
        text: textOfContent(current.data.content),
        attachments: attachmentsOfContent(current.data.content),
        edited: original !== current,
      })) };
    }

    if (action === 'edit_sent') {
      if (request.seq !== undefined && (!Number.isSafeInteger(request.seq) || request.seq < 0)) {
        throw new Error('seq must be a non-negative safe integer.');
      }
      if (request.seq === undefined && !request.messageId) throw new Error('seq or messageId is required for edit_sent.');
      const newText = typeof request.text === 'string' ? request.text : '';
      if (!newText.trim()) throw new Error('Replacement text cannot be empty.');
      const session = resolvedAgent?.session;
      if (!session?.append || !session.surface) throw new Error('Session editing unavailable / Редактирование сессии недоступно.');
      if (resolvedAgent.status === 'running') throw new Error('Wait for the response to finish / Дождитесь завершения ответа.');
      const state = sentMessageState(session);
      const row = state.messages.find(({ original, current }) =>
        request.seq !== undefined ? original.seq === request.seq || current.seq === request.seq : original.data.id === request.messageId);
      if (!row || (request.messageId && row.original.data.id !== request.messageId)) {
        throw new Error('Sent user message not found / Отправленное сообщение не найдено.');
      }
      if (!session.surface.nodes.includes(row.current.seq)) {
        throw new Error('Message was compacted or replaced; create a new chat / Сообщение уже сжато или заменено; создайте новый чат.');
      }
      const generate = request.generate === true;
      if (generate && typeof resolvedAgent.followup !== 'function') {
        throw new Error('Generation unavailable for this session / Генерация для этой сессии недоступна.');
      }
      const events = session.snapshotEvents();
      const wakeId = seq => `harness-qol-edit:${session.id}:${seq}`;
      const queued = id => events.some(event =>
        event.type === 'user/message' && event.data.id === id ||
        event.type === 'agent/inbox/spliced' && event.data.inserted?.some(message => message.id === id));
      const inInbox = id => (resolvedAgent.inbox?.nextTurn || []).some(m => m.id === id);
      const unchanged = textOfContent(row.current.data.content) === newText;
      const alreadyStarted = generate && unchanged && row.current.data.source.qolRegeneration && (queued(wakeId(row.current.seq)) || inInbox(wakeId(row.current.seq)));
      let edited = row.current;
      if (!unchanged || generate && !alreadyStarted) {
        // A regeneration shadows the whole response suffix, including tool calls
        // and results together. Nothing is removed from the append-only audit log.
        const start = session.surface.nodes.indexOf(row.current.seq);
        const shadowed = generate ? session.surface.nodes.slice(start) : [row.current.seq];
        const content = [{ type: 'text', text: newText }, ...row.current.data.content.filter(block => block?.type !== 'text')];
        const source = generate ? { ...row.current.data.source, qolRegeneration: {
          startSeq: row.original.seq + 1, endSeq: events.at(-1).seq,
        } } : row.current.data.source;
        edited = session.append('user/message', { ...row.current.data, source, content }, {
          surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed.at(-1) },
          sourceEventSeqs: shadowed,
        });
      }
      if (generate && !alreadyStarted) {
        // Public Agent API: a runtime-context wake triggers a normal turn
        // without appending any redundant human prompt to the session surface.
        resolvedAgent.followup({
          id: wakeId(edited.seq), role: 'user',
          source: { kind: 'runtime-context' },
          content: [{ type: 'text', text: '' }],
        });
      }
      const updated = sentMessageState(session);
      return {
        sessionId: session.id, key: String(row.original.seq), text: newText,
        edits: updated.edits, regenerations: updated.regenerations,
        saved: true, applied: true, generationStarted: generate,
      };
    }

    if (action === 'get_edits') {
      const state = sentMessageState(resolvedAgent?.session);
      return { edits: state.edits, regenerations: state.regenerations, applied: true };
    }

    throw new Error(`Unknown action: ${action}`);
  }

  return {
    run: async (agent, request) => {
      try {
        const data = await perform(agent, request);
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
    editsStore,
  };
}

export function registerMessageEditor(ctx, settings) {
  const operations = createMessageOperations(ctx, settings);

  ctx.effect(() => ctx.tools.register({
    name: 'harness_qol_message_edit',
    description: 'Edit queued or sent user messages, preserving attachments. Sent edits require an idle session. With generate:true, editing the latest request replaces its response suffix and starts a new answer in the same chat; earlier messages are only saved. Originals remain in the audit log.',
    parameters: messageEditParameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: request => ['list_queue', 'list_sent', 'get_edits'].includes(request?.action ?? 'list_queue'),
    execute: (request, exec) => operations.run(exec.agent, request),
  }));

  ctx.effect(() => ctx.commands.register({
    name: 'harness-qol-message-edit',
    description: 'QOL Message Edit: edit_queue, list_queue, edit_sent, list_sent, get_edits (JSON).',
    recordInput: true,
    input: { hint: 'JSON operation: action, sessionId, itemId, seq, messageId, text' },
    async handler(invocation) {
      let request;
      try {
        request = invocation.rawInput.trim() ? JSON.parse(invocation.rawInput) : {};
      } catch {
        return { kind: 'error', text: 'Invalid JSON / Некорректный JSON.' };
      }
      const result = await operations.run(invocation.agent, request);
      return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) };
    },
  }));
}
