// The start of a chat (UC-WEBCO-CHAT-001): the suggestions that fit the current tab, as a user meets
// them. The whole panel runs (see panel.ts); besides the screen, the tests look only at what the model
// was asked.
import '@testing-library/jest-dom/vitest'
import { act, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeTab } from './tab'
import { closeBrowser, FakeBrowser } from './browser'

afterEach(closeBrowser)

async function openOn(url: string, title: string) {
  const tab = new FakeTab(url)
  tab.title = title
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  await browser.openPanel()
  return browser
}

/** The suggestions shown, in order. */
const suggestions = () =>
  within(screen.getByRole('list', { name: 'Suggestions' }))
    .getAllByRole('button')
    .map((b) => b.textContent)

describe('the start of a chat', () => {
  it('[UC-WEBCO-CHAT-001-S05] on a YouTube video, the suggestions are about the video and its moments', async () => {
    const browser = await openOn('https://www.youtube.com/watch?v=aBcDeFgHiJk', 'How rivers carve valleys - YouTube')

    expect(await screen.findByText('What do you want to know about this video?')).toBeVisible()
    expect(screen.getByText("Webco can read this video's transcript and search the web.")).toBeVisible()
    expect(suggestions()).toEqual([
      'Summarize this video',
      'List its key moments with their times',
      'What does the video say about …',
      'Search the web for …',
    ])
    expect(browser.ai.calls).toEqual([])
  })

  it('[UC-WEBCO-CHAT-001-S05] the suggestions follow the tab: another page, then a tab Webco cannot read', async () => {
    const browser = await openOn('https://news.example.com/2026/rivers', 'Rivers | News')

    expect(await screen.findByText('What do you want to know about this page?')).toBeVisible()
    expect(suggestions()).toEqual([
      'Summarize this page',
      'What does this page say about …',
      'List its key points',
      'Search the web for …',
    ])

    act(() => browser.tab.navigate('chrome://settings', 'Settings'))

    expect(await screen.findByText('What are you looking for?')).toBeVisible()
    expect(suggestions()).toEqual(['Search the web for …'])
    expect(browser.ai.calls).toEqual([])
  })
})
