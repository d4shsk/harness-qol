// Concatenate inside the main Client module factory, then call registerModelDefaultsClient(ctx, React, store).
// Uses only React and public ctx services/slot hooks; does not import Harness packages.
function registerModelDefaultsClient(ctx, React, store) {
  const h = React.createElement;
  const ns = 'harness-qol-models';
  const dictionaries = {
    en: {
      title: 'Default model',
      intro: 'The default model for new chat sessions. Selecting a different model inside an individual chat session will not overwrite this default.',
      provider: 'Provider', model: 'Model', reasoning: 'Reasoning',
      automatic: 'Provider default', select: 'Select…',
      save: 'Save default', saving: 'Saving…', saved: 'Saved. Existing sessions were not changed.',
      refresh: 'Reload defaults', loading: 'Loading…',
      openChat: 'Open a chat session, then return to Models to edit defaults.',
      readOnly: 'Defaults cannot be persisted without the profile configuration editor.',
      failed: 'The request failed.',
    },
    ru: {
      title: 'Модель по умолчанию',
      intro: 'Модель по умолчанию для новых сессий. Выбор другой модели внутри отдельного чата не будет перезаписывать эту настройку.',
      provider: 'Провайдер', model: 'Модель', reasoning: 'Рассуждение',
      automatic: 'По умолчанию у провайдера', select: 'Выберите…',
      save: 'Сохранить', saving: 'Сохранение…', saved: 'Сохранено. Текущие сессии не изменены.',
      refresh: 'Перечитать настройки', loading: 'Загрузка…',
      openChat: 'Откройте чат и вернитесь в «Модели», чтобы изменить настройки по умолчанию.',
      readOnly: 'Для сохранения нужен редактор конфигурации профиля.',
      failed: 'Не удалось выполнить запрос.',
    },
  };
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    ctx.effect(() => ctx.locale.register(ns, language, dictionary));
  }
  const t = ctx.locale.bind(ns);
  const control = { width: '100%', minWidth: 0, font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '8px 10px' };
  const button = { ...control, width: 'auto', cursor: 'pointer', padding: '8px 14px' };
  const labelStyle = { display: 'grid', gap: 6, minWidth: 0 };

  function ModelForm({ initial, providers, run, disabled, onSave }) {
    const [provider, setProvider] = React.useState(initial?.provider ?? '');
    const [model, setModel] = React.useState(initial?.model ?? '');
    const [effort, setEffort] = React.useState(initial?.reasoningEffort ?? '');
    const [models, setModels] = React.useState([]);
    const [reasoning, setReasoning] = React.useState(null);
    const [catalogError, setCatalogError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [modelLoading, setModelLoading] = React.useState(false);
    const [effortLoading, setEffortLoading] = React.useState(false);
    const [status, setStatus] = React.useState('');
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    React.useEffect(() => {
      let active = true;
      setModels([]); setCatalogError('');
      if (!provider || disabled) { setModelLoading(false); return; }
      setModelLoading(true);
      run({ action: 'catalog', provider }).then(data => {
        if (active) setModels(data.models ?? []);
      }).catch(error => { if (active) setCatalogError(error.message); })
        .finally(() => { if (active) setModelLoading(false); });
      return () => { active = false; };
    }, [provider, disabled, run]);
    React.useEffect(() => {
      let active = true;
      setReasoning(null);
      if (!provider || !model || disabled) { setEffortLoading(false); return; }
      setEffortLoading(true); setCatalogError('');
      run({ action: 'catalog', provider, model }).then(data => {
        if (active) setReasoning(data.reasoning);
      }).catch(error => { if (active) setCatalogError(error.message); })
        .finally(() => { if (active) setEffortLoading(false); });
      return () => { active = false; };
    }, [provider, model, disabled, run]);
    const efforts = reasoning?.efforts ?? [];
    const modelOptions = models.some(item => item.id === model) || !model ? models : [{ id: model, name: model }, ...models];
    const providerOptions = providers.some(item => item.id === provider) || !provider ? providers : [{ id: provider, name: provider }, ...providers];
    const effortOptions = efforts.some(item => item.id === effort) || !effort ? efforts : [{ id: effort, name: effort }, ...efforts];
    const field = (text, input) => h('label', { style: labelStyle }, h('span', null, text), input);
    return h('form', {
      style: { display: 'grid', gap: 12 },
      onSubmit: async event => {
        event.preventDefault(); setStatus(''); setBusy(true);
        try {
          const selection = { provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
          await onSave(selection);
          if (mounted.current) setStatus(t('saved'));
        } catch (error) { if (mounted.current) setStatus(error.message); }
        finally { if (mounted.current) setBusy(false); }
      },
    },
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 } },
      field(t('provider'), h('select', { style: control, value: provider, disabled: disabled || busy,
        onChange: e => { setProvider(e.target.value); setModel(''); setEffort(''); setStatus(''); } },
        h('option', { value: '' }, t('select')), ...providerOptions.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
      field(t('model'), h('select', { style: control, value: model, disabled: disabled || busy || !provider || modelLoading,
        onChange: e => { setModel(e.target.value); setEffort(''); setStatus(''); } },
        h('option', { value: '' }, t(modelLoading ? 'loading' : 'select')), ...modelOptions.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
      field(t('reasoning'), h('select', { style: control, value: effort, disabled: disabled || busy || !model || effortLoading || !effortOptions.length,
        onChange: e => { setEffort(e.target.value); setStatus(''); } },
        h('option', { value: '' }, t(effortLoading ? 'loading' : 'automatic')), ...effortOptions.map(item => h('option', { key: item.id, value: item.id }, item.name))))),
    catalogError && h('div', { role: 'alert', style: { fontSize: 12 } }, catalogError),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
      h('button', { type: 'submit', style: button, disabled: disabled || busy || !provider || !model || effortLoading || modelLoading }, t(busy ? 'saving' : 'save')),
      h('span', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12 } }, status)));
  }

  function Defaults(props) {
    if (store && !store.isEnabled('models')) return null;
    React.useSyncExternalStore(callback => ctx.locale.subscribe(callback), () => ctx.locale.getSnapshot());
    const sessionId = props.useSessions(snapshot => Object.values(snapshot.byId).find(candidate => (candidate.retainedBy.mainView ?? 0) > 0)?.id);
    const [snapshot, setSnapshot] = React.useState(null);
    const [providers, setProviders] = React.useState([]);
    const [error, setError] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const [revision, setRevision] = React.useState(0);
    const run = React.useCallback(async request => {
      const scope = sessionId && ctx.sessions.scope(sessionId);
      if (!scope?.remote?.commands) throw new Error(t('openChat'));
      const reply = await scope.remote.commands.execute('/harness-qol-models ' + JSON.stringify(request), []);
      if (reply?.ok === false) throw new Error(reply.error?.message ?? t('failed'));
      const execution = reply?.ok === true ? reply.value : reply;
      if (!execution?.result?.text) throw new Error(t('failed'));
      let result;
      try { result = JSON.parse(execution.result.text); }
      catch { throw new Error(execution.result.text); }
      if (!result.ok) throw new Error(result.error ?? t('failed'));
      return result.data;
    }, [sessionId]);
    React.useEffect(() => {
      let active = true;
      setSnapshot(null); setError(''); setProviders([]);
      if (!sessionId) { setLoading(false); return; }
      setLoading(true);
      Promise.all([run({ action: 'read' }), run({ action: 'catalog' })]).then(([data, catalog]) => {
        if (!active) return;
        setSnapshot(data); setProviders(catalog.providers ?? []);
      }).catch(failure => { if (active) setError(failure.message); })
        .finally(() => { if (active) setLoading(false); });
      return () => { active = false; };
    }, [run, sessionId, revision]);
    const save = async (action, selection) => {
      await run({ action, selection });
    };
    const disabled = !sessionId || !snapshot?.writable;
    return h('section', { style: { padding: '20px 0', marginTop: 12, display: 'grid', gap: 18, color: 'inherit' }, 'aria-label': t('title') },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
        h('h3', { style: { margin: 0, fontSize: 16 } }, t('title')),
        h('button', { type: 'button', style: button, disabled: !sessionId || loading, onClick: () => setRevision(value => value + 1) }, t('refresh'))),
      h('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.55 } }, t('intro')),
      !sessionId && h('p', { role: 'status' }, t('openChat')),
      loading && h('p', { role: 'status' }, t('loading')),
      error && h('p', { role: 'alert' }, error),
      snapshot && !snapshot.writable && h('p', { role: 'status' }, t('readOnly')),
      snapshot && h('div', { style: { display: 'grid', gap: 12 } },
        h(ModelForm, { key: 'main-' + revision + '-' + sessionId, initial: snapshot.main, providers, run, disabled, onSave: selection => save('save-main', selection) })));
  }

  let dispose = null;
  function update() {
    const enabled = !store || store.isEnabled('models');
    if (enabled && !dispose) {
      dispose = ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
        name: 'settings.models.footer', id: 'harness-qol-model-defaults', order: 10, label: () => t('title'),
      }, Defaults));
    } else if (!enabled && dispose) {
      dispose();
      dispose = null;
    }
  }
  update();
  const unsub = store?.subscribe ? store.subscribe(update) : null;
  return () => {
    if (unsub) unsub();
    if (dispose) dispose();
    dispose = null;
  };
}
