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
  for (const dependency of ['dsh-tools', 'schemastery', 'dsh-util-values', 'dsh-brand', 'cordis', 'dsh-settings', 'dsh-scope']) {
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
const cardKeys = registered.filter((entry) => entry.options.name === 'settings.models.provider-card').map((entry) => entry.options.key)
check('registers both provider-card families', cardKeys.includes('llm-pi-ai') && cardKeys.includes('llm-deepseek'), cardKeys.join(', '))
check('registers no settings page of its own',
  !registered.some((entry) => entry.options.name === 'settings.section'),
  registered.map((entry) => entry.options.name).join(', '))
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

// The card has to write what the user actually toggled — the provider switch
// for the provider, a single model for a chip.
await new Promise((resolve) => setTimeout(resolve, 0))
{
  /**
   * Expand one element tree into host elements. Function components are
   * invoked, which is enough for this UI: none of its sub-components uses a
   * hook beyond the store subscription on the card itself.
   */
  const flatten = (node, out = []) => {
    if (Array.isArray(node)) {
      for (const item of node) flatten(item, out)
      return out
    }
    if (node === null || typeof node !== 'object') return out
    if (typeof node.type === 'function') return flatten(node.type(node.props), out)
    out.push(node)
    flatten(node.children, out)
    return out
  }
  const entry = registered.find((e) => e.options.name === 'settings.models.provider-card' && e.options.key === 'llm-pi-ai')
  const tree = flatten(entry.component({ provider: { provider: 'demo', displayName: 'Demo' } }))
  const labels = tree.filter((node) => node.type === 'label')
  const providerRow = labels.find((node) => node.props.className === 'prb-row')
  const chip = (id) => labels.find((node) => String(node.props.className).startsWith('prb-model')
    && flatten(node.children).some((child) => child.type === 'span' && [].concat(child.children ?? []).includes(id)))
  const toggle = (label) => (value) => flatten(label.children)
    .find((child) => child.type === 'input')
    .props.onChange({ target: { checked: value } })

  check('the card renders the provider switch and one chip per model',
    providerRow !== undefined && chip('model-a') !== undefined && chip('model-b') !== undefined,
    `${labels.length} label(s)`)
  check('an inherited model is labelled as following its provider',
    flatten(chip('model-b').children).some((child) => [].concat(child.children ?? []).includes('· 跟随提供方')))
  check('an individually set model carries no inheritance label',
    !flatten(chip('model-a').children).some((child) => [].concat(child.children ?? []).includes('· 跟随提供方')))

  const before = hostCalls.length
  await toggle(providerRow)(true)
  await toggle(chip('model-a'))(false)
  const writes = hostCalls.slice(before).filter((call) => call.method === 'POST').map((call) => call.body)
  check('the provider switch writes a provider mark',
    JSON.stringify(writes[0]) === JSON.stringify({ scope: 'provider', provider: 'demo', on: true }), JSON.stringify(writes[0]))
  check('a chip writes only its own model',
    JSON.stringify(writes[1]) === JSON.stringify({ scope: 'model', provider: 'demo', model: 'model-a', on: false }), JSON.stringify(writes[1]))
}

// ------------------------------------------------------- host route contract
console.log('host route contract (through the real settings service)')
// The write path is checked against the REAL settings provider rather than a
// hand-modelled stub. Both primitives it offers matter here and neither is
// guessable: `update` merges recursively (so it can only add or overwrite a
// key) while `mutate` applies path ops (so it can also remove one). A stub
// that got either wrong would rubber-stamp a write path that cannot work.
const { Context } = await import('@deepseek-ai/cordis')
const { SettingsProvider } = await import('@deepseek-ai/dsh-settings')

/** Minimal writable provider whose document lives in memory. */
class MemorySettings extends SettingsProvider {
  doc = {}
  get writable() { return true }
  async load() { return this.doc }
  async persist(ns, section) { this.doc[ns] = structuredClone(section) }
}
const settingsRoot = new Context()
settingsRoot.plugin(MemorySettings)
await new Promise((resolve) => setTimeout(resolve, 30))
const settings = settingsRoot.get('settings')
check('the real settings service is available for the write checks', settings !== undefined)
/** The stored user section for this plugin's namespace. */
const stored = () => settings.describe().find((descriptor) => descriptor.ns === 'per-request-billing')?.user ?? {}

const catalogModels = [{ id: 'model-a', name: 'A' }]
const stubCatalogCtx = {
  llm: {
    listConfigurableProviders: () => [{ provider: 'demo', displayName: 'Demo', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'demo'] }],
    listProviders: () => [],
    listModels: async () => catalogModels,
  },
  settings,
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
check('the mark landed in the settings namespace', stored().models?.['demo/model-a'] === 'per-request', JSON.stringify(stored()))

const reread = await invoke('GET')
check('a later GET sees the persisted mark', reread.payload.catalog.providers[0].models[0].marked === true)

/** Replace the stored user section, the way a fresh document would look. */
const setState = async (next = {}) => {
  await settings.replace('per-request-billing', { global: false, providerDefault: {}, models: {}, ...next })
}
const providerOf = (result) => result.payload.catalog.providers[0]
const modelOf = (result) => result.payload.catalog.providers[0].models[0]

const cleared = await invoke('POST', { scope: 'model', provider: 'demo', model: 'model-a', on: false })
check('POST unmarks the model', modelOf(cleared).marked === false)
// The requested value already equals what the model inherits, so the override
// is dropped rather than restated: storing it would freeze the model and stop
// it following its provider.
check('the unmark drops the override rather than freezing it',
  stored().models?.['demo/model-a'] === undefined, JSON.stringify(stored()))
check('the unmarked model is not reported as explicitly set', modelOf(cleared).explicit === false)

await setState()
const providerOn = await invoke('POST', { scope: 'provider', provider: 'demo', on: true })
check('POST marks the provider', providerOf(providerOn).marked === true)
check('its models inherit the provider mark', modelOf(providerOn).marked === true)
check('an inherited model is not reported as explicit', modelOf(providerOn).explicit === false)
check('an inherited mark is stored once, on the provider',
  stored().providerDefault?.demo === 'per-request' && Object.keys(stored().models ?? {}).length === 0,
  JSON.stringify(stored()))

const providerOff = await invoke('POST', { scope: 'provider', provider: 'demo', on: false })
check('POST unmarks the provider', providerOf(providerOff).marked === false, JSON.stringify(stored()))
check('the provider unmark drops the override instead of freezing it',
  stored().providerDefault?.demo === undefined, JSON.stringify(stored()))
check('and its models follow it back down', modelOf(providerOff).marked === false)

await setState()
const reMarked = await invoke('POST', { scope: 'model', provider: 'demo', model: 'model-a', on: true })
check('a model can be marked on its own', modelOf(reMarked).marked === true && modelOf(reMarked).explicit === true)
check('the individual mark is stored', stored().models?.['demo/model-a'] === 'per-request', JSON.stringify(stored()))
// Switching a parent level re-establishes inheritance for everything under it,
// so a model marked individually starts following its provider again instead of
// outvoting it forever.
const followDown = await invoke('POST', { scope: 'provider', provider: 'demo', on: false })
check('toggling the provider clears individual model marks',
  Object.keys(stored().models ?? {}).length === 0, JSON.stringify(stored()))
check('and the model follows the provider down',
  modelOf(followDown).marked === false && modelOf(followDown).explicit === false)
const followUp = await invoke('POST', { scope: 'provider', provider: 'demo', on: true })
check('and follows it back up', modelOf(followUp).marked === true && modelOf(followUp).explicit === false)

// Setting a model to the value it already inherits clears the override instead
// of freezing it, so the chip returns to "follows its provider".
await setState({ providerDefault: { demo: 'per-request' } })
const redundant = await invoke('POST', { scope: 'model', provider: 'demo', model: 'model-a', on: true })
check('a model mark equal to what it inherits is not stored',
  Object.keys(stored().models ?? {}).length === 0, JSON.stringify(stored()))
check('and the model still reads as per-request', modelOf(redundant).marked === true)
const optedOut = await invoke('POST', { scope: 'model', provider: 'demo', model: 'model-a', on: false })
check('a model can opt out of a marked provider',
  modelOf(optedOut).marked === false && stored().models?.['demo/model-a'] === 'per-token')

await setState({ providerDefault: { demo: 'per-token' }, models: { 'demo/model-a': 'per-token' } })
const globalOn = await invoke('POST', { scope: 'global', on: true })
check('POST marks everything globally', providerOf(globalOn).marked === true && modelOf(globalOn).marked === true)
check('the global switch clears the levels below it',
  Object.keys(stored().providerDefault ?? {}).length === 0 && Object.keys(stored().models ?? {}).length === 0,
  JSON.stringify(stored()))
const globalOff = await invoke('POST', { scope: 'global', on: false })
check('POST clears the global switch', providerOf(globalOff).marked === false)

const bad = await invoke('POST', { scope: 'nonsense' })
check('an unknown scope is refused without crashing the route', bad.status === 400 && bad.payload.ok === false, JSON.stringify(bad.payload))

// The route is same-origin only, so a request a cross-site page can actually
// send (a form post, or fetch with text/plain) must be refused before the body
// is read. A JSON content type is what forces the CORS preflight this route
// never answers.
const beforeRefused = JSON.stringify(stored())
const formPost = await invoke('POST', { scope: 'global', on: true }, { headers: { 'content-type': 'application/x-www-form-urlencoded' } })
check('a non-JSON content type is refused', formPost.status === 415 && formPost.payload.ok === false, JSON.stringify(formPost.payload))
const noType = await invoke('POST', { scope: 'global', on: true }, { headers: {} })
check('a missing content type is refused', noType.status === 415, JSON.stringify(noType.payload))
check('and the refused cross-site write changed nothing', JSON.stringify(stored()) === beforeRefused, JSON.stringify(stored()))

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
