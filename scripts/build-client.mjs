/**
 * Build `lib/client.js` from `src/client/index.js`.
 *
 * A client bundle is not a module the shell imports: it is a script that hands
 * a factory to the module loader, and the loader answers that factory's
 * `require` calls from its module table. The canonical build produces exactly
 * this shape (see `packages/client/tsdown.client.ts` in the harness
 * repository), so emitting it directly here removes the need for the
 * repository's tsc + tsdown pipeline while staying byte-compatible with what
 * the shell expects:
 *
 *   window.__ModuleLoader__.load({
 *     id: '<package name>',
 *     factory: (require) => { <module body> return module.exports; }
 *   })
 *
 * The added prelude only defines `module` and `exports`; `require` is the
 * loader's own, so an unseeded specifier fails loudly at boot instead of
 * silently resolving to nothing.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const id = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
const source = readFileSync(join(root, 'src/client/index.js'), 'utf8')

const banner = [
  `window.__ModuleLoader__.load({`,
  `  id: ${JSON.stringify(id)},`,
  `  factory: (require) => {`,
  `    var module = { exports: {} };`,
  `    var exports = module.exports;`,
  '',
].join('\n')

const footer = [
  '',
  '    return module.exports;',
  '  },',
  '});',
  '',
].join('\n')

const bundle = banner + source + footer

// Prove the bundle is syntactically valid before it is ever served: the shell
// evaluates it with the same primitive.
try {
  new Function('window', bundle)
} catch (error) {
  console.error(`build: bundle is not valid JavaScript: ${error.message}`)
  process.exit(1)
}

mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib/client.js'), bundle)
console.log(`built lib/client.js (${bundle.length} bytes, id ${id})`)
