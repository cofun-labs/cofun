import { buildManifest as composeManifest, type ManifestEnv } from '@cofun/app/manifest'

export type { ManifestEnv } from '@cofun/app/manifest'

export function buildManifest(env: ManifestEnv, version: string, options?: { store?: boolean }) {
  return composeManifest(
    {
      name: 'Notico: AI copilot for Notion',
      description:
        'AI copilot for Notion: summarize and edit pages, update databases, search and organize your workspace. No subscription needed.',
      hosts: ['https://www.notion.so/*', 'https://app.notion.com/*'],
    },
    env,
    version,
    options,
  )
}
