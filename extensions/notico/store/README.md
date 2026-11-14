# Notico in the Chrome Web Store

What Notico's item in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) says, kept here so that it changes through pull requests like the code it describes. The store's API takes only the package, so the Dashboard is filled in by hand from these files: change a file here first, then copy it into the Dashboard. Never edit the Dashboard alone.

| File | Dashboard tab |
|---|---|
| [listing.md](listing.md) | Store listing: description, category, links, images |
| [privacy.md](privacy.md) | Privacy: single purpose, permission justifications, remote code, data usage, privacy policy |
| [distribution.md](distribution.md) | Distribution: payments, visibility, regions |
| [test-instructions.md](test-instructions.md) | Test instructions, for the store's reviewers |
| [images/](images/) | Store listing: screenshots and promo tiles |

The summary line under the name is not here: it is the manifest's `description` in [`../manifest.ts`](../manifest.ts), and it changes only with a new version.

A pull request that changes what Notico asks for or what leaves the browser updates these files with the code: a permission or host permission changes [privacy.md](privacy.md) (`test/manifest.test.ts` checks that every permission has a justification there), a new place data goes changes its data usage, and selling something changes [distribution.md](distribution.md). Update the Dashboard before submitting the version that needs it.
