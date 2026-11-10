// The command line of `pnpm e2e`.
import { isNotion, toUuid } from '../../extension/src/notion/hosts'

export type Answer = 'allow' | 'deny'
export type LockAction = 'acquire' | 'refresh' | 'release' | 'status'

export type Command =
  | { name: 'help' }
  | { name: 'reload' }
  | { name: 'panel'; url?: string }
  | { name: 'ask'; question?: string; answer?: Answer; timeoutMs: number; json: boolean }
  | { name: 'page'; title: string; markdown: string }
  | { name: 'db'; title: string; rows: string[] }
  | { name: 'trash'; id: string }
  | { name: 'close' }
  | { name: 'lock'; action: LockAction; purpose?: string }

export interface Parsed {
  command: Command
  /** `--owner`: who takes the Canary lock. */
  owner?: string
}

export const DEFAULT_TIMEOUT_S = 300

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const USAGE = `Usage: pnpm e2e <command> [options]

Drives the shared Chrome Canary (CDP port 9228) for ai-e2e scenarios. See docs/bdd.md.

Commands:
  reload                       Build this checkout into the extension folder Canary loads, reload it,
                               and check it is enabled
  panel [url]                  Open the side panel for the Notion tab this tool opened, first going to
                               url if given (a tab is opened if there is none yet); starts a new chat.
                               Only on a page or database this tool created
  ask [question]               Send the question in the side panel, wait for the reply, and print it
                               with each tool call; without a question, keep waiting for the last reply
      --allow | --deny         Answer every approval prompt this way (otherwise stop at the first one)
      --timeout <seconds>      How long to wait for the reply (default ${DEFAULT_TIMEOUT_S})
      --json                   Print the reply as JSON
  page <title> [markdown…]     Create a throwaway private page; each argument is a line of Markdown
                               (taken as text, even "---" or "-h"; only --owner is an option)
  db <title> [row…]            Create a throwaway private task database (Name, Status, Due); each row
                               is "name|status|YYYY-MM-DD", status and date optional
  trash <id>                   Move a page or database this tool created to the trash
  close                        Close the Notion tab this tool opened (and its side panel)
  lock acquire [purpose]       Hold the Canary lock across several commands
  lock refresh|release|status

Options:
  --owner <name>               Lock owner (default: $E2E_OWNER, else the git branch)

Exit codes: 0 done, 1 failed, 2 usage error, 3 Canary busy (prints the holder),
4 a reply is waiting for approval (run "pnpm e2e ask --allow" or "--deny").`

const LOCK_ACTIONS = new Set<string>(['acquire', 'refresh', 'release', 'status'])
const ASK_FLAGS = new Set(['--allow', '--deny', '--timeout', '--json'])
/** Commands whose arguments are all text, so Markdown like "---" or "- item" passes as is. */
const TEXT_COMMANDS = new Set(['page', 'db'])

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    // After page or db, every argument is text (a title, or Markdown such as "---"), except --owner.
    const text = TEXT_COMMANDS.has(positional[0]) && arg !== '--owner' && !arg.startsWith('--owner=')
    if (!text && (arg === '-h' || arg === '--help')) return { command: { name: 'help' } }
    if (text || !arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq < 0 ? arg : arg.slice(0, eq)
    if (flags.has(name)) throw new UsageError(`${name} is given twice.`)
    if (name === '--owner' || name === '--timeout') {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1)
      if (value === undefined || value === '') throw new UsageError(`${name} needs a value.`)
      flags.set(name, value)
    } else if (name === '--allow' || name === '--deny' || name === '--json') {
      if (eq >= 0) throw new UsageError(`${name} takes no value.`)
      flags.set(name, true)
    } else {
      throw new UsageError(`Unknown option ${name}.`)
    }
  }

  const owner = flags.get('--owner') as string | undefined
  flags.delete('--owner')
  const [name, ...rest] = positional
  if (!name) return { command: { name: 'help' }, owner }
  if (name !== 'ask') {
    const misplaced = [...flags.keys()].find((f) => ASK_FLAGS.has(f))
    if (misplaced) throw new UsageError(`${misplaced} only goes with ask.`)
  }
  const most = (n: number) => {
    if (rest.length > n) throw new UsageError(`Too many arguments for ${name}: ${rest.slice(n).join(' ')}`)
  }

  switch (name) {
    case 'help':
      return { command: { name: 'help' }, owner }
    case 'reload':
    case 'close':
      most(0)
      return { command: { name }, owner }
    case 'panel': {
      most(1)
      const [url] = rest
      if (url !== undefined && !isNotion(url)) throw new UsageError(`Not a Notion URL: ${url}`)
      return { command: { name, url }, owner }
    }
    case 'ask': {
      most(1)
      if (flags.has('--allow') && flags.has('--deny')) throw new UsageError('Give --allow or --deny, not both.')
      const timeout = flags.get('--timeout')
      const seconds = timeout === undefined ? DEFAULT_TIMEOUT_S : Number(timeout)
      if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError(`Not a number of seconds: ${timeout}`)
      const question = rest[0]?.trim()
      if (rest[0] !== undefined && !question) throw new UsageError('The question is empty.')
      return {
        command: {
          name,
          question,
          answer: flags.has('--allow') ? 'allow' : flags.has('--deny') ? 'deny' : undefined,
          timeoutMs: seconds * 1000,
          json: flags.has('--json'),
        },
        owner,
      }
    }
    case 'page': {
      const [title, ...lines] = rest
      if (!title?.trim()) throw new UsageError('page needs a title.')
      return { command: { name, title: title.trim(), markdown: lines.join('\n') }, owner }
    }
    case 'db': {
      const [title, ...rows] = rest
      if (!title?.trim()) throw new UsageError('db needs a title.')
      return { command: { name, title: title.trim(), rows }, owner }
    }
    case 'trash': {
      most(1)
      const id = rest[0] && toUuid(rest[0])
      if (!id) throw new UsageError(rest[0] ? `Not a Notion id: ${rest[0]}` : 'trash needs the id of a page.')
      return { command: { name, id }, owner }
    }
    case 'lock': {
      const [action, ...purpose] = rest
      if (!action || !LOCK_ACTIONS.has(action)) throw new UsageError('lock needs acquire, refresh, release, or status.')
      if (action !== 'acquire' && purpose.length) throw new UsageError(`Too many arguments for lock ${action}.`)
      return {
        command: { name, action: action as LockAction, purpose: purpose.join(' ').trim() || undefined },
        owner,
      }
    }
    default:
      throw new UsageError(`Unknown command: ${name}`)
  }
}
