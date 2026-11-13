// What the model is told about each tool's arguments. The fixture is the JSON Schema of every tool
// as it was written by hand, before the schemas were generated from zod (#184): a generated schema
// must say the same, descriptions included. Change the fixture only when a tool's arguments are
// meant to change.
import { describe, expect, it } from 'vitest'
import { TOOLS } from '../src/tools'
import parameters from './fixtures/tool-parameters.json'

describe('tool parameters', () => {
  it('covers every tool', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(parameters).sort())
  })

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s tells the model its arguments as before', (name, tool) => {
    expect(tool.parameters).toEqual(parameters[name as keyof typeof parameters])
  })
})
