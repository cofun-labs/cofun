import { expect, it } from 'vitest'
import { buildManifest } from '../manifest'

it('[@no-uc:access] asks for site access individually and has its own extension identity', () => {
  const manifest = buildManifest({ VITE_CLERK_SYNC_HOST: 'https://copilot.test' }, '0.0.1')
  expect(manifest.name).toBe('Cofun: AI browser copilot')
  expect(manifest.action.default_title).toBe('Open Cofun')
  expect(manifest.host_permissions).toEqual(['https://copilot.test/*', 'https://*.copilot.test/*'])
  expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*'])
  expect(manifest).not.toHaveProperty('key')
})
