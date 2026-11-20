/**
 * The sign-in page the extension opens in a tab. Signing in here sets Clerk's cookies
 * (on this host, its parent domain, and on a production instance the Frontend API host),
 * and the extension picks the session up through Clerk's Sync Host.
 * Social logins (Google etc.) work here because this is a normal web page.
 */

import * as z from './zod'

const LoginApp = z.enum(['notico', 'confluco']).optional().catch(undefined)
const appNames = {
  notico: 'Notico by Cofun',
  confluco: 'Confluco by Cofun',
}

/**
 * Clerk's Frontend API host is encoded in the publishable key: pk_test_ (a development instance)
 * or pk_live_ (a production instance), then base64 of the host and a "$", without padding.
 */
export function clerkFrontendApi(publishableKey: string): string {
  return atob(publishableKey.split('_')[2] ?? '').replace(/\$$/, '')
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function loginPage(publishableKey: string, requestedApp: unknown): string {
  const fapi = clerkFrontendApi(publishableKey)
  const app = LoginApp.parse(requestedApp)
  const name = app ? appNames[app] : 'Cofun'
  const returnUrl = app ? `/login?app=${app}` : '/login'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in · ${esc(name)}</title>
<style>
  :root { --bg: #f7f7f5; --fg: #1f1f1f; --muted: #6b6b6b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #191919; --fg: #e6e6e6; --muted: #9b9b9b; } }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
         background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0; }
  p { color: var(--muted); margin: 0; text-align: center; }
  #signed-in { display: none; flex-direction: column; align-items: center; gap: 12px; }
  button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #ccc; background: transparent; color: inherit; cursor: pointer; }
</style>
</head>
<body>
<h1>${esc(name)}</h1>
<div id="sign-in"></div>
<button id="restart-sign-up" type="button" hidden>Start registration again</button>
<div id="signed-in">
  <p>You're signed in. Go back to the side panel.</p>
  <button id="sign-out">Sign out</button>
</div>
<script defer crossorigin="anonymous" src="https://${esc(fapi)}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous"
  data-clerk-publishable-key="${esc(publishableKey)}"
  src="https://${esc(fapi)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script>
  window.addEventListener('load', start)
  async function start() {
    // Preserve the chosen brand when Clerk returns here from an OAuth step.
    const returnUrl = ${JSON.stringify(returnUrl)}
    // Keep the whole flow on this page. Without signInUrl/signUpUrl, Clerk sends
    // steps it can't finish here (OAuth sign-up continuation, Protect checks) to
    // its hosted Account Portal, which can't redirect back to this domain.
    // Clerk's SDK reports its own usage to clerk-telemetry.com when the instance
    // is a development one. PRIVACY.md lists where this page's data goes, so it
    // is off whatever the instance.
    await window.Clerk.load({
      telemetry: false,
      ui: { ClerkUI: window.__internal_ClerkUICtor },
      signInUrl: returnUrl,
      signUpUrl: returnUrl,
      localization: { signIn: { start: { titleCombined: ${JSON.stringify(`Continue to ${name}`)} } } },
    })
    const restart = document.getElementById('restart-sign-up')
    let expiryTimer
    const renderRestart = () => {
      clearTimeout(expiryTimer)
      const route = location.hash.split('?')[0]
      const onSignUpCheck = route === '#/create/protect-check' || route === '#/create/continue/protect-check'
      const check = window.Clerk.client?.signUp.protectCheck
      restart.hidden = true
      if (window.Clerk.user || !onSignUpCheck || check?.status !== 'pending' || !check.expiresAt) return
      const remaining = check.expiresAt - Date.now()
      restart.hidden = remaining >= 0
      if (restart.hidden) expiryTimer = setTimeout(renderRestart, remaining + 1)
    }
    restart.onclick = () => {
      renderRestart()
      if (restart.hidden) return
      // Reset the local attempt and enter the combined component's sign-up form.
      // Its Google button creates a new SignUp before redirecting to Google.
      window.Clerk.client.resetSignUp()
      location.replace('#/create')
      restart.hidden = true
    }
    window.addEventListener('hashchange', renderRestart)
    // Clerk calls listeners on every resource change, including mid-flow steps
    // like the Protect check. Remounting SignIn on each call restarts the flow,
    // so only mount or unmount when the signed-in state actually changes.
    let shown = null
    const render = () => {
      renderRestart()
      const signedIn = !!window.Clerk.user
      if (signedIn === shown) return
      shown = signedIn
      document.getElementById('signed-in').style.display = signedIn ? 'flex' : 'none'
      const box = document.getElementById('sign-in')
      if (signedIn) window.Clerk.unmountSignIn(box)
      else window.Clerk.mountSignIn(box, {
          routing: 'hash',
          withSignUp: true,
          fallbackRedirectUrl: returnUrl,
          signUpFallbackRedirectUrl: returnUrl,
        })
    }
    window.Clerk.addListener(render)
    render()
    document.getElementById('sign-out').onclick = () => window.Clerk.signOut()
  }
</script>
</body>
</html>`
}
