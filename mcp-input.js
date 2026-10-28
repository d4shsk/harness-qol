// Shared by Host and the generated Client. Parsing never downloads or executes code.
const MCP_AGENT_BROWSER_PACKAGE = 'agent-browser@0.40.0';

function mcpInputError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseMcpUrl(raw) {
  let url;
  try { url = new URL(raw); } catch {
    throw mcpInputError('invalidUrl', 'Enter a valid HTTP(S) MCP endpoint or a supported GitHub URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /\s|\\/.test(raw)) {
    throw mcpInputError('invalidUrl', 'Only HTTP(S) URLs without embedded credentials are supported.');
  }
  return url;
}

function isMcpRepositoryUrl(url) {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return ['github.com', 'www.github.com', 'raw.githubusercontent.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'git.sr.ht']
    .some(domain => host === domain || host.endsWith('.' + domain))
    || host.includes('github.com') || /\.git(?:\/|$)/i.test(url.pathname);
}

function agentBrowserMcpRecipe() {
  return {
    id: 'agent-browser', name: 'Agent Browser', command: 'npx',
    args: ['-y', MCP_AGENT_BROWSER_PACKAGE, 'mcp'], env: {}, transport: 'stdio',
    description: 'Browser automation via the agent-browser MCP stdio server',
    tip: 'Requires Node.js 24+. Before browser actions, install Chrome once with: npx -y agent-browser@0.40.0 install',
    source: 'https://github.com/vercel-labs/agent-browser', type: 'Supported GitHub MCP',
  };
}

function parseMcpRepository(raw, url) {
  // Exact recipes, not repo-name -> npm-name guessing. Unknown repositories fail closed.
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/$/, '').replace(/\.git$/, '').toLowerCase();
  if (url.protocol === 'https:' && host === 'github.com' && !url.port) {
    if (path === '/vercel-labs/agent-browser') return agentBrowserMcpRecipe();
    const match = path.match(/^\/modelcontextprotocol\/servers\/tree\/main\/src\/(filesystem|memory|github|sqlite|fetch)$/);
    if (match) {
      const id = match[1];
      const python = ['sqlite', 'fetch'].includes(id);
      return {
        id, name: `${id} MCP`, command: python ? 'uvx' : 'npx',
        args: python ? [`mcp-server-${id}`] : ['-y', `@modelcontextprotocol/server-${id}`],
        env: id === 'github' ? { GITHUB_PERSONAL_ACCESS_TOKEN: '' } : {},
        transport: 'stdio', source: raw, type: 'Supported GitHub MCP',
      };
    }
  }
  throw mcpInputError('unsupportedRepository', 'This Git repository has no supported MCP launch recipe. Paste the MCP command or mcpServers JSON from its documentation, then use Test connection. A repository name is not an npm package or an MCP endpoint.');
}

export function validateMcpServerInput(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw mcpInputError('invalidConfig', 'Invalid MCP server configuration.');
  const transport = config.transport || (config.url ? 'streamable-http' : 'stdio');
  if (!['stdio', 'streamable-http', 'sse'].includes(transport)) throw mcpInputError('invalidConfig', 'Unsupported MCP transport.');
  if (transport === 'stdio' && (typeof config.command !== 'string' || !config.command.trim())) throw mcpInputError('invalidConfig', 'An MCP stdio command is required.');
  if (transport !== 'stdio' && !config.url) throw mcpInputError('invalidUrl', 'An HTTP(S) MCP endpoint is required.');
  if (config.url) {
    const url = parseMcpUrl(config.url);
    if (isMcpRepositoryUrl(url)) throw mcpInputError('repositoryEndpoint', 'A Git repository page is not an MCP HTTP endpoint. Use a supported Quick install link or the documented MCP command.');
  }
}

export function formatMcpArgs(args) {
  // Preserve spaces, quotes and Windows backslashes when the form round-trips argv.
  return args.map(arg => {
    const value = String(arg);
    return !value || /[\s"']/.test(value) ? '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : value;
  }).join(' ');
}

export function splitCommandArgs(str) {
  if (!str || typeof str !== 'string') return [];
  const args = [];
  let current = '', quote = '', started = false;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '\\' && quote === '"' && /["\\]/.test(str[i + 1] || '')) {
      current += str[++i]; started = true;
    } else if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? '' : char; started = true;
    } else if (/\s/.test(char) && !quote) {
      if (started) args.push(current);
      current = ''; started = false;
    } else { current += char; started = true; }
  }
  if (quote) throw mcpInputError('invalidCommand', 'Unclosed quote in MCP command arguments.');
  if (started) args.push(current);
  return args;
}

