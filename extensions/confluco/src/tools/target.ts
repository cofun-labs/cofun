// The Confluence tab a tool works on: the one the question was asked on, once the user allows its site.
import type { ToolContext } from '@cofun/agent'
import { activeTab, confluenceOrigin, confluenceTabAt, mayUseSite, type ConfluenceTab } from '../confluence/tab'
import type { ToolMemory } from './memory'

/**
 * The Confluence tab the question was asked on. When Confluco may not use its site yet, the call's
 * card asks the user, whose Allow asks Chrome; a tab that is not a Confluence page is refused.
 */
export async function target({ memory, ask }: Pick<ToolContext<ToolMemory>, 'memory' | 'ask'>): Promise<ConfluenceTab> {
  const question = memory.confluenceQuestion
  const known = await question?.tab
  if (known) return known
  const captured = await (question ? question.captured : activeTab())
  if (!captured) throw new Error('Open a Confluence page in the current tab.')
  const origin = confluenceOrigin(captured)
  if (origin && !(await mayUseSite(origin))) {
    const host = new URL(origin).host
    const allowed = await ask({ text: `Allow Confluco to use Confluence on ${host}?`, access: origin })
    // Chrome granted it only if the user allowed it in its own prompt too.
    if (!allowed || !(await mayUseSite(origin)))
      throw new Error(
        `Confluco may not use ${host}: the user did not allow it, so nothing was read. Answer without it. ` +
          "If the user wants this Confluence site used, they can ask again. Don't ask for this site again unless the user asks.",
      )
  }
  const tab = await confluenceTabAt(captured)
  if (!tab) throw new Error('The current tab is not a Confluence page. Open a Confluence page and ask again.')
  if (question) question.tab = Promise.resolve(tab)
  return tab
}
