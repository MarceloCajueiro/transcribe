// ffmpeg glue: probe the input and split it into small, uniform audio chunks.
// Uses the system `ffmpeg`/`ffprobe` binaries — no audio libraries.

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// 64 kbps mono MP3 keeps every chunk comfortably under the inline-request limit
// (10 min ≈ 4.8 MB ≈ 6.4 MB base64) and is plenty of fidelity for speech.
const BITRATE = '64k';
const SAMPLE_RATE = '16000';

export function probeDuration(file) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('ffprobe not found — install it ("brew install ffmpeg").');
  }
  return parseFloat((r.stdout || '0').trim()) || 0;
}

// Split into `seconds`-long mono MP3 chunks inside `workdir`. Video input works
// too: `-vn` drops the picture. Returns the chunk paths in order.
//
// `signature` fingerprints everything that changes the transcript (the prompt,
// the model). It and `seconds` are recorded only after ffmpeg finishes, so a
// resumed run reuses the chunks *only* when they match — a split interrupted
// halfway, or one cut at a different size, is redone instead of silently
// passing for a complete one.
export function splitAudio(input, workdir, seconds, signature) {
  const metaPath = join(workdir, 'split.json');
  if (existsSync(metaPath)) {
    let meta;
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { meta = null; }
    if (meta?.done && meta.seconds === seconds && meta.signature === signature) {
      const existing = listChunks(workdir);
      if (existing.length) return existing;
    }
  }

  // Stale, partial, or unknown: start from a clean workdir. Leaving old chunks
  // (or their cached transcripts) behind is how a resume returns wrong text.
  for (const f of readdirSync(workdir)) {
    if (/^chunk_\d+\.mp3/.test(f)) rmSync(join(workdir, f));
  }

  const r = spawnSync(
    'ffmpeg',
    [
      '-y', '-i', input,
      '-vn', '-ac', '1', '-ar', SAMPLE_RATE, '-b:a', BITRATE,
      '-f', 'segment', '-segment_time', String(seconds), '-reset_timestamps', '1',
      join(workdir, 'chunk_%03d.mp3'),
    ],
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('ffmpeg not found — install it ("brew install ffmpeg").');
  }
  if (r.status !== 0) {
    const stderr = r.stderr || '';
    if (/does not contain any stream/i.test(stderr)) {
      throw new Error('no audio track in the input file (a silent video has nothing to transcribe).');
    }
    throw new Error(`ffmpeg failed: ${stderr.slice(-500)}`);
  }

  const chunks = listChunks(workdir);
  if (!chunks.length) throw new Error('ffmpeg produced no audio chunks');
  writeFileSync(metaPath, JSON.stringify({ done: true, seconds, signature }));
  return chunks;
}

function listChunks(workdir) {
  return readdirSync(workdir)
    .filter((f) => /^chunk_\d+\.mp3$/.test(f))
    // Numeric sort: past chunk_999 ffmpeg stops padding, and plain sort() would
    // put "chunk_1000" before "chunk_999".
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => join(workdir, f));
}
