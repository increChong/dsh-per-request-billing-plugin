window.__ModuleLoader__.load({
  id: "dsh-per-request-billing",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
/**
 * Per-request billing optimizer — browser half (source).
 *
 * The build script wraps this module in the loader handoff the web shell
 * expects:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { <file> } })
 *
 * so the `require` calls below resolve through the loader's module table. Only
 * specifiers the platform seeds are used — see `dsh.client.external` in
 * package.json for the ones this plugin adds — because a `require` the table
 * cannot answer is a guaranteed runtime throw.
 *
 * The UI is one seat: the extension area inside each provider card on the
 * Models settings page. There is deliberately no page of its own — marking is
 * a property of a provider and its models, so it belongs where those are
 * configured, not in a separate tab listing the same thing again.
 *
 * Deliberately no JSX and no TypeScript: elements are built with
 * `React.createElement`. That keeps the browser artifact reproducible from
 * source without the repository's tsc + tsdown pipeline.
 */

const React = require('react')

const HOST_URL = '/plugins/dsh-per-request-billing/state'

const CSS = [
  '.prb-root{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}',
  '.prb-hint{color:var(--dsw-alias-label-secondary);font-size:11px}',
  '.prb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:6px}',
  '.prb-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
  '.prb-name{font-weight:600}',
  '.prb-badge{font-size:10px;border-radius:999px;padding:1px 7px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
  '.prb-on{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
  '.prb-row{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}',
  '.prb-row input{margin:0}',
  '.prb-models{display:flex;flex-wrap:wrap;gap:4px 10px;padding-left:18px}',
  '.prb-model{display:flex;align-items:center;gap:4px;padding:2px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:11px;cursor:pointer;user-select:none}',
  '.prb-model.prb-active{border-color:var(--dsw-alias-state-warn-primary)}',
  '.prb-err{color:var(--dsw-alias-state-error-primary)}',
  '.prb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
].join('\n')

const T = {
  title: '按次计费',
  providerLine: '该提供方的模型都按次计费',
  models: '单个模型',
  noModels: '该提供方还没有配置模型。',
  unavailable: '未能读取该提供方的模型清单。',
  loading: '读取模型配置…',
  inherited: '跟随提供方',
  explicit: '单独设置',
  marked: '按次计费',
  unmarked: '按量计费',
  hint: '按次计费的模型会在每次组装提示词时被引导「少发请求、多用上下文」。切换提供方开关会让其下模型重新跟随提供方。',
}

/** Minimal external store so every card re-renders from one snapshot. */
function createStore() {
  let snapshot = { ready: false, error: null, catalog: { global: false, providers: [], stats: { markedModels: 0, totalModels: 0, steps: 0 } } }
  const listeners = new Set()
  return {
    get: () => snapshot,
    set: (next) => {
      snapshot = next
      for (const listener of Array.from(listeners)) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function useSnapshot(store) {
  const bump = React.useState(0)[1]
  React.useEffect(() => store.subscribe(() => bump((n) => n + 1)), [])
  return store.get()
}

function Row(props) {
  return React.createElement('label', { className: 'prb-row' },
    React.createElement('input', {
      type: 'checkbox',
      checked: props.checked,
      onChange: (event) => props.onChange(event.target.checked),
    }),
    React.createElement('span', null, props.label),
  )
}

function ModelChips(props) {
  const models = props.provider.models
  if (models.length === 0) return React.createElement('div', { className: 'prb-hint' }, T.noModels)
  return React.createElement('div', { className: 'prb-models' }, models.map((model) => React.createElement('label', {
    key: model.id,
    className: 'prb-model' + (model.marked ? ' prb-active' : ''),
    title: model.explicit ? T.explicit : T.inherited,
  },
    React.createElement('input', {
      type: 'checkbox',
      checked: model.marked,
      onChange: (event) => props.onToggle(model.id, event.target.checked),
    }),
    React.createElement('span', { className: 'prb-mono' }, model.id),
    model.explicit ? null : React.createElement('span', { className: 'prb-hint' }, '· ' + T.inherited),
  )))
}

function plugin(store, write) {
  /** The extension area of one Models-page provider card. */
  function ProviderCard(props) {
    const state = useSnapshot(store)
    const route = props !== null && typeof props === 'object' && props.provider !== null && typeof props.provider === 'object'
      ? String(props.provider.provider)
      : ''
    const hint = (text, error) => React.createElement('div', { className: 'prb-root' },
      React.createElement('div', { className: 'prb-hint' + (error ? ' prb-err' : '') }, text))
    if (!state.ready) return hint(state.error ?? T.loading, state.error !== null)
    const provider = state.catalog.providers.find((candidate) => candidate.provider === route)
    if (provider === undefined) return hint(T.unavailable)

    return React.createElement('div', { className: 'prb-root' },
      React.createElement('div', { className: 'prb-head' },
        React.createElement('span', { className: 'prb-name' }, T.title),
        React.createElement('span', { className: 'prb-badge ' + (provider.marked ? 'prb-on' : '') }, provider.marked ? T.marked : T.unmarked),
      ),
      React.createElement(Row, {
        checked: provider.marked,
        label: T.providerLine,
        onChange: (on) => write({ scope: 'provider', provider: provider.provider, on }),
      }),
      React.createElement('div', { className: 'prb-hint' }, T.models),
      React.createElement(ModelChips, {
        provider,
        onToggle: (model, on) => write({ scope: 'model', provider: provider.provider, model, on }),
      }),
      state.error === null ? null : React.createElement('div', { className: 'prb-hint prb-err' }, state.error),
      React.createElement('div', { className: 'prb-hint' }, T.hint),
    )
  }

  return { ProviderCard }
}

/**
 * Plugin body.
 *
 * Exported through `exports.` rather than `export function`: the bundle format
 * is CommonJS (the loader's factory returns `module.exports`), so an ESM
 * `export` would be a syntax error inside it. The real pipeline gets this from
 * rolldown's format conversion; authoring it directly keeps the artifact
 * reproducible without that toolchain.
 *
 * @param ctx - the browser-side plugin context.
 */
exports.apply = function apply(ctx) {
  const store = createStore()

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-per-request-billing'
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => tag.remove()
  }, 'per-request-billing: styles')

  let generation = 0
  async function refresh() {
    const mine = ++generation
    try {
      const response = await fetch(HOST_URL, { headers: { accept: 'application/json' } })
      const body = await response.json()
      if (mine !== generation) return
      if (body.ok !== true) throw new Error(body.message ?? 'host refused the read')
      store.set({ ready: true, error: null, catalog: body.catalog })
    } catch (error) {
      if (mine !== generation) return
      store.set({ ...store.get(), error: error instanceof Error ? error.message : String(error) })
    }
  }

  async function write(body) {
    try {
      const response = await fetch(HOST_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const answer = await response.json()
      if (answer.ok !== true) throw new Error(answer.message ?? 'host refused the write')
      store.set({ ready: true, error: null, catalog: answer.catalog })
    } catch (error) {
      store.set({ ...store.get(), error: error instanceof Error ? error.message : String(error) })
    }
  }

  const ui = plugin(store, write)

  const slots = ctx.get('slots')
  if (slots === undefined) {
    console.error('per-request-billing: slots service unavailable')
    return
  }

  // Keyed by the row's owning settings namespace, so one registration per
  // adapter family covers every card of that family — shipped, added, and
  // hand-declared rows alike.
  for (const settingsNs of ['llm-pi-ai', 'llm-deepseek']) {
    slots.inject('settings.models.provider-card', () => slots.register({
      name: 'settings.models.provider-card',
      key: settingsNs,
    }, ui.ProviderCard))
  }

  // The provider directory can change while the page is open. Host events reach
  // the browser only through the remote gateway, and every forwarded event is
  // keyed under an internal per-generation prefix, so `ctx.remote.$on` is the
  // only subscription that can ever fire here — a plain `ctx.on` never matches.
  const remote = ctx.get('remote')
  if (remote !== undefined && typeof remote.$on === 'function') {
    ctx.effect(() => remote.$on('llm/adapters-updated', () => ctx.timeout(() => refresh(), 300)), 'per-request-billing: adapter refresh')
  }

  refresh()
}

    return module.exports;
  },
});
