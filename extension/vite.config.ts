import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/** Clerk's Frontend API host is encoded in the publishable key: pk_test_<base64("host$")>. */
function clerkFrontendApi(publishableKey: string): string | undefined {
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
function clerkCookiePermission(syncHost: string, cookieDomain?: string): string {
  const { protocol, hostname } = new URL(syncHost)
  const labels = hostname.split('.')
  if (cookieDomain) return `${protocol}//*.${cookieDomain.replace(/^\./, '')}/*`
  if (labels.length < 2 || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return `${protocol}//${hostname}/*`
  return `${protocol}//*.${labels.slice(-2).join('.')}/*`
}

/** Writes manifest.json into the build, filled from env. */
function manifest(env: Record<string, string>): Plugin {
  return {
    name: 'notion-copilot-manifest',
    generateBundle() {
      const clerkHost = clerkFrontendApi(env.VITE_CLERK_PUBLISHABLE_KEY ?? '')
      const json = {
        manifest_version: 3,
        name: 'Copilot for Notion',
        version: process.env.npm_package_version ?? '0.1.0',
        description: 'A side panel AI helper for Notion pages.',
        ...(env.CRX_PUBLIC_KEY ? { key: env.CRX_PUBLIC_KEY } : {}),
        permissions: ['sidePanel', 'storage', 'tabs', 'cookies'],
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
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(json, null, 2) })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const name of ['VITE_CLERK_PUBLISHABLE_KEY', 'VITE_CLERK_SYNC_HOST', 'VITE_API_URL']) {
    if (!env[name]) throw new Error(`${name} is not set. Put it in .env.local.`)
  }

  return {
    plugins: [react(), manifest(env)],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // Readable output makes Chrome Web Store review easier.
      minify: false,
      rollupOptions: {
        input: { sidepanel: 'sidepanel.html', background: 'src/background.ts' },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        },
      },
    },
  }
})
