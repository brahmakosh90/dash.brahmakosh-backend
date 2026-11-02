import { WebSocket, WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Astrology from '../models/Astrology.js';
import Agent from '../models/Agent.js';
import Chat from '../models/Chat.js';
import Client from '../models/Client.js';
import { getUserChatContext, buildContextPrompt, updateChatSummary, invalidateUserChatContext } from './userChatContext.js';
import { extractFirstName, buildGreeting, renderCustomGreeting } from '../utils/voiceGreeting.js';
import { uploadBuffer } from '../utils/storage.js';
import astrologyService from './astrologyService.js';

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Realtime API WebSocket proxy
//
//   client  <──ws──>  /realtime  <──ws──>  wss://api.openai.com/v1/realtime
//
// The OpenAI key never leaves the server. The client authenticates with its app
// JWT (?token=) and may only send a small whitelist of realtime events; the
// session configuration (model, voice, instructions, tools) is owned by the server.
// ─────────────────────────────────────────────────────────────────────────────

const REALTIME_PATH   = '/realtime';
const REALTIME_MODEL  = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const OPENAI_URL      = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;

const MAX_SESSION_MS      = Number.parseInt(process.env.REALTIME_MAX_SESSION_MS ?? '', 10) || 15 * 60_000;
const HEARTBEAT_MS        = 30_000;
const MAX_CLIENT_PAYLOAD  = 1024 * 1024;          // one audio chunk is a few KB
const MAX_PENDING_BYTES   = 2 * 1024 * 1024;      // client audio buffered while OpenAI connects
const MAX_CLIENT_BACKLOG  = 8 * 1024 * 1024;      // slow client: stop paying for audio nobody hears
const UPSTREAM_CONNECT_MS = 10_000;

const DEFAULT_INSTRUCTIONS =
  'You are Rashmi, a calm, warm and compassionate FEMALE spiritual guide and Vedic astrologer for the Brahmakosh app. ' +
  'Always speak as a woman: in Hindi use feminine forms (e.g. "main kar sakti hoon", "main batati hoon"). ' +
  'If asked, say you are Rashmi, an AI guide, and refer to yourself as female. ' +
  'Brahmakosh is a spiritual wellness app: Vedic astrology/kundali, panchang, numerology, meditation, chanting and guidance.';

// Appended LAST to every session prompt (after any client-defined agent prompt and the user data), so it wins
// over conflicting instructions such as "speak only Hindi".
const VOICE_RULES =
  '\n\nVOICE CALL RULES (these OVERRIDE any conflicting instruction above, including any instruction to use only one language):\n' +
  '- You speak BOTH Hindi and English fluently. NEVER say you can only speak Hindi (or only English).\n' +
  '- Your default language is Hindi (Devanagari), including the first greeting. After that, mirror the LATEST user message: ' +
  'pure English or a request such as "speak in English" -> reply fully in English from that very reply; ' +
  'pure Hindi -> fully in Hindi; mixed Hindi+English (Hinglish) -> natural Hinglish, matching whichever language dominates and ' +
  'keeping the English words the user used. Switch whenever the user switches. Never reply in Urdu or Arabic script.\n' +
  '- Keep replies short (2-3 sentences) and conversational. Do not greet again after the first message.\n' +
  '- You only listen and speak. Never claim abilities you do not have (seeing through a camera, browsing the web, calling or messaging anyone, remembering beyond the data above).\n' +
  '- You cannot run tasks or tools during this call. Never say you are starting a process, will generate something, or ask the user to wait. ' +
  'Answer immediately from the data given above.\n' +
  '- When the user asks about themselves, describe what you know from their profile and kundali above (name, birth details, sign, nakshatra, key planets, current dasha); mention missing details only briefly at the end.\n' +
  '- For astrology, use ONLY the real birth chart data given above and never invent planetary positions. ' +
  'If the kundali data is missing, say it has not been generated yet and ask the user to complete their birth details in the app.';

const VOICE_BILLING_ENABLED = process.env.VOICE_BILLING_ENABLED === 'true';   // same switch as the old voice agent
const DEFAULT_VOICE_CCR = 20;                  // credits per 10 seconds
const BILLING_INTERVAL_MS = 10_000;
const KUNDALI_WAIT_MS = 7_000;
const MIN_TRANSCRIPT_CHARS = 2;
const MALE_VOICE_SLOT = /^(krishna|ranbir|god|raqib)/i;
const RECORDING_FOLDER = 'voice-agent-audio';
const MAX_RECORDED_BYTES = 80 * 1024 * 1024;
const GREETING_PREFIX =
  'Say the following greeting aloud, word for word, in a warm tone, and say nothing else: ';

// 24kHz mono PCM16 -> WAV so the dashboard can play it in a plain <audio> element
const pcmToWav = (pcm) => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

// Server VAD would answer in whatever language the model guesses, so replies are triggered manually
// once the transcript is known, with an explicit language for that turn.
const ENGLISH_REQUEST = /english|इंग्लिश|अंग्रेज/i;
const ROMAN_HINDI = /\b(kya|hai|hain|hoon|mujhe|mera|meri|mere|batao|bataiye|aap|kaise|nahi|nahin|haan|kaun|tum|kab|kyun|karo|karna|chahiye)\b/gi;

const detectReplyLanguage = (text) => {
  if (ENGLISH_REQUEST.test(text)) return 'english';
  const dev = (text.match(/[ऀ-ॿ]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  if (dev + lat === 0) return null;
  if (lat === 0) return 'hindi';
  const romanHindi = (text.match(ROMAN_HINDI) || []).length;
  if (dev === 0) return romanHindi >= 2 ? 'hinglish' : 'english';
  const latinShare = lat / (dev + lat);
  if (latinShare >= 0.85) return 'english';
  if (latinShare <= 0.15) return 'hindi';
  return 'hinglish';
};

const LANGUAGE_TURN_HEADER = {
  english: 'LANGUAGE FOR THIS REPLY: ENGLISH ONLY. Every word you speak must be English. Do not use Hindi words.',
  hindi: 'LANGUAGE FOR THIS REPLY: HINDI (Devanagari) ONLY.',
  hinglish: 'LANGUAGE FOR THIS REPLY: natural HINGLISH (Hindi mixed with the English words the user used).',
};

const LANGUAGE_TURN_INSTRUCTION = {
  english: 'FOR THIS REPLY ONLY: the user is speaking English. Reply fully in English, even if earlier replies were in Hindi.',
  hindi: 'FOR THIS REPLY ONLY: the user is speaking Hindi. Reply fully in Hindi (Devanagari script).',
  hinglish: 'FOR THIS REPLY ONLY: the user mixed Hindi and English. Reply in natural Hinglish: Hindi in Devanagari, keeping the English words the user used in English.',
};

const clip = (value, max) => {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

// Everything Rashmi should know about this user: profile, kundali (planets, dasha, ...) and earlier topics.
const buildUserContext = async (userId) => {
  try {
    let [user, astro, chatCtx] = await Promise.all([
      User.findById(userId).select('profile preferredLanguage').lean(),
      Astrology.findOne({ userId }).lean(),
      getUserChatContext(userId).catch(() => null),
    ]);

    const lines = ['', 'USER DETAILS (private background; use naturally, never recite everything at once):'];
    const p = user?.profile || {};
    if (p.name) lines.push(`- Name: ${p.name} (address by first name: ${extractFirstName(p.name)})`);
    if (p.dob) lines.push(`- Date of birth: ${new Date(p.dob).toISOString().slice(0, 10)}`);
    if (p.timeOfBirth) lines.push(`- Time of birth: ${p.timeOfBirth}`);
    if (p.placeOfBirth) lines.push(`- Place of birth: ${p.placeOfBirth}`);
    if (p.profession) lines.push(`- Profession: ${p.profession}`);
    if (p.gowthra) lines.push(`- Gotra: ${p.gowthra}`);
    if (user?.preferredLanguage) lines.push(`- Preferred language: ${user.preferredLanguage === 'en' ? 'English' : 'Hindi'}`);

    if (!astro) {
      // No kundali yet: build it now when the birth details are complete (same service as the Kundali page)
      const hasBirth = p.dob && p.timeOfBirth && Number.isFinite(p.latitude) && Number.isFinite(p.longitude);
      if (hasBirth) {
        try {
          await Promise.race([
            astrologyService.getCompleteAstrologyData(userId, p),
            new Promise((_, reject) => setTimeout(() => reject(new Error('kundali timeout')), KUNDALI_WAIT_MS)),
          ]);
          astro = await Astrology.findOne({ userId }).lean();
        } catch (err) {
          console.warn(`[RealtimeProxy:${userId}] kundali generation skipped:`, err.message);
        }
      }
    }

    if (astro) {
      const a = astro.astroDetails || {};
      const astroLine = Object.entries(a).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ');
      lines.push('', 'KUNDALI (Vedic birth chart):');
      if (astroLine) lines.push(`- Astro details: ${astroLine}`);
      if (astro.planets?.length) {
        lines.push('- Planets: ' + astro.planets.map((pl) =>
          `${pl.name} in ${pl.sign} (house ${pl.house}, ${pl.nakshatra}${pl.isRetro === 'true' ? ', retrograde' : ''})`).join('; '));
      }
      if (astro.birthChart?.houses) {
        const houses = astro.birthChart.houses instanceof Map ? Object.fromEntries(astro.birthChart.houses) : astro.birthChart.houses;
        lines.push('- Houses: ' + Object.entries(houses).map(([h, pls]) => `H${h}: ${[].concat(pls).join('/') || 'empty'}`).join('; '));
      }
      if (astro.currentVdasha) lines.push(`- Current Vimshottari dasha: ${clip(astro.currentVdasha, 600)}`);
      if (astro.currentChardasha) lines.push(`- Current Char dasha: ${clip(astro.currentChardasha, 300)}`);
      if (astro.sadhesatiLifeDetails) lines.push(`- Sade Sati: ${clip(astro.sadhesatiLifeDetails, 400)}`);
      if (astro.pitraDoshaReport) lines.push(`- Pitra dosha: ${clip(astro.pitraDoshaReport, 300)}`);
      if (astro.gemstoneSuggestion) lines.push(`- Gemstone suggestion: ${clip(astro.gemstoneSuggestion, 300)}`);
    } else {
      lines.push('', 'KUNDALI: not generated yet for this user. For astrology questions, ask them to complete birth details in the app.');
    }

    return lines.join('\n') + buildContextPrompt(chatCtx);
  } catch (err) {
    console.warn(`[RealtimeProxy:${userId}] could not load user context:`, err.message);
    return '';
  }
};

// Events a browser client is allowed to forward to OpenAI. Notably absent:
// session.update (server-owned config) and anything that could change model/tools.
const CLIENT_EVENT_WHITELIST = new Set([
  'input_audio_buffer.append',
  'input_audio_buffer.commit',
  'input_audio_buffer.clear',
  'response.create',
  'response.cancel',
  'conversation.item.truncate',
]);

const activeByUser = new Map(); // userId -> client ws (one live session per user)

export const buildSessionUpdate = (instructions, voice) => ({
  type: 'session.update',
  session: {
    type: 'realtime',
    model: REALTIME_MODEL,
    output_modalities: ['audio'],
    instructions,
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        // No fixed language: users switch between Hindi, English and Hinglish. The prompt biases toward Devanagari, not Urdu/Arabic.
        transcription: { model: 'gpt-4o-transcribe', prompt: 'The speaker talks in Hindi, English, or a mix of both. Write English words and English sentences in English (Latin letters); write Hindi speech in Devanagari. Never transliterate English into Devanagari. Never use Urdu or Arabic script.' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: false,
        },
      },
      output: {
        format: { type: 'audio/pcm', rate: 24000 },
        voice,
      },
    },
  },
});

const rejectUpgrade = (socket, status, message) => {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain\r\n' +
    `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
  );
  socket.destroy();
};

const authenticate = (req) => {
  const url   = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) return { error: [401, 'Authentication required'] };

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'user') return { error: [403, 'Access denied'] };
    const userId = String(decoded.userId || '');
    if (!userId) return { error: [401, 'Invalid token'] };
    const agentId = url.searchParams.get('agentId');
    return { userId, agentId: mongoose.isValidObjectId(agentId) ? agentId : null };
  } catch {
    return { error: [401, 'Invalid or expired token'] };
  }
};

const safeClose = (ws, code, reason) => {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason ? String(reason).slice(0, 120) : undefined);
    }
  } catch { /* already closing */ }
};

const sendJson = (ws, payload) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
};

function handleClient(clientWs, userId, agentId) {
  const tag = `[RealtimeProxy:${userId}]`;

  // One session per user — a new connection replaces a stale one (e.g. app reopened).
  const previous = activeByUser.get(userId);
  if (previous && previous !== clientWs) safeClose(previous, 4009, 'Replaced by a newer session');
  activeByUser.set(userId, clientWs);

  let upstream = null;
  let sessionInstructions = '';
  let upstreamReady = false;
  let pending = [];
  let pendingBytes = 0;
  let closed = false;

  // ── Call history + recording ──────────────────────────────────────────────
  let chatPromise = null;
  const entries = [];                 // { role, text, ts, itemId }
  const assistantAudio = new Map();   // item_id -> Buffer[]
  const assistantStart = new Map();   // item_id -> first audio timestamp
  const userAudio = new Map();        // item_id -> Buffer
  const userSpeechAt = new Map();     // item_id -> timestamp
  let userRing = [];                  // last ~400ms of mic audio (speech onset is detected late)
  let userCapture = null;             // chunks while the user is speaking
  let recordedBytes = 0;
  const assistantText = new Map();    // item_id -> transcript built from deltas (survives a hang-up mid-sentence)
  const assistantDone = new Set();    // item_ids whose final transcript arrived
  let responseActive = false;         // OpenAI allows only one response at a time
  let queuedReply = null;             // latest user turn that arrived while a response was running
  let billingTimer = null;

  const trackClientAudio = (b64) => {
    if (recordedBytes > MAX_RECORDED_BYTES) return;
    const chunk = Buffer.from(b64, 'base64');
    recordedBytes += chunk.length;
    if (userCapture) userCapture.push(chunk);
    else { userRing.push(chunk); if (userRing.length > 4) userRing.shift(); }
  };

  const sendReply = (text) => {
    const lang = text ? detectReplyLanguage(text) : null;
    console.log(`${tag} user said (${lang || 'unknown'}): ${text.slice(0, 80)}`);
    const instructions = lang
      ? `${LANGUAGE_TURN_HEADER[lang]}\n\n${sessionInstructions}\n\n${LANGUAGE_TURN_INSTRUCTION[lang]}`
      : `${sessionInstructions}\n\nThe user's last words were unclear. Briefly ask them to repeat, in the language you were last speaking.`;
    responseActive = true;
    upstream.send(JSON.stringify({ type: 'response.create', response: { instructions } }));
  };

  // One response at a time: a newer user turn cancels the running reply and is answered right after it ends.
  const replyToUser = (transcript, { failed = false } = {}) => {
    if (closed || !upstream || upstream.readyState !== WebSocket.OPEN || !upstreamReady) return;
    const text = String(transcript || '').trim();
    if (!failed && text.length < MIN_TRANSCRIPT_CHARS) return;   // noise / empty transcript: stay quiet
    const turn = failed ? '' : text;
    if (responseActive) {
      queuedReply = turn;
      upstream.send(JSON.stringify({ type: 'response.cancel' }));
      return;
    }
    sendReply(turn);
  };

  const trackUpstreamEvent = (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        userCapture = [...userRing];
        break;
      case 'input_audio_buffer.speech_stopped':
        if (userCapture && ev.item_id) {
          userAudio.set(ev.item_id, Buffer.concat(userCapture));
          userSpeechAt.set(ev.item_id, Date.now());
        }
        userCapture = null;
        userRing = [];
        break;
      case 'conversation.item.input_audio_transcription.completed':
        entries.push({ role: 'user', text: ev.transcript, itemId: ev.item_id, ts: userSpeechAt.get(ev.item_id) ?? Date.now() });
        replyToUser(ev.transcript);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        replyToUser('', { failed: true });
        break;
      case 'response.created':
        responseActive = true;
        break;
      case 'response.done':
        responseActive = false;
        if (queuedReply !== null) {
          const next = queuedReply;
          queuedReply = null;
          replyToUser(next, { failed: next === '' });
        }
        break;
      case 'response.output_audio_transcript.delta':
        if (ev.item_id) assistantText.set(ev.item_id, (assistantText.get(ev.item_id) || '') + (ev.delta || ''));
        break;
      case 'response.output_audio.delta':
        if (ev.delta && ev.item_id && recordedBytes <= MAX_RECORDED_BYTES) {
          const chunk = Buffer.from(ev.delta, 'base64');
          recordedBytes += chunk.length;
          if (!assistantAudio.has(ev.item_id)) { assistantAudio.set(ev.item_id, []); assistantStart.set(ev.item_id, Date.now()); }
          assistantAudio.get(ev.item_id).push(chunk);
        }
        break;
      case 'response.output_audio_transcript.done':
        assistantDone.add(ev.item_id);
        entries.push({ role: 'assistant', text: ev.transcript, itemId: ev.item_id, ts: assistantStart.get(ev.item_id) ?? Date.now() });
        break;
      default:
    }
  };

  const saveHistory = async () => {
    try {
      const chat = chatPromise ? await chatPromise : null;
      if (!chat) return;
      for (const [itemId, text] of assistantText) {
        if (!assistantDone.has(itemId)) entries.push({ role: 'assistant', text, itemId, ts: assistantStart.get(itemId) ?? Date.now() });
      }
      const turns = entries.filter((e) => e.text && e.text.trim()).sort((a, b) => a.ts - b.ts);
      if (turns.length === 0) { await Chat.deleteOne({ _id: chat._id }); return; }

      const messages = await Promise.all(turns.map(async (t) => {
        const pcm = t.role === 'user' ? userAudio.get(t.itemId) : Buffer.concat(assistantAudio.get(t.itemId) || []);
        let audioKey = null;
        if (pcm && pcm.length > 4800) {
          try {
            const key = `${RECORDING_FOLDER}/${t.role}_${chat._id}_${t.ts}.wav`;
            await uploadBuffer(pcmToWav(pcm), key, 'audio/wav');
            audioKey = key;
          } catch (err) {
            console.warn(`${tag} recording upload failed:`, err.message);
          }
        }
        return { role: t.role, content: t.text.trim(), timestamp: new Date(t.ts), ...(audioKey && { audioKey }) };
      }));

      await Chat.updateOne({ _id: chat._id }, { $set: { messages, voiceEndTime: new Date() } });
      invalidateUserChatContext(userId);
      updateChatSummary(chat._id).catch(() => {});
    } catch (err) {
      console.error(`${tag} could not save call history:`, err.message);
    }
  };

  const cleanup = (clientCode = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    saveHistory();
    clearTimeout(connectTimer);
    clearTimeout(maxDurationTimer);
    clearInterval(heartbeat);
    clearInterval(billingTimer);
    pending = [];
    if (activeByUser.get(userId) === clientWs) activeByUser.delete(userId);
    if (upstream) {
      upstream.removeAllListeners('message');
      safeClose(upstream, 1000, 'client closed');
      // Don't let a half-open upstream linger if it never completes its handshake.
      if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    }
    safeClose(clientWs, clientCode, reason);
  };

  // ── Heartbeat (detect dead clients behind NAT / mobile networks) ──────────
  let alive = true;
  clientWs.on('pong', () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (!alive) return cleanup(1001, 'Heartbeat timeout');
    alive = false;
    try { clientWs.ping(); } catch { cleanup(1011, 'Ping failed'); }
  }, HEARTBEAT_MS);

  const maxDurationTimer = setTimeout(() => cleanup(4008, 'Max session duration reached'), MAX_SESSION_MS);

  // ── Credits (same switch and rate as the old voice agent) ──────────────────
  const startBilling = async () => {
    if (!VOICE_BILLING_ENABLED) return;
    try {
      const u = await User.findById(userId).select('credits clientId').lean();
      if (!u || u.credits <= 0) {
        sendJson(clientWs, { type: 'credit:warning', message: 'Credits khatam ho gaye hain.', remainingBalance: u?.credits ?? 0 });
        return cleanup(4010, 'Insufficient credits');
      }
      const clientDoc = u.clientId ? await Client.findById(u.clientId?._id || u.clientId).select('settings.voiceCCR').lean() : null;
      const ccr = clientDoc?.settings?.voiceCCR ?? DEFAULT_VOICE_CCR;
      billingTimer = setInterval(async () => {
        try {
          const after = await User.findOneAndUpdate(
            { _id: userId, credits: { $gt: 0 } },
            [{ $set: { credits: { $max: [0, { $subtract: ['$credits', ccr] }] } } }],
            { new: true, projection: 'credits' }
          ).lean();
          const balance = after ? after.credits : 0;
          sendJson(clientWs, { type: 'credit:update', creditsDeducted: ccr, remainingBalance: balance });
          if (balance <= 0) {
            sendJson(clientWs, { type: 'credit:warning', message: 'Credits khatam ho gaye hain.', remainingBalance: 0 });
            cleanup(4010, 'Insufficient credits');
          }
        } catch (err) {
          console.error(`${tag} billing error:`, err.message);
        }
      }, BILLING_INTERVAL_MS);
    } catch (err) {
      console.error(`${tag} could not start billing:`, err.message);
    }
  };

  // ── Upstream connection ───────────────────────────────────────────────────
  const sessionPromise = (async () => {
    const [userContext, foundAgent, user] = await Promise.all([
      buildUserContext(userId),
      agentId ? Agent.findOne({ _id: agentId, isActive: true }).lean().catch(() => null) : null,
      User.findById(userId).select('profile.name preferredLanguage clientId').lean().catch(() => null),
    ]);
    // An agent only applies to users of the client that owns it
    const sameClient = !foundAgent || !user?.clientId || String(foundAgent.clientId) === String(user.clientId?._id || user.clientId);
    const agent = sameClient ? foundAgent : null;
    const base = agent?.systemPrompt || process.env.REALTIME_INSTRUCTIONS || DEFAULT_INSTRUCTIONS;
    const voice = process.env.REALTIME_VOICE
      || (agent && MALE_VOICE_SLOT.test(agent.voiceName || '') ? 'echo' : 'marin');
    const fullName = user?.profile?.name;
    const greeting =
      renderCustomGreeting(agent?.firstMessage, fullName) ||
      buildGreeting({
        fullName,
        language: user?.preferredLanguage,
        voiceName: agent?.voiceName,
        agentName: agent?.name,
        gender: agent && MALE_VOICE_SLOT.test(agent.voiceName || '') ? 'male' : 'female',
      });
    return { instructions: base + userContext + VOICE_RULES, voice, greeting, agent };
  })();
  upstream = new WebSocket(OPENAI_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    perMessageDeflate: false,
  });

  const connectTimer = setTimeout(() => {
    if (!upstreamReady) {
      console.error(`${tag} upstream connect timeout`);
      sendJson(clientWs, { type: 'proxy.error', message: 'Voice service timed out' });
      cleanup(1011, 'Upstream timeout');
    }
  }, UPSTREAM_CONNECT_MS);

  upstream.on('open', () => {
    if (closed) return;
    clearTimeout(connectTimer);
    // Session config (with the user's profile + kundali) must land before any buffered audio
    sessionPromise.then(({ instructions, voice, greeting, agent }) => {
      if (closed || upstream.readyState !== WebSocket.OPEN) return;
      sessionInstructions = instructions;
      upstream.send(JSON.stringify(buildSessionUpdate(instructions, voice)));
      chatPromise = Chat.create({
        userId,
        title: 'Voice Agent Chat',
        agentId: agent?._id || null,
        messages: [],
        voiceStartTime: new Date(),
      }).catch((err) => { console.error(`${tag} could not create chat:`, err.message); return null; });
      // The agent speaks first: the client-defined greeting (AI Agents tab) or the built-in localized one
      upstream.send(JSON.stringify({
        type: 'response.create',
        response: { instructions: GREETING_PREFIX + greeting },
      }));
      responseActive = true;
      upstreamReady = true;
      for (const msg of pending) upstream.send(msg);
      pending = [];
      pendingBytes = 0;
      startBilling();
    }).catch((err) => {
      console.error(`${tag} session setup failed:`, err.message);
      sendJson(clientWs, { type: 'proxy.error', message: 'Voice service error' });
      cleanup(1011, 'Setup failed');
    });
  });

  upstream.on('message', (data, isBinary) => {
    if (closed || clientWs.readyState !== WebSocket.OPEN) return;
    if (clientWs.bufferedAmount > MAX_CLIENT_BACKLOG) {
      console.warn(`${tag} client too slow, closing`);
      return cleanup(1013, 'Client too slow');
    }
    clientWs.send(data, { binary: isBinary });
    if (!isBinary) trackUpstreamEvent(data.toString());
  });

  upstream.on('unexpected-response', (_req, res) => {
    console.error(`${tag} upstream rejected handshake: HTTP ${res.statusCode}`);
    sendJson(clientWs, { type: 'proxy.error', message: 'Voice service unavailable' });
    cleanup(1011, 'Upstream rejected');
  });

  upstream.on('error', (err) => {
    console.error(`${tag} upstream error:`, err.message);
    sendJson(clientWs, { type: 'proxy.error', message: 'Voice service error' });
    cleanup(1011, 'Upstream error');
  });

  upstream.on('close', (code, reason) => {
    if (closed) return;
    // 1005/1006 are reserved and cannot be sent in a close frame.
    const safeCode = code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011;
    cleanup(safeCode, reason?.toString() || 'Upstream closed');
  });

  // ── Client → upstream ─────────────────────────────────────────────────────
  clientWs.on('message', (raw, isBinary) => {
    if (closed || isBinary) return; // protocol is JSON text frames only

    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return sendJson(clientWs, { type: 'proxy.error', message: 'Invalid JSON' });
    }

    if (!event || !CLIENT_EVENT_WHITELIST.has(event.type)) {
      return sendJson(clientWs, { type: 'proxy.error', message: `Event not allowed: ${event?.type}` });
    }

    if (event.type === 'input_audio_buffer.append' && event.audio) trackClientAudio(event.audio);

    const payload = raw.toString();
    if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
      upstream.send(payload);
    } else if (pendingBytes + payload.length <= MAX_PENDING_BYTES) {
      pending.push(payload);
      pendingBytes += payload.length;
    }
  });

  clientWs.on('error', (err) => {
    console.error(`${tag} client error:`, err.message);
    cleanup(1011, 'Client error');
  });
  clientWs.on('close', () => cleanup(1000, 'Client closed'));
}

