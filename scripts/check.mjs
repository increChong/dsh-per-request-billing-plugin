/**
 * Contract checks for both halves, runnable without a DSH install.
 *
 * These are not style checks: each one asserts something the runtime will
 * otherwise fail on at boot or at the first model step.
 *
 *   1. the host half is a valid ESM module exporting `name`, `inject`, `apply`
 *   2. the client bundle hands a factory to the module loader
 *   3. the factory runs with only `react` seeded, and its `apply` registers
 *      the expected slot seats — through `inject` callbacks actually invoked,
 *      which is how the real slot service behaves
 *   4. the host route answers GET and POST against a stub host context, and a
 *      write is observable in the next read (the client's whole contract)
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok    ${label}`)
    return
  }
  failures += 1
  console.error(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------- host half
// The host half imports DSH's own packages, which a plugin declares as peers
// and the runtime supplies. This workspace has no install, so resolve them
// against a DSH installation when one is available (DSH_INSTALL points at its
// node_modules) and report the gap otherwise instead of dying obscurely.
const dshInstall = process.env.DSH_INSTALL
  ?? (process.env.DSH_HOME_MODULES ?? '')
if (dshInstall.length > 0 && existsSync(join(dshInstall, '@deepseek-ai/dsh-tools'))) {
  // Link every package the host half imports; a plugin declares these as peers
  // and the runtime supplies them, so there is nothing to install here.
  const scope = join(root, 'node_modules/@deepseek-ai')
  mkdirSync(scope, { recursive: true })
  for (const dependency of ['dsh-tools', 'schemastery', 'dsh-util-values', 'dsh-brand', 'cordis']) {
    const target = join(dshInstall, '@deepseek-ai', dependency)
    const link = join(scope, dependency)
    if (existsSync(target) && !existsSync(link)) symlinkSync(target, link, 'dir')
  }
}

console.log('host half (lib/index.js)')
let host
try {
  host = await import(pathToFileURL(join(root, 'lib/index.js')).href)
} catch (error) {
  console.error(`  FAIL  host half cannot be imported: ${error.message}`)
  console.error('        set DSH_INSTALL=<dsh node_modules> to resolve its peer dependencies')
  process.exit(1)
}
check('exports a name', typeof host.name === 'string' && host.name.length > 0)
check('declares inject', Array.isArray(host.inject), 'inject must be an array')
check('exports apply', typeof host.apply === 'function')
check('inject covers the services it uses',
  ['llm', 'settings', 'systemPrompt', 'tools'].every((service) => host.inject.includes(service)),
  `inject = ${JSON.stringify(host.inject)}`)

// -------------------------------------------------------------- client bundle
console.log('client bundle (lib/client.js)')
const code = readFileSync(join(root, 'lib/client.js'), 'utf8')
let handoff
new Function('window', code)({ __ModuleLoader__: { load: (spec) => { handoff = spec } } })
check('calls __ModuleLoader__.load', handoff !== undefined)
check('hands over the package id', handoff?.id === 'dsh-per-request-billing', String(handoff?.id))
check('hands over a factory', typeof handoff?.factory === 'function')

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
}
const sees = []
let unseeded
const exportsObject = handoff.factory((specifier) => {
  sees.push(specifier)
  if (specifier === 'react') return React
  unseeded = specifier
  throw new Error(`unseeded require: ${specifier}`)
})
check('factory returns module exports', exportsObject !== null && typeof exportsObject === 'object')
check('exports apply', typeof exportsObject.apply === 'function')

// Run apply against a stub context whose inject fires immediately, which is
// what the slot service does once the slot is declared.
const registered = []
const slots = {
  inject: (key, callback) => {
    callback()
    return () => {}
  },
  register: (options, component) => {
    registered.push({ options, component })
    return () => {}
  },
}
// Host events reach the browser only through the remote gateway, under an
// internal per-generation key (`internal/api-gateway/remote-event/<uuid>/<event>`),
// so a plugin MUST subscribe with `remote.$on`; a plain `ctx.on` never fires.
const remoteEvents = []
const remote = {
  $on: (event, listener) => {
    remoteEvents.push({ event, listener })
    return () => {}
  },
}
const timers = []
const stubCtx = {
  effect: (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get: (service) => (service === 'slots' ? slots : (service === 'remote' ? remote : undefined)),
  on: () => {},
  timeout: (callback, delay) => {
    timers.push({ callback, delay })
    return () => {}
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}
// The client half talks to the host over one JSON route. Model the real
// catalog shape (including `explicit`, which is what marks a model as
// individually set) so the UI's own logic is exercised, not just its markup.
const catalogResponse = {
  global: false,
  providers: [{
    provider: 'demo',
    displayName: 'Demo',
    marked: false,
    explicit: false,
    error: null,
    models: [
      { id: 'model-a', marked: true, explicit: true },
      { id: 'model-b', marked: false, explicit: false },
    ],
  }],
  stats: { markedModels: 1, totalModels: 2, steps: 0 },
}
const hostCalls = []
globalThis.fetchCalls = 0
globalThis.fetch = async (url, options = {}) => {
  globalThis.fetchCalls += 1
  hostCalls.push({ url, method: options.method ?? 'GET', body: options.body === undefined ? undefined : JSON.parse(options.body) })
  return { json: async () => ({ ok: true, catalog: catalogResponse }) }
}
globalThis.document = { createElement: () => ({ dataset: {}, remove: () => {} }), head: { appendChild: () => {} } }

exportsObject.apply(stubCtx)
check('requires only seeded specifiers', unseeded === undefined, `tried to require ${unseeded}`)
check('required react from the module table', sees.includes('react'))
check('registers the settings page', registered.some((entry) => entry.options.name === 'settings.section' && entry.options.id === 'per-request-billing'))
const cardKeys = registered.filter((entry) => entry.options.name === 'settings.models.provider-card').map((entry) => entry.options.key)
check('registers both provider-card families', cardKeys.includes('llm-pi-ai') && cardKeys.includes('llm-deepseek'), cardKeys.join(', '))
check('every registration carries a component', registered.every((entry) => typeof entry.component === 'function'))
check('the ProviderCard component renders from slot props',
  registered
    .filter((entry) => entry.options.name === 'settings.models.provider-card')
    .every((entry) => entry.component({ provider: { provider: 'llm-pi-ai', displayName: 'x' } }) !== undefined))
check('subscribes to the forwarded adapter event through the remote gateway',
  remoteEvents.some((entry) => entry.event === 'llm/adapters-updated'),
  remoteEvents.map((entry) => entry.event).join(', ') || '(no remote subscription)')

// The subscription is only useful if firing it actually re-reads the host.
{
  const before = globalThis.fetchCalls
  remoteEvents.find((entry) => entry.event === 'llm/adapters-updated')?.listener()
  check('firing it schedules a refresh', timers.length > 0, `${timers.length} timer(s)`)
  const scheduled = timers[timers.length - 1]
  const pending = scheduled.callback()
  await pending
  check('the scheduled refresh re-reads the host', globalThis.fetchCalls > before,
    `${globalThis.fetchCalls - before} fetch(es)`)
}

// The reset button must act on what the host actually returns. It used to read
// `catalog.models`, a field the host never sends, so its loop body never ran.
await new Promise((resolve) => setTimeout(resolve, 0))
{
  /** Flatten a rendered element tree into a list of nodes. */
  const flatten = (node, out = []) => {
    if (Array.isArray(node)) {
      for (const item of node) flatten(item, out)
      return out
    }
    if (node === null || typeof node !== 'object') return out
    out.push(node)
    flatten(node.children, out)
    return out
  }
  const panelEntry = registered.find((entry) => entry.options.name === 'settings.section' && entry.options.id === 'per-request-billing')
  const tree = flatten(panelEntry.component())
  const button = tree.find((node) => node.type === 'button' && [].concat(node.children ?? []).includes('清除单模型勾选'))
  check('the settings page renders a reset button', button !== undefined,
    `rendered ${tree.length} node(s); ready=${panelEntry.component.toString().length > 0}`)
  if (button !== undefined) {
    const before = hostCalls.length
    await button.props.onClick()
    const writes = hostCalls.slice(before).filter((call) => call.method === 'POST').map((call) => call.body)
    check('it writes one unmark per explicitly marked model',
      writes.length === 1 && writes[0].scope === 'model' && writes[0].provider === 'demo' && writes[0].model === 'model-a' && writes[0].on === false,
      JSON.stringify(writes))
    check('it leaves inherited models alone', !writes.some((body) => body.model === 'model-b'), JSON.stringify(writes))
  }
}

