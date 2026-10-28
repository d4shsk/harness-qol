import { registerBtw } from './btw.js';
import { registerConsole } from './console.js';
import { registerModelDefaults } from './model-defaults.js';
import { registerMessageEditor } from './messages.js';
import { registerInstructions } from './instructions.js';
import { registerMcp } from './mcp.js';
import { registerMcpHistoryRepair } from './mcp-history.js';
import { registerWebSearch } from './web-search.js';
import { getSettingsState, registerSettingsHttp, registerSettingsConnection } from './settings-state.js';

export const name = 'harness-qol';
export const inject = ['commands', 'llm', 'sessions', 'agentDefaultModel', 'tools', 'configEditor', 'agents'];
export async function apply(ctx) {
  const state = getSettingsState();
  await state.load();
  ctx.inject(['connection'], scope => registerSettingsConnection(scope, state));
  ctx.inject(['webServer'], scope => {
    registerSettingsHttp(scope, state);
  });
  ctx.inject(['jobs', 'subprocess', 'sandboxPolicy', 'sandbox', 'fs', 'workingDirectory'], scope => registerConsole(scope, state));
  registerBtw(ctx, state);
  registerModelDefaults(ctx, state);
  registerMessageEditor(ctx, state);
  registerInstructions(ctx, state);
  const historyRepair = registerMcpHistoryRepair(ctx);
  registerMcp(ctx, state, undefined, historyRepair);
  registerWebSearch(ctx, state);
}


