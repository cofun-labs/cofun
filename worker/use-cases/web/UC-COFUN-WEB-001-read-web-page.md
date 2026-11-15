# UC-COFUN-WEB-001: Read a public web page

## Behavior

A signed-in user's client can have the service read a web page for them by its address: the page's title and main text, as anyone who opens the address without signing in would see it, clipped to as much as the client asks for. Reading a page this way is free. A page drawn by scripts shows no text this way; the client can then ask for it to be rendered in a browser, which shows what it draws. Rendering is free too, and a user can have only a few pages rendered a minute. The service never keeps or logs the address or the page.

Which addresses a user may have read is the client's rule (for Notico, only those the user gave: UC-NOTICO-PANEL-003); the service only refuses those that are never read.

Key constraints:

- The service reads only public pages: it sends no cookie or credential, and never reads an address on its own domain, on a local network name, or written as an IP address, also when a page redirects there.
- A page that can't be read (it needs a sign-in, a bot check stops it, it is not HTML or text, or it shows no text) is refused with the reason, so the client can say what to do instead.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-WEB-001-S01 | P0 | ✅ | Given a signed-in user; when their client asks for a public web page; then it gets the page's title and main text, clipped to what it asked for, and nothing is charged. |
| UC-COFUN-WEB-001-S02 | P0 | ✅ | Given an address on the service's own domain, on a local network name, or written as an IP address, or a page that redirects to one; when a client asks for it; then it is refused, and that address is never reached. |
| UC-COFUN-WEB-001-S03 | P1 | ✅ | Given a page behind a sign-in or a bot check, or one that is not HTML or text; when a client asks for it; then it is refused with the reason. |
| UC-COFUN-WEB-001-S04 | P1 | ✅ | Given a page that shows no text until its scripts run; when a client asks for it; then it is told the page shows no text; and when it asks for the page rendered, it gets the text the page shows in a browser. |
| UC-COFUN-WEB-001-S05 | P1 | ✅ | Given a user who has had as many pages rendered as they may in a minute; when their client asks for another rendered; then they are told to wait, nothing is rendered, and pages can still be read plainly; a render costs no credits. |
| UC-COFUN-WEB-001-S06 | P1 | ✅ | Given a user who has asked for as many pages as they may in a minute; when they ask for another; then they are told to wait, and the page is not read. |

### ai-e2e

(none)
