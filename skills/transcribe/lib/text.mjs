// Transcript post-processing. The model timestamps each chunk relative to that
// chunk's own start, so every chunk after the first has to be shifted forward.

// Shift every [mm:ss] / [hh:mm:ss] marker in `text` by `offsetSeconds`, and
// re-render as [hh:mm:ss] once the transcript passes the one-hour mark.
export function offsetTimestamps(text, offsetSeconds) {
  if (!offsetSeconds) return text;
  // {1,3} on the first group: a chunk's own clock can pass 99 minutes.
  return text.replace(/\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]/g, (_, a, b, c) => {
    const t = (c === undefined ? +a * 60 + +b : +a * 3600 + +b * 60 + +c) + offsetSeconds;
    return `[${formatTime(t)}]`;
  });
}

export function formatTime(total) {
  const s = Math.max(0, Math.floor(total));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}
