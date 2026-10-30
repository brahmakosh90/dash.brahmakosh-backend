import express from 'express';
import fetch from 'node-fetch';
import { authenticate, authorize } from '../middleware/auth.js';
import VoiceConfig from '../models/voiceConfig.js';

const router = express.Router();

const FALLBACK_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const FALLBACK_MODEL_ID = 'eleven_turbo_v2_5';

/**
 * POST /api/tts/synthesize
 * Synthesize text to speech for preview (e.g. agent first message).
 * Body: { text: string, voiceName: string }
 * Response: { success: true, audioContent: string } (base64 MP3)
 */
router.post('/synthesize', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    if (!elevenLabsApiKey) {
      return res.status(503).json({
        success: false,
        message: 'TTS service unavailable',
      });
    }

    const { text, voiceName } = req.body || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ success: false, message: 'text is required' });
    }

    const voice = await VoiceConfig.findOne({ name: (voiceName || '').trim(), isActive: true });
    const voiceId = voice?.voiceId || FALLBACK_VOICE_ID;
    const modelId = voice?.modelId || FALLBACK_MODEL_ID;
    const settings = voice?.voiceSettings || {
      stability:         0.5,
      similarity_boost:  0.75,
      style:             0.0,
      use_speaker_boost: true,
    };

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    const requestTTS = (targetUrl) => fetch(targetUrl, {
      method:  'POST',
      headers: {
        Accept:         'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key':   elevenLabsApiKey,
      },
      body: JSON.stringify({
        text,
        model_id:       modelId,
        voice_settings: settings,
      }),
    });

    let response = await requestTTS(url);

    // Voice missing on this environment's ElevenLabs account — use the default voice
    if (response.status === 404 && voiceId !== FALLBACK_VOICE_ID) {
      console.error(`[TTS] ElevenLabs voice "${voiceId}" (${voice?.name}) not found for this API key — falling back to default voice`);
      response = await requestTTS(`https://api.elevenlabs.io/v1/text-to-speech/${FALLBACK_VOICE_ID}`);
    }

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({
        success: false,
        message: `TTS synthesis failed: ${response.status}`,
        error:   process.env.NODE_ENV === 'development' ? errText : undefined,
      });
    }

    const buffer = await response.buffer();
    const base64 = buffer.toString('base64');

    res.json({
      success:      true,
      audioContent: base64,
      data:         { audioContent: base64 },
    });
  } catch (error) {
    console.error('[TTS] Synthesize error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to synthesize speech',
      error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

export default router;
