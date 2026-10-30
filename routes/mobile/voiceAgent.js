import { WebSocketServer } from 'ws';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import Chat from '../../models/Chat.js';
import VoiceConfig from '../../models/voiceConfig.js';
import Agent from '../../models/Agent.js';
import User from '../../models/User.js';
import Client from '../../models/Client.js';
import { uploadBuffer } from '../../utils/storage.js';

const DEFAULT_AGENT_VOICE_CCR = 20; // credits per 10 seconds
const VOICE_BILLING_INTERVAL_MS = 10_000; // 10 seconds

const getAgentVoiceCCR = async (clientId) => {
  if (!clientId) return DEFAULT_AGENT_VOICE_CCR;
  try {
    const client = await Client.findById(clientId).select('settings.voiceCCR').lean();
    return client?.settings?.voiceCCR ?? DEFAULT_AGENT_VOICE_CCR;
  } catch { return DEFAULT_AGENT_VOICE_CCR; }
};

// ─── Validate environment variables ──────────────────────────────────────────
const deepgramApiKey   = process.env.DEEPGRAM_API_KEY;
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const openaiApiKey     = process.env.OPENAI_API_KEY;

console.log('[VoiceAgent] API Keys Status:');
console.log('  Deepgram:',   deepgramApiKey   ? `${deepgramApiKey.substring(0, 4)}...` : '❌ MISSING');
console.log('  OpenAI:',     openaiApiKey     ? `${openaiApiKey.substring(0, 7)}...`   : '❌ MISSING');
console.log('  ElevenLabs:', elevenLabsApiKey ? `${elevenLabsApiKey.substring(0, 4)}...` : '❌ MISSING');

// ─── Initialize clients ───────────────────────────────────────────────────────
let deepgramClient = null;
let openai         = null;

if (deepgramApiKey) {
  deepgramClient = createClient(deepgramApiKey);
  console.log('[VoiceAgent] ✅ Deepgram client initialized');
}
if (openaiApiKey) {
  openai = new OpenAI({ apiKey: openaiApiKey });
  console.log('[VoiceAgent] ✅ OpenAI client initialized');
}

const FALLBACK_VOICE_ID           = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const FALLBACK_MODEL_ID           = 'eleven_turbo_v2_5';
const DEFAULT_PROMPT              = 'You are a helpful spiritual guide. Keep answers concise.';
const VOICE_AGENT_AUDIO_FOLDER    = 'voice-agent-audio';
const DEEPGRAM_KEEPALIVE_MS       = 8_000;
const DEEPGRAM_RECONNECT_DELAY_MS = 500;
const SILENCE_THRESHOLD_MS        = 800;

// Turn states
const TURN_SPEAKING     = 'SPEAKING';
const TURN_INTERRUPTED  = 'INTERRUPTED';
const TURN_COMPLETED    = 'COMPLETED';

