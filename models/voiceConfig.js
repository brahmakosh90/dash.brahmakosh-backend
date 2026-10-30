import mongoose from 'mongoose';

/**
 * VoiceConfig Model
 *
 * Stores ElevenLabs voice configuration for each named voice slot.
 *
 * Confirmed ElevenLabs Premade Voice IDs (available to all users):
 * ─────────────────────────────────────────────────────────────────
 *  Male voices (Krishna):
 *    krishna1 → Adam   → pNInz6obpgDQGcFmaJgB
 *    krishna2 → Antoni → ErXwobaYiN019PkySvjV
 *    krishna3 → Arnold → VR6AewLTigWG4xSOukaG
 *
 *  Female voices (Rashmi):
 *    rashmi1  → Rachel → 21m00Tcm4TlvDq8ikWAM
 *    rashmi2  → Domi   → AZnzlk1XvdvUeBnXmlld
 *    rashmi3  → Bella  → EXAVITQu4vr4xnSDxMaL
 * ─────────────────────────────────────────────────────────────────
 */

const voiceConfigSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      enum: [
        'krishna1', 'krishna2', 'krishna3',
        'rashmi1', 'rashmi2', 'rashmi3',
        'saavi1', 'kanika1', 'roohi1', 'kanika2',
        'ranbir1', 'priyanka1', 'god1', 'raqib1',
        'rasmi1'
      ],
      trim: true,
    },
    gender: {
      type: String,
      required: true,
      enum: ['male', 'female'],
    },
    voiceId: {
      type: String,
      required: true,
      trim: true,
    },
    elevenlabsVoiceName: {
      // Human-readable ElevenLabs name e.g. "Adam", "Rachel"
      type: String,
      required: true,
      trim: true,
    },
    displayName: {
      // UI label e.g. "Krishna 1 (Adam)"
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    prompt: {
      // System prompt sent to OpenAI before every conversation turn
      type: String,
      default: 'Give the answer within two lines.',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    modelId: {
      // ElevenLabs TTS model
      type: String,
      default: 'eleven_turbo_v2_5',
    },
    voiceSettings: {
      stability:         { type: Number, default: 0.5 },
      similarity_boost:  { type: Number, default: 0.75 },
      style:             { type: Number, default: 0.0 },
      use_speaker_boost: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

const VoiceConfig = mongoose.models.VoiceConfig || mongoose.model('VoiceConfig', voiceConfigSchema);
export default VoiceConfig;