# Webco

Webco is an AI side panel for Chrome that gets you answers from any web page: it summarizes and explains the page you're on, compares it with other tabs you add to a question, explains text you select, reads a page by its address, and searches the web. It reads, and changes nothing on any site. The first time it needs a site, it asks you to allow it, and Chrome asks too. It can read a YouTube video's transcript. It uses the same Cofun account and credit balance as Notico and Confluco.

The model can summarize earlier messages to continue a long chat. You can still read the original messages when you reopen it. OpenRouter models need a context window of at least 200,000 tokens.

Web searches and pages rendered in a browser cost credits, also when your own model answers. To search for free instead, switch on **Search with DuckDuckGo** in **Account → Settings**: each search then opens DuckDuckGo in a background tab and reads its results. Those searches show in your Chrome history, and if DuckDuckGo asks you to confirm you're a person, answer it in that tab.

[Install Webco from the Chrome Web Store](https://chromewebstore.google.com/detail/ohopjjnpfepkmkcfccaondkhggegbfeh).

## Try the development build

Run `pnpm install` from the repository root, then run `pnpm --filter webco-extension build`. In `chrome://extensions`, turn on Developer mode and load `extensions/webco/dist` unpacked. Open the panel from the toolbar and sign in with Cofun.

[Privacy policy](PRIVACY.md) · [Development guide](../../docs/development.md)
