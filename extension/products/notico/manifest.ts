// What makes Notico's manifest its own (see buildManifest in extension/manifest.ts).
import type { ProductManifest } from '../../manifest'

export const MANIFEST: ProductManifest = {
  name: 'Notico: AI copilot for Notion',
  description:
    'AI copilot for Notion: summarize and edit pages, update databases, search and organize your workspace. No subscription needed.',
  actionTitle: 'Open Notico',
  // Notion's two hosts: its calls run in the user's Notion tab, with that tab's session.
  siteHosts: ['https://www.notion.so/*', 'https://app.notion.com/*'],
}
