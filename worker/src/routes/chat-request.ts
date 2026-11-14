// What the worker accepts in a chat request (/v1/chat/completions): the messages, the tools, and the
// options the model is called with, checked and cut down to what the model needs.
import * as z from '../zod'
import { MAX_ID_CHARS, badRequest, parse, part } from '../http'

const MAX_MESSAGES = 200
export const MAX_TOKENS = 16_384
export const MAX_CONTENT_CHARS = 200_000
const MAX_TOOLS = 64
const MAX_TOOL_CALLS = 32

const MAX_SCHEMA_DEPTH = 64
/** OpenAI's rule for function names. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Whether a JSON value nests objects or arrays more than `max` levels deep. Stops at `max`, so it can't overflow. */
function nestedDeeperThan(value: unknown, max: number): boolean {
  if (!value || typeof value !== 'object') return false
  if (max === 0) return true
  return Object.values(value).some((child) => nestedDeeperThan(child, max - 1))
}

// What the worker accepts in a chat request. Every part is a zod schema that keeps only the fields
// the model needs, so anything else a client added is dropped. A request is refused with the first
// thing wrong with it, in the words below: the client is told what the part needs, not zod's own
// description of the mismatch.

/** The body: a JSON object. Its fields are checked one by one, in the order the refusals are given. */
export const Body = part(
  z.object({
    messages: z.unknown().optional(),
    tools: z.unknown().optional(),
    tool_choice: z.unknown().optional(),
    max_tokens: z.unknown().optional(),
    stream: z.unknown().optional(),
    model: z.unknown().optional(),
  }),
  'body must be a JSON object',
)

/**
 * A tool call's id: 1 to 256 characters as JavaScript counts them. Not `.max()`: zod counts a string
 * over the limit by code point, which would let an id of emoji be twice as long.
 */
const isId = (id: string) => id.length > 0 && id.length <= MAX_ID_CHARS
const Id = z.string().refine(isId)
const ToolName = z.string().regex(TOOL_NAME)

const ToolCalls = part(
  z.array(z.unknown()).min(1).max(MAX_TOOL_CALLS),
  `tool_calls must be an array of 1 to ${MAX_TOOL_CALLS} calls`,
).pipe(
  z.array(
    part(
      z.object({
        id: Id,
        type: z.literal('function'),
        function: z.object({ name: ToolName, arguments: z.string() }),
      }),
      'each tool call needs an id, type "function", and a function with a name and string arguments',
    ),
  ),
)

/** An assistant message: its text, or the tools it called, with text or without. */
const AssistantMessage = z
  .object({ role: z.literal('assistant'), content: z.unknown().optional(), tool_calls: z.unknown().optional() })
  .transform((m, ctx) => {
    const refuse = (message: string) => {
      ctx.addIssue({ code: 'custom', message })
      return z.NEVER
    }
    if (m.tool_calls === undefined || m.tool_calls === null) {
      if (typeof m.content !== 'string') return refuse('assistant messages need string content or tool_calls')
      return { role: m.role, content: m.content }
    }
    if (m.content !== undefined && m.content !== null && typeof m.content !== 'string') {
      return refuse('assistant content must be a string or null')
    }
    const calls = ToolCalls.safeParse(m.tool_calls)
    if (!calls.success) return refuse(calls.error.issues[0].message)
    // The model accepts an empty string next to tool calls; OpenAI clients often send null.
    return { role: m.role, content: m.content ?? '', tool_calls: calls.data }
  })

const TOOL_MESSAGE = 'tool messages need a tool_call_id and string content'

/** One message, with the fields the model needs for its role. */
const Message = part(z.looseObject({}), 'each message must be an object').pipe(
  z.discriminatedUnion(
    'role',
    [
      z.object({ role: z.literal('system'), content: z.string({ error: 'system messages need string content' }) }),
      z.object({ role: z.literal('user'), content: z.string({ error: 'user messages need string content' }) }),
      AssistantMessage,
      z.object({
        role: z.literal('tool'),
        tool_call_id: z.string({ error: TOOL_MESSAGE }).refine(isId, { error: TOOL_MESSAGE }),
        content: z.string({ error: TOOL_MESSAGE }),
      }),
    ],
    { error: 'each message needs a role: system, user, assistant, or tool' },
  ),
)

const Messages = part(z.array(z.unknown()).min(1), 'messages must be a non-empty array')
  .refine((messages) => messages.length <= MAX_MESSAGES, { error: `at most ${MAX_MESSAGES} messages`, abort: true })
  .pipe(z.array(Message))

const TOOL = 'each tool needs type "function" and a function definition'
const TOOL_NAMES = 'tool names are 1 to 64 letters, digits, underscores, or dashes'

/** A tool as far as its name: a function tool. What else its function holds is read after the name is known to be new. */
const ToolHead = z.object(
  {
    type: z.literal('function', { error: TOOL }),
    function: z.looseObject(
      { name: z.string({ error: TOOL_NAMES }).regex(TOOL_NAME, { error: TOOL_NAMES }) },
      { error: TOOL },
    ),
  },
  { error: TOOL },
)

