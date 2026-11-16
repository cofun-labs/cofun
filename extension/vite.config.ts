import { existsSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { buildManifest, type ProductManifest } from './manifest.ts'

/**
 * Writes manifest.json into the build, from the product's own manifest config and its env. Two
 * variables from the shell change it, for the release workflow (.github/workflows/release.yml):
 * EXTENSION_VERSION replaces package.json's version, and CRX_STORE_BUILD=1 builds for the Chrome Web
 * Store, without `key` and `version_name`. package.json's version is a development one, 0.0.1, below
 * every released version, so a local build is never taken for one from the store.
 */
function manifest(product: ProductManifest, env: Record<string, string>): Plugin {
  return {
    name: 'cofun-manifest',
    generateBundle() {
      const json = buildManifest(
        product,
        { ...env, VITE_CLERK_SYNC_HOST: env.VITE_CLERK_SYNC_HOST },
        process.env.EXTENSION_VERSION || process.env.npm_package_version || '0.0.1',
        { store: process.env.CRX_STORE_BUILD === '1' },
      )
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(json, null, 2) })
    },
  }
}

/**
 * The product to build: PRODUCT names its folder in products/, Notico's by default. Its own files are
 * its entries (sidepanel.html and the script it runs, and background.ts, the service worker), its
 * manifest config (manifest.ts), its build config (.env, and .env.local over it), and the icons it
 * publishes (public/). The build goes to dist/<product>/.
 */
const PRODUCT = process.env.PRODUCT || 'notico'

export default defineConfig(async ({ mode }) => {
  const folder = `${import.meta.dirname}/products/${PRODUCT}`
  if (!/^[a-z][a-z0-9-]*$/.test(PRODUCT) || !existsSync(`${folder}/manifest.ts`))
    throw new Error(`PRODUCT=${PRODUCT} names no product: it must be a folder in extension/products/.`)
  const { MANIFEST } = (await import(`${folder}/manifest.ts`)) as { MANIFEST: ProductManifest }
  const env = loadEnv(mode, folder, '')
  for (const name of ['VITE_CLERK_PUBLISHABLE_KEY', 'VITE_CLERK_SYNC_HOST', 'VITE_API_URL']) {
    if (!env[name]) throw new Error(`${name} is not set. Put it in products/${PRODUCT}/.env.local.`)
  }

  // Usage events (src/analytics.ts) are sent by the build that goes to the Chrome Web Store only: any
  // other build, such as a development or e2e one, gets no PostHog key, so it sends nothing and its
  // use is not counted with real users'. POSTHOG_IN_DEV=1 keeps the key, to try the events locally.
  const sendsUsage = process.env.CRX_STORE_BUILD === '1' || process.env.POSTHOG_IN_DEV === '1'

  return {
    // The product's folder is the root, so its page is built to the top of the build: sidepanel.html.
    root: folder,
    plugins: [react(), manifest(MANIFEST, env)],
    envDir: folder,
    publicDir: `${folder}/public`,
    define: {
      'import.meta.env.VITE_POSTHOG_KEY': JSON.stringify(sendsUsage ? (env.VITE_POSTHOG_KEY ?? '') : ''),
    },
    build: {
      outDir: `${import.meta.dirname}/dist/${PRODUCT}`,
      emptyOutDir: true,
      // Readable output makes Chrome Web Store review easier.
      minify: false,
      rollupOptions: {
        input: { sidepanel: `${folder}/sidepanel.html`, background: `${folder}/background.ts` },
        output: {
          entryFileNames: (chunk: { name: string }) =>
            chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        },
      },
    },
  }
})
