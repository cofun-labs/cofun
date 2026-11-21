import { defineConfig } from 'vitest/config'

// The tab tools read pages in a DOM, as the side panel does (markdown.ts), and run in the tab what
// Chrome would run there (test/youtube.ts).
export default defineConfig({ test: { environment: 'jsdom' } })
