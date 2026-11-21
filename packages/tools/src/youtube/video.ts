// The site layer for a YouTube video in one of the user's tabs: which pages are videos, what the
// watch page says about one (title, channel, date, description, chapters, and its caption tracks),
// which caption track is read, and the transcript as YouTube's own transcript panel gives it, all
// parsed here, as they come from the tab (tab.ts), and turned into Markdown for the model.
//
// The transcript is the one the page shows under "Show transcript": its panel's request (get_panel)
// with the watch page's own parameters. The caption files the player loads (timedtext) need a token
// that only the page's own scripts make, and the older get_transcript endpoint now refuses requests,
// so neither is used, and nothing falls back to them.
import { z } from '../zod'

/** The only origin whose watch pages are read as videos; the others (m.youtube.com, youtu.be, which redirects) are read as pages. */
export const YOUTUBE = 'https://www.youtube.com'

/** The transcript panel the watch page opens, as its request names it. */
export const TRANSCRIPT_PANEL = 'PAmodern_transcript_view'

/** The id of the video a watch page on www.youtube.com shows; undefined for any other page. */
export function videoIdOf(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.origin !== YOUTUBE || parsed.pathname !== '/watch') return undefined
  const id = parsed.searchParams.get('v')
  return id && /^[\w-]{11}$/.test(id) ? id : undefined
}

/** YouTube's text: a plain string, or runs of text. */
const Text = z.union([
  z.looseObject({ simpleText: z.string() }).transform((text) => text.simpleText),
  z
    .looseObject({ runs: z.array(z.looseObject({ text: z.string() })) })
    .transform((text) => text.runs.map((run) => run.text).join('')),
])

const CaptionTrack = z.looseObject({
  languageCode: z.string(),
  /** `asr` for captions YouTube made from the speech. */
  kind: z.string().optional(),
  name: Text.optional(),
})
type CaptionTrack = z.infer<typeof CaptionTrack>

/** The parts of the watch page's player response that are read (ytInitialPlayerResponse). */
const PlayerResponse = z.looseObject({
  playabilityStatus: z.looseObject({ status: z.string(), reason: z.string().optional() }).optional(),
  videoDetails: z
    .looseObject({
      videoId: z.string(),
      title: z.string(),
      author: z.string(),
      lengthSeconds: z.string().optional(),
      shortDescription: z.string().optional(),
      isLive: z.boolean().optional(),
    })
    .optional(),
  microformat: z
    .looseObject({ playerMicroformatRenderer: z.looseObject({ publishDate: z.string().optional() }).optional() })
    .optional(),
  captions: z
    .looseObject({
      playerCaptionsTracklistRenderer: z
        .looseObject({
          captionTracks: z.array(CaptionTrack).optional(),
          audioTracks: z.array(z.looseObject({ defaultCaptionTrackIndex: z.number().optional() })).optional(),
        })
        .optional(),
    })
    .optional(),
})

/**
 * The chapters of the player's bar (the markers map of ytInitialData's player overlay): the ones
 * the channel wrote in the description, else those YouTube made. An entry that isn't a chapter
 * list is skipped.
 */
const Markers = z.array(
  z.looseObject({
    key: z.string(),
    value: z.looseObject({
      chapters: z
        .array(z.looseObject({ chapterRenderer: z.looseObject({ title: Text, timeRangeStartMillis: z.number() }) }))
        .optional(),
    }),
  }),
)

/** The request context of the watch page's own requests (ytcfg's INNERTUBE_CONTEXT), sent back with the language set. */
const RequestContext = z.looseObject({ client: z.looseObject({ hl: z.string() }) })

interface Chapter {
  title: string
  /** Where it starts, in seconds. */
  start: number
}

/** A caption track as the model is told of it: its name on YouTube, and whether YouTube made it from the speech. */
interface Track {
  language: string
  name: string
  auto: boolean
}

/** A video as its watch page describes it, before its transcript is read. */
export interface VideoPage {
  id: string
  title: string
  channel: string
  /** The day it was published, as YYYY-MM-DD, when the page says. */
  published?: string
  /** Its length in seconds; 0 while it is live. */
  length: number
  description: string
  chapters: Chapter[]
  /** Why the video has no transcript to read; undefined when it has one (see `track`). */
  noTranscript?: string
  /** The caption track to read, and the request to read it with. */
  track?: Track
  request?: { params: string; context: unknown }
}

