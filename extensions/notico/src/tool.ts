// Defines a tool from one zod schema of its arguments: the JSON Schema the model is sent, the check
// before the tool runs, and the type its code works with all come from that schema.
import type { ToolSpec } from './agent'
import { z } from './zod'

/** A verb in the forms a tool call's description needs: "read", "reading", "read". */
export interface Verb {
  base: string
  ing: string
  past: string
}

/**
 * What a tool call does, in the user's words: the verb, then what it acts on. `name` is the name of
 * the thing, shown set apart, when the call knows it: "Searched for *roadmap draft*" is
 * `{ verb: SEARCH, what: 'for', name: 'roadmap draft' }`, and "Moved 2 pages to the trash" is
 * `{ verb: MOVE, what: '2 pages to the trash' }`.
 */
export interface Action {
  verb: Verb
  what?: string
  name?: string
  /** Words after the name: "Moved *Notes* to the trash". */
  after?: string
}

/** The pages and databases a call read or changed, by id (32 hex digits, no dashes). */
export interface Touched {
  read?: string[]
  changed?: string[]
}

/** A tool as the extension has it: what the agent runs, and how the side panel describes a call. */
export interface Tool extends ToolSpec {
  /**
   * What a call that worked read and changed, from its arguments and what it returned, so the side
   * panel can sum them for a question, also in a saved session.
   */
  touched: (args: unknown, result: string) => Touched
  /**
   * A call in words, from the arguments the model gave (which may not parse) and, once it has run,
   * what it returned. Also used for calls in saved sessions.
   */
  describe: (args: unknown, result?: string) => Action
}

/** A tool's arguments: an object schema, so the model is sent `type: "object"`. */
type ArgsSchema = z.ZodObject

export interface ToolDefinition<S extends ArgsSchema> extends Omit<ToolSpec, 'parameters' | 'run' | 'preview'> {
  /**
   * The call in the user's words (see `Tool.describe`): from its arguments, or undefined when they
   * don't parse, and what it returned once it has run. A name it gives comes from the arguments or
   * the result, so a call that hasn't run, or that failed, falls back to general words.
   */
  describe: (args: z.output<S> | undefined, result: string | undefined) => Action
  /**
   * The pages and databases a call that worked read and changed (see `Tool.touched`), from its
   * arguments, or undefined when they don't parse, and what it returned. Searching and listing pages
   * read none; a change counts the pages it changed or made.
   */
  touched: (args: z.output<S> | undefined, result: string) => Touched
  /**
   * The arguments. Describe what the model should know with `.describe()`, and give `error` where
   * the model needs more than zod's own words to correct its call.
   */
  args: S
  /** Runs the tool with the arguments as the schema gives them. */
  run: (args: z.output<S>, signal?: AbortSignal) => Promise<unknown>
  /** What a call does, in words (see `ToolSpec.preview`), from the same arguments as `run` gets. */
  preview?: (args: z.output<S>) => string | undefined | Promise<string | undefined>
}

/**
 * The tool as the agent takes it. Its `run` receives the arguments as an unknown value and parses
 * them first; arguments that don't parse are a plain error, which the model gets back and can correct.
 *
 * The agent runtime has already checked the model's arguments against `parameters` and converted
 * them where it could (see `toAgentTool` in agent/calls.ts), so in a question this parse refuses next to
 * nothing (only what JSON Schema can't say, such as a whole number too large to be exact): it is
 * what turns the value into its type, and what a caller without the runtime gets.
 */
export function defineTool<S extends ArgsSchema>({
  args,
  run,
  preview,
  describe,
  touched,
  ...rest
}: ToolDefinition<S>): Tool {
  return {
    ...rest,
    touched: (given, result) => {
      const parsed = parseArgs(args, given)
      return touched(parsed.ok ? parsed.args : undefined, result)
    },
    describe: (given, result) => {
      const parsed = parseArgs(args, given)
      return describe(parsed.ok ? parsed.args : undefined, result)
    },
    parameters: parametersOf(args),
    run: async (given: unknown, signal) => {
      const parsed = parseArgs(args, given)
      if (!parsed.ok) throw new Error(parsed.refusal)
      return run(parsed.args, signal)
    },
    ...(preview && {
      preview: (given: unknown) => {
        // Arguments that don't parse have no preview: the run refuses them, and says why.
        const parsed = parseArgs(args, given)
        return parsed.ok ? preview(parsed.args) : undefined
      },
    }),
  }
}

/** The JSON Schema of the arguments, as the model is sent it. */
function parametersOf(args: ArgsSchema): object {
  const { $schema: _, ...parameters } = z.toJSONSchema(args, {
    io: 'input',
    // What zod adds that tells the model nothing: an integer's bounds at what a JavaScript number
    // holds exactly, and that the keys of an object of values by name are text.
    override: ({ jsonSchema }) => {
      if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum
      if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum
      const names = jsonSchema.propertyNames
      if (typeof names === 'object' && Object.keys(names).length === 1 && names.type === 'string')
        delete jsonSchema.propertyNames
    },
  })
  return parameters
}

/** The arguments as the schema gives them, or what is wrong with each one, for the model. */
function parseArgs<S extends ArgsSchema>(
  args: S,
  given: unknown,
): { ok: true; args: z.output<S> } | { ok: false; refusal: string } {
  // zod leaves a key named `__proto__` out of an object of values by name without a word; a call
  // must not go ahead with part of what it asked for dropped.
  const dropped = protoKey(given)
  if (dropped) return { ok: false, refusal: `\`${argumentPath(dropped)}\`: "__proto__" can't be used as a name.` }
  const result = args.safeParse(given, {
    // For what a schema gives no `error` of its own: zod's words, with the argument they are about.
    error: (issue) => {
      // zod's own message, in English; `z.locales` would bundle every language.
      const said = z.config().localeError?.(issue)
      const text = typeof said === 'string' ? said : (said?.message ?? 'Invalid input')
      return issue.path?.length ? `\`${argumentPath(issue.path)}\`: ${text}` : text
    },
  })
  if (result.success) return { ok: true, args: result.data }
  return { ok: false, refusal: result.error.issues.map((issue) => issue.message).join('\n') }
}

/** The path of the first key named `__proto__` anywhere in a value, if it has one. */
function protoKey(value: unknown, path: PropertyKey[] = []): PropertyKey[] | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const [n, item] of value.entries()) {
      const found = protoKey(item, [...path, n])
      if (found) return found
    }
    return undefined
  }
  if (Object.hasOwn(value, '__proto__')) return [...path, '__proto__']
  for (const [key, item] of Object.entries(value)) {
    const found = protoKey(item, [...path, key])
    if (found) return found
  }
  return undefined
}

/** Where in the arguments an issue is, as the model would write it: `filter[0].property`. */
function argumentPath(path: PropertyKey[]): string {
  return path.map((key, n) => (typeof key === 'number' ? `[${key}]` : `${n ? '.' : ''}${String(key)}`)).join('')
}
