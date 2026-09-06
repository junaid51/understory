import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'bench/test/**/*.test.ts', 'demo/test/**/*.test.ts'],
    // Property tests are slower than unit tests and this ceiling is deliberate:
    // if a property suite needs longer than this, the generators are too large
    // for the fast CI tier and belong in the deep tier instead.
    testTimeout: 30_000,
  },
})