function parseMcpInputUnchecked(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  // 1. JSON configuration (e.g. Claude Desktop, Cursor or raw server definition)
  let jsonToParse = raw;
  if (!jsonToParse.startsWith('{') && /^\s*"[\w-]+"\s*:\s*\{/.test(jsonToParse)) {
    jsonToParse = '{' + jsonToParse + '}';
  }
  if (jsonToParse.startsWith('{')) {
    try {
      const parsed = JSON.parse(jsonToParse);
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        const firstKey = Object.keys(parsed.mcpServers)[0];
        if (firstKey) {
          const cfg = parsed.mcpServers[firstKey];
          return {
            id: firstKey,
            name: cfg.name || firstKey,
            command: cfg.command || '',
            args: Array.isArray(cfg.args) ? cfg.args : [],
            env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
            cwd: cfg.cwd || '',
            url: cfg.url || '',
            headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
            transport: cfg.transport || (cfg.url ? 'streamable-http' : 'stdio'),
            description: cfg.description || '',
            type: 'JSON (mcpServers)',
          };
        }
      }
      if (parsed.command || parsed.url) {
        const id = parsed.id || parsed.name || 'custom-mcp';
        return {
          id: id.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
          name: parsed.name || id,
          command: parsed.command || '',
          args: Array.isArray(parsed.args) ? parsed.args : [],
          env: parsed.env && typeof parsed.env === 'object' ? parsed.env : {},
          cwd: parsed.cwd || '',
          url: parsed.url || '',
          headers: parsed.headers && typeof parsed.headers === 'object' ? parsed.headers : {},
          transport: parsed.transport || (parsed.url ? 'streamable-http' : 'stdio'),
          description: parsed.description || '',
          type: 'JSON (Config)',
        };
      }
      const firstKey = Object.keys(parsed)[0];
      if (firstKey && typeof parsed[firstKey] === 'object') {
        const cfg = parsed[firstKey];
        return {
          id: firstKey,
          name: cfg.name || firstKey,
          command: cfg.command || '',
          args: Array.isArray(cfg.args) ? cfg.args : [],
          env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
          cwd: cfg.cwd || '',
          url: cfg.url || '',
          headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
          transport: cfg.transport || (cfg.url ? 'streamable-http' : 'stdio'),
          description: cfg.description || '',
          type: 'JSON',
        };
      }
    } catch (_e) {}
  }

  // URLs are parsed by authority, never by an unanchored substring regex.
  if (/^(?:[a-z][a-z0-9+.-]*:|(?:www\.)?github\.com\/)/i.test(raw)) {
    const url = parseMcpUrl(raw);
    if (isMcpRepositoryUrl(url)) return parseMcpRepository(raw, url);
    const lastPart = url.pathname.replace(/\/$/, '').split('/').pop() || 'remote-mcp';
    return {
      id: lastPart.toLowerCase().replace(/[^a-z0-9_-]/g, '-'), name: `${url.hostname} MCP`,
      url: raw, transport: 'streamable-http', headers: {},
      description: `Remote MCP endpoint (not yet tested): ${raw}`, type: 'HTTP Endpoint (unverified)',
    };
  }

  // 4. CLI command string (e.g. "npx -y @modelcontextprotocol/server-filesystem", "uvx mcp-server-sqlite --db-path ./test.db")
  if (/^(npx|uvx|docker|node|python|python3)\b/i.test(raw)) {
    const parts = splitCommandArgs(raw);
    const command = parts[0];
    const args = parts.slice(1);
    if (command === 'npx' && /^(?:-y\s+|--yes\s+)?agent-browser$/.test(args.join(' '))) {
      return agentBrowserMcpRecipe();
    }

    let guessedName = 'mcp-server';
    for (const arg of args) {
      if (!arg.startsWith('-') && !arg.includes('=') && (!arg.includes('/') || arg.startsWith('@')) && !arg.includes('\\')) {
        guessedName = arg.replace(/^@[\w-]+\//, '');
        break;
      }
    }

    const cleanId = guessedName.replace(/^@[\w-]+\//, '').replace(/^mcp-server-|^mcp-|^server-|-mcp$/gi, '').toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    return {
      id: cleanId || 'custom-mcp',
      name: guessedName || command,
      command,
      args,
      env: cleanId === 'github' ? { GITHUB_PERSONAL_ACCESS_TOKEN: '' } : {},
      transport: 'stdio',
      description: raw,
      type: 'CLI Command',
    };
  }

  if (raw === 'agent-browser') return agentBrowserMcpRecipe();

  // 5. Bare package name (e.g. "@modelcontextprotocol/server-filesystem", "mcp-server-sqlite")
  if (/^(@[\w-]+\/)?[\w-]+$/.test(raw)) {
    const isPython = /^mcp-server-/.test(raw);
    const cmd = isPython ? 'uvx' : 'npx';
    const pkgArgs = isPython ? [raw] : ['-y', raw];
    const cleanId = raw.replace(/^@[\w-]+\//, '').replace(/^mcp-server-|^mcp-|^server-|-mcp$/gi, '').toLowerCase();
    return {
      id: cleanId || 'mcp-server',
      name: raw,
      command: cmd,
      args: pkgArgs,
      env: cleanId === 'github' ? { GITHUB_PERSONAL_ACCESS_TOKEN: '' } : {},
      transport: 'stdio',
      description: `Пакет ${raw}`,
      type: 'Package Name',
    };
  }

  return null;
}

export function smartParseInput(input) {
  const parsed = parseMcpInputUnchecked(input);
  if (parsed) validateMcpServerInput(parsed);
  return parsed;
}
