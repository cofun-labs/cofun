import { prepareCloudPageEdit, prepareCloudUndoEdit } from '../confluence/cloud-edits'
import { prepareCloudRestore } from '../confluence/cloud-status'
import type { ToolContext } from '@cofun/agent'
import { applyAttachmentUpload, prepareAttachmentUpload } from '../confluence/attachments'
import { prepareCloudOrganization, prepareCloudTrash } from '../confluence/cloud-organization'
import { applyCloudLabel, prepareCloudComment, prepareCloudPageWrite } from '../confluence/cloud-writes'
import { applyComment, prepareComment, requestedComment } from '../confluence/comments'
import { applyLabel, changeLabelArgs, requestedLabelChanges } from '../confluence/labels'
import { applyOrganization, prepareOrganization, requestedOrganization } from '../confluence/page-organization'
import { applyPageStatus, preparePageStatus, requestedPageStatus } from '../confluence/page-status'
import {
  applyPageEdit,
  applyPageWrite,
  describePageWrite,
  pageTitleArgs,
  preparePageEdit,
  preparePageWrite,
  prepareUndoPageEdit,
  requestedPageEdit,
  requestedPageWrite,
  requestedUndo,
} from '../confluence/page-writes'
import { captureConfluenceTab, refuse, type ConfluenceTab } from '../confluence/tab'
import type { ConfluenceUndo } from '../confluence/undo'
import { defineTool } from '../tool'
import { z } from '../zod'
import type { ConfluenceQuestion, ToolMemory } from './memory'
import { asData } from '@cofun/tools'
import { on, verb } from './shared'

interface ChangeResult {
  data: object
  changed: boolean
  undo?: ConfluenceUndo
}

interface Plan {
  preview: string
  confirm?: boolean
  apply(signal?: AbortSignal): Promise<ChangeResult>
}

const noArgs = z.strictObject({})

async function requireSameTab(context: ToolContext<ToolMemory>, captured: ConfluenceTab): Promise<void> {
  const now = await captureConfluenceTab(context.memory.accountId)
  if (
    now?.tabId !== captured.tabId ||
    now.url !== captured.url ||
    now.instance.path !== captured.instance.path ||
    now.instance.origin !== captured.instance.origin
  )
    refuse('The Confluence tab or connection changed. Open the intended page and ask again.')
}

/** Each prepared change belongs to the active question and its recorded tab. */
function change<S extends z.ZodObject>(
  name: string,
  title: string,
  description: string,
  args: S,
  prepare: (
    input: z.output<S>,
    context: ToolContext<ToolMemory>,
    question: ConfluenceQuestion,
    tab: ConfluenceTab,
    signal?: AbortSignal,
  ) => Promise<Plan>,
) {
  const plans = new WeakMap<ConfluenceQuestion, { tab: ConfluenceTab; plan: Plan } | { error: Error }>()
  return defineTool({
    name,
    description,
    args,
    changesData: true,
    needsConfirmation: ({ memory }) => {
      const question = memory.confluenceQuestion
      const pending = question && plans.get(question)
      return pending !== undefined && 'plan' in pending && pending.plan.confirm === true
    },
    describe: () => on(verb('change', 'changing', 'changed'), undefined, title),
    preview: async (input, context, signal) => {
      const { memory } = context
      const question = memory.confluenceQuestion
      if (!question) refuse('Ask for a Confluence change from the side panel.')
      plans.delete(question)
      if (question.writtenTool && (question.writtenTool !== name || name !== 'change_page_label')) {
        plans.set(question, { error: new Error('The Confluence change in this question was already handled.') })
        return undefined
      }
      const tab = await question.tab
      if (!tab) refuse('Open the connected Confluence page before asking for a change.')
      await requireSameTab(context, tab)
      signal?.throwIfAborted()
      try {
        const plan = await prepare(input, context, question, tab, signal)
        signal?.throwIfAborted()
        if (memory.confluenceQuestion !== question) return undefined
        question.writtenTool = name
        plans.set(question, { tab, plan })
        return plan.preview
      } catch (error) {
        if (!(error instanceof Error) || 'stopsQuestion' in error || signal?.aborted) throw error
        plans.set(question, { error })
        return undefined
      }
    },
    run: async (_args, signal, context) => {
      const { memory } = context
      const question = memory.confluenceQuestion
      const prepared = question && plans.get(question)
      if (!question || !prepared) refuse('Ask again to review the intended Confluence change.')
      plans.delete(question)
      if ('error' in prepared) throw prepared.error
      const { plan, tab } = prepared
      signal?.throwIfAborted()
      await requireSameTab(context, tab)
      await question.beforeWrite()
      signal?.throwIfAborted()
      try {
        const result = await plan.apply(signal)
        if (result.changed) memory.confluenceUndo = result.undo
        return { text: asData([JSON.stringify(result.data)]), details: {}, changed: result.changed }
      } catch (error) {
        if (error instanceof Error && 'mayHaveChanged' in error && error.mayHaveChanged === true)
          memory.confluenceUndo = undefined
        throw error
      }
    },
  })
}

