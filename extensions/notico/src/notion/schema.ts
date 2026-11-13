// A database's properties: the schema of a new database, and changes to an existing one planned
// against its schema. A change that would lose values the user didn't ask to remove is refused
// before anything is sent: no type changes, no removing the title, no two properties or options
// with one name.
import { z } from '../zod'
import { blockOps, collectionOps, type Operation, type RecordMap, type SchemaOption } from './api'
import type { Schema } from './markdown'
import { oneLine, plainText } from './props'

/** The property types a database can be given, by the names its schema uses. */
const PROPERTY_TYPES = [
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'checkbox',
  'url',
  'email',
  'phone_number',
  'person',
] as const
type PropertyType = (typeof PROPERTY_TYPES)[number]

/** How many properties, options, or changes one call takes at most, so its preview stays readable. */
export const SCHEMA_MAX = 30
/** The colors Notion gives options, in the order new options get them. */
const COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']

/** Why a database change can't be made; nothing is sent when one is refused. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaError'
  }
}

/** A property in a schema, with the fields changes read. */
interface PropertyDef {
  name?: string
  type?: string
  options?: SchemaOption[]
  [field: string]: unknown
}
type Defs = Record<string, PropertyDef>

/** One change to a database's properties, as the model gives it. */
export type SchemaChange =
  | { action: 'add_property'; property: string; type: PropertyType; options?: string[] }
  | { action: 'rename_property'; property: string; to: string }
  | { action: 'remove_property'; property: string }
  | { action: 'add_options'; property: string; options: string[] }
  | { action: 'rename_option'; property: string; option: string; to: string }
  | { action: 'remove_option'; property: string; option: string }

const SCHEMA_ACTIONS = [
  'add_property',
  'rename_property',
  'remove_property',
  'add_options',
  'rename_option',
  'remove_option',
] as const

/** Text arguments drop Markdown escapes (see plainText), so the model must double a backslash. */
export const BACKSLASH = 'Markdown escapes are undone: write a backslash itself as \\\\.'

/** Which entry of a list argument an issue is about, counted from 1. */
const entryAt = (issue: { path?: PropertyKey[] }) => Number(issue.path?.[1]) + 1

/** A property's type; `where` says which entry an issue is about, as the model is told. */
const typeArg = (where: (issue: { path?: PropertyKey[] }) => string) =>
  z.enum(PROPERTY_TYPES, {
    error: (issue) => {
      const given = typeof issue.input === 'string' && issue.input.trim() ? oneLine(issue.input) : 'property without a'
      return `${where(issue)} can't be a ${given} type. Use one of: ${PROPERTY_TYPES.join(', ')}.`
    },
  })

/** Option names for a select or multi-select. */
const optionsArg = (description: string) =>
  z
    .array(z.string())
    .max(SCHEMA_MAX, { error: `At most ${SCHEMA_MAX} options can be added at once.` })
    .describe(description)
    .optional()

/** A property as the model describes it, and as it is described to the model. */
export const PROPERTY_SPEC = z.strictObject({
  name: z.string({ error: 'A property name must not be empty.' }).describe(`The property's name. ${BACKSLASH}`),
  type: typeArg((issue) => `Property ${entryAt(issue)}`),
  options: optionsArg("For select and multi_select: the options' names, without commas. A status gets Notion's own."),
})
type PropertySpec = z.output<typeof PROPERTY_SPEC>

/**
 * One entry of the `changes` argument, as it is described to the model: its action, and the fields
 * the actions take between them. Which fields an action needs is checked by parseChanges.
 */
export const CHANGE_ARG = z.strictObject({
  action: z.enum(SCHEMA_ACTIONS, {
    error: (issue) => `Change ${entryAt(issue)}: \`action\` must be one of ${SCHEMA_ACTIONS.join(', ')}.`,
  }),
  property: z
    .string({ error: (issue) => `Change ${entryAt(issue)} needs \`property\`.` })
    .describe('The property to change, or to add.'),
  type: typeArg((issue) => `Change ${entryAt(issue)}: the property`).optional(),
  options: optionsArg('For add_property and add_options: option names.'),
  option: z.string().describe('For rename_option and remove_option: the option.').optional(),
  to: z.string().describe(`For the renames: the new name. ${BACKSLASH}`).optional(),
})
type ChangeArg = z.output<typeof CHANGE_ARG>

