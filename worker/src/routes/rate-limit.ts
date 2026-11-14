// The default rate limit of /v1: how many requests one user can make a minute to every route there
// except the chat, which has a limit of its own (see chat.ts).
import type { MiddlewareHandler } from 'hono'
import { HttpError, type AppEnv } from '../http'

/**
 * Counts the request against the signed-in user's API_LIMIT, and refuses it once they are over.
 * Mounted on the /v1 sub-app after the session check and the chat (see app.ts), so it runs before
 * every other route there: a refused request reads no credits and reaches neither D1 nor Stripe.
 */
export const defaultRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { success } = await c.env.API_LIMIT.limit({ key: c.get('userId') })
  if (!success) throw new HttpError(429, 'rate_limited', 'Too many requests. Wait a minute, then try again.')
  await next()
}
