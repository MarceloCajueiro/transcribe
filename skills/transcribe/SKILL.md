---
name: transcribe
description: Turn an audio or video file into a text transcript (speech-to-text) with Gemini. Splits the recording into chunks, transcribes each with retry/resume, and joins them into one Markdown transcript — optionally with timestamps and speaker labels. Use when the user wants to transcribe audio/video, "what does this recording say", get the text of an interview, meeting, lecture, podcast, voice memo or video, or generate a transcript/subtitle-ready text from speech. The transcription language is chosen explicitly (or auto-detected).
user_invocable: true
---

# transcribe — audio/video → text transcript (Gemini STT)

Takes a recording and produces a single Markdown transcript. Handles the whole
pipeline: audio extraction → chunking → per-chunk transcription (with timeout,
retry, and resume) → timestamp offsetting → join.

## How it works

- **Split** — `ffmpeg` extracts the audio (video input works, the picture is dropped) and cuts it into ~10-minute mono MP3 chunks. Chunks stay small so each fits in one inline API request and one call can't time out on a two-hour file.
- **Transcribe** — each chunk is one Gemini call over the REST API, audio sent as inline base64. Up to 5 retries with backoff (rides out transient 429s and timeouts). Temperature 0, safety filters off so long-form speech isn't blocked mid-recording.
- **Resume** — every chunk's transcript is cached next to its audio in a workdir. Re-running the same command **reuses** finished chunks and only redoes what's missing — a long recording that hits a rate limit just needs a re-run, nothing is lost.
- **Stitch** — the model timestamps each chunk from its own zero, so every chunk is shifted to absolute time before joining.

## Prerequisites

- `node` (v18+, for native `fetch`) — no `npm install`.
- `ffmpeg` + `ffprobe` (`brew install ffmpeg`).
- A **Gemini API key** in `GEMINI_API_KEY` (environment or `~/.env`). Get one at https://aistudio.google.com/apikey.

The script ships inside this skill, next to this file. Run it with the path of the directory this SKILL.md was loaded from - that path is already known and always correct.

## Steps

### 1. Get the input
A path to any audio or video file ffmpeg can read (`.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`, `.mp4`, `.mov`, …).

### 2. Decide the transcription language
Ask the user (or infer from context) which **language** is spoken, and pass it as `--lang` (e.g. `English`, `pt-BR`, `Spanish`). You may omit it and let Gemini auto-detect — but when in doubt, set it explicitly. This is the one setting worth confirming up front.

### 3. (Optional) Pick the transcript shape
- `--timestamps` — prefix each paragraph with `[mm:ss]`, offset to absolute time across chunks. Useful for interviews, lectures, anything to be navigated or cited.
- `--speakers` — label turns `Speaker 1:`, `Speaker 2:` … when more than one person talks. Useful for interviews and meetings.
- `--prompt "…"` — names, jargon, or acronyms to spell correctly.

### 4. Run it
```bash
# SKILL_DIR = the directory holding this SKILL.md, i.e. the one you just read
node "$SKILL_DIR/transcribe.mjs" <input> --lang <language> [--timestamps] [--speakers] [--out <file.md>]
```
For a **long** recording (dozens of chunks), warn the user it can take a while and may hit the free-tier rate limit — if it stops with failures, just run the **same command again** to resume.

### 5. Deliver
Give the user the output path and the word count (printed at the end). Summarize the content only if asked.

## Options (see `--help`)

- `--lang <language>` — spoken language (default: auto-detect).
- `--timestamps` — `[mm:ss]` per paragraph, absolute across the whole file.
- `--speakers` — speaker labels when multiple people talk.
- `--prompt <text>` — extra direction (names, jargon, spelling).
- `--out <file>` — output transcript (default: `<input-basename>.md`).
- `--chunk-minutes <n>` — split size (default: `10`, max `25`).
- `--model`/`--concurrency`/`--workdir`/`--key` — see `--help`.

## Fixed decisions (unless the user asks otherwise)

- One Markdown transcript out; verbatim, no summarizing, no cleanup of filler words.
- Unintelligible passages marked `[inaudible]`.
- Chunk cache kept next to the output (`<out>.chunks/`) so re-runs resume. Mention it can be deleted to force a clean re-run.
