import '@testing-library/jest-dom/vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { closeBrowser, FakeBrowser, SITE } from './panel'

afterEach(closeBrowser)

const published = {
  id: '42',
  type: 'page',
  status: 'current',
  title: 'Fixture page',
  space: { key: 'TEST' },
  ancestors: [],
}
const sourceUrl = `${SITE}/pages/viewpage.action?pageId=42`
const original = '<p>Release pending</p><p>Keep this paragraph</p>'
const edited = '<p>Release ready</p><p>Keep this paragraph</p>'
const editCommand = 'Replace "Release pending" with "Release ready" on this page'

async function panel() {
  const browser = await FakeBrowser.start()
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

async function connected() {
  const { browser, user } = await panel()
  await browser.signIn()
  await user.click(screen.getByRole('button', { name: 'Connect Confluence' }))
  await user.type(await screen.findByLabelText('Confluence base URL'), SITE)
  await user.click(screen.getByRole('button', { name: /^Connect$/ }))
  expect(await screen.findByText(`Connected to ${SITE}`)).toBeVisible()
  expect(browser.requestedOrigins).toEqual(['https://wiki.example.test:443/*'])
  await user.click(screen.getByRole('button', { name: 'Done' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect Confluence' })).toHaveFocus())
  return { browser, user }
}

async function ask(user: UserEvent, message: string) {
  await user.click(screen.getByRole('textbox', { name: 'Message' }))
  await user.paste(message)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

function usePage(browser: FakeBrowser) {
  let version = 2
  let value = original
  browser.confluenceResponse = (url, init) => {
    expect(new URL(url).pathname).toBe('/kb/rest/api/content/42')
    if (init?.method === 'PUT') {
      expect(init.body).toBe(
        JSON.stringify({
          type: 'page',
          title: published.title,
          version: { number: 3 },
          body: { storage: { value: edited, representation: 'storage' } },
        }),
      )
      version = 3
      value = edited
    }
    return Response.json({
      ...published,
      version: { number: version },
      body: { view: { value }, storage: { value, representation: 'storage' } },
    })
  }
  return () => {
    version++
  }
}

const writes = (browser: FakeBrowser) => browser.workspaceRequests.filter(({ init }) => init?.method === 'PUT')

it('[UC-CONFLUCO-AUTH-001-S01] opens Cofun sign-in and chats with the resulting session', async () => {
  const { browser, user } = await panel()
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(browser.openedTabs).toEqual(['https://copilot.test/login'])
  expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
  await browser.signIn()
  browser.ai.script.push({ reply: 'Signed in and ready.' })
  await ask(user, 'Say you are ready')
  expect(await screen.findByText('Signed in and ready.')).toBeVisible()
})

it('[UC-CONFLUCO-CONFLUENCE-001-S01] reads the published page in a connected tab', async () => {
  const { browser, user } = await connected()
  usePage(browser)
  browser.ai.script.push({ toolCalls: [{ name: 'read_page', arguments: '{}' }] }, { reply: 'I read the release note.' })
  await ask(user, 'Read the current page')
  expect(await screen.findByText('I read the release note.')).toBeVisible()
  const prompt = JSON.stringify(browser.ai.calls.at(-1)?.inputs.messages)
  expect(prompt).toContain('Release pending')
  expect(prompt).toContain(sourceUrl)
})

it('[UC-CONFLUCO-CONFLUENCE-002-S01] searches published pages within the connected instance', async () => {
  const { browser, user } = await connected()
  browser.confluenceResponse = (url) => {
    const endpoint = new URL(url)
    expect(endpoint.pathname).toBe('/kb/rest/api/search')
    expect(endpoint.searchParams.get('cql')).toBe('type = page AND title ~ "roadmap"')
    return Response.json({
      results: [{ content: { ...published, title: 'Roadmap fixture' }, excerpt: 'Next milestone' }],
      _links: {},
    })
  }
  browser.ai.script.push(
    { toolCalls: [{ name: 'search_pages', arguments: '{"query":"roadmap","field":"title"}' }] },
    { reply: 'Found the matching page.' },
  )
  await ask(user, 'Search for a page titled roadmap')
  expect(await screen.findByText('Found the matching page.')).toBeVisible()
  const prompt = JSON.stringify(browser.ai.calls.at(-1)?.inputs.messages)
  expect(prompt).toContain('Roadmap fixture')
  expect(prompt).toContain(sourceUrl)
})

async function checkEdit(action: 'Allow' | 'Deny', count: number) {
  const { browser, user } = await connected()
  usePage(browser)
  browser.ai.script.push({ toolCalls: [{ name: 'edit_page', arguments: '{}' }] }, { reply: 'Edit request handled.' })
  await ask(user, editCommand)
  const confirmation = await screen.findByRole('group', { name: 'Confirm Confluence edit' })
  expect(screen.getByText(/Before: "Release pending"\s+After: "Release ready"/)).toBeVisible()
  expect(writes(browser)).toHaveLength(0)
  await user.click(within(confirmation).getByRole('button', { name: action }))
  expect(await screen.findByText('Edit request handled.')).toBeVisible()
  expect(writes(browser)).toHaveLength(count)
  if (count) {
    expect(browser.workspaceRequests.at(-1)?.init?.method).toBe('GET')
    expect(JSON.stringify(browser.ai.calls.at(-1)?.inputs.messages)).toContain('bodyVerified')
  }
}

it('[UC-CONFLUCO-CONFLUENCE-003-S01] applies one edit after Allow', () => checkEdit('Allow', 1))

it('[UC-CONFLUCO-CONFLUENCE-003-S02] leaves the page unchanged after Deny', () => checkEdit('Deny', 0))

it('[UC-CONFLUCO-CONFLUENCE-003-S03] refuses to apply a preview of an older page revision', async () => {
  const { browser, user } = await connected()
  const advanceVersion = usePage(browser)
  browser.ai.script.push({ toolCalls: [{ name: 'edit_page', arguments: '{}' }] })
  await ask(user, editCommand)
  const confirmation = await screen.findByRole('group', { name: 'Confirm Confluence edit' })
  advanceVersion()
  await user.click(within(confirmation).getByRole('button', { name: 'Allow' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('The Confluence page changed after the preview.')
  expect(writes(browser)).toHaveLength(0)
})