const ToolBody = z.object({
  description: z.string({ error: 'tool descriptions must be strings' }).optional(),
  // Passed on as it is. Bounded, so serializing the request (here and in the AI binding) can never
  // run out of stack.
  parameters: z
    .custom<Record<string, unknown>>(isObject, { error: 'tool parameters must be an object' })
    .refine((parameters) => !nestedDeeperThan(parameters, MAX_SCHEMA_DEPTH), {
      error: `tool parameters are nested more than ${MAX_SCHEMA_DEPTH} levels deep`,
    })
    .optional(),
})

/**
 * The tool definitions: function tools only, with unique names. Tools are read one at a time, so the
 * first thing wrong in the list is what the client is told.
 */
const Tools = part(
  z.array(z.unknown()).min(1).max(MAX_TOOLS),
  `tools must be an array of 1 to ${MAX_TOOLS} tools`,
).transform((list, ctx) => {
  const refuse = (message: string) => {
    ctx.addIssue({ code: 'custom', message })
    return z.NEVER
  }
  const names = new Set<string>()
  const tools: { type: 'function'; function: { name: string } & z.output<typeof ToolBody> }[] = []
  for (const item of list) {
    const head = ToolHead.safeParse(item)
    if (!head.success) return refuse(head.error.issues[0].message)
    const { name } = head.data.function
    if (names.has(name)) return refuse(`tool ${name} is defined twice`)
    names.add(name)
    const body = ToolBody.safeParse(head.data.function)
    if (!body.success) return refuse(body.error.issues[0].message)
    tools.push({ type: 'function', function: { name, ...body.data } })
  }
  return tools
})

// `none` is left out on purpose: the model ignores it and writes fake tool calls into the reply text.
// Clients that want no tool calls leave out `tools`.
const ToolChoice = part(
  z.union([
    z.enum(['auto', 'required']),
    z.object({ type: z.literal('function'), function: z.object({ name: ToolName }) }),
  ]),
  'tool_choice must be auto, required, or {"type":"function","function":{"name":...}}',
)

export const MaxTokens = part(z.int().min(1).max(MAX_TOKENS), `max_tokens must be an integer from 1 to ${MAX_TOKENS}`)
export const Stream = part(z.boolean().optional(), 'stream must be a boolean')

type Tools = z.output<typeof Tools>

/** What the model gets: the fields it needs from each part of the request, nothing else. */
interface ModelInputs {
  messages: z.output<typeof Messages>
  tools?: Tools
  tool_choice?: z.output<typeof ToolChoice>
}

function parseToolChoice(value: unknown, tools: Tools | undefined): z.output<typeof ToolChoice> {
  if (!tools) throw badRequest('tool_choice needs tools')
  if (value === 'none') throw badRequest('tool_choice none is not supported; leave out tools instead')
  const choice = parse(ToolChoice, value)
  if (typeof choice === 'string') return choice
  const { name } = choice.function
  if (!tools.some((tool) => tool.function.name === name)) {
    throw badRequest(`tool_choice names an unknown tool: ${name}`)
  }
  return choice
}

/**
 * Validates the conversation and tools, and returns only what the model needs.
 * `chars` counts message text, tool calls and results, and tool definitions, so tools can't get around
 * the size limit.
 */
export function parseModelInputs(body: z.output<typeof Body>): { inputs: ModelInputs; chars: number } {
  const inputs: ModelInputs = { messages: parse(Messages, body.messages) }
  if (body.tools !== undefined && body.tools !== null) inputs.tools = parse(Tools, body.tools)
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    inputs.tool_choice = parseToolChoice(body.tool_choice, inputs.tools)
  }

  // As OpenAI requires, an assistant message with tool calls is followed right away by one result per
  // call (in any order), before any other message. Ids only need to be unique within one assistant
  // message: results are paired with the calls right before them.
  let pending = new Set<string>()
  const unanswered = () => badRequest('each tool call needs its result right after the assistant message')
  let chars = 0
  for (const m of inputs.messages) {
    chars += m.content.length
    if (m.role === 'tool') {
      if (!pending.delete(m.tool_call_id)) {
        throw badRequest('each tool message must answer a call from the assistant message before it')
      }
      chars += m.tool_call_id.length
      continue
    }
    if (pending.size) throw unanswered()
    const toolCalls = 'tool_calls' in m ? m.tool_calls : undefined
    if (toolCalls) {
      pending = new Set(toolCalls.map((call) => call.id))
      if (pending.size !== toolCalls.length) throw badRequest('tool call ids in one message must be unique')
      chars += JSON.stringify(toolCalls).length
    }
  }
  if (pending.size) throw unanswered()
  if (inputs.tools) chars += JSON.stringify(inputs.tools).length
  return { inputs, chars }
}
