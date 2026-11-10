// A database's properties: the schema of a new database, and changes to an existing one planned
// against its schema. A change that would lose values the user didn't ask to remove is refused
// before anything is sent: no type changes, no removing the title, no two properties or options
// with one name.
import { blockOps, collectionOps, type Operation, type RecordMap, type SchemaOption } from './api'
import type { Schema } from './markdown'
import { oneLine, plainText } from './props'

/** The property types a database can be given, by the names its schema uses. */
export const PROPERTY_TYPES = [
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
export type PropertyType = (typeof PROPERTY_TYPES)[number]

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

/** A property as the model describes it. */
export interface PropertySpec {
  name: string
  type: string
  options?: string[]
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
  | { action: 'add_property'; property: string; type: string; options?: string[] }
  | { action: 'rename_property'; property: string; to: string }
  | { action: 'remove_property'; property: string }
  | { action: 'add_options'; property: string; options: string[] }
  | { action: 'rename_option'; property: string; option: string; to: string }
  | { action: 'remove_option'; property: string; option: string }

export const SCHEMA_ACTIONS = [
  'add_property',
  'rename_property',
  'remove_property',
  'add_options',
  'rename_option',
  'remove_option',
] as const

/** A name for a property or an option: on one line, Markdown escapes undone. */
function nameArg(value: unknown, what: string): string {
  const name = typeof value === 'string' ? oneLine(plainText(value)) : ''
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
function optionNames(value: unknown, property: string, existing: SchemaOption[] = []): string[] {
  if (!Array.isArray(value) || !value.length) throw new SchemaError(`Give the options of “${property}” as a list.`)
  if (value.length > SCHEMA_MAX) throw new SchemaError(`At most ${SCHEMA_MAX} options can be added at once.`)
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
function propertyDef(spec: Record<string, unknown>, newId: () => string): PropertyDef {
  const name = nameArg(spec.name, 'A property name')
  const type = typeof spec.type === 'string' ? spec.type.trim().toLowerCase() : ''
  if (!PROPERTY_TYPES.includes(type as PropertyType))
    throw new SchemaError(
      `“${name}” can't be a ${type || 'property without a'} type. Use one of: ${PROPERTY_TYPES.join(', ')}.`,
    )
  const hasOptions = spec.options !== undefined && spec.options !== null
  if (type === 'select' || type === 'multi_select')
    return { name, type, options: hasOptions ? newOptions(optionNames(spec.options, name), newId) : [] }
  if (hasOptions)
    throw new SchemaError(
      type === 'status'
        ? `“${name}” is a status: it gets Notion's options (Not started, In progress, Done), which can't be chosen here.`
        : `“${name}” is a ${type.replace(/_/g, ' ')} property; only selects and multi-selects have options.`,
    )
  if (type === 'status') return statusDef(name, newId)
  return { name, type }
}

/** A key for a new property that `defs` doesn't use, like the four characters Notion's client picks. */
function newKey(defs: Defs, random: () => number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (;;) {
    const key = Array.from({ length: 4 }, () => chars[Math.floor(random() * chars.length)]).join('')
    if (!(key in defs) && key !== 'title') return key
  }
}

export interface SchemaOptions {
  newId?: () => string
  random?: () => number
}

/** The schema of a new database: its title column, then `specs` in order. Names must differ. */
export function newSchema(
  titleName: unknown,
  specs: unknown,
  { newId = () => crypto.randomUUID(), random = Math.random }: SchemaOptions = {},
): Schema {
  const defs: Defs = {
    title: { name: titleName === undefined ? 'Name' : nameArg(titleName, 'The title column'), type: 'title' },
  }
  if (specs !== undefined && specs !== null && !Array.isArray(specs))
    throw new SchemaError('`properties` must be a list of properties.')
  const list = (specs ?? []) as Record<string, unknown>[]
  if (list.length > SCHEMA_MAX)
    throw new SchemaError(`A database can be created with at most ${SCHEMA_MAX} properties.`)
  for (const spec of list) {
    const def = propertyDef(spec ?? {}, newId)
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

/** The `changes` argument, checked for shape before anything is asked of Notion. */
export function parseChanges(value: unknown): SchemaChange[] {
  if (!Array.isArray(value) || !value.length)
    throw new SchemaError('`changes` must be a list with at least one change.')
  if (value.length > SCHEMA_MAX) throw new SchemaError(`At most ${SCHEMA_MAX} changes can be made in one call.`)
  return value.map((raw: unknown, i) => {
    const c = (raw ?? {}) as Record<string, unknown>
    if (!SCHEMA_ACTIONS.includes(c.action as (typeof SCHEMA_ACTIONS)[number]))
      throw new SchemaError(`Change ${i + 1}: \`action\` must be one of ${SCHEMA_ACTIONS.join(', ')}.`)
    const need = (field: string) => {
      if (typeof c[field] !== 'string' || !(c[field] as string).trim())
        throw new SchemaError(`Change ${i + 1} (${String(c.action)}) needs \`${field}\`.`)
    }
    need('property')
    if (c.action === 'add_property') need('type')
    if (c.action === 'rename_property' || c.action === 'rename_option') need('to')
    if (c.action === 'rename_option' || c.action === 'remove_option') need('option')
    if (c.action === 'add_options' && !Array.isArray(c.options))
      throw new SchemaError(`Change ${i + 1} (add_options) needs \`options\`: a list of names.`)
    return c as unknown as SchemaChange
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
  { newId = () => crypto.randomUUID(), random = Math.random, now = Date.now() }: SchemaOptions & { now?: number } = {},
): SchemaPlan {
  const op = collectionOps(spaceId, collectionId)
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
): { operations: Operation[]; rows: string[] } {
  const op = blockOps(spaceId, Date.now())
  const operations: Operation[] = []
  const changed: string[] = []
  for (const id of rows) {
    const props = (recordMap.block?.[id]?.properties ?? {}) as Record<string, unknown>
    const values: Record<string, unknown[]> = {}
    for (const r of renames) {
      const text = (props[r.key] as [string?][] | undefined)?.[0]?.[0]
      if (typeof text !== 'string') continue
      const now =
        r.type === 'multi_select'
          ? text
              .split(',')
              .map((v) => (v === r.from ? r.to : v))
              .join(',')
          : text === r.from
            ? r.to
            : text
      if (now !== text) values[r.key] = [[now]]
    }
    if (Object.keys(values).length) {
      operations.push(op.setProperties(id, values))
      changed.push(id)
    }
  }
  return { operations, rows: changed }
}