/**
 * Attach the /realtime proxy to an existing HTTP server.
 *
 * Other `ws` servers on this process are created with `{ server, path }`, and ws
 * answers every non-matching upgrade with a 400. To let /realtime coexist with them
 * (and socket.io), the server's existing 'upgrade' listeners are wrapped in one
 * dispatcher that claims /realtime first and forwards everything else untouched.
 * Call this AFTER all other WebSocket servers have been set up.
 */
export function setupOpenAIRealtimeProxy(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_PAYLOAD, perMessageDeflate: false });

  const existing = server.listeners('upgrade');
  server.removeAllListeners('upgrade');

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];

    if (pathname !== REALTIME_PATH) {
      for (const listener of existing) listener.call(server, req, socket, head);
      return;
    }

    socket.on('error', () => {}); // avoid unhandled ECONNRESET during handshake

    if (!process.env.OPENAI_API_KEY || !process.env.JWT_SECRET) {
      console.error('[RealtimeProxy] OPENAI_API_KEY / JWT_SECRET not configured');
      return rejectUpgrade(socket, 503, 'Voice service not configured');
    }

    const { userId, agentId, error } = authenticate(req);
    if (error) return rejectUpgrade(socket, error[0], error[1]);

    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, userId, agentId));
  });

  server.on('close', () => {
    for (const ws of wss.clients) safeClose(ws, 1001, 'Server shutting down');
  });

  console.log(`[RealtimeProxy] ✅ WebSocket proxy initialized at ${REALTIME_PATH} (${REALTIME_MODEL})`);
  return wss;
}
