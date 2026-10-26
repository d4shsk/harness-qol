import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  textOfContent,
  attachmentsOfContent,
  createMessageEditsStore,
  createMessageOperations,
} from './messages.js';

test('textOfContent: extracts joined text from content blocks', () => {
  const content = [
    { type: 'text', text: 'Hello ' },
    { type: 'image', attachment: { id: 'img-1' } },
    { type: 'text', text: 'world!' },
  ];
  assert.equal(textOfContent(content), 'Hello world!');
  assert.equal(textOfContent([]), '');
  assert.equal(textOfContent(null), '');
});

test('attachmentsOfContent: extracts image and file attachments', () => {
  const content = [
    { type: 'text', text: 'Hello' },
    { type: 'image', attachment: { attachmentId: 'img-1', name: 'photo.png' } },
    { type: 'file', attachment: { attachmentId: 'file-1', name: 'doc.pdf' } },
  ];
  const attachments = attachmentsOfContent(content);
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].type, 'image');
  assert.equal(attachments[0].attachment.attachmentId, 'img-1');
  assert.equal(attachments[1].type, 'file');
  assert.equal(attachments[1].attachment.attachmentId, 'file-1');
});

test('createMessageEditsStore: persists and retrieves message edits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-edits-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'edits.json');

  const store = createMessageEditsStore(file);
  await store.set('session-1', 'msg-1', 'Updated text');
  await store.set('session-1', 42, 'Seq 42 edited');

  assert.equal(store.get('session-1')['msg-1'], 'Updated text');
  assert.equal(store.get('session-1')['42'], 'Seq 42 edited');
  assert.equal(store.get('session-2')['msg-1'], undefined);

  // Reload from disk
  const reloaded = createMessageEditsStore(file);
  await reloaded.load();
  assert.equal(reloaded.get('session-1')['msg-1'], 'Updated text');
  assert.equal(reloaded.get('session-1')['42'], 'Seq 42 edited');

  await store.clear('session-1');
  assert.deepEqual(store.get('session-1'), {});
});

test('createMessageOperations: list_queue and edit_queue preserve attachments', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-edits-ops-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'edits.json');
  const editsStore = createMessageEditsStore(file);

  const mockImage = { type: 'image', attachment: { attachmentId: 'img-123', name: 'test.png' } };
  const mockFile = { type: 'file', attachment: { attachmentId: 'file-456', name: 'document.pdf' } };

  let replaced = null;
  const mockInbox = {
    nextTurn: [
      {
        id: 'item-1',
        content: [
          { type: 'text', text: 'Original queued text' },
          mockImage,
          mockFile,
        ],
      },
    ],
    nextStep: [],
    replace(itemId, msg) {
      replaced = { itemId, msg };
    },
  };

  const agent = {
    id: 'agent-1',
    session: { id: 'session-1' },
    inbox: mockInbox,
  };

  const ctx = {
    agents: { get: () => agent },
  };

  const settings = {
    isModuleEnabled: id => id === 'messages',
  };

  const ops = createMessageOperations(ctx, settings, editsStore);

  // 1. List queue
  const listRes = await ops.run(agent, { action: 'list_queue' });
  assert.equal(listRes.ok, true);
  assert.equal(listRes.data.queue.length, 1);
  assert.equal(listRes.data.queue[0].text, 'Original queued text');
  assert.equal(listRes.data.queue[0].attachments.length, 2);

  // 2. Edit queue preserving attachments
  const editRes = await ops.run(agent, {
    action: 'edit_queue',
    itemId: 'item-1',
    text: 'Revised queued prompt',
  });
  assert.equal(editRes.ok, true);
  assert.equal(editRes.data.text, 'Revised queued prompt');
  assert.equal(editRes.data.attachments.length, 2);

  // Verify that agent.inbox.replace was called with both attachments intact
  assert.ok(replaced);
  assert.equal(replaced.itemId, 'item-1');
  assert.equal(replaced.msg.content[0].text, 'Revised queued prompt');
  assert.equal(replaced.msg.content[1].type, 'image');
  assert.equal(replaced.msg.content[2].type, 'file');
});

