import { memo } from 'react'
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

const nameOf: Record<string, string> = {
  read_page: 'Read the current page',
  search_pages: 'Search Confluence',
  edit_page: 'Replace text in Confluence',
}

export const ToolCall = memo(function ToolCall({
  tool,
  onAnswer,
}: {
  tool: ShownTool
  onAnswer: (allow: boolean) => void
}) {
  const name = nameOf[tool.name] ?? tool.name
  const asking = tool.status === 'confirm'
  return (
    <>
      <details className={`tool ${tool.status}`} open={asking}>
        <summary title={LABEL[tool.status]}>
          <span className="tool-mark" role="img" aria-label={LABEL[tool.status]}>
            <Icon name={MARK[tool.status]} />
          </span>
          {name}
        </summary>
        <div className="tool-body">
          {tool.preview && <pre>{tool.preview}</pre>}
          {tool.result && <pre>{tool.result}</pre>}
        </div>
      </details>
      {asking && (
        <div className="tool-confirm" role="group" aria-label="Confirm Confluence edit">
          <span>Apply this change?</span>
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
