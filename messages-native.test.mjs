import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMessageOperations, sentMessageState, textOfContent } from './messages.js';

// Optional integration with the installed Harness, without making the plugin's
// portable test suite depend on an installation or making any provider calls.
test('native Session: edit changes derived context once, survives replay and preserves fork attachments', {
  skip: !process.env.DSH_TEST_SESSION_MODULE,
}, async () => {
  const { Session, buildForkSeed } = await import(process.env.DSH_TEST_SESSION_MODULE);
  const source = Session.create('source');
  source.append('system/message', { message: {
    id: 'system-1', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'System' }],
  } }, { surfaceOp: 'append' });
  const image = { type: 'image', attachment: { attachmentId: 'image-1', width: 32, height: 32 } };
  const file = { type: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt' } };
  const original = source.append('user/message', {
    id: 'message-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original' }, image, file],
  }, { surfaceOp: 'append' });
  const answer = source.append('assistant/message', { turn: 1, step: 1, stream: [], message: {
    id: 'answer-1', role: 'assistant', source: { kind: 'model', provider: 'test', model: 'fixture' },
    content: [{ type: 'text', text: 'Existing reply' }],
  } }, { surfaceOp: 'append' });
  const followUp = source.append('user/message', {
    id: 'message-2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original follow-up' }],
  }, { surfaceOp: 'append' });
  const ops = createMessageOperations({}, { isModuleEnabled: () => true }, { load: async () => {} });
  const agent = { id: source.id, status: 'idle', session: source };
  assert.equal((await ops.run(agent, { action: 'edit_sent', seq: original.seq, text: 'Edited' })).ok, true);
  assert.equal(source.deriveMessages().length, 4);
  assert.equal(textOfContent(source.deriveMessages()[2].content), 'Existing reply');
  assert.equal(source.snapshotEvents()[answer.seq], answer);
  assert.equal(textOfContent(source.deriveMessages()[1].content), 'Edited');
  assert.equal(textOfContent(original.data.content), 'Original');
  assert.deepEqual(source.deriveMessages()[1].content.slice(1), [image, file]);
  const length = source.snapshotEvents().length;
  assert.equal((await ops.run(agent, { action: 'edit_sent', seq: original.seq, text: 'Edited' })).ok, true);
  assert.equal(source.snapshotEvents().length, length);
  assert.equal((await ops.run(agent, { action: 'edit_sent', seq: original.seq, text: 'Second edit' })).ok, true);
  assert.equal(textOfContent(source.deriveMessages()[1].content), 'Second edit');
  const replay = Session.create('replayed', source.snapshotEvents());
  assert.equal(textOfContent(replay.deriveMessages()[1].content), 'Second edit');
  assert.equal(sentMessageState(replay).edits[String(original.seq)], 'Second edit');

  const child = Session.create('child', buildForkSeed(source.snapshotEvents(), original.seq));
  assert.equal((await ops.run({ id: child.id, status: 'idle', session: child }, {
    action: 'edit_sent', seq: original.seq, text: 'Child edit',
  })).ok, true);
  assert.equal(textOfContent(child.deriveMessages()[1].content), 'Child edit');
  assert.deepEqual(child.deriveMessages()[1].content.slice(1), [image, file]);
  assert.equal(textOfContent(source.deriveMessages()[1].content), 'Second edit');

  // Exercise the complete UI operation against real Session objects: earlier
  // edits made after the selected historical cut must not be lost in a fork.
  const clientCode = await readFile(new URL('./messages-client.js', import.meta.url), 'utf8');
  const createChat = new Function(`${clientCode}; return qolCreateEditedChat;`)();
  let completeChild;
  const ctx = { sessions: {
    scope: id => ({ remote: { commands: { execute: async line => {
      const session = id === source.id ? source : completeChild;
      const result = await ops.run({ id, session, status: 'idle' }, JSON.parse(line.slice(line.indexOf(' ') + 1)));
      return { ok: true, value: { result: { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) } } };
    } } } }),
    fork: async options => {
      completeChild = Session.create('complete-child', buildForkSeed(source.snapshotEvents(), options.atSeq));
      options.onCreated(completeChild.id);
      return completeChild.id;
    },
    using: async (_id, _options, operation) => operation(),
  }, uiWorkspace: { openSession: id => assert.equal(id, completeChild.id) } };
  await createChat(ctx, source.id, followUp.seq, 'message-2', 'Edited follow-up', {});
  assert.equal(textOfContent(completeChild.deriveMessages()[1].content), 'Second edit');
  assert.equal(textOfContent(completeChild.deriveMessages()[3].content), 'Edited follow-up');
  assert.equal(textOfContent(source.deriveMessages()[3].content), 'Original follow-up');

  // Test regeneration in the same chat: editing the latest request removes its answer from active surface
  const followups = [];
  const followUpAgent = {
    id: source.id, status: 'idle', session: source,
    followup: msg => followups.push(msg),
    inbox: { nextTurn: [] },
  };
  // Append an assistant answer to the follow-up
  const followUpAnswer = source.append('assistant/message', { turn: 2, step: 1, stream: [], message: {
    id: 'answer-2', role: 'assistant', source: { kind: 'model', provider: 'test', model: 'fixture' },
    content: [{ type: 'text', text: 'Follow-up answer' }],
  } }, { surfaceOp: 'append' });
  assert.equal(source.deriveMessages().length, 5);

  const regenRes = await ops.run(followUpAgent, {
    action: 'edit_sent', seq: followUp.seq, text: 'Regenerated question', generate: true,
  });
  assert.equal(regenRes.ok, true);
  assert.equal(regenRes.data.generationStarted, true);
  assert.equal(followups.length, 1);
  assert.equal(followups[0].source.kind, 'runtime-context');

  // Active derived messages should now have ONLY 4 messages: system, message-1, answer-1, and edited followUp!
  // The old followUpAnswer is gone from the derived context!
  assert.equal(source.deriveMessages().length, 4);
  assert.equal(textOfContent(source.deriveMessages()[3].content), 'Regenerated question');
  assert.deepEqual(sentMessageState(source).regenerations, [{ startSeq: followUp.seq + 1, endSeq: followUpAnswer.seq }]);
});
