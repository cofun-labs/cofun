// Clerk session auth for /v1/*: every request there carries a session token the worker verifies itself.
import { verifyToken } from '@clerk/backend'
import type { MiddlewareHandler } from 'hono'
import { HttpError, type AppEnv } from '../http'

/**
 * Checks the request's Clerk session token, and sets the user it is for (`userId`), the origin it
 * was issued to (`azp`, when it names one), and its claims.
 * The first handler of the /v1 sub-app (see app.ts), so it runs before every route under /v1.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const jwtKey = c.env.CLERK_JWT_KEY
  if (!jwtKey) throw new HttpError(503, 'not_configured', 'CLERK_JWT_KEY is not set')

  const header = c.req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) throw new HttpError(401, 'unauthorized', 'sign in first')

  const authorizedParties = (c.env.CLERK_AUTHORIZED_PARTIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!authorizedParties.length) throw new HttpError(503, 'not_configured', 'CLERK_AUTHORIZED_PARTIES is not set')
  let claims: Awaited<ReturnType<typeof verifyToken>>
  try {
    claims = await verifyToken(token, { jwtKey })
  } catch {
    throw new HttpError(401, 'unauthorized', 'invalid or expired session')
  }
  // Clerk sets azp to the origin that requested the token: chrome-extension://<id> for an
  // extension, this worker's origin for the admin page. A token that names an origin must name an
  // allowed one. One that names none is let through: Clerk hands a side panel that just loaded such
  // a token (the session's last active token, from /v1/client) and keeps it for its first minute.
  // Refusing it gains little: docs/security.md ("Accepted: a session token that names no origin")
  // says why, and what that rests on.
  const azp = claims.azp
  if (azp !== undefined && (typeof azp !== 'string' || !authorizedParties.includes(azp))) {
    throw new HttpError(401, 'unauthorized', 'invalid or expired session')
  }
  c.set('userId', claims.sub)
  c.set('azp', azp)
  c.set('claims', claims)
  await next()
}
