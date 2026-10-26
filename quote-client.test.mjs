import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Load functions from quote-client.js by evaluating in VM or module wrapper
const code = await readFile(new URL('./quote-client.js', import.meta.url), 'utf8');

// Create sandbox to extract pure functions
const scope = {};
const fn = new Function('scope', `${code};
scope.formatQuoteMarkdown = formatQuoteMarkdown;
scope.truncateQuotePreview = truncateQuotePreview;
scope.splitQuoteAndText = splitQuoteAndText;
scope.clampMenuPosition = clampMenuPosition;
scope.createQuoteStore = createQuoteStore;
scope.createMenuStore = createMenuStore;
scope.getAssistantSelection = getAssistantSelection;
`);
fn(scope);

const {
  formatQuoteMarkdown,
  truncateQuotePreview,
  splitQuoteAndText,
  clampMenuPosition,
  createQuoteStore,
  createMenuStore,
  getAssistantSelection,
} = scope;

test('formatQuoteMarkdown: single-line quote prepends markdown blockquote to draft', () => {
  const result = formatQuoteMarkdown('This is an answer.', 'Can you clarify this?');
  assert.equal(result, '> This is an answer.\n\nCan you clarify this?');
});

test('formatQuoteMarkdown: multi-line quote prefixes every line with blockquote marker', () => {
  const quote = 'Line 1: error in file\nLine 2: stack trace here\nLine 3: finished';
  const draft = 'Why did this fail?';
  const result = formatQuoteMarkdown(quote, draft);
  assert.equal(
    result,
    '> Line 1: error in file\n> Line 2: stack trace here\n> Line 3: finished\n\nWhy did this fail?'
  );
});

test('formatQuoteMarkdown: handles Windows CRLF line endings cleanly', () => {
  const quote = 'First\r\nSecond\r\nThird';
  const result = formatQuoteMarkdown(quote, 'Check this');
  assert.equal(result, '> First\n> Second\n> Third\n\nCheck this');
});

test('formatQuoteMarkdown: empty user draft returns quote ending with newlines', () => {
  const result = formatQuoteMarkdown('Just a quote', '');
  assert.equal(result, '> Just a quote\n\n');
});

test('formatQuoteMarkdown: empty quote returns draft text unchanged', () => {
  const result = formatQuoteMarkdown('', 'Normal prompt');
  assert.equal(result, 'Normal prompt');
  assert.equal(formatQuoteMarkdown('   ', 'Normal prompt'), 'Normal prompt');
});

test('formatQuoteMarkdown: whitespace around quote and draft is properly trimmed', () => {
  const result = formatQuoteMarkdown('  quoted text  ', '  user question  ');
  assert.equal(result, '> quoted text\n\nuser question');
});

test('truncateQuotePreview: limits multiline preview to 2 lines and appends ellipsis', () => {
  const single = 'Just one line';
  assert.equal(truncateQuotePreview(single, 2), 'Just one line');

  const twoLines = 'Line 1\nLine 2';
  assert.equal(truncateQuotePreview(twoLines, 2), 'Line 1\nLine 2');

  const threeLines = 'Line 1\nLine 2\nLine 3';
  assert.equal(truncateQuotePreview(threeLines, 2), 'Line 1\nLine 2…');

  const manyLines = 'Line A\r\nLine B\r\nLine C\r\nLine D';
  assert.equal(truncateQuotePreview(manyLines, 2), 'Line A\nLine B…');
});

test('splitQuoteAndText: extracts quote block and body text from markdown prompt', () => {
  const input = '> Quoted text from agent\n\nUser prompt here';
  const parsed = splitQuoteAndText(input);
  assert.ok(parsed);
  assert.equal(parsed.quote, 'Quoted text from agent');
  assert.equal(parsed.body, 'User prompt here');
});

test('splitQuoteAndText: handles multi-line quote block', () => {
  const input = '> Line 1 of quote\n> Line 2 of quote\n\nMy follow up question';
  const parsed = splitQuoteAndText(input);
  assert.ok(parsed);
  assert.equal(parsed.quote, 'Line 1 of quote\nLine 2 of quote');
  assert.equal(parsed.body, 'My follow up question');
});

test('splitQuoteAndText: handles quote without user body', () => {
  const input = '> Only a quote here';
  const parsed = splitQuoteAndText(input);
  assert.ok(parsed);
  assert.equal(parsed.quote, 'Only a quote here');
  assert.equal(parsed.body, '');
});

test('splitQuoteAndText: returns null for plain non-quoted message', () => {
  assert.equal(splitQuoteAndText('Just a plain user message'), null);
  assert.equal(splitQuoteAndText('Some text with > inside, but not starting with >'), null);
});

