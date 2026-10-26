// Interactive, pipe-backed jobs. No private process handles or shell monkey-patches.
const LIVE = new Set(['running', 'stopping']);
const MAX_INPUT = 16 * 1024;
export const CONSOLE_KIND = 'qol-console';
export const consoleParameters = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['list', 'start', 'send', 'read', 'eof', 'stop'], description: 'list by default; start launches an interactive background process; send writes one line; read observes output without consuming job_output; eof closes stdin; stop terminates the process.' },
    argv: { type: 'array', items: { type: 'string' }, description: 'For start: executable and separate arguments, e.g. ["java","-jar","server.jar","nogui"]. No implicit shell or command parsing.' },
    cwd: { type: 'string', description: 'For start: directory, relative to the session directory; omitted uses that directory.' },
    jobId: { type: 'string', description: 'For send/read/eof/stop: job id from list or start. Only QOL-launched jobs accept input.' },
    text: { type: 'string', description: 'For send: one line, at most 16 KiB UTF-8, without line breaks. A newline is appended.' },
    from: { type: 'integer', description: 'For read: absolute byte offset, 0 by default; continue with returned next.' },
  },
};

export function createConsoleOperations(ctx, settings) {
  const records = new Map();
  let disposed = false;
  const need = name => {
    const service = ctx.get(name);
    if (!service) throw new Error(`Service unavailable: ${name}`);
    return service;
  };
  const jobs = need('jobs');
  const policyFor = agent => need('sandboxPolicy').resolve({ session: agent.session });
  const project = (job, agent) => ({ ...job, inputSupported: records.get(job.id)?.owner === agent.id,
    stdinOpen: records.get(job.id)?.stdinOpen === true });
  function ownedRecord(agent, id) {
    const job = jobs.get(id, agent.id); // Authorize before looking at the handle map.
    const record = records.get(id);
    if (!record || record.owner !== agent.id) throw new Error('No stdin for this job / У этой задачи нет доступного stdin. Запустите процесс через QOL Console.');
    if (!LIVE.has(job.status)) throw new Error('Process has finished / Процесс завершён.');
    return record;
  }
  function checkInputPolicy(agent, record) {
    const policy = policyFor(agent);
    if (policy.mode !== record.policy.mode || policy.workspaceRoot !== record.policy.workspaceRoot) {
      throw new Error('Session policy changed; restart the process under the current policy / Политика сессии изменилась; перезапустите процесс.');
    }
  }
  async function perform(agent, request, signal) {
    if (disposed) throw new Error('Console module unloaded.');
    if (!agent?.id || !agent.session) throw new Error('An owning session is required.');
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Expected an operation object.');
    signal?.throwIfAborted();
    const action = request.action ?? 'list';
    // Keep observation and emergency stop available even when the module is disabled.
    if (['start', 'send', 'eof'].includes(action) && !settings.isModuleEnabled('console')) {
      throw new Error('Console module is disabled / Модуль Console отключён.');
    }
    if (action === 'list') return { jobs: jobs.list(agent.id).map(job => project(job, agent)) };
    if (action === 'read') {
      if (!Number.isSafeInteger(request.from ?? 0) || (request.from ?? 0) < 0) throw new Error('Invalid output offset.');
      const output = jobs.readAt(request.jobId, request.from ?? 0, agent.id);
      // Bound the response, even if another producer retained a very large ring.
      const chunks = []; let bytes = 0; let next = request.from ?? 0;
      for (const chunk of output.chunks) {
        const buffer = Buffer.from(chunk.text);
        let start = Math.max(0, next - chunk.at);
        // readAt returns whole overlapping chunks; trim bytes already observed.
        while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
        let end = Math.min(buffer.length, start + 64 * 1024 - bytes);
        while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
        if (end === start && start < buffer.length) break;
        chunks.push({ ...chunk, at: chunk.at + start, text: buffer.subarray(start, end).toString('utf8') });
        bytes += end - start;
        next = chunk.at + end;
        if (end < buffer.length) break;
      }
      if (!output.chunks.length) next = output.next;
      return { job: project(jobs.get(request.jobId, agent.id), agent), chunks, next, lossy: output.lossy, hasMore: next < output.next };
    }
    if (action === 'stop') return { outcome: jobs.kill(request.jobId, agent.id, 'Stopped via QOL Console') };
    if (action === 'start') {
      if (!Array.isArray(request.argv) || !request.argv.length || request.argv.length > 256 ||
          request.argv.some(value => typeof value !== 'string' || value.includes('\0')) || !request.argv[0].trim() ||
          Buffer.byteLength(JSON.stringify(request.argv)) > 64 * 1024) throw new Error('argv must contain an executable and separate arguments (max 64 KiB).');
      if (request.cwd !== undefined && (typeof request.cwd !== 'string' || !request.cwd.trim())) throw new Error('Invalid cwd.');
      const subprocess = need('subprocess');
      const base = await need('workingDirectory').ensure(agent, signal);
      const fs = need('fs');
      const target = await fs.resolve(request.cwd ?? base, { cwd: base, signal });
      if ((await fs.stat(target, signal))?.type !== 'directory') throw new Error('Working directory does not exist.');
      const cwd = fs.processPath(target);
      const policy = policyFor(agent);
      let argv = [await subprocess.resolveExecutable(request.argv[0], undefined, signal), ...request.argv.slice(1)];
      if (policy.mode !== 'danger-full-access') {
        const confined = await need('sandbox').confine(argv, policy, signal);
        if (confined.enforcement !== 'full') throw new Error('Interactive console requires full sandbox enforcement.');
        argv = confined.argv;
      }
      signal?.throwIfAborted();
      if (disposed || !settings.isModuleEnabled('console')) throw new Error('Console module is disabled.');
      // Recheck after async preparation: no over-admission by concurrent starts.
      if (records.size >= 32 || [...records.values()].filter(record => record.owner === agent.id).length >= 8) throw new Error('Console process limit reached (8 per session, 32 per profile).');
      let child;
      const record = { owner: agent.id, policy, stdinOpen: true, busy: false, child: null };
      const id = jobs.start({
        kind: CONSOLE_KIND, owner: agent.id, label: JSON.stringify(request.argv), outputLimitBytes: 256 * 1024,
        output: ['stdout', 'stderr'].map(channel => ({ channel, read: from => child.collected[channel].readFrom(from) })),
        run() {
          child = subprocess.spawn({ argv, cwd, stdio: { stdin: 'pipe', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } }, graceMs: 2000 });
          record.child = child;
          const onError = () => { record.stdinOpen = false; };
          child.stdin?.on('error', onError); // A late EPIPE must never crash the Host.
          const done = child.done.then(outcome => ({
            status: record.stopping ? 'killed' : outcome.exitCode === 0 ? 'completed' : 'failed',
            detail: `exit=${outcome.exitCode}; signal=${outcome.signal ?? 'none'}`,
          }), error => ({ status: record.stopping ? 'killed' : 'failed', detail: String(error?.message ?? error) }))
            .finally(() => { record.stdinOpen = false; records.delete(id); });
          record.done = done;
          return { done, cancel() { child.terminate(); record.stopping = true; record.stdinOpen = false; } };
        },
      });
      records.set(id, record);
      return { job: project(jobs.get(id, agent.id), agent), cwd };
    }
    if (action !== 'send' && action !== 'eof') throw new Error(`Unknown console action: ${action}`);
    const record = ownedRecord(agent, request.jobId);
    checkInputPolicy(agent, record);
    const stdin = record.child.stdin;
    if (!record.stdinOpen || !stdin || stdin.destroyed || stdin.writableEnded) throw new Error('stdin is closed / stdin закрыт.');
    if (record.busy) throw new Error('Previous input is still pending; do not resend / Предыдущий ввод ещё отправляется.');
    if (action === 'eof') { record.stdinOpen = false; stdin.end(); return { closed: true }; }
    if (typeof request.text !== 'string' || /[\x00-\x08\x0a-\x1f\x7f]/.test(request.text) || Buffer.byteLength(request.text) > MAX_INPUT) throw new Error('Send a single line up to 16 KiB without control characters.');
    const data = request.text + '\n';
    if ((stdin.writableLength ?? 0) + Buffer.byteLength(data) > 64 * 1024) throw new Error('stdin buffer is full.');
    record.busy = true;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          record.stdinOpen = false; // Uncertain delivery: block further writes rather than queue duplicates.
          reject(new Error('Input delivery timed out; it may have been written. Do not retry automatically.'));
        }, 5000);
        stdin.write(data, 'utf8', error => { clearTimeout(timer); error ? reject(error) : resolve(); });
      });
      return { written: true, bytes: Buffer.byteLength(data) };
    } finally { record.busy = false; }
  }
  return {
    async run(agent, request, signal) {
      try { return { ok: true, data: await perform(agent, request, signal) }; }
      catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
    },
    async dispose() {
      disposed = true;
      const active = [...records.entries()];
      for (const [id, record] of active) {
        try { jobs.kill(id, record.owner, 'QOL Console unloaded'); } catch { record.child.terminate(); }
      }
      await Promise.allSettled(active.map(([, record]) => record.done));
      records.clear();
    },
  };
}

