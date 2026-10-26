import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getSettingsState } from './settings-state.js';

export function getDshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
}

export function getGlobalInstructionsPath() {
  return join(getDshHome(), 'AGENTS.md');
}

export async function readInstructions(filePath = getGlobalInstructionsPath()) {
  try {
    const content = await readFile(filePath, 'utf8');
    const st = await stat(filePath);
    return { ok: true, path: filePath, exists: true, content, size: st.size };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: true, path: filePath, exists: false, content: '', size: 0 };
    }
    throw err;
  }
}

export async function writeInstructions(filePath = getGlobalInstructionsPath(), content) {
  if (typeof content !== 'string') {
    throw new Error('Content must be a string / Содержимое должно быть строкой.');
  }
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(filePath, content, 'utf8');
  const st = await stat(filePath);
  return { ok: true, path: filePath, exists: true, size: st.size, content };
}

export async function appendInstructions(filePath = getGlobalInstructionsPath(), ruleText) {
  const trimmed = typeof ruleText === 'string' ? ruleText.trim() : '';
  if (!trimmed) {
    throw new Error('Rule content cannot be empty / Текст правила не может быть пустым.');
  }

  let existing = '';
  let exists = false;
  try {
    existing = await readFile(filePath, 'utf8');
    exists = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (existing.includes(trimmed)) {
    return {
      ok: true,
      path: filePath,
      exists: true,
      content: existing,
      duplicate: true,
      rule: trimmed,
      message: 'Rule is already in AGENTS.md / Правило уже есть в AGENTS.md',
    };
  }

  let updated;
  if (!exists || !existing.trim()) {
    if (/^#+\s/.test(trimmed)) {
      updated = `${trimmed}\n`;
    } else {
      const line = trimmed.startsWith('-') || trimmed.startsWith('*') ? trimmed : `- ${trimmed}`;
      updated = `# Agent Instructions\n\n${line}\n`;
    }
  } else {
    const cleanExisting = existing.replace(/\s+$/, '');
    const line = trimmed.startsWith('#') || trimmed.startsWith('-') || trimmed.startsWith('*')
      ? trimmed
      : `- ${trimmed}`;
    updated = `${cleanExisting}\n\n${line}\n`;
  }

  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(filePath, updated, 'utf8');
  const st = await stat(filePath);
  return {
    ok: true,
    path: filePath,
    exists: true,
    size: st.size,
    content: updated,
    rule: trimmed,
    message: 'Rule added to AGENTS.md / Правило добавлено в AGENTS.md',
  };
}

export function createInstructionsOperations(ctx, settingsState) {
  const settings = settingsState || getSettingsState();

  return {
    async run(request = {}, signal) {
      signal?.throwIfAborted();
      if (settings && !settings.isModuleEnabled('instructions')) {
        throw new Error('Module "instructions" is disabled in Harness QOL settings / Модуль "instructions" отключён в настройках Harness QOL.');
      }
      const action = request.action || 'read';
      const filePath = getGlobalInstructionsPath();

      if (action === 'info' || action === 'list') {
        let exists = false;
        let size = 0;
        try {
          const st = await stat(filePath);
          exists = st.isFile();
          size = st.size;
        } catch (_e) {}
        return {
          ok: true,
          scope: 'global',
          path: filePath,
          displayPath: '~/.dsh/AGENTS.md',
          exists,
          size,
        };
      }

      if (action === 'read') {
        const result = await readInstructions(filePath);
        return { ...result, scope: 'global', displayPath: '~/.dsh/AGENTS.md' };
      }

      if (action === 'write') {
        const result = await writeInstructions(filePath, request.content ?? '');
        return { ...result, scope: 'global', displayPath: '~/.dsh/AGENTS.md' };
      }

      if (action === 'append') {
        const result = await appendInstructions(filePath, request.content);
        return { ...result, scope: 'global', displayPath: '~/.dsh/AGENTS.md' };
      }

      throw new Error(`Unknown action: ${action} / Неизвестное действие: ${action}`);
    },
  };
}

export function registerInstructionsHttp(ctx, state, operations) {
  const webServer = ctx.get('webServer');
  if (!webServer) return;
  const connection = ctx.get('connection');

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/harness-qol/instructions',
    async handler(request, response) {
      const send = (status, data) => {
        response.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        response.end(JSON.stringify(data));
      };

      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        return response.end();
      }

      if (connection) {
        const rejection = connection.requestRejection(request);
        if (rejection) return send(rejection, { ok: false, error: 'Unauthorized' });
      }

      try {
        if (request.method === 'GET') {
          const url = new URL(request.url, 'http://localhost');
          const action = url.searchParams.get('action') || 'read';
          const result = await operations.run({ action });
          return send(200, result);
        }

        if (request.method === 'POST') {
          if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
            return send(415, { ok: false, error: 'JSON required' });
          }
          const chunks = [];
          let size = 0;
          for await (const chunk of request) {
            size += Buffer.byteLength(chunk);
            if (size > 512 * 1024) return send(413, { ok: false, error: 'Payload too large' });
            chunks.push(Buffer.from(chunk));
          }
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const result = await operations.run(payload);
          return send(200, result);
        }

        return send(405, { ok: false, error: 'GET or POST required' });
      } catch (error) {
        return send(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  }));
}