// ------------------------------------------------------- host route contract
console.log('host route contract (through the real handler)')
// The stored USER section, merged exactly the way @deepseek-ai/dsh-settings
// does it: `update` recurses into matching keys, so a key omitted from the
// patch is KEPT. Modelling this with Object.assign instead would silently
// accept a delete-based unmark that cannot work against the real service.
const settingsState = { global: false, providerDefault: {}, models: {} }
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const mergeLayers = (under, over) => {
  if (over === undefined) return under
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) merged[key] = key in merged ? mergeLayers(merged[key], value) : value
  return merged
}
let watched
const settingsScope = {
  get: () => ({ global: settingsState.global, providerDefault: { ...settingsState.providerDefault }, models: { ...settingsState.models } }),
  watch: (callback) => {
    watched = callback
    return () => {}
  },
  update: async (patch) => {
    const merged = mergeLayers(settingsState, patch)
    for (const key of Object.keys(settingsState)) delete settingsState[key]
    Object.assign(settingsState, merged)
    if (watched !== undefined) await watched(settingsScope.get(), undefined)
  },
  replace: async (section) => {
    for (const key of Object.keys(settingsState)) delete settingsState[key]
    Object.assign(settingsState, section)
    if (watched !== undefined) await watched(settingsScope.get(), undefined)
  },
}
const catalogModels = [{ id: 'model-a', name: 'A' }]
const stubCatalogCtx = {
  llm: {
    listConfigurableProviders: () => [{ provider: 'demo', displayName: 'Demo', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'demo'] }],
    listProviders: () => [],
    listModels: async () => catalogModels,
  },
  settings: {
    register: () => settingsScope,
    describe: () => [],
  },
  systemPrompt: { section: () => () => {} },
  tools: { register: () => () => {} },
  get: (service) => {
    if (service === 'webServer') return webServer
    if (service === 'sessionProjections') return projections
    return undefined
  },
  on: (event, handler) => {
    if (event === 'system-prompt/assemble') assemble = handler
    return () => {}
  },
  effect: (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}
