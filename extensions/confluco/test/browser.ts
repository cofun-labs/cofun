// The browser Confluco's side panel UI tests run in: the shared one (@cofun/panel-test), with
// Confluco installed on a fake browser tab.
import { fileURLToPath } from 'node:url'
import { FakeBrowser as SharedBrowser, type TestedExtension } from '@cofun/panel-test'
import type { FakeTab } from './tab'

export { closeBrowser, START } from '@cofun/panel-test'

const confluco: TestedExtension = {
  sidePanel: fileURLToPath(import.meta.resolve('../sidepanel.html')),
  background: () => import('../src/background'),
  // The required host permissions a build has (manifest.ts): the hosts sign-in uses.
  hostPermissions: ['https://*.cofun.cc/*', 'https://clerk.cofun.cc/*'],
}

export type FakeBrowser = SharedBrowser<FakeTab>
export const FakeBrowser = {
  /** Starts a browser with Confluco installed on `tab`, signed in as `signedInAs` or signed out. */
  start: (tab: FakeTab, options?: { signedInAs?: string }): Promise<FakeBrowser> =>
    SharedBrowser.start(confluco, tab, options),
}
