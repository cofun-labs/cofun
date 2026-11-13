import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { buildManifest } from './manifest.ts'

/**
 * Writes manifest.json into the build, filled from env. Two variables from the shell change it, for
 * the release workflow (.github/workflows/release.yml): EXTENSION_VERSION replaces package.json's
 * version, and CRX_STORE_BUILD=1 builds for the Chrome Web Store, without `key`.
 */
function manifest(env: Record<string, string>): Plugin {
  return {
    name: 'notion-copilot-manifest',
    generateBundle() {
      const json = buildManifest(
        { ...env, VITE_CLERK_SYNC_HOST: env.VITE_CLERK_SYNC_HOST },
        process.env.EXTENSION_VERSION || process.env.npm_package_version || '0.1.0',
        { store: process.env.CRX_STORE_BUILD === '1' },
      )
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(json, null, 2) })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '')
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
