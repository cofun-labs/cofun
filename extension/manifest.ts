// Builds the extension's manifest.json from env values. vite.config.ts writes the result into the
// build, and test/manifest.test.ts pins its permissions: Chrome disables an installed extension
// on update when the new version adds a permission warning, so a permission must never
// change unnoticed.

/** The env values the manifest is built from (see .env). */
export interface ManifestEnv {
  VITE_CLERK_PUBLISHABLE_KEY?: string
  VITE_CLERK_SYNC_HOST: string
  CLERK_COOKIE_DOMAIN?: string
  CRX_PUBLIC_KEY?: string
}

/** Clerk's Frontend API host is encoded in the publishable key: pk_test_<base64("host$")>. */
export function clerkFrontendApi(publishableKey: string): string | undefined {
  const encoded = publishableKey.split('_')[2]
  if (!encoded) return undefined
  return Buffer.from(encoded, 'base64').toString('utf8').replace(/\$$/, '')
}

/**
 * Host permission covering the domain Clerk sets __client_uat on: the sign-in
 * page's registrable domain (e.g. notion-copilot.kitfun.cc -> *.kitfun.cc).
 * The last two labels are a guess that fits hosts like example.com; set
 * CLERK_COOKIE_DOMAIN for suffixes such as example.co.uk. IPs and single-label
 * hosts (localhost) get a permission for the host itself.
 */
export function clerkCookiePermission(syncHost: string, cookieDomain?: string): string {
  const { protocol, hostname } = new URL(syncHost)
  const labels = hostname.split('.')
  if (cookieDomain) return `${protocol}//*.${cookieDomain.replace(/^\./, '')}/*`
  if (labels.length < 2 || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return `${protocol}//${hostname}/*`
  return `${protocol}//*.${labels.slice(-2).join('.')}/*`
}

/** The manifest for the given env and package version. */
export function buildManifest(env: ManifestEnv, version: string) {
  const clerkHost = clerkFrontendApi(env.VITE_CLERK_PUBLISHABLE_KEY ?? '')
  return {
    manifest_version: 3,
    name: 'Copilot for Notion',
    version,
    description: 'A side panel AI helper for Notion pages.',
    ...(env.CRX_PUBLIC_KEY ? { key: env.CRX_PUBLIC_KEY } : {}),
    // scripting: Notion calls run in the user's Notion tab (src/notion/tab.ts).
    // tabs: background.ts and src/notion/tab.ts read tab URLs to tell Notion tabs from others. Host
    // permissions would expose a Notion tab's URL too, but not once the user limits the extension's
    // site access; with tabs the panel still opens there and says which access is missing.
    permissions: ['sidePanel', 'storage', 'tabs', 'cookies', 'scripting'],
    host_permissions: [
      'https://www.notion.so/*',
      'https://app.notion.com/*',
      ...(clerkHost ? [`https://${clerkHost}/*`] : []),
      // Sign-in page; the cookies permission reads its Clerk session (Sync Host).
      `${new URL(env.VITE_CLERK_SYNC_HOST).origin}/*`,
      // Clerk sets __client_uat on the parent domain (e.g. .kitfun.cc). The side
      // panel watches it to notice sign-in and sign-out, and Chrome only reports
      // cookies whose domain the extension has host permission for.
      clerkCookiePermission(env.VITE_CLERK_SYNC_HOST, env.CLERK_COOKIE_DOMAIN),
    ],
    background: { service_worker: 'background.js', type: 'module' },
    // No side_panel.default_path: without it, a tab has no panel unless background.ts
    // sets one, so the panel stays off on other sites even before background.ts runs.
    action: { default_title: 'Open Copilot for Notion' },
  }
}
