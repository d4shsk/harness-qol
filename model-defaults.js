// Harness-QOL Models: canonical default model configuration with protection against chat overrides.
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSettingsState } from './settings-state.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertRoute(route) {
  if (!object(route) || typeof route.provider !== 'string' || !route.provider.trim() ||
      typeof route.model !== 'string' || !route.model.trim()) {
    throw new Error('Select a provider and model / Выберите провайдера и модель.');
  }
  if (route.reasoningEffort !== undefined && route.reasoningEffort !== null &&
      (typeof route.reasoningEffort !== 'string' || !route.reasoningEffort)) {
    throw new Error('Invalid reasoning effort / Некорректный уровень рассуждения.');
  }
  return {
    provider: route.provider, model: route.model,
    ...(route.reasoningEffort == null ? {} : { reasoningEffort: route.reasoningEffort }),
  };
}

export function createModelDefaultsOperations(ctx, settingsState) {
  const settings = settingsState || getSettingsState();
  const need = name => {
    const service = ctx.get(name);
    if (!service) throw new Error(`Required service unavailable: ${name}`);
    return service;
  };
  const read = () => ({
    main: need('agentDefaultModel').currentSelection(),
    writable: !!ctx.get('configEditor'),
  });
  return {
    async run(request, signal) {
      try {
        if (!object(request)) throw new Error('Expected an operation object.');
        signal?.throwIfAborted();
        const action = request.action ?? 'read';
        let data;
        if (action === 'read') data = read();
        else if (action === 'catalog') {
          const llm = need('llm');
          if (request.model !== undefined && !request.provider) throw new Error('model requires provider');
          if (!request.provider) data = { providers: llm.listProviders() };
          else if (!request.model) data = { models: await llm.listModels(request.provider) };
          else {
            const model = await llm.resolveModelInfo(request.provider, request.model, signal);
            data = { provider: model.provider, model: model.id, reasoning: model.reasoning ?? null };
          }
        } else if (action === 'save-main') {
          if (settings && !settings.isModuleEnabled('models')) {
            throw new Error('Module "models" is disabled in Harness QOL settings / Модуль "models" отключён в настройках Harness QOL.');
          }
          need('configEditor'); // saveSelection is a no-op without the editor; fail explicitly instead.
          const selection = assertRoute(request.selection);
          await need('llm').resolveCallConfig(selection, signal);
          signal?.throwIfAborted();
          await need('agentDefaultModel').saveSelection(selection);
          data = read();
        } else throw new Error(`Unknown operation: ${action}`);
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** Called by the main Host plugin inside apply; registrations are owned by its context. */
export function registerModelDefaults(ctx, settingsState) {
  const settings = settingsState || getSettingsState();
  // The controller persists a default from an anonymous, queued async callback.
  // Stack names disappear across that boundary; a process-wide flag also leaks
  // between concurrent requests. Track only the selectModel async chain instead.
  // There is no public switch for this automatic persistence in this Harness version.
  ctx.inject(['sessionController', 'agentDefaultModel'], scope => {
    const controller = scope.get('sessionController');
    const defaults = scope.get('agentDefaultModel');
    scope.effect(() => {
      const localSelection = new AsyncLocalStorage();
      const originalSelect = controller.selectModel;
      const originalSave = defaults.saveSelection;
      const selectDescriptor = Object.getOwnPropertyDescriptor(controller, 'selectModel');
      const saveDescriptor = Object.getOwnPropertyDescriptor(defaults, 'saveSelection');
      const select = function (...args) {
        return localSelection.run(true, () => originalSelect.apply(this, args));
      };
      const save = async function (...args) {
        if (settings && !settings.isModuleEnabled('models')) {
          return originalSave.apply(this, args);
        }
        if (localSelection.getStore()) return;
        return originalSave.apply(this, args);
      };
      controller.selectModel = select;
      defaults.saveSelection = save;
      return () => {
        // Restore exact own/prototype methods, without clobbering a later wrapper.
        // Cordis returns a fresh context proxy on every method read; compare
        // stored descriptors rather than those proxy identities.
        if (Object.getOwnPropertyDescriptor(controller, 'selectModel')?.value === select) {
          if (selectDescriptor) Object.defineProperty(controller, 'selectModel', selectDescriptor);
          else delete controller.selectModel;
        }
        if (Object.getOwnPropertyDescriptor(defaults, 'saveSelection')?.value === save) {
          if (saveDescriptor) Object.defineProperty(defaults, 'saveSelection', saveDescriptor);
          else delete defaults.saveSelection;
        }
        localSelection.disable();
      };
    });
  });

  const operations = createModelDefaultsOperations(ctx, settings);

  const tools = ctx.get('tools');
  const commands = ctx.get('commands');
  if (tools) ctx.effect(() => tools.register({
    name: 'harness_qol_model_defaults',
    description: 'Inspect model defaults and provider/model reasoning options; save the default for new chats. Model changes within an active chat will not overwrite this default.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read', 'catalog', 'save-main'], description: 'read by default; catalog lists providers, provider models, or exact model reasoning options; save-main saves default model.' },
        provider: { type: 'string', description: 'Provider route for catalog discovery.' },
        model: { type: 'string', description: 'Exact model id for reasoning discovery; requires provider.' },
        selection: { description: 'Complete provider/model plus optional reasoning effort for saves.', oneOf: [
          { type: 'null' },
          { type: 'object', additionalProperties: false, required: ['provider', 'model'], properties: {
            provider: { type: 'string' }, model: { type: 'string' },
            reasoningEffort: { type: ['string', 'null'], description: 'An effort id returned by catalog; omit/null uses the adapter default.' },
          } },
        ] },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: args => !args?.action || args.action === 'read' || args.action === 'catalog',
    execute: (request, exec) => operations.run(request, exec.signal),
  }));
  if (commands) ctx.effect(() => commands.register({
    name: 'harness-qol-models',
    description: 'Harness-QOL: inspect or save new-session model defaults / настройки моделей новых сессий.',
    recordInput: false,
    input: { hint: 'JSON operation (read, catalog, save-main)' },
    async handler(invocation) {
      let request;
      try { request = invocation.rawInput.trim() ? JSON.parse(invocation.rawInput) : { action: 'read' }; }
      catch { return { kind: 'error', text: 'Invalid JSON / Некорректный JSON.' }; }
      const result = await operations.run(request, invocation.signal);
      return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) };
    },
  }));
  return operations;
}
