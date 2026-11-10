// Defines a tool from one zod schema of its arguments: the JSON Schema the model is sent, the check
// before the tool runs, and the type its code works with all come from that schema.
import type { ToolSpec } from './agent'
import { z } from './zod'

/** A tool's arguments: an object schema, so the model is sent `type: "object"`. */
type ArgsSchema = z.ZodObject

export interface ToolDefinition<S extends ArgsSchema> extends Omit<ToolSpec, 'parameters' | 'run' | 'preview'> {
  /**
   * The arguments. Describe what the model should know with `.describe()`, and give `error` where
   * the model needs more than zod's own words to correct its call.
   */
  args: S
  /** Runs the tool with the arguments as the schema gives them. */
  run: (args: z.output<S>, signal?: AbortSignal) => Promise<unknown>
}

/**
 * The tool as the agent takes it. Its `run` receives the arguments as an unknown value and parses
 * them first; arguments that don't parse are a plain error, which the model gets back and can correct.
 *
 * The agent runtime has already checked the model's arguments against `parameters` and converted
 * them where it could (see `toAgentTool` in agent.ts), so in a question this parse refuses next to
 * nothing (only what JSON Schema can't say, such as a whole number too large to be exact): it is
 * what turns the value into its type, and what a caller without the runtime gets.
 */
export function defineTool<S extends ArgsSchema>({ args, run, ...rest }: ToolDefinition<S>): ToolSpec {
  return {
    ...rest,
    parameters: parametersOf(args),
    run: async (given: unknown, signal) => run(parseArgs(args, given), signal),
  }
}

/** The JSON Schema of the arguments, as the model is sent it. */
function parametersOf(args: ArgsSchema): object {
  const { $schema: _, ...parameters } = z.toJSONSchema(args, {
    io: 'input',
    // zod bounds an integer by what a JavaScript number holds exactly; that tells the model nothing.
    override: ({ jsonSchema }) => {
      if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum
      if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum
    },
  })
  return parameters
}

/** The arguments as the schema gives them, or an error that says what is wrong with each one. */
function parseArgs<S extends ArgsSchema>(args: S, given: unknown): z.output<S> {
  const result = args.safeParse(given, {
    // For what a schema gives no `error` of its own: zod's words, with the argument they are about.
    error: (issue) => {
      // zod's own message, in English; `z.locales` would bundle every language.
      const said = z.config().localeError?.(issue)
      const text = typeof said === 'string' ? said : (said?.message ?? 'Invalid input')
      return issue.path?.length ? `\`${argumentPath(issue.path)}\`: ${text}` : text
    },
  })
  if (result.success) return result.data
  throw new Error(result.error.issues.map((issue) => issue.message).join('\n'))
}

/** Where in the arguments an issue is, as the model would write it: `filter[0].property`. */
function argumentPath(path: PropertyKey[]): string {
  return path.map((key, n) => (typeof key === 'number' ? `[${key}]` : `${n ? '.' : ''}${String(key)}`)).join('')
}
