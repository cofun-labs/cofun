import { memo, useState } from 'react'
import type { Action } from '../tool'
import { describeCall } from '../tools'
import { allowSite } from '../web/tab'
import type { ShownTool } from './chat-session'
import { Icon, type IconName } from './icons'

const MARK: Record<ShownTool['status'], IconName> = {
  running: 'dots',
  confirm: 'ask',
  done: 'check',
  failed: 'close',
  skipped: 'minus',
  stopped: 'square',
  declined: 'slash',
}

const LABEL: Record<ShownTool['status'], string> = {
  running: 'Running',
  confirm: 'Waiting for your OK',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Not run',
  stopped: 'Stopped',
  declined: 'Declined',
}

const CHANGES: Record<ShownTool['status'], string> = {
  running: 'Changes (in progress)',
  confirm: 'Changes',
  done: 'Changes',
  failed: 'Changes (failed)',
  skipped: 'Changes (not made)',
  declined: 'Changes (not made)',
  stopped: 'Changes (stopped)',
}

/** Lead words for a call that did not end as asked; the rest is the call with its verb as is. */
const ENDED: Partial<Record<ShownTool['status'], string>> = {
  declined: 'Declined:',
  stopped: 'Stopped:',
  skipped: 'Not run:',
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** The call in words for its status, e.g. "Reading", "Read", "Couldn't read", around what it acts on. */
function Phrase({ action, status }: { action: Action; status: ShownTool['status'] }) {
  const { verb, what, name, after } = action
  const lead =
    status === 'running'
      ? capital(verb.ing)
      : status === 'done'
        ? capital(verb.past)
        : status === 'failed'
          ? `Couldn't ${verb.base}`
          : status === 'confirm'
            ? capital(verb.base)
            : `${ENDED[status]} ${verb.base}`
  return (
    <span className="tool-phrase">
      {[lead, what].filter(Boolean).join(' ')}
      {name && (
        <>
          {' '}
          <em>{name}</em>
        </>
      )}
      {after && ` ${after}`}
      {status === 'running' ? '…' : status === 'confirm' ? '?' : ''}
    </span>
  )
}

/**
 * One tool call: collapsed to what it did in words, expandable to what it changed, then the tool, its
 * arguments, and its result. Memoized: text streaming into the reply leaves finished calls unchanged,
 * so they skip re-rendering (and re-formatting their JSON).
 */
export const ToolCall = memo(function ToolCall({
  tool,
  onAnswer,
}: {
  tool: ShownTool
  /** Set while the call waits for the user's OK; called with their answer. */
  onAnswer?: (allow: boolean) => void
}) {
  // A name comes from the details only once the call worked: an error says nothing about the thing.
  const action = describeCall(tool.name, tool.args, tool.status === 'done' ? tool.details : undefined)
  const args = pretty(tool.args)
  const asking = tool.status === 'confirm' && onAnswer
  return (
    <>
      {/* Open while asking whether to run it, so the user sees exactly what the tool would do. A
          question the call asks as it runs (to read a site, to go on) is about something else. */}
      <details className={`tool ${tool.status}`} open={tool.status === 'confirm' && !tool.question}>
        <summary title={LABEL[tool.status]}>
          <span className="tool-mark" role="img" aria-label={LABEL[tool.status]}>
            <Icon name={MARK[tool.status]} />
          </span>{' '}
          {/* A call asking its own question (such as whether to go on) is already running: the chip says so. */}
          <Phrase action={action} status={tool.status === 'confirm' && tool.question ? 'running' : tool.status} />
        </summary>
        <div className="tool-body">
          {tool.preview && (
            <>
              {/* Say when the changes may not have been made: the error, if any, tells more. */}
              <div className="tool-label">{CHANGES[tool.status]}</div>
              <pre>{tool.preview}</pre>
            </>
          )}
          <div className="tool-label">Tool</div>
          <pre className="tool-name">{tool.name}</pre>
          {args !== '{}' && args !== '' && (
            <>
              <div className="tool-label">Arguments</div>
              <pre>{args}</pre>
            </>
          )}
          {/* Nothing has run yet while the user is asked whether to run it. */}
          {(tool.status !== 'confirm' || tool.question) && (
            <>
              {/* A stopped tool that ended at all ended with an error, e.g. the abort. */}
              <div className="tool-label">
                {tool.status === 'failed' || (tool.status === 'stopped' && tool.result) ? 'Error' : 'Result'}
              </div>
              <pre>
                {tool.status === 'running' || tool.status === 'confirm'
                  ? '…'
                  : pretty(tool.result) || LABEL[tool.status]}
              </pre>
            </>
          )}
        </div>
      </details>
      {asking && tool.question && tool.access && (
        <AccessCard question={tool.question} origin={tool.access} onAnswer={onAnswer} />
      )}
      {asking && tool.question && !tool.access && (
        <div className="tool-confirm" role="group" aria-label={tool.question}>
          <span>{tool.question}</span>
          <div className="tool-answers">
            <button onClick={() => onAnswer(false)}>Stop</button>
            <button className="primary" onClick={() => onAnswer(true)}>
              Continue
            </button>
          </div>
        </div>
      )}
      {asking && !tool.question && (
        <div className="tool-confirm" role="group" aria-label={`Allow this? ${capital(asked(action))}`}>
          <span>Allow this? {capital(asked(action))}</span>
          <div className="tool-answers">
            <button onClick={() => onAnswer(false)}>Deny</button>
            <button className="primary" onClick={() => onAnswer(true)}>
              Allow
            </button>
          </div>
        </div>
      )}
    </>
  )
})

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
      <span>
        {inChrome ? `${question} Answer Chrome's prompt.` : question}
        <span className="tool-confirm-note">
          Notico can then read pages on {new URL(origin).host} when a question needs them. Chrome asks you too.
        </span>
      </span>
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
              // The user said yes and Chrome failed: not a no, so the call doesn't show as declined.
              // The tool still finds the site not allowed, and fails.
              onAnswer(true)
            })
          }}
        >
          Allow
        </button>
      </div>
    </div>
  )
}

/** The call as a request, e.g. "move 1 page to the trash". */
function asked({ verb, what, name, after }: Action): string {
  return [verb.base, what, name, after].filter(Boolean).join(' ')
}

/** Arguments or a result for reading: JSON indented, anything else as is. */
function pretty(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  return JSON.stringify(value, null, 2) ?? ''
}
