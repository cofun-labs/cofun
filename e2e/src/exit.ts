// What must happen before the process exits on Ctrl-C or a kill, which skips `finally` blocks:
// steps that must not stop halfway finish, then cleanups run.
const critical = new Set<Promise<unknown>>()
const cleanups = new Set<() => Promise<unknown>>()

/** Lets `step` finish even if the command is interrupted while it runs. */
export async function uninterruptible<T>(step: Promise<T>): Promise<T> {
  critical.add(step)
  try {
    return await step
  } finally {
    critical.delete(step)
  }
}

/** Runs `cleanup` if the command is interrupted; call the returned function once it's not needed. */
export function onInterrupt(cleanup: () => Promise<unknown>): () => void {
  cleanups.add(cleanup)
  return () => void cleanups.delete(cleanup)
}

/** Called on an interrupt, before the process exits. */
export async function beforeInterruptExit(): Promise<void> {
  await Promise.allSettled(critical)
  for (const cleanup of cleanups) await cleanup().catch(() => undefined)
}
