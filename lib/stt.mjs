// Gemini speech-to-text over the REST API — zero dependencies (native fetch).
// Each chunk is sent as inline base64 audio (chunks are sized to stay under the
// ~20 MB inline request limit), so no Files API upload dance is needed.

import { readFileSync } from 'node:fs';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Turn off the content filters so legitimate long-form speech (interviews,
// lectures, sermons, therapy sessions) isn't blocked mid-recording.
const SAFETY_OFF = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

// One STT call over one audio chunk. Returns the transcript text. Throws on HTTP
// error, timeout, or an empty response.
export async function sttSingle({ file, prompt, model, apiKey, timeoutMs = 180000 }) {
  const url = `${ENDPOINT}/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'audio/mp3', data: readFileSync(file).toString('base64') } },
        ],
      },
    ],
    // Long chunks produce long transcripts — don't let the default cap truncate.
    generationConfig: { temperature: 0, maxOutputTokens: 65536 },
    safetySettings: SAFETY_OFF,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`timeout after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    const err = new Error(`HTTP ${res.status}: ${detail}`);
    // 4xx other than "slow down"/"try again" won't fix itself — a bad key or a
    // malformed request fails identically on every retry. Don't burn the backoff.
    err.fatal = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
    throw err;
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason ?? 'unknown';
    throw new Error(`no transcript in response (reason=${reason})`);
  }
  return text;
}
