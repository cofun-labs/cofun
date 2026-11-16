# Security policy

## Reporting a vulnerability

Report a vulnerability privately, through GitHub: on this repository's [Security tab](https://github.com/cofun-labs/cofun/security), choose [Report a vulnerability](https://github.com/cofun-labs/cofun/security/advisories/new). Only you and the maintainers can see the report, and we answer there. Please don't open a public issue, pull request, or discussion about it until it is fixed.

Say what is affected, how to reproduce it, and what someone could do with it. We'll confirm we have the report, keep you told as we fix it, and credit you in the advisory once it is published, if you want to be.

Bugs that aren't security problems go to the [issues](https://github.com/cofun-labs/cofun/issues).

## Scope

In scope:

- The extensions in this repository ([`extension/`](extension)), as built from it or installed from the Chrome Web Store.
- The worker they share ([`worker/`](worker)), served at `api.cofun.cc`, its sign-in page included.

Out of scope: the services Cofun relies on (Notion, Clerk, Cloudflare, Stripe, OpenRouter, PostHog), unless the problem is in how Cofun uses them; report the rest to them. [docs/security.md](docs/security.md) describes what Cofun protects and the trade-offs it accepts on purpose.

## Testing

Test only with accounts, workspaces, and data that are your own. Don't read, change, or delete anyone else's data, don't use up credits or other resources that aren't yours, and don't run tests that slow the service down or flood it with requests. A Notion workspace is someone's account: testing against one that isn't yours is never allowed. If you come across someone else's data by accident, stop, don't keep it, and tell us in your report.
