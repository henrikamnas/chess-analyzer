// Copies runtime files from node_modules into public/ so the dev server and build serve them as-is.
import { copyFileSync, mkdirSync } from 'node:fs'

// Stockfish builds, loaded as web workers.
const src = 'node_modules/stockfish/bin'
const dest = 'public/engine'
const builds = {
  stockfish: 'stockfish-19-lite-single', // fast default (~1.6 MB)
  'stockfish-full': 'stockfish-19', // full network, multi-threaded (~99 MB, needs cross-origin isolation)
  'stockfish-full-single': 'stockfish-19-single', // full network, single-threaded fallback
}
mkdirSync(dest, { recursive: true })
for (const [name, file] of Object.entries(builds)) {
  copyFileSync(`${src}/${file}.js`, `${dest}/${name}.js`)
  copyFileSync(`${src}/${file}.wasm`, `${dest}/${name}.wasm`)
}

// Service worker that adds the COOP/COEP headers on hosts that can't (e.g. GitHub Pages),
// so the multi-threaded engine works there too. It does nothing when the server already sends them.
copyFileSync('node_modules/coi-serviceworker/coi-serviceworker.min.js', 'public/coi-serviceworker.js')

console.log(`Copied Stockfish builds (${Object.keys(builds).join(', ')}) and coi-serviceworker into public/`)
