# UC-COFUN-WEB-001: Read a public web page

## Behavior

A signed-in user's client can have the service read a public web page by its address: its title and main text, as anyone who opens the address without signing in would see it. Reading a page this way is free. A page drawn by scripts can be rendered in a browser instead, only while the user has credits left; a render costs what its browser time cost the service, at its provider's list price with nothing added. The service never keeps or logs the address or the page, only a record of each render.

Which addresses to read is the client's choice (UC-NOTICO-PANEL-003); the service only refuses those that are never read.

Key constraints:

- The service reads only public pages: it sends no cookie or credential, and never reads an address on its own domain, on a local network name, or written as an IP address, also when a page redirects there.
- A page that can't be read (it needs a sign-in, a bot check stops it, it is not HTML or text, or it shows no text) is refused with the reason, so the client can say what to do instead.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-WEB-001-S01 | P0 | ✅ | Given a signed-in user; when their client asks for a public web page; then the service asks the site for it with no cookie or credential, and the client gets the page's title and main text, clipped to what it asked for, and nothing is charged. |
| UC-COFUN-WEB-001-S02 | P0 | ✅ | Given an address on the service's own domain, on a local network name, or written as an IP address, or a page that redirects to one; when a client asks for it; then it is refused, and that address is never reached. |
| UC-COFUN-WEB-001-S03 | P1 | ✅ | Given a page behind a sign-in or a bot check, or one that is not HTML or text; when a client asks for it; then it is refused with the reason. |
| UC-COFUN-WEB-001-S04 | P1 | ✅ | Given a page that shows no text until its scripts run; when a client asks for it; then it is told the page shows no text; and when it asks for the page rendered, it gets the text the page shows in a browser. |
| UC-COFUN-WEB-001-S05 | P0 | ✅ | Given a signed-in user with credits; when their client has pages rendered; then each costs the browser time it used, taken from their credits, and the client is told what it cost; and once they have had as many rendered as they may in a minute, they are told to wait, nothing more is rendered, and pages can still be read plainly. |
| UC-COFUN-WEB-001-S06 | P1 | ✅ | Given a user who has asked for as many pages as they may in a minute; when they ask for another; then they are told to wait, and the page is not read. |
| UC-COFUN-WEB-001-S07 | P0 | ✅ | Given a user with no credits left; when their client asks for a page rendered; then they are told they have no credits and when the next free ones arrive, nothing is rendered, and pages can still be read plainly. |
| UC-COFUN-WEB-001-S08 | P1 | ✅ | Given a page that shows no text even rendered, one that could not be rendered, or the browser that renders pages turning renders away for coming too often; when a client asks for it rendered; then it is told why, the browser being busy included, and the render costs nothing, as the answer says. |

### ai-e2e

(none)
