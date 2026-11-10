import { defineConfig } from 'vitest/config'

// The tests run without the build config (vite.config.ts), which needs the build's env.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
