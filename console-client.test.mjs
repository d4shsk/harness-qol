import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./console-client.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source + '\nthis.api = { qolConsoleText, qolConsoleLabel, qolConsoleLogLine, qolConsoleRequest, createQolConsoleVisibility, qolConsoleLayout, registerConsoleClient };', context);
const { qolConsoleText, qolConsoleLabel, qolConsoleLogLine, qolConsoleRequest, createQolConsoleVisibility, qolConsoleLayout, registerConsoleClient } = context.api;

test('console client: log shrinks inside the allocated view instead of pushing controls behind the chat composer', () => {
  const layout = qolConsoleLayout();
  assert.equal(layout.panel.height, '100%');
  assert.equal(layout.panel.maxHeight, '100%');
  assert.equal(layout.panel.boxSizing, 'border-box', 'padding stays inside the allocated height');
  assert.equal(layout.panel.padding, '16px 20px', 'do not double-reserve space for the shell-owned composer');
  assert.equal(layout.panel.display, 'flex');
  assert.equal(layout.panel.overflow, 'hidden');
  assert.equal(layout.card.minHeight, 0);
  assert.equal(layout.card.flex, '1 1 0');
  assert.equal(layout.log.flex, '1 1 0');
  assert.equal(layout.log.height, 'auto');
  assert.equal(layout.log.overflow, 'auto');
  assert.equal(layout.fixed.flexShrink, 0, 'command entry and buttons retain their height');
  assert.doesNotMatch(source, /44dvh|clamp\(220px/, 'log height must not be tied to viewport height');
});

test('console client: output is plain text; ANSI controls are not rendered as HTML', () => {
  assert.equal(qolConsoleText('\x1b[31mRED\x1b[0m\n<script>x</script>'), 'RED\n<script>x</script>');
  assert.equal(qolConsoleText('\x1b]0;title\x07Привет'), 'Привет');
  assert.equal(qolConsoleText(null), '');
});

test('console client: command serializes Unicode and unwraps the shared Host result', async () => {
  let call;
  const ctx = { sessions: { scope: id => ({ remote: { commands: { execute: async (...args) => {
    call = { id, args };
    return { ok: true, value: { result: { kind: 'success', text: JSON.stringify({ ok: true, data: { written: true } }) } } };
  } } } }) } };
  const result = await qolConsoleRequest(ctx, 'owner', { action: 'send', jobId: 'console-id', text: 'say Привет' });
  assert.equal(result.written, true);
  assert.equal(call.id, 'owner');
  assert.deepEqual(JSON.parse(call.args[0].slice('/harness-qol-console '.length)), { action: 'send', jobId: 'console-id', text: 'say Привет' });
  assert.equal(call.args[1].length, 0);
});

test('console client: errors and missing Host generation are explicit', async () => {
  const ctx = reply => ({ sessions: { scope: () => ({ remote: { commands: { execute: async () => reply } } }) } });
  await assert.rejects(qolConsoleRequest({ sessions: { scope: () => undefined } }, 's', {}), /Session unavailable/);
  await assert.rejects(qolConsoleRequest(ctx({ ok: false, error: { message: 'access denied' } }), 's', {}), /access denied/);
  await assert.rejects(qolConsoleRequest(ctx(undefined), 's', {}), /Перезапустите Harness/);
  await assert.rejects(qolConsoleRequest(ctx({ result: { text: JSON.stringify({ ok: false, error: 'stdin closed' }) } }), 's', {}), /stdin closed/);
});

test('console client: additive view registration toggles and disposes without rendering a mock UI', () => {
  let enabled = true, callback, registrations = 0, withdrawals = 0, active = 0;
  const effects = [];
  const ctx = {
    jobs: {}, locale: { register: () => () => {}, bind: () => key => key },
    effect(fn) { effects.push(fn()); },
    slots: {
      inject(name, register) {
        assert.equal(name, 'conversation.session.header.actions');
        const cleanup = register();
        return cleanup;
      },
      register(options) {
        assert.equal(options.id, 'harness-qol-console-visibility');
        assert.equal(options.order, 21);
        registrations++; active++;
        return () => { active--; withdrawals++; };
      },
    },
  };
  const store = { isEnabled: id => { assert.equal(id, 'console'); return enabled; }, subscribe(fn) { callback = fn; return () => { callback = null; }; } };
  const dispose = registerConsoleClient(ctx, {}, store);
  assert.equal(active, 1);
  callback(); assert.equal(registrations, 1);
  enabled = false; callback(); assert.equal(active, 0);
  enabled = true; callback(); assert.equal(active, 1);
  dispose(); assert.equal(active, 0); assert.equal(callback, null); assert.equal(withdrawals, 2);
  for (const effect of effects) effect?.();
  assert.doesNotMatch(source, /require\(['"]@deepseek-ai\//);
  assert.doesNotMatch(source, /document\.body|setInterval|MutationObserver/);
  assert.match(source, /jobs\.observe\(sessionId, id\)/);
  assert.match(source, /jobs\.watchRows\(sessionId\)/);
  assert.doesNotMatch(source, /h\('style'/, 'layout does not depend on CSP-sensitive stylesheet tags');
});

test('console client: hides empty-session tab and reveals first job without opening the view', () => {
  let active = 0, registrations = 0;
  const ctx = { slots: {
    inject(name, callback) { assert.equal(name, 'conversation.view'); return callback(); },
    register(options) {
      assert.equal(options.id, 'harness-qol-console');
      active++; registrations++;
      return () => { active--; };
    },
  } };
  const visibility = createQolConsoleVisibility(ctx, () => null, () => 'Processes');
  const empty = visibility.retain(false);
  assert.equal(active, 0, 'no jobs: no tab registration, not just an empty component');
  empty();
  const running = visibility.retain(true);
  assert.equal(active, 1, 'first job reveals tab');
  const overlapping = visibility.retain(true);
  assert.equal(registrations, 1, 'multiple header lifetimes share a registration');
  running(); assert.equal(active, 1);
  overlapping(); assert.equal(active, 0, 'switching away from populated header removes tab');
  const otherEmpty = visibility.retain(false);
  assert.equal(active, 0, 'jobs in a previously viewed session do not show an empty tab here');
  otherEmpty();
  const newJob = visibility.retain(true);
  visibility.setEnabled(false); assert.equal(active, 0);
  visibility.setEnabled(true); assert.equal(active, 1);
  visibility.dispose(); assert.equal(active, 0);
  newJob(); visibility.retain(true); visibility.setEnabled(true);
  assert.equal(active, 0, 'late effects cannot revive an unloaded feature');
});

test('console client: process labels are concise without losing executable identity', () => {
  assert.equal(qolConsoleLabel({ label: '["cmd.exe","/d","/c","run.bat"]' }), 'run.bat · cmd.exe');
  assert.equal(qolConsoleLabel({ label: '["C:\\\\Java\\\\java.exe","-jar","C:\\\\servers\\\\server.jar"]' }), 'server.jar · java.exe');
  assert.equal(qolConsoleLabel({ label: '["/usr/bin/node","-e","code"]' }), 'node');
  assert.equal(qolConsoleLabel({ label: 'Ordinary background task' }), 'Ordinary background task');
  assert.equal(qolConsoleLabel({ label: '{}', id: 'id' }), '{}');
});

test('console client: log decoration preserves text and recognizes severity', () => {
  for (const level of ['INFO', 'WARN', 'ERROR', 'DEBUG', 'FATAL', 'TRACE']) {
    const original = `[18:31:18] [Server thread/${level}] [Minecraft]: Привет <script>`;
    const line = qolConsoleLogLine(original);
    assert.equal(line.level, level);
    assert.equal(line.prefix + line.body, original);
  }
  const ordinary = qolConsoleLogLine('  indented stack trace');
  assert.equal(ordinary.prefix, '');
  assert.equal(ordinary.body, '  indented stack trace');
  assert.equal(qolConsoleLogLine('').body, '');
});
