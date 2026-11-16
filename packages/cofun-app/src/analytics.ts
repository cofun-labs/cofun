import { z } from './zod'

/** A value the event may carry as it is, or `other`: what is not on the list is never sent. */
const oneOf = (known: readonly string[]) => z.string().transform((value) => (known.includes(value) ? value : 'other'))

/** Where a question's model runs. */
const Provider = z.enum(['hosted', 'openrouter'])
export function analyticsEvents(tools: readonly string[], errors: readonly string[]) {
  /** A tool by its name, as the extension defines it. The model may ask for a tool that does not exist: its name is not sent. */
  const ToolName = oneOf(tools)
  /** Why a tool failed: a Notion error's code. */
  const ToolError = oneOf(errors)
  /** Why a question failed: the worker's error code. */
  const QuestionError = oneOf([
    'out_of_credits',
    'credits_unavailable',
    'unsupported_model',
    'unauthorized',
    'provider_error',
    'rate_limited',
    'bad_request',
    'too_large',
    'not_configured',
    'internal',
  ])
  const Count = z.int().min(0).max(10_000)

  /**
   * Every event, with all it may carry. An event that does not fit is not sent. Each says only that
   * something happened, never its text: `reply_copied` not the reply, `chat_opened` not its title.
   */
  return z.discriminatedUnion('event', [
    z.strictObject({ event: z.literal('panel_opened') }),
    z.strictObject({ event: z.literal('sign_in_opened') }),
    /**
     * The device's usage was joined to an account: usually a sign-in, but also the first panel this
     * version opens for someone already signed in, and usage data turned on again by someone who signed
     * in while it was off. The panel reloads when a sign-in happens, so it never sees one as it happens.
     */
    z.strictObject({ event: z.literal('signed_in') }),
    /** `site_tab`: whether the current tab showed a page from the integrated site. */
    z.strictObject({ event: z.literal('question_asked'), provider: Provider, site_tab: z.boolean() }),
    /** `rounds`: the model calls the question took. `tool_calls`: the tool calls that ended, however they did. */
    z.strictObject({
      event: z.literal('question_ended'),
      provider: Provider,
      outcome: z.enum(['done', 'stopped', 'step_limit', 'error']),
      error_code: QuestionError.optional(),
      rounds: Count,
      tool_calls: Count,
    }),
    z.strictObject({
      event: z.literal('tool_called'),
      tool: ToolName,
      ok: z.boolean(),
      status: z.enum(['done', 'failed', 'skipped', 'stopped', 'declined']),
      error_code: ToolError.optional(),
    }),
    z.strictObject({ event: z.literal('model_switched'), provider: Provider }),
    z.strictObject({ event: z.literal('own_key_saved'), provider: z.enum(['openrouter']) }),
    z.strictObject({ event: z.literal('settings_opened') }),
    /** `pack`: the pack's quantity, in units of 1,000 credits. */
    z.strictObject({ event: z.literal('credits_buy_clicked'), pack: Count }),
    z.strictObject({ event: z.literal('credits_opened') }),
    z.strictObject({ event: z.literal('credits_history_opened') }),
    z.strictObject({ event: z.literal('chat_created') }),
    z.strictObject({ event: z.literal('chat_opened') }),
    z.strictObject({ event: z.literal('chat_deleted') }),
    /** `how`: with `@` in the message, or the "+" button. */
    z.strictObject({ event: z.literal('page_added'), how: z.enum(['mention', 'button']) }),
    z.strictObject({ event: z.literal('reply_stopped') }),
    z.strictObject({ event: z.literal('reply_copied') }),
  ])
}

export type AnalyticsEvent = z.input<ReturnType<typeof analyticsEvents>>
export interface Analytics {
  track: (event: AnalyticsEvent) => void
  identify: (userId: string | null) => void
  loadEnabled: () => Promise<boolean>
  saveEnabled: (enabled: boolean) => Promise<void>
}
