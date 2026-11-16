import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@clerk/chrome-extension': fileURLToPath(import.meta.resolve('@cofun/app/test-clerk')) },
  },
  test: {
    environment: 'jsdom',
    env: {
      VITE_API_URL: 'https://api.copilot.test/v1/',
      VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_fake',
      VITE_CLERK_SYNC_HOST: 'https://copilot.test',
    },
  },
})
