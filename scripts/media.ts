// Where a PR's demo recording or screenshots go in the public R2 bucket behind static.cofun.cc, for
// upload-media.ts (`pnpm media`, see "PR media" in docs/development.md). Everything here is pure:
// it reads no file and calls nothing.
import { basename, extname } from 'node:path'

/** The R2 bucket. Its name is no secret: everything in it is public at MEDIA_ORIGIN. */
export const MEDIA_BUCKET = 'cofun-static'

/** The bucket's public custom domain. */
const MEDIA_ORIGIN = 'https://static.cofun.cc'

/** The folder of this repository in the bucket, which other repositories may share. */
const REPOSITORY = 'cofun'

/** The files a PR comment can show, by extension, with the content type each is served with. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/** One file to upload: where it is on disk, and what it becomes in the bucket. */
export interface MediaUpload {
  file: string
  key: string
  contentType: string
  url: string
}

/** What is wrong with the arguments, said so that whoever typed them can correct them. */
export class MediaArgumentError extends Error {}

export const USAGE = 'Usage: pnpm media <pr-number> <file>…'

/**
 * The name a file has in the bucket: its base name, with every run of characters other than
 * letters, digits, `.`, `_`, and `-` replaced by one `-`, and its extension in lower case. So a
 * URL never needs escaping, and a name can't reach outside the PR's folder.
 */
export function mediaName(file: string): string {
  const base = basename(file)
  const extension = extname(base)
  const stem = base
    .slice(0, base.length - extension.length)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (stem === '') {
    throw new MediaArgumentError(`${file}: the file name has no letters or digits before its extension.`)
  }
  if (!Object.hasOwn(CONTENT_TYPES, extension.toLowerCase())) {
    throw new MediaArgumentError(
      `${file}: not a file a PR comment can show. Use one of ${Object.keys(CONTENT_TYPES).join(', ')}.`,
    )
  }
  return stem + extension.toLowerCase()
}

/** The content type a name from mediaName is served with. */
function mediaContentType(name: string): string {
  const type = CONTENT_TYPES[extname(name)]
  if (type === undefined) throw new MediaArgumentError(`${name}: unknown file type.`)
  return type
}

/** The object key of a PR's file: `cofun/pr/<number>/<name>`. */
export function mediaKey(pr: string, name: string): string {
  if (!/^[1-9][0-9]*$/.test(pr)) {
    throw new MediaArgumentError(`"${pr}" is not a PR number: it must be digits only, such as 367.`)
  }
  return `${REPOSITORY}/pr/${pr}/${name}`
}

/** The public URL of an object key. */
export function mediaUrl(key: string): string {
  return `${MEDIA_ORIGIN}/${key}`
}

/**
 * The uploads the command line asks for: `<pr-number> <file>…`. Throws a MediaArgumentError when
 * the PR number or a file name is not usable, or when two files would get the same name, so
 * nothing is uploaded unless everything can be.
 */
export function mediaUploads(args: readonly string[]): MediaUpload[] {
  const [pr, ...files] = args
  if (pr === undefined || files.length === 0) throw new MediaArgumentError(USAGE)
  const uploads = files.map((file) => {
    const name = mediaName(file)
    const key = mediaKey(pr, name)
    return { file, key, contentType: mediaContentType(name), url: mediaUrl(key) }
  })
  const seen = new Map<string, string>()
  for (const { file, key } of uploads) {
    const other = seen.get(key)
    if (other !== undefined) {
      throw new MediaArgumentError(`${other} and ${file} would both be uploaded as ${key}. Rename one.`)
    }
    seen.set(key, file)
  }
  return uploads
}
