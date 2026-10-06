// Copies the Stockfish WASM builds into public/ so the dev server and build can serve them as workers.
import { copyFileSync, mkdirSync } from 'node:fs'

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
console.log(`Copied Stockfish builds to ${dest}: ${Object.keys(builds).join(', ')}`)