/**
 * What the watch page says about the video `id`: undefined when it gives no details of it (the
 * page shows a video YouTube doesn't play, say), else the video, or why it can't be read, which no
 * part of the page is understood without.
 */
export function videoPage(
  id: string,
  raw: { player: unknown; markers: unknown; params: unknown; context: unknown },
): VideoPage | { unplayable: string } | { reason: string } {
  const player = PlayerResponse.safeParse(raw.player)
  if (!player.success) return { reason: "YouTube's page did not describe the video in a way that could be read." }
  const { videoDetails: details, playabilityStatus: playable, microformat, captions } = player.data
  if (!details) return { unplayable: playable?.reason ?? 'YouTube does not play it here.' }
  if (details.videoId !== id) return { reason: "YouTube's page described another video." }
  const published = microformat?.playerMicroformatRenderer?.publishDate?.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
  const video: VideoPage = {
    id,
    title: details.title,
    channel: details.author,
    published,
    length: Number(details.lengthSeconds) || 0,
    description: details.shortDescription ?? '',
    chapters: chaptersOf(raw.markers),
  }
  const list = captions?.playerCaptionsTracklistRenderer
  const tracks = list?.captionTracks ?? []
  if (playable && playable.status !== 'OK')
    return { ...video, noTranscript: `YouTube does not play the video here (${playable.reason ?? playable.status}).` }
  if (details.isLive) return { ...video, noTranscript: 'It is live: YouTube gives no transcript of a live stream.' }
  if (!tracks.length) return { ...video, noTranscript: 'It has no captions, so YouTube gives no transcript of it.' }
  const context = RequestContext.safeParse(raw.context)
  const params = z.string().min(1).safeParse(raw.params)
  if (!context.success || !params.success)
    return { reason: "YouTube's page lists captions for the video but did not offer its transcript as expected." }
  const track = chosenTrack(tracks, list?.audioTracks?.[0]?.defaultCaptionTrackIndex)
  // The panel gives the track of the language the request asks in, when the video has one.
  const asked = { ...context.data, client: { ...context.data.client, hl: track.language } }
  return { ...video, track, request: { params: params.data, context: asked } }
}

function chaptersOf(markers: unknown): Chapter[] {
  const parsed = Markers.safeParse(markers)
  if (!parsed.success) return []
  const of = (key: string) => parsed.data.find((marker) => marker.key === key && marker.value.chapters?.length)
  const list = of('DESCRIPTION_CHAPTERS') ?? of('AUTO_CHAPTERS')
  return (list?.value.chapters ?? []).map(({ chapterRenderer: chapter }) => ({
    title: oneLine(chapter.title),
    start: Math.floor(chapter.timeRangeStartMillis / 1000),
  }))
}

/**
 * The caption track to read: in the language spoken in the video (the one YouTube's speech
 * recognition made, else the player's default, else the first), and of those one the channel wrote
 * over one made from the speech, the language's own code over a regional one.
 */
function chosenTrack(tracks: CaptionTrack[], defaultIndex: number | undefined): Track {
  const spoken = (tracks.find((track) => track.kind === 'asr') ?? tracks[defaultIndex ?? 0] ?? tracks[0]).languageCode
  const base = (code: string) => code.split('-')[0].toLowerCase()
  const rank = (track: CaptionTrack) =>
    (track.kind === 'asr' ? 2 : 0) +
    (track.languageCode === spoken ? 0 : 1) +
    (base(track.languageCode) === base(spoken) ? 0 : 4)
  const [track] = [...tracks].sort((a, b) => rank(a) - rank(b))
  return { language: track.languageCode, name: oneLine(track.name ?? track.languageCode), auto: track.kind === 'asr' }
}

/** A line of the transcript panel, with its time as the panel shows it ("1:07"). */
const Segment = z.looseObject({ simpleText: z.string(), timestamp: z.string() })

/** An item of a section: a line of the transcript, or something else, which is skipped. */
const Item = z.looseObject({
  macroMarkersPanelItemViewModel: z
    .looseObject({
      item: z.looseObject({
        timelineItemViewModel: z
          .looseObject({
            contentItems: z.array(z.looseObject({ transcriptSegmentViewModel: Segment.optional() })),
          })
          .optional(),
      }),
    })
    .optional(),
})

