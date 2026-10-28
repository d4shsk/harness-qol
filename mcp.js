import { admitMcpResult, renderMcpResult } from './mcp-content.js';
import { smartParseInput, validateMcpServerInput } from './mcp-input.js';
export { smartParseInput, splitCommandArgs } from './mcp-input.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getSettingsState } from './settings-state.js';

export function getDshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
}

export function getMcpConfigPath() {
  return join(getDshHome(), 'mcp-servers.json');
}

export function getClaudeDesktopConfigPath() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Claude', 'claude_desktop_config.json');
  } else if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

export function openPathInExplorer(targetPath, isFile = false) {
  try {
    if (process.platform === 'win32') {
      const args = isFile ? [`/select,${targetPath}`] : [targetPath];
      const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
      child.unref();
    } else if (process.platform === 'darwin') {
      const args = isFile ? ['-R', targetPath] : [targetPath];
      const child = spawn('open', args, { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const dir = isFile ? dirname(targetPath) : targetPath;
      const child = spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' });
      child.unref();
    }
  } catch (err) {
    console.error('[harness-qol:mcp] Failed to open path in explorer:', err);
  }
}

export const MCP_PRESETS = [
  { ...smartParseInput('https://github.com/vercel-labs/agent-browser'), category: 'Browser' },
  {
    id: 'filesystem',
    name: 'Local Filesystem',
    description: 'Direct access to local directories and files on disk',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
    env: {},
    transport: 'stdio',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    tip: 'Replace the directory path in the arguments with your target folder.',
    category: 'System',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Search repositories, read files, issues, pull requests, and commits',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    transport: 'stdio',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    tip: 'Provide a personal access token in GITHUB_PERSONAL_ACCESS_TOKEN.',
    category: 'Developer',
  },
  {
    id: 'sqlite',
    name: 'SQLite Database',
    description: 'Read schemas, inspect tables, and execute SQL queries on SQLite databases',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', './database.db'],
    env: {},
    transport: 'stdio',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    tip: 'Specify your database path in the --db-path argument.',
    category: 'Database',
  },
  {
    id: 'memory',
    name: 'Memory Graph',
    description: 'Persistent associative knowledge graph and long-term memory',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
    transport: 'stdio',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    tip: 'Stores entities and relations persistently across sessions.',
    category: 'Knowledge',
  },
  {
    id: 'fetch',
    name: 'Web Fetch & Markdown',
    description: 'Fetch web pages and convert HTML into clean Markdown format',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: {},
    transport: 'stdio',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    tip: 'Runs using uvx (fast Python package runner).',
    category: 'Search & Web',
  },
  {
    id: 'custom-stdio',
    name: 'Custom CLI (stdio)',
    description: 'Run any local MCP server via npx, uvx, node, python, or docker',
    command: 'npx',
    args: ['-y', 'my-mcp-server'],
    env: {},
    transport: 'stdio',
    category: 'Custom',
  },
  {
    id: 'custom-http',
    name: 'Remote HTTP / SSE',
    description: 'Connect to an external MCP server over Streamable HTTP or SSE',
    url: 'http://127.0.0.1:8000/mcp',
    transport: 'streamable-http',
    headers: {},
    category: 'Custom',
  },
];

class McpProcessConnection {
  constructor(serverConfig, logger) {
    this.config = serverConfig;
    this.logger = logger;
    this.process = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.buffer = '';
    this.serverInfo = null;
    this.capabilities = null;
    this.tools = [];
    this.status = 'connecting';
    this.error = null;
    this.connectedAt = null;
    this.stderrBuffer = [];
    this.isDisposed = false;
  }

  handleLine(line) {
    try {
      const msg = JSON.parse(line);
      // Server requests have their own id namespace, including id 0. Handle
      // them before matching responses to our pending client requests.
      if (msg && typeof msg.method === 'string') {
        if (msg.id !== undefined && msg.id !== null) {
          const response = { jsonrpc: '2.0', id: msg.id };
          if (msg.method === 'roots/list') {
            // No roots are currently supplied by this client. An empty list
            // lets servers use their configured cwd without waiting forever.
            response.result = { roots: [] };
          } else if (msg.method === 'ping') {
            response.result = {};
          } else {
            response.error = { code: -32601, message: `Method not found: ${msg.method}` };
          }
          if (this.process && !this.process.killed) {
            this.process.stdin.write(JSON.stringify(response) + '\n');
          }
        }
        return;
      }
      if (msg && msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const { resolve, reject, timeoutId } = this.pendingRequests.get(msg.id);
        this.pendingRequests.delete(msg.id);
        if (timeoutId) clearTimeout(timeoutId);
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      }
    } catch (_err) {}
  }

  handleStdout(chunk) {
    this.buffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(line);
      }
    }
  }

  sendRequest(method, params = {}, timeoutMs = 30000, signal) {
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.killed || this.process.exitCode !== null) {
        return reject(new Error(`MCP server "${this.config.id}" is not running`));
      }
      const id = this.nextRequestId++;
      const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

      let timeoutId = null;
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            reject(new Error(`MCP request "${method}" to "${this.config.id}" timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }

      if (signal) {
        signal.addEventListener('abort', () => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            if (timeoutId) clearTimeout(timeoutId);
            reject(new Error(`MCP request "${method}" to "${this.config.id}" was aborted`));
          }
        }, { once: true });
      }

      this.pendingRequests.set(id, { resolve, reject, timeoutId });
      try {
        this.process.stdin.write(message);
      } catch (err) {
        this.pendingRequests.delete(id);
        if (timeoutId) clearTimeout(timeoutId);
        reject(err);
      }
    });
  }

  sendNotification(method, params = {}) {
    if (!this.process || this.process.killed) return;
    const message = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    try {
      this.process.stdin.write(message);
    } catch (_e) {}
  }

  cleanupPending(err) {
    for (const [id, req] of this.pendingRequests.entries()) {
      if (req.timeoutId) clearTimeout(req.timeoutId);
      req.reject(err || new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }

  async connect() {
    this.status = 'connecting';
    this.error = null;
    this.isDisposed = false;

    const { command, args = [], env = {}, cwd } = this.config;
    if (!command) {
      throw new Error(`Command is required for stdio MCP server "${this.config.id}"`);
    }

    const isWin = process.platform === 'win32';
    const spawnEnv = {
      ...process.env,
      ...env,
    };

    const proc = spawn(command, args, {
      env: spawnEnv,
      cwd: cwd || undefined,
      shell: isWin,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: isWin,
    });

    this.process = proc;

    proc.stdout.on('data', chunk => this.handleStdout(chunk));
    proc.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      this.stderrBuffer.push(text);
      if (this.stderrBuffer.length > 50) this.stderrBuffer.shift();
    });

    proc.on('error', err => {
      this.status = 'error';
      this.error = `Failed to start "${command}": ${err.message}`;
      this.cleanupPending(err);
    });

    proc.on('exit', (code, signal) => {
      if (!this.isDisposed) {
        this.status = 'error';
        const recentStderr = this.stderrBuffer.slice(-10).join('').trim();
        this.error = recentStderr || `Process exited with code ${code ?? signal ?? 'unknown'}`;
      }
      this.cleanupPending(new Error(`Process exited (${code ?? signal ?? 'unknown'})`));
    });

    try {
      const initResult = await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { roots: {} },
        clientInfo: { name: 'DeepSeek Harness QOL', version: '1.0.0' },
      }, 15000);

      this.serverInfo = initResult?.serverInfo || null;
      this.capabilities = initResult?.capabilities || null;
      this.sendNotification('notifications/initialized');

      const toolsResult = await this.sendRequest('tools/list', {}, 15000);
      this.tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
      this.status = 'connected';
      this.error = null;
      this.connectedAt = Date.now();
      return { ok: true, serverInfo: this.serverInfo, tools: this.tools };
    } catch (err) {
      const recentStderr = this.stderrBuffer.slice(-10).join('').trim();
      this.error = recentStderr ? `${err.message}\n${recentStderr}` : err.message;
      this.disconnect();
      this.status = 'error';
      throw err;
    }
  }

  async callTool(name, argumentsObj = {}, signal) {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: argumentsObj,
    }, 60000, signal);
    return result;
  }

  disconnect() {
    this.isDisposed = true;
    this.status = 'disabled';
    this.cleanupPending(new Error('MCP server disconnected'));
    if (this.process && !this.process.killed) {
      try {
        this.process.stdin.end();
      } catch (_e) {}
      try {
        this.process.kill();
      } catch (_e) {}
    }
    this.process = null;
  }
}

class McpHttpConnection {
  constructor(serverConfig, logger) {
    this.config = serverConfig;
    this.logger = logger;
    this.serverInfo = null;
    this.capabilities = null;
    this.tools = [];
    this.status = 'connecting';
    this.error = null;
    this.connectedAt = null;
    this.nextRequestId = 1;
    this.isDisposed = false;
  }

  async sendJsonRpc(method, params = {}, signal) {
    const { url, headers = {} } = this.config;
    if (!url) throw new Error('URL is required for HTTP MCP server');

    const id = this.nextRequestId++;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      }
      return data.result;
    }
    const text = await res.text();
    return { text };
  }

  async connect() {
    this.status = 'connecting';
    this.error = null;
    this.isDisposed = false;

    try {
      const initResult = await this.sendJsonRpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'DeepSeek Harness QOL', version: '1.0.0' },
      });

      this.serverInfo = initResult?.serverInfo || null;
      this.capabilities = initResult?.capabilities || null;

      try {
        await this.sendJsonRpc('notifications/initialized', {});
      } catch (_e) {}

      const toolsResult = await this.sendJsonRpc('tools/list', {});
      this.tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
      this.status = 'connected';
      this.error = null;
      this.connectedAt = Date.now();
      return { ok: true, serverInfo: this.serverInfo, tools: this.tools };
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      throw err;
    }
  }

  async callTool(name, argumentsObj = {}, signal) {
    const result = await this.sendJsonRpc('tools/call', {
      name,
      arguments: argumentsObj,
    }, signal);
    return result;
  }

  disconnect() {
    this.isDisposed = true;
    this.status = 'disabled';
  }
}

export function createMcpManager(ctx, settingsState, customConfigPath) {
  const settings = settingsState || getSettingsState();
  const configFile = customConfigPath || getMcpConfigPath();
  const connections = new Map();
  const toolDisposers = new Map();
  const systemPromptDisposers = new Map();
  let serverConfigs = new Map();
  let disposed = false;

  function normalizeServerConfig(id, raw) {
    if (!raw || typeof raw !== 'object') return null;
    const cleanId = String(id || raw.id || 'mcp').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    return {
      id: cleanId,
      name: raw.name || cleanId,
      enabled: raw.enabled !== false,
      transport: raw.transport || (raw.url ? 'streamable-http' : 'stdio'),
      command: raw.command || '',
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      env: raw.env && typeof raw.env === 'object' ? raw.env : {},
      cwd: raw.cwd || '',
      url: raw.url || '',
      headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
      description: raw.description || '',
      source: raw.source || '',
      tip: raw.tip || '',
    };
  }

  async function loadConfig() {
    serverConfigs.clear();
    try {
      let rawText = '';
      if (existsSync(configFile)) {
        rawText = await readFile(configFile, 'utf8');
      } else {
        const altConfig = join(getDshHome(), 'mcp.json');
        if (existsSync(altConfig)) {
          rawText = await readFile(altConfig, 'utf8');
        }
      }

      if (rawText.trim()) {
        const data = JSON.parse(rawText);
        const map = data.mcpServers || data.servers || (data && typeof data === 'object' ? data : {});
        for (const [key, value] of Object.entries(map)) {
          const cfg = normalizeServerConfig(key, value);
          if (cfg) {
            serverConfigs.set(cfg.id, cfg);
          }
        }
      }
    } catch (err) {
      console.warn('[harness-qol:mcp] Failed to load MCP config:', err);
    }
    return serverConfigs;
  }

  async function saveConfig() {
    try {
      const dir = dirname(configFile);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      const output = { mcpServers: {} };
      for (const [id, cfg] of serverConfigs.entries()) {
        const serverJson = {
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
          enabled: cfg.enabled,
        };
        if (cfg.cwd) serverJson.cwd = cfg.cwd;
        if (cfg.transport && cfg.transport !== 'stdio') serverJson.transport = cfg.transport;
        if (cfg.url) serverJson.url = cfg.url;
        if (cfg.headers && Object.keys(cfg.headers).length > 0) serverJson.headers = cfg.headers;
        if (cfg.description) serverJson.description = cfg.description;
        if (cfg.source) serverJson.source = cfg.source;
        if (cfg.name && cfg.name !== id) serverJson.name = cfg.name;
        output.mcpServers[id] = serverJson;
      }
      await writeFile(configFile, JSON.stringify(output, null, 2), 'utf8');
    } catch (err) {
      console.error('[harness-qol:mcp] Failed to save MCP config:', err);
      throw err;
    }
  }

  function unregisterServerTools(id) {
    const list = toolDisposers.get(id);
    if (Array.isArray(list)) {
      for (const dispose of list) {
        try { dispose(); } catch (_e) {}
      }
    }
    toolDisposers.delete(id);

    const spDispose = systemPromptDisposers.get(id);
    if (typeof spDispose === 'function') {
      try { spDispose(); } catch (_e) {}
    }
    systemPromptDisposers.delete(id);
  }

  function registerServerTools(id, conn) {
    unregisterServerTools(id);
    const toolsService = ctx.get('tools');
    if (!toolsService || !Array.isArray(conn.tools)) return;

    const disposers = [];
    for (const tool of conn.tools) {
      const rawName = tool.name;
      const cleanToolName = rawName.replace(/[^A-Za-z0-9_-]/g, '_');
      const publicName = `mcp__${id}__${cleanToolName}`.slice(0, 64);
      const schema = tool.inputSchema && typeof tool.inputSchema === 'object'
        ? { type: 'object', properties: {}, ...tool.inputSchema }
        : { type: 'object', properties: {} };

      try {
        const dispose = toolsService.register({
          name: publicName,
          description: `[MCP: ${id}] ${tool.description || rawName}`,
          parameters: schema,
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: renderMcpResult,
          },
          isConcurrencySafe: () => false,
          execute: async (args, exec) => {
            const result = await conn.callTool(rawName, args, exec.signal);
            if (result && result.isError) {
              const errorText = Array.isArray(result.content)
                ? result.content.map(c => c?.text || JSON.stringify(c)).join('\n')
                : 'MCP tool execution failed';
              throw new Error(errorText);
            }
            return admitMcpResult(result, ctx.get('attachments'), exec.signal);
          },
        });
        if (typeof dispose === 'function') {
          disposers.push(dispose);
        }
      } catch (err) {
        console.error(`[harness-qol:mcp] Failed to register tool "${publicName}":`, err);
      }
    }
    toolDisposers.set(id, disposers);

    // Register section in system prompt so the model is aware of the tools and server instructions
    const systemPrompt = ctx.get('systemPrompt');
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      try {
        const toolNames = conn.tools.map(t => `mcp__${id}__${t.name.replace(/[^A-Za-z0-9_-]/g, '_')}`).join(', ');
        const sectionDispose = systemPrompt.section({
          name: `harness-qol:mcp:${id}`,
          order: 860,
          text: () => {
            if (!settings.isModuleEnabled('mcp')) return '';
            const connNow = connections.get(id);
            if (!connNow || connNow.status !== 'connected') return '';
            return `Active MCP Server "${id}": provides tools [${toolNames}].`;
          },
        });
        if (typeof sectionDispose === 'function') {
          systemPromptDisposers.set(id, sectionDispose);
        }
      } catch (_e) {}
    }
  }

  async function startServer(id) {
    if (disposed) return { ok: false, status: 'disabled', error: 'MCP manager was unloaded' };
    const cfg = serverConfigs.get(id);
    if (!cfg) throw new Error(`MCP server "${id}" not found`);

    if (connections.has(id)) {
      const existing = connections.get(id);
      existing.disconnect();
      connections.delete(id);
    }
    unregisterServerTools(id);

    if (!cfg.enabled) {
      return { ok: true, status: 'disabled', message: 'Server is disabled' };
    }

    validateMcpServerInput(cfg);
    const conn = cfg.transport === 'streamable-http' || cfg.transport === 'sse'
      ? new McpHttpConnection(cfg, console)
      : new McpProcessConnection(cfg, console);

    connections.set(id, conn);

    try {
      const result = await conn.connect();
      if (disposed || connections.get(id) !== conn) {
        conn.disconnect();
        return { ok: false, status: 'disabled', error: 'MCP connection was superseded or unloaded' };
      }
      registerServerTools(id, conn);
      return {
        ok: true,
        status: 'connected',
        tools: conn.tools,
        serverInfo: conn.serverInfo,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        error: conn.error || err.message,
      };
    }
  }

  function stopServer(id) {
    const conn = connections.get(id);
    if (conn) {
      conn.disconnect();
      connections.delete(id);
    }
    unregisterServerTools(id);
    return { ok: true, status: 'disabled' };
  }

  async function restartServer(id) {
    stopServer(id);
    return await startServer(id);
  }

  async function testServer(serverData) {
    const cfg = normalizeServerConfig(serverData?.id || 'test-server', serverData);
    if (!cfg) throw new Error('Invalid server configuration');
    validateMcpServerInput(cfg);

    const conn = cfg.transport === 'streamable-http' || cfg.transport === 'sse'
      ? new McpHttpConnection(cfg, console)
      : new McpProcessConnection(cfg, console);

    try {
      const result = await conn.connect();
      conn.disconnect();
      return {
        ok: true,
        status: 'connected',
        serverInfo: result.serverInfo,
        tools: result.tools,
        count: result.tools?.length || 0,
      };
    } catch (err) {
      conn.disconnect();
      return {
        ok: false,
        status: 'error',
        error: conn.error || err.message,
      };
    }
  }

  async function toggleServer(id, enabled) {
    const cfg = serverConfigs.get(id);
    if (!cfg) throw new Error(`MCP server "${id}" not found`);
    cfg.enabled = !!enabled;
    await saveConfig();
    if (cfg.enabled) {
      return await startServer(id);
    } else {
      return stopServer(id);
    }
  }

  async function saveServer(serverData) {
    const cfg = normalizeServerConfig(serverData.id, serverData);
    if (!cfg) throw new Error('Invalid server configuration');
    validateMcpServerInput(cfg);
    serverConfigs.set(cfg.id, cfg);
    await saveConfig();

    const connection = cfg.enabled ? await restartServer(cfg.id) : stopServer(cfg.id);
    return { ...connection, saved: true, server: cfg };
  }

  async function deleteServer(id) {
    stopServer(id);
    serverConfigs.delete(id);
    await saveConfig();
    return { ok: true };
  }

  async function importConfig(rawJson) {
    if (!rawJson) throw new Error('No configuration provided to import');
    let parsed;
    try {
      parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
    } catch (err) {
      throw new Error(`JSON parse error: ${err.message}`);
    }

    const map = parsed.mcpServers || parsed.servers || (parsed && typeof parsed === 'object' ? parsed : {});
    const imported = Object.entries(map).map(([key, value]) => normalizeServerConfig(key, value)).filter(Boolean);
    for (const cfg of imported) validateMcpServerInput(cfg);
    let count = 0;
    for (const cfg of imported) {
      if (cfg) {
        serverConfigs.set(cfg.id, cfg);
        count++;
      }
    }
    await saveConfig();

    // Start newly imported enabled servers
    for (const [id, cfg] of serverConfigs.entries()) {
      if (cfg.enabled && !connections.has(id)) {
        startServer(id).catch(() => {});
      }
    }

    return { ok: true, count };
  }

  async function importFromClaude() {
    const claudePath = getClaudeDesktopConfigPath();
    if (!existsSync(claudePath)) {
      throw new Error(`Claude Desktop config not found at: ${claudePath}`);
    }
    const content = await readFile(claudePath, 'utf8');
    return await importConfig(content);
  }

  function getServers() {
    const list = [];
    const claudePath = getClaudeDesktopConfigPath();
    const hasClaude = existsSync(claudePath);

    for (const [id, cfg] of serverConfigs.entries()) {
      const conn = connections.get(id);
      list.push({
        ...cfg,
        status: !cfg.enabled ? 'disabled' : (conn?.status || 'connecting'),
        error: conn?.error || null,
        tools: conn?.tools || [],
        serverInfo: conn?.serverInfo || null,
        connectedAt: conn?.connectedAt || null,
      });
    }

    return {
      ok: true,
      servers: list,
      configPath: configFile,
      hasClaudeConfig: hasClaude,
    };
  }

  async function startAllEnabled() {
    if (settings && !settings.isModuleEnabled('mcp')) return;
    await loadConfig();
    if (disposed) return;
    for (const [id, cfg] of serverConfigs.entries()) {
      if (cfg.enabled) {
        startServer(id).catch(err => {
          console.warn(`[harness-qol:mcp] Failed to auto-start "${id}":`, err.message);
        });
      }
    }
  }

  function stopAll() {
    for (const id of new Set([...serverConfigs.keys(), ...connections.keys()])) {
      stopServer(id);
    }
  }

  return {
    loadConfig,
    saveConfig,
    getServers,
    startServer,
    stopServer,
    restartServer,
    toggleServer,
    saveServer,
    deleteServer,
    testServer,
    importConfig,
    importFromClaude,
    startAllEnabled,
    stopAll,
    dispose() { disposed = true; stopAll(); },
    getMcpConfigPath,
  };
}

async function mcpOperation(manager, method, action, payload = {}, queryInput = '') {
  if (method === 'GET') {
    if (action === 'list' || action === '') return manager.getServers();
    if (action === 'presets') return { ok: true, presets: MCP_PRESETS };
  }
  if (action === 'smart-parse') {
    const parsed = smartParseInput(method === 'GET' ? queryInput : payload.input || '');
    return { ok: !!parsed, parsed };
  }
  if (method === 'POST') {
    if (action === 'toggle') return manager.toggleServer(payload.id, payload.enabled);
    if (action === 'save') return manager.saveServer(payload.server || payload);
    if (action === 'delete') return manager.deleteServer(payload.id);
    if (action === 'restart') return manager.restartServer(payload.id);
    if (action === 'test') return manager.testServer(payload.server || payload);
    if (action === 'import') return manager.importConfig(payload.config || payload.rawJson || payload);
    if (action === 'import-claude') return manager.importFromClaude();
    if (action === 'open-config') {
      openPathInExplorer(manager.getMcpConfigPath(), true);
      return { ok: true };
    }
  }
  throw Object.assign(new Error('Endpoint not found'), { status: 404 });
}

export function registerMcpConnection(ctx, manager) {
  const connection = ctx.get('connection');
  if (!connection?.fetch) return;
  for (const action of ['list', 'presets', 'smart-parse', 'toggle', 'save', 'delete', 'restart', 'test', 'import', 'import-claude', 'open-config']) {
    const methods = ['list', 'presets'].includes(action) ? ['GET'] : action === 'smart-parse' ? ['GET', 'POST'] : ['POST'];
    ctx.effect(() => connection.fetch.register({
      path: `/api/harness-qol/mcp/${action}`, methods, requestBody: 'buffered',
      async fetch(request) {
        const send = (status, data) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
        try {
          let payload = {};
          if (request.method === 'POST') {
            if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return send(415, { ok: false, error: 'JSON required' });
            const text = await request.text();
            if (Buffer.byteLength(text) > 512 * 1024) return send(413, { ok: false, error: 'Payload too large' });
            payload = text ? JSON.parse(text) : {};
          }
          return send(200, await mcpOperation(manager, request.method, action, payload, new URL(request.url).searchParams.get('input')));
        } catch (err) {
          return send(err.status || 400, { ok: false, error: err.message, code: err.code });
        }
      },
    }));
  }
}

export function registerMcpHttp(ctx, state, manager) {
  const webServer = ctx.get('webServer');
  if (!webServer) return;
  const connection = ctx.get('connection');
  ctx.effect(() => webServer.register({
    kind: 'prefix', path: '/harness-qol/mcp',
    async handler(request, response) {
      const send = (status, data) => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        response.end(JSON.stringify(data));
      };
      if (connection) {
        const rejection = connection.requestRejection(request);
        if (rejection) return send(rejection, { ok: false, error: 'Unauthorized' });
      }
      if (!['GET', 'POST'].includes(request.method)) return send(405, { ok: false, error: 'GET or POST required' });
      try {
        const url = new URL(request.url, 'http://localhost');
        const action = url.pathname.replace(/^\/harness-qol\/mcp\/?/, '');
        const chunks = [];
        let size = 0;
        if (request.method === 'POST') {
          if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return send(415, { ok: false, error: 'JSON required' });
          for await (const chunk of request) {
            size += Buffer.byteLength(chunk);
            if (size > 512 * 1024) return send(413, { ok: false, error: 'Payload too large' });
            chunks.push(Buffer.from(chunk));
          }
        }
        const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        return send(200, await mcpOperation(manager, request.method, action, payload, url.searchParams.get('input')));
      } catch (err) {
        return send(err.status || 400, { ok: false, error: err.message, code: err.code });
      }
    },
  }));
}

export const mcpToolParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'toggle', 'save', 'delete', 'test'],
      description: 'Operation: "list" (get all MCP servers and their status/tools), "toggle" (enable or disable server), "save" (add or update server), "delete" (remove server), "test" (test connection to a server).'
    },
    id: {
      type: 'string',
      description: 'Server ID (e.g. "filesystem", "github"). Required for toggle and delete actions.'
    },
    enabled: {
      type: 'boolean',
      description: 'Whether the server is enabled (for toggle action).'
    },
    server: {
      type: 'object',
      description: 'Complete server configuration (for save or test actions: id, command, args, env, cwd, transport, url).'
    }
  },
  required: ['action']
};

export function registerMcp(ctx, settingsState, customConfigPath, historyRepair) {
  const settings = settingsState || getSettingsState();
  const manager = createMcpManager(ctx, settings, customConfigPath);

  ctx.inject(['connection'], scope => registerMcpConnection(scope, manager));
  ctx.inject(['webServer'], scope => {
    registerMcpHttp(scope, settings, manager);
  });

  ctx.effect(() => () => manager.dispose());

  // Auto-start all enabled MCP servers on application boot
  manager.startAllEnabled().catch(() => {});

  // Subscribe to module enabled changes
  if (settings && typeof settings.subscribe === 'function') {
    ctx.effect(() => settings.subscribe(modules => {
      if (modules.mcp === false) {
        manager.stopAll();
      } else {
        manager.startAllEnabled().catch(() => {});
      }
    }));
  }

  // Model tool
  const tools = ctx.get('tools');
  if (tools) {
    ctx.effect(() => tools.register({
      name: 'harness_qol_mcp',
      description: 'Manage MCP (Model Context Protocol) servers in DeepSeek Harness: list active servers and their exposed tools, toggle servers on/off, or add/test new MCP servers.',
      parameters: mcpToolParameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
      isConcurrencySafe: request => (request?.action ?? 'list') === 'list',
      execute: async (request) => {
        if (settings && !settings.isModuleEnabled('mcp')) {
          throw new Error('Module "mcp" is disabled in Harness QOL settings / Модуль "mcp" отключён в настройках Harness QOL.');
        }
        const action = request.action || 'list';
        if (action === 'list') {
          const servers = manager.getServers();
          return historyRepair ? { ...servers, historyRepair: historyRepair.status() } : servers;
        }
        if (action === 'toggle') {
          if (!request.id) throw new Error('Server "id" is required for toggle action');
          return await manager.toggleServer(request.id, request.enabled);
        }
        if (action === 'save') {
          if (!request.server) throw new Error('Server config "server" is required for save action');
          return await manager.saveServer(request.server);
        }
        if (action === 'delete') {
          if (!request.id) throw new Error('Server "id" is required for delete action');
          return await manager.deleteServer(request.id);
        }
        if (action === 'test') {
          return await manager.testServer(request.server || { id: request.id });
        }
        throw new Error(`Unknown action: ${action}`);
      },
    }));
  }

  // Chat slash command
  const commands = ctx.get('commands');
  if (commands) {
        ctx.effect(() => commands.register({
      name: 'mcp',
      description: 'Manage MCP (Model Context Protocol) servers: /mcp list, /mcp enable <id>, /mcp disable <id>, /mcp test <id>.',
      recordInput: true,
      input: { hint: 'list | enable <id> | disable <id> | test <id>' },
      async handler(invocation) {
        const text = invocation.rawInput?.trim() || 'list';
        const [subCmd, targetId] = text.split(/\s+/);
        try {
          if (subCmd === 'list' || !subCmd) {
            const data = manager.getServers();
            const lines = data.servers.map(s => {
              const statusTag = `[${s.status}]`;
              const toolsCount = s.tools?.length ? ` (${s.tools.length} tools)` : '';
              return `${statusTag} **${s.name || s.id}** [${s.id}] — ${s.status}${toolsCount}`;
            });
            return {
              kind: 'success',
              text: `### MCP Servers (${data.servers.length})\n\n${lines.join('\n') || 'No configured MCP servers.'}\n\nConfig: \`${data.configPath}\``
            };
          }
          if (subCmd === 'enable' && targetId) {
            const res = await manager.toggleServer(targetId, true);
            return { kind: 'success', text: `Server "${targetId}" enabled (${res.status}).` };
          }
          if (subCmd === 'disable' && targetId) {
            await manager.toggleServer(targetId, false);
            return { kind: 'success', text: `Server "${targetId}" disabled.` };
          }
          if (subCmd === 'test' && targetId) {
            const servers = manager.getServers().servers;
            const target = servers.find(s => s.id === targetId);
            if (!target) return { kind: 'error', text: `Server "${targetId}" not found.` };
            const res = await manager.testServer(target);
            if (res.ok) {
              const toolNames = res.tools?.map(t => t.name).join(', ') || 'none';
              return { kind: 'success', text: `Connection to "${targetId}" successful. Tools found: ${res.count} (${toolNames})` };
            }
            return { kind: 'error', text: `Connection to "${targetId}" failed: ${res.error}` };
          }
          return { kind: 'error', text: 'Usage: /mcp [list | enable <id> | disable <id> | test <id>]' };
        } catch (err) {
          return { kind: 'error', text: `Error: ${err.message}` };
        }
      }
    }));
  }

  return manager;
}
