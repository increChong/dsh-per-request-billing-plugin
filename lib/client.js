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
  '.prb-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
  '.prb-row{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}',
  '.prb-row input{margin:0}',
  '.prb-models{display:flex;flex-wrap:wrap;gap:4px 10px;padding-left:18px}',
  '.prb-model{display:flex;align-items:center;gap:4px;padding:2px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:11px;cursor:pointer;user-select:none}',
  '.prb-model.prb-active{border-color:var(--dsw-alias-state-warn-primary)}',
  '.prb-actions{display:flex;gap:6px;flex-wrap:wrap}',
  '.prb-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font:inherit;font-size:11px;border-radius:6px;padding:2px 8px;cursor:pointer}',
  '.prb-input{flex:1;min-width:120px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 6px;color:inherit;font:inherit;font-size:11px}',
  '.prb-err{color:var(--dsw-alias-state-error-primary)}',
  '.prb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
].join('\n')

const T = {
  title: '按次计费模型优化',
  nav: '按次计费',
  intro: '被勾选的提供方 / 模型视为「按次计费」。使用这些模型时，插件会自动向系统提示词注入调用优化策略：批量与并行调用工具、一次拿全量信息、复用已有结果、主动使用更长上下文，从而尽量用更少的请求次数完成任务。安全底线：优化只作用于调用方式，绝不跳过授权与审批。标记会持久化保存。',
  manual: '手动加入模型 id（配置里还没有的）',
  add: '加入',
  global: '全局：所有模型都按次计费',
  providerLine: '提供方整体按次计费（其下所有模型）',
  models: '单模型',
  noModels: '该提供方尚无模型配置（可在模型配置页添加，或在下方手动输入模型 id）。',
  resetModels: '清除单模型勾选',
  inherited: '继承',
  explicit: '单独设置',
  marked: '按次计费',
  unmarked: '按量计费',
  stats: '已优化步骤',
  loading: '读取模型配置…',
  retry: '重试',
}

/** Minimal external store so both seats re-render from one snapshot. */
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

function ManualAdd(props) {
  const pair = React.useState('')
  const draft = pair[0]
  const setDraft = pair[1]
  return React.createElement('div', { className: 'prb-head' },
    React.createElement('input', {
      className: 'prb-input',
      placeholder: T.manual,
      value: draft,
      onChange: (event) => setDraft(event.target.value),
    }),
    React.createElement('button', {
      className: 'prb-btn',
      onClick: () => {
        const id = String(draft).trim()
        if (id.length === 0) return
        props.onAdd(id)
        setDraft('')
      },
    }, T.add),
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
  function ProviderBlock(props) {
    const provider = props.provider
    return React.createElement('div', { className: 'prb-card' },
      React.createElement('div', { className: 'prb-head' },
        React.createElement('span', { className: 'prb-name' }, provider.displayName),
        React.createElement('span', { className: 'prb-badge prb-mono' }, provider.provider),
        React.createElement('span', { className: 'prb-badge ' + (provider.marked ? 'prb-on' : '') }, provider.marked ? T.marked : T.unmarked),
        provider.error ? React.createElement('span', { className: 'prb-badge prb-err' }, provider.error) : null,
      ),
      React.createElement(Row, {
        checked: provider.marked,
        label: T.providerLine,
        onChange: (on) => write({ scope: 'provider', provider: provider.provider, on }),
      }),
      React.createElement(ModelChips, {
        provider,
        onToggle: (model, on) => write({ scope: 'model', provider: provider.provider, model, on }),
      }),
      React.createElement(ManualAdd, {
        key: 'manual:' + provider.provider,
        onAdd: (model) => write({ scope: 'model', provider: provider.provider, model, on: true }),
      }),
    )
  }

  /** Full settings page. */
  function Panel() {
    const state = useSnapshot(store)
    const catalog = state.catalog
    if (!state.ready) {
      return React.createElement('div', { className: 'prb-root' },
        React.createElement('div', { className: 'prb-hint' }, state.error === null ? T.loading : state.error),
      )
    }
    return React.createElement('div', { className: 'prb-root' },
      React.createElement('div', { className: 'prb-head' },
        React.createElement('span', { className: 'prb-name' }, T.title),
        React.createElement('span', { className: 'prb-badge ' + (catalog.stats.markedModels > 0 || catalog.global ? 'prb-ok' : '') }, catalog.stats.markedModels + '/' + catalog.stats.totalModels),
        React.createElement('span', { className: 'prb-badge' }, T.stats + ': ' + catalog.stats.steps),
      ),
      React.createElement('div', { className: 'prb-hint' }, T.intro),
      React.createElement('div', { className: 'prb-card' },
        React.createElement(Row, {
          checked: catalog.global,
          label: T.global,
          onChange: (on) => write({ scope: 'global', on }),
        }),
      ),
      catalog.providers.map((provider) => React.createElement(ProviderBlock, { key: provider.provider, provider })),
      React.createElement('div', { className: 'prb-actions' },
        React.createElement('button', {
          className: 'prb-btn',
          onClick: async () => {
            for (const key of Object.keys(state.catalog.models ?? {})) await write({ scope: 'model', provider: key.split('/')[0], model: key.split('/').slice(1).join('/'), on: false })
          },
        }, T.resetModels),
      ),
      state.error === null ? null : React.createElement('div', { className: 'prb-hint prb-err' }, state.error),
    )
  }

  /** Compact per-provider area inside a Models-page provider card. */
  function ProviderCard(props) {
    const state = useSnapshot(store)
    const route = props !== null && typeof props === 'object' && props.provider !== null && typeof props.provider === 'object'
      ? String(props.provider.provider)
      : ''
    const provider = state.catalog.providers.find((candidate) => candidate.provider === route)
    if (!state.ready || provider === undefined) return React.createElement('div', { className: 'prb-root prb-hint' }, T.loading)
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
      React.createElement(ManualAdd, {
        key: 'manual:' + provider.provider,
        onAdd: (model) => write({ scope: 'model', provider: provider.provider, model, on: true }),
      }),
    )
  }

  return { Panel, ProviderCard }
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

  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'per-request-billing',
    order: 12,
    label: () => T.nav,
  }, ui.Panel))

  slots.inject('settings.models.provider-card', () => slots.register({
    name: 'settings.models.provider-card',
    key: 'llm-pi-ai',
  }, ui.ProviderCard))
  slots.inject('settings.models.provider-card', () => slots.register({
    name: 'settings.models.provider-card',
    key: 'llm-deepseek',
  }, ui.ProviderCard))

  // The provider directory can change while the page is open.
  ctx.on('llm/adapters-updated', () => ctx.timeout(() => refresh(), 300))

  refresh()
}

    return module.exports;
  },
});
