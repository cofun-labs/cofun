// pnpm build: builds each product in products/, one after another, each into dist/<name>/ (see
// vite.config.ts, which builds the one product PRODUCT names). PRODUCT=<name> builds only that one.
// Arguments go to each `vite build` (`--mode development`, say).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const PRODUCTS = path.join(import.meta.dirname, 'products')

/** The products: the folders of products/ with a manifest config. */
const all = readdirSync(PRODUCTS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(PRODUCTS, entry.name, 'manifest.ts')))
  .map((entry) => entry.name)
  .sort()

const products = process.env.PRODUCT ? [process.env.PRODUCT] : all
for (const product of products) {
  console.log(`\nBuilding ${product} into dist/${product}/`)
  const run = spawnSync('pnpm', ['exec', 'vite', 'build', ...process.argv.slice(2)], {
    cwd: import.meta.dirname,
    env: { ...process.env, PRODUCT: product },
    stdio: 'inherit',
  })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
