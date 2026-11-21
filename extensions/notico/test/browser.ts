// The browser Notico's side panel UI tests run in: the shared one (@cofun/panel-test), with Notico
// installed on a fake Notion tab.
import { fileURLToPath } from 'node:url'
import { FakeBrowser as SharedBrowser, type TestedExtension } from '@cofun/panel-test'
import { isNotion } from '../src/notion/hosts'
import type { FakeNotionTab } from './notion-tab'

export { closeBrowser, START } from '@cofun/panel-test'

const notico: TestedExtension = {
  sidePanel: fileURLToPath(import.meta.resolve('../sidepanel.html')),
  background: () => import('../src/background'),
  // The required host permissions a build has (manifest.ts): Notion, and the hosts sign-in uses.
  hostPermissions: [
    'https://www.notion.so/*',
    'https://app.notion.com/*',
    'https://clerk.cofun.cc/*',
    'https://api.cofun.cc/*',
    'https://*.cofun.cc/*',
  ],
  // A Notion page opens in a tab of its own, which the panel goes on to use.
  opensTab: isNotion,
}

export type FakeBrowser = SharedBrowser<FakeNotionTab>
export const FakeBrowser = {
  /** Starts a browser with Notico installed on `tab`, signed in as `signedInAs` or signed out. */
  start: (tab: FakeNotionTab, options?: { signedInAs?: string }): Promise<FakeBrowser> =>
    SharedBrowser.start(notico, tab, options),
}