export function registerConsole(ctx, settings) {
  const operations = createConsoleOperations(ctx, settings);
  ctx.effect(() => ctx.jobs.attachController('harness-qol-console'));
  ctx.effect(() => () => operations.dispose());
  ctx.effect(() => ctx.tools.register({
    name: 'harness_qol_console',
    description: 'Launch an interactive background process and send console lines (e.g. Minecraft server commands). List, observe, or stop session jobs. Existing ordinary jobs cannot accept input; start the process here first. Processes end with the owning session or Harness.',
    parameters: consoleParameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: request => ['list', 'read'].includes(request?.action ?? 'list'),
    execute: (request, exec) => operations.run(exec.agent, request, exec.signal),
  }));
  ctx.effect(() => ctx.commands.register({
    name: 'harness-qol-console', description: 'QOL Console: start, send, read, list, eof, stop (JSON).',
    recordInput: true, input: { hint: 'JSON operation: start, send, read, list, eof, stop' },
    async handler(invocation) {
      let request;
      try { request = invocation.rawInput.trim() ? JSON.parse(invocation.rawInput) : {}; }
      catch { return { kind: 'error', text: 'Invalid JSON / Некорректный JSON.' }; }
      const result = await operations.run(invocation.agent, request, invocation.signal);
      return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) };
    },
  }));
}
