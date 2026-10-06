import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Cross-origin isolation lets the full Stockfish build use multiple threads (SharedArrayBuffer).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  // GitHub Pages serves the app from /<repo>/; the deploy workflow sets BASE_PATH.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    allowedHosts: ['.ts.net'],
    headers: isolation,
  },
  preview: {
    headers: isolation,
  },
})
