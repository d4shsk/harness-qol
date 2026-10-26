import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = await readFile(new URL('./images-client.js', import.meta.url), 'utf8');
const helper = vm.runInNewContext(`${source}\n({qolImageFit,qolImagePngBlob,qolCopyImage})`, { Promise, Error });

function imageFixture({ conversionError, blob = { type: 'image/png', bytes: 'actual pixels' } } = {}) {
  const calls = [];
  const canvas = {
    width: 0, height: 0,
    getContext(type) { calls.push(['context', type]); return { drawImage(image, x, y) {
      calls.push(['draw', image, x, y]);
      if (conversionError) throw conversionError;
    } }; },
    toBlob(done, type) { calls.push(['encode', type, this.width, this.height]); done(blob); },
  };
  const image = { complete: true, naturalWidth: 2048, naturalHeight: 1536,
    ownerDocument: { createElement(tag) { assert.equal(tag, 'canvas'); return canvas; } },
  };
  return { image, canvas, calls, blob };
}

function clipboardFixture(write) {
  return { navigator: { clipboard: { write } }, ClipboardItem: class {
    constructor(data) { this.data = data; }
  } };
}

test('single-image fit preserves 240px long edge and never upscales', () => {
  const wide = helper.qolImageFit({ width: 2048, height: 1024 });
  assert.equal(wide.width, 240); assert.equal(wide.height, 120);
  const small = helper.qolImageFit({ width: 80, height: 40 });
  assert.equal(small.width, 80); assert.equal(small.height, 40);
  assert.equal(helper.qolImageFit({ width: 20, height: 2000 }).objectPosition, 'center top');
  assert.equal(helper.qolImageFit({ width: 2000, height: 20 }).objectPosition, 'left center');
});

test('conversion copies full intrinsic resolution as PNG, not the thumbnail or URL', async () => {
  const fixture = imageFixture();
  assert.equal(await helper.qolImagePngBlob(fixture.image), fixture.blob);
  const encode = fixture.calls.find(call => call[0] === 'encode');
  assert.deepEqual(encode, ['encode', 'image/png', 2048, 1536]);
  assert.equal(fixture.canvas.width, 0); assert.equal(fixture.canvas.height, 0);
});

test('write is initiated synchronously in user gesture with promise-backed PNG item', async () => {
  const fixture = imageFixture();
  let called = false;
  let copied;
  const pending = helper.qolCopyImage(fixture.image, clipboardFixture(items => {
    called = true;
    assert.equal(items.length, 1);
    assert.deepEqual(Object.keys(items[0].data), ['image/png']);
    return items[0].data['image/png'].then(blob => { copied = blob; });
  }));
  assert.equal(called, true);
  await pending;
  assert.equal(copied, fixture.blob);
});

test('unsupported clipboard fails explicitly', async () => {
  await assert.rejects(helper.qolCopyImage(imageFixture().image, {}), /unavailable/);
});

test('clipboard permission denial is propagated for visible UI error', async () => {
  const denied = new Error('NotAllowedError: denied');
  await assert.rejects(helper.qolCopyImage(imageFixture().image, clipboardFixture(() => Promise.reject(denied))), error => error === denied);
});

test('unloaded images and failed PNG encoding reject', async () => {
  const fixture = imageFixture();
  fixture.image.complete = false;
  await assert.rejects(helper.qolImagePngBlob(fixture.image), /not loaded/);
  await assert.rejects(helper.qolImagePngBlob(imageFixture({ blob: null }).image), /conversion failed/);
});

test('tainted canvas security failure is propagated through clipboard item', async () => {
  const denied = new Error('SecurityError: tainted canvas');
  const fixture = imageFixture({ conversionError: denied });
  await assert.rejects(helper.qolCopyImage(fixture.image, clipboardFixture(items => items[0].data['image/png'])), error => error === denied);
});

test('synchronous clipboard failure becomes a rejected operation', async () => {
  await assert.rejects(helper.qolCopyImage(imageFixture().image, clipboardFixture(() => { throw new Error('Clipboard denied'); })), /Clipboard denied/);
});
