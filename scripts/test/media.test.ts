import { describe, expect, it } from 'vitest'
import { MediaArgumentError, mediaKey, mediaName, mediaUploads, mediaUrl, USAGE } from '../media.ts'

describe('mediaName', () => {
  it('keeps a plain name', () => {
    expect(mediaName('read-only-mode.gif')).toBe('read-only-mode.gif')
  })

  it('drops the directories', () => {
    expect(mediaName('/tmp/recordings/demo.gif')).toBe('demo.gif')
    expect(mediaName('../../demo.png')).toBe('demo.png')
  })

  it('replaces each run of other characters with one dash', () => {
    expect(mediaName('Screen Shot 2026-11-14 at 10.00.00.png')).toBe('Screen-Shot-2026-11-14-at-10.00.00.png')
    expect(mediaName('演示 demo?#&.gif')).toBe('demo.gif')
    expect(mediaName('a%2Fb.gif')).toBe('a-2Fb.gif')
  })

  it('lowercases the extension', () => {
    expect(mediaName('Demo.GIF')).toBe('Demo.gif')
  })

  it('refuses a name with nothing left before the extension', () => {
    expect(() => mediaName('演示.gif')).toThrow(MediaArgumentError)
    expect(() => mediaName('.gif')).toThrow(MediaArgumentError)
    expect(() => mediaName('...png')).toThrow(MediaArgumentError)
  })

  it('refuses a file that is not an image or a video', () => {
    expect(() => mediaName('notes.html')).toThrow(/notes\.html: not a file a PR comment can show/)
    expect(() => mediaName('demo.svg')).toThrow(MediaArgumentError)
    expect(() => mediaName('demo')).toThrow(MediaArgumentError)
  })
})

describe('mediaKey', () => {
  it('puts the file in the folder of its PR', () => {
    expect(mediaKey('367', 'demo.gif')).toBe('cofun/pr/367/demo.gif')
  })

  it('refuses a PR number that is not digits only', () => {
    for (const pr of ['', '0', '012', '#367', '36a', '3.5', '-1', '../1', '1/2', ' 367', 'demo.gif']) {
      expect(() => mediaKey(pr, 'demo.gif'), pr).toThrow(MediaArgumentError)
    }
  })
})

describe('mediaUrl', () => {
  it('is the key on the public domain', () => {
    expect(mediaUrl('cofun/pr/367/demo.gif')).toBe('https://static.cofun.cc/cofun/pr/367/demo.gif')
  })
})

describe('mediaUploads', () => {
  it('gives each file its key, content type, and URL', () => {
    expect(mediaUploads(['367', 'out/demo.gif', 'Before After.PNG', 'clip.mp4'])).toEqual([
      {
        file: 'out/demo.gif',
        key: 'cofun/pr/367/demo.gif',
        contentType: 'image/gif',
        url: 'https://static.cofun.cc/cofun/pr/367/demo.gif',
      },
      {
        file: 'Before After.PNG',
        key: 'cofun/pr/367/Before-After.png',
        contentType: 'image/png',
        url: 'https://static.cofun.cc/cofun/pr/367/Before-After.png',
      },
      {
        file: 'clip.mp4',
        key: 'cofun/pr/367/clip.mp4',
        contentType: 'video/mp4',
        url: 'https://static.cofun.cc/cofun/pr/367/clip.mp4',
      },
    ])
  })

  it('serves every allowed extension with its own content type', () => {
    const types = mediaUploads(['1', 'a.gif', 'a.png', 'a.jpg', 'b.jpeg', 'a.webp', 'a.mp4', 'a.webm']).map(
      (upload) => upload.contentType,
    )
    expect(types).toEqual([
      'image/gif',
      'image/png',
      'image/jpeg',
      'image/jpeg',
      'image/webp',
      'video/mp4',
      'video/webm',
    ])
  })

  it('asks for a PR number and at least one file', () => {
    expect(() => mediaUploads([])).toThrow(USAGE)
    expect(() => mediaUploads(['367'])).toThrow(USAGE)
  })

  it('refuses a file where the PR number goes', () => {
    expect(() => mediaUploads(['demo.gif', 'other.gif'])).toThrow(/"demo\.gif" is not a PR number/)
  })

  it('refuses two files that would get the same name', () => {
    expect(() => mediaUploads(['367', 'a/demo.gif', 'b/demo.GIF'])).toThrow(
      'a/demo.gif and b/demo.GIF would both be uploaded as cofun/pr/367/demo.gif. Rename one.',
    )
  })
})
