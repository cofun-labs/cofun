import { describe, expect, it } from 'vitest'
import { rejectedKey } from '../src/models'
import type { OwnSetup } from '../src/own'
import { KEY_REJECTED } from '../src/provider'

const askedWith: OwnSetup = {
  service: 'openrouter',
  key: 'sk-or-test',
  model: { id: 'vendor/model', name: 'Model', contextLength: 100_000, price: { input: 1, output: 2 } },
}
const rejected = {
  status: 'error',
  message: 'OpenRouter turned your key away.',
  code: KEY_REJECTED,
  model: { service: 'openrouter', name: 'Model' },
  rounds: 1,
} as const

describe('rejectedKey', () => {
  it('[UC-WEBCO-AGENT-002-S03] marks the key the question was asked with when its provider turned it away', () => {
    expect(rejectedKey(askedWith, rejected)).toBe(askedWith)
  })

  it('[UC-WEBCO-AGENT-002-S03] marks no key for another failure, for the hosted model, or for a question asked without one', () => {
    expect(rejectedKey(askedWith, { ...rejected, code: 'rate_limited' })).toBeUndefined()
    expect(rejectedKey(askedWith, { ...rejected, model: { service: 'hosted' } })).toBeUndefined()
    expect(rejectedKey(askedWith, { ...rejected, model: undefined })).toBeUndefined()
    expect(rejectedKey(undefined, rejected)).toBeUndefined()
  })
})
