import VoiceConfig from '../models/voiceConfig.js';

/**
 * Default ElevenLabs Voice IDs
 * Male voices (Krishna):
 *   - Adam:   pNInz6obpgDQGcFmaJgB
 *   - Antoni: ErXwobaYiN019PkySvjV
 *   - Arnold: VR6AewLTigWG4xSOukaG
 * Female voices (Rashmi):
 *   - Rachel: 21m00Tcm4TlvDq8ikWAM
 *   - Domi:   AZnzlk1XvdvUeBnXmlld
 *   - Bella:  EXAVITQu4vr4xnSDxMaL
 *
 * Replace the voiceId values below with your actual ElevenLabs Voice IDs
 * from your ElevenLabs account dashboard.
 */

const DEFAULT_VOICES = [
  // ─── Male Voices (Krishna) ────────────────────────────────────────────────
  {
    name: 'krishna1',
    gender: 'male',
    voiceId: 'pNInz6obpgDQGcFmaJgB', // Adam - deep, confident male voice
    elevenlabsVoiceName: 'Adam',
    displayName: 'Krishna 1 (Adam)',
    description: 'Deep, confident male voice ideal for spiritual guidance.',
    prompt: 'Give the answer within two lines.',
  },
  {
    name: 'krishna2',
    gender: 'male',
    voiceId: 'ErXwobaYiN019PkySvjV', // Antoni - well-rounded male voice
    elevenlabsVoiceName: 'Antoni',
    displayName: 'Krishna 2 (Antoni)',
    description: 'Well-rounded male voice with a calm and soothing tone.',
    prompt: 'Give the answer within two lines.',
  },
  {
    name: 'krishna3',
    gender: 'male',
    voiceId: 'VR6AewLTigWG4xSOukaG', // Arnold - authoritative male voice
    elevenlabsVoiceName: 'Arnold',
    displayName: 'Krishna 3 (Arnold)',
    description: 'Authoritative and clear male voice.',
    prompt: 'Give the answer within two lines.',
  },

  // ─── Female Voices (Rashmi) ───────────────────────────────────────────────
  {
    name: 'rashmi2',
    gender: 'female',
    voiceId: 'AZnzlk1XvdvUeBnXmlld', // Domi - strong female voice
    elevenlabsVoiceName: 'Domi',
    displayName: 'Rashmi 2 (Domi)',
    description: 'Strong, expressive female voice with clear articulation.',
    prompt: 'Give the answer within two lines.',
  },
  {
    name: 'rashmi3',
    gender: 'female',
    voiceId: 'EXAVITQu4vr4xnSDxMaL', // Bella - soft female voice
    elevenlabsVoiceName: 'Bella',
    displayName: 'Rashmi 3 (Bella)',
    description: 'Soft, warm female voice with a gentle delivery.',
    prompt: 'Give the answer within two lines.',
  },

  // ─── New Hindi Voices ─────────────────────────────────────────────────────
  {
    name: 'saavi1',
    gender: 'female',
    voiceId: 'a4BpQNxKFbuzzTj2JRQc',
    elevenlabsVoiceName: 'Saavi',
    displayName: 'Saavi - Soothing Meditative Voice',
    description: 'Saavi delivers a soothing, meditative, and gently immersive style designed to calm and relax listeners.',
    modelId: 'eleven_multilingual_v2',
    prompt: 'Give the answer within two lines.',
  },
  {
    name: 'kanika1',
    gender: 'female',
    voiceId: 'C2S5J6WvmHnrQWjUu6Rg',
    elevenlabsVoiceName: 'Kanika',
    displayName: 'Kanika - Soothing & Guided Meditation',
    description: 'Kanika delivers a deep, soothing Hindi voice warm, expressive, and emotionally rich.',
    modelId: 'eleven_multilingual_v2',
    prompt: 'Give the answer within two lines.',
  },
  {
    name: 'roohi1',
    gender: 'female',
    voiceId: 'oHNJagRZ2LQEfZb2CEkb',
    elevenlabsVoiceName: 'Roohi',
    displayName: 'Roohi - Breathy, Soft and Whisper',
    description: 'Roohi - Guided Meditation & Narration - A calming voice for guided meditations, gentle narration, and late-night reflections.',
    modelId: 'eleven_multilingual_v2',
    prompt: 'Give the answer within two lines.',
  },
  {
    name: 'kanika2',
    gender: 'female',
    voiceId: 'LWUgWFxGgMLZlNkiFd3F',
    elevenlabsVoiceName: 'Kanika Soft',
    displayName: 'Kanika - Soft and Vibrant',
    description: 'Kanika - Rich Mythological Narrator - soft, intimate, and deeply relatable.',
    modelId: 'eleven_multilingual_v2',
    prompt: 'Give the answer within two lines.',
  },
  {
    name: 'ranbir1',
    gender: 'male',
    voiceId: 'SGbOfpm28edC83pZ9iGb',
    elevenlabsVoiceName: 'Ranbir',
    displayName: 'Ranbir - Calm, Steady and Clear',
    description: 'Ranbir M - Calm, Conversational Voice - A young and youthful voice, popularly used across genres.',
    modelId: 'eleven_multilingual_v2',
    prompt: 'Give the answer within two lines.',
  },
  {
    name: 'priyanka1',
    gender: 'female',
    voiceId: 'xisH9EzaRxUnFxiRwuVV',
    elevenlabsVoiceName: 'Priyanka Sogam',
    displayName: 'Priyanka Sogam - Guided Meditation',
    description: 'Use it with Multilingual V2 for best experience. Priyanka Sogam is a soothing and steady guide for meditation and mindfulness.',
    modelId: 'eleven_multilingual_v2',
    prompt: 'Give the answer within two lines.',
  },
  {
    name: 'god1',
    gender: 'male',
    voiceId: 'ttpam6l3Fgkia7uX33b6',
    elevenlabsVoiceName: 'God',
    displayName: 'God - Friendly, Warm and Encouraging',
    description: 'God - A soothing and pleasant Hindi Voice, good for Narration and also used as God Voice in various narrations.',
    modelId: 'eleven_multilingual_v2',
    prompt: 'Give the answer within two lines.',
  },
  {
    name: 'raqib1',
    gender: 'male',
    voiceId: '0UZ29F1kNDvmelKG8QCM',
    elevenlabsVoiceName: 'Raqib',
    displayName: 'Raqib - Clear Documentary Presenter',
    description: 'Raqib delivers a clear, composed Hindi tone suited for documentary and factual presentation.',
    modelId: 'eleven_multilingual_v2',
    prompt: 'Give the answer within two lines.',
  },
  {
    name: 'rasmi1',
    gender: 'female',
    voiceId: 'ydnQbIPvdUZLvjGe0dap',
    elevenlabsVoiceName: 'Rasmi',
    displayName: 'Rasmi AI Voice',
    description: 'Custom voice for Rasmi AI.',
    modelId: 'eleven_multilingual_v2',
    prompt: 'Give the answer within two lines.',
  },
];

export const seedVoiceConfigs = async () => {
  try {
    for (const voice of DEFAULT_VOICES) {
      await VoiceConfig.findOneAndUpdate(
        { name: voice.name },
        {
          $set: {
            gender: voice.gender,
            displayName: voice.displayName,
            description: voice.description,
            elevenlabsVoiceName: voice.elevenlabsVoiceName,
            ...(voice.modelId ? { modelId: voice.modelId } : {}),
          },
          $setOnInsert: {
            voiceId: voice.voiceId,
            prompt: voice.prompt,
          },
        },
        { upsert: true, new: true }
      );
    }
    console.log('[VoiceConfig] ✅ Default voice configurations seeded successfully');
  } catch (err) {
    console.error('[VoiceConfig] ❌ Failed to seed voice configurations:', err.message);
  }
};