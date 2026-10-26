import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getSettingsState } from './settings-state.js';

export const folderRecordSchema = z.object({
  folders: z.array(z.string().min(1)).min(1).max(32),
  revision: z.string().min(1),
});
export const workspaceDomainSpec = {
  name: 'harness_qol_workspaces', version: 1, layout: 'per-record',
  tables: { roots: { valueSchema: folderRecordSchema } },
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };

/** One operation owner for the UI, command and tool; never writes into a project folder. */
export function createWorkspaceOperations(registry, table, settingsState) {
  const settings = settingsState || getSettingsState();
  let chain = Promise.resolve();
  const view = workspace => {
    const record = table.get(workspace.id);
    return { id: workspace.id, title: workspace.title, path: workspace.path,
      folders: [...(record?.folders ?? [workspace.path])],
      revision: `${workspace.updatedAt}:${record?.revision ?? 'native'}` };
  };
  const requireWorkspace = id => registry.get(id) ?? fail('Workspace not found / Workspace не найден.');
  async function foldersOf(input, retained = []) {
    if (!Array.isArray(input) || !input.length || input.length > 32) fail('Select 1–32 folders / Выберите от 1 до 32 папок.');
    const result = [];
    for (const path of input) {
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.length > 32768) fail('An absolute folder path is required / Нужен абсолютный путь к папке.');
      let canonical;
      try {
        canonical = await realpath(path);
        if (!(await stat(canonical)).isDirectory()) fail(`Not a folder / Не папка: ${path}`);
      } catch (error) {
        // Keep previously attached missing roots: renaming must not require all disks online.
        if (error.code === 'ENOENT' && retained.includes(path)) canonical = path;
        else throw error;
      }
      if (!result.includes(canonical)) result.push(canonical);
    }
    return result;
  }
  const titleOf = value => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\u0000-\u001f]/.test(value)) fail('Enter a name (1–200 characters) / Введите название (1–200 символов).');
    return value.trim();
  };
  async function perform(request, signal) {
    signal?.throwIfAborted();
    if (settings && !settings.isModuleEnabled('workspaces')) {
      fail('Workspaces module is disabled in Harness QOL settings / Модуль воркспейсов отключён в настройках Harness QOL.');
    }
    if (!object(request)) fail('Expected an operation object.');
    const action = request.action ?? 'list';
    if (action === 'list') return { workspaces: registry.list().map(view) };
    if (action === 'read') return view(requireWorkspace(request.workspaceId));
    if (action !== 'create' && action !== 'update') fail(`Unknown operation: ${action}`);
    const title = titleOf(request.title);
    const workspace = action === 'update' ? requireWorkspace(request.workspaceId) : null;
    if (workspace && request.revision !== view(workspace).revision) fail('Workspace changed. Reload before saving / Workspace изменён. Перечитайте его перед сохранением.');
    const folders = await foldersOf(request.folders, workspace ? view(workspace).folders : []);
    if (workspace && folders[0] !== workspace.path) fail('Keep the primary folder first to preserve existing chats / Основная папка должна оставаться первой для совместимости с чатами.');
    signal?.throwIfAborted();
    if (workspace && request.revision !== view(workspace).revision) fail('Workspace changed. Reload before saving / Workspace изменён. Перечитайте его перед сохранением.');
    if (!workspace) {
      if (await registry.resolveByPath(folders[0])) fail('This primary folder already has a workspace. Edit it instead / У этой основной папки уже есть workspace. Отредактируйте его.');
      signal?.throwIfAborted();
      const created = await registry.create(folders[0], title);
      try { await table.put(created.id, { folders, revision: randomUUID() }); }
      catch (error) { fail(`The workspace exists with its primary folder, but saving additional folders failed. Edit it to retry / Workspace создан с основной папкой, но дополнительные папки не сохранены: ${error.message}`); }
      return view(created);
    }
    const previous = table.get(workspace.id);
    await table.put(workspace.id, { folders, revision: randomUUID() });
    try { if (workspace.title !== title) await workspace.setTitle(title); }
    catch (error) {
      try { if (previous) await table.put(workspace.id, previous); else await table.delete(workspace.id); }
      catch (rollback) { fail(`Rename failed; folder changes were saved / Название не изменено, изменения папок сохранены: ${error.message}; ${rollback.message}`); }
      throw error;
    }
    return view(workspace);
  }
  return {
    run(request = {}, signal) {
      const task = chain.then(async () => {
        try { return { ok: true, data: await perform(request, signal) }; }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      });
      chain = task.then(() => undefined, () => undefined);
      return task;
    },
    async drain() { await chain; },
    contextText(agent) {
      if (settings && !settings.isModuleEnabled('workspaces')) return '';
      if (!agent?.session) return '';
      const cwd = agent.session.header.cwd;
      // Membership is owned by the native registry; changing the agent cwd must not switch roots.
      const workspace = registry.list().find(item => item.sessionIds.includes(agent.id))
        ?? registry.list().find(item => item.path === cwd);
      if (!workspace) return '';
      const value = view(workspace);
      if (value.folders.length < 2) return '';
      return `Harness QOL workspace folders: ${JSON.stringify({ workspaceId: value.id, title: value.title, primary: value.path, folders: value.folders })}. All listed folders belong to this workspace. Relative paths resolve against the current working directory, NOT every root. Use absolute paths (or an explicit command cwd) for other folders. Existing filesystem permissions still apply; attaching a folder does not grant access.`;
    },
  };
}

