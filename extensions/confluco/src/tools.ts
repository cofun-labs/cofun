import { getInstance } from './confluence/instance'
import { searchArgs, searchPages } from './confluence/navigation'
import { activeTab } from './confluence/page'
import { applyPageEdit, preparePageEdit, type PageEditRequest } from './confluence/page-writes'
import { readPage } from './confluence/read-page'
import { confluenceTab, refuse, type ConfluenceTab } from './confluence/tab'
import { defineTool } from './tool'
import { z } from './zod'

export interface WorkspaceQuestion {
  tab?: ConfluenceTab
  edit?: PageEditRequest
}

export function createTools(userId: string, currentQuestion: () => WorkspaceQuestion) {
  let prepared: { question: WorkspaceQuestion; plan: Awaited<ReturnType<typeof preparePageEdit>> } | undefined
  return [
    defineTool({
      name: 'read_page',
      description: 'Read text and the source link from the current published Confluence page.',
      args: z.strictObject({}),
      run: (_args, signal) => readPage(currentQuestion().tab, signal),
    }),
    defineTool({
      name: 'search_pages',
      description: 'Find published Confluence pages by title or text. Returns excerpts and source links.',
      args: searchArgs,
      run: (args, signal) => searchPages(args, currentQuestion().tab, signal),
    }),
    defineTool({
      name: 'edit_page',
      description:
        'Preview a single text replacement. Use only for a direct request such as Replace "OLD" with "NEW" on this page. The extension takes the exact text from the user message and requires confirmation.',
      args: z.strictObject({}),
      changesData: true,
      needsConfirmation: true,
      preview: async (_args, signal) => {
        prepared = undefined
        const question = currentQuestion()
        const edit = question.edit
        if (!edit) refuse('Ask the user to say Replace "OLD" with "NEW" on this page.')
        question.edit = undefined
        const plan = await preparePageEdit(edit, question.tab, signal)
        signal?.throwIfAborted()
        prepared = { question, plan }
        return plan.preview
      },
      run: async (_args, signal) => {
        signal?.throwIfAborted()
        const ready = prepared
        prepared = undefined
        const question = currentQuestion()
        if (ready?.question !== question) refuse('Ask again to preview the intended page change.')
        const [tab, instance] = await Promise.all([activeTab(), getInstance(userId)])
        const original = ready.plan.tab
        if (instance?.origin !== original.instance.origin || instance.path !== original.instance.path)
          refuse('The Confluence connection changed after the preview. Connect the intended instance and ask again.')
        const active = confluenceTab(tab, instance)
        if (active?.tabId !== ready.plan.tab.tabId || active.url !== ready.plan.tab.url)
          refuse('The active Confluence page changed after the preview. Reopen it and ask again.')
        return applyPageEdit(ready.plan, signal)
      },
    }),
  ]
}
