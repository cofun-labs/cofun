import { buildManifest as composeManifest, type ManifestEnv } from '@cofun/app/manifest'

export function buildManifest(env: ManifestEnv, version: string, options?: { store?: boolean }) {
  return composeManifest(
    {
      name: 'Cofun: AI browser copilot',
      description: 'Ask about your open tabs, read public pages, and search the web in your browser side panel.',
    },
    env,
    version,
    options,
  )
}
