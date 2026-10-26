import { registerBtw } from './btw.js';
import { registerModelDefaults } from './model-defaults.js';
import { getSettingsState, registerSettingsHttp } from './settings-state.js';

export const name = 'harness-qol';
export const inject = ['commands', 'llm', 'sessions', 'agentDefaultModel', 'tools', 'configEditor'];
export function apply(ctx) {
  const state = getSettingsState();
  ctx.inject(['webServer'], scope => {
    registerSettingsHttp(scope, state);
  });
  registerBtw(ctx, state);
  registerModelDefaults(ctx, state);
}

