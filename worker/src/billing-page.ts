/**
 * The page Stripe's Checkout sends a buyer back to: after paying, or after going back without
 * paying. It holds no data and runs no script; the credits are added by the webhook, and the side
 * panel shows them when the user comes back to it.
 */
export function billingPage(outcome: 'paid' | 'cancelled'): string {
  const [title, text] =
    outcome === 'paid'
      ? [
          'Thank you',
          'Your credits are added as soon as the payment goes through. Go back to the side panel to use them.',
        ]
      : ['Nothing was bought', 'You can close this tab and go back to the side panel.']
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Cofun</title>
<style>
  :root { --bg: #f7f7f5; --fg: #1f1f1f; --muted: #6b6b6b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #191919; --fg: #e6e6e6; --muted: #9b9b9b; } }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
         padding: 0 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0; }
  p { color: var(--muted); margin: 0; text-align: center; max-width: 28em; }
</style>
</head>
<body>
<h1>${title}</h1>
<p>${text}</p>
</body>
</html>`
}
