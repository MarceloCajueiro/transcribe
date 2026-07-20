# transcribe

Turn a recording into text — **audio or video → one Markdown transcript.**

`transcribe` extracts the audio, splits it into chunks, transcribes each with
[Gemini](https://ai.google.dev/gemini-api/docs/audio), and joins the result into a single
transcript. It's built for **long** recordings: every chunk is cached, so if a run hits a
rate limit you just run it again and it resumes.

- 🎙️ **mp3 / m4a / wav / ogg / flac / mp4 / mov** in, **Markdown** out
- 🌍 Any language (`--lang`), auto-detected by default
- ⏱️ Optional `[mm:ss]` **timestamps**, correct across the whole file
- 🗣️ Optional **speaker labels** for interviews and meetings
- ♻️ **Resumable** — per-chunk cache; re-run to pick up where it stopped
- 📦 **Zero npm dependencies** — native `fetch` + the system `ffmpeg`
- 🤖 Installable as a [Claude Code](https://docs.claude.com/en/docs/claude-code) skill

The mirror image of [narrate](https://github.com/MarceloCajueiro/narrate) (document → narrated audio).

---

## Requirements

- [Node](https://nodejs.org) v18+ (for native `fetch`) — no `npm install`.
- [`ffmpeg`](https://ffmpeg.org) + `ffprobe` — `brew install ffmpeg`
- A **Gemini API key** — get one free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

Set the key in your environment (or in `~/.env`):

```bash
export GEMINI_API_KEY=your-key-here
```

---

## Quick start

```bash
git clone https://github.com/MarceloCajueiro/transcribe.git
cd transcribe

# Transcribe an interview in Brazilian Portuguese, with speaker labels
node transcribe.mjs interview.m4a --lang pt-BR --speakers

# A lecture video, with timestamps, to a specific output file
node transcribe.mjs lecture.mp4 --lang English --timestamps --out lecture.md

# Just the text, language auto-detected
node transcribe.mjs voice-memo.m4a
```

Output goes to `<input-basename>.md` unless you pass `--out`.

---

## Options

| Option | Default | What it does |
|---|---|---|
| `--lang <language>` | auto | Spoken language, e.g. `English`, `pt-BR`, `Spanish`. Auto-detected if omitted; set it for short/noisy audio or mixed languages. |
| `--timestamps` | off | Prefix each paragraph with `[mm:ss]`, offset to absolute time across chunks. |
| `--speakers` | off | Label turns `Speaker 1:`, `Speaker 2:` … when more than one person talks. |
| `--prompt <text>` | — | Extra direction, e.g. names, jargon or acronyms to spell correctly. |
| `--out <file>` | `<input-basename>.md` | Output transcript path. |
| `--chunk-minutes <n>` | `10` | Audio split size, capped at `25` (above that a chunk exceeds the ~20 MB inline request limit). |
| `--model <id>` | `gemini-3.5-flash` | Model used for transcription. |
| `--concurrency <n>` | `2` | Parallel API calls. |
| `--workdir <dir>` | `<out>.chunks/` | Audio + partial-transcript cache (kept between runs to resume). |
| `--key <ENV_VAR>` | `GEMINI_API_KEY` | Env var holding the API key (falls back to `~/.env`). |

---

## How it works

1. **Split** — `ffmpeg` extracts the audio (video works, `-vn` drops the picture) and cuts it into ~10-minute 64 kbps mono MP3 chunks — small enough to send inline in one request, short enough that no single call times out.
2. **Transcribe** — one Gemini call per chunk over the REST API, audio inlined as base64. Temperature 0, up to 5 retries with backoff to ride out transient 429s. Safety filters are off so long-form speech isn't blocked mid-recording.
3. **Resume** — each chunk's transcript is cached next to its audio; a re-run reuses finished chunks and only redoes the missing ones. Nothing is lost to a mid-run rate limit.
4. **Stitch** — the model timestamps each chunk from its own zero, so chunks are shifted to absolute time before being joined.

---

## Notes & limits

- **Long recordings cost time and quota.** A two-hour interview is a dozen API calls. On the free tier you may hit the daily/rate limit — the run stops with the failed chunk numbers; **run the same command again** to resume once quota is back (or enable billing).
- **The chunk cache** lives at `<out>.chunks/`. Delete it to force a clean re-run.
- **Speaker labels are per chunk** — the model can't hear across the cut, so "Speaker 1" in chunk 3 isn't guaranteed to be the same person as in chunk 1. For stricter diarization, raise `--chunk-minutes` (up to `25`) so there are fewer cuts.
- **Changing the options re-does the work.** The cache is keyed by the split size, the model and the prompt, so adding `--speakers` (or switching `--lang`) correctly re-transcribes instead of handing back the old text. Re-running the *same* command resumes.
- **Transcription is verbatim**, including filler words. Ask Claude to clean it up afterwards if you want prose.

Run `node test.mjs` for the self-check on timestamp offsetting.

---

## Install as a Claude Code skill

```
/plugin marketplace add MarceloCajueiro/claude-plugins
/plugin install transcribe@cajueiro-plugins
```

Then ask Claude to "transcribe this interview in Portuguese" and it will drive the tool.

---

## License

MIT © Marcelo Cajueiro — [cajueiro.tech](https://cajueiro.tech)
