// How the panel reads and words credits the worker reports, where the whole panel cannot show it:
// the tests' worker never names a source of credits the panel does not know.
import { describe, expect, it } from 'vitest'
import { Credits, Grants } from '@cofun/base/credits'

describe('a source of credits the panel does not know yet', () => {
  const grant = { source: 'subscription', amount: 5_000_000_000, left: 1_000_000, grantedAt: 1, expiresAt: 2 }

  it('[@no-uc:contract] is read, in the credits and in their history, instead of failing the read', () => {
    expect(Grants.parse({ grants: [grant] }).grants).toEqual([grant])
    const credits = {
      balance: 1_000_000,
      free: { started: true, until: 2 },
      grants: [{ source: 'subscription', left: 1_000_000, expiresAt: 2 }],
      usage: { days: 30, byDay: [] },
    }
    expect(Credits.parse(credits)).toEqual(credits)
  })
})
