// The worker's own pages: the sign-in page the extensions sync their session from, and the admin page.
import { Hono } from 'hono'
import { adminPage } from '../admin'
import { loginPage } from '../login'
import { HttpError, type App } from '../http'

export function pageRoutes(): App {
  const routes: App = new Hono()
  routes.get('/health', (c) => c.json({ ok: true }))

  // Sign-in page for the extension (Clerk Sync Host).
  routes.get('/', (c) => c.redirect('/login'))
  routes.get('/login', (c) => {
    if (!c.env.CLERK_PUBLISHABLE_KEY) throw new HttpError(503, 'not_configured', 'CLERK_PUBLISHABLE_KEY is not set')
    // This page holds the Clerk session the extension syncs from, so no other site may frame it.
    c.header('content-security-policy', "frame-ancestors 'none'")
    c.header('x-frame-options', 'DENY')
    return c.html(loginPage(c.env.CLERK_PUBLISHABLE_KEY))
  })

  // Admin page: look up an account's credits and grant credits by hand. The page holds no data;
  // everything it shows comes from /v1/admin/*, which checks the session and the admin role.
  routes.get('/admin', (c) => {
    if (!c.env.CLERK_PUBLISHABLE_KEY) throw new HttpError(503, 'not_configured', 'CLERK_PUBLISHABLE_KEY is not set')
    // No other site may frame it, so none can trick an admin into clicking through a grant.
    c.header('content-security-policy', "frame-ancestors 'none'")
    c.header('x-frame-options', 'DENY')
    return c.html(adminPage(c.env.CLERK_PUBLISHABLE_KEY))
  })

  return routes
}
