import { z } from '../zod'
import { pageTrashUndo } from './page-status'
import { pageEditUndo } from './page-writes'

export const ConfluenceUndo = z.union([pageEditUndo, pageTrashUndo])
export type ConfluenceUndo = z.output<typeof ConfluenceUndo>
