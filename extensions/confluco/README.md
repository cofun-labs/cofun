# Confluco

Confluco is an AI side panel for Chrome. It can answer questions, read the current tab or tabs you add, and search the web. It uses the same Cofun account and credit balance as Notico.

Web searches cost credits. To search for free instead, switch on **Search with DuckDuckGo** in **Account → Settings**: each search then opens DuckDuckGo in a background tab and reads its results. Those searches show in your Chrome history, and if DuckDuckGo asks you to confirm you're a person, answer it in that tab.

## Connect to Confluence

Open **Account → Settings → Confluence connection**. Enter your Cloud site URL (such as `https://team.atlassian.net/wiki`) or your self-managed base URL, including its deployment path if it has one. Allow Chrome site access, then open the connected site and sign in to Confluence. On either site type, you can read the current page, search published content, browse spaces and page trees, and inspect versions, access, labels, discussions and attachments.

In Edit mode on either site type, you can ask to create a published child page, rename a page, add or remove a label, or post a footer comment or reply. For example, ask `Create page "Notes" under this page`. You can also move a page or copy its body within the space and confirm moving an eligible page to the trash. You can also replace exact published text, restore a page by its link with space administrator access, and undo the last verified edit or trash action in the chat. On Cloud, publishing an edit or undo can merge into or overwrite an unpublished draft.

Use **Confluence** in the composer to select a file and confirm an upload or replacement on the current published page. On Cloud, Confluence matches attachments by filename. A concurrent same-name upload can receive the selected file as a new version. On a self-managed site you can also use **Attach editor selection**.

## Try the development build

Run `pnpm install` from the repository root, then run `pnpm --filter confluco-extension build`. In `chrome://extensions`, turn on Developer mode and load `extensions/confluco/dist` unpacked. Open the panel from the toolbar and sign in with Cofun.

[Privacy policy](PRIVACY.md) · [Development guide](../../docs/development.md)
