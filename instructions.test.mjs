import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  getGlobalInstructionsPath,
  readInstructions,
  writeInstructions,
  appendInstructions,
  createInstructionsOperations,
  registerInstructionsHttp,
  registerInstructions,
  instructionsParameters,
} from './instructions.js';
import { createSettingsState } from './settings-state.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hq-instructions-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('getGlobalInstructionsPath resolves ~/.dsh/AGENTS.md', () => {
  const p = getGlobalInstructionsPath();
  assert.match(p, /\.dsh[\\/]AGENTS\.md$/);
});

test('readInstructions returns empty content for missing file without error', async t => {
  const dir = await tempDir(t);
  const target = join(dir, 'AGENTS.md');
  const res = await readInstructions(target);
  assert.equal(res.ok, true);
  assert.equal(res.exists, false);
  assert.equal(res.content, '');
  assert.equal(res.size, 0);
});

test('writeInstructions creates directory and writes file content', async t => {
  const dir = await tempDir(t);
  const target = join(dir, 'nested', 'AGENTS.md');
  const content = '# My Rules\n- Always use bun\n';
  const res = await writeInstructions(target, content);
  assert.equal(res.ok, true);
  assert.equal(res.exists, true);
  assert.equal(res.content, content);
  assert.ok(res.size > 0);

  const onDisk = await readFile(target, 'utf8');
  assert.equal(onDisk, content);
});

test('appendInstructions initializes new file with header and rule', async t => {
  const dir = await tempDir(t);
  const target = join(dir, 'AGENTS.md');
  const res = await appendInstructions(target, 'Always test before commit');
  assert.equal(res.ok, true);
  assert.equal(res.exists, true);
  assert.match(res.content, /^# Agent Instructions\n\n- Always test before commit\n$/);

  const onDisk = await readFile(target, 'utf8');
  assert.equal(onDisk, res.content);
});

test('appendInstructions appends to existing file with clean spacing', async t => {
  const dir = await tempDir(t);
  const target = join(dir, 'AGENTS.md');
  await writeFile(target, '# Rules\n- First rule\n', 'utf8');

  const res = await appendInstructions(target, 'Second rule');
  assert.equal(res.ok, true);
  assert.equal(res.content, '# Rules\n- First rule\n\n- Second rule\n');

  const onDisk = await readFile(target, 'utf8');
  assert.equal(onDisk, res.content);
});

test('appendInstructions detects and skips duplicate rules', async t => {
  const dir = await tempDir(t);
  const target = join(dir, 'AGENTS.md');
  await writeFile(target, '# Rules\n- Always use pnpm\n', 'utf8');

  const res = await appendInstructions(target, 'Always use pnpm');
  assert.equal(res.ok, true);
  assert.equal(res.duplicate, true);
  assert.equal(res.content, '# Rules\n- Always use pnpm\n');
});

test('appendInstructions preserves markdown heading or list prefix if provided', async t => {
  const dir = await tempDir(t);
  const target = join(dir, 'AGENTS.md');
  await writeFile(target, '# Existing\n', 'utf8');

  const res = await appendInstructions(target, '## Coding\n* Custom bullet');
  assert.equal(res.ok, true);
  assert.equal(res.content, '# Existing\n\n## Coding\n* Custom bullet\n');
});

test('createInstructionsOperations respects instructions module enabled/disabled state', async t => {
  const dir = await tempDir(t);
  const settingsFile = join(dir, 'settings.json');
  const settingsState = createSettingsState(settingsFile);

  const ctx = {
    get: () => undefined,
  };

  const ops = createInstructionsOperations(ctx, settingsState);
  const infoRes = await ops.run({ action: 'info' });
  assert.equal(infoRes.ok, true);
  assert.equal(infoRes.scope, 'global');

  await settingsState.setModule('instructions', false);
  await assert.rejects(
    () => ops.run({ action: 'info' }),
    /Module "instructions" is disabled/
  );
});

test('registerInstructionsHttp handles GET, POST and OPTIONS', async t => {
  const dir = await tempDir(t);
  const settingsFile = join(dir, 'settings.json');
  const settingsState = createSettingsState(settingsFile);
  const testFile = join(dir, 'AGENTS.md');

  const operations = {
    run: async req => {
      if (req.action === 'read') return { ok: true, path: testFile, content: 'test content' };
      if (req.action === 'write') return { ok: true, path: testFile, content: req.content, size: req.content.length };
      return { ok: true, action: req.action };
    },
  };

  let registeredRoute = null;
  const mockWebServer = {
    register: route => { registeredRoute = route; return () => {}; },
  };

  const mockCtx = {
    get: name => name === 'webServer' ? mockWebServer : undefined,
    effect: fn => fn(),
  };

  registerInstructionsHttp(mockCtx, settingsState, operations);
  assert.ok(registeredRoute);
  assert.equal(registeredRoute.path, '/harness-qol/instructions');

  // Test OPTIONS
  let status = 0;
  const mockOptionsRes = {
    writeHead: s => { status = s; },
    end: () => {},
  };
  await registeredRoute.handler({ method: 'OPTIONS' }, mockOptionsRes);
  assert.equal(status, 204);

  // Test GET
  let jsonBody = '';
  const mockGetRes = {
    writeHead: s => { status = s; },
    end: data => { jsonBody = data; },
  };
  await registeredRoute.handler({ method: 'GET', url: '/harness-qol/instructions?action=read' }, mockGetRes);
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(jsonBody), { ok: true, path: testFile, content: 'test content' });

  // Test POST
  const postPayload = JSON.stringify({ action: 'write', content: 'new rules' });
  const mockReqStream = Readable.from([Buffer.from(postPayload)]);
  mockReqStream.method = 'POST';
  mockReqStream.headers = { 'content-type': 'application/json' };

  await registeredRoute.handler(mockReqStream, mockGetRes);
  assert.equal(status, 200);
  assert.equal(JSON.parse(jsonBody).content, 'new rules');
});

test('registerInstructions registers tool, command, and system prompt section', async t => {
  const dir = await tempDir(t);
  const settingsFile = join(dir, 'settings.json');
  const settingsState = createSettingsState(settingsFile);

  const registeredTools = [];
  const registeredCommands = [];
  let registeredPromptSection = null;

  const mockCtx = {
    get(name) {
      if (name === 'tools') return { register: t => registeredTools.push(t) };
      if (name === 'commands') return { register: c => registeredCommands.push(c) };
      if (name === 'webServer') return { register: () => () => {} };
      return undefined;
    },
    inject(deps, fn) {
      if (deps.includes('systemPrompt')) {
        const scope = {
          get: name => name === 'systemPrompt' ? {
            section: s => { registeredPromptSection = s; return () => {}; },
          } : undefined,
          effect: cb => cb(),
        };
        fn(scope);
      }
      if (deps.includes('webServer')) {
        const scope = {
          get: name => name === 'webServer' ? { register: () => () => {} } : undefined,
          effect: cb => cb(),
        };
        fn(scope);
      }
    },
    effect: cb => cb(),
  };

  const ops = registerInstructions(mockCtx, settingsState);
  assert.ok(ops);

  assert.equal(registeredTools.length, 1);
  assert.equal(registeredTools[0].name, 'harness_qol_instructions');
  assert.deepEqual(registeredTools[0].parameters, instructionsParameters);

  assert.equal(registeredCommands.length, 1);
  assert.equal(registeredCommands[0].name, 'remember');

  assert.ok(registeredPromptSection);
  assert.equal(registeredPromptSection.name, 'harness-qol:instructions');
  assert.match(registeredPromptSection.text(), /global AGENTS\.md/);
});
