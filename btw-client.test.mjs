import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = await readFile(new URL('./btw-client.js', import.meta.url), 'utf8');
const api = vm.runInNewContext(`${source}\n({qolBtwSafeHref,qolBtwInline,qolBtwMarkdown,qolBtwPresentation})`, { URL });
const plain = value => JSON.parse(JSON.stringify(value));

test('pending question comes from exact CommandNode.args before any result exists', () => {
  assert.deepEqual(plain(api.qolBtwPresentation({ name: 'btw', args: 'Почему **это** работает?\nИ когда?', outcome: null })), {
    question: 'Почему **это** работает?\nИ когда?', state: 'pending', answer: '',
  });
});

test('settlement and replay preserve recorded question and answer without client state', () => {
  const node = { name: 'btw', args: 'Что произошло?', outcome: { kind: 'success', text: '**Ответ**\n\n- Первый\n- Второй' } };
  const before = structuredClone(node);
  assert.deepEqual(plain(api.qolBtwPresentation(node)), { question: node.args, state: 'success', answer: node.outcome.text });
  assert.deepEqual(plain(api.qolBtwPresentation(JSON.parse(JSON.stringify(node)))), plain(api.qolBtwPresentation(node)));
  assert.deepEqual(node, before);
});

test('legacy diagnostic footer is hidden for both fresh answers and replay', () => {
  const footer = '— /btw · openai-codex/gpt-6.1-sol · снимок до события 811. Основная задача не прерывалась.';
  const node = { args: 'Вопрос', outcome: { kind: 'success', text: '**Ответ**\n\n' + footer } };
  assert.equal(api.qolBtwPresentation(node).answer, '**Ответ**');
  assert.equal(api.qolBtwPresentation(JSON.parse(JSON.stringify(node))).answer, '**Ответ**');
  assert.ok(node.outcome.text.endsWith(footer), 'committed history is not rewritten');
  assert.equal(api.qolBtwPresentation({ outcome: { kind: 'success', text: 'Обычный ответ без подписи' } }).answer, 'Обычный ответ без подписи');
  const middle = 'Цитата: ' + footer + '\nПродолжение';
  assert.equal(api.qolBtwPresentation({ outcome: { kind: 'success', text: middle } }).answer, middle);
});

test('error answers are retained, not shown as success', () => {
  assert.deepEqual(plain(api.qolBtwPresentation({ args: 'Вопрос', outcome: { kind: 'error', text: 'Timeout' } })), {
    question: 'Вопрос', state: 'error', answer: 'Timeout',
  });
});

test('older commands without recorded args explicitly report absence, never fabricate input', () => {
  assert.equal(api.qolBtwPresentation({ args: null, outcome: { kind: 'success', text: 'Old answer' } }).question, null);
  assert.equal(api.qolBtwPresentation({ args: {}, outcome: {} }).question, null);
});

test('inline Markdown supports bold code links and ordinary text', () => {
  assert.deepEqual(plain(api.qolBtwInline('Текст **важный** и `x < 1` [док](https://example.com/doc).')), [
    { kind: 'text', text: 'Текст ' }, { kind: 'strong', text: 'важный' }, { kind: 'text', text: ' и ' },
    { kind: 'code', text: 'x < 1' }, { kind: 'text', text: ' ' },
    { kind: 'link', text: 'док', href: 'https://example.com/doc' }, { kind: 'text', text: '.' },
  ]);
});

test('unsafe protocols and hidden control characters never become links', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', '//evil.test', '/relative', 'https://good.test\n@evil.test', 'java\tscript:evil', 'vbscript:test']) {
    assert.equal(api.qolBtwSafeHref(href), null, href);
  }
  assert.equal(api.qolBtwSafeHref('<https://example.com>'), 'https://example.com/');
  assert.equal(api.qolBtwSafeHref('mailto:hello@example.com'), 'mailto:hello@example.com');
  assert.equal(api.qolBtwSafeHref('HTTPS://example.com'), 'https://example.com/');
  assert.equal(api.qolBtwInline('[unsafe](data:text/html,hello)')[0].kind, 'text');
});

test('HTML remains text and unsupported syntax is not discarded', () => {
  const value = '<script>alert(1)</script> &lt;img&gt;\n| a | b |\n|---|---|';
  const result = plain(api.qolBtwMarkdown(value));
  assert.deepEqual(result, [{ kind: 'paragraph', content: [{ kind: 'text', text: value }] }]);
});

test('paragraph headings and ordered/unordered lists have distinct semantic blocks', () => {
  const result = plain(api.qolBtwMarkdown('# Заголовок\r\n\r\nПервая строка\r\nВторая\r\n\r\n- **Один**\r\n- Два\r\n\r\n3. Три\r\n4. Четыре'));
  assert.deepEqual(result.map(x => x.kind), ['heading', 'paragraph', 'list', 'list']);
  assert.equal(result[0].content[0].text, 'Заголовок');
  assert.equal(result[1].content[0].text, 'Первая строка\nВторая');
  assert.equal(result[2].ordered, false);
  assert.equal(result[2].items[0][0].kind, 'strong');
  assert.equal(result[3].ordered, true); assert.equal(result[3].start, 3);
});

test('fenced code preserves HTML and Markdown literally, supports backticks and tildes', () => {
  for (const mark of ['```', '~~~']) {
    assert.deepEqual(plain(api.qolBtwMarkdown(`${mark}js\n<script>\n**literal**\n${mark}`)), [
      { kind: 'code', language: 'js', text: '<script>\n**literal**' },
    ]);
  }
  assert.deepEqual(plain(api.qolBtwMarkdown('```txt\nunclosed')), [{ kind: 'code', language: 'txt', text: 'unclosed' }]);
});

test('malformed inline syntax and empty results remain total', () => {
  assert.deepEqual(plain(api.qolBtwMarkdown(null)), []);
  assert.deepEqual(plain(api.qolBtwInline('**unfinished ` [broken](')), [{ kind: 'text', text: '**unfinished ` [broken](' }]);
  assert.equal(api.qolBtwPresentation(undefined).state, 'pending');
  assert.equal(api.qolBtwPresentation({ outcome: { kind: 'success' } }).answer, '');
});