let route
let assemble
let projected = { pending: null, lastUsed: null }
const projections = { stateOf: () => projected }
const webServer = { register: (spec) => { route = spec; return () => {} } }
host.apply(stubCatalogCtx)
check('registers a client state route', route !== undefined && typeof route.path === 'string', 'webServer.register was not called')
check('route path is namespaced', route?.path?.startsWith('/plugins/dsh-per-request-billing/'), String(route?.path))

const invoke = async (method, body, options = {}) => {
  const chunks = options.raw === undefined
    ? (body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    : [Buffer.from(options.raw)]
  const headers = options.headers ?? (method === 'POST' ? { 'content-type': 'application/json' } : {})
  const req = {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let status
  let payload
  const res = {
    set statusCode(value) { status = value },
    get statusCode() { return status },
    setHeader: () => {},
    end: (text) => { payload = JSON.parse(text) },
  }
  await route.handler(req, res)
  return { status, payload }
}

const read = await invoke('GET')
check('GET answers ok', read.status === 200 && read.payload.ok === true, JSON.stringify(read.payload))
check('GET returns the provider catalog', read.payload.catalog.providers.length === 1 && read.payload.catalog.providers[0].models[0].id === 'model-a')

const wrote = await invoke('POST', { scope: 'model', provider: 'demo', model: 'model-a', on: true })
check('POST marks the model', wrote.status === 200 && wrote.payload.catalog.providers[0].models[0].marked === true, JSON.stringify(wrote.payload.catalog?.providers))
check('the mark landed in the settings namespace', settingsState.models['demo/model-a'] === 'per-request', JSON.stringify(settingsState.models))

const reread = await invoke('GET')
check('a later GET sees the persisted mark', reread.payload.catalog.providers[0].models[0].marked === true)

const cleared = await invoke('POST', { scope: 'model', provider: 'demo', model: 'model-a', on: false })
check('POST unmarks the model', cleared.payload.catalog.providers[0].models[0].marked === false)
// An unmark must be expressible as the explicit opposite mode: `update` deep-
// merges, so a key omitted from the patch survives and a delete-based unmark
// is a silent no-op against the real service.
check('the unmark is stored as an explicit per-token override',
  settingsState.models['demo/model-a'] === 'per-token', JSON.stringify(settingsState.models))
check('the unmarked model reports itself as explicitly set',
  cleared.payload.catalog.providers[0].models[0].explicit === true)

/**
 * Reset the stored user section and let the plugin observe it, the way a fresh
 * document plus one commit would. Writing through the route alone cannot clear
 * an explicit mark, so the checks below start from a known section instead.
 * @param next - the user section to install.
 */
const setState = async (next) => {
  for (const key of Object.keys(settingsState)) delete settingsState[key]
  Object.assign(settingsState, { global: false, providerDefault: {}, models: {} }, next)
  if (watched !== undefined) await watched(settingsScope.get(), undefined)
}

await setState({})
const providerOn = await invoke('POST', { scope: 'provider', provider: 'demo', on: true })
check('POST marks the provider', providerOn.payload.catalog.providers[0].marked === true)
check('its models inherit the provider mark', providerOn.payload.catalog.providers[0].models[0].marked === true)
check('an inherited model is not reported as explicit',
  providerOn.payload.catalog.providers[0].models[0].explicit === false)
const providerOff = await invoke('POST', { scope: 'provider', provider: 'demo', on: false })
check('POST unmarks the provider', providerOff.payload.catalog.providers[0].marked === false, JSON.stringify(settingsState.providerDefault))
check('the provider unmark is stored explicitly', settingsState.providerDefault.demo === 'per-token')
check('and its models follow it back down', providerOff.payload.catalog.providers[0].models[0].marked === false)
// A model may now opt back IN against a per-token provider default.
const reMarked = await invoke('POST', { scope: 'model', provider: 'demo', model: 'model-a', on: true })
check('a model can override its provider default', reMarked.payload.catalog.providers[0].models[0].marked === true)
check('the override wins over the provider default',
  reMarked.payload.catalog.providers[0].marked === false && reMarked.payload.catalog.providers[0].models[0].marked === true)

await setState({})
const globalOn = await invoke('POST', { scope: 'global', on: true })
check('POST marks everything globally', globalOn.payload.catalog.providers[0].marked === true)
check('global reaches every model', globalOn.payload.catalog.providers[0].models[0].marked === true)
const globalOff = await invoke('POST', { scope: 'global', on: false })
check('POST clears the global switch', globalOff.payload.catalog.providers[0].marked === false)

const bad = await invoke('POST', { scope: 'nonsense' })
check('an unknown scope is refused without crashing the route', bad.status === 400 && bad.payload.ok === false, JSON.stringify(bad.payload))

// The route is same-origin only, so a request a cross-site page can actually
// send (a form post, or fetch with text/plain) must be refused before the body
// is read. A JSON content type is what forces the CORS preflight this route
// never answers.
const formPost = await invoke('POST', { scope: 'global', on: true }, { headers: { 'content-type': 'application/x-www-form-urlencoded' } })
check('a non-JSON content type is refused', formPost.status === 415 && formPost.payload.ok === false, JSON.stringify(formPost.payload))
const noType = await invoke('POST', { scope: 'global', on: true }, { headers: {} })
check('a missing content type is refused', noType.status === 415, JSON.stringify(noType.payload))
check('and the refused cross-site write changed nothing', settingsState.global === false, JSON.stringify(settingsState))

const huge = await invoke('POST', undefined, { raw: '{"scope":"global","on":true,"pad":"' + 'x'.repeat(70 * 1024) + '"}' })
check('an oversized body is refused', huge.status === 413 && huge.payload.ok === false, JSON.stringify(huge.payload))
const malformed = await invoke('POST', undefined, { raw: '{not json' })
check('a malformed body is answered, not crashed', malformed.status === 400 && malformed.payload.ok === false, JSON.stringify(malformed.payload))
const wrongMethod = await invoke('DELETE')
check('an unsupported method is refused', wrongMethod.status === 405, JSON.stringify(wrongMethod.payload))

// ------------------------------------------------------ route detection (hook)
// The step's own resolved variables are authoritative; every other source is a
// fallback. Deciding on "any candidate that is marked" rather than on the most
// authoritative one would apply the policy to a session that merely used a
// marked model earlier in its life.
console.log('model detection (through the real assemble hook)')
check('the assemble hook was registered', typeof assemble === 'function')
if (typeof assemble === 'function') {
  const run = async ({ config = {}, variables, options, header, pending = null, lastUsed = null }) => {
    await setState(config)
    projected = { pending, lastUsed }
    const assembly = { sections: [], contexts: [], tools: [{ name: 'bash', description: 'run', parameters: {} }], variables }
    const agent = { options, session: { requestHeader: () => (header === undefined ? undefined : { config: header }) } }
    const out = await assemble(assembly, { agent, scope: agent }, async () => assembly)
    const injected = out.sections.find((section) => section.name === 'per-request-billing:optimize')
    return { injected: injected !== undefined, text: injected?.text ?? '' }
  }

  const marked = { provider: 'demo', model: 'model-a' }
  const other = { provider: 'other', model: 'model-b' }

  const hit = await run({ config: { models: { 'demo/model-a': 'per-request' } }, variables: marked, options: marked, header: marked, lastUsed: marked })
  check('a marked route is optimized', hit.injected === true)
  check('the injected text names the running model', hit.text.includes('`demo/model-a`'), hit.text.slice(0, 80))
  check('the injected text keeps the approval guarantee', hit.text.includes('安全底线'))

  const miss = await run({ variables: other, options: other, header: other, lastUsed: other })
  check('an unmarked route is left alone', miss.injected === false)

  const switched = await run({
    config: { providerDefault: { demo: 'per-request' } },
    variables: other,
    options: marked,
    header: other,
    lastUsed: other,
  })
  check('a session that switched away from a marked model is left alone', switched.injected === false)

  const inherited = await run({
    config: { providerDefault: { demo: 'per-request' } },
    variables: marked,
    options: marked,
    header: marked,
    lastUsed: marked,
  })
  check('a provider-level mark still reaches its own models', inherited.injected === true)

  const pendingHit = await run({ config: { models: { 'demo/model-a': 'per-request' } }, variables: undefined, options: other, header: other, pending: marked, lastUsed: other })
  check('a pending selection is honored when no route was resolved', pendingHit.injected === true)

  const headerHit = await run({ config: { models: { 'demo/model-a': 'per-request' } }, variables: undefined, options: other, header: marked, lastUsed: other })
  check('the logged request header is the next fallback', headerHit.injected === true)
}

console.log('')
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
