// Notico's usage events: which features are used and how they end, sent to PostHog from the side
// panel by @cofun/analytics, which sends nothing else and nothing the SDK would add by itself. The
// rest of the extension calls `track` with one of the events below; every property is an enum, a
// number, or a boolean, so a message, a reply, a page's title, a URL, or a key has no field to travel
// in. A new event or property is also listed in PRIVACY.md.
import { createAnalytics, oneOf } from '@cofun/analytics'
import { NOTION_ERROR_CODES } from './notion/api'
import { TOOLS } from './tools'
import { z } from './zod'

/** Where a question's model runs. */
const Provider = z.enum(['hosted', 'openrouter'])
/** A tool by its name, as the extension defines it. The model may ask for a tool that does not exist: its name is not sent. */
const ToolName = oneOf(TOOLS.map((tool) => tool.name))
/** Why a tool failed: a Notion error's code. */
const ToolError = oneOf(NOTION_ERROR_CODES)
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

export const { track, identify, loadAnalyticsEnabled, saveAnalyticsEnabled } = createAnalytics({
  product: 'notico',
  key: import.meta.env.VITE_POSTHOG_KEY,
  host: import.meta.env.VITE_POSTHOG_HOST,
  events: {
    panel_opened: {},
    sign_in_opened: {},
    /** `notion_tab`: whether the current tab showed a Notion page. */
    question_asked: { provider: Provider, notion_tab: z.boolean() },
    /** `rounds`: the model calls the question took. `tool_calls`: the tool calls that ended, however they did. */
    question_ended: {
      provider: Provider,
      outcome: z.enum(['done', 'stopped', 'step_limit', 'error']),
      error_code: QuestionError.optional(),
      rounds: Count,
      tool_calls: Count,
    },
    tool_called: {
      tool: ToolName,
      ok: z.boolean(),
      status: z.enum(['done', 'failed', 'skipped', 'stopped', 'declined']),
      error_code: ToolError.optional(),
    },
    model_switched: { provider: Provider },
    own_key_saved: { provider: z.enum(['openrouter']) },
    settings_opened: {},
    /** `pack`: the pack's quantity, in units of 1,000 credits. */
    credits_buy_clicked: { pack: Count },
    credits_opened: {},
    credits_history_opened: {},
    chat_created: {},
    chat_opened: {},
    chat_deleted: {},
    /** `how`: with `@` in the message, or the "+" button. */
    page_added: { how: z.enum(['mention', 'button']) },
    reply_stopped: {},
    reply_copied: {},
    /** The user undid a question's changes from its reply: `refused` when something changed since, and nothing was undone. */
    question_undone: { outcome: z.enum(['done', 'refused', 'failed']) },
  },
})
