import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The tests run without the build config (vite.config.ts), which needs the build's env.
export default defineConfig({
  resolve: {
    // The side panel's UI tests (test/*.test.tsx) run the panel with a fake Clerk; see test/clerk.tsx.
    alias: { '@clerk/chrome-extension': fileURLToPath(new URL('./test/clerk.tsx', import.meta.url)) },
  },
  test: {
    // *.test.ts run in Node. *.test.tsx name their DOM environment in a `@vitest-environment` comment.
    include: ['test/**/*.test.{ts,tsx}'],
    // What the build reads from .env.local. Nothing is sent to these hosts: the tests answer every request.
    env: {
      VITE_API_URL: 'https://api.copilot.test/v1/',
      VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_fake',
      VITE_CLERK_SYNC_HOST: 'https://copilot.test',
    },
  },
})