/** A name for a property or an option: on one line, Markdown escapes undone. */
function nameArg(value: string, what: string): string {
  const name = oneLine(plainText(value))
  if (!name) throw new SchemaError(`${what} must not be empty.`)
  return name
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The property named `name` (any case) as [key, def]. */
function propertyNamed(defs: Defs, name: string): [string, PropertyDef] {
  const found = Object.entries(defs).find(([key, def]) => def && same(def.name ?? key, name))
  if (!found) {
    const names = Object.entries(defs).flatMap(([key, def]) => (def ? [def.name ?? key] : []))
    throw new SchemaError(`There is no property “${name}”. The properties are: ${names.join(', ')}.`)
  }
  return found
}

function checkFreeName(defs: Defs, name: string, except?: string) {
  const clash = Object.entries(defs).find(([key, def]) => def && key !== except && same(def.name ?? key, name))
  if (clash) throw new SchemaError(`There is already a property “${clash[1].name ?? clash[0]}”.`)
}

/** Option names for a select or multi-select, checked: on one line, no commas, none twice. */
function optionNames(value: string[], property: string, existing: SchemaOption[] = []): string[] {
  if (!value.length) throw new SchemaError(`Give the options of “${property}” as a list.`)
  const names: string[] = []
  for (const raw of value) {
    const name = nameArg(raw, `An option of “${property}”`)
    // A multi-select keeps its values as one comma-separated text.
    if (name.includes(',')) throw new SchemaError(`Option names can't contain commas: “${name}”.`)
    if ([...existing.map((o) => o.value), ...names].some((n) => same(n, name)))
      throw new SchemaError(`“${property}” already has an option “${name}”.`)
    names.push(name)
  }
  return names
}

/** The option of `def` named `name` (any case; as query_database shows it, or unescaped). */
function optionNamed(def: PropertyDef, name: string): SchemaOption {
  const found = (def.options ?? []).find((o) => same(o.value ?? '', name))
  if (!found) {
    const names = (def.options ?? []).map((o) => o.value).filter(Boolean)
    throw new SchemaError(
      `“${def.name}” has no option “${name}”.` + (names.length ? ` Its options are: ${names.join(', ')}.` : ''),
    )
  }
  return found
}

function newOptions(names: string[], newId: () => string, after = 0): SchemaOption[] {
  return names.map((value, i) => ({ id: newId(), value, color: COLORS[(after + i) % COLORS.length] }))
}

/** A status property with Notion's own options and groups, as its web client makes one. */
function statusDef(name: string, newId: () => string): PropertyDef {
  const options = [
    { id: newId(), value: 'Not started' },
    { id: newId(), value: 'In progress', color: 'blue' },
    { id: newId(), value: 'Done', color: 'green' },
  ]
  const group = (title: string, option: SchemaOption, color: string) => ({
    id: newId(),
    name: title,
    optionIds: [option.id],
    color,
  })
  return {
    name,
    type: 'status',
    options,
    groups: [
      group('To-do', options[0], 'gray'),
      group('In progress', options[1], 'blue'),
      group('Complete', options[2], 'green'),
    ],
    defaultOption: 'Not started',
  }
}

/** A new property's definition, checked. */
function propertyDef({ name: given, type, options }: PropertySpec, newId: () => string): PropertyDef {
  const name = nameArg(given, 'A property name')
  if (type === 'select' || type === 'multi_select')
    return { name, type, options: options ? newOptions(optionNames(options, name), newId) : [] }
  if (options)
    throw new SchemaError(
      type === 'status'
        ? `“${name}” is a status: it gets Notion's options (Not started, In progress, Done), which can't be chosen here.`
        : `“${name}” is a ${type.replace(/_/g, ' ')} property; only selects and multi-selects have options.`,
    )
  if (type === 'status') return statusDef(name, newId)
  return { name, type }
}

/**
 * A key for a new property that `defs` doesn't use, like the four characters Notion's client picks.
 * Never all digits: JavaScript puts such keys first in an object, so the property would move ahead
 * of the others.
 */
function newKey(defs: Defs, random: () => number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (;;) {
    const key = Array.from({ length: 4 }, () => chars[Math.floor(random() * chars.length)]).join('')
    if (!(key in defs) && key !== 'title' && !/^\d+$/.test(key)) return key
  }
}

export interface SchemaOptions {
  newId?: () => string
  random?: () => number
}

/** The schema of a new database: its title column, then `specs` in order. Names must differ. */
export function newSchema(
  titleName: string | undefined,
  specs: PropertySpec[] = [],
  { newId = () => crypto.randomUUID(), random = Math.random }: SchemaOptions = {},
): Schema {
  const defs: Defs = {
    title: { name: titleName === undefined ? 'Name' : nameArg(titleName, 'The title column'), type: 'title' },
  }
  for (const spec of specs) {
    const def = propertyDef(spec, newId)
    checkFreeName(defs, def.name!)
    defs[newKey(defs, random)] = def
  }
  return defs as Schema
}

/** An option renamed by a change: rows that have `from` get `to`. */
interface OptionRename {
  key: string
  type: string
  from: string
  to: string
}

export interface SchemaPlan {
  operations: Operation[]
  /** The schema after the changes. */
  schema: Schema
  /** What each change does, in words, in order. */
  lines: string[]
  /** Options renamed; every row that has one must be rewritten too (see renameInRows). */
  renames: OptionRename[]
}

/** The `changes` argument as changes, each with what its action needs, before anything is asked of Notion. */
export function parseChanges(changes: ChangeArg[]): SchemaChange[] {
  return changes.map((c, i): SchemaChange => {
    const refuse = (needs: string) => new SchemaError(`Change ${i + 1} (${c.action}) needs ${needs}.`)
    const need = <T extends string>(field: string, value: T | undefined): T => {
      if (!value?.trim()) throw refuse(`\`${field}\``)
      return value
    }
    const property = need('property', c.property)
    switch (c.action) {
      case 'add_property':
        return { action: c.action, property, type: need('type', c.type), options: c.options }
      case 'rename_property':
        return { action: c.action, property, to: need('to', c.to) }
      case 'remove_property':
        return { action: c.action, property }
      case 'add_options':
        if (!c.options) throw refuse('`options`: a list of names')
        return { action: c.action, property, options: c.options }
      case 'rename_option': {
        const to = need('to', c.to)
        return { action: c.action, property, option: need('option', c.option), to }
      }
      case 'remove_option':
        return { action: c.action, property, option: need('option', c.option) }
    }
  })
}

/**
 * The operations making `changes` to a database whose properties are `schema`, in order, each
 * against the schema as the ones before it left it. Refuses, before anything is sent, a change
 * that would lose values the user didn't ask to remove.
 */
export function planSchemaChanges(
  spaceId: string,
  collectionId: string,
  schema: Schema,
  changes: SchemaChange[],
  userId: string | undefined,
  { newId = () => crypto.randomUUID(), random = Math.random, now = Date.now() }: SchemaOptions & { now?: number } = {},
): SchemaPlan {
  const op = collectionOps(spaceId, collectionId, userId)
  const defs = structuredClone(schema) as Defs
  const operations: Operation[] = []
  const lines: string[] = []
  const renames: OptionRename[] = []
  /** The select or multi-select at `key`; a status's options are Notion's own, with groups this doesn't keep. */
  const withOptions = (key: string): PropertyDef => {
    const def = defs[key]
    if (def.type === 'select' || def.type === 'multi_select') return def
    if (def.type === 'status')
      throw new SchemaError(`“${def.name}” is a status: its options and their groups can only be changed in Notion.`)
    throw new SchemaError(`“${def.name}” is a ${String(def.type).replace(/_/g, ' ')} property; it has no options.`)
  }
  for (const change of changes) {
    const given = nameArg(change.property, 'A property name')
    switch (change.action) {
      case 'add_property': {
        const def = propertyDef({ name: given, type: change.type, options: change.options }, newId)
        checkFreeName(defs, def.name!)
        const key = newKey(defs, random)
        defs[key] = def
        operations.push(op.addProperty(key, def))
        const shown = def.type === 'select' || def.type === 'multi_select' ? optionList(def) : ''
        lines.push(`Add the property “${def.name}” (${String(def.type).replace(/_/g, ' ')}${shown})`)
        break
      }
      case 'rename_property': {
        const [key, def] = propertyNamed(defs, given)
        const to = nameArg(change.to, 'The new name')
        checkFreeName(defs, to, key)
        lines.push(`Rename the property “${def.name}” to “${to}”`)
        def.name = to
        operations.push(op.renameProperty(key, to))
        break
      }
      case 'remove_property': {
        const [key, def] = propertyNamed(defs, given)
        if (key === 'title' || def.type === 'title')
          throw new SchemaError(`“${def.name}” is the title column: every database has one, so it can't be removed.`)
        operations.push(...op.removeProperty(key, structuredClone(def)))
        delete defs[key]
        lines.push(`Remove the property “${def.name}”: its values in every row are lost`)
        break
      }
      case 'add_options': {
        const [key] = propertyNamed(defs, given)
        const def = withOptions(key)
        const added = newOptions(optionNames(change.options, def.name!, def.options), newId, def.options?.length ?? 0)
        def.options = [...(def.options ?? []), ...added]
        for (const o of added) operations.push(op.addOption(key, o))
        lines.push(`Add options to “${def.name}”: ${added.map((o) => o.value).join(', ')}`)
        break
      }
      case 'rename_option': {
        const [key] = propertyNamed(defs, given)
        const def = withOptions(key)
        const option = optionNamed(def, nameArg(change.option, 'The option'))
        const to = nameArg(change.to, 'The new name')
        if (to.includes(',')) throw new SchemaError(`Option names can't contain commas: “${to}”.`)
        const clash = (def.options ?? []).find((o) => o.id !== option.id && same(o.value, to))
        // Two options with one name would merge their rows' values for good.
        if (clash) throw new SchemaError(`“${def.name}” already has an option “${clash.value}”.`)
        lines.push(`Rename the option “${option.value}” of “${def.name}” to “${to}”, in every row that has it`)
        const earlier = renames.find((r) => r.key === key && r.to === option.value)
        if (earlier) earlier.to = to
        else renames.push({ key, type: String(def.type), from: option.value, to })
        option.value = to
        operations.push(op.updateOption(key, { ...option }))
        break
      }
      case 'remove_option': {
        const [key] = propertyNamed(defs, given)
        const def = withOptions(key)
        const option = optionNamed(def, nameArg(change.option, 'The option'))
        def.options = (def.options ?? []).filter((o) => o.id !== option.id)
        operations.push(op.removeOption(key, option.id))
        lines.push(`Remove the option “${option.value}” of “${def.name}”: rows that have it lose it`)
        break
      }
    }
  }
  operations.push(op.touch(now))
  return { operations, schema: defs as Schema, lines, renames: renames.filter((r) => r.from !== r.to) }
}

function optionList(def: PropertyDef): string {
  return def.options?.length ? `: ${def.options.map((o) => o.value).join(', ')}` : ''
}

/**
 * The changes to rows that renaming options takes: each row whose value is a renamed option (for
 * a multi-select, has it among its options) gets the new name, as Notion's client does.
 */
export function renameInRows(
  spaceId: string,
  rows: string[],
  recordMap: RecordMap,
  renames: OptionRename[],
  userId: string | undefined,
): { operations: Operation[]; rows: string[] } {
  const op = blockOps(spaceId, Date.now(), userId)
  const operations: Operation[] = []
  const changed: string[] = []
  // Each renamed option's name before the call, mapped to its name after it, by property. A row's
  // options are renamed in one pass, so renames that chain or swap names can't undo each other.
  const byKey = new Map<string, { type: string; names: Map<string, string> }>()
  for (const r of renames) {
    const entry = byKey.get(r.key) ?? { type: r.type, names: new Map<string, string>() }
    entry.names.set(r.from, r.to)
    byKey.set(r.key, entry)
  }
  for (const id of rows) {
    const row = recordMap.block?.[id]
    // A row that didn't come back can't be renamed with the others: it would lose its value.
    if (!row) throw new SchemaError("Notion didn't return every row, so the options can't be renamed in all of them.")
    const props = row.properties ?? {}
    const values: Record<string, unknown[]> = {}
    for (const [key, { type, names }] of byKey) {
      const text = (props[key] as [string?][] | undefined)?.[0]?.[0]
      if (typeof text !== 'string') continue
      const rename = (v: string) => names.get(v) ?? v
      const now = type === 'multi_select' ? text.split(',').map(rename).join(',') : rename(text)
      if (now !== text) values[key] = [[now]]
    }
    if (Object.keys(values).length) {
      operations.push(op.setProperties(id, values))
      changed.push(id)
    }
  }
  return { operations, rows: changed }
}
