// Builds public/maia/maia1-<rating>.bin from the Maia-1 networks (CSSLab, GPL-3.0,
// https://github.com/CSSLab/maia-chess): human move prediction at Lichess ratings 1100–1900.
//
// 1. Convert each lc0 network to ONNX with lc0 (https://github.com/LeelaChessZero/lc0/releases), which folds
//    the batch norms into the convolutions:
//      lc0 leela2onnx --input=maia-1500.pb.gz --output=maia1-1500.onnx
// 2. node scripts/build-maia.mjs <dir with maia1-*.onnx>
//
// The output keeps only what move prediction needs (the residual tower and the policy head, not the value
// head), as float16 in a fixed order that src/maia/net.ts reads.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

const dir = process.argv[2]
if (!dir) throw new Error('usage: build-maia.mjs <dir with maia1-*.onnx>')
const OUT = 'public/maia'
const BLOCKS = 6
const FILTERS = 64

// --- minimal protobuf reading: an ONNX model's initializers (name -> dims, float32 data) ---
function fields(buf, start, end) {
  const out = []
  let p = start
  const varint = () => {
    let r = 0
    let s = 0
    for (;;) {
      const b = buf[p++]
      r += (b & 0x7f) * 2 ** s
      if (!(b & 0x80)) return r
      s += 7
    }
  }
  while (p < end) {
    const key = varint()
    const wt = key & 7
    const no = Math.floor(key / 8)
    if (wt === 0) out.push({ no, v: varint() })
    else if (wt === 2) {
      const len = varint()
      out.push({ no, s: p, e: p + len })
      p += len
    } else if (wt === 5) p += 4
    else if (wt === 1) p += 8
    else throw new Error(`unexpected wire type ${wt}`)
  }
  return out
}

function initializers(buf) {
  const graph = fields(buf, 0, buf.length).find((f) => f.no === 7)
  const out = new Map()
  for (const f of fields(buf, graph.s, graph.e)) {
    if (f.no !== 5) continue
    const t = fields(buf, f.s, f.e)
    const name = buf.toString('utf8', t.find((x) => x.no === 8).s, t.find((x) => x.no === 8).e)
    const dims = t.filter((x) => x.no === 1).map((x) => x.v)
    const type = t.find((x) => x.no === 2).v
    const raw = t.find((x) => x.no === 9)
    out.set(name, { dims, type, raw: raw && buf.subarray(raw.s, raw.e) })
  }
  return out
}

// float32 -> float16 bits, rounding to nearest even
const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)
function toHalf(x) {
  f32[0] = x
  const u = u32[0]
  const sign = (u >>> 16) & 0x8000
  let exp = ((u >>> 23) & 0xff) - 127 + 15
  let mant = u & 0x7fffff
  if (exp >= 31) return sign | 0x7c00
  if (exp <= 0) {
    if (exp < -10) return sign
    mant |= 0x800000
    const shift = 14 - exp
    let h = mant >> shift
    if ((mant >> (shift - 1)) & 1 && ((mant & ((1 << (shift - 1)) - 1)) || h & 1)) h++
    return sign | h
  }
  let h = sign | (exp << 10) | (mant >> 13)
  if (mant & 0x1000 && (mant & 0xfff || h & 1)) h++
  return h
}

mkdirSync(OUT, { recursive: true })
for (const file of readdirSync(dir).filter((f) => /^maia1-\d+\.onnx$/.test(f))) {
  const inits = initializers(readFileSync(`${dir}/${file}`))
  const order = ['/inputconv/w/kernel', '/inputconv/w/bias']
  for (let b = 0; b < BLOCKS; b++) {
    const p = `/block${b}/conv`
    order.push(`${p}1/w/kernel`, `${p}1/w/bias`, `${p}2/w/kernel`, `${p}2/w/bias`)
    order.push(`${p}2/se/matmul1/w`, `${p}2/se/add1/w`, `${p}2/se/matmul2/w`, `${p}2/se/add2/w`)
  }
  order.push('/policy/conv1/w/kernel', '/policy/conv1/w/bias', '/policy/conv2/w/kernel', '/policy/conv2/w/bias')
  if (inits.get('/inputconv/w/kernel').dims[0] !== FILTERS || !inits.has(`/block${BLOCKS - 1}/conv1/w/kernel`) || inits.has(`/block${BLOCKS}/conv1/w/kernel`)) {
    throw new Error(`${file}: expected ${BLOCKS} blocks of ${FILTERS} filters`)
  }
  const halves = []
  for (const name of order) {
    const t = inits.get(name)
    if (!t || t.type !== 1 || !t.raw) throw new Error(`${file}: ${name} missing or not raw float32`)
    const data = new Float32Array(t.raw.buffer.slice(t.raw.byteOffset, t.raw.byteOffset + t.raw.length))
    for (const v of data) halves.push(toHalf(v))
  }
  // The policy head's mapping from its 80x8x8 output to the 1858 policy moves
  const map = inits.get('/const/mapping_table')
  const mapping = map.type === 6 ? new Int32Array(map.raw.buffer.slice(map.raw.byteOffset, map.raw.byteOffset + map.raw.length)) : null
  if (!mapping || mapping.length !== 1858) throw new Error(`${file}: unexpected mapping table`)
  const out = new Uint16Array(halves.length + 1858)
  out.set(halves)
  out.set(Uint16Array.from(mapping), halves.length)
  const name = file.replace('.onnx', '.bin')
  writeFileSync(`${OUT}/${name}`, out)
  console.log(`${name}: ${(out.byteLength / 1e6).toFixed(2)} MB`)
}
