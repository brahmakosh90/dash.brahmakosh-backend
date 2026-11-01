const MAX_TEXT = 2000;
const clip = (v) => String(v ?? '').trim().slice(0, MAX_TEXT);

/** Whitelist + trim the admin-supplied mantra object so only known script/language fields are stored. */
export const sanitizeMantraText = (input) => {
  const m = input && typeof input === 'object' ? input : {};
  return {
    sanskrit: clip(m.sanskrit),
    hindi: clip(m.hindi),
    transliteration: clip(m.transliteration),
    meaning: { en: clip(m.meaning?.en), hi: clip(m.meaning?.hi) },
  };
};

/**
 * Pick what the app should show for a language. Never returns an empty mantra when any
 * script is available: Hindi falls back to Sanskrit (same Devanagari), English to transliteration.
 */
export const localizeMantraText = (mantraText, lang) => {
  const m = mantraText || {};
  const meaning = m.meaning || {};
  const isHindi = lang !== 'en';
  const primary = isHindi ? (m.hindi || m.sanskrit) : (m.transliteration || m.sanskrit);
  return {
    text: primary || '',
    sanskrit: m.sanskrit || '',
    hindi: m.hindi || '',
    transliteration: m.transliteration || '',
    meaning: (isHindi ? meaning.hi || meaning.en : meaning.en || meaning.hi) || '',
  };
};
