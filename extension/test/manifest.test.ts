// The extension's manifest (extension/manifest.ts). Chrome disables an installed extension on
// update when the new version adds a permission warning, so the permissions are pinned here: a
// change to them must change this file in the same pull request, where a reviewer sees it.
import { describe, expect, it } from 'vitest'
import { buildManifest, clerkFrontendApi, type ManifestEnv } from '../manifest'
import { hostedEnv } from './hosted-env'

const NOTION = ['https://www.notion.so/*', 'https://app.notion.com/*']
const CLERK_HOST = 'clerk.example.com'
/** A publishable key as Clerk builds it: the Frontend API host and a `$`, in base64. */
const PUBLISHABLE_KEY = `pk_live_${Buffer.from(`${CLERK_HOST}$`).toString('base64')}`

function manifest(env: Partial<ManifestEnv> & Pick<ManifestEnv, 'VITE_CLERK_SYNC_HOST'>) {
  return buildManifest({ VITE_CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY, ...env }, '1.2.3')
}

describe('extension manifest', () => {
  // What the published extension asks its users for. A change to extension/.env that changes
  // these (another Clerk instance, another sign-in host) must change this test too.
  it('ships with exactly these permissions and host permissions', () => {
    const env = hostedEnv()
    const json = buildManifest({ ...env, VITE_CLERK_SYNC_HOST: env.VITE_CLERK_SYNC_HOST! }, '1.2.3')
    expect(json.permissions).toEqual(['sidePanel', 'storage', 'tabs', 'cookies', 'scripting'])
    expect(json.host_permissions).toEqual([
      'https://www.notion.so/*',
      'https://app.notion.com/*',
      'https://saving-yeti-9519.clerk.accounts.dev/*',
      'https://notion-copilot.kitfun.cc/*',
      'https://*.kitfun.cc/*',
    ])
  })

  it('asks for exactly these permissions, whatever the env', () => {
    const envs: ManifestEnv[] = [
      { VITE_CLERK_SYNC_HOST: 'https://notion-copilot.kitfun.cc' },
      { VITE_CLERK_SYNC_HOST: 'https://app.example.co.uk', CLERK_COOKIE_DOMAIN: 'example.co.uk' },
      { VITE_CLERK_SYNC_HOST: 'http://localhost:8787', CRX_PUBLIC_KEY: 'public-key' },
    ]
    for (const env of envs) {
      expect(manifest(env).permissions).toEqual(['sidePanel', 'storage', 'tabs', 'cookies', 'scripting'])
    }
  })

  it('asks for no optional permissions and injects no content scripts', () => {
    const json: Record<string, unknown> = manifest({ VITE_CLERK_SYNC_HOST: 'https://notion-copilot.kitfun.cc' })
    expect(Object.keys(json).sort()).toEqual(
      [
        'action',
        'background',
        'content_security_policy',
        'description',
        'host_permissions',
        'manifest_version',
        'name',
        'permissions',
        'version',
      ].sort(),
    )
  })

  it("covers Notion, Clerk, the sign-in page, and the sign-in page's parent domain", () => {
    expect(manifest({ VITE_CLERK_SYNC_HOST: 'https://notion-copilot.kitfun.cc' }).host_permissions).toEqual([
      ...NOTION,
      `https://${CLERK_HOST}/*`,
      'https://notion-copilot.kitfun.cc/*',
      'https://*.kitfun.cc/*',
    ])
  })

  it('covers CLERK_COOKIE_DOMAIN instead of guessing the parent domain', () => {
    const env = { VITE_CLERK_SYNC_HOST: 'https://app.example.co.uk' }
    // The guess is wrong for a suffix like co.uk, which is why the setting exists.
    expect(manifest(env).host_permissions.at(-1)).toBe('https://*.co.uk/*')
    for (const CLERK_COOKIE_DOMAIN of ['example.co.uk', '.example.co.uk']) {
      expect(manifest({ ...env, CLERK_COOKIE_DOMAIN }).host_permissions).toEqual([
        ...NOTION,
        `https://${CLERK_HOST}/*`,
        'https://app.example.co.uk/*',
        'https://*.example.co.uk/*',
      ])
    }
  })

  it('covers only the host itself for localhost', () => {
    expect(manifest({ VITE_CLERK_SYNC_HOST: 'http://localhost:8787' }).host_permissions).toEqual([
      ...NOTION,
      `https://${CLERK_HOST}/*`,
      'http://localhost:8787/*',
      'http://localhost/*',
    ])
  })

  it('covers only the host itself for an IP address', () => {
    expect(manifest({ VITE_CLERK_SYNC_HOST: 'http://127.0.0.1:8787' }).host_permissions).toEqual([
      ...NOTION,
      `https://${CLERK_HOST}/*`,
      'http://127.0.0.1:8787/*',
      'http://127.0.0.1/*',
    ])
    expect(manifest({ VITE_CLERK_SYNC_HOST: 'http://[::1]:8787' }).host_permissions).toEqual([
      ...NOTION,
      `https://${CLERK_HOST}/*`,
      'http://[::1]:8787/*',
      'http://[::1]/*',
    ])
  })

  it('leaves out the Clerk host when the publishable key names none', () => {
    expect(clerkFrontendApi('')).toBeUndefined()
    expect(
      manifest({ VITE_CLERK_SYNC_HOST: 'https://notion-copilot.kitfun.cc', VITE_CLERK_PUBLISHABLE_KEY: '' })
        .host_permissions,
    ).toEqual([...NOTION, 'https://notion-copilot.kitfun.cc/*', 'https://*.kitfun.cc/*'])
  })

  it('pins the extension ID with the public key, when one is set', () => {
    const env = { VITE_CLERK_SYNC_HOST: 'https://notion-copilot.kitfun.cc' }
    expect(manifest(env)).not.toHaveProperty('key')
    expect(manifest({ ...env, CRX_PUBLIC_KEY: 'public-key' })).toMatchObject({ key: 'public-key', version: '1.2.3' })
  })
})
