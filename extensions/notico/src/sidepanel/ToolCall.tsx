import { ToolCall as SharedToolCall, type ShownTool } from '@cofun/base/ui'
import { useState } from 'react'
import { describeCall } from '../tools'
import { allowSite } from '../web/tab'

export type { ShownTool } from '@cofun/base/ui'

export function ToolCall({ tool, onAnswer }: { tool: ShownTool; onAnswer?: (allow: boolean) => void }) {
  return <SharedToolCall tool={tool} describe={describeCall} renderAccess={renderAccess} onAnswer={onAnswer} />
}

function renderAccess(question: string, origin: string, onAnswer: (allow: boolean) => void) {
  return <AccessCard question={question} origin={origin} onAnswer={onAnswer} />
}

/**
 * A call asking to read a site: Allow asks Chrome for that origin, whose own prompt has the last
 * word. Chrome takes the request only in the click's own handler. While its prompt is open the
 * buttons are off, so a second click can't queue another prompt behind it.
 */
function AccessCard({
  question,
  origin,
  onAnswer,
}: {
  question: string
  origin: string
  onAnswer: (allow: boolean) => void
}) {
  const [inChrome, setInChrome] = useState(false)
  return (
    <div className="tool-confirm" role="group" aria-label={question} aria-busy={inChrome}>
      <span>{inChrome ? `${question} Answer Chrome's prompt.` : question}</span>
      <div className="tool-answers">
        <button disabled={inChrome} onClick={() => onAnswer(false)}>
          Deny
        </button>
        <button
          className="primary"
          disabled={inChrome}
          onClick={() => {
            setInChrome(true)
            allowSite(origin).then(onAnswer, (err: unknown) => {
              console.error('Could not ask Chrome for access to the site', err)
              onAnswer(false)
            })
          }}
        >
          Allow
        </button>
      </div>
    </div>
  )
}
