# Releases

An extension is released from `main` by the [Release workflow](../.github/workflows/release.yml), run by hand: Actions → Release → Run workflow, on `main`, with the extension and the version. Or:

```bash
gh workflow run release.yml --ref main -f extension=notico -f version=0.2.0
```

Before running it, add the version to the extension's `CHANGELOG.md` ([Notico's](../extensions/notico/CHANGELOG.md)) through a PR: what changed for users since the last release (`git log <name>-v<last version>..main`), worker changes they notice included, written for them rather than copied from commit titles. The workflow uses that entry (the text under the `## <version> (<date>)` heading) as the body of the GitHub Release, and stops before it builds or tags anything if the changelog has no entry for the version.

The same PR brings the extension's store page up to date for that version: what the Dashboard's tabs say (the listing, the privacy answers, distribution, test instructions, and the images) is kept in `extension/products/<name>/store/` ([Notico's](../extension/products/notico/store/README.md)). Fold each file's "For the next version" notes into its text, check the text against what changed, and name the new version in its README. If what users see in the side panel changed, retake the screenshots and the marquee promo tile in the same PR, the way the listing's Images section says they are made.

The version goes into the manifest and is not committed: `package.json` keeps the development version 0.0.1, below every released one, and the tags record what was released. It must be 1 to 4 dot-separated integers from 0 to 65535, without leading zeros, and higher than the version last uploaded to the store, which rejects any other.

The workflow needs no secrets. Merge nothing into `main` while it runs: it tags the commit it built, and when `main` had moved on with a change to a workflow file, GitHub refused the tag (403) and the run had to start again. It checks out `main`, runs `pnpm check`, builds the extension for the store, runs its browser tests against that build, and zips `extension/dist`. Then it tags the commit `<name>-v<version>` (for example `notico-v0.2.0`) and publishes a GitHub Release with the changelog entry as its body and the zip (`<name>-<version>.zip`) attached; the zip is also kept as the run's artifact. A tag that exists already stops the run, so each version is built once. A release records that a version was built and released, whether or not the store accepts it: a version the store turns down is followed by the next one. To throw a run's result away before anyone uses it, delete the release and its tag:

```bash
gh release delete notico-v0.2.0 --cleanup-tag
```

The store build is the normal build with two variables set, which you can also set by hand to look at one: `EXTENSION_VERSION` replaces the version, and `CRX_STORE_BUILD=1` leaves `key` and `version_name` out of the manifest (every other build has `version_name` `<version> dev`, which `chrome://extensions` shows). The Chrome Web Store signs the item with a key of its own, which sets its ID.

```bash
CRX_STORE_BUILD=1 EXTENSION_VERSION=0.2.0 pnpm --filter cofun-extension build
```

Uploading to the store is done by hand. First check that the release's zip is the one the run built: the run's summary page gives its SHA-256, which must match the zip you download.

```bash
gh release download notico-v0.2.0 --pattern '*.zip' --dir /tmp/notico-release
shasum -a 256 /tmp/notico-release/notico-0.2.0.zip
```

Then, in the Chrome Web Store Developer Dashboard, Package → Upload new package with that zip, copy into the other tabs whatever changed in `extension/products/<name>/store/` since the last release, and Submit for review. A new extension's first upload is what assigns its ID: its public key (Package tab → View public key) becomes its `CRX_PUBLIC_KEY`, and the ID goes wherever the extension's origin is allowed ([development.md](development.md#notico)) and into `EXTENSION_ID` in `extension/browser-driver/extension.ts`.