/**
 * The transcript panel's answer (get_panel): a section for each chapter (one for a video without),
 * each of items, in order; a chapter in which nothing is said has none.
 */
const TranscriptPanel = z.looseObject({
  content: z.looseObject({
    engagementPanelSectionListRenderer: z.looseObject({
      content: z.looseObject({
        sectionListRenderer: z.looseObject({
          contents: z.array(
            z.looseObject({
              itemSectionRenderer: z.looseObject({ contents: z.array(Item).optional() }).optional(),
            }),
          ),
        }),
      }),
    }),
  }),
})

/** A line of the transcript: where it starts, in seconds, and what is said. */
export interface Line {
  start: number
  text: string
}

/** The lines of the transcript panel's answer, in order; undefined when it can't be read as one. */
export function transcriptLines(body: unknown): Line[] | undefined {
  const panel = TranscriptPanel.safeParse(body)
  if (!panel.success) return undefined
  const lines: Line[] = []
  for (const section of panel.data.content.engagementPanelSectionListRenderer.content.sectionListRenderer.contents)
    for (const item of section.itemSectionRenderer?.contents ?? [])
      for (const content of item.macroMarkersPanelItemViewModel?.item.timelineItemViewModel?.contentItems ?? []) {
        const segment = content.transcriptSegmentViewModel
        if (!segment) continue
        const start = seconds(segment.timestamp)
        if (start === undefined) return undefined
        const text = oneLine(segment.simpleText)
        if (text) lines.push({ start, text })
      }
  return lines
}

/** "1:02:03" or "2:03" in seconds; undefined for anything else. */
function seconds(time: string): number | undefined {
  if (!/^\d+(:\d{1,2}){1,2}$/.test(time)) return undefined
  return time.split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

/** A time as the transcript and the chapters mark it: [mm:ss], or [h:mm:ss] past an hour. */
function timeMark(total: number): string {
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h ? `[${h}:${two(m)}:${two(s)}]` : `[${two(m)}:${two(s)}]`
}

/** Text on one line, its runs of white space as one space. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** A paragraph of the transcript runs this long at most, in seconds, before the next line starts another. */
const PARAGRAPH_SECONDS = 30

/**
 * A video as Markdown: its title, its channel, date, and length, its chapters, its description, and
 * its transcript, if it has one, in paragraphs that start with their time ([mm:ss]), under a
 * heading for each chapter. What the page wrote is kept from passing for the Markdown's own
 * structure: a line of the description that opens like a heading is escaped, and every line of the
 * transcript starts with its time.
 */
export function videoMarkdown(video: VideoPage, lines: Line[] = []): string {
  const facts = [
    `- Channel: ${oneLine(video.channel)}`,
    ...(video.published ? [`- Published: ${video.published}`] : []),
    ...(video.length ? [`- Length: ${timeMark(video.length).slice(1, -1)}`] : []),
  ]
  const blocks = [`# ${oneLine(video.title)}`, facts.join('\n')]
  if (video.chapters.length)
    blocks.push(
      '## Chapters',
      video.chapters.map((chapter) => `- ${timeMark(chapter.start)} ${chapter.title}`).join('\n'),
    )
  const description = video.description.trim().replace(/^(\s*)#/gm, '$1\\#')
  if (description) blocks.push('## Description', description)
  if (lines.length) blocks.push('## Transcript', ...transcriptBlocks(lines, video.chapters))
  return blocks.join('\n\n')
}

/** The transcript's paragraphs, with a heading where each chapter starts. */
function transcriptBlocks(lines: Line[], chapters: Chapter[]): string[] {
  const blocks: string[] = []
  let next = 0
  let paragraph: Line[] = []
  const flush = () => {
    if (paragraph.length) blocks.push(`${timeMark(paragraph[0].start)} ${paragraph.map((line) => line.text).join(' ')}`)
    paragraph = []
  }
  for (const line of lines) {
    // The chapters that start by this line: the last of them is the one it is in.
    let chapter: Chapter | undefined
    while (next < chapters.length && chapters[next].start <= line.start) chapter = chapters[next++]
    if (chapter) {
      flush()
      blocks.push(`### ${chapter.title}`)
    } else if (paragraph.length && line.start - paragraph[0].start >= PARAGRAPH_SECONDS) flush()
    paragraph.push(line)
  }
  flush()
  return blocks
}