// Generate unique turn ID
const createTurnId = () => `turn_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const isValidObjectId = (id) => /^[a-f\d]{24}$/i.test(String(id ?? ''));

function pcmToWav(pcmBuffer) {
  const dataLen = pcmBuffer.length;
  const header  = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1,  20);
  header.writeUInt16LE(1,  22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2,  32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcmBuffer]);
}

// ─────────────────────────────────────────────────────────────────────────────
export const handleVoiceAgentWebSocket = (wss) => {
  wss.on('connection', async (ws) => {
    console.log('[VoiceAgent] New WebSocket connection');

    if (!deepgramApiKey || !openaiApiKey || !elevenLabsApiKey) {
      ws.send(JSON.stringify({ type: 'error', message: 'Server configuration error: Missing API keys', error: 'MISSING_API_KEYS' }));
      ws.close();
      return;
    }

    // ─── Per-connection state ─────────────────────────────────────────────────
    let deepgramConnection    = null;
    let keepaliveTimer        = null;
    let silenceTimer          = null;
    let accumulatedTranscript = '';
    let isProcessingLLM       = false;
    let chat                  = null;
    let userId                = null;
    let isActive              = false;   // master gate for all async callbacks
    let audioChunkCount       = 0;
    let voiceConfig           = null;
    let agentPromptOverride   = null;
    let agentFirstMessage     = null;
    let userAudioChunks       = [];
    let isReconnectingDG      = false;
    let pendingAudioChunks    = [];
    let firstMessageSent      = false;
    let currentTTSAbortCtrl   = null;
    let currentTurnId         = null;   // active AI turn ID
    let currentTurnState      = null;   // SPEAKING | INTERRUPTED | COMPLETED
    let voiceBillingInterval  = null;   // 10-second billing timer

    // ── Keepalive ──────────────────────────────────────────────────────────────
    const stopKeepalive = () => {
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    };
    const startKeepalive = () => {
      stopKeepalive();
      keepaliveTimer = setInterval(() => {
        if (deepgramConnection && isActive) {
          try { deepgramConnection.keepAlive(); } catch (_) {}
        }
      }, DEEPGRAM_KEEPALIVE_MS);
    };

    // ── Safe send (never throws after disconnect) ─────────────────────────────
    const safeSend = (payload) => {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify(payload)); } catch (_) {}
      }
    };

    // ── Full session cleanup ───────────────────────────────────────────────────
    const cleanup = () => {
      if (!isActive && !deepgramConnection) return;
      console.log('[VoiceAgent] Cleaning up session...');

      isActive = false;  // ← gates ALL async callbacks from here on

      // Stop voice billing interval
      if (voiceBillingInterval) {
        clearInterval(voiceBillingInterval);
        voiceBillingInterval = null;
      }

      // Abort any in-flight TTS
      if (currentTTSAbortCtrl) {
        try { currentTTSAbortCtrl.abort(); } catch (_) {}
        currentTTSAbortCtrl = null;
      }

      stopKeepalive();
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }

      if (deepgramConnection) {
        try { deepgramConnection.finish(); } catch (_) {}
        deepgramConnection = null;
      }

      audioChunkCount    = 0;
      pendingAudioChunks = [];
      userAudioChunks    = [];
      isReconnectingDG   = false;
      firstMessageSent   = false;
      isProcessingLLM    = false;
      currentTurnState   = null;
      currentTurnId      = null;
      console.log('[VoiceAgent] Cleanup complete');
    };

    // ── Initialize (or re-initialize) Deepgram ────────────────────────────────
    const initDeepgram = () => new Promise((resolve, reject) => {
      try {
        console.log('[VoiceAgent] Creating Deepgram connection...');

        const dgConn = deepgramClient.listen.live({
          model:            'nova-2-general',
          language:         voiceConfig?.language || 'hi',
          encoding:         'linear16',
          sample_rate:      16000,
          channels:         1,
          interim_results:  true,
          utterance_end_ms: 1000,
          vad_events:       true,
          punctuate:        true,
          smart_format:     true,
        });

        // OPEN
        dgConn.on(LiveTranscriptionEvents.Open, () => {
          if (!isActive) {
            try { dgConn.finish(); } catch (_) {}
            return;
          }
          console.log('[VoiceAgent] ✅ Deepgram connection opened');
          deepgramConnection = dgConn;
          isReconnectingDG   = false;
          startKeepalive();

          if (pendingAudioChunks.length > 0) {
            console.log(`[VoiceAgent] Flushing ${pendingAudioChunks.length} pending audio chunks`);
            for (const chunk of pendingAudioChunks) {
              try { deepgramConnection.send(chunk); } catch (_) {}
            }
            pendingAudioChunks = [];
          }
          resolve(dgConn);
        });

        // TRANSCRIPT
        dgConn.on(LiveTranscriptionEvents.Transcript, async (data) => {
          if (!isActive) return;

          const transcript = data.channel?.alternatives?.[0]?.transcript;
          const isFinal    = data.is_final;
          if (!transcript?.trim()) return;

          console.log('[VoiceAgent] 🎤 Transcript:', { text: transcript, isFinal, confidence: data.channel?.alternatives?.[0]?.confidence });
          safeSend({ type: 'transcript', text: transcript, isFinal });

          if (isFinal) {
            accumulatedTranscript += (accumulatedTranscript ? ' ' : '') + transcript;
            if (silenceTimer) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(async () => {
              if (!isActive) return;
              await processTurnComplete();
            }, SILENCE_THRESHOLD_MS);
          }
        });

        // UTTERANCE END
        dgConn.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
          if (!isActive) return;
          console.log('[VoiceAgent] 🔚 Utterance end detected');
          if (silenceTimer) clearTimeout(silenceTimer);
          await processTurnComplete();
        });

        // METADATA
        dgConn.on(LiveTranscriptionEvents.Metadata, (data) => {
          console.log('[VoiceAgent] 📊 Metadata:', { request_id: data.request_id });
        });

        // ERROR
        dgConn.on(LiveTranscriptionEvents.Error, (error) => {
          console.error('[VoiceAgent] ❌ Deepgram error:', error.message);
        });

        // CLOSE — reconnect transparently if session is still active
        dgConn.on(LiveTranscriptionEvents.Close, () => {
          console.log('[VoiceAgent] Deepgram connection closed');
          stopKeepalive();

          if (!isActive) {
            console.log('[VoiceAgent] Session inactive — skipping reconnect');
            return;
          }
          if (isReconnectingDG) return;

          deepgramConnection = null;
          isReconnectingDG   = true;

          console.log(`[VoiceAgent] 🔄 Auto-reconnecting Deepgram in ${DEEPGRAM_RECONNECT_DELAY_MS}ms...`);
          setTimeout(async () => {
            if (!isActive) { isReconnectingDG = false; return; }
            try {
              await initDeepgram();
              console.log('[VoiceAgent] ✅ Deepgram reconnected successfully');
            } catch (err) {
              console.error('[VoiceAgent] ❌ Deepgram reconnect failed:', err.message);
              isReconnectingDG = false;
              safeSend({ type: 'error', message: 'Speech recognition lost. Please restart.', error: 'DEEPGRAM_RECONNECT_FAILED' });
            }
          }, DEEPGRAM_RECONNECT_DELAY_MS);
        });

      } catch (err) {
        reject(err);
      }
    });

    // ── Interrupt helper: TTS abort + pipeline flush + state broadcast ────────
    const interruptCurrentTurn = () => {
      if (currentTurnState !== TURN_SPEAKING) return;
      const interruptedTurnId = currentTurnId;
      console.log(`[VoiceAgent] ⏹️ Interrupting turn | turnId: ${interruptedTurnId}`);

      if (currentTTSAbortCtrl) {
        try { currentTTSAbortCtrl.abort(); } catch (_) {}
        currentTTSAbortCtrl = null;
      }
      currentTurnState = TURN_INTERRUPTED;
      isProcessingLLM  = false;

      // Bug 2 Fix: Send newTurnId so frontend knows which turnId to accept next
      const nextTurnId = createTurnId();
      currentTurnId = nextTurnId;
      safeSend({ type: 'interruption_acknowledged', turnId: interruptedTurnId, newTurnId: nextTurnId, interruptedAt: Date.now() });
      // Bug 3 Fix: server-driven state — frontend knows backend is now listening
      safeSend({ type: 'agent_state', state: 'listening' });
    };

    // ── ElevenLabs TTS ────────────────────────────────────────────────────────
    const streamElevenLabsTTS = async (text, turnId) => {
      let audioKey = null;
      const abortCtrl = new AbortController();
      currentTTSAbortCtrl = abortCtrl;
      currentTurnId    = turnId;
      currentTurnState = TURN_SPEAKING;
      console.log(`[VoiceAgent] 🔊 TTS start | turnId: ${turnId}`);
      safeSend({ type: 'agent_state', state: 'speaking', turnId });
      try {
        const voiceId  = voiceConfig?.voiceId  || FALLBACK_VOICE_ID;
        const modelId  = voiceConfig?.modelId  || FALLBACK_MODEL_ID;
        const settings = voiceConfig?.voiceSettings || { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true };

        // Bug Fix: Add timeout to ElevenLabs fetch — prevents hanging forever on slow network
        const fetchTimeout = setTimeout(() => { try { abortCtrl.abort(); } catch (_) {} }, 30_000);

        const requestTTS = (id) => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}/stream`, {
          method:  'POST',
          headers: { Accept: 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': elevenLabsApiKey },
          body:    JSON.stringify({ text, model_id: modelId, voice_settings: settings }),
          signal:  abortCtrl.signal,
        });

        let response = await requestTTS(voiceId);

        // The configured voice may not exist on this environment's ElevenLabs account
        // (e.g. a cloned/library voice that was never added to the production workspace).
        // Fall back to the default voice instead of failing the whole call.
        if (response.status === 404 && voiceId !== FALLBACK_VOICE_ID) {
          const errText = await response.text().catch(() => '');
          console.error(`[VoiceAgent] ⚠️ ElevenLabs voice "${voiceId}" (${voiceConfig?.name}) not found for this API key — falling back to default voice. ${errText}`);
          response = await requestTTS(FALLBACK_VOICE_ID);
        }

        clearTimeout(fetchTimeout);

        if (!response.ok) {
          const errText = await response.text().catch(() => 'unknown');
          throw new Error(`ElevenLabs ${response.status}: ${errText}`);
        }

        const aiChunks = [];
        let chunkCount = 0;
        let sendBuffer = Buffer.alloc(0);
        const MIN_CHUNK_SIZE = 4096;

        for await (const chunk of response.body) {
          // Drop chunk if turn was interrupted
          if (!isActive || abortCtrl.signal.aborted || currentTurnState !== TURN_SPEAKING) {
            console.log(`[VoiceAgent] ⏭️ Chunk dropped | turnId: ${turnId} | state: ${currentTurnState}`);
            break;
          }
          chunkCount++;
          aiChunks.push(chunk);
          sendBuffer = Buffer.concat([sendBuffer, chunk]);

          if (sendBuffer.length >= MIN_CHUNK_SIZE) {
            // Bug 2 Fix: Double-check abort signal AND turn state before every send
            if (currentTurnState === TURN_SPEAKING && !abortCtrl.signal.aborted) {
              safeSend({ type: 'audio_chunk', turnId, audio: sendBuffer.toString('base64'), chunkIndex: chunkCount });
            }
            sendBuffer = Buffer.alloc(0);
          }
        }

        // Send remaining buffer only if not interrupted
        if (sendBuffer.length > 0 && currentTurnState === TURN_SPEAKING && !abortCtrl.signal.aborted) {
          safeSend({ type: 'audio_chunk', turnId, audio: sendBuffer.toString('base64'), chunkIndex: chunkCount });
        }

        // Send audio_complete only if not interrupted
        if (currentTurnState === TURN_SPEAKING && !abortCtrl.signal.aborted) {
          currentTurnState = TURN_COMPLETED;
          safeSend({ type: 'audio_complete', turnId, totalChunks: chunkCount });
          // Problem 3 fix: agent_turn_ended so frontend stops guessing
          safeSend({ type: 'agent_state', state: 'listening' });
          console.log(`[VoiceAgent] ✅ TTS complete | turnId: ${turnId} | chunks: ${chunkCount}`);
        } else {
          console.log(`[VoiceAgent] ⏹️ TTS stopped | turnId: ${turnId} | state: ${currentTurnState}`);
        }

        // S3 upload — fire-and-forget, never block the turn
        if (aiChunks.length > 0 && (process.env.R2_BUCKET || (process.env.R2_BUCKET || process.env.AWS_BUCKET_NAME)) && currentTurnState !== TURN_INTERRUPTED) {
          uploadBuffer(Buffer.concat(aiChunks), VOICE_AGENT_AUDIO_FOLDER, `ai_${chat?._id}_${Date.now()}.mp3`, 'audio/mpeg')
            .then(({ key }) => { audioKey = key; })
            .catch(e => console.warn('[VoiceAgent] S3 upload failed (AI audio):', e.message));
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          console.log(`[VoiceAgent] ⏹️ TTS aborted | turnId: ${turnId}`);
        } else {
          console.error('[VoiceAgent] ElevenLabs TTS error:', error.message);
          if (isActive) {
            safeSend({ type: 'error', message: 'Error generating speech', error: error.message, turnId });
            // Recover state so frontend doesn't get stuck
            if (currentTurnState === TURN_SPEAKING) {
              currentTurnState = TURN_COMPLETED;
              safeSend({ type: 'agent_state', state: 'listening' });
            }
          }
        }
      } finally {
        if (currentTTSAbortCtrl === abortCtrl) currentTTSAbortCtrl = null;
      }
      return { audioKey };
    };

    // ── Process one conversation turn ─────────────────────────────────────────
    const processTurnComplete = async () => {
      if (!isActive)                     return;
      if (!accumulatedTranscript.trim()) return;
      // Bug Fix: Prevent concurrent LLM calls — drop duplicate utterance-end events
      if (isProcessingLLM)               return;

      // If AI is currently speaking, abort it and let user's new question take over
      if (currentTurnState === TURN_SPEAKING) {
        interruptCurrentTurn();
      }

      if (!accumulatedTranscript.trim()) return;

      const userMessage     = accumulatedTranscript.trim();
      accumulatedTranscript = '';
      isProcessingLLM       = true;

      // S3 upload — fire-and-forget, capture key asynchronously
      let userAudioKey = null;
      if (userAudioChunks.length > 0 && (process.env.R2_BUCKET || process.env.AWS_BUCKET_NAME)) {
        const chunksToUpload = userAudioChunks.splice(0);
        uploadBuffer(pcmToWav(Buffer.concat(chunksToUpload)), VOICE_AGENT_AUDIO_FOLDER, `user_${chat._id}_${Date.now()}.wav`, 'audio/wav')
          .then(({ key }) => { userAudioKey = key; })
          .catch(e => console.warn('[VoiceAgent] S3 upload failed (user audio):', e.message));
      }
      userAudioChunks = [];

      console.log('[VoiceAgent] 💬 Processing turn:', userMessage);

      try {
        // Credit check before processing (deduction interval se hoti hai)
        const userDoc = await User.findById(userId);
        if (!userDoc || userDoc.credits <= 0) {
          safeSend({ type: 'error', message: 'Insufficient credits', error: 'INSUFFICIENT_CREDITS', remainingBalance: userDoc?.credits ?? 0 });
          cleanup();
          return;
        }

        const clientId = userDoc.clientId?._id || userDoc.clientId;

        chat.messages.push({ role: 'user', content: userMessage });
        await chat.save();

        safeSend({ type: 'user_message', text: userMessage });
        if (!isActive) return;

        // Problem 3 fix: tell frontend backend is processing
        safeSend({ type: 'agent_state', state: 'processing' });

        const systemPrompt = agentPromptOverride || voiceConfig?.prompt || DEFAULT_PROMPT;
        const voiceSystemPrompt = systemPrompt + '\n\nCRITICAL VOICE RULES (follow strictly):\n- NEVER say "Namaste" or any greeting after the very first message. No exceptions.\n- NEVER repeat your introduction or say who you are after the first message.\n- Answer ONLY what the user asked. Maximum 2 sentences per response.\n- Be direct. No filler phrases.';
        const completion   = await openai.chat.completions.create({
          model:       process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages:    [
            { role: 'system', content: voiceSystemPrompt },
            ...chat.messages.map(m => ({ role: m.role, content: m.content })),
          ],
          temperature: 0.7,
          max_tokens:  100,
        });

        if (!isActive) return;

        const aiResponse = completion.choices[0].message.content;
        const newTurnId  = createTurnId();
        console.log(`[VoiceAgent] 🎬 New turn | turnId: ${newTurnId}`);
        safeSend({ type: 'ai_response', text: aiResponse, turnId: newTurnId });

        const { audioKey: aiAudioKey } = await streamElevenLabsTTS(aiResponse, newTurnId);

        // Credit deduction ab interval se hota hai — per turn nahi
        if (isActive) {
          chat.messages.push({ role: 'assistant', content: aiResponse });
          await chat.save();
        }
      } catch (error) {
        console.error('[VoiceAgent] Error processing turn:', error);
        if (isActive) {
          safeSend({ type: 'error', message: 'Error processing response', error: error.message });
          // Bug 3 Fix: Always recover to listening state on error — prevents frontend getting stuck
          safeSend({ type: 'agent_state', state: 'listening' });
        }
      } finally {
        isProcessingLLM = false;
      }
    };

    // ─── Incoming message handler ─────────────────────────────────────────────
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);

        // ── START ──────────────────────────────────────────────────────────────
        if (data.type === 'start') {
          if (isActive) {
            console.log('[VoiceAgent] Re-start on active session — resetting');
            cleanup();
          }

          console.log('[VoiceAgent] Start command received:', { chatId: data.chatId, userId: data.userId, agentId: data.agentId });

          // ── Token verification ──────────────────────────────────────────────
          const token = data.token;
          if (!token) {
            safeSend({ type: 'error', message: 'Authentication required', error: 'NO_TOKEN' });
            setTimeout(() => ws.close(1008, 'No token'), 500);
            return;
          }
          try {
            const jwt = await import('jsonwebtoken');
            const decoded = jwt.default.verify(token, process.env.JWT_SECRET);
            if (decoded.role !== 'user') {
              safeSend({ type: 'error', message: 'Access denied', error: 'INVALID_ROLE' });
              setTimeout(() => ws.close(1008, 'Invalid role'), 500);
              return;
            }
            userId = decoded.userId;
          } catch (jwtErr) {
            safeSend({ type: 'error', message: 'Invalid or expired token', error: 'INVALID_TOKEN' });
            setTimeout(() => ws.close(1008, 'Invalid token'), 500);
            return;
          }
          isActive            = true;
          agentPromptOverride = null;
          agentFirstMessage   = null;

          // Resolve Agent
          let requestedVoice = data.voiceName || 'krishna1';
          if (data.agentId && isValidObjectId(data.agentId)) {
            try {
              const agent = await Agent.findById(data.agentId).lean();
              if (agent?.voiceName)            requestedVoice      = agent.voiceName;
              if (agent?.systemPrompt)         agentPromptOverride = agent.systemPrompt;
              if (agent?.firstMessage?.trim()) agentFirstMessage   = agent.firstMessage.trim();
              console.log('[VoiceAgent] 🤖 Agent resolved:', { name: agent?.name, voiceName: agent?.voiceName });
            } catch (e) {
              console.warn('[VoiceAgent] ⚠️ Could not resolve agentId:', e.message);
            }
          } else if (data.agentId) {
            console.log(`[VoiceAgent] ℹ️ Skipping non-ObjectId agentId: "${data.agentId}" — using default voice`);
          }

          // Resolve VoiceConfig
          voiceConfig = await VoiceConfig.findOne({ name: requestedVoice, isActive: true });
          if (!voiceConfig) {
            console.warn(`[VoiceAgent] ⚠️ Voice "${requestedVoice}" not found — using fallback`);
          } else {
            console.log(`[VoiceAgent] 🎙️ Voice: ${voiceConfig.displayName} (${voiceConfig.voiceId})`);
          }

          // Find or create chat
          if (data.chatId && data.chatId !== 'new') {
            chat = await Chat.findOne({ _id: data.chatId, userId });
          }
          if (!chat) {
            chat = new Chat({ userId, title: 'Voice Agent Chat', agentId: isValidObjectId(data.agentId) ? data.agentId : null, messages: [], voiceStartTime: new Date() });
            await chat.save();
            console.log('[VoiceAgent] Created new chat:', chat._id);
          } else if (!chat.voiceStartTime) {
            chat.voiceStartTime = new Date();
            await chat.save();
          }

          // Init Deepgram
          try {
            await initDeepgram();
          } catch (error) {
            console.error('[VoiceAgent] Failed to initialize Deepgram:', error);
            safeSend({ type: 'error', message: 'Failed to initialize speech recognition', error: error.message });
            cleanup();
            return;
          }

          safeSend({ type: 'deepgram_connected', message: 'Speech recognition active' });
          safeSend({ type: 'started', chatId: chat._id, voiceName: voiceConfig?.name || requestedVoice, message: 'Voice agent started' });

          // ✅ Start 10-second billing interval
          const userDocForBilling = await User.findById(userId).select('credits clientId').lean();
          const billingClientId = userDocForBilling?.clientId?._id || userDocForBilling?.clientId;
          const voiceCCR = await getAgentVoiceCCR(billingClientId);

          voiceBillingInterval = setInterval(async () => {
            if (!isActive) {
              clearInterval(voiceBillingInterval);
              voiceBillingInterval = null;
              return;
            }
            try {
              const userDoc = await User.findById(userId);
              if (!userDoc) return;

              if (userDoc.credits <= 0) {
                clearInterval(voiceBillingInterval);
                voiceBillingInterval = null;
                safeSend({ type: 'error', message: 'Insufficient credits', error: 'INSUFFICIENT_CREDITS', remainingBalance: 0 });
                cleanup();
                return;
              }

              const newBalance = Math.max(0, userDoc.credits - voiceCCR);
              userDoc.credits = newBalance;
              await userDoc.save();

              safeSend({ type: 'credit:update', creditsDeducted: voiceCCR, remainingBalance: newBalance });
              console.log(`[VoiceAgent] 💳 Billed ${voiceCCR} credits | balance: ${newBalance}`);

              if (newBalance <= 0) {
                clearInterval(voiceBillingInterval);
                voiceBillingInterval = null;
                safeSend({ type: 'error', message: 'Insufficient credits', error: 'INSUFFICIENT_CREDITS', remainingBalance: 0 });
                cleanup();
              }
            } catch (err) {
              console.error('[VoiceAgent] Billing interval error:', err.message);
            }
          }, VOICE_BILLING_INTERVAL_MS);

          // First message — only once per session, never on Deepgram reconnects
          if (agentFirstMessage && isActive && !firstMessageSent) {
            firstMessageSent = true;
            try {
              const firstTurnId = createTurnId();
              safeSend({ type: 'ai_response', text: agentFirstMessage, turnId: firstTurnId });
              const { audioKey } = await streamElevenLabsTTS(agentFirstMessage, firstTurnId);
              if (isActive) {
                chat.messages.push({ role: 'assistant', content: agentFirstMessage, ...(audioKey && { audioKey }) });
                await chat.save();
              }
            } catch (err) {
              console.error('[VoiceAgent] First message TTS error:', err.message);
            }
          }

        // ── STOP ──────────────────────────────────────────────────────────────
        } else if (data.type === 'stop') {
          console.log('[VoiceAgent] Stop command received');
          // Save voice end time
          if (chat) {
            try {
              chat.voiceEndTime = new Date();
              await chat.save();
            } catch (e) {}
          }
          cleanup();
          safeSend({ type: 'stopped', message: 'Voice agent stopped' });

        // ── INTERRUPT (explicit from app) ─────────────────────────────────────
        } else if (data.type === 'interrupt') {
          const reqTurnId = data.turnId;
          console.log(`[VoiceAgent] ⏹️ Interrupt command | turnId: ${reqTurnId} | current: ${currentTurnId}`);

          if (!reqTurnId || reqTurnId === currentTurnId) {
            interruptCurrentTurn();
            console.log(`[VoiceAgent] ✅ Interrupt applied | turnId: ${currentTurnId}`);
          } else {
            console.log(`[VoiceAgent] ⏭️ Interrupt ignored | state: ${currentTurnState}`);
          }

        // ── AUDIO ─────────────────────────────────────────────────────────────
        } else if (data.type === 'audio') {
          if (!isActive) return;
          // Bug 1 Fix: Do NOT forward mic audio to Deepgram while AI is speaking.
          // This prevents the speaker echo from triggering VAD / self-interruption.
          if (currentTurnState === TURN_SPEAKING) return;

          const audioBuffer = Buffer.from(data.audio, 'base64');
          userAudioChunks.push(audioBuffer);

          if (deepgramConnection) {
            try {
              deepgramConnection.send(audioBuffer);
              audioChunkCount++;
              if (audioChunkCount % 50 === 0) {
                console.log(`[VoiceAgent] 📤 Sent ${audioChunkCount} audio chunks to Deepgram`);
              }
            } catch (error) {
              console.error('[VoiceAgent] Error sending audio chunk:', error.message);
              pendingAudioChunks.push(audioBuffer);
            }
          } else if (isReconnectingDG) {
            pendingAudioChunks.push(audioBuffer);
          }
        }

      } catch (error) {
        console.error('[VoiceAgent] Error handling message:', error);
        safeSend({ type: 'error', message: 'Error processing message', error: error.message });
      }
    });

    // ─── Client disconnect / error ────────────────────────────────────────────
    ws.on('close', () => {
      console.log('[VoiceAgent] Client disconnected');
      if (chat && isActive) {
        try {
          Chat.findByIdAndUpdate(chat._id, { voiceEndTime: new Date() }).catch(() => {});
        } catch (e) {}
      }
      cleanup();
    });

    ws.on('error', (error) => {
      console.error('[VoiceAgent] WebSocket error:', error.message);
      cleanup();
    });
  });
};

// ─────────────────────────────────────────────────────────────────────────────
export const setupVoiceAgentWebSocket = (server) => {
  const wss = new WebSocketServer({
    server,
    path: '/api/voice/agent',
    clientTracking: true,
  });

  // Keep connections alive with ping/pong every 30 seconds
  const pingInterval = setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) {
        client.ping();
      }
    });
  }, 30_000);

  wss.on('close', () => clearInterval(pingInterval));

  handleVoiceAgentWebSocket(wss);
  console.log('[VoiceAgent] ✅ WebSocket server initialized at /api/voice/agent');
  return wss;
};