/**
 * Package-shape checks that need no DSH install and no peer dependencies.
 *
 * `npm pack` runs this through `prepack`, so it must stay dependency-free: a
 * packer legitimately has no install, and failing there would make the package
 * unpublishable. It validates only the artifacts that ship.
 *
 * Use scripts/check.mjs for the full behavioural contract (it imports the host
 * half and therefore needs DSH_INSTALL).
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

check('declares a scoped-free package name', typeof manifest.name === 'string' && manifest.name.length > 0)
check('declares a version', typeof manifest.version === 'string')
check('declares a license', typeof manifest.license === 'string')
check('is ESM (host half runs in the DSH host process)', manifest.type === 'module')
check('main points at the host half', typeof manifest.main === 'string' && existsSync(join(root, manifest.main)), manifest.main)
check('exports the host half', manifest.exports?.['.']?.default === './lib/index.js')
check('exports the client bundle', manifest.exports?.['./client']?.default === './lib/client.js')

// The two declarations that make this a bundle rather than a plain library.
check('declares dsh.bundle.patch', typeof manifest.dsh?.bundle?.patch === 'string', JSON.stringify(manifest.dsh?.bundle))
const patchPath = manifest.dsh?.bundle?.patch
if (typeof patchPath === 'string') {
  const patchFile = join(root, patchPath)
  check('the patch file exists', existsSync(patchFile), patchPath)
  if (existsSync(patchFile)) {
    const patch = readFileSync(patchFile, 'utf8')
    check('the patch inserts rows', /^- insert:/m.test(patch))
    const rows = [...patch.matchAll(/^\s+- id: (.+)$/gm)].map((match) => match[1].trim())
    check('the patch names the host row', rows.includes('per-request-billing'), rows.join(', '))
    check('the patch does not name a client row',
      !rows.some((row) => row.includes('client')),
      'a browser half is served through the web module graph, not a composition row')
  }
}

check('declares dsh.client.platform', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client?.platform))
check('declares client externals', Array.isArray(manifest.dsh?.client?.external), 'needed for specifiers beyond the platform seed')
// Forwarded host events only reach the browser through the remote gateway, and
// its `ctx.remote` service exists only once the api-remotes client half has
// applied. Without this declaration the subscription can silently find nothing
// and the UI stops noticing anything the host learns later.
check('declares the remote gateway its event subscription needs',
  (manifest.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-api-remotes'),
  JSON.stringify(manifest.dsh?.client?.inject))

// DSH's own packages are peers the runtime supplies; schemastery is a real dep.
const peers = Object.keys(manifest.peerDependencies ?? {})
check('declares its host peers', peers.includes('@deepseek-ai/dsh-tools') && peers.includes('@deepseek-ai/dsh-settings'), peers.join(', '))
check('declares schemastery as a dependency', typeof manifest.dependencies?.['@deepseek-ai/schemastery'] === 'string')

// The shipped client bundle must be parseable and carry the loader handoff.
const bundlePath = join(root, 'lib/client.js')
check('the client bundle exists', existsSync(bundlePath), 'run npm run build')
if (existsSync(bundlePath)) {
  const bundle = readFileSync(bundlePath, 'utf8')
  check('the bundle calls __ModuleLoader__.load', bundle.includes('window.__ModuleLoader__.load('))
  check('the bundle carries the package id', bundle.includes(JSON.stringify(manifest.name)))
  check('the bundle has no top-level ESM export',
    !/^\s*export\s/m.test(bundle),
    'the bundle format is CommonJS; use exports.<name> = in the client source')
  let handoff
  try {
    new Function('window', bundle)({ __ModuleLoader__: { load: (spec) => { handoff = spec } } })
  } catch (error) {
    check('the bundle evaluates', false, error.message)
  }
  if (handoff !== undefined) {
    check('the factory is callable', typeof handoff.factory === 'function')
    // `require` is answered by the loader's module table; every specifier the
    // bundle asks for must be one the platform actually seeds, or the browser
    // throws at load. Track the asks instead of asserting a constant.
    const SEEDED = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis']
    const asked = []
    let unseeded
    let exported
    try {
      exported = handoff.factory((specifier) => {
        asked.push(specifier)
        if (!SEEDED.includes(specifier)) {
          unseeded = specifier
          throw new Error(`unseeded require: ${specifier}`)
        }
        return { createElement: () => null, useState: (value) => [value, () => {}], useEffect: () => {} }
      })
    } catch (error) {
      check('the factory runs with only seeded specifiers', false, error.message)
    }
    check('the factory only requires platform-seeded specifiers', unseeded === undefined,
      `tried to require ${unseeded}; seeded: ${SEEDED.join(', ')}`)
    check('the factory requires at least one module', asked.length > 0, 'no require() calls were made')
    check('the bundle exports apply', typeof exported?.apply === 'function')
  }
}

console.log('')
if (failures > 0) {
  console.error(`${failures} package check(s) failed`)
  process.exit(1)
}
console.log('package shape is valid')
