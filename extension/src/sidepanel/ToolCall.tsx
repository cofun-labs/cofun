import { memo } from 'react'
import type { ToolStatus } from '../agent'

/** A tool call as the panel shows it. */
export interface ShownTool {
  id: string
  name: string
  args: unknown
  /** `confirm`: waiting for the user to allow or deny it. */
  status: 'running' | 'confirm' | ToolStatus
  /** What the model got back, or the error. Empty while running. */
  result: string
  /** What the call would change, in words, shown while the user is asked. */
  preview?: string
}

const MARK: Record<ShownTool['status'], string> = {
  running: '⋯',
  confirm: '?',
  done: '✓',
  failed: '✗',
  skipped: '–',
  stopped: '■',
  declined: '⊘',
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

/**
 * One tool call: collapsed to its name and input, expandable to the full arguments and result.
 * Memoized: text streaming into the reply leaves finished calls unchanged, so they skip re-rendering
 * (and re-formatting their JSON).
 */
export const ToolCall = memo(function ToolCall({
  tool,
  onAnswer,
}: {
  tool: ShownTool
  /** Set while the call waits for the user's OK; called with their answer. */
  onAnswer?: (allow: boolean) => void
}) {
  const input = summarize(tool.args)
  const asking = tool.status === 'confirm' && onAnswer
  return (
    <>
      {/* Open while asking, so the user sees exactly what the tool would do. */}
      <details className={`tool ${tool.status}`} open={tool.status === 'confirm'}>
        <summary title={LABEL[tool.status]}>
          <span className="tool-mark">{MARK[tool.status]}</span> <span className="tool-name">{tool.name}</span>
          {input && <span className="tool-input"> {input}</span>}
        </summary>
        <div className="tool-body">
          {tool.preview && (
            <>
              <div className="tool-label">Changes</div>
              <pre>{tool.preview}</pre>
            </>
          )}
          <div className="tool-label">Arguments</div>
          <pre>{pretty(tool.args)}</pre>
          {/* Nothing has run yet while the user is asked. */}
          {tool.status !== 'confirm' && (
            <>
              {/* A stopped tool that ended at all ended with an error, e.g. the abort. */}
              <div className="tool-label">
                {tool.status === 'failed' || (tool.status === 'stopped' && tool.result) ? 'Error' : 'Result'}
              </div>
              <pre>{tool.status === 'running' ? '…' : pretty(tool.result) || LABEL[tool.status]}</pre>
            </>
          )}
        </div>
      </details>
      {asking && (
        <div className="tool-confirm" role="group" aria-label={`Allow ${tool.name} to run?`}>
          <span>
            Allow <span className="tool-name">{tool.name}</span> to run?
          </span>
          <button className="primary" onClick={() => onAnswer(true)}>
            Allow
          </button>
          <button onClick={() => onAnswer(false)}>Deny</button>
        </div>
      )}
    </>
  )
})

/** A one-line description of the arguments, e.g. `query: "roadmap", limit: 5`. Empty for none. */
function summarize(args: unknown, max = 60): string {
  let line: string
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    line = Object.entries(args)
      .map(([key, value]) => `${key}: ${JSON.stringify(value) ?? String(value)}`)
      .join(', ')
  } else if (args === undefined) {
    line = ''
  } else {
    line = JSON.stringify(args) ?? ''
  }
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
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
