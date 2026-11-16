// Notico's manifest (extension/manifest.ts, with products/notico/manifest.ts). Chrome disables an installed extension on
// update when the new version adds a permission warning, so the permissions are pinned here: a
// change to them must change this file in the same pull request, where a reviewer sees it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildManifest, type ManifestEnv } from '../manifest'
import { MANIFEST } from '../products/notico/manifest'

const NOTION = ['https://www.notion.so/*', 'https://app.notion.com/*']
const CLERK_HOST = 'clerk.example.com'
/** A publishable key as Clerk builds it: the Frontend API host and a `$`, in base64 without padding. */
const PUBLISHABLE_KEY = `pk_live_${Buffer.from(`${CLERK_HOST}$`).toString('base64').replace(/=+$/, '')}`

function manifest(env: Partial<ManifestEnv> & Pick<ManifestEnv, 'VITE_CLERK_SYNC_HOST'>) {
  return buildManifest(MANIFEST, { VITE_CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY, ...env }, '1.2.3')
}

/** The committed build config of the hosted extension (extension/products/notico/.env), as `KEY=value` lines. */
function hostedEnv(): Record<string, string> {
  const text = readFileSync(new URL('../products/notico/.env', import.meta.url), 'utf8')
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => /^\w+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
  )
}