test('createQuoteStore: stores and clears quotes per session independently', () => {
  const store = createQuoteStore();

  assert.equal(store.get('session-1'), null);

  let notified = 0;
  const unsubscribe = store.subscribe(() => { notified++; });

  store.set('session-1', 'Quote for session 1');
  assert.equal(store.get('session-1'), 'Quote for session 1');
  assert.equal(store.get('session-2'), null); // Session 2 is isolated
  assert.equal(notified, 1);

  store.set('session-2', 'Quote for session 2');
  assert.equal(store.get('session-2'), 'Quote for session 2');
  assert.equal(notified, 2);

  store.clear('session-1');
  assert.equal(store.get('session-1'), null);
  assert.equal(store.get('session-2'), 'Quote for session 2');
  assert.equal(notified, 3);

  unsubscribe();
  store.clear('session-2');
  assert.equal(notified, 3); // No more notifications after unsubscribe
});

test('createQuoteStore: tracks active session id', () => {
  const store = createQuoteStore();
  assert.equal(store.getActiveSessionId(), null);
  store.setActiveSessionId('session-xyz');
  assert.equal(store.getActiveSessionId(), 'session-xyz');
});

test('createMenuStore: controls context menu state and notifies subscribers', () => {
  const store = createMenuStore();
  assert.deepEqual(store.get(), { open: false, x: 0, y: 0, text: '', sessionId: null });

  let notifications = 0;
  const unsub = store.subscribe(() => { notifications++; });

  store.open({ x: 100, y: 200, text: 'Quoted snippet', sessionId: 'sess-1' });
  assert.deepEqual(store.get(), {
    open: true,
    x: 100,
    y: 200,
    text: 'Quoted snippet',
    sessionId: 'sess-1',
  });
  assert.equal(notifications, 1);

  store.close();
  assert.equal(store.get().open, false);
  assert.equal(notifications, 2);

  unsub();
});

test('clampMenuPosition: clamps within screen bounds', () => {
  const env = { innerWidth: 1000, innerHeight: 800 };

  // Normal inside position
  assert.deepEqual(clampMenuPosition(300, 400, 160, 80, env), { x: 300, y: 400 });

  // Exceeds right edge
  const rightOverflow = clampMenuPosition(950, 400, 160, 80, env);
  assert.equal(rightOverflow.x, 1000 - 160 - 8); // 832
  assert.equal(rightOverflow.y, 400);

  // Exceeds bottom edge
  const bottomOverflow = clampMenuPosition(300, 780, 160, 80, env);
  assert.equal(bottomOverflow.x, 300);
  assert.equal(bottomOverflow.y, 800 - 80 - 8); // 712

  // Negative / off-screen left and top
  const minClamped = clampMenuPosition(-20, -50, 160, 80, env);
  assert.equal(minClamped.x, 8);
  assert.equal(minClamped.y, 8);
});

test('getAssistantSelection: returns text and assistant element when valid selection inside assistant step', () => {
  const mockAssistant = {
    matches: selector => selector.includes('assistant-step'),
    closest: selector => selector.includes('assistant-step') ? mockAssistant : null,
  };

  const mockTextNode = {
    nodeType: 3, // TEXT_NODE
    parentElement: mockAssistant,
  };

  const mockRange = {
    commonAncestorContainer: mockTextNode,
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 200, height: 20, bottom: 120 }),
  };

  const mockEnv = {
    getSelection: () => ({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => '   Selected assistant explanation   ',
      getRangeAt: () => mockRange,
    }),
  };

  const result = getAssistantSelection(mockEnv);
  assert.ok(result);
  assert.equal(result.text, 'Selected assistant explanation');
  assert.equal(result.assistantEl, mockAssistant);
});

test('getAssistantSelection: returns null for collapsed selection or selection outside assistant message', () => {
  // Collapsed selection
  const collapsedEnv = {
    getSelection: () => ({
      isCollapsed: true,
      rangeCount: 1,
      toString: () => '',
    }),
  };
  assert.equal(getAssistantSelection(collapsedEnv), null);

  // Selection inside user message (not assistant)
  const mockUserEl = {
    closest: () => null,
  };
  const outsideEnv = {
    getSelection: () => ({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'User prompt text',
      getRangeAt: () => ({
        commonAncestorContainer: {
          nodeType: 1,
          parentElement: null,
          closest: () => null,
        },
      }),
    }),
  };
  assert.equal(getAssistantSelection(outsideEnv), null);
});
