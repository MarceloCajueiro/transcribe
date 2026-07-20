#!/usr/bin/env node
// transcribe — turn an audio/video file into a text transcript with Gemini STT.
// Zero dependencies: native fetch + the system ffmpeg/ffprobe binaries.
//
//   node transcribe.mjs <input.(mp3|m4a|wav|mp4|…)> [options]
//
// See `--help` for options, or the README for the full walkthrough.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { probeDuration, splitAudio } from './lib/audio.mjs';
import { sttSingle } from './lib/stt.mjs';
import { offsetTimestamps, formatTime } from './lib/text.mjs';

const MODEL = 'gemini-3.5-flash';
const DEFAULT_CHUNK_MINUTES = 10; // keeps each inline request well under the size limit
// 64 kbps mono ⇒ ~0.48 MB/min, ~0.64 MB/min once base64'd. 25 min ≈ 16 MB, the
// most that reliably fits the ~20 MB inline request limit.
const MAX_CHUNK_MINUTES = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOOLEAN_FLAGS = new Set(['timestamps', 'speakers', 'help']);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      // Boolean flags never consume the next token — otherwise
      // `--timestamps meeting.mp4` would swallow the input file.
      if (BOOLEAN_FLAGS.has(key)) { args[key] = true; continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`--${key} needs a value`);
      args[key] = next;
      i++;
    } else args._.push(a);
  }
  return args;
}

function number(value, fallback, name) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number (got "${value}")`);
  return n;
}

const HELP = `transcribe — audio/video -> text transcript (Gemini STT)

Usage:
  node transcribe.mjs <input> [options]

Input:
  Any audio or video file ffmpeg can read (.mp3, .m4a, .wav, .ogg, .flac,
  .mp4, .mov, …). Video works — the picture is dropped.

Options:
  --out <file>       Output transcript (default: <input-basename>.md).
  --lang <language>  Transcription language, e.g. "English", "pt-BR".
                     Default: auto (Gemini infers it from the speech).
  --timestamps       Prefix each paragraph with [mm:ss], offset across chunks.
  --speakers         Label speakers ("Speaker 1:", …) when more than one talks.
  --prompt <text>    Extra direction, e.g. names/jargon to spell correctly.
  --chunk-minutes <n>  Audio split size (default: ${DEFAULT_CHUNK_MINUTES}, max ${MAX_CHUNK_MINUTES}).
  --model <id>       STT model (default: ${MODEL}).
  --key <ENV_VAR>    Env var holding the API key (default: GEMINI_API_KEY).
                     Falls back to ~/.env if not set in the environment.
  --concurrency <n>  Parallel STT calls (default: 2).
  --workdir <dir>    Where audio chunks + partial transcripts are cached
                     (default: <out>.chunks/). Kept so a re-run resumes.
  --help             Show this help.

Examples:
  node transcribe.mjs interview.m4a --lang pt-BR --speakers
  node transcribe.mjs lecture.mp4 --lang English --timestamps --out lecture.md
`;

function buildPrompt({ lang, timestamps, speakers, extra }) {
  const lines = [
    'Transcribe the following audio verbatim.',
    lang ? `The speech is in ${lang}; transcribe it in that language.` : 'Transcribe in the language spoken.',
    'Output ONLY the transcript — no preamble, no summary, no commentary, no markdown fences.',
    'Use correct punctuation and break the text into readable paragraphs.',
    'Mark unintelligible passages as [inaudible].',
  ];
  if (speakers) {
    lines.push('If more than one person speaks, prefix each turn with "Speaker 1:", "Speaker 2:", … consistently.');
  } else {
    lines.push('Do not add speaker labels.');
  }
  if (timestamps) {
    lines.push('Start each paragraph with a [mm:ss] timestamp relative to the START of THIS audio clip.');
  } else {
    lines.push('Do not add timestamps.');
  }
  if (extra) lines.push(extra);
  return lines.join('\n');
}

function getApiKey(varName) {
  if (process.env[varName]) return process.env[varName];
  try {
    const line = readFileSync(join(homedir(), '.env'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${varName}=`));
    if (line) return line.slice(varName.length + 1).trim().replace(/^["']|["']$/g, '');
  } catch { /* no ~/.env */ }
  return null;
}

