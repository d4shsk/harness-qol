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

test('createMessageOperations: edit_sent and get_edits store sent message edits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-edits-ops2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'edits.json');
  const editsStore = createMessageEditsStore(file);

  const agent = { id: 'agent-1', session: { id: 'session-1' } };
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
