// Runs the extension's real client code (extension/src/llm.ts) against the worker,
// so the two sides can't drift apart.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { streamChat } from '../../extension/src/llm'
import { createApp, type Env } from '../src/app'
import { FakeClerk } from './clerk'
import { FakeAiBinding, FakeQuotaNamespace, FakeUsageDataset } from './fakes'
import type { AiBinding } from '../src/app'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const app = createApp()
let clerk: FakeClerk
let env: Env
let ai: FakeAiBinding
let usage: FakeUsageDataset

beforeAll(async () => {
  clerk = await FakeClerk.create()
  env = {
    AI: (ai = new FakeAiBinding('你好 来自 worker')),
    QUOTA: new FakeQuotaNamespace(),
    USAGE: (usage = new FakeUsageDataset()),
    DAILY_REQUEST_LIMIT: '100',
    MODEL: '@cf/test/model',
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: EXT,
  }
  // The extension calls fetch(); route it into the worker app.
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    app.request(new URL(url).pathname, init, env)) as typeof fetch
})

afterEach(() => {
  ai.rawSse = undefined
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

  it('[UC-CHAT-001-S04] extension shows when the daily quota resets', async () => {
    const token = await clerk.sessionToken({ userId: 'user_carol', azp: EXT })
    env.DAILY_REQUEST_LIMIT = '1'
    try {
      await streamChat(
        config(async () => token),
        hi,
        () => {},
      )
      await expect(
        streamChat(
          config(async () => token),
          hi,
          () => {},
        ),
      ).rejects.toThrow('The quota resets at 00:00 UTC.')
    } finally {
      env.DAILY_REQUEST_LIMIT = '100'
    }
  })

  it('extension reads the last event when the stream ends without a newline', async () => {
    const token = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
    const chunk = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}`
    ai.rawSse = `${chunk('a')}\n\n${chunk('b')}`
    expect(
      await streamChat(
        config(async () => token),
        hi,
        () => {},
      ),
    ).toBe('ab')
  })

  it('extension surfaces an error event in the stream', async () => {
    const token = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
    ai.rawSse = `data: ${JSON.stringify({ error: { message: 'model overloaded' } })}\n\n`
    await expect(
      streamChat(
        config(async () => token),
        hi,
        () => {},
      ),
    ).rejects.toThrow('model overloaded')
  })

  it('a stream error the extension stops at is recorded as provider_error', async () => {
    const token = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
    // The model reports an error and keeps the stream open, so only the client's cancel ends it.
    const openStream: AiBinding = {
      async run() {
        const event = `data: ${JSON.stringify({ error: { message: 'model overloaded' } })}\n\n`
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(event))
          },
        })
      },
    }
    env.AI = openStream
    usage.points = []
    try {
      await expect(
        streamChat(
          config(async () => token),
          hi,
          () => {},
        ),
      ).rejects.toThrow('model overloaded')
    } finally {
      env.AI = ai
    }
    expect(usage.points.map((p) => p.blobs?.[1])).toEqual(['provider_error'])
  })

  it('extension rejects a successful response that is not a stream', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch
    try {
      await expect(
        streamChat(
          config(async () => 'token'),
          hi,
          () => {},
        ),
      ).rejects.toThrow('Unexpected response')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
