import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { admitMcpImage, admitMcpResult, renderMcpResult, isImageAttachment, needsMcpImageRepair } from './mcp-content.js';
import { MCP_REPAIR_KEY, mcpImageRepairProjection, repairMcpSession, registerMcpHistoryRepair } from './mcp-history.js';
import { createMcpManager } from './mcp.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNFUAAAAASUVORK5CYII=';
const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 68, width: 1, height: 1 };
const raw = { type: 'image', data: png, mimeType: 'image/png' };
function storage() {
  const saved = [];
  return { saved, imageLimits: { maxImageBytes: 1000 }, async saveImage(input) { saved.push(input); return ref; } };
}

// This is the consumer contract that crashed: every rendered image must have a durable reference.
function readRequestImages(blocks) { return blocks.filter(b => b.type === 'image').map(b => b.attachment.attachmentId); }

test('MCP screenshot bytes are durably saved before render; raw base64 never reaches Session', async () => {
  const attachments = storage();
  let release;
  attachments.saveImage = input => new Promise(resolve => { attachments.saved.push(input); release = () => resolve(ref); });
  let finished = false;
  const original = { content: [{ type: 'text', text: 'Screenshot' }, raw], structuredContent: { success: true } };
  const task = admitMcpResult(original, attachments).then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false, 'admission awaits durable storage');
  release();
  const value = await task;
  assert.deepEqual(attachments.saved[0], { data: Buffer.from(png, 'base64'), mediaType: 'image/png' });
  assert.deepEqual(value.structuredContent, { success: true });
  assert.equal(original.content[1], raw, 'server response is not mutated');
  const rendered = renderMcpResult({}, value);
  assert.deepEqual(rendered, [{ type: 'text', text: 'Screenshot' }, { type: 'image', attachment: ref }]);
  assert.deepEqual(readRequestImages(JSON.parse(JSON.stringify(rendered))), [ref.attachmentId]);
  assert.equal(JSON.stringify(rendered).includes(png), false);
});

test('renderer safely rejects legacy images, malformed blocks and unsupported binary types', () => {
  for (const value of [null, undefined, 'ok', { content: [null, {}, { type: 'text' }, raw, { type: 'image' }, { type: 'audio', data: png }] }]) {
    const result = renderMcpResult({}, value);
    assert.doesNotThrow(() => readRequestImages(result));
    assert.equal(JSON.stringify(result).includes(png), false);
    assert.ok(result.every(b => b.type !== 'text' || typeof b.text === 'string'));
  }
  const result = renderMcpResult({}, { content: [
    { type: 'resource', resource: { uri: 'memory://x', text: 'Embedded text' } },
    { type: 'resource_link', name: 'Resource', uri: 'memory://x' },
    { type: 'resource', resource: { blob: png } },
  ] });
  assert.equal(result[0].text, 'Embedded text');
  assert.match(result[1].text, /memory:\/\/x/);
  assert.equal(JSON.stringify(result).includes(png), false);
});

test('invalid base64, media and policy violations fall back to explicit text without storage writes', async () => {
  const attachments = storage();
  for (const image of [{ ...raw, data: '%%%' }, { ...raw, data: 'YQ=' }, { ...raw, data: 'YR==' }, { ...raw, data: '' }, { ...raw, data: 'x'.repeat(2000) }, { ...raw, mimeType: 'image/svg+xml' }, { type: 'image' }]) {
    const block = await admitMcpImage(image, attachments);
    assert.equal(block.type, 'text');
    assert.match(block.text, /unavailable/);
  }
  assert.equal(attachments.saved.length, 0);
  assert.equal((await admitMcpImage(raw, null)).type, 'text');
  assert.equal((await admitMcpImage(raw, { saveImage: async () => { throw new Error('bad image'); } })).type, 'text');
  assert.equal((await admitMcpImage(raw, { saveImage: async () => ({ attachmentId: 'bad' }) })).type, 'text');
});

test('valid attachment refs pass through without resaving and never fall back to inline base64', async () => {
  const attachments = storage();
  const block = await admitMcpImage({ type: 'image', attachment: ref }, attachments);
  assert.equal(block.attachment, ref);
  assert.equal(attachments.saved.length, 0);
  assert.equal(needsMcpImageRepair(block), false);
  assert.equal(isImageAttachment(undefined), false);
  assert.equal(needsMcpImageRepair(raw), true);
  assert.equal(needsMcpImageRepair({ type: 'image', attachment: {} }), true);
});

