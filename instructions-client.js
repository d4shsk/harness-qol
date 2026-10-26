// Harness-QOL Instructions (AGENTS.md) editor for Settings.
// Concatenate inside the Client ModuleLoader factory.

const INSTRUCTIONS_ICON_SVG = '<path d="M3 1.5A1.5 1.5 0 0 1 4.5 0h5.086a1.5 1.5 0 0 1 1.06.44l3.914 3.914a1.5 1.5 0 0 1 .44 1.06V14.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 14.5v-13zm6.5 0v3.5a.5.5 0 0 0 .5.5H13l-3.5-4zM5 7a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1H5zm0 2.5a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1H5zm0 2.5a.5.5 0 0 0 0 1h3.5a.5.5 0 0 0 0-1H5z" fill="currentColor"/>';

function patchInstructionsNavIcon() {
  if (typeof document === 'undefined') return;
  const spans = document.querySelectorAll('span');
  for (const span of spans) {
    const text = (span.textContent || '').trim();
    if (text === 'Instructions' || text === 'Инструкции') {
      const btn = span.closest('button');
      if (btn) {
        btn.setAttribute('data-nav-id', 'instructions');
        const svg = btn.querySelector('svg');
        if (svg && svg.getAttribute('data-icon') !== 'instructions') {
          svg.setAttribute('viewBox', '0 0 16 16');
          svg.setAttribute('width', '16');
          svg.setAttribute('height', '16');
          svg.setAttribute('data-icon', 'instructions');
          svg.innerHTML = INSTRUCTIONS_ICON_SVG;
        }
      }
    }
  }
}

function initInstructionsNavObserver() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  patchInstructionsNavIcon();
  if (window.__instructionsNavObserver) return () => {};

  let observer = null;
  if (typeof MutationObserver !== 'undefined') {
    try {
      observer = new MutationObserver(() => patchInstructionsNavIcon());
      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
      });
    } catch (_e) {}
  }
  const onClick = () => setTimeout(patchInstructionsNavIcon, 10);
  window.addEventListener('click', onClick, true);
  const intervalId = setInterval(patchInstructionsNavIcon, 300);
  window.__instructionsNavObserver = { observer, intervalId, onClick };

  return () => {
    if (observer) observer.disconnect();
    clearInterval(intervalId);
    window.removeEventListener('click', onClick, true);
    delete window.__instructionsNavObserver;
  };
}