function editableSession() {
  const image = { type: 'image', attachment: { attachmentId: 'img-1' } };
  const file = { type: 'file', attachment: { attachmentId: 'file-1' } };
  const events = Array.from({ length: 5 }, (_, seq) => ({ seq, type: 'boundary', data: {} }));
  events.push({ seq: 5, type: 'user/message', surfaceOp: 'append', data: {
    id: 'msg-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original' }, image, file],
  } });
  return {
    id: 'session-1', surface: { nodes: [5] }, events,
    snapshotEvents: () => [...events],
    append(type, data, metadata) {
      assert.equal(type, 'user/message');
      const { startSeq, endSeq } = metadata.surfaceOp;
      const startIndex = this.surface.nodes.indexOf(startSeq);
      const endIndex = this.surface.nodes.indexOf(endSeq);
      assert.notEqual(startIndex, -1);
      assert.notEqual(endIndex, -1);
      const shadowed = this.surface.nodes.slice(startIndex, endIndex + 1);
      assert.deepEqual(metadata.sourceEventSeqs, shadowed);
      const event = { seq: events.length, type, data, ...metadata };
      this.surface.nodes.splice(startIndex, shadowed.length, event.seq);
      events.push(event);
      return event;
    },
  };
}

test('createMessageOperations: edit_sent replaces the surface in the same session, not another prompt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-edits-ops2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'edits.json');
  const editsStore = createMessageEditsStore(file);

  const session = editableSession();
  const original = session.snapshotEvents()[5];
  const agent = { id: 'session-1', session, status: 'idle' };
  const ctx = { agents: { get: () => agent } };
  const settings = { isModuleEnabled: () => true };
  const ops = createMessageOperations(ctx, settings, editsStore);

  const editRes = await ops.run(agent, {
    action: 'edit_sent',
    seq: 5,
    text: 'Edited past message',
  });
  assert.equal(editRes.ok, true);
  assert.equal(editRes.data.key, '5');
  assert.equal(editRes.data.text, 'Edited past message');

  const getRes = await ops.run(agent, { action: 'get_edits' });
  assert.equal(getRes.ok, true);
  assert.equal(getRes.data.edits['5'], 'Edited past message');
  assert.equal(getRes.data.edits['msg-1'], 'Edited past message');
  assert.equal(editRes.data.applied, true);
  assert.equal(session.id, 'session-1');
  assert.equal(original.data.content[0].text, 'Original');
  const replacement = session.snapshotEvents().at(-1);
  assert.deepEqual(session.surface.nodes, [replacement.seq]);
  assert.deepEqual(replacement.data.content.slice(1), original.data.content.slice(1));

  // Retries are idempotent. Another edit targets the current replacement, not
  // the now-shadowed original event; listing does not duplicate the message.
  await ops.run(agent, { action: 'edit_sent', seq: 5, text: 'Edited past message' });
  assert.equal(session.snapshotEvents().length, 7);
  assert.equal((await ops.run(agent, { action: 'edit_sent', messageId: 'msg-1', text: '  Second edit\n' })).ok, true);
  const list = await ops.run(agent, { action: 'list_sent' });
  assert.equal(list.data.messages.length, 1);
  assert.equal(list.data.messages[0].text, '  Second edit\n');
  assert.equal(list.data.messages[0].seq, 5);
  assert.equal(list.data.messages[0].edited, true);
});

