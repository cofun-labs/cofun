import { defineConfig } from '@playwright/test'

export default defineConfig({
  // The browser tests: the built extension in Chromium. The vitest tests are in test/.
  testDir: 'browser-test',
  // One Chromium with the extension loaded per test is plenty for a handful of tests.
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 30_000,
})
