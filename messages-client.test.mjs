import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('./messages-client.js', import.meta.url), 'utf8');

const scope = {};
const fn = new Function('scope', `${code};
scope.createMessageEditsClientStore = createMessageEditsClientStore;
scope.qolExtractMessageText = qolExtractMessageText;
scope.qolExtractAttachments = qolExtractAttachments;
scope.qolBuildEditedContent = qolBuildEditedContent;
scope.qolPrepareUserContent = qolPrepareUserContent;
scope.qolQueueDockLayout = qolQueueDockLayout;
scope.qolUpdateQueue = qolUpdateQueue;
scope.qolSelectQueue = qolSelectQueue;
scope.qolEditQueuedMessage = qolEditQueuedMessage;
scope.qolExecuteMessageCommand = qolExecuteMessageCommand;
`);
fn(scope);

const {
  createMessageEditsClientStore,
  qolExtractMessageText,
  qolExtractAttachments,
  qolBuildEditedContent,
  qolPrepareUserContent,
  qolUpdateQueue,
  qolSelectQueue,
  qolEditQueuedMessage,
  qolExecuteMessageCommand,
} = scope;

test('createMessageEditsClientStore: set, get, remove and subscribe', () => {
  const store = createMessageEditsClientStore();
  let notifications = 0;
  const unsub = store.subscribe(() => { notifications++; });

  store.set('s1', '10', 'New text');
  assert.equal(store.get('s1', '10'), 'New text');
  assert.equal(store.has('s1', '10'), true);
  assert.equal(store.has('s1', '99'), false);
  assert.equal(notifications, 1);

  store.remove('s1', '10');
  assert.equal(store.has('s1', '10'), false);
  assert.equal(notifications, 2);

  unsub();
});

test('qolExtractMessageText: extracts plain text from blocks', () => {
  const blocks = [
    { type: 'text', text: 'Part 1, ' },
    { type: 'image', attachment: {} },
    { type: 'text', text: 'Part 2' },
  ];
  assert.equal(qolExtractMessageText(blocks), 'Part 1, Part 2');
  assert.equal(qolExtractMessageText([]), '');
});

test('qolExtractAttachments: extracts image and file attachments', () => {
  const blocks = [
    { type: 'text', text: 'Prompt' },
    { type: 'image', attachment: { id: 'img1' } },
    { type: 'file', attachment: { id: 'file1' } },
  ];
  const list = qolExtractAttachments(blocks);
  assert.equal(list.length, 2);
  assert.equal(list[0].type, 'image');
  assert.equal(list[1].type, 'file');
});

test('user content Factory receives image sources and file references, not raw blocks', () => {
  const image = Object.freeze({ attachmentId: 'sha256:9930b04f', name: 'image.png', width: 1223, height: 337 });
  const file = Object.freeze({ attachmentId: 'file-1', name: 'notes.txt' });
  const secondImage = Object.freeze({ attachmentId: 'image-2', width: 32, height: 64 });
  const unknown = Object.freeze({ type: 'future-block', value: 42 });
  const content = Object.freeze([
    Object.freeze({ type: 'text', text: 'видишь ' }),
    Object.freeze({ type: 'image', attachment: image }),
    Object.freeze({ type: 'file', attachment: file }),
    Object.freeze({ type: 'image', attachment: secondImage }),
    Object.freeze({ type: 'text', text: 'картинку?' }), unknown,
  ]);
  const prepared = qolPrepareUserContent(content);
  assert.equal(prepared.text, 'видишь картинку?');
  assert.deepEqual(prepared.attachments, [
    { type: 'image', image: { attachment: image } },
    { type: 'file', file },
    { type: 'image', image: { attachment: secondImage } },
  ]);
  // These are the exact accesses used by native UserContent and the image gallery.
  assert.equal(prepared.attachments[0].image.attachment, image);
  assert.equal(prepared.attachments[1].file, file);
  assert.deepEqual(prepared.extraBlocks, [unknown]);
  const labels = { 'session-1': 'Referenced chat' };
  const edited = qolPrepareUserContent(content, 'Edited caption', labels);
  assert.equal(edited.text, 'Edited caption');
  assert.deepEqual(edited.attachments, prepared.attachments);
  assert.equal(edited.referenceLabels, labels);
});

test('image-only messages survive preparation; empty content is supported', () => {
  const image = { attachmentId: 'image-only' };
  const prepared = qolPrepareUserContent([{ type: 'image', attachment: image }]);
  assert.equal(prepared.text, '');
  assert.equal(prepared.attachments[0].image.attachment, image);
  assert.deepEqual(qolPrepareUserContent(undefined), { text: '', attachments: [], extraBlocks: [] });
});

