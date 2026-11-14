// The user's own model, on the service they chose, and the settings page's check of it.
import { normalizeContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { OwnSetup } from '../models'
import { deepSeekProvider } from './deepseek'
import { openRouterProvider } from './openrouter'
import type { ModelProvider } from './provider'

/** The provider for the user's own model on the service they chose. */
export const ownProvider = (setup: OwnSetup): ModelProvider =>
  setup.service === 'openrouter' ? openRouterProvider(setup) : deepSeekProvider(setup)

const CHECK_TIMEOUT_MS = 30_000

/** How a check of a key and model went. */
export type ModelCheck = { status: 'ok' } | { status: 'no_tools' } | { status: 'failed'; message: string }

/**
 * Asks the model one short question with one tool, as the settings page's check: whether the key
 * and the model work, and whether the model calls the tool. Costs the user a tiny request.
 */
export async function checkModel(setup: OwnSetup): Promise<ModelCheck> {
  const provider = ownProvider(setup)
  const context = normalizeContext({
    systemPrompt: 'Use the tool to answer.',
    messages: [{ role: 'user', content: 'What time is it? Use the tool.', timestamp: Date.now() }],
    tools: [
      {
        name: 'get_time',
        description: 'Get the current time.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  })
  const stream = streamSimple(await provider.loadModel(), context, {
    apiKey: await provider.apiKey(),
    identity: provider.identity,
    // A stalled model must not leave the check waiting forever.
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
  for await (const _event of stream);
  const reply = await stream.result()
  if (reply.stopReason === 'aborted') return { status: 'failed', message: `${provider.name} did not answer in time.` }
  if (reply.stopReason === 'error') return { status: 'failed', message: provider.parseError(reply.errorMessage).text }
  return reply.content.some((block) => block.type === 'toolCall') ? { status: 'ok' } : { status: 'no_tools' }
}
