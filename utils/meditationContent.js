export const DEFAULT_MEDITATION_CATEGORY = 'General';
const MAX_CATEGORY_LENGTH = 60;
const MAX_INSTRUCTIONS = 60;
const MAX_INSTRUCTION_LENGTH = 300;

const clean = (value, max) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** Category as stored/served: trimmed, single-spaced, capped; blank/invalid becomes "General" (never an empty tab name). */
export const normalizeCategory = (value) =>
  (typeof value === 'string' ? clean(value, MAX_CATEGORY_LENGTH) : '') || DEFAULT_MEDITATION_CATEGORY;

const toSeconds = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 24 * 3600 ? Math.round(n) : null;
};

/**
 * Step-by-step guidance shown during a guided meditation.
 * Accepts: an array of strings, an array of { text, textHindi?, startSecond?, durationSeconds? },
 * or one newline-separated string. Returns a clean array (max 60 steps); steps with a startSecond are
 * ordered by it, the rest keep their order so the app can cycle them evenly across the session.
 */
export const normalizeInstructions = (input) => {
  let list = input;
  if (typeof list === 'string') list = list.split(/\r?\n/);
  if (!Array.isArray(list)) return [];

  const steps = [];
  for (const item of list) {
    const raw = typeof item === 'string' ? { text: item } : item;
    if (!raw || typeof raw !== 'object') continue;
    const text = clean(raw.text ?? raw.instruction, MAX_INSTRUCTION_LENGTH);
    if (!text) continue;
    steps.push({
      text,
      textHindi: clean(raw.textHindi ?? raw.hindi, MAX_INSTRUCTION_LENGTH),
      startSecond: toSeconds(raw.startSecond ?? raw.atSecond),
      durationSeconds: toSeconds(raw.durationSeconds ?? raw.duration),
    });
    if (steps.length >= MAX_INSTRUCTIONS) break;
  }

  return steps.every((s) => s.startSecond !== null)
    ? steps.sort((a, b) => a.startSecond - b.startSecond)
    : steps;
};

const AUDIO_MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm' };

/** Best-effort MIME type from a key/URL extension, so players that need a hint get one. */
export const audioMimeType = (keyOrUrl) => {
  const path = String(keyOrUrl || '').split(/[?#]/)[0];
  const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
  return AUDIO_MIME[ext] || null;
};
