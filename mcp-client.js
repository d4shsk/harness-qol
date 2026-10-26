// Harness-QOL MCP (Model Context Protocol) Manager for Settings.
// Concatenate inside the Client ModuleLoader factory.

const MCP_ICON_SVG = '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';

function patchMcpNavIcon() {
  if (typeof document === 'undefined') return;
  const spans = document.querySelectorAll('span');
  for (const span of spans) {
    const text = (span.textContent || '').trim();
    if (text === 'MCP Servers' || text === 'MCP серверы' || text === 'MCP') {
      const btn = span.closest('button');
      if (btn) {
        btn.setAttribute('data-nav-id', 'mcp');
        const svg = btn.querySelector('svg');
        if (svg && svg.getAttribute('data-icon') !== 'mcp') {
          svg.setAttribute('viewBox', '0 0 24 24');
          svg.setAttribute('width', '16');
          svg.setAttribute('height', '16');
          svg.setAttribute('data-icon', 'mcp');
          svg.innerHTML = MCP_ICON_SVG;
        }
      }
    }
  }
}

function initMcpNavObserver() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  patchMcpNavIcon();
  if (window.__mcpNavObserver) return () => {};

  let observer = null;
  if (typeof MutationObserver !== 'undefined') {
    try {
      observer = new MutationObserver(() => patchMcpNavIcon());
      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
      });
    } catch (_e) {}
  }
  const onClick = () => setTimeout(patchMcpNavIcon, 10);
  window.addEventListener('click', onClick, true);
  const intervalId = setInterval(patchMcpNavIcon, 300);
  window.__mcpNavObserver = { observer, intervalId, onClick };

  return () => {
    if (observer) observer.disconnect();
    clearInterval(intervalId);
    window.removeEventListener('click', onClick, true);
    delete window.__mcpNavObserver;
  };
}