test('per-message image count and byte budgets apply to MCP content', async () => {
  const attachments = storage();
  attachments.imageLimits.maxImagesPerMessage = 1;
  const result = await admitMcpResult({ content: [raw, raw] }, attachments);
  assert.equal(result.content[0].type, 'image');
  assert.equal(result.content[1].type, 'text');
  assert.equal(attachments.saved.length, 1);
  attachments.imageLimits.maxMessageImageBytes = 10;
  assert.equal((await admitMcpResult({ content: [raw] }, attachments)).content[0].type, 'text');
});

test('cancellation is propagated instead of being swallowed as image validation failure', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(admitMcpImage(raw, storage(), controller.signal), /cancelled/);
  const next = new AbortController();
  await assert.rejects(admitMcpImage(raw, { async saveImage() { next.abort(new Error('cancelled during save')); return ref; } }, next.signal), /cancelled during save/);
});

function makeHistory(seed) {
  const events = structuredClone(seed);
  let state = mcpImageRepairProjection.init();
  const nodes = [];
  function fold(event) {
    const op = event.surfaceOp;
    if (op === 'append') nodes.push(event.seq);
    else if (op?.op === 'replace') {
      const start = nodes.indexOf(op.startSeq), end = nodes.indexOf(op.endSeq);
      assert.ok(start >= 0 && end >= start);
      nodes.splice(start, end - start + 1, event.seq);
    }
    state = mcpImageRepairProjection.apply(state, event);
  }
  events.forEach(fold);
  const session = { id: 'poisoned', surface: { nodes }, append(type, data, opts) {
    const event = JSON.parse(JSON.stringify({ seq: events.length, type, data, ...opts }));
    events.push(event); fold(event); return event;
  } };
  const reads = [];
  let flushed = 0;
  const deps = {
    projections: { stateOf(_session, key) { assert.equal(key, MCP_REPAIR_KEY); return state; } },
    query: { async readEvent(input) { reads.push(input.seq); return { target: events[input.seq] }; } },
    attachments: storage(), sessions: { async flush() { flushed++; } },
  };
  return { session, events, deps, reads, get state() { return state; }, get flushed() { return flushed; } };
}
const seed = [
  { seq: 0, type: 'user/message', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Take a screenshot' }] }, surfaceOp: 'append' },
  { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'mcp__agent_browser__screenshot', arguments: '{}' }] } }, surfaceOp: 'append' },
  { seq: 2, type: 'tool/result', data: { turn: 1, step: 1, message: { id: 't1', role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'Saved screenshot' }, raw] } }, surfaceOp: 'append' },
  { seq: 3, type: 'user/message', data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue' }] }, surfaceOp: 'append' },
];

test('legacy poisoned result is replaced in place, preserving all turns, call identities and original audit bytes', async () => {
  const h = makeHistory(seed);
  assert.throws(() => readRequestImages(h.events[2].data.message.content), /attachmentId/);
  assert.deepEqual(h.state.pending, [2]);
  const result = await repairMcpSession(h.session, h.deps);
  assert.deepEqual(result, { sessionId: 'poisoned', messages: 1, images: 1, unavailable: 0 });
  assert.equal(h.events.length, 5);
  assert.deepEqual(h.session.surface.nodes, [0, 1, 4, 3]);
  const repaired = h.events[4];
  assert.equal(repaired.type, 'tool/result');
  assert.equal(repaired.data.message.id, 't1');
  assert.equal(repaired.data.message.toolCallId, 'call-1');
  assert.equal(repaired.data.turn, 1);
  assert.equal(repaired.data.step, 1);
  assert.deepEqual(readRequestImages(repaired.data.message.content), [ref.attachmentId]);
  assert.deepEqual(repaired.sourceEventSeqs, [2]);
  assert.deepEqual(h.events[2], seed[2], 'original audit event is unchanged');
  assert.equal(h.flushed, 1);
  assert.deepEqual(h.state.pending, []);
  await repairMcpSession(h.session, h.deps);
  assert.equal(h.events.length, 5, 'idempotent');
  assert.deepEqual(h.reads, [2], 'no full log scans or repeated legacy reads');
  const replay = makeHistory(h.events);
  assert.deepEqual(replay.session.surface.nodes, [0, 1, 4, 3]);
  assert.deepEqual(replay.state.pending, []);
});