export const workspaceToolParameters = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['list', 'read', 'create', 'update'], description: 'list by default; read returns one workspace; create or update saves its name and folder list.' },
    workspaceId: { type: 'string', description: 'Workspace id from list; required for read and update.' },
    title: { type: 'string', description: 'Name, 1–200 characters; required for create and update.' },
    folders: { type: 'array', items: { type: 'string' }, description: 'Complete list of 1–32 absolute directory paths for create/update. The first is primary and cannot change on update. Aliases are deduplicated.' },
    revision: { type: 'string', description: 'Exact revision from a fresh read, required for update to avoid overwriting concurrent edits.' },
  },
};

export function registerWorkspaceTool(ctx, operations) {
  ctx.effect(() => ctx.get('tools').register({
    name: 'harness_qol_workspaces',
    description: 'List, create and edit named multi-folder workspaces without moving or deleting files. Returns workspace ids, folders and edit revisions.',
    parameters: workspaceToolParameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    isConcurrencySafe: request => !request?.action || ['list', 'read'].includes(request.action),
    execute: (request, exec) => operations.run(request, exec.signal),
  }));
}

/** Same-origin, authenticated browser API, also available before the first chat exists. */
export function registerWorkspaceHttp(ctx, operations) {
  ctx.effect(() => ctx.get('webServer').register({
    kind: 'exact', path: '/harness-qol/workspaces',
    async handler(request, response) {
      const send = (status, data) => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        response.end(JSON.stringify(data));
      };
      const rejection = ctx.get('connection').requestRejection(request);
      if (rejection) return send(rejection, { ok: false, error: 'Unauthorized' });
      if (request.method !== 'POST') return send(405, { ok: false, error: 'POST required' });
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) return send(415, { ok: false, error: 'JSON required' });
      try {
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += Buffer.byteLength(chunk);
          if (size > 1024 * 1024) return send(413, { ok: false, error: 'Payload too large' });
          chunks.push(Buffer.from(chunk));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return send(200, await operations.run(payload));
      } catch (error) { return send(400, { ok: false, error: error.message }); }
    },
  }));
}

export async function registerWorkspaces(ctx, settingsState) {
  const domain = await ctx.get('storageDomain').open(workspaceDomainSpec);
  const operations = createWorkspaceOperations(ctx.get('workspaceRegistry'), domain.table('roots'), settingsState);
  // Disposed after accepted operations drain, before the domain handle closes.
  ctx.effect(() => async () => { await operations.drain(); await domain.close(); });
  registerWorkspaceTool(ctx, operations);
  registerWorkspaceHttp(ctx, operations);
  ctx.effect(() => ctx.get('systemPrompt').context({
    name: 'harness-qol:workspace-folders', order: 55, interpolate: false,
    text: context => operations.contextText(context.agent),
  }));
  return operations;
}
