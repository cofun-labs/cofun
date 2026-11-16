# Notion API fixtures

Responses of Notion's internal API (`/api/v3/…`), in the shapes recorded by the #64 spike and by
requests against a real Notion tab. Ids, names, and text are replaced with placeholders; nothing
here comes from a real workspace.

`rich-page`, `synced-copy`, `database-row`, and `database-row-mentions` were recorded from throwaway
private pages (2026-11): a page with mentions, a numbered list, a quote, a callout, code with a
caption, a table, columns, and a synced block; a page with a copy of that synced block; a database
row whose view orders its columns; and the lookup of the person and related row that row's load
left out. Their blocks were written through the API, then loaded as Notion returns them. Users are
reduced to a placeholder name, and the CRDT copy of each block's content is left out.
