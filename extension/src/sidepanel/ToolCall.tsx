import { memo } from 'react'
import type { ToolStatus } from '../agent'
import type { Action } from '../tool'
import { describeCall } from '../tools'
import { Icon, type IconName } from './icons'

/** A tool call as the panel shows it. */
export interface ShownTool {
  id: string
  name: string
  args: unknown
  /** `confirm`: waiting for the user to allow or deny it. */
  status: 'running' | 'confirm' | ToolStatus
  /** What the model got back, or the error. Empty while running. */
  result: string
  /** What the call changes, in words, as the tool saw things before it ran. */
  preview?: string
  /** Set while `confirm` when the call is already running and asks this instead of whether to run. */
  question?: string
}

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
  skipped: 'Not run: step limit reached',
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
  // A name is read from the result only once the call worked: an error says nothing about the thing.
  const action = describeCall(tool.name, tool.args, tool.status === 'done' ? tool.result : undefined)
  const args = pretty(tool.args)
  const asking = tool.status === 'confirm' && onAnswer
  return (
    <>
      {/* Open while asking, so the user sees exactly what the tool would do. */}
      <details className={`tool ${tool.status}`} open={tool.status === 'confirm'}>
        <summary title={LABEL[tool.status]}>
          <span className="tool-mark" role="img" aria-label={LABEL[tool.status]}>
            <Icon name={MARK[tool.status]} />
          </span>{' '}
          <Phrase action={action} status={tool.status} />
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
      {asking && tool.question && (
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
