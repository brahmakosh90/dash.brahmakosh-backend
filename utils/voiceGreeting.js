// Short, localized opening line for voice-agent calls.
// Template placeholders: {name} = user's first name, {agent} = persona name.
const GREETINGS = {
  en: { named: 'Hello, {name}. I am {agent}. How can I help you?',        neutral: 'Hello. I am {agent}. How can I help you?' },
  hi: { named: 'नमस्ते {name}। मैं {agent} हूँ। मैं आपकी क्या मदद कर सकती हूँ?', neutral: 'नमस्ते। मैं {agent} हूँ। मैं आपकी क्या मदद कर सकती हूँ?' },
  bn: { named: 'নমস্কার {name}। আমি {agent}। আমি আপনাকে কীভাবে সাহায্য করতে পারি?', neutral: 'নমস্কার। আমি {agent}। আমি আপনাকে কীভাবে সাহায্য করতে পারি?' },
  ta: { named: 'வணக்கம் {name}. நான் {agent}. உங்களுக்கு நான் எப்படி உதவலாம்?', neutral: 'வணக்கம். நான் {agent}. உங்களுக்கு நான் எப்படி உதவலாம்?' },
  te: { named: 'నమస్కారం {name}. నేను {agent}. నేను మీకు ఎలా సహాయం చేయగలను?', neutral: 'నమస్కారం. నేను {agent}. నేను మీకు ఎలా సహాయం చేయగలను?' },
  mr: { named: 'नमस्कार {name}. मी {agent} आहे. मी तुमची काय मदत करू शकते?', neutral: 'नमस्कार. मी {agent} आहे. मी तुमची काय मदत करू शकते?' },
  gu: { named: 'નમસ્તે {name}. હું {agent} છું. હું તમારી શું મદદ કરી શકું?', neutral: 'નમસ્તે. હું {agent} છું. હું તમારી શું મદદ કરી શકું?' },
  kn: { named: 'ನಮಸ್ಕಾರ {name}. ನಾನು {agent}. ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?', neutral: 'ನಮಸ್ಕಾರ. ನಾನು {agent}. ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?' },
  ml: { named: 'നമസ്കാരം {name}. ഞാൻ {agent}. ഞാൻ നിങ്ങളെ എങ്ങനെ സഹായിക്കണം?', neutral: 'നമസ്കാരം. ഞാൻ {agent}. ഞാൻ നിങ്ങളെ എങ്ങനെ സഹായിക്കണം?' },
  pa: { named: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ {name}। ਮੈਂ {agent} ਹਾਂ। ਮੈਂ ਤੁਹਾਡੀ ਕੀ ਮਦਦ ਕਰ ਸਕਦੀ ਹਾਂ?', neutral: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ। ਮੈਂ {agent} ਹਾਂ। ਮੈਂ ਤੁਹਾਡੀ ਕੀ ਮਦਦ ਕਰ ਸਕਦੀ ਹਾਂ?' },
};

// Templates are written in the feminine form (Rashmi); swap verb endings for male voices.
const MALE_FORMS = [['सकती', 'सकता'], ['शकते', 'शकतो'], ['ਸਕਦੀ', 'ਸਕਦਾ']];

const DEFAULT_LANGUAGE = 'hi';

// Persona names spoken in the script of the greeting language (TTS reads Devanagari more naturally).
const HINDI_PERSONA = { Rashmi: 'रश्मि', Krishna: 'कृष्ण' };
const MAX_NAME_LENGTH  = 30;

// "hi-IN" / "HI_in" / "hi" → "hi"; anything unsupported → default.
export const normalizeGreetingLanguage = (lang) => {
  const base = String(lang ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return GREETINGS[base] ? base : DEFAULT_LANGUAGE;
};

// First word of the profile name, stripped to letters/marks so the text is safe to speak
// and cannot smuggle template or prompt text. Returns '' when nothing usable is left.
export const extractFirstName = (fullName) => {
  const first = String(fullName ?? '').trim().split(/\s+/)[0] || '';
  return first.replace(/[^\p{L}\p{M}'.-]/gu, '').slice(0, MAX_NAME_LENGTH);
};

// Persona name shown in the greeting: derived from the voice slot (rashmi*/rasmi* → Rashmi),
// otherwise the agent's own name.
export const resolvePersonaName = ({ voiceName, agentName } = {}) => {
  const v = String(voiceName ?? '').toLowerCase();
  if (v.startsWith('rashmi') || v.startsWith('rasmi')) return 'Rashmi';
  if (v.startsWith('krishna')) return 'Krishna';
  return String(agentName ?? '').trim() || 'Rashmi';
};

export const buildGreeting = ({ fullName, language, voiceName, agentName, gender } = {}) => {
  const lang      = normalizeGreetingLanguage(language);
  const firstName = extractFirstName(fullName);
  let agent       = resolvePersonaName({ voiceName, agentName });
  if (lang === 'hi') agent = HINDI_PERSONA[agent] || agent;
  const template  = firstName ? GREETINGS[lang].named : GREETINGS[lang].neutral;
  let text = template.replace('{name}', () => firstName).replace('{agent}', () => agent);
  if (gender === 'male') for (const [f, m] of MALE_FORMS) text = text.replaceAll(f, m);
  return text;
};
