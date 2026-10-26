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
`);
fn(scope);

const {
  createMessageEditsClientStore,
  qolExtractMessageText,
  qolExtractAttachments,
  qolBuildEditedContent,
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
