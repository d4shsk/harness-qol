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
    if (defaultAgent && defaultAgent.session) return defaultAgent;
    if (targetSessionId && ctx.sessions) {
      // In case session exists without active agent
      const session = ctx.sessions.get(targetSessionId);
      if (session) return { id: targetSessionId, session };
    }
    return defaultAgent || null;
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
      const session = resolvedAgent?.session || (targetSessionId && ctx.sessions ? ctx.sessions.get(targetSessionId) : null);
      if (!session) return { messages: [] };

      const events = typeof session.snapshotEvents === 'function'
        ? session.snapshotEvents()
        : session.log || [];
      const userMessages = [];

      for (const event of events) {
        if (!event || event.type !== 'user/message') continue;
        const data = event.data;
        if (!data || data.source?.kind !== 'user') continue;
        userMessages.push({
          seq: event.seq,
          messageId: data.id,
          time: event.time,
          text: textOfContent(data.content),
          attachments: attachmentsOfContent(data.content),
        });
      }

      return { messages: userMessages };
    }

    if (action === 'edit_sent') {
      const key = request.seq !== undefined ? String(request.seq) : request.messageId;
      if (!key) throw new Error('seq or messageId is required for edit_sent.');
      const newText = typeof request.text === 'string' ? request.text.trim() : '';
      if (!newText) throw new Error('Replacement text cannot be empty.');

      const sid = targetSessionId || 'default';
      const edits = await editsStore.set(sid, key, newText);
      return { sessionId: sid, key, text: newText, edits, saved: true };
    }

    if (action === 'get_edits') {
      const sid = targetSessionId || 'default';
      return { edits: editsStore.get(sid) };
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
    description: 'Edit already sent messages or messages in the queue (preserving image and file attachments).',
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
