import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Cloudflare Workers Builds runs these tests before every deploy, and its build machine can stall
    // for seconds: one stall pushed a test that takes milliseconds past vitest's 5 s default, and the
    // deploy failed (#286). The tests never wait for time to pass, so the timeout only has to catch a
    // test that hangs, and a long one still does. Hooks (10 s by default) get the same room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
