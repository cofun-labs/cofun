import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildManifest } from '../manifest'

it('[@no-uc:privacy] grants no Confluence site by default and limits panel requests to Cofun and Clerk', () => {
  const entries = readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')
  const env = Object.fromEntries(
    entries
      .filter((line) => /^\w+=/.test(line))
      .map((line) => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1).trim()]
      }),
  )
  const manifest = buildManifest({ ...env, VITE_CLERK_SYNC_HOST: env.VITE_CLERK_SYNC_HOST }, '0.0.1')
  expect(manifest.permissions).toEqual(['sidePanel', 'storage', 'tabs', 'cookies', 'scripting'])
  expect(manifest.host_permissions).toEqual([
    'https://clerk.cofun.cc/*',
    'https://api.cofun.cc/*',
    'https://*.cofun.cc/*',
  ])
  expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*'])
  expect(manifest.content_security_policy.extension_pages).toBe(
    "default-src 'self'; script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' https://api.cofun.cc https://clerk.cofun.cc; img-src 'self' data: blob: https://img.clerk.com",
  )
})
