import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createWorkspaceOperations, folderRecordSchema, workspaceDomainSpec, registerWorkspaceTool, registerWorkspaceHttp } from './workspaces.js';

async function fixture(t) {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'harness-qol-ws-test-'));
  // Only remove this exact owned temp directory, never a supplied project path.
  assert.ok(resolve(root).startsWith(join(resolve(temp), 'harness-qol-ws-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'one'); const b = join(root, 'two');
  await mkdir(a); await mkdir(b); await writeFile(join(a, 'keep.txt'), 'untouched');
  const entities = new Map(); const records = new Map(); let id = 0;
  const registry = {
    list: () => [...entities.values()], get: key => entities.get(key), resolveByPath: async path => [...entities.values()].find(item => item.path === path),
    async create(path, title = 'Native') {
      const old = await this.resolveByPath(path); if (old) return old;
      const workspace = { id: `ws-${++id}`, path, title, updatedAt: 'time-' + id, sessionIds: [],
        async setTitle(value) { this.title = value; this.updatedAt += '-updated'; } };
      entities.set(workspace.id, workspace); return workspace;
    },
  };
  const table = { get: id => records.get(id),
    async put(id, value) { records.set(id, folderRecordSchema.parse(value)); },
    async delete(id) { return records.delete(id); },
  };
  return { root, a, b, entities, registry, records, table, ops: createWorkspaceOperations(registry, table) };
}
const ok = result => { assert.equal(result.ok, true, result.error); return result.data; };
const bad = (result, pattern) => { assert.equal(result.ok, false); assert.match(result.error, pattern); };

test('create, reread after reload, edit folders/title, leave project contents untouched', async t => {
  const f = await fixture(t);
  const created = ok(await f.ops.run({ action: 'create', title: '  Project  ', folders: [f.a, f.b] }));
  assert.equal(created.title, 'Project'); assert.deepEqual(created.folders, [f.a, f.b]);
  const reloaded = createWorkspaceOperations(f.registry, f.table);
  assert.deepEqual(ok(await reloaded.run({ action: 'read', workspaceId: created.id })), created);
  const edited = ok(await reloaded.run({ action: 'update', workspaceId: created.id, revision: created.revision, title: 'Renamed', folders: [f.a] }));
  assert.equal(edited.title, 'Renamed'); assert.deepEqual(edited.folders, [f.a]);
  assert.notEqual(edited.revision, created.revision);
  assert.equal(await readFile(join(f.a, 'keep.txt'), 'utf8'), 'untouched');
});
test('edit native pre-QOL workspace, keeping its id, primary root and sessions', async t => {
  const f = await fixture(t); const native = await f.registry.create(f.a);
  native.sessionIds.push('chat-1');
  const initial = ok(await f.ops.run({ action: 'read', workspaceId: native.id }));
  const edited = ok(await f.ops.run({ action: 'update', workspaceId: native.id, revision: initial.revision, title: 'With roots', folders: [f.a, f.b] }));
  assert.equal(edited.id, native.id); assert.deepEqual(edited.folders, [f.a, f.b]); assert.deepEqual(native.sessionIds, ['chat-1']);
});
test('canonicalize and deduplicate symlink aliases', async t => {
  const f = await fixture(t); const alias = join(f.root, 'alias'); await symlink(f.a, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const item = ok(await f.ops.run({ action: 'create', title: 'Roots', folders: [alias, f.a, f.b, f.b] }));
  assert.deepEqual(item.folders, [f.a, f.b]);
});
test('duplicate primary is refused without retitling existing workspace', async t => {
  const f = await fixture(t); const original = await f.registry.create(f.a, 'Original');
  bad(await f.ops.run({ action: 'create', title: 'Replacement', folders: [f.a, f.b] }), /already has/);
  assert.equal(original.title, 'Original'); assert.equal(f.records.size, 0);
});
test('reject invalid names, roots, files, empty roots and excessive roots before mutation', async t => {
  const f = await fixture(t);
  for (const title of ['', '  ', 'a'.repeat(201), 'line\nbreak']) bad(await f.ops.run({ action: 'create', title, folders: [f.a] }), /name/);
  for (const folders of [[], ['relative'], [join(f.a, 'keep.txt')], [join(f.root, 'missing')], new Array(33).fill(f.a)]) {
    assert.equal((await f.ops.run({ action: 'create', title: 'Test', folders })).ok, false);
  }
  assert.equal(f.entities.size, 0); assert.equal(f.records.size, 0);
});
test('stale revisions and primary replacement are refused', async t => {
  const f = await fixture(t); const item = ok(await f.ops.run({ action: 'create', title: 'One', folders: [f.a] }));
  bad(await f.ops.run({ action: 'update', workspaceId: item.id, revision: item.revision, title: 'Two', folders: [f.b, f.a] }), /primary/);
  const edit = { action: 'update', workspaceId: item.id, revision: item.revision, title: 'Two', folders: [f.a, f.b] };
  const results = await Promise.all([f.ops.run(edit), f.ops.run(edit)]);
  assert.equal(results.filter(value => value.ok).length, 1); bad(results.find(value => !value.ok), /changed/);
});
test('native title changes invalidate QOL revision', async t => {
  const f = await fixture(t); const native = await f.registry.create(f.a);
  const item = ok(await f.ops.run({ action: 'read', workspaceId: native.id }));
  await native.setTitle('Elsewhere');
  bad(await f.ops.run({ action: 'update', workspaceId: item.id, revision: item.revision, title: 'Clobber', folders: [f.a] }), /changed/);
});
test('missing retained roots can be removed or kept while renaming', async t => {
  const f = await fixture(t); const item = ok(await f.ops.run({ action: 'create', title: 'One', folders: [f.a, f.b] }));
  // Verified owned temp path, created by this fixture.
  assert.equal(f.b, join(f.root, 'two')); await rm(f.b, { recursive: true });
  const edited = ok(await f.ops.run({ action: 'update', workspaceId: item.id, revision: item.revision, title: 'Offline disk', folders: item.folders }));
  assert.deepEqual(edited.folders, item.folders);
});
test('failed native rename rolls folder metadata back and queue recovers', async t => {
  const f = await fixture(t); const item = ok(await f.ops.run({ action: 'create', title: 'One', folders: [f.a] }));
  f.entities.get(item.id).setTitle = async () => { throw new Error('rename refused'); };
  bad(await f.ops.run({ action: 'update', workspaceId: item.id, revision: item.revision, title: 'Two', folders: [f.a, f.b] }), /rename refused/);
  assert.deepEqual(ok(await f.ops.run({ action: 'read', workspaceId: item.id })), item);
});
test('failed metadata write does not rename workspace', async t => {
  const f = await fixture(t); const native = await f.registry.create(f.a);
  const item = ok(await f.ops.run({ action: 'read', workspaceId: native.id }));
  f.table.put = async () => { throw new Error('disk full'); };
  bad(await f.ops.run({ action: 'update', workspaceId: item.id, revision: item.revision, title: 'Two', folders: [f.a, f.b] }), /disk full/);
  assert.equal(native.title, 'Native');
});
test('partial create failure explicitly reports the retained registration', async t => {
  const f = await fixture(t); f.table.put = async () => { throw new Error('disk full'); };
  bad(await f.ops.run({ action: 'create', title: 'One', folders: [f.a, f.b] }), /workspace exists with its primary/);
  assert.equal(f.entities.size, 1);
});
test('cancelled operation commits nothing', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort(new Error('cancelled'));
  bad(await f.ops.run({ action: 'create', title: 'One', folders: [f.a] }, controller.signal), /cancelled/);
  assert.equal(f.entities.size, 0);
});
test('context lists only this session workspace and updates without an agent restart', async t => {
  const f = await fixture(t); const item = ok(await f.ops.run({ action: 'create', title: 'One', folders: [f.a, f.b] }));
  const agent = { id: 'chat-1', session: { header: { cwd: f.a } } };
  assert.ok(f.ops.contextText(agent).includes(JSON.stringify(f.b)));
  assert.equal(f.ops.contextText({ id: 'other', session: { header: { cwd: f.root } } }), '');
  await f.ops.run({ action: 'update', workspaceId: item.id, revision: item.revision, title: 'One', folders: [f.a] });
  assert.equal(f.ops.contextText(agent), '');
});
test('tool and authenticated HTTP UI use the exact same operation implementation', async t => {
  const f = await fixture(t); let tool; let route;
  const ctx = { effect: callback => callback(), get: name => ({
    tools: { register(value) { tool = value; return () => {}; } },
    webServer: { register(value) { route = value; return () => {}; } },
    connection: { requestRejection: request => request.headers.cookie === 'owner' ? undefined : 401 },
  })[name] };
  registerWorkspaceTool(ctx, f.ops); registerWorkspaceHttp(ctx, f.ops);
  const created = ok(await tool.execute({ action: 'create', title: 'By tool', folders: [f.a, f.b] }, {}));
  async function http(payload, authenticated = true, method = 'POST', type = 'application/json') {
    const request = Readable.from([Buffer.from(JSON.stringify(payload))]);
    request.method = method; request.headers = { 'content-type': type, cookie: authenticated ? 'owner' : '' };
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await route.handler(request, response); return response;
  }
  const viaUi = await http({ action: 'read', workspaceId: created.id });
  assert.equal(viaUi.status, 200); assert.deepEqual(ok(viaUi.body), created);
  const updated = await http({ action: 'update', workspaceId: created.id, revision: created.revision, title: 'By UI', folders: [f.a] });
  assert.deepEqual(ok(await tool.execute({ action: 'read', workspaceId: created.id }, {})), ok(updated.body));
  assert.equal((await http({ action: 'list' }, false)).status, 401);
  assert.equal((await http({ action: 'list' }, true, 'GET')).status, 405);
  assert.equal((await http({ action: 'list' }, true, 'POST', 'text/plain')).status, 415);
});
test('storage domain and tables use portable storage identifiers', () => {
  assert.match(workspaceDomainSpec.name, /^[a-z][a-z0-9_]*$/);
  for (const name of Object.keys(workspaceDomainSpec.tables)) assert.match(name, /^[a-z][a-z0-9_]*$/);
});
test('client declares creation flows and session edit menu without importing private UI packages', async () => {
  const source = await readFile(new URL('./workspaces-client.js', import.meta.url), 'utf8');
  assert.match(source, /sidebar\.workspaces\.directoryFlow/); assert.match(source, /conversation\.hero\.workspace\.directoryFlow/);
  assert.match(source, /sidebar\.workspaces\.session\.menu\.item/); assert.match(source, /showModal\(\)/);
  assert.doesNotMatch(source, /sidebar\.footer\.action/);
  assert.doesNotMatch(source, /require\(|appendChild|createPortal|querySelector|#[a-fA-F\d]{3,8}\b/);
});