test('both normal and disabled message paths pass the shared prepared content and loader', () => {
  assert.match(code, /const prepared = React\.useMemo\(\(\) => qolPrepareUserContent\(/);
  const calls = [...code.matchAll(/renderFactorySlot\('conversation\.chat\.user\.content', \{([\s\S]*?)\}\)/g)];
  assert.equal(calls.length, 2);
  for (const [, props] of calls) {
    assert.match(props, /content: prepared/);
    assert.match(props, /loadImage,/);
    assert.match(props, /facts,/);
  }
  assert.doesNotMatch(code, /const prepared = \{/);
});

test('queue uses the retained Session API for edit, remove and steering', async () => {
  const calls = [];
  const session = { async updateQueue(...args) { calls.push(args); return { ok: true, value: { accepted: true } }; } };
  const ctx = { sessions: { binding(id) { assert.equal(id, 's1'); return { session }; } } };
  await qolEditQueuedMessage(ctx, 's1', { id: 'q1', content: [{ type: 'text', text: 'old' }] }, 'new\ntext');
  await qolUpdateQueue(ctx, 's1', 'q2', { kind: 'remove' });
  await qolUpdateQueue(ctx, 's1', 'q3', { kind: 'steer' });
  assert.deepEqual(calls, [
    ['q1', { kind: 'edit', content: [{ type: 'text', text: 'new\ntext' }] }],
    ['q2', { kind: 'remove' }], ['q3', { kind: 'steer' }],
  ]);
});

test('queue surfaces RemoteResult failures and does not pretend unavailable actions succeeded', async () => {
  await assert.rejects(qolUpdateQueue({}, 's1', 'q1', { kind: 'remove' }), /Queue unavailable/);
  for (const reply of [{ ok: false, error: { message: 'Already consumed' } }, undefined, { ok: true, value: {} }]) {
    const ctx = { sessions: { binding: () => ({ session: { updateQueue: async () => reply } }) } };
    await assert.rejects(qolUpdateQueue(ctx, 's1', 'q1', { kind: 'remove' }), /Already consumed|Queue update failed/);
  }
});

test('queue shows sending echoes and de-duplicates the Host handoff by rpcId', () => {
  const image = Object.freeze({ previewUrl: 'blob:pending-image' });
  const submission = Object.freeze({ requestId: 'rpc-1', placement: 'queued', text: 'queued text', attachments: [
    { type: 'image', value: image }, { type: 'file', value: { name: 'notes.txt', bytes: 12 } },
  ] });
  const rows = qolSelectQueue(undefined, [submission]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pending, true);
  assert.equal(rows[0].id, 'rpc-1');
  assert.equal(rows[0].content[1].attachment, image);
  const admitted = Object.freeze({ id: 'message-1', source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'text', text: 'queued text' }] });
  assert.deepEqual(qolSelectQueue({ 'next-turn': [admitted] }, [submission]), [admitted]);
  assert.deepEqual(qolSelectQueue({ 'next-turn': [admitted] }, []), [admitted]);
  assert.deepEqual(qolSelectQueue(undefined, []), []);
});

test('queue excludes only locally owned transcript rows, not cold recovered rows or next-step steering', () => {
  const transcript = { id: 'm1', source: { kind: 'user', rpcId: 'transcript-1' } };
  const cold = { id: 'm2', source: { kind: 'user', rpcId: 'old-rpc' } };
  const other = { id: 'm3', source: { kind: 'user' } };
  const submissions = [
    { requestId: 'transcript-1', placement: 'transcript' },
    { requestId: 'steer-1', placement: 'steering' },
  ];
  assert.deepEqual(qolSelectQueue({ 'next-turn': [transcript, cold, other], 'next-step': [{ id: 'steer' }] }, submissions), [cold, other]);
});

test('queue edits with attachments use the shared Host operation, retaining image and file blocks', async () => {
  const { createMessageOperations } = await import('./messages.js');
  const image = { type: 'image', attachment: { attachmentId: 'image-1' } };
  const file = { type: 'file', attachment: { attachmentId: 'file-1' } };
  let row = { id: 'q1', content: [{ type: 'text', text: 'old' }, image, file] };
  const agent = { id: 's1', session: { id: 's1' }, inbox: {
    get nextTurn() { return [row]; }, nextStep: [],
    replace(id, updated) { assert.equal(id, 'q1'); row = updated; },
  } };
  const operations = createMessageOperations({}, { isModuleEnabled: () => true }, { load: async () => {} });
  const ctx = { sessions: { scope(id) {
    assert.equal(id, 's1');
    return { remote: { commands: { async execute(line, attachments) {
      assert.deepEqual(attachments, []);
      assert.ok(line.startsWith('/harness-qol-message-edit '));
      const request = JSON.parse(line.slice(line.indexOf(' ') + 1));
      const result = await operations.run(agent, request);
      return { ok: true, value: { result: { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) } } };
    } } } };
  } } };
  await qolEditQueuedMessage(ctx, 's1', row, 'updated text');
  assert.equal(row.content[0].text, 'updated text');
  assert.equal(row.content[1], image);
  assert.equal(row.content[2], file);
});

