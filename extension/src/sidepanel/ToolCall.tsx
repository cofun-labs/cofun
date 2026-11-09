import { memo } from 'react'
import type { ToolStatus } from '../agent'

/** A tool call as the panel shows it. */
export interface ShownTool {
  id: string
  name: string
  args: unknown
  status: 'running' | ToolStatus
  /** What the model got back, or the error. Empty while running. */
  result: string
}

const MARK: Record<ShownTool['status'], string> = {
  running: '⋯',
  done: '✓',
  failed: '✗',
  skipped: '–',
  stopped: '■',
}

const LABEL: Record<ShownTool['status'], string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Not run: step limit reached',
  stopped: 'Stopped',
}

/**
 * One tool call: collapsed to its name and input, expandable to the full arguments and result.
 * Memoized: text streaming into the reply leaves finished calls unchanged, so they skip re-rendering
 * (and re-formatting their JSON).
 */
export const ToolCall = memo(function ToolCall({ tool }: { tool: ShownTool }) {
  const input = summarize(tool.args)
  return (
    <details className={`tool ${tool.status}`}>
      <summary title={LABEL[tool.status]}>
        <span className="tool-mark">{MARK[tool.status]}</span> <span className="tool-name">{tool.name}</span>
        {input && <span className="tool-input"> {input}</span>}
      </summary>
      <div className="tool-body">
        <div className="tool-label">Arguments</div>
        <pre>{pretty(tool.args)}</pre>
        {/* A stopped tool that ended at all ended with an error, e.g. the abort. */}
        <div className="tool-label">
          {tool.status === 'failed' || (tool.status === 'stopped' && tool.result) ? 'Error' : 'Result'}
        </div>
        <pre>{tool.status === 'running' ? '…' : pretty(tool.result) || LABEL[tool.status]}</pre>
      </div>
    </details>
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
