import { z } from 'zod';
import { admitMcpImage, needsMcpImageRepair } from './mcp-content.js';

export const MCP_REPAIR_KEY = 'harness-qol:mcp-image-repair';

function repairMessage(event) {
  if (event.type === 'tool/result') return event.data?.message;
  if (event.type === 'user/message' && event.data?.source?.kind === 'ptc-mode') return event.data;
  return null;
}

// Host-only incremental index: checkpoint only sequence numbers, never duplicate base64 bytes.
export const mcpImageRepairProjection = {
  key: MCP_REPAIR_KEY,
  stateVersion: 1,
  stateSchema: z.object({ pending: z.array(z.number().int().nonnegative()) }),
  init: () => ({ pending: [] }),
  apply(state, event) {
    const replacement = event.surfaceOp;
    let pending = state.pending;
    if (replacement?.op === 'replace' && replacement.startSeq === replacement.endSeq && pending.includes(replacement.startSeq)) {
      pending = pending.filter(seq => seq !== replacement.startSeq);
    }
    const message = repairMessage(event);
    if (Array.isArray(message?.content) && message.content.some(needsMcpImageRepair)) pending = [...pending, event.seq];
    return pending === state.pending ? state : { pending };
  },
};

export async function repairMcpSession(session, { projections, query, attachments, sessions, signal }) {
  const state = projections.stateOf(session, MCP_REPAIR_KEY);
  if (!state) throw new Error('MCP image repair projection is not registered');
  const candidates = state.pending.filter(seq => session.surface.nodes.includes(seq));
  let messages = 0, images = 0, unavailable = 0;
  for (const seq of candidates) {
    signal?.throwIfAborted();
    const { target: event } = await query.readEvent({ sessionId: session.id, seq, before: 0, after: 0 }, signal);
    const message = repairMessage(event);
    if (!message || !Array.isArray(message.content) || !session.surface.nodes.includes(seq)) continue;
    const content = [];
    let count = 0;
    for (const block of message.content) {
      if (!needsMcpImageRepair(block)) { content.push(block); continue; }
      const admitted = await admitMcpImage(block, attachments, signal);
      content.push(admitted);
      count++;
      if (admitted.type !== 'image') unavailable++;
    }
    signal?.throwIfAborted();
    // A concurrent compaction/edit may have shadowed the node during image admission.
    if (!count || !session.surface.nodes.includes(seq)) continue;
    const repairedMessage = { ...message, content };
    const data = event.type === 'tool/result' ? { ...event.data, message: repairedMessage } : repairedMessage;
    session.append(event.type, data, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [...new Set([...(event.sourceEventSeqs || []), seq])],
    });
    messages++;
    images += count;
  }
  if (messages) await sessions.flush(session);
  return { sessionId: session.id, messages, images, unavailable };
}

export function registerMcpHistoryRepair(ctx) {
  const repairs = [], errors = [];
  let active = 0;
  const status = () => ({ active, repairs: repairs.map(row => ({ ...row })), errors: errors.map(row => ({ ...row })) });
  // Recovery remains active even if the MCP module/server was disabled after poisoning a chat.
  ctx.inject(['sessions', 'sessionProjections', 'sessionQuery'], scope => {
    const projections = scope.get('sessionProjections');
    const sessions = scope.get('sessions');
    const query = scope.get('sessionQuery');
    scope.effect(() => projections.register(mcpImageRepairProjection));
    const controller = new AbortController();
    const running = new Map();
    function repair(session, signal) {
      if (!session || controller.signal.aborted) return Promise.resolve();
      if (running.has(session)) return running.get(session);
      active++;
      const task = repairMcpSession(session, {
        projections, query, sessions, attachments: scope.get('attachments'),
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      }).then(result => {
        if (result.messages) {
          repairs.push(result);
          if (repairs.length > 100) repairs.shift();
          console.info('[harness-qol:mcp] Repaired legacy image results:', result);
        }
      }).catch(error => {
        if (controller.signal.aborted || signal?.aborted) throw error;
        errors.push({ sessionId: session.id, error: error.message });
        if (errors.length > 100) errors.shift();
        throw error;
      }).finally(() => { running.delete(session); active--; });
      running.set(session, task);
      return task;
    }
    scope.on('agent/created', ({ agent, signal }) => repair(sessions.get(agent.id), signal));
    scope.on('agent/pre-step', async ({ agent, signal }, next) => {
      await repair(sessions.get(agent.id), signal);
      return next();
    });
    // Upgrade already-entered idle chats too. Busy agents repair at their next pre-step.
    scope.effect(() => {
      for (const session of sessions.list()) {
        if (scope.get('agents')?.get(session.id)?.status === 'running') continue;
        repair(session).catch(error => {
          if (!controller.signal.aborted) console.error('[harness-qol:mcp] History repair failed:', error.message);
        });
      }
      return async () => {
        controller.abort(new Error('MCP history repair unloaded'));
        await Promise.allSettled([...running.values()]);
      };
    });
  });
  return { status };
}
