// pnpm media <pr-number> <file>…: uploads a PR's demo recording or screenshots to the public R2
// bucket behind static.cofun.cc and prints each file's URL, to embed in a PR comment (see "PR
// media" in docs/development.md). It uploads with the `cf` CLI and the Cloudflare login on this
// machine, so it holds no account id and no token; with several accounts in that login,
// CLOUDFLARE_ACCOUNT_ID picks the one that has the bucket.
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'

/** The R2 bucket. Its name is no secret: everything in it is public at ORIGIN. */
const BUCKET = 'cofun-static'

/** The bucket's public custom domain. */
const ORIGIN = 'https://static.cofun.cc'

/** The folder of this repository in the bucket, which other repositories may share. */
const REPOSITORY = 'cofun'

/** The files that can be uploaded, by extension, with the content type each is served with. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/** What is wrong with the arguments, said so that whoever typed them can correct them. */
class ArgumentError extends Error {}

/** One file to upload: where it is on disk, and what it becomes in the bucket. */
interface Upload {
  path: string
  key: string
  contentType: string
}

/**
 * The upload of one file of a PR, as `cofun/pr/<number>/<name>`. The name is the file's base name
 * with every run of characters other than letters, digits, `.`, `_`, and `-` replaced by one `-`,
 * so a URL never needs escaping and a name can't reach outside the PR's folder.
 */
function upload(pr: string, file: string, cwd: string): Upload {
  const base = basename(file)
  const extension = extname(base).toLowerCase()
  const contentType = CONTENT_TYPES[extension]
  if (contentType === undefined) {
    throw new ArgumentError(`${file}: not an image or a video. Use one of ${Object.keys(CONTENT_TYPES).join(', ')}.`)
  }
  const stem = base
    .slice(0, base.length - extension.length)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (stem === '') throw new ArgumentError(`${file}: the file name has no letters or digits before its extension.`)
  const path = resolve(cwd, file)
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new ArgumentError(`${file}: no such file.`)
  return { path, key: `${REPOSITORY}/pr/${pr}/${stem}${extension}`, contentType }
}

function main(args: readonly string[]): void {
  const [pr, ...files] = args
  if (pr === undefined || files.length === 0) throw new ArgumentError('Usage: pnpm media <pr-number> <file>…')
  if (!/^[1-9][0-9]*$/.test(pr)) {
    throw new ArgumentError(`"${pr}" is not a PR number: it must be digits only, such as 367.`)
  }
  // pnpm runs this in scripts/; INIT_CWD is the directory `pnpm media` was typed in. Every file is
  // checked before the first is uploaded.
  const cwd = process.env.INIT_CWD ?? process.cwd()
  const uploads = files.map((file) => upload(pr, file, cwd))
  const keys = uploads.map(({ key }) => key)
  const twice = keys.find((key, index) => keys.indexOf(key) !== index)
  if (twice !== undefined) throw new ArgumentError(`Two files would be uploaded as ${twice}. Rename one.`)
  for (const { path, key, contentType } of uploads) {
    execFileSync(
      'cf',
      ['r2', 'objects', 'put', key, '--bucket-name', BUCKET, '--content-type', contentType, '--file', path],
      // cf's own output (the object's metadata) is dropped; its errors are shown.
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
    console.log(`${ORIGIN}/${key}`)
  }
}

/** What went wrong, for the terminal. */
function failure(error: unknown): string {
  if (error instanceof ArgumentError) return error.message
  // cf ran and exited with an error, which it has already printed.
  if (error instanceof Error && 'status' in error && typeof error.status === 'number') return 'the upload failed.'
  // Anything else, such as cf not being installed, has said nothing yet.
  return error instanceof Error ? error.message : String(error)
}

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(`error: ${failure(error)}`)
  process.exitCode = 1
}