function pageWrite(action: 'create' | 'rename') {
  return change(
    action === 'create' ? 'create_page' : 'rename_page',
    'a Confluence page',
    action === 'create'
      ? 'Create a published child page for a direct user request, with the exact quoted title.'
      : 'Rename a published page for a direct user request, with the exact quoted title.',
    pageTitleArgs,
    async ({ title }, { userText }, _question, tab, signal) => {
      const request = requestedPageWrite(userText)
      if (request?.action !== action || request.title !== title)
        throw new Error(
          'Only the user can request this page change. ' +
            (action === 'create'
              ? 'Ask them to say Create page "TITLE" under this page.'
              : 'Ask them to say Rename this page to "TITLE".'),
        )
      if (tab.instance.cloud) {
        const plan = await prepareCloudPageWrite(request, tab, signal)
        return {
          preview: plan.preview,
          async apply(signal) {
            const data = await plan.apply(signal)
            return { data, changed: data.changed }
          },
        }
      }
      const plan = await preparePageWrite(request, tab, signal)
      return {
        preview: describePageWrite(plan),
        async apply(signal) {
          const data = await applyPageWrite(plan, signal)
          return { data, changed: data.changed }
        },
      }
    },
  )
}

const editPage = change(
  'edit_page',
  'text on a Confluence page',
  'Replace exact text on a published page. Use only when the user directly requests Replace "OLD" with "NEW" on this page.',
  noArgs,
  async (_args, { userText }, _question, tab, signal) => {
    const request = requestedPageEdit(userText)
    if (!request) refuse('Ask the user to say Replace "OLD" with "NEW" on this page.')
    const plan = tab.instance.cloud
      ? await prepareCloudPageEdit(request, tab, signal)
      : await preparePageEdit(request, tab, signal)
    return {
      preview: plan.preview,
      async apply(signal) {
        const data = 'apply' in plan ? await plan.apply(signal) : await applyPageEdit(plan, signal)
        return {
          data,
          changed: true,
          undo: { page: data.page.ref, version: data.version, before: request.before, after: request.after },
        }
      },
    }
  },
)

function pageStatus(action: 'trash' | 'restore') {
  return change(
    action === 'trash' ? 'trash_page' : 'restore_page',
    'the status of a Confluence page',
    action === 'trash'
      ? 'Move a directly requested page to the recoverable trash.'
      : 'Restore a trashed page directly specified by the user by link.',
    noArgs,
    async (_args, { userText }, _question, tab, signal) => {
      const request = requestedPageStatus(userText)
      if (request?.action !== action)
        refuse('Ask the user to specify the page to trash or provide the link of the page to restore.')
      if (tab.instance.cloud) {
        if (action === 'restore') {
          const plan = await prepareCloudRestore(tab, request.targetUrl, signal)
          return {
            preview: plan.preview,
            confirm: plan.confirm,
            async apply(signal) {
              const data = await plan.apply(signal)
              return { data, changed: data.changed }
            },
          }
        }
        const plan = await prepareCloudTrash(tab, request.targetUrl, signal)
        return {
          preview: plan.preview,
          confirm: true,
          async apply(signal) {
            const data = await plan.apply(signal)
            return {
              data,
              changed: data.changed,
              undo: { kind: 'trash' as const, page: data.page.ref, version: data.version },
            }
          },
        }
      }
      const plan = await preparePageStatus(request, tab, signal)
      return {
        preview: plan.preview,
        confirm: plan.page.status !== (action === 'trash' ? 'trashed' : 'current'),
        async apply(signal) {
          const { trashDate, ...data } = await applyPageStatus(plan, signal)
          const undo =
            data.changed && data.status === 'trashed'
              ? { kind: 'trash' as const, page: data.page.ref, version: data.version, trashDate }
              : undefined
          return { data, changed: data.changed, undo }
        },
      }
    },
  )
}

function organizePage(action: 'move' | 'copy') {
  return change(
    action === 'move' ? 'move_page' : 'copy_page',
    'a Confluence page',
    action === 'move'
      ? 'Move one page under a parent in the same space using the destination link in the user message.'
      : 'Copy a single page into the same space using the destination link and quoted title in the user message.',
    noArgs,
    async (_args, { userText }, _question, tab, signal) => {
      const request = requestedOrganization(userText)
      if (request?.action !== action)
        refuse(
          'Ask the user to specify the source page and parent link. Use Move this page under URL or Copy this page under URL as "TITLE".',
        )
      if (tab.instance.cloud) {
        const plan = await prepareCloudOrganization(request, tab, signal)
        return {
          preview: plan.preview,
          async apply(signal) {
            const data = await plan.apply(signal)
            return { data, changed: data.changed }
          },
        }
      }
      const plan = await prepareOrganization(request, tab, signal)
      return {
        preview: plan.preview,
        async apply(signal) {
          const data = await applyOrganization(plan, signal)
          return { data, changed: data.changed }
        },
      }
    },
  )
}