describe('extension manifest', () => {
  // What the published extension asks its users for. A change to extension/products/notico/.env that changes
  // these (another Clerk instance, another sign-in host) must change this test too.
  it('[@no-uc:privacy] ships with exactly these permissions and host permissions', () => {
    const env = hostedEnv()
    const json = buildManifest(MANIFEST, { ...env, VITE_CLERK_SYNC_HOST: env.VITE_CLERK_SYNC_HOST! }, '1.2.3')
    expect(json.permissions).toEqual([
      'sidePanel',
      'storage',
      'tabs',
      'cookies',
      'scripting',
      'contextMenus',
      'activeTab',
    ])
    expect(json.host_permissions).toEqual([
      'https://www.notion.so/*',
      'https://app.notion.com/*',
      'https://clerk.cofun.cc/*',
      'https://api.cofun.cc/*',
      'https://*.cofun.cc/*',
    ])
  })

  // Where the published extension's own pages may load from and send requests to: the hosts
  // PRIVACY.md lists, enforced by the browser. A change to extension/products/notico/.env or to the policy that
  // adds a host must change this test and PRIVACY.md in the same pull request.
  it('[@no-uc:privacy] ships with a content security policy that allows only these hosts', () => {
    const env = hostedEnv()
    const json = buildManifest(MANIFEST, { ...env, VITE_CLERK_SYNC_HOST: env.VITE_CLERK_SYNC_HOST! }, '1.2.3')
    expect(json.content_security_policy.extension_pages).toBe(
      "default-src 'self'; script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self' https://api.cofun.cc https://clerk.cofun.cc https://openrouter.ai " +
        'https://us.i.posthog.com; ' +
        "img-src 'self' data: blob: https://img.clerk.com",
    )
  })

  it('[@no-uc:privacy] allows requests only to the configured worker, Clerk host, OpenRouter, and PostHog host, whatever the env', () => {
    const csp = (env: Partial<ManifestEnv>) =>
      manifest({ VITE_CLERK_SYNC_HOST: 'https://app.example.com', ...env }).content_security_policy.extension_pages
    expect(csp({ VITE_API_URL: 'http://localhost:8787/v1' })).toContain(
      `connect-src 'self' http://localhost:8787 https://${CLERK_HOST} https://openrouter.ai;`,
    )
    // PostHog's host, for usage events, is the one the build is configured with: the origin alone.
    expect(csp({ VITE_API_URL: 'http://localhost:8787/v1', VITE_POSTHOG_HOST: 'https://eu.i.posthog.com/' })).toContain(
      `connect-src 'self' http://localhost:8787 https://${CLERK_HOST} https://openrouter.ai https://eu.i.posthog.com;`,
    )
    // Without a worker URL or a Clerk host, requests go only to OpenRouter, for a user's own model.
    expect(csp({ VITE_CLERK_PUBLISHABLE_KEY: '' })).toContain("connect-src 'self' https://openrouter.ai;")
  })

  it('[@no-uc:privacy] asks for exactly these permissions, whatever the env', () => {
    const envs: ManifestEnv[] = [
      { VITE_CLERK_SYNC_HOST: 'https://api.cofun.cc' },
      { VITE_CLERK_SYNC_HOST: 'https://app.example.co.uk', CLERK_COOKIE_DOMAIN: 'example.co.uk' },
      { VITE_CLERK_SYNC_HOST: 'http://localhost:8787', CRX_PUBLIC_KEY: 'public-key' },
    ]
    for (const env of envs) {
      expect(manifest(env).permissions).toEqual([
        'sidePanel',
        'storage',
        'tabs',
        'cookies',
        'scripting',
        'contextMenus',
        'activeTab',
      ])
    }
  })

  // Web sites are optional host permissions, granted one site at a time when the user allows it
  // (read_current_tab): installing or updating asks for none, so the update keeps the extension on.
  it('[@no-uc:privacy] asks for web sites only as optional host permissions, and injects no content scripts', () => {
    const json: Record<string, unknown> = manifest({ VITE_CLERK_SYNC_HOST: 'https://api.cofun.cc' })
    expect(json.optional_host_permissions).toEqual(['https://*/*', 'http://*/*'])
    expect(Object.keys(json).sort()).toEqual(
      [
        'action',
        'background',
        'content_security_policy',
        'description',
        'host_permissions',
        'icons',
        'manifest_version',
        'name',
        'optional_host_permissions',
        'permissions',
        'side_panel',
        'version',
        'version_name',
      ].sort(),
    )
  })

  it("[@no-uc:privacy] covers Notion, Clerk, the sign-in page, and the sign-in page's parent domain", () => {
    expect(manifest({ VITE_CLERK_SYNC_HOST: 'https://api.cofun.cc' }).host_permissions).toEqual([
      ...NOTION,
      `https://${CLERK_HOST}/*`,
      'https://api.cofun.cc/*',
      'https://*.cofun.cc/*',
    ])
  })

  it('[@no-uc:privacy] covers CLERK_COOKIE_DOMAIN instead of guessing the parent domain', () => {
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

  it('[@no-uc:privacy] covers only the host itself for localhost', () => {
    expect(manifest({ VITE_CLERK_SYNC_HOST: 'http://localhost:8787' }).host_permissions).toEqual([
      ...NOTION,
      `https://${CLERK_HOST}/*`,
      'http://localhost:8787/*',
      'http://localhost/*',
    ])
  })

  it('[@no-uc:privacy] covers only the host itself for an IP address', () => {
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

  it('[@no-uc:privacy] leaves out the Clerk host when the publishable key names none', () => {
    expect(
      manifest({ VITE_CLERK_SYNC_HOST: 'https://api.cofun.cc', VITE_CLERK_PUBLISHABLE_KEY: '' }).host_permissions,
    ).toEqual([...NOTION, 'https://api.cofun.cc/*', 'https://*.cofun.cc/*'])
  })

  it('[@no-uc:access] pins the extension ID with the public key, when one is set', () => {
    const env = { VITE_CLERK_SYNC_HOST: 'https://api.cofun.cc' }
    expect(manifest(env)).not.toHaveProperty('key')
    expect(manifest({ ...env, CRX_PUBLIC_KEY: 'public-key' })).toMatchObject({ key: 'public-key', version: '1.2.3' })
  })

  // The Chrome Web Store signs the item with its own key, which sets the ID, so the zip uploaded
  // there carries no `key`, and no `version_name`, which marks a development build. Everything
  // else is what local builds ship.
  it('[@no-uc:access] leaves out only the key and the development mark in the store build', () => {
    const env = hostedEnv()
    const hosted = { ...env, VITE_CLERK_SYNC_HOST: env.VITE_CLERK_SYNC_HOST! }
    expect(env.CRX_PUBLIC_KEY).toBeTruthy()
    const local = buildManifest(MANIFEST, hosted, '1.2.3')
    const store = buildManifest(MANIFEST, hosted, '1.2.3', { store: true })
    expect(local).toHaveProperty('key', env.CRX_PUBLIC_KEY)
    expect(local).toHaveProperty('version_name', '1.2.3 dev')
    expect(store).not.toHaveProperty('key')
    expect(store).not.toHaveProperty('version_name')
    const { key: _, version_name: __, ...rest } = local
    expect(store).toEqual(rest)
  })
})
