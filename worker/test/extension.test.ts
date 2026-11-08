// Runs the extension's real client code (extension/src/llm.ts) against the worker,
// so the two sides can't drift apart.
import { beforeAll, describe, expect, it } from 'vitest'
import { streamChat } from '../../extension/src/llm'
import { createApp, type Env } from '../src/app'
import { FakeClerk } from './clerk'
import { FakeAiBinding } from './fakes'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const app = createApp()
let clerk: FakeClerk
let env: Env

beforeAll(async () => {
  clerk = await FakeClerk.create()
  env = {
    AI: new FakeAiBinding('你好 来自 worker'),
    MODEL: '@cf/test/model',
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: EXT,
  }
  // The extension calls fetch(); route it into the worker app.
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    app.request(new URL(url).pathname, init, env)) as typeof fetch
})

const config = (getToken: () => Promise<string | null>) => ({ apiUrl: 'https://nk.example.dev/v1/', getToken })
const hi = [{ role: 'user' as const, content: 'hi' }]

describe('extension client against the worker', () => {
  it('[UC-CHAT-001-S01] extension client streams the reply', async () => {
    const token = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
    const deltas: string[] = []
    const full = await streamChat(
      config(async () => token),
      hi,
      (d) => deltas.push(d),
    )
    expect(full).toBe('你好 来自 worker ')
    expect(deltas).toHaveLength(3)
  })

  it('extension asks to sign in when there is no session', async () => {
    await expect(
      streamChat(
        config(async () => null),
        hi,
        () => {},
      ),
    ).rejects.toThrow('Please sign in first.')
  })

  it('extension shows the server reason for a rejected session', async () => {
    await expect(
      streamChat(
        config(async () => 'not-a-jwt'),
        hi,
        () => {},
      ),
    ).rejects.toThrow('invalid or expired session')
  })
})