const changeLabel = change(
  'change_page_label',
  'a Confluence page label',
  'Add or remove an ordinary label only when the user directly requests that exact label change on the current page.',
  changeLabelArgs,
  async ({ action, label }, { userText }, question, tab) => {
    const request = requestedLabelChanges(userText)[question.nextLabel]
    if (request?.action !== action || request.label !== label.toLowerCase())
      throw new Error('Only the user can request a label change. Ask for the exact label on the intended page.')
    question.nextLabel++
    return {
      preview: `${action === 'add' ? 'Add' : 'Remove'} the label "${request.label}" on the current page.`,
      async apply(signal) {
        const data = tab.instance.cloud
          ? await applyCloudLabel(request, tab, signal)
          : await applyLabel(request, tab, signal)
        return { data, changed: data.changed }
      },
    }
  },
)

const addComment = change(
  'add_page_comment',
  'a Confluence page comment',
  'Add a footer comment or reply from a direct user request. The exact comment and target come from the user message.',
  noArgs,
  async (_args, { userText }, _question, tab, signal) => {
    const request = requestedComment(userText)
    if (!request)
      refuse('Ask the user to say Add comment "TEXT" on this page or Reply to comment ID with "TEXT" on this page.')
    if (tab.instance.cloud) {
      const plan = await prepareCloudComment(request, tab, signal)
      return {
        preview: plan.preview,
        async apply(signal) {
          return { data: await plan.apply(signal), changed: true }
        },
      }
    }
    const plan = await prepareComment(request, tab, signal)
    return {
      preview: plan.preview,
      async apply(signal) {
        return { data: await applyComment(plan, signal), changed: true }
      },
    }
  },
)

const uploadAttachment = change(
  'upload_page_attachment',
  'an attachment on a Confluence page',
  'Upload or replace the local file the user selected and submitted using the attachment controls.',
  noArgs,
  async (_args, _context, question, tab, signal) => {
    if (!question.attachment)
      refuse('Choose a local file and select Upload attachment or Replace attachment in the panel.')
    const plan = await prepareAttachmentUpload(question.attachment, tab, signal)
    return {
      preview: plan.preview,
      confirm: true,
      async apply(signal) {
        return { data: await applyAttachmentUpload(plan, signal), changed: true }
      },
    }
  },
)

const undoChange = change(
  'undo_last_change',
  'the last Confluence change',
  'Undo the latest verified text edit or trash action in this chat after a direct user request to undo.',
  noArgs,
  async (_args, { userText, memory }, _question, tab, signal) => {
    if (!requestedUndo(userText)) refuse('Ask the user to explicitly request undoing the last operation.')
    const undo = memory.confluenceUndo
    if (!undo) refuse('The last workspace change in this conversation has no verified operation that can be undone.')
    if (tab.instance.cloud) {
      const plan =
        'kind' in undo
          ? await prepareCloudRestore(tab, undefined, signal, undo)
          : await prepareCloudUndoEdit(undo, tab, signal)
      return {
        preview: plan.preview,
        confirm: 'confirm' in plan && plan.confirm,
        async apply(signal) {
          const data = await plan.apply(signal)
          return { data, changed: data.changed }
        },
      }
    }
    if ('kind' in undo) {
      const plan = await preparePageStatus({ action: 'restore' }, tab, signal, undo)
      return {
        preview: plan.preview,
        confirm: plan.reviewAccess,
        async apply(signal) {
          const { trashDate: _, ...data } = await applyPageStatus(plan, signal)
          return { data, changed: data.changed }
        },
      }
    }
    const plan = await prepareUndoPageEdit(undo, tab, signal)
    return {
      preview: plan.preview,
      async apply(signal) {
        return { data: await applyPageEdit(plan, signal), changed: true }
      },
    }
  },
)

const commonWrites = [pageWrite('create'), pageWrite('rename'), changeLabel, addComment]
const trashPage = pageStatus('trash')
const movePage = organizePage('move')
const copyPage = organizePage('copy')
const restorePage = pageStatus('restore')

export const CONFLUENCE_WRITES = [
  ...commonWrites,
  editPage,
  undoChange,
  trashPage,
  restorePage,
  movePage,
  copyPage,
  uploadAttachment,
]