export const instructionsParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['read', 'append', 'write'],
      description: 'Operation: "read" (read instructions), "append" (add a rule to the end of global AGENTS.md), or "write" (replace full content of global AGENTS.md).'
    },
    content: {
      type: 'string',
      description: 'Markdown text to append or write. When appending, specify concise, clear guidelines or rules.'
    }
  },
  required: ['action']
};

export function registerInstructions(ctx, settingsState) {
  const settings = settingsState || getSettingsState();
  const operations = createInstructionsOperations(ctx, settings);

  ctx.inject(['webServer'], scope => {
    registerInstructionsHttp(scope, settings, operations);
  });

  const tools = ctx.get('tools');
  if (tools) {
    ctx.effect(() => tools.register({
      name: 'harness_qol_instructions',
      description: 'Read, append to, or update global AGENTS.md instructions (~/.dsh/AGENTS.md). When the user asks to remember a rule, preference, convention, or guideline (like in Codex), use this tool to append or update AGENTS.md.',
      parameters: instructionsParameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
      },
      isConcurrencySafe: request => (request?.action ?? 'read') === 'read',
      execute: (request, exec) => operations.run(request, exec.signal),
    }));
  }

  const commands = ctx.get('commands');
  if (commands) {
    ctx.effect(() => commands.register({
      name: 'remember',
      description: 'Добавить правило или инструкцию в глобальный AGENTS.md (~/.dsh/AGENTS.md).',
      recordInput: true,
      input: { hint: 'Текст правила / rule to remember' },
      async handler(invocation) {
        const text = invocation.rawInput?.trim();
        if (!text) {
          return { kind: 'error', text: 'Укажите правило: /remember <текст правила>' };
        }
        try {
          const result = await operations.run({ action: 'append', content: text }, invocation.signal);
          return {
            kind: 'success',
            text: `✓ Добавлено в ${result.displayPath || result.path}:\n- ${text}`
          };
        } catch (error) {
          return { kind: 'error', text: `Ошибка: ${error.message}` };
        }
      }
    }));
  }

  ctx.inject(['systemPrompt'], scope => {
    const sp = scope.get('systemPrompt');
    if (sp) {
      scope.effect(() => sp.section({
        name: 'harness-qol:instructions',
        order: 850,
        text: () => {
          if (!settings.isModuleEnabled('instructions')) return '';
          return 'When the user asks to remember a rule, convention, style guideline, or instruction for future tasks (like in Codex, e.g. "remember this", "добавь в AGENTS.md", "запомни правило"), persist it into global AGENTS.md (~/.dsh/AGENTS.md) using the harness_qol_instructions tool with action "append".';
        }
      }));
    }
  });

  return operations;
}
