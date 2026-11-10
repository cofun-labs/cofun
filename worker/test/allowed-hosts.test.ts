// The hosts the extension may contact are listed in extension/allowed-hosts.json, and PRIVACY.md
// says what goes to each. This test fails when the hosted extension's manifest or its configured
// endpoints (extension/.env) name a host that is not on the list, or the list names one they no
// longer use: a change to where data goes must change the list, and PRIVACY.md, in the same pull
// request, where a reviewer sees it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildManifest, CLERK_IMAGE_HOST, clerkFrontendApi, type ManifestEnv } from '../../extension/manifest'
import { NOTION_HOSTS } from '../../extension/src/notion/hosts'
import { hostedEnv } from './hosted-env'

interface AllowedHosts {
  /** Hosts the extension sends requests to, each with what goes there. */
  requests: Record<string, string>
  /** Host permission patterns the extension holds without sending requests there. */
  permissionOnly: Record<string, string>
}

const allowed = JSON.parse(
  readFileSync(new URL('../../extension/allowed-hosts.json', import.meta.url), 'utf8'),
) as AllowedHosts
const REQUESTS = Object.keys(allowed.requests)
const PERMISSION_ONLY = Object.keys(allowed.permissionOnly)

/** Every host the extension built from `env` names: where it comes from, and the host. */
function namedHosts(env: ManifestEnv): { requests: [string, string][]; permissions: [string, string][] } {
  const manifest = buildManifest(env, '1.2.3')
  const csp = manifest.content_security_policy.extension_pages
  const cspHosts = csp
    .split(/[\s;]+/)
    .filter((source) => /^https?:\/\//.test(source))
    .map((source): [string, string] => ['content_security_policy', new URL(source).hostname])
  return {
    requests: [
      ...NOTION_HOSTS.map((host): [string, string] => ['NOTION_HOSTS', host]),
      ['VITE_API_URL', new URL(env.VITE_API_URL!).hostname],
      ['VITE_CLERK_SYNC_HOST', new URL(env.VITE_CLERK_SYNC_HOST).hostname],
      ['VITE_CLERK_PUBLISHABLE_KEY', clerkFrontendApi(env.VITE_CLERK_PUBLISHABLE_KEY ?? '') ?? ''],
      ['CLERK_IMAGE_HOST', CLERK_IMAGE_HOST],
      ...cspHosts,
    ],
    // A match pattern is `scheme://host/path`; the host may start with `*.`.
    permissions: manifest.host_permissions.map((pattern): [string, string] => [
      'host_permissions',
      pattern.replace(/^[a-z*]+:\/\//, '').replace(/\/.*$/, ''),
    ]),
  }
}

/** The named hosts that are not on the list, as `source: host`. */
function offList(env: ManifestEnv): string[] {
  const { requests, permissions } = namedHosts(env)
  return [
    ...requests.filter(([, host]) => !REQUESTS.includes(host)),
    ...permissions.filter(([, host]) => !REQUESTS.includes(host) && !PERMISSION_ONLY.includes(host)),
  ].map(([source, host]) => `${source}: ${host}`)
}

function hosted(): ManifestEnv {
  const env = hostedEnv()
  return { ...env, VITE_CLERK_SYNC_HOST: env.VITE_CLERK_SYNC_HOST! }
}

describe('allowed hosts', () => {
  it('the hosted extension names no host that is not on the list', () => {
    expect(offList(hosted())).toEqual([])
  })

  it('the list names no host the hosted extension does not use', () => {
    const { requests, permissions } = namedHosts(hosted())
    const used = new Set([...requests, ...permissions].map(([, host]) => host))
    expect([...REQUESTS, ...PERMISSION_ONLY].filter((host) => !used.has(host))).toEqual([])
    // A wildcard permission is never a host requests go to.
    expect(REQUESTS.filter((host) => host.includes('*'))).toEqual([])
  })

  it('reports each host a changed config would add', () => {
    const key = `pk_live_${Buffer.from('clerk.example.com$').toString('base64')}`
    expect(
      offList({
        VITE_CLERK_PUBLISHABLE_KEY: key,
        VITE_CLERK_SYNC_HOST: 'https://app.example.com',
        VITE_API_URL: 'https://api.example.com/v1',
      }),
    ).toEqual([
      'VITE_API_URL: api.example.com',
      'VITE_CLERK_SYNC_HOST: app.example.com',
      'VITE_CLERK_PUBLISHABLE_KEY: clerk.example.com',
      'content_security_policy: api.example.com',
      'content_security_policy: clerk.example.com',
      'host_permissions: clerk.example.com',
      'host_permissions: app.example.com',
      'host_permissions: *.example.com',
    ])
  })

  it('limits the extension pages to the listed hosts', () => {
    expect(buildManifest(hosted(), '1.2.3').content_security_policy.extension_pages).toBe(
      "script-src 'self'; object-src 'self'; " +
        "connect-src 'self' https://notion-copilot.kitfun.cc https://saving-yeti-9519.clerk.accounts.dev; " +
        "img-src 'self' data: blob: https://img.clerk.com",
    )
  })
})
