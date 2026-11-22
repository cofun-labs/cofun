# Privacy

Cofun makes AI side panels for Chrome, each one an extension for a different kind of page. The extensions share one sign-in and one server (the worker). This page says what the sign-in and the worker do with your data, the same for every extension. What an extension reads in your browser, which hosts it contacts, and what it keeps on your device is on its own privacy page; the two pages together are its privacy policy:

- [Notico](extensions/notico/PRIVACY.md), for Notion
- [Confluco](extensions/confluco/PRIVACY.md), for Confluence
- [Webco](extensions/webco/PRIVACY.md), for any web page

This page describes the worker deployed from `worker/` and the extensions built from this repository with their committed configuration. If you build an extension against your own deployment, the hosts are the ones you configure.

The short version: when you ask a question, the conversation, including what the extension read to answer it, goes to our worker and from there to an AI model that runs on Cloudflare. We do not store that content. The worker keeps your credits and a record of what each request cost, never what you asked or what the AI answered.

## Who receives your data

Each recipient gets only what is listed for it.

- **[Clerk](https://clerk.com/legal/privacy)**, which holds your account: your email address, name, and avatar, as your sign-in provider gives them. You sign in on our page `https://api.cofun.cc/login`, which runs Clerk's sign-in code, including its check that you are not a bot. What you enter there goes to Clerk and the sign-in provider you choose, such as Google, not to our worker. The worker checks each request's session token without calling Clerk, and uses only your Clerk user id from it, and for an operator, that the account is one.
- **[Cloudflare](https://www.cloudflare.com/privacypolicy/)**, which runs the worker and holds everything it keeps and logs (below). It processes:
  - **your conversation**, which the worker passes to the AI model on Workers AI through Cloudflare's AI Gateway, with the chat's random id so that its requests reach the copy of the model that already holds it. The gateway keeps no messages or replies, only request analytics (counts, tokens, cost) under your Clerk user id and the extension;
  - **the address of a web page** the assistant reads. The worker fetches it from Cloudflare, or has Cloudflare's Browser Run load it in a browser for a page drawn by scripts, and returns its title and text;
  - **the query of a web search** the assistant makes, which may hold text from the conversation. The worker sends it to Cloudflare's Web Search through the same gateway, which keeps no query or results, only request analytics and its billing record, and returns each result's address, title, and description;
  - **a visit to the sign-in page**, which Cloudflare's Web Analytics counts (`static.cloudflareinsights.com`): the page's address, the page you came from, your browser and operating system, and how fast it loaded.
- **[Linkup](https://www.linkup.so)**, the provider behind Cloudflare's Web Search: the query of a web search, to run it. Cloudflare lists Linkup as keeping no data of the searches it serves.
- **The sites of web pages read for you**: a request for the page, and for a rendered page what the page loads, from Cloudflare and never with a cookie or sign-in of yours. The site sees Cloudflare, not you, and shows what it shows anyone who is not signed in.
- **[Stripe](https://stripe.com/privacy)**, when you buy credits. Stripe sells them as the merchant of record: what you enter on its Checkout page (`checkout.stripe.com`) goes to Stripe and Link, Stripe's checkout service, never to us. The worker sends Stripe your Clerk user id, the pack you chose, and the pages to return to; Stripe tells the worker when a payment goes through, is refunded, or is disputed, with the payment's reference and the pack, never your payment details.
- **[PostHog](https://posthog.com/privacy)**: when a payment adds credits, the worker sends one event, that a purchase was completed, with your Clerk user id and the pack, and nothing else; it tells PostHog not to work out a location. What an extension itself sends PostHog, and how to turn it off, is on its privacy page; that switch does not cover this event.

The worker never stores or logs your conversation, the address or text of a web page, or a search's query or results.

## What the worker keeps

- **Your credits**, in a database on Cloudflare, under your Clerk user id:
  - each grant of credits: how many, how many are left, when it was given and expires, and where it came from: the free weekly grant, an operator (with their Clerk user id), or a purchase (with its Stripe reference, and whether it was taken back);
  - each paid call (a call to the AI model, a page rendered, a web search), whether it succeeded or failed: when, which extension, how it ended, what it used (such as the model and its tokens, or browser time), and what it cost, with the random ids of the chat and the question it was for. These ids say nothing about what you asked.
  - for each call to the AI model, from the moment it starts: when it started, so the worker can count how many calls you have going at once.

  They are kept with no end date, as the account's record. Operators can see and total them, per account or across accounts, and grant credits. Showing you your credits stores nothing new: the worker works them out from these records.
- **Usage records**, one for each model request, web page, and web search, in Cloudflare Workers Analytics Engine, which deletes them after 90 days: figures such as your Clerk user id, which extension, the model, the outcome, sizes and counts (characters, tokens, results), the credits, the duration, and the chat and question ids. Never text.

## What the worker logs

Cloudflare keeps the worker's logs: the request logs it records for every Worker (such as the time, address, and status of a request; when you look at your credits, the address holds how far your clock is from UTC), and what the worker writes to them.

- **Errors.** When something fails, the worker logs a short part of the error, so that if it quoted part of a request, no more than a short excerpt of it reaches the logs. The one error it logs whole is from writing a usage record (above), which holds nothing you asked and nothing from a page.
- **Credits granted by hand**: the operator's Clerk user id, the account's Clerk user id, the number of credits, and when they expire.
- **Purchases**: your Clerk user id, the credits, and the payment's Stripe reference; for a purchase taken back, its reference and why; for a payment that grants nothing, its Stripe reference and why.

## Changes and contact

This page is written by recipient, and by what the worker keeps and logs. It changes in the same pull request as a change that adds a recipient, a kind of data one receives, or something the worker keeps or logs; its [history](https://github.com/cofun-labs/cofun/commits/main/PRIVACY.md) shows every change. Questions and reports: [open an issue](https://github.com/cofun-labs/cofun/issues). Report a security vulnerability privately instead, as [SECURITY.md](SECURITY.md) says.
