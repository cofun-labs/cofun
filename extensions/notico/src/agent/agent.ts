// Notico supplies its model settings, tool context, and mode guidance to the shared agent.
import { CofunAgent, type SelectedModel } from '@cofun/base/agent'
import { answering, HOSTED_ONLY, type OwnSetup } from '../models'
import { ownProvider } from './own'
import type { AgentConfig, ToolContext } from './types'
import { readWebPage, searchWebFor } from './worker'

/** Ahead of a question asked in Read only, for the model: it has no tool that changes data for it. */
const READ_ONLY_NOTE =
  '[Read only: the user set Notico to Read only for this question, so you have no tools that change Notion. ' +
  "If the question asks for a change, make none and don't describe one as done: say you can't make changes in " +
  'Read only, and that the user can switch to Edit with the mode button at the bottom left of the message box ' +
  'and ask again. You can still read and answer.]'
/** Ahead of a question asked in Edit right after one in Read only: the tools that change data are back. */
const EDIT_NOTE = '[Edit: the user switched Notico back to Edit, so the tools that change Notion are available again.]'

export class CopilotAgent extends CofunAgent<ToolContext> {
  constructor({ model, results, ...config }: AgentConfig) {
    let previous: OwnSetup | undefined
    let selected: SelectedModel | undefined
    super({
      ...config,
      readOnlyNotes: { active: READ_ONLY_NOTE, resumed: EDIT_NOTE },
      modelUpdatedMessage: 'Notico was just updated. Ask it to continue.',
      model: async () => {
        const choice = answering((await model?.()) ?? HOSTED_ONLY)
        if (JSON.stringify(choice) !== JSON.stringify(previous)) {
          previous = choice
          selected = choice && { service: choice.service, provider: ownProvider(choice) }
        }
        return selected
      },
      toolContext: ({ ask, turn, charge, namesResult, questionChars }) => ({
        ask,
        questionChars,
        readWeb: (url, maxChars, render, signal) =>
          readWebPage({ ...config, turn }, url, maxChars, render, signal, charge),
        searchWeb: (query, limit, signal) => searchWebFor({ ...config, turn }, query, limit, signal, charge),
        keep: async (result) => {
          if (!results) throw new Error('There is no store to keep results in.')
          return results.keep(result)
        },
        kept: async (id) => (namesResult(id) ? ((await results?.result(id)) ?? 'gone') : 'unknown'),
      }),
    })
  }
}
