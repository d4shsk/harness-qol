import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSideContext, createBtwRuntime, extractBtwAnswer } from '../btw.js';

const message = (role, text) => ({ role, content: [{ type: 'text', text }] });
function fixture(stream) {
  let requests = [];
  const agent = { id: 'test-session' }; // Deliberately no steer/followup/cancel/inject methods.
  const session = { seq: 42, deriveMessages: () => [message('user', 'Build the app'), message('assistant', 'Still working')], requestHeader: () => ({ config: { provider: 'test', model: 'model', reasoningEffort: 'high' } }) };
  const ctx = {
    sessions: { get: () => session },
    llm: {
      prepareCall: async (config, signal, configure) => {
        let cfg = config;
        if (typeof configure === 'function') {
          const fakeModelInfo = {
            reasoning: {
              efforts: [{ id: 'minimal' }, { id: 'low' }, { id: 'high' }],
              defaultEffort: 'high'
            }
          };
          cfg = { ...config, ...configure(config, fakeModelInfo) };
        }
        return { config: cfg, stream: options => { requests.push(options); return stream(options); } };
      }
    }
  };
  return { agent, session, requests, runtime: createBtwRuntime(ctx) };
}

test('context ignores system instructions and reasoning, preserves recent order, and stays bounded', () => {
  const messages = [message('system', 'SECRET INSTRUCTIONS'), message('user', 'old '.repeat(2000)), message('assistant', 'new answer')];
  messages.push({ role: 'assistant', content: [{ type: 'reasoning', text: 'PRIVATE REASONING' }] });
  const text = buildSideContext(messages, 120);
  assert.ok(text.includes('new answer'));
  assert.ok(text.includes('Older context omitted'));
  assert.ok(!text.includes('SECRET INSTRUCTIONS'));
  assert.ok(!text.includes('PRIVATE REASONING'));
  assert.ok(text.length < 180);
});

test('side answer does not drive or cancel the main agent and uses captured route', async () => {
  const f = fixture(async function* () { yield { type: 'text-delta', index: 0, text: 'Side answer' }; yield { type: 'finish', reason: { kind: 'stop' } }; });
  const result = await f.runtime.ask({ agent: f.agent, rawInput: '  Question? ', signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /Side answer/);
  assert.match(result.text, /test\/model/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].reasoningEffort, 'minimal');
  assert.equal(f.requests[0].tools, undefined);
  assert.match(f.requests[0].messages[0].content[0].text, /through_event_seq="41"/);
  assert.match(f.requests[0].messages[0].content[0].text, /Question\?/);
  await f.runtime.dispose();
});

test('empty question and oversized question perform no network calls', async () => {
  const f = fixture(async function* () {});
  for (const rawInput of ['   ', 'x'.repeat(16001)]) {
    const result = await f.runtime.ask({ agent: f.agent, rawInput, signal: new AbortController().signal });
    assert.equal(result.kind, 'error');
  }
  assert.equal(f.requests.length, 0);
  await f.runtime.dispose();
});

test('parallel /btw in same session is refused without blocking the first answer', async () => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const f = fixture(async function* () { await ready; yield { type: 'text-delta', text: 'First' }; yield { type: 'finish', reason: { kind: 'stop' } }; });
  const args = { agent: f.agent, rawInput: 'Question', signal: new AbortController().signal };
  const first = f.runtime.ask(args);
  const second = await f.runtime.ask(args);
  assert.equal(second.kind, 'error');
  release();
  assert.equal((await first).kind, 'success');
  await f.runtime.dispose();
});

test('provider error is explicit, never reported as success', async () => {
  const f = fixture(async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exceeded' } } }; });
  const result = await f.runtime.ask({ agent: f.agent, rawInput: 'Question', signal: new AbortController().signal });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /quota exceeded/);
  await f.runtime.dispose();
});

test('unload aborts only the side request and drains it', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(async function* ({ signal }) {
    started();
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const pending = f.runtime.ask({ agent: f.agent, rawInput: 'Question', signal: new AbortController().signal });
  await ready;
  await f.runtime.dispose();
  assert.equal((await pending).kind, 'error');
  const later = await f.runtime.ask({ agent: f.agent, rawInput: 'Question', signal: new AbortController().signal });
  assert.equal(later.kind, 'error');
});

test('extractBtwAnswer: falls back to reasoning when text-delta is empty', () => {
  assert.equal(extractBtwAnswer('', 'Thinking result with answer'), 'Thinking result with answer');
  assert.equal(extractBtwAnswer('Final answer', 'Internal thinking'), 'Final answer');
  assert.equal(extractBtwAnswer('<think>Thinking</think>\nActual answer', ''), 'Actual answer');
  assert.equal(extractBtwAnswer('<think>Only thought answer</think>', ''), 'Only thought answer');
  assert.equal(extractBtwAnswer('<think>Unfinished thought', ''), 'Unfinished thought');
});

test('btw: recovers answer when model streams only reasoning-delta without text-delta', async () => {
  const f = fixture(async function* () {
    yield { type: 'reasoning-delta', text: 'Here is the explanation generated in thinking block' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const result = await f.runtime.ask({ agent: f.agent, rawInput: 'Question', signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /Here is the explanation generated in thinking block/);
  await f.runtime.dispose();
});
