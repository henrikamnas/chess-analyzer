// Copies the Stockfish WASM build into public/ so the dev server and build can serve it as a worker.
import { copyFileSync, mkdirSync } from 'node:fs'

const src = 'node_modules/stockfish/bin'
const dest = 'public/engine'
mkdirSync(dest, { recursive: true })
copyFileSync(`${src}/stockfish-19-lite-single.js`, `${dest}/stockfish.js`)
copyFileSync(`${src}/stockfish-19-lite-single.wasm`, `${dest}/stockfish.wasm`)
console.log('Copied Stockfish (lite, single-threaded) to public/engine')
