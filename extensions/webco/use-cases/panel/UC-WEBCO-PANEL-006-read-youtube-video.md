# UC-WEBCO-PANEL-006: Read the YouTube video in a tab

## Behavior

A user watching a YouTube video asks the assistant about it, to summarize it or save its key points to their notes. Reading the current tab, or a tab they added, on a YouTube video gives the video's title, channel, date, chapters, description, and what is said in it: the transcript YouTube shows, in paragraphs that start with their time, so a reply can cite a moment and link to it. It is read in the user's own tab, on YouTube once they allowed the site, as reading any other page is. When there is no transcript, the assistant is told so and why, never left to guess what the video says.

Key constraint:

- A video or transcript YouTube did not give as expected is not read at all: the question stops, no other way of getting it is tried, and nothing is sent to YouTube again.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-WEBCO-PANEL-006-S01 | P1 | ✅ | Given a video with chapters and captions open in the current tab, on YouTube the user allowed; when the assistant reads the tab; then it gets the video's title, channel, date, chapters, and description, and its transcript in paragraphs that start with their time, under a heading for each chapter. |
| UC-WEBCO-PANEL-006-S02 | P1 | ✅ | Given a video with captions in its spoken language written for it, others made from the speech, and translations; when the assistant reads it; then the written captions in the spoken language are asked for, and the assistant is told which captions were asked for. |
| UC-WEBCO-PANEL-006-S03 | P1 | ✅ | Given a video with no captions, or a live stream; when the assistant reads it; then it is told there is no transcript and why, and gets the video's title, channel, and description. |
| UC-WEBCO-PANEL-006-S04 | P1 | ✅ | Given YouTube answers the transcript's request with an error or with something that is not a transcript; when the assistant reads the video; then the question stops, the user is told the transcript was not read, and nothing is sent to YouTube again. |
| UC-WEBCO-PANEL-006-S05 | P2 | ✅ | Given YouTube turns the request away for coming too often; when the assistant reads the video; then the question stops and the user is told why. |
| UC-WEBCO-PANEL-006-S06 | P2 | ✅ | Given a video with a transcript longer than one part of a result; when the assistant reads it; then it gets the first part, with an outline by chapter, and can read the rest from the device. |
| UC-WEBCO-PANEL-006-S07 | P2 | ✅ | Given a YouTube page that is not a video's watch page, or a video YouTube doesn't play; when the assistant reads the tab; then it reads the page as it reads any other, and for the video is told there is no transcript. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-WEBCO-PANEL-006-S08 | P1 | ✅ | Given a real YouTube video with chapters and captions, in a tab the user added to a question; when they ask to summarize it with the moments it covers; then the reply follows the video's transcript and cites times from it. |
