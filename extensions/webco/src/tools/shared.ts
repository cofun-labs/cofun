// How the side panel words a tool's call (see `Tool.describe`).
import type { Verb } from '../tool'

export const verb = (base: string, ing: string, past: string): Verb => ({ base, ing, past })
