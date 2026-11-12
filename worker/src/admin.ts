/**
 * The admin page: an operator looks up one account's credits by Clerk user id and grants it
 * credits by hand. It signs in with Clerk like the sign-in page, and holds no data of its own:
 * everything it shows comes from /v1/admin/*, called with the session token, and the worker decides
 * there who is an admin. Whatever the worker answers is put on the page as text, never as HTML.
 */
import { clerkFrontendApi, esc } from './login'

export function adminPage(publishableKey: string): string {
  const fapi = clerkFrontendApi(publishableKey)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Admin · Notico</title>
<style>
  :root { --bg: #f7f7f5; --fg: #1f1f1f; --muted: #6b6b6b; --line: #d9d9d6; --bad: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #191919; --fg: #e6e6e6; --muted: #9b9b9b; --line: #3a3a3a; --bad: #f2b8b5; } }
  body { margin: 0; padding: 32px 16px; display: flex; flex-direction: column; align-items: center; gap: 16px;
         background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 24px 0 8px; }
  #app { display: none; width: 100%; max-width: 760px; }
  #account { display: none; }
  form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
  label { display: flex; flex-direction: column; gap: 4px; color: var(--muted); font-size: 13px; }
  input { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; }
  #user-id { width: 22em; max-width: 100%; }
  input[type=number] { width: 8em; }
  button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
  #message { min-height: 1.5em; margin: 12px 0 0; }
  #message.bad { color: var(--bad); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; font-variant-numeric: tabular-nums; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: normal; font-size: 13px; }
  tr.expired td { color: var(--muted); }
  .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .muted { color: var(--muted); }
</style>
</head>
<body>
<h1>Notico admin</h1>
<div id="sign-in"></div>
<div id="app">
  <div class="top">
    <span class="muted">Credits of one account</span>
    <button id="sign-out" type="button">Sign out</button>
  </div>
  <form id="lookup">
    <label>Clerk user id
      <input id="user-id" name="userId" placeholder="user_…" autocomplete="off" spellcheck="false" required />
    </label>
    <button type="submit">Look up</button>
  </form>
  <p id="message" role="status"></p>
  <div id="account">
    <h2>Credits of <span id="account-id"></span></h2>
    <dl>
      <dt>Balance</dt><dd id="balance"></dd>
      <dt>Overspent</dt><dd id="debt"></dd>
    </dl>
    <h2>Grants</h2>
    <p id="no-grants" class="muted">No grants. This account has not used the AI yet, or the user id is not the one you meant.</p>
    <div class="scroll">
      <table id="grants">
        <thead><tr><th>Source</th><th>Granted</th><th>Expires</th><th>Credits</th><th>Left</th><th>Granted by</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <h2>Grant credits</h2>
    <form id="grant">
      <label>Credits
        <input id="credits" name="credits" type="number" min="1" step="1" required />
      </label>
      <label>Days until they expire
        <input id="days" name="days" type="number" min="1" step="1" value="30" required />
      </label>
      <button type="submit">Grant</button>
    </form>
  </div>
</div>
<script defer crossorigin="anonymous" src="https://${esc(fapi)}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous"
  data-clerk-publishable-key="${esc(publishableKey)}"
  src="https://${esc(fapi)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script>
  window.addEventListener('load', start)
  const el = (id) => document.getElementById(id)
  /** The account on the page: grants go to it, not to whatever the user id box says now. */
  let shownUserId = null

  async function start() {
    // The same options as the sign-in page: the whole flow stays here, and Clerk's SDK telemetry is off.
    await window.Clerk.load({
      telemetry: false,
      ui: { ClerkUI: window.__internal_ClerkUICtor },
      signInUrl: location.pathname,
      signUpUrl: location.pathname,
    })
    let shown = null
    const render = () => {
      const signedIn = !!window.Clerk.user
      if (signedIn === shown) return
      shown = signedIn
      el('app').style.display = signedIn ? 'block' : 'none'
      const box = el('sign-in')
      if (signedIn) window.Clerk.unmountSignIn(box)
      else {
        showAccount(null)
        say('')
        window.Clerk.mountSignIn(box, { routing: 'hash', fallbackRedirectUrl: location.pathname })
      }
    }
    window.Clerk.addListener(render)
    render()
    el('sign-out').onclick = () => window.Clerk.signOut()
    el('lookup').onsubmit = (event) => {
      event.preventDefault()
      const userId = el('user-id').value.trim()
      // A lookup that fails leaves no account on the page: the one shown before is not the one asked for.
      run(() => api('GET', '/v1/admin/accounts/' + encodeURIComponent(userId)), '', true)
    }
    el('grant').onsubmit = (event) => {
      event.preventDefault()
      const credits = Number(el('credits').value)
      const days = Number(el('days').value)
      const question = 'Grant ' + credits + ' credits to ' + shownUserId + ', expiring in ' + days + ' days?'
      if (!shownUserId || !window.confirm(question)) return
      const path = '/v1/admin/accounts/' + encodeURIComponent(shownUserId) + '/grants'
      run(() => api('POST', path, { credits, days }), 'Granted ' + credits + ' credits.').then((done) => {
        if (done) el('credits').value = ''
      })
    }
  }

  /** Calls the worker as the signed-in user. A refusal is thrown with the worker's own message. */
  async function api(method, path, body) {
    const token = await window.Clerk.session.getToken()
    const res = await fetch(path, {
      method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error((data && data.error && data.error.message) || 'The request failed (' + res.status + ').')
    return data
  }

  /** Runs a call that answers with an account, and shows the account or what went wrong. */
  async function run(call, done, clearOnFailure) {
    say('Working…')
    try {
      showAccount(await call())
      say(done)
      return true
    } catch (err) {
      if (clearOnFailure) showAccount(null)
      say(err instanceof Error ? err.message : 'The request failed.', true)
      return false
    }
  }

  function say(text, bad) {
    el('message').textContent = text
    el('message').className = bad ? 'bad' : ''
  }

  /** Amounts arrive in micro-credits (1 credit = 1,000,000). */
  const credits = (micro) => (micro / 1000000).toLocaleString('en-US', { maximumFractionDigits: 2 })
  const time = (ms) => new Date(ms).toLocaleString()

  function showAccount(account) {
    shownUserId = account ? account.userId : null
    el('account').style.display = account ? 'block' : 'none'
    if (!account) return
    el('account-id').textContent = account.userId
    el('balance').textContent = credits(account.balance)
    el('debt').textContent = credits(account.debt)
    el('no-grants').style.display = account.grants.length ? 'none' : 'block'
    el('grants').style.display = account.grants.length ? 'table' : 'none'
    const rows = el('grants').tBodies[0]
    rows.replaceChildren()
    const now = Date.now()
    // Newest first.
    for (const grant of account.grants.slice().reverse()) {
      const expired = grant.expiresAt <= now
      const row = rows.insertRow()
      if (expired) row.className = 'expired'
      const cells = [
        grant.source,
        time(grant.grantedAt),
        time(grant.expiresAt) + (expired ? ' (expired)' : ''),
        credits(grant.amount),
        credits(grant.left),
        grant.by || '',
      ]
      for (const text of cells) row.insertCell().textContent = text
    }
  }
</script>
</body>
</html>`
}
