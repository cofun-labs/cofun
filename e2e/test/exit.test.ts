import { describe, expect, it } from 'vitest'
import { beforeInterruptExit, onInterrupt, uninterruptible } from '../src/exit'

describe('beforeInterruptExit', () => {
  it('waits for uninterruptible steps, then runs the cleanups still registered', async () => {
    const order: string[] = []
    let finish!: () => void
    const step = uninterruptible(new Promise<void>((r) => (finish = r)).then(() => void order.push('swap')))
    onInterrupt(async () => void order.push('cleanup'))
    const forget = onInterrupt(async () => void order.push('forgotten'))
    forget()
    const exiting = beforeInterruptExit()
    await Promise.resolve()
    expect(order).toEqual([])
    finish()
    await exiting
    await step
    expect(order).toEqual(['swap', 'cleanup'])
  })
})
