// pnpm media <pr-number> <file>…: uploads a PR's demo recording or screenshots to the public R2
// bucket and prints each file's URL, to embed in a PR comment (see "PR media" in
// docs/development.md). It uploads with the `cf` CLI and the Cloudflare login on this machine, so
// it holds no account id and no token; with several accounts in that login, CLOUDFLARE_ACCOUNT_ID
// picks the one that has the bucket.
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { MEDIA_BUCKET, MediaArgumentError, mediaUploads } from './media.ts'

function main(args: readonly string[]): void {
  // pnpm runs this in scripts/; INIT_CWD is the directory `pnpm media` was typed in.
  const cwd = process.env.INIT_CWD ?? process.cwd()
  const uploads = mediaUploads(args).map((upload) => ({ ...upload, path: resolve(cwd, upload.file) }))
  for (const { file, path } of uploads) {
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
      throw new MediaArgumentError(`${file}: no such file.`)
    }
  }
  for (const { path, key, contentType, url } of uploads) {
    execFileSync(
      'cf',
      ['r2', 'objects', 'put', key, '--bucket-name', MEDIA_BUCKET, '--content-type', contentType, '--file', path],
      // cf's own output (the object's metadata) is dropped; its errors are shown.
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
    console.log(url)
  }
}

try {
  main(process.argv.slice(2))
} catch (error) {
  // A failed upload has already printed cf's own error.
  console.error(error instanceof MediaArgumentError ? `error: ${error.message}` : 'error: the upload failed.')
  process.exitCode = 1
}