test('sending queue rows cannot be edited and command failures stay visible', async () => {
  await assert.rejects(qolEditQueuedMessage({}, 's1', { pending: true }, 'text'), /still sending/);
  for (const result of [undefined, { kind: 'error', text: 'Denied' }, { kind: 'success', text: '{"ok":false,"error":"Missing item"}' }]) {
    const ctx = { sessions: { scope: () => ({ remote: { commands: { execute: async () => ({ ok: true, value: { result } }) } } }) } };
    await assert.rejects(qolExecuteMessageCommand(ctx, 's1', {}), /no result|Denied|Missing item/);
  }
});

test('queue dock is centered and constrained by the native composer geometry', () => {
  const layout = scope.qolQueueDockLayout;
  assert.equal(layout.margin, '0 auto 8px');
  assert.equal(layout.boxSizing, 'border-box');
  assert.equal(layout.minWidth, 0);
  assert.equal(layout.flex, 'none');
  // Evaluate only the length/subtraction expressions, without DOM emulation.
  const length = (expression, column, values) => expression
    .replace(/var\((--[\w-]+), (\d+)px\)/g, (_, name, fallback) => String(values[name] ?? Number(fallback)))
    .replace('100%', String(column)).slice(5, -1)
    .split(' - ').map(Number).reduce((left, right) => left - right);
  const width = (column, card, clearance = 12, inset = 10) => {
    const values = { '--dsh-composer-card-max-width': card, '--dsh-composer-side-clearance': clearance, '--dsh-composer-dock-inset': inset };
    return Math.min(length(layout.width, column, values), length(layout.maxWidth, column, values));
  };
  assert.equal(width(2200, 1190), 1150); // Wide screenshot: never span the full column.
  assert.equal(width(2200, 900), 860); // Follows the user's resized chat/composer.
  assert.equal(width(360, 1190), 296); // Narrow viewport: keeps side clearance.
  assert.equal(width(360, 1190, 8, 6), 320); // Inherits host gutter changes.
  assert.equal(Math.min(length(layout.width, 360, {}), length(layout.maxWidth, 360, {})), 296);
  const dock = code.slice(code.indexOf('function QolQueueDock'));
  assert.match(dock, /'data-harness-qol-queue': true,\s+style: qolQueueDockLayout/);
});

test('bundle defaults to queued busy sends and dock renders actual pending rows', async () => {
  const patch = await readFile(new URL('./cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /busyEnter: queue/);
  assert.doesNotMatch(patch, /busyEnter: steer/);
  const dock = code.slice(code.indexOf('function QolQueueDock'));
  assert.match(dock, /qolSelectQueue\(inbox, pendingSubmissions\)/);
  assert.match(dock, /row\.pending === true \|\| busyId !== null/);
  assert.match(dock, /row\.pending && h\('span'/);
  assert.match(dock, /role: 'alert'/);
  assert.doesNotMatch(dock, /typeof updateQueue|notify\(/);
});

test('qolBuildEditedContent: updates text block while preserving image/file blocks', () => {
  const original = [
    { type: 'text', text: 'Old text' },
    { type: 'image', attachment: { id: 'img-1' } },
    { type: 'file', attachment: { id: 'file-1' } },
  ];
  const edited = qolBuildEditedContent(original, 'New updated text');
  assert.equal(edited.length, 3);
  assert.equal(edited[0].type, 'text');
  assert.equal(edited[0].text, 'New updated text');
  assert.equal(edited[1].type, 'image');
  assert.equal(edited[1].attachment.id, 'img-1');
  assert.equal(edited[2].type, 'file');
  assert.equal(edited[2].attachment.id, 'file-1');
});
