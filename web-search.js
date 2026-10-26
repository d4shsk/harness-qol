import { getSettingsState } from './settings-state.js';

export function registerWebSearch(ctx, settingsState) {
  const state = settingsState || getSettingsState();
  const activeRestrictions = new Map();
  let stopped = false;

  function applyRestriction(agent) {
    if (stopped || !agent?.id || activeRestrictions.has(agent.id)) return;
    // Never fall back to a global context: restrict() is agent-scoped.
    const tools = agent.ctx?.get?.('tools');
    if (!tools?.get('web_search', agent)) return;
    // restrict() synchronously emits tools/change BEFORE returning its disposer.
    // Reserve the agent first so this notification cannot re-enter registration.
    activeRestrictions.set(agent.id, null);
    try {
      activeRestrictions.set(agent.id, tools.restrict({ deny: ['web_search'] }));
    } catch (err) {
      activeRestrictions.delete(agent.id);
      console.warn('[harness-qol:web-search] Failed to restrict web_search for agent', agent.id, err);
    }
  }

  function removeRestriction(agentId) {
    const unrestrict = activeRestrictions.get(agentId);
    if (unrestrict) {
      activeRestrictions.delete(agentId);
      try {
        unrestrict();
      } catch (err) {
        console.warn('[harness-qol:web-search] Failed to unrestrict web_search for agent', agentId, err);
      }
    }
  }

  function unrestrictAll() {
    const entries = [...activeRestrictions];
    activeRestrictions.clear();
    for (const [id, unrestrict] of entries) {
      try {
        unrestrict?.();
      } catch (err) {
        console.warn('[harness-qol:web-search] Failed to unrestrict web_search for agent', id, err);
      }
    }
    activeRestrictions.clear();
  }

  function reconcileAll() {
    if (stopped) return;
    if (!state.isModuleEnabled('webSearch')) {
      const agentsService = ctx.get?.('agents') || ctx.agents;
      const agentsList = agentsService?.list?.() || [];
      for (const agent of agentsList) {
        applyRestriction(agent);
      }
    } else {
      unrestrictAll();
    }
  }

  // Global guard against direct execution when webSearch is disabled
  ctx.inject(['tools'], scope => {
    const tools = scope.get('tools') || scope.tools;
    if (tools && typeof tools.guard === 'function') {
      scope.effect(() => tools.guard(exec => {
        if (exec?.name === 'web_search' && !state.isModuleEnabled('webSearch')) {
          return 'The default web_search tool is disabled in Harness QOL settings (use search via MCP instead).';
        }
      }));
    }
  });

  ctx.inject(['agents', 'tools'], scope => {
    scope.on('agent/created', ({ agent }) => {
      if (!state.isModuleEnabled('webSearch')) {
        applyRestriction(agent);
      }
    });

    scope.on('agent/disposed', ({ agent }) => {
      if (agent?.id) {
        removeRestriction(agent.id);
      }
    });

    scope.on('tools/change', () => {
      if (!state.isModuleEnabled('webSearch')) {
        const agentsService = scope.get?.('agents') || scope.agents;
        const agentsList = agentsService?.list?.() || [];
        for (const agent of agentsList) {
          applyRestriction(agent);
        }
      }
    });

    const unsubscribe = state.subscribe(() => {
      reconcileAll();
    });

    scope.effect(() => () => {
      stopped = true;
      unsubscribe();
      unrestrictAll();
    });

    // Initial reconciliation
    reconcileAll();
  });

  return {
    reconcileAll,
    unrestrictAll,
    getActiveRestrictions: () => new Map(activeRestrictions),
  };
}