function registerInstructionsClient(ctx, React, t, store = qolModulesStore) {
  const h = React.createElement;

  const css = `
.hq-inst-section{max-width:760px;width:100%;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px;box-sizing:border-box}
.hq-inst-section *{box-sizing:border-box}
.hq-inst-header{display:flex;flex-direction:column;gap:4px}
.hq-inst-title{margin:0;font-size:18px;font-weight:600;line-height:24px}
.hq-inst-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px}
.hq-inst-path-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px;overflow:hidden;margin-top:2px}
.hq-inst-path{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.hq-inst-badge{flex:none;display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;line-height:16px}
.hq-inst-badge[data-exists=true]{background:rgba(34,197,94,.12);color:#16a34a}
.hq-inst-badge[data-exists=false]{background:rgba(148,163,184,.15);color:var(--dsw-alias-label-secondary)}
.hq-inst-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.hq-inst-editor-wrap{display:flex;flex-direction:column;position:relative}
.hq-inst-editor{width:100%;box-sizing:border-box;min-height:360px;max-height:560px;height:420px;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:13px;line-height:20px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;resize:vertical;outline:none;tab-size:2}
.hq-inst-editor:focus{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));box-shadow:0 0 0 1px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.hq-inst-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:2px}
.hq-inst-actions{display:flex;align-items:center;gap:8px}
.hq-inst-btn{padding:6px 14px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:opacity .15s}
.hq-inst-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border:none;font-weight:500}
.hq-inst-btn-primary:hover:not(:disabled){opacity:.9}
.hq-inst-btn-primary:disabled{opacity:.4;cursor:default}
.hq-inst-btn-secondary{background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}
.hq-inst-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.hq-inst-btn-secondary:disabled{opacity:.4;cursor:default}
.hq-inst-status{font-size:12px;line-height:18px}
.hq-inst-status-ok{color:#16a34a;font-weight:500}
.hq-inst-status-dirty{color:#d97706}
.hq-inst-status-err{color:var(--dsw-alias-state-error-primary,#ef4444)}
.hq-inst-meta{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
.hq-inst-tpl-menu{position:relative}
.hq-inst-tpl-dropdown{position:absolute;bottom:calc(100% + 6px);left:0;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:20;display:flex;flex-direction:column;min-width:230px;padding:4px}
.hq-inst-tpl-item{padding:7px 10px;text-align:left;background:transparent;border:none;border-radius:6px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.hq-inst-tpl-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
`;

  function InstructionsSettingsSection() {
    React.useSyncExternalStore(callback => ctx.locale.subscribe(callback), () => ctx.locale.getSnapshot());
    const [content, setContent] = React.useState('');
    const [savedContent, setSavedContent] = React.useState('');
    const [exists, setExists] = React.useState(false);
    const [path, setPath] = React.useState('');
    const [displayPath, setDisplayPath] = React.useState('~/.dsh/AGENTS.md');
    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const [statusMessage, setStatusMessage] = React.useState('');
    const [errorMessage, setErrorMessage] = React.useState('');
    const [templatesOpen, setTemplatesOpen] = React.useState(false);
    const textareaRef = React.useRef(null);

    React.useEffect(() => {
      let cancelled = false;
      async function loadInstructions() {
        try {
          setLoading(true);
          setErrorMessage('');
          setStatusMessage('');
          const res = await fetch('/harness-qol/instructions?action=read');
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const data = await res.json();
          if (cancelled) return;
          if (data.ok) {
            setContent(data.content || '');
            setSavedContent(data.content || '');
            setExists(!!data.exists);
            setPath(data.path || '');
            if (data.displayPath) setDisplayPath(data.displayPath);
          } else {
            throw new Error(data.error || 'Failed to read file');
          }
        } catch (err) {
          if (!cancelled) setErrorMessage((t('instructions.loadFailed') || 'Load failed') + ': ' + err.message);
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
      loadInstructions();
      return () => { cancelled = true; };
    }, []);

    const isDirty = content !== savedContent;

    const handleSave = async () => {
      if (saving) return;
      try {
        setSaving(true);
        setErrorMessage('');
        const res = await fetch('/harness-qol/instructions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'write', content }),
        });
        const data = await res.json();
        if (data.ok) {
          setSavedContent(content);
          setExists(true);
          setStatusMessage(t('instructions.saved') || 'Saved');
          setTimeout(() => setStatusMessage(''), 3000);
        } else {
          throw new Error(data.error || 'Save failed');
        }
      } catch (err) {
        setErrorMessage((t('instructions.saveFailed') || 'Save failed') + ': ' + err.message);
      } finally {
        setSaving(false);
      }
    };

    const handleRevert = () => {
      setContent(savedContent);
      setStatusMessage('');
      setErrorMessage('');
    };

    const handleKeyDown = e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const textarea = textareaRef.current;
        if (!textarea) return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const nextContent = content.substring(0, start) + '  ' + content.substring(end);
        setContent(nextContent);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }, 0);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };

    const insertTemplate = templateText => {
      const trimmed = templateText.trim();
      let next;
      if (!content.trim()) {
        next = trimmed + '\n';
      } else {
        next = content.replace(/\s+$/, '') + '\n\n' + trimmed + '\n';
      }
      setContent(next);
      setTemplatesOpen(false);
      if (textareaRef.current) textareaRef.current.focus();
    };

    const lineCount = content ? content.split('\n').length : 0;
    const charCount = content.length;
    const statsPattern = t('instructions.linesAndChars') || '{lines} lines, {chars} characters';
    const statsText = statsPattern.replace('{lines}', String(lineCount)).replace('{chars}', String(charCount));

    return h('section', { className: 'hq-inst-section', 'data-harness-qol-instructions': true, 'aria-label': t('instructions.title') || 'Instructions' },
      h('style', null, css),
      h('div', { className: 'hq-inst-header' },
        h('h2', { className: 'hq-inst-title' }, t('instructions.title') || 'Instructions'),
        h('p', { className: 'hq-inst-desc' }, t('instructions.desc') || 'Global instructions and rules loaded by DeepSeek Harness for the AI agent (compatible with AGENTS.md / Codex).')),
      h('div', { className: 'hq-inst-path-bar' },
        h('span', { className: 'hq-inst-path', title: path }, displayPath + (path ? ' (' + path + ')' : '')),
        h('span', { className: 'hq-inst-badge', 'data-exists': String(exists) },
          h('span', { className: 'hq-inst-dot' }),
          exists ? (t('instructions.statusExists') || 'File exists') : (t('instructions.statusNew') || 'New file (not created yet)'))),
      h('div', { className: 'hq-inst-editor-wrap' },
        h('textarea', {
          ref: textareaRef,
          className: 'hq-inst-editor',
          value: content,
          placeholder: '# Agent Instructions\n\n- Add guidelines and rules for the AI here...',
          spellCheck: false,
          disabled: loading,
          onChange: e => setContent(e.target.value),
          onKeyDown: handleKeyDown,
        })),
      h('div', { className: 'hq-inst-footer' },
        h('div', { className: 'hq-inst-actions' },
          h('button', {
            type: 'button',
            className: 'hq-inst-btn hq-inst-btn-primary',
            disabled: !isDirty || saving || loading,
            onClick: handleSave,
          }, saving ? (t('instructions.saving') || 'Saving…') : (t('instructions.save') || 'Save')),
          h('button', {
            type: 'button',
            className: 'hq-inst-btn hq-inst-btn-secondary',
            disabled: !isDirty || saving || loading,
            onClick: handleRevert,
          }, t('instructions.revert') || 'Revert'),
          h('div', { className: 'hq-inst-tpl-menu' },
            h('button', {
              type: 'button',
              className: 'hq-inst-btn hq-inst-btn-secondary',
              onClick: () => setTemplatesOpen(!templatesOpen),
            }, (t('instructions.template') || 'Insert template…') + ' ▾'),
            templatesOpen && h('div', { className: 'hq-inst-tpl-dropdown' },
              h('button', {
                type: 'button',
                className: 'hq-inst-tpl-item',
                onClick: () => insertTemplate('## Coding Guidelines\n- Always run tests before finishing a task.\n- Prefer concise and clean code.\n- Do not modify lockfiles directly.'),
              }, t('instructions.templateCodex') || 'Standard Codex guidelines'),
              h('button', {
                type: 'button',
                className: 'hq-inst-tpl-item',
                onClick: () => insertTemplate('## Communication\n- Answer the user in Russian (or requested language).\n- Explain key decisions concisely.'),
              }, t('instructions.templateRussian') || 'Russian language responses'),
              h('button', {
                type: 'button',
                className: 'hq-inst-tpl-item',
                onClick: () => insertTemplate('## Code Quality\n- Write unit tests for new functionality.\n- Keep components modular and single-purpose.'),
              }, t('instructions.templateQuality') || 'Code quality & testing rules'))),
          statusMessage && h('span', { className: 'hq-inst-status hq-inst-status-ok' }, statusMessage),
          !statusMessage && isDirty && h('span', { className: 'hq-inst-status hq-inst-status-dirty' }, t('instructions.unsaved') || 'Unsaved changes'),
          errorMessage && h('span', { className: 'hq-inst-status hq-inst-status-err' }, errorMessage)),
        h('span', { className: 'hq-inst-meta' }, statsText)));
  }

  let dispose = null;
  let cleanNav = null;

  function update() {
    const enabled = !store || store.isEnabled('instructions');
    if (enabled && !dispose) {
      dispose = ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'instructions',
        order: 13,
        label: () => t('instructions.nav') || 'Instructions',
      }, InstructionsSettingsSection));
      cleanNav = initInstructionsNavObserver();
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
