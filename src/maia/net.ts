// The Maia-1 network (lc0 architecture: 6 residual blocks of 64 filters with squeeze-and-excitation, and a
// convolutional policy head), run in plain TypeScript: about 38M multiply-adds per position, tens of
// milliseconds, so there's no ML runtime to download. Weights come from scripts/build-maia.mjs.

const BLOCKS = 6
const F = 64 // filters
const SE = 8 // squeeze-and-excitation width
const INPUT = 112 // input planes
const POLICY_PLANES = 80
export const POLICY_SIZE = 1858

interface Conv {
  w: Float32Array // [out][in][3][3]
  b: Float32Array
  cin: number
  cout: number
}

interface Block {
  conv1: Conv
  conv2: Conv
  se1: Float32Array // [F][SE]
  se1b: Float32Array
  se2: Float32Array // [SE][2F]
  se2b: Float32Array
}

export interface Net {
  input: Conv
  blocks: Block[]
  policy1: Conv
  policy2: Conv
  mapping: Uint16Array // policy move -> index into the 80x64 policy head output
}

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >> 10) & 0x1f
  const mant = h & 0x3ff
  if (exp === 0) return sign * mant * 2 ** -24
  if (exp === 31) return mant ? NaN : sign * Infinity
  return sign * (1 + mant / 1024) * 2 ** (exp - 15)
}

export function loadNet(buffer: ArrayBuffer): Net {
  const halves = new Uint16Array(buffer)
  let p = 0
  const take = (n: number) => {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = halfToFloat(halves[p + i])
    p += n
    return out
  }
  const conv = (cin: number, cout: number): Conv => ({ w: take(cout * cin * 9), b: take(cout), cin, cout })
  const input = conv(INPUT, F)
  const blocks: Block[] = []
  for (let i = 0; i < BLOCKS; i++) {
    blocks.push({ conv1: conv(F, F), conv2: conv(F, F), se1: take(F * SE), se1b: take(SE), se2: take(SE * 2 * F), se2b: take(2 * F) })
  }
  const policy1 = conv(F, F)
  const policy2 = conv(F, POLICY_PLANES)
  const mapping = halves.slice(p, p + POLICY_SIZE)
  if (mapping.length !== POLICY_SIZE || p + POLICY_SIZE !== halves.length) throw new Error('Unexpected Maia network size')
  return { input, blocks, policy1, policy2, mapping }
}

/** 3x3 convolution with zero padding over 8x8 planes, plus bias: x [cin][64] -> [cout][64]. */
function conv3(c: Conv, x: Float32Array): Float32Array {
  const y = new Float32Array(c.cout * 64)
  for (let o = 0; o < c.cout; o++) {
    const out = o * 64
    y.fill(c.b[o], out, out + 64)
    for (let i = 0; i < c.cin; i++) {
      const inp = i * 64
      const wo = (o * c.cin + i) * 9
      for (let ky = 0; ky < 3; ky++) {
        // output rows whose input row (r + ky - 1) is on the board
        const r0 = ky === 0 ? 1 : 0
        const r1 = ky === 2 ? 7 : 8
        for (let kx = 0; kx < 3; kx++) {
          const w = c.w[wo + ky * 3 + kx]
          if (w === 0) continue
          const c0 = kx === 0 ? 1 : 0
          const c1 = kx === 2 ? 7 : 8
          const shift = (ky - 1) * 8 + (kx - 1)
          for (let r = r0; r < r1; r++) {
            const row = out + r * 8
            const src = inp + r * 8 + shift
            for (let col = c0; col < c1; col++) y[row + col] += w * x[src + col]
          }
        }
      }
    }
  }
  return y
}

function relu(x: Float32Array): Float32Array {
  for (let i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0
  return x
}

/** Policy logits (1858, lc0 move order, from the side to move's view) for encoded input planes. */
export function forward(net: Net, planes: Float32Array): Float32Array {
  let x = relu(conv3(net.input, planes))
  for (const b of net.blocks) {
    const h = conv3(b.conv2, relu(conv3(b.conv1, x)))
    // Squeeze and excitation: per-filter scale (sigmoid) and bias from the filters' means
    const mean = new Float32Array(F)
    for (let f = 0; f < F; f++) {
      let s = 0
      for (let k = 0; k < 64; k++) s += h[f * 64 + k]
      mean[f] = s / 64
    }
    const hidden = new Float32Array(SE)
    for (let j = 0; j < SE; j++) {
      let s = b.se1b[j]
      for (let f = 0; f < F; f++) s += mean[f] * b.se1[f * SE + j]
      hidden[j] = s > 0 ? s : 0
    }
    const next = new Float32Array(F * 64)
    for (let f = 0; f < F; f++) {
      let g = b.se2b[f]
      let beta = b.se2b[F + f]
      for (let j = 0; j < SE; j++) {
        g += hidden[j] * b.se2[j * 2 * F + f]
        beta += hidden[j] * b.se2[j * 2 * F + F + f]
      }
      const scale = 1 / (1 + Math.exp(-g))
      for (let k = 0; k < 64; k++) {
        const v = scale * h[f * 64 + k] + beta + x[f * 64 + k]
        next[f * 64 + k] = v > 0 ? v : 0
      }
    }
    x = next
  }
  const head = conv3(net.policy2, relu(conv3(net.policy1, x)))
  const logits = new Float32Array(POLICY_SIZE)
  for (let i = 0; i < POLICY_SIZE; i++) logits[i] = head[net.mapping[i]]
  return logits
}
