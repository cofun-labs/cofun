// zod, set up for the package. Import `z` from here, never from 'zod' (a lint error), as in every
// package. The harness runs only in vitest, where no content security policy applies; it sets zod up
// as the extensions do (jitless, so it never compiles parsers with `new Function`) so that whichever
// module imports zod first, the panel under test parses with the same zod it ships with.
import { z } from 'zod'

z.config({ jitless: true })

export { z }