test('ordinary uploaded images are never rewritten; hidden old results are not resurrected', async () => {
  const h = makeHistory(seed);
  h.session.append('tool/result', { ...seed[2].data, message: { ...seed[2].data.message, content: [{ type: 'text', text: 'Already replaced' }] } }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } });
  h.session.append('user/message', { role: 'user', source: { kind: 'user' }, content: [raw] }, { surfaceOp: 'append' });
  const count = h.events.length;
  assert.equal((await repairMcpSession(h.session, h.deps)).messages, 0);
  assert.equal(h.events.length, count);
  assert.equal(h.reads.length, 0);
});

test('unrecoverable old image becomes text without losing surrounding MCP text; PTC image echoes recover too', async () => {
  const ptc = { seq: 0, type: 'user/message', data: { role: 'user', source: { kind: 'ptc-mode' }, content: [{ type: 'text', text: 'PTC output' }, { type: 'image' }] }, surfaceOp: 'append' };
  const h = makeHistory([ptc]);
  const result = await repairMcpSession(h.session, h.deps);
  assert.equal(result.unavailable, 1);
  assert.equal(h.events[1].data.content[0].text, 'PTC output');
  assert.match(h.events[1].data.content[1].text, /unavailable/);
  assert.deepEqual(readRequestImages(h.events[1].data.content), []);
});

test('a concurrent replacement during storage is respected instead of overwriting newer content', async () => {
  const h = makeHistory(seed);
  h.deps.attachments.saveImage = async () => {
    h.session.append('tool/result', { ...seed[2].data, message: { ...seed[2].data.message, content: [{ type: 'text', text: 'Newer replacement' }] } }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } });
    return ref;
  };
  assert.equal((await repairMcpSession(h.session, h.deps)).messages, 0);
  assert.equal(h.events.length, 5);
  assert.equal(h.events[4].data.message.content[0].text, 'Newer replacement');
});

test('repair is registered before steps, preserves next decisions, and unload owns async tasks', async () => {
  const h = makeHistory(seed), listeners = new Map(), disposers = [];
  const services = { sessions: { ...h.deps.sessions, get: () => h.session, list: () => [] }, sessionProjections: { ...h.deps.projections, register: () => () => {} }, sessionQuery: h.deps.query, attachments: h.deps.attachments };
  const scope = { get: key => services[key], effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); }, on: (name, handler) => listeners.set(name, handler) };
  const api = registerMcpHistoryRepair({ inject(_deps, callback) { callback(scope); } });
  const decision = { kind: 'enter', startsRequestSeries: true, messages: [] };
  const output = await listeners.get('agent/pre-step')({ agent: { id: h.session.id } }, async () => decision);
  assert.equal(output, decision);
  assert.equal(api.status().repairs[0].images, 1);
  assert.equal(api.status().active, 0);
  for (const dispose of disposers.reverse()) await dispose();
});

test('real MCP subprocess -> registered tool -> attachment admission -> render has no raw image blocks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-mcp-image-'));
  const definitions = new Map(), attachments = storage();
  const ctx = { get(key) { return key === 'attachments' ? attachments : key === 'tools' ? { register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name); } } : null; } };
  const manager = createMcpManager(ctx, { isModuleEnabled: () => true }, join(dir, 'servers.json'));
  t.after(async () => {
    manager.stopAll();
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('hq-mcp-image-'));
    await rm(dir, { recursive: true, force: true });
  });
  const source = `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const m=JSON.parse(line); if(m.id===undefined)return;
    const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'image-fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'screenshot',inputSchema:{type:'object'}}]}:${JSON.stringify({ content: [{ type: 'text', text: 'Fixture screenshot' }, raw] })};
    console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
  });`;
  const saved = await manager.saveServer({ id: 'image-fixture', command: process.execPath, args: ['-e', source] });
  assert.equal(saved.ok, true);
  const tool = definitions.get('mcp__image-fixture__screenshot');
  assert.ok(tool);
  const value = await tool.execute({}, {});
  const content = tool.output.render({}, value);
  assert.deepEqual(readRequestImages(content), [ref.attachmentId]);
  assert.equal(attachments.saved.length, 1);
  assert.equal(JSON.stringify(content).includes(png), false);
});
