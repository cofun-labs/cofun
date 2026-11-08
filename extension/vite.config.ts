import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/** Clerk's Frontend API host is encoded in the publishable key: pk_test_<base64("host$")>. */
function clerkFrontendApi(publishableKey: string): string | undefined {
  const encoded = publishableKey.split('_')[2]
  if (!encoded) return undefined
  return Buffer.from(encoded, 'base64').toString('utf8').replace(/\$$/, '')
}

/** Writes manifest.json into the build, filled from env. */
function manifest(env: Record<string, string>): Plugin {
  return {
    name: 'notion-kit-manifest',
    generateBundle() {
      const clerkHost = clerkFrontendApi(env.VITE_CLERK_PUBLISHABLE_KEY ?? '')
      const json = {
        manifest_version: 3,
        name: 'Notion Kit',
        version: process.env.npm_package_version ?? '0.1.0',
        description: 'A side panel AI helper for Notion pages.',
        ...(env.CRX_PUBLIC_KEY ? { key: env.CRX_PUBLIC_KEY } : {}),
        permissions: ['sidePanel', 'storage', 'tabs', 'cookies'],
        host_permissions: [
          'https://www.notion.so/*',
          'https://app.notion.com/*',
          ...(clerkHost ? [`https://${clerkHost}/*`] : []),
        ],
        background: { service_worker: 'background.js', type: 'module' },
        side_panel: { default_path: 'sidepanel.html' },
        action: { default_title: 'Open Notion Kit' },
      }
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(json, null, 2) })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const name of ['VITE_CLERK_PUBLISHABLE_KEY', 'VITE_API_URL']) {
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
