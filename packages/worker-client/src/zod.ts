// zod, set up for the package. Import `z` from here, never from 'zod' (a lint error): the setting
// below must be in place before any schema is built.
import { z } from 'zod'

// zod would otherwise compile its object parsers with `new Function`, which an extension's content
// security policy forbids; even its probe for whether that works is reported as a violation. zod
// reads this when a schema is built. The package sets it itself, so its schemas are safe whichever
// module of the extension imports zod first.
z.config({ jitless: true })

export { z }