function registerMcpClient(ctx, React, t, store = qolModulesStore) {
  const h = React.createElement;

  const css = `
.hq-mcp-section{max-width:840px;width:100%;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:16px;box-sizing:border-box}
.hq-mcp-section *{box-sizing:border-box}
.hq-mcp-header{display:flex;flex-direction:column;gap:4px}
.hq-mcp-header-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.hq-mcp-title{margin:0;font-size:18px;font-weight:600;line-height:24px}
.hq-mcp-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px}
.hq-mcp-top-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hq-mcp-btn{padding:6px 12px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:all .15s}
.hq-mcp-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border:none;font-weight:500}
.hq-mcp-btn-primary:hover:not(:disabled){opacity:.9}
.hq-mcp-btn-secondary{background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}
.hq-mcp-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.hq-mcp-btn-sm{padding:4px 8px;font-size:12px;border-radius:6px}
.hq-mcp-btn-danger{color:var(--dsw-alias-state-error-primary,#ef4444);border-color:rgba(239,68,68,.3)}
.hq-mcp-btn-danger:hover:not(:disabled){background:rgba(239,68,68,.1)}
.hq-mcp-btn:disabled{opacity:.4;cursor:default}

.hq-mcp-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px}
.hq-mcp-path-box{display:flex;align-items:center;gap:8px;overflow:hidden;min-width:0}
.hq-mcp-path-label{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.hq-mcp-path-val{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}

.hq-mcp-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.hq-mcp-search-wrap{position:relative;flex:1;min-width:200px}
.hq-mcp-search{width:100%;padding:6px 10px 6px 30px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);outline:none}
.hq-mcp-search:focus{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.hq-mcp-search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--dsw-alias-label-secondary);pointer-events:none}
.hq-mcp-filter-tabs{display:inline-flex;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px}
.hq-mcp-tab{padding:4px 10px;border:none;background:transparent;border-radius:6px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.hq-mcp-tab:hover{color:var(--dsw-alias-label-primary)}
.hq-mcp-tab[data-active=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:0 1px 3px rgba(0,0,0,.08)}

.hq-mcp-list{display:flex;flex-direction:column;gap:10px}
.hq-mcp-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;transition:border-color .15s}
.hq-mcp-card:hover{border-color:var(--dsw-alias-border-l1,rgba(0,0,0,.2))}
.hq-mcp-card[data-enabled=false]{opacity:.75}
.hq-mcp-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.hq-mcp-card-title-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hq-mcp-card-name{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.hq-mcp-card-id{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.06);color:var(--dsw-alias-label-secondary)}
.hq-mcp-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500}
.hq-mcp-badge[data-status=connected]{background:rgba(34,197,94,.12);color:#16a34a}
.hq-mcp-badge[data-status=connecting]{background:rgba(234,179,8,.15);color:#b45309}
.hq-mcp-badge[data-status=error]{background:rgba(239,68,68,.12);color:#dc2626}
.hq-mcp-badge[data-status=disabled]{background:rgba(148,163,184,.15);color:var(--dsw-alias-label-secondary)}
.hq-mcp-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.hq-mcp-transport-badge{font-size:11px;padding:1px 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);text-transform:uppercase}

.hq-mcp-cmd-box{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;padding:6px 10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow-x:auto;color:var(--dsw-alias-label-primary);word-break:break-all}
.hq-mcp-card-desc{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.hq-mcp-tip-box{font-size:12px;line-height:17px;padding:6px 10px;background:rgba(234,179,8,.08);border:1px solid rgba(234,179,8,.2);border-radius:6px;color:#b45309}
.hq-mcp-error-box{font-size:12px;line-height:18px;padding:8px 10px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:6px;color:#dc2626;white-space:pre-wrap;word-break:break-word}

.hq-mcp-tools-toggle{display:inline-flex;align-items:center;gap:6px;background:none;border:none;padding:0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.hq-mcp-tools-toggle:hover{color:var(--dsw-alias-label-primary)}
.hq-mcp-tools-list{display:flex;flex-direction:column;gap:6px;margin-top:6px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2)}
.hq-mcp-tool-item{display:flex;flex-direction:column;gap:2px;padding:6px 8px;background:var(--dsw-alias-bg-base);border-radius:6px;font-size:12px}
.hq-mcp-tool-name{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-weight:600;color:var(--dsw-alias-label-primary)}
.hq-mcp-tool-desc{color:var(--dsw-alias-label-secondary);font-size:11px}

.hq-mcp-card-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding-top:4px}
.hq-mcp-card-actions{display:flex;align-items:center;gap:6px}

.hq-mcp-switch{display:inline-flex;align-items:center;flex:none;width:38px;height:22px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s}
.hq-mcp-switch[aria-checked=true]{background:var(--dsw-alias-label-primary)}
.hq-mcp-switch .thumb{width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s}
.hq-mcp-switch[aria-checked=true] .thumb{transform:translateX(16px)}

.hq-mcp-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px}
.hq-mcp-modal{background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;max-width:680px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 12px 36px rgba(0,0,0,.25);overflow:hidden;color:var(--dsw-alias-label-primary)}
.hq-mcp-modal-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.hq-mcp-modal-title{margin:0;font-size:16px;font-weight:600}
.hq-mcp-modal-body{padding:16px 20px;overflow-y:auto;display:flex;flex-direction:column;gap:14px}
.hq-mcp-modal-foot{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}

.hq-mcp-form-row{display:flex;flex-direction:column;gap:6px}
.hq-mcp-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.hq-mcp-hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.hq-mcp-input{width:100%;padding:8px 10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);outline:none}
.hq-mcp-input:focus{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.hq-mcp-input-code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px}

.hq-mcp-presets-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;margin-bottom:8px}
.hq-mcp-preset-card{padding:8px 10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;text-align:left;display:flex;flex-direction:column;gap:3px;transition:all .15s}
.hq-mcp-preset-card:hover{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.hq-mcp-preset-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.hq-mcp-preset-desc{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:14px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}

.hq-mcp-env-table{display:flex;flex-direction:column;gap:6px}
.hq-mcp-env-row{display:flex;align-items:center;gap:6px}
.hq-mcp-empty{text-align:center;padding:32px 16px;color:var(--dsw-alias-label-secondary);font-size:13px}
`;

  function splitArgs(str) {
    if (!str || typeof str !== 'string') return [];
    const matches = [];
    let current = '';
    let inDouble = false;
    let inSingle = false;
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (char === '"' && !inSingle) inDouble = !inDouble;
      else if (char === "'" && !inDouble) inSingle = !inSingle;
      else if (/\s/.test(char) && !inDouble && !inSingle) {
        if (current.length > 0) {
          matches.push(current);
          current = '';
        }
      } else current += char;
    }
    if (current.length > 0) matches.push(current);
    return matches;
  }

  function smartParseClient(input) {
    if (typeof input !== 'string') return null;
    const raw = input.trim();
    if (!raw) return null;

    // 1. JSON
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
              env: cfg.env || {},
              cwd: cfg.cwd || '',
              url: cfg.url || '',
              headers: cfg.headers || {},
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
            env: parsed.env || {},
            cwd: parsed.cwd || '',
            url: parsed.url || '',
            headers: parsed.headers || {},
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
            env: cfg.env || {},
            cwd: cfg.cwd || '',
            url: cfg.url || '',
            headers: cfg.headers || {},
            transport: cfg.transport || (cfg.url ? 'streamable-http' : 'stdio'),
            description: cfg.description || '',
            type: 'JSON',
          };
        }
      } catch (_e) {}
    }

    // 2. GitHub Subtree (e.g. servers/tree/main/src/filesystem)
    const ghSubMatch = raw.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tree\/[^\/]+\/src\/([A-Za-z0-9_.-]+)/i);
    if (ghSubMatch) {
      const sub = ghSubMatch[3];
      return {
        id: sub.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
        name: `${sub} MCP`,
        command: 'npx',
        args: ['-y', `@modelcontextprotocol/server-${sub}`],
        env: sub === 'github' ? { GITHUB_PERSONAL_ACCESS_TOKEN: '' } : {},
        transport: 'stdio',
        description: `Official ${sub} server from modelcontextprotocol repository`,
        source: raw,
        type: 'GitHub Subtree',
      };
    }

    // 3. GitHub repository URL
    const ghMatch = raw.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
    if (ghMatch) {
      const owner = ghMatch[1];
      const repo = ghMatch[2].replace(/\.git$/, '');
      const cleanId = repo.replace(/^mcp-server-|^mcp-|-mcp$/gi, '') || repo;
      return {
        id: cleanId.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
        name: repo,
        command: 'npx',
        args: ['-y', repo],
        env: {},
        transport: 'stdio',
        description: `MCP server from GitHub (${owner}/${repo})`,
        source: `https://github.com/${owner}/${repo}`,
        type: 'GitHub Repo',
      };
    }

    // 4. HTTP / SSE URL endpoint
    if (/^https?:\/\//i.test(raw)) {
      try {
        const url = new URL(raw);
        const pathname = url.pathname.replace(/\/$/, '');
        const lastPart = pathname.split('/').pop() || 'remote-mcp';
        return {
          id: lastPart.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
          name: `${url.hostname} MCP`,
          url: raw,
          transport: 'streamable-http',
          headers: {},
          description: `Remote MCP server: ${raw}`,
          type: 'HTTP Endpoint',
        };
      } catch (_e) {}
    }

    // 5. CLI command string (e.g. npx, uvx, docker, node, python)
    if (/^(npx|uvx|docker|node|python|python3)\b/i.test(raw)) {
      const parts = splitArgs(raw);
      const command = parts[0];
      const args = parts.slice(1);
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

    // 6. Bare package name
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
        description: `Package ${raw}`,
        type: 'Package Name',
      };
    }

    return null;
  }

  function McpSettingsSection() {
    React.useSyncExternalStore(callback => ctx.locale.subscribe(callback), () => ctx.locale.getSnapshot());

    const [servers, setServers] = React.useState([]);
    const [configPath, setConfigPath] = React.useState('~/.dsh/mcp-servers.json');
    const [hasClaude, setHasClaude] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [search, setSearch] = React.useState('');
    const [filter, setFilter] = React.useState('all'); // all, connected, disabled, error
    const [expandedTools, setExpandedTools] = React.useState({});
    const [editModalOpen, setEditModalOpen] = React.useState(false);
    const [importModalOpen, setImportModalOpen] = React.useState(false);
    const [editingServer, setEditingServer] = React.useState(null);
    const [testResult, setTestResult] = React.useState(null);
    const [testing, setTesting] = React.useState(false);
    const [presets, setPresets] = React.useState([]);
    const [quickInput, setQuickInput] = React.useState('');
    const [detectedType, setDetectedType] = React.useState(null);

    // Form state
    const [formId, setFormId] = React.useState('');
    const [formName, setFormName] = React.useState('');
    const [formTransport, setFormTransport] = React.useState('stdio');
    const [formCommand, setFormCommand] = React.useState('');
    const [formArgs, setFormArgs] = React.useState('');
    const [formUrl, setFormUrl] = React.useState('');
    const [formCwd, setFormCwd] = React.useState('');
    const [formDesc, setFormDesc] = React.useState('');
    const [formTip, setFormTip] = React.useState('');
    const [formEnv, setFormEnv] = React.useState([]); // array of { key, value }
    const [importText, setImportText] = React.useState('');
    const [importError, setImportError] = React.useState('');

    async function loadData() {
      try {
        setLoading(true);
        const res = await fetch('/harness-qol/mcp/list');
        if (res.ok) {
          const data = await res.json();
          if (data && data.ok) {
            setServers(data.servers || []);
            if (data.configPath) setConfigPath(data.configPath);
            setHasClaude(!!data.hasClaudeConfig);
          }
        }
      } catch (err) {
        console.error('[harness-qol:mcp-client] Failed to load servers:', err);
      } finally {
        setLoading(false);
      }
    }

    async function loadPresets() {
      try {
        const res = await fetch('/harness-qol/mcp/presets');
        if (res.ok) {
          const data = await res.json();
          if (data && data.ok && Array.isArray(data.presets)) {
            setPresets(data.presets);
          }
        }
      } catch (_e) {}
    }

    React.useEffect(() => {
      loadData();
      loadPresets();
    }, []);

    async function toggleServer(id, enabled) {
      setServers(prev => prev.map(s => s.id === id ? { ...s, enabled: !enabled, status: !enabled ? 'connecting' : 'disabled' } : s));
      try {
        const res = await fetch('/harness-qol/mcp/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, enabled: !enabled }),
        });
        if (res.ok) {
          loadData();
        }
      } catch (_err) {
        loadData();
      }
    }

    async function restartServer(id) {
      try {
        setServers(prev => prev.map(s => s.id === id ? { ...s, status: 'connecting' } : s));
        await fetch('/harness-qol/mcp/restart', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        loadData();
      } catch (_e) {
        loadData();
      }
    }

    async function deleteServer(id) {
      if (!confirm(`Delete MCP server "${id}"?`)) return;
      try {
        await fetch('/harness-qol/mcp/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        loadData();
      } catch (_e) {
        loadData();
      }
    }

    function openEditModal(srv = null) {
      setEditingServer(srv);
      setTestResult(null);
      setQuickInput('');
      setDetectedType(null);
      if (srv) {
        setFormId(srv.id || '');
        setFormName(srv.name || srv.id || '');
        setFormTransport(srv.transport || 'stdio');
        setFormCommand(srv.command || '');
        setFormArgs(Array.isArray(srv.args) ? srv.args.join(' ') : '');
        setFormUrl(srv.url || '');
        setFormCwd(srv.cwd || '');
        setFormDesc(srv.description || '');
        setFormTip(srv.tip || '');
        const envList = [];
        if (srv.env && typeof srv.env === 'object') {
          for (const [k, v] of Object.entries(srv.env)) {
            envList.push({ key: k, value: String(v) });
          }
        }
        setFormEnv(envList);
      } else {
        setFormId('');
        setFormName('');
        setFormTransport('stdio');
        setFormCommand('npx');
        setFormArgs('');
        setFormUrl('');
        setFormCwd('');
        setFormDesc('');
        setFormTip('');
        setFormEnv([]);
      }
      setEditModalOpen(true);
    }

    function applyParsedServer(p) {
      if (!p) return;
      if (p.id) setFormId(p.id);
      if (p.name) setFormName(p.name);
      if (p.transport) setFormTransport(p.transport);
      if (p.command !== undefined) setFormCommand(p.command);
      if (p.args) setFormArgs(Array.isArray(p.args) ? p.args.join(' ') : String(p.args));
      if (p.url !== undefined) setFormUrl(p.url);
      if (p.cwd !== undefined) setFormCwd(p.cwd);
      if (p.description) setFormDesc(p.description);
      if (p.tip) setFormTip(p.tip);
      if (p.env && typeof p.env === 'object') {
        const envList = [];
        for (const [k, v] of Object.entries(p.env)) {
          envList.push({ key: k, value: String(v) });
        }
        setFormEnv(envList);
      }
    }

    function applyPreset(p) {
      setFormId(p.id || '');
      setFormName(p.name || '');
      setFormTransport(p.transport || 'stdio');
      setFormCommand(p.command || '');
      setFormArgs(Array.isArray(p.args) ? p.args.join(' ') : '');
      setFormUrl(p.url || '');
      setFormDesc(p.description || '');
      setFormTip(p.tip || '');
      const envList = [];
      if (p.env && typeof p.env === 'object') {
        for (const [k, v] of Object.entries(p.env)) {
          envList.push({ key: k, value: String(v) });
        }
      }
      setFormEnv(envList);
      setTestResult(null);
    }

    function handleQuickInput(val) {
      setQuickInput(val);
      if (!val || !val.trim()) {
        setDetectedType(null);
        return;
      }
      const clientParsed = smartParseClient(val);
      if (clientParsed) {
        setDetectedType(clientParsed.type || 'Server detected');
        applyParsedServer(clientParsed);
        return;
      }
      setDetectedType(null);

      fetch('/harness-qol/mcp/smart-parse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: val.trim() }),
      })
        .then(res => res.json())
        .then(data => {
          if (data && data.ok && data.parsed) {
            setDetectedType(data.parsed.type || 'Server detected');
            applyParsedServer(data.parsed);
          }
        })
        .catch(() => {});
    }

    async function testCurrentForm() {
      setTesting(true);
      setTestResult(null);
      const envObj = {};
      for (const item of formEnv) {
        if (item.key.trim()) envObj[item.key.trim()] = item.value;
      }
      const argsArray = formArgs.trim() ? splitArgs(formArgs) : [];
      const payload = {
        id: formId.trim() || 'test-server',
        name: formName.trim() || formId.trim(),
        transport: formTransport,
        command: formCommand.trim(),
        args: argsArray,
        env: envObj,
        cwd: formCwd.trim() || undefined,
        url: formUrl.trim(),
      };
      try {
        const res = await fetch('/harness-qol/mcp/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        setTestResult(data);
      } catch (err) {
        setTestResult({ ok: false, error: err.message });
      } finally {
        setTesting(false);
      }
    }

    async function saveCurrentForm() {
      if (!formId.trim()) {
        alert('Please specify a Server ID (e.g. "filesystem").');
        return;
      }
      if (formTransport === 'stdio' && !formCommand.trim()) {
        alert('Please specify a command (e.g. "npx").');
        return;
      }
      if (formTransport !== 'stdio' && !formUrl.trim()) {
        alert('Please specify an endpoint URL.');
        return;
      }

      const envObj = {};
      for (const item of formEnv) {
        if (item.key.trim()) envObj[item.key.trim()] = item.value;
      }
      const argsArray = formArgs.trim() ? splitArgs(formArgs) : [];
      const payload = {
        id: formId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
        name: formName.trim() || formId.trim(),
        transport: formTransport,
        command: formCommand.trim(),
        args: argsArray,
        env: envObj,
        cwd: formCwd.trim() || undefined,
        url: formUrl.trim(),
        description: formDesc.trim(),
        tip: formTip.trim(),
        enabled: editingServer ? editingServer.enabled : true,
      };

      try {
        const res = await fetch('/harness-qol/mcp/save', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ server: payload }),
        });
        if (res.ok) {
          setEditModalOpen(false);
          loadData();
        } else {
          const err = await res.json();
          alert(`Save error: ${err.error || 'Failed to save'}`);
        }
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    }

    async function handleImportSubmit() {
      setImportError('');
      if (!importText.trim()) return;
      try {
        const res = await fetch('/harness-qol/mcp/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config: importText.trim() }),
        });
        const data = await res.json();
        if (data.ok) {
          setImportModalOpen(false);
          setImportText('');
          loadData();
        } else {
          setImportError(data.error || 'Import error');
        }
      } catch (err) {
        setImportError(err.message);
      }
    }

    async function handleImportClaude() {
      try {
        const res = await fetch('/harness-qol/mcp/import-claude', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          alert(`Imported ${data.count} servers successfully.`);
          loadData();
        } else {
          alert(`Error: ${data.error}`);
        }
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    }

    async function openConfigFile() {
      try {
        await fetch('/harness-qol/mcp/open-config', { method: 'POST' });
      } catch (_e) {}
    }

    // Filtered list
    const filteredServers = servers.filter(s => {
      if (filter === 'connected' && s.status !== 'connected') return false;
      if (filter === 'disabled' && s.enabled !== false) return false;
      if (filter === 'error' && s.status !== 'error') return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      const matchName = (s.name || '').toLowerCase().includes(q);
      const matchId = (s.id || '').toLowerCase().includes(q);
      const matchCmd = (s.command || '').toLowerCase().includes(q) || (s.args || []).join(' ').toLowerCase().includes(q);
      const matchTools = (s.tools || []).some(tItem => (tItem.name || '').toLowerCase().includes(q) || (tItem.description || '').toLowerCase().includes(q));
      return matchName || matchId || matchCmd || matchTools;
    });

    return h('div', { className: 'hq-mcp-section' },
      h('style', null, css),

      // Header
      h('div', { className: 'hq-mcp-header' },
        h('div', { className: 'hq-mcp-header-row' },
          h('div', null,
            h('h2', { className: 'hq-mcp-title' }, t('mcp.title') || 'MCP Servers'),
            h('p', { className: 'hq-mcp-desc' }, t('mcp.desc') || 'Manage Model Context Protocol servers to give AI assistants specialized external tools (e.g. GitHub, local filesystem, databases).')),
          h('div', { className: 'hq-mcp-top-actions' },
            h('button', {
              type: 'button',
              className: 'hq-mcp-btn hq-mcp-btn-primary',
              onClick: () => openEditModal(null),
            }, '+ ' + (t('mcp.addServer') || 'Add Server')),
            h('button', {
              type: 'button',
              className: 'hq-mcp-btn hq-mcp-btn-secondary',
              onClick: () => setImportModalOpen(true),
            }, t('mcp.importJson') || 'Import JSON'),
            hasClaude && h('button', {
              type: 'button',
              className: 'hq-mcp-btn hq-mcp-btn-secondary',
              onClick: handleImportClaude,
              title: 'Import all servers from claude_desktop_config.json',
            }, t('mcp.importClaude') || 'From Claude Desktop')))),

      // Config path bar
      h('div', { className: 'hq-mcp-bar' },
        h('div', { className: 'hq-mcp-path-box' },
          h('span', { className: 'hq-mcp-path-label' }, (t('mcp.configFile') || 'Configuration file:') + ' '),
          h('span', { className: 'hq-mcp-path-val', title: configPath }, configPath)),
        h('button', {
          type: 'button',
          className: 'hq-mcp-btn hq-mcp-btn-secondary hq-mcp-btn-sm',
          onClick: openConfigFile,
        }, t('mcp.openFolder') || 'Open in File Manager')),

      // Search & Filters bar
      h('div', { className: 'hq-mcp-controls' },
        h('div', { className: 'hq-mcp-search-wrap' },
          h('svg', { className: 'hq-mcp-search-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2' },
            h('circle', { cx: '11', cy: '11', r: '8' }),
            h('line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' })),
          h('input', {
            type: 'text',
            className: 'hq-mcp-search',
            placeholder: t('mcp.searchPlaceholder') || 'Search by name, command, or tools…',
            value: search,
            onChange: e => setSearch(e.target.value),
          })),
        h('div', { className: 'hq-mcp-filter-tabs' },
          h('button', {
            type: 'button',
            className: 'hq-mcp-tab',
            'data-active': filter === 'all',
            onClick: () => setFilter('all'),
          }, (t('mcp.filterAll') || 'All') + ` (${servers.length})`),
          h('button', {
            type: 'button',
            className: 'hq-mcp-tab',
            'data-active': filter === 'connected',
            onClick: () => setFilter('connected'),
          }, (t('mcp.filterConnected') || 'Connected') + ` (${servers.filter(s => s.status === 'connected').length})`),
          h('button', {
            type: 'button',
            className: 'hq-mcp-tab',
            'data-active': filter === 'disabled',
            onClick: () => setFilter('disabled'),
          }, (t('mcp.filterDisabled') || 'Disabled') + ` (${servers.filter(s => s.enabled === false).length})`),
          servers.some(s => s.status === 'error') && h('button', {
            type: 'button',
            className: 'hq-mcp-tab',
            'data-active': filter === 'error',
            onClick: () => setFilter('error'),
            style: { color: '#dc2626' },
          }, (t('mcp.filterError') || 'Errors') + ` (${servers.filter(s => s.status === 'error').length})`))),

      // Server cards list
      loading && h('div', { className: 'hq-mcp-empty' }, t('mcp.loading') || 'Loading MCP servers…'),
      !loading && filteredServers.length === 0 && h('div', { className: 'hq-mcp-empty' },
        h('p', null, servers.length === 0
          ? (t('mcp.noServers') || 'No MCP servers configured yet.')
          : (t('mcp.noMatching') || 'No servers match current filter.'))),

      !loading && filteredServers.map(s => {
        const isEnabled = s.enabled !== false;
        const status = s.status || (isEnabled ? 'connected' : 'disabled');
        const isExpanded = !!expandedTools[s.id];
        const statusLabel = status === 'connected' ? (t('mcp.statusConnected') || 'Connected')
          : status === 'connecting' ? (t('mcp.statusConnecting') || 'Connecting…')
          : status === 'error' ? (t('mcp.statusError') || 'Error')
          : (t('mcp.statusDisabled') || 'Disabled');

        const cmdLine = s.transport === 'streamable-http' || s.transport === 'sse'
          ? (s.url || 'HTTP MCP')
          : `${s.command || ''} ${(s.args || []).join(' ')}`.trim();

        return h('div', { key: s.id, className: 'hq-mcp-card', 'data-enabled': String(isEnabled) },
          // Header row
          h('div', { className: 'hq-mcp-card-head' },
            h('div', { className: 'hq-mcp-card-title-group' },
              h('h3', { className: 'hq-mcp-card-name' }, s.name || s.id),
              h('span', { className: 'hq-mcp-card-id' }, s.id),
              h('span', { className: 'hq-mcp-badge', 'data-status': status },
                h('span', { className: 'hq-mcp-dot' }),
                statusLabel),
              h('span', { className: 'hq-mcp-transport-badge' }, s.transport || 'stdio'),
              s.tools && s.tools.length > 0 && h('span', { className: 'hq-mcp-badge', 'data-status': 'connected', style: { fontSize: '11px' } },
                `${s.tools.length} ${t('mcp.toolsCount') || 'tools'}`)),
            h('button', {
              type: 'button',
              role: 'switch',
              className: 'hq-mcp-switch',
              'aria-checked': isEnabled,
              title: isEnabled ? 'Disable server' : 'Enable server',
              onClick: () => toggleServer(s.id, isEnabled),
            }, h('span', { className: 'thumb' }))),

          // Command preview
          cmdLine && h('div', { className: 'hq-mcp-cmd-box' }, cmdLine),

          // Description or tip
          s.description && h('p', { className: 'hq-mcp-card-desc' }, s.description),
          s.tip && h('p', { className: 'hq-mcp-tip-box' }, s.tip),

          // Error box if failed
          status === 'error' && s.error && h('div', { className: 'hq-mcp-error-box' }, s.error),

          // Expandable tools list
          s.tools && s.tools.length > 0 && h('div', null,
            h('button', {
              type: 'button',
              className: 'hq-mcp-tools-toggle',
              onClick: () => setExpandedTools(prev => ({ ...prev, [s.id]: !prev[s.id] })),
            },
              h('span', null, isExpanded ? '▾' : '▸'),
              h('span', null, (isExpanded ? (t('mcp.hideTools') || 'Hide tools') : (t('mcp.showTools') || 'Show tools')) + ` (${s.tools.length})`)),
            isExpanded && h('div', { className: 'hq-mcp-tools-list' },
              s.tools.map((tItem, idx) => h('div', { key: idx, className: 'hq-mcp-tool-item' },
                h('span', { className: 'hq-mcp-tool-name' }, `mcp__${s.id}__${tItem.name}`),
                tItem.description && h('span', { className: 'hq-mcp-tool-desc' }, tItem.description))))),

          // Card Footer
          h('div', { className: 'hq-mcp-card-footer' },
            h('div', { className: 'hq-mcp-card-actions' },
              h('button', {
                type: 'button',
                className: 'hq-mcp-btn hq-mcp-btn-secondary hq-mcp-btn-sm',
                onClick: () => openEditModal(s),
              }, t('mcp.edit') || 'Configure'),
              h('button', {
                type: 'button',
                className: 'hq-mcp-btn hq-mcp-btn-secondary hq-mcp-btn-sm',
                onClick: () => restartServer(s.id),
                title: 'Restart server process',
              }, t('mcp.restart') || 'Restart'),
              h('button', {
                type: 'button',
                className: 'hq-mcp-btn hq-mcp-btn-secondary hq-mcp-btn-sm hq-mcp-btn-danger',
                onClick: () => deleteServer(s.id),
              }, t('mcp.delete') || 'Delete'))));
      }),

      // Add / Edit Modal
      editModalOpen && h('div', { className: 'hq-mcp-modal-backdrop', onClick: () => setEditModalOpen(false) },
        h('div', { className: 'hq-mcp-modal', onClick: e => e.stopPropagation() },
          h('div', { className: 'hq-mcp-modal-head' },
            h('h3', { className: 'hq-mcp-modal-title' }, editingServer ? (t('mcp.editModalTitle') || 'Configure MCP Server') : (t('mcp.addModalTitle') || 'Add MCP Server')),
            h('button', {
              type: 'button',
              className: 'hq-mcp-btn hq-mcp-btn-secondary hq-mcp-btn-sm',
              onClick: () => setEditModalOpen(false),
            }, '✕')),

          h('div', { className: 'hq-mcp-modal-body' },
            // Quick install input
            !editingServer && h('div', { className: 'hq-mcp-form-row' },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
                h('label', { className: 'hq-mcp-label' }, t('mcp.quickInstall') || 'Quick install'),
                detectedType && h('span', { style: { fontSize: '11px', color: '#16a34a', fontWeight: '500' } }, `Detected: ${detectedType}`)),
              h('div', { style: { display: 'flex', gap: '8px' } },
                h('input', {
                  type: 'text',
                  className: 'hq-mcp-input',
                  placeholder: 'Paste GitHub URL, npx/uvx command, package name, or JSON...',
                  value: quickInput,
                  onChange: e => handleQuickInput(e.target.value),
                  onPaste: e => {
                    const text = e.clipboardData?.getData('text') || '';
                    if (text) setTimeout(() => handleQuickInput(text), 10);
                  },
                }),
                h('button', {
                  type: 'button',
                  className: 'hq-mcp-btn hq-mcp-btn-secondary',
                  style: { flex: 'none' },
                  onClick: () => handleQuickInput(quickInput),
                }, 'Apply')),
              h('span', { className: 'hq-mcp-hint' }, 'Automatically detects package name, arguments, repository, and environment variables.')),

            // Server ID & Name
            h('div', { style: { display: 'flex', gap: '12px' } },
              h('div', { className: 'hq-mcp-form-row', style: { flex: 1 } },
                h('label', { className: 'hq-mcp-label' }, 'Server ID (alphanumeric, no spaces)*'),
                h('input', {
                  type: 'text',
                  className: 'hq-mcp-input hq-mcp-input-code',
                  placeholder: 'filesystem',
                  value: formId,
                  disabled: !!editingServer,
                  onChange: e => setFormId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-')),
                })),
              h('div', { className: 'hq-mcp-form-row', style: { flex: 1 } },
                h('label', { className: 'hq-mcp-label' }, 'Display name'),
                h('input', {
                  type: 'text',
                  className: 'hq-mcp-input',
                  placeholder: 'Local Filesystem',
                  value: formName,
                  onChange: e => setFormName(e.target.value),
                }))),

            // Transport selector
            h('div', { className: 'hq-mcp-form-row' },
              h('label', { className: 'hq-mcp-label' }, 'Transport type'),
              h('div', { style: { display: 'flex', gap: '16px' } },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px' } },
                  h('input', {
                    type: 'radio',
                    name: 'mcp-transport',
                    value: 'stdio',
                    checked: formTransport === 'stdio',
                    onChange: () => setFormTransport('stdio'),
                  }),
                  'stdio (CLI command / npx / uvx / docker)'),
                h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px' } },
                  h('input', {
                    type: 'radio',
                    name: 'mcp-transport',
                    value: 'streamable-http',
                    checked: formTransport !== 'stdio',
                    onChange: () => setFormTransport('streamable-http'),
                  }),
                  'HTTP / SSE (Remote endpoint URL)'))),

            // Stdio fields
            formTransport === 'stdio' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
              h('div', { style: { display: 'flex', gap: '12px' } },
                h('div', { className: 'hq-mcp-form-row', style: { width: '130px' } },
                  h('label', { className: 'hq-mcp-label' }, 'Command*'),
                  h('input', {
                    type: 'text',
                    className: 'hq-mcp-input hq-mcp-input-code',
                    placeholder: 'npx',
                    value: formCommand,
                    onChange: e => setFormCommand(e.target.value),
                  })),
                h('div', { className: 'hq-mcp-form-row', style: { flex: 1 } },
                  h('label', { className: 'hq-mcp-label' }, 'Arguments'),
                  h('input', {
                    type: 'text',
                    className: 'hq-mcp-input hq-mcp-input-code',
                    placeholder: '-y @modelcontextprotocol/server-filesystem C:\\Users\\...',
                    value: formArgs,
                    onChange: e => setFormArgs(e.target.value),
                  }))),
              h('div', { className: 'hq-mcp-form-row' },
                h('label', { className: 'hq-mcp-label' }, 'Working directory (CWD, optional)'),
                h('input', {
                  type: 'text',
                  className: 'hq-mcp-input hq-mcp-input-code',
                  placeholder: 'C:\\Users\\...',
                  value: formCwd,
                  onChange: e => setFormCwd(e.target.value),
                }))),

            // HTTP fields
            formTransport !== 'stdio' && h('div', { className: 'hq-mcp-form-row' },
              h('label', { className: 'hq-mcp-label' }, 'Endpoint URL*'),
              h('input', {
                type: 'text',
                className: 'hq-mcp-input hq-mcp-input-code',
                placeholder: 'http://127.0.0.1:8000/mcp',
                value: formUrl,
                onChange: e => setFormUrl(e.target.value),
              })),

            // Environment variables
            h('div', { className: 'hq-mcp-form-row' },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
                h('label', { className: 'hq-mcp-label' }, 'Environment variables'),
                h('button', {
                  type: 'button',
                  className: 'hq-mcp-btn hq-mcp-btn-secondary hq-mcp-btn-sm',
                  onClick: () => setFormEnv(prev => [...prev, { key: '', value: '' }]),
                }, '+ Add variable')),
              formEnv.length === 0 && h('span', { className: 'hq-mcp-hint' }, 'No environment variables configured.'),
              h('div', { className: 'hq-mcp-env-table' },
                formEnv.map((item, idx) => h('div', { key: idx, className: 'hq-mcp-env-row' },
                  h('input', {
                    type: 'text',
                    className: 'hq-mcp-input hq-mcp-input-code',
                    placeholder: 'KEY (e.g. GITHUB_PERSONAL_ACCESS_TOKEN)',
                    style: { flex: 1 },
                    value: item.key,
                    onChange: e => {
                      const next = [...formEnv];
                      next[idx].key = e.target.value;
                      setFormEnv(next);
                    },
                  }),
                  h('input', {
                    type: 'text',
                    className: 'hq-mcp-input hq-mcp-input-code',
                    placeholder: 'Value',
                    style: { flex: 2 },
                    value: item.value,
                    onChange: e => {
                      const next = [...formEnv];
                      next[idx].value = e.target.value;
                      setFormEnv(next);
                    },
                  }),
                  h('button', {
                    type: 'button',
                    className: 'hq-mcp-btn hq-mcp-btn-secondary hq-mcp-btn-sm hq-mcp-btn-danger',
                    onClick: () => setFormEnv(prev => prev.filter((_, i) => i !== idx)),
                  }, '✕')))),

            // Description
            h('div', { className: 'hq-mcp-form-row' },
              h('label', { className: 'hq-mcp-label' }, 'Description'),
              h('input', {
                type: 'text',
                className: 'hq-mcp-input',
                placeholder: 'Optional description of what this server provides...',
                value: formDesc,
                onChange: e => setFormDesc(e.target.value),
              })),

            // Tip note
            formTip && h('div', { className: 'hq-mcp-tip-box' }, formTip),

            // Test connection result banner
            testResult && h('div', {
              style: {
                padding: '10px 12px',
                borderRadius: '8px',
                fontSize: '12px',
                background: testResult.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
                border: `1px solid ${testResult.ok ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'}`,
                color: testResult.ok ? '#16a34a' : '#dc2626',
              }
            },
              testResult.ok
                ? `Connection successful. Discovered ${testResult.count || testResult.tools?.length || 0} tools: ${(testResult.tools || []).map(tool => tool.name).join(', ') || 'none'}`
                : `Connection failed: ${testResult.error || 'Could not connect'}`)),

          h('div', { className: 'hq-mcp-modal-foot' },
            h('button', {
              type: 'button',
              className: 'hq-mcp-btn hq-mcp-btn-secondary',
              onClick: testCurrentForm,
              disabled: testing,
            }, testing ? 'Testing…' : 'Test connection'),
            h('div', { style: { display: 'flex', gap: '8px' } },
              h('button', {
                type: 'button',
                className: 'hq-mcp-btn hq-mcp-btn-secondary',
                onClick: () => setEditModalOpen(false),
              }, 'Cancel'),
              h('button', {
                type: 'button',
                className: 'hq-mcp-btn hq-mcp-btn-primary',
                onClick: saveCurrentForm,
              }, 'Save')))))),

      // Import JSON Modal
      importModalOpen && h('div', { className: 'hq-mcp-modal-backdrop', onClick: () => setImportModalOpen(false) },
        h('div', { className: 'hq-mcp-modal', onClick: e => e.stopPropagation() },
          h('div', { className: 'hq-mcp-modal-head' },
            h('h3', { className: 'hq-mcp-modal-title' }, 'Import MCP JSON Configuration'),
            h('button', {
              type: 'button',
              className: 'hq-mcp-btn hq-mcp-btn-secondary hq-mcp-btn-sm',
              onClick: () => setImportModalOpen(false),
            }, '✕')),
          h('div', { className: 'hq-mcp-modal-body' },
            h('p', { className: 'hq-mcp-desc' },
              'Paste configuration JSON from Claude Desktop, Cursor, or standard mcpServers schema:'),
            h('textarea', {
              className: 'hq-mcp-input hq-mcp-input-code',
              style: { minHeight: '220px', resize: 'vertical' },
              placeholder: '{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users\\\\..."]\n    }\n  }\n}',
              value: importText,
              onChange: e => setImportText(e.target.value),
            }),
            importError && h('div', { className: 'hq-mcp-error-box' }, importError)),
          h('div', { className: 'hq-mcp-modal-foot' },
            h('button', {
              type: 'button',
              className: 'hq-mcp-btn hq-mcp-btn-secondary',
              onClick: () => setImportModalOpen(false),
            }, 'Cancel'),
            h('button', {
              type: 'button',
              className: 'hq-mcp-btn hq-mcp-btn-primary',
              onClick: handleImportSubmit,
            }, 'Import'))))
    );
  }

  let dispose = null;
  let cleanNav = null;

  function update() {
    const enabled = !store || store.isEnabled('mcp');
    if (enabled && !dispose) {
      dispose = ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'mcp',
        order: 13.5,
        label: () => 'MCP Servers',
      }, McpSettingsSection));
      cleanNav = initMcpNavObserver();
    } else if (!enabled && dispose) {
      dispose();
      dispose = null;
      if (cleanNav) {
        cleanNav();
        cleanNav = null;
      }
    }
  }

  update();
  const unsub = store?.subscribe ? store.subscribe(update) : null;
  return () => {
    if (unsub) unsub();
    if (dispose) dispose();
    if (cleanNav) cleanNav();
    dispose = null;
    cleanNav = null;
  };
}