test('createMessageOperations: edit_sent with generate:true regenerates the latest user request and shadows old response', async () => {
  const followups = [];
  const session = editableSession();
  const assistantEvent = { seq: 6, type: 'assistant/message', surfaceOp: 'append', data: {
    turn: 1, step: 1, message: { id: 'ans-1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'Old response' }] },
  } };
  session.events.push(assistantEvent);
  session.surface.nodes.push(6);

  const agent = {
    id: 'session-1', session, status: 'idle',
    followup: msg => followups.push(msg),
    inbox: { nextTurn: [] },
  };
  const ops = createMessageOperations({}, { isModuleEnabled: () => true }, { load: async () => {}, get: () => ({}), set: async () => ({}) });

  const res = await ops.run(agent, {
    action: 'edit_sent', seq: 5, text: 'Updated prompt', generate: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.generationStarted, true);
  assert.equal(followups.length, 1);
  assert.equal(followups[0].source.kind, 'runtime-context');

  // Surface should now only have the replacement node (shadowed both 5 and 6)
  const currentEvents = session.snapshotEvents();
  const replacement = currentEvents.at(-1);
  assert.deepEqual(session.surface.nodes, [replacement.seq]);
  assert.deepEqual(replacement.data.source.qolRegeneration, { startSeq: 6, endSeq: 6 });

  // Multiple clicks with identical text should NOT send duplicate followups
  agent.inbox.nextTurn.push(followups[0]);
  const repeat = await ops.run(agent, {
    action: 'edit_sent', seq: 5, text: 'Updated prompt', generate: true,
  });
  assert.equal(repeat.ok, true);
  assert.equal(followups.length, 1);
});

test('createMessageOperations: editing an earlier message with generate:true shadows all subsequent turns', async () => {
  const followups = [];
  const session = editableSession();
  // We have user message 1 at seq 5. Now add answer 1 (6), user message 2 (7), answer 2 (8)
  const events = [
    { seq: 6, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'ans-1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'Answer 1' }] } } },
    { seq: 7, type: 'user/message', surfaceOp: 'append', data: { id: 'msg-2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Prompt 2' }] } },
    { seq: 8, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, step: 1, message: { id: 'ans-2', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'Answer 2' }] } } },
  ];
  for (const ev of events) {
    session.events.push(ev);
    session.surface.nodes.push(ev.seq);
  }
  assert.deepEqual(session.surface.nodes, [5, 6, 7, 8]);

  const agent = {
    id: 'session-1', session, status: 'idle',
    followup: msg => followups.push(msg),
    inbox: { nextTurn: [] },
  };
  const ops = createMessageOperations({}, { isModuleEnabled: () => true }, { load: async () => {}, get: () => ({}), set: async () => ({}) });

  // Edit earlier message (seq 5) with generate: true
  const res = await ops.run(agent, {
    action: 'edit_sent', seq: 5, text: 'Rewritten prompt 1', generate: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.generationStarted, true);
  assert.equal(followups.length, 1);

  // Surface should now only have the replacement node (shadowed 5, 6, 7, 8)
  const currentEvents = session.snapshotEvents();
  const replacement = currentEvents.at(-1);
  assert.deepEqual(session.surface.nodes, [replacement.seq]);
  // qolRegeneration covers everything after seq 5 up to seq 8
  assert.deepEqual(replacement.data.source.qolRegeneration, { startSeq: 6, endSeq: 8 });
});

test('sent edits reject running, missing, non-user, invalid and compacted targets', async () => {
  const session = editableSession();
  const agent = { id: 'session-1', session, status: 'idle' };
  const ops = createMessageOperations({}, { isModuleEnabled: () => true }, { load: async () => {} });
  for (const request of [{ seq: 0 }, { seq: 99 }, { seq: -1 }, { seq: 1.5 }, {}, { seq: 5, messageId: 'wrong' }, { seq: 5, text: '   ' }]) {
    const result = await ops.run(agent, { action: 'edit_sent', text: 'new', ...request });
    assert.equal(result.ok, false);
  }
  agent.status = 'running';
  assert.match((await ops.run(agent, { action: 'edit_sent', seq: 5, text: 'new' })).error, /finish/);
  agent.status = 'idle';
  session.surface.nodes = [];
  assert.match((await ops.run(agent, { action: 'edit_sent', seq: 5, text: 'new' })).error, /compacted/);
  assert.equal(session.snapshotEvents().length, 6);
});

test('an unknown explicit session never falls back to editing the caller session', async () => {
  const session = editableSession();
  const ops = createMessageOperations({}, { isModuleEnabled: () => true }, { load: async () => {} });
  const result = await ops.run({ id: session.id, session }, { action: 'edit_sent', sessionId: 'missing', seq: 5, text: 'new' });
  assert.equal(result.ok, false);
  assert.equal(session.snapshotEvents().length, 6);
});

test('createMessageOperations: respects messages disabled setting', async t => {
  const agent = { id: 'agent-1', session: { id: 'session-1' } };
  const ctx = { agents: { get: () => agent } };
  const settings = { isModuleEnabled: () => false };
  const ops = createMessageOperations(ctx, settings);

  const res = await ops.run(agent, { action: 'list_queue' });
  assert.equal(res.ok, false);
  assert.match(res.error, /disabled|отключён/i);
});
