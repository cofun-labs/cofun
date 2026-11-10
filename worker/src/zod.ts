// Sets zod up for the worker. A module that builds schemas imports this file for its effect, and
// zod itself as a namespace (`import * as z from 'zod'`), which lets the bundler leave out the parts
// of zod that are not used; a `z` passed on from here would keep all of it.
import { config } from 'zod'

// Workers forbid generating code, so zod parses there without compiling its parsers. Say so, so the
// tests, which run in Node where compiling works, run the same parser as the deployed worker. zod
// reads this when a schema is built; a module's imports are evaluated before its own schemas.
config({ jitless: true })