// Run `worker` over items with at most `n` in flight. Returns results in order.
async function pool(items, n, worker) {
  const results = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const input = resolve(args._[0]);
  if (!existsSync(input) || !statSync(input).isFile()) {
    throw new Error(`input file not found: ${args._[0]}`);
  }

  const out = resolve(args.out || `${basename(input, extname(input))}.md`);
  const workdir = resolve(args.workdir || `${out}.chunks`);
  const model = args.model || MODEL;
  const concurrency = Math.max(1, number(args.concurrency, 2, 'concurrency'));
  const chunkMinutes = number(args['chunk-minutes'], DEFAULT_CHUNK_MINUTES, 'chunk-minutes');
  const chunkSeconds = Math.min(MAX_CHUNK_MINUTES, Math.max(1, chunkMinutes)) * 60;
  if (chunkMinutes > MAX_CHUNK_MINUTES) {
    console.log(`[transcribe] --chunk-minutes capped at ${MAX_CHUNK_MINUTES} (inline request size limit).`);
  }
  const keyVar = args.key || 'GEMINI_API_KEY';
  const maxRetries = 5;

  const apiKey = getApiKey(keyVar);
  if (!apiKey) throw new Error(`API key not found. Set ${keyVar} in the environment or ~/.env.`);

  const prompt = buildPrompt({
    lang: args.lang && String(args.lang),
    timestamps: !!args.timestamps,
    speakers: !!args.speakers,
    extra: typeof args.prompt === 'string' ? args.prompt : null,
  });

  const duration = probeDuration(input);
  console.log(`[transcribe] ${basename(input)} · ${formatTime(duration)} · model=${model}`);
  mkdirSync(workdir, { recursive: true });

  console.log(`[transcribe] splitting into ${chunkSeconds / 60}-minute chunks…`);
  // The prompt and model fingerprint the transcript: change either and the
  // cached chunk transcripts no longer describe what was asked for.
  const audioChunks = splitAudio(input, workdir, chunkSeconds, `${model}\n${prompt}`);
  console.log(`[transcribe] ${audioChunks.length} chunk(s).`);

  const t0 = Date.now();
  const failures = [];
  const texts = await pool(audioChunks, concurrency, async (audio, idx) => {
    const n = idx + 1;
    const cached = `${audio}.txt`;
    if (existsSync(cached)) {
      console.log(`[transcribe] chunk ${n}/${audioChunks.length} cached, reusing.`);
      return readFileSync(cached, 'utf8');
    }
    // Transcription takes roughly real time in the worst case; be generous.
    const timeoutMs = Math.max(180000, chunkSeconds * 1000);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[transcribe] chunk ${n}/${audioChunks.length}, attempt ${attempt}…`);
        const text = await sttSingle({ file: audio, prompt, model, apiKey, timeoutMs });
        // Write-then-rename: a half-written cache file would be reused as if
        // it were the whole chunk on the next run.
        writeFileSync(`${cached}.tmp`, text);
        renameSync(`${cached}.tmp`, cached);
        return text;
      } catch (e) {
        console.log(`[transcribe] chunk ${n} attempt ${attempt} failed: ${e.message.slice(0, 120)}`);
        if (e.fatal) {
          console.log(`[transcribe] chunk ${n}: not retrying (the request itself is rejected).`);
          break;
        }
        if (attempt < maxRetries) await sleep(3000 * attempt); // backoff (also eases transient 429s)
      }
    }
    failures.push(n);
    return null;
  });

  if (failures.length) {
    console.error(`\n[transcribe] ${failures.length} chunk(s) failed after retries: ${failures.join(', ')}`);
    console.error('[transcribe] Re-run the same command to resume — cached chunks are reused.');
    process.exit(1);
  }

  // Each chunk was timestamped from its own zero — shift it to absolute time.
  // Offsets come from the chunks' measured durations, not the nominal split
  // size: ffmpeg cuts on frame boundaries, so the two drift apart.
  let elapsed = 0;
  const transcript = texts
    .map((t, i) => {
      if (!args.timestamps) return t.trim();
      const shifted = offsetTimestamps(t.trim(), elapsed);
      elapsed += probeDuration(audioChunks[i]);
      return shifted;
    })
    .join('\n\n');
  writeFileSync(out, `${transcript}\n`);

  const words = transcript.split(/\s+/).filter(Boolean).length;
  console.log(`\n[transcribe] done -> ${out}`);
  console.log(`[transcribe] ${words} words · ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min to transcribe`);
  console.log(`[transcribe] chunk cache kept at ${workdir} (delete to force a full re-run).`);
}

if (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`[transcribe] error: ${e.message}`);
    process.exit(1);
  });
}
