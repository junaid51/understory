import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The core and the bench apparatus are consumed as TypeScript source.
 *
 * Neither package has a build step: `@understory/core` points `main` at
 * `src/index.ts` because nothing is published to npm yet, so Vite compiles them
 * alongside the demo. That is also what makes this a laboratory rather than a
 * showcase, since editing the engine and reloading the page are the same action.
 */
export default defineConfig({
  base: './',
  server: { port: 5173 },
  build: { target: 'es2022', outDir: 'dist' },
  plugins: [react()],
})
