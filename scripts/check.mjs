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
const stubCtx = {
  effect: (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get: (service) => (service === 'slots' ? slots : undefined),
  on: () => {},
  timeout: () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}
globalThis.fetch = async () => ({ json: async () => ({ ok: true, catalog: { global: false, providers: [], stats: { markedModels: 0, totalModels: 0, steps: 0 } } }) })
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

// ------------------------------------------------------- host route contract
console.log('host route contract (through the real handler)')
const settingsState = { global: false, providerDefault: {}, models: {} }
let watched
const settingsScope = {
  get: () => ({ global: settingsState.global, providerDefault: { ...settingsState.providerDefault }, models: { ...settingsState.models } }),
  watch: (callback) => {
    watched = callback
    return () => {}
  },
  update: async (patch) => {
    Object.assign(settingsState, patch)
    if (watched !== undefined) await watched(settingsScope.get(), undefined)
  },
  replace: async () => {},
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
  get: (service) => (service === 'webServer' ? webServer : (service === 'agentDefaultModel' ? undefined : undefined)),
  on: () => {},
  effect: (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}
let route
const webServer = { register: (spec) => { route = spec; return () => {} } }
host.apply(stubCatalogCtx)
check('registers a client state route', route !== undefined && typeof route.path === 'string', 'webServer.register was not called')
check('route path is namespaced', route?.path?.startsWith('/plugins/dsh-per-request-billing/'), String(route?.path))

const invoke = async (method, body) => {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
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
check('the unmark reached the namespace', settingsState.models['demo/model-a'] === undefined)

const bad = await invoke('POST', { scope: 'nonsense' })
check('an unknown scope is refused without crashing the route', bad.status === 400 && bad.payload.ok === false, JSON.stringify(bad.payload))

console.log('')
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
