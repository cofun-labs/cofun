import { memo, useId, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

/** Only these links are made clickable; anything else in a reply is shown as text. */
function webUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

function Link({ href, children, ...rest }: ComponentProps<'a'>) {
  // A footnote and its way back are links within the reply. Their other attributes (an id, and what
  // a screen reader says, such as "Back to reference 1") come from the Markdown renderer, not the
  // model: Markdown links carry none.
  if (href?.startsWith('#'))
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    )
  const url = webUrl(href)
  if (!url) return <span>{children}</span>
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

/**
 * An image is never loaded: it would send a request to whatever host the reply names, and the
 * extension contacts only the hosts in PRIVACY.md. Its alt text stands in, linked to the image.
 */
function Image({ src, alt }: ComponentProps<'img'>) {
  const text = alt || 'Image'
  const url = webUrl(typeof src === 'string' ? src : undefined)
  return url ? <Link href={url}>{text}</Link> : <span>{text}</span>
}

/** Tables scroll sideways inside the reply instead of widening it. */
function Table(props: ComponentProps<'table'>) {
  return (
    <div className="table-scroll">
      <table {...props} />
    </div>
  )
}

const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <Link {...props} />,
  img: ({ node: _node, ...props }) => <Image {...props} />,
  table: ({ node: _node, ...props }) => <Table {...props} />,
}

// A single line break in a reply stays a line break, as the model wrote it, not a space.
const PLUGINS = [remarkGfm, remarkBreaks]

/**
 * The text of a reply, formatted from the Markdown the model wrote. The model's text is untrusted:
 * raw HTML in it is shown as text, never rendered (there is no HTML plugin), and the output is
 * React elements, never `innerHTML`.
 *
 * Memoized: the panel re-renders on every keystroke and every streamed word, and a reply whose
 * text has not changed need not be parsed again.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  // Each reply's footnotes get ids of their own, so one reply's links can't jump into another's.
  const prefix = `${useId()}-`
  return (
    <ReactMarkdown remarkPlugins={PLUGINS} remarkRehypeOptions={{ clobberPrefix: prefix }} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  )
})
