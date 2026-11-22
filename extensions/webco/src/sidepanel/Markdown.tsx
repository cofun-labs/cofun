import { memo, useId, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { replyRules } from '@cofun/reply'

/** Tables scroll sideways inside the reply instead of widening it. */
function Table(props: ComponentProps<'table'>) {
  return (
    <div className="table-scroll">
      <table {...props} />
    </div>
  )
}

const COMPONENTS: Components = {
  table: ({ node: _node, ...props }) => <Table {...props} />,
}

// A single line break in a reply stays a line break, as the model wrote it, not a space.
const PLUGINS = [remarkGfm, remarkBreaks]
// What a reply may make the panel do: load nothing, and open only web pages (@cofun/reply).
const REHYPE_PLUGINS = [replyRules]

/**
 * The text of a reply, formatted from the Markdown the model wrote. The model's text is untrusted:
 * raw HTML in it is shown as text, never rendered (there is no HTML plugin), the output is React
 * elements, never `innerHTML`, and its links and images follow @cofun/reply's rules.
 *
 * Memoized: the panel re-renders on every keystroke and every streamed word, and a reply whose
 * text has not changed need not be parsed again.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  // Each reply's footnotes get ids of their own, so one reply's links can't jump into another's.
  const prefix = `${useId()}-`
  return (
    <ReactMarkdown
      remarkPlugins={PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      remarkRehypeOptions={{ clobberPrefix: prefix }}
      components={COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  )
})
