import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import compression from 'compression';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Route imports ────────────────────────────────────────────────────────────
import partnerRoutes               from './routes/partners.js';
import superAdminAuthRoutes        from './routes/auth/superAdminAuth.js';
import adminAuthRoutes             from './routes/auth/adminAuth.js';
import clientAuthRoutes            from './routes/auth/clientAuth.js';
import userAuthRoutes              from './routes/auth/userAuth.js';
import passwordResetRoutes         from './routes/auth/passwordReset.js';
import partnerPasswordResetRoutes from './routes/auth/partnerPasswordReset.js';
import appleOtpRoutes              from './routes/auth/appleOtp.js';
import userRoutes                  from './routes/users.js';
import adminRoutes                 from './routes/admin.js';
import clientRoutes                from './routes/client.js';
import superAdminRoutes            from './routes/superAdmin.js';
import clientProfileMobileRoutes   from './routes/mobile/clientProfile.js';
import userProfileMobileRoutes     from './routes/mobile/userProfile.js';
import partnerProfileMobileRoutes  from './routes/mobile/partnerProfile.js';
import mobileContentRoutes         from './routes/mobile/content.js';
import chatRoutes                  from './routes/mobile/chat.js';
import avatarChatRoutes            from './routes/mobile/avatarChat.js';
import voiceRoutes                 from './routes/mobile/voice.js';
import mobileAgentsRoutes          from './routes/mobile/agents.js';
import mobilePanchangRoutes         from './routes/mobile/panchang.js';
import mobileReportsRoutes          from './routes/mobile/reports.js';
import uploadRoutes                from './routes/upload.js';
import mediaRoutes                 from './routes/media.js';
import testimonialRoutes           from './routes/testimonials/index.js';
import reviewRoutes                from './routes/reviews.js';
import founderMessageRoutes        from './routes/founderMessages/index.js';
import brandAssetRoutes            from './routes/brandAssets/index.js';
import sponsorRoutes               from './routes/sponsors.js';
import expertCategoryRoutes        from './routes/expertCategories.js';
import expertRoutes                from './routes/experts.js';
import meditationRoutes            from './routes/meditations.js';
import liveAvatarRoutes            from './routes/liveAvatars.js';
import brahmAvatarRoutes           from './routes/brahmAvatars.js';
import chantingRoutes              from './routes/chantings.js';
import prathanaRoutes              from './routes/prathanas.js';
import spiritualActivityRoutes     from './routes/spiritualActivities.js';
import spiritualConfigurationRoutes from './routes/spiritualConfigurations.js';
import spiritualClipRoutes         from './routes/spiritualClips.js';
import spiritualStatsRoutes        from './routes/spiritualStats.js';
import spiritualRewardsRoutes      from './routes/spiritualRewards.js';
import karmaPointsRoutes           from './routes/karmaPoints.js';
import rewardRedemptionsRoutes     from './routes/rewardRedemptions.js';
import chapterRoutes               from './routes/chapters.js';
import shlokaRoutes                from './routes/shlokas.js';
import sankalpRoutes               from './routes/sankalp.js';
import userSankalpRoutes           from './routes/userSankalp.js';
import leaderboardRoutes           from './routes/leaderboard.js';
import analyticsRoutes             from './routes/analytics.js';
import notificationRoutes          from './routes/notifications.js';
import alertsRoutes                from './routes/alerts.js';
import pujaPadhatiRoutes           from './routes/pujaPadhati.js';
import swapnaDecoderRoutes         from './routes/swapnaDecoder.js';
import shivPuranRoutes             from './routes/shivPuran.js';
import ramayanaRoutes              from './routes/ramayana.js';
import durgaSaptashatiRoutes       from './routes/durgaSaptashati.js';
import dreamRequestRoutes          from './routes/dreamRequest.js';
import partnerUserChatRoutes       from './routes/chatRoutes.js';
import userPaymentRoutes           from './routes/userPayment.js';
import userPlanPaymentRoutes       from './routes/userPlanPayment.js';
import clientSubscriptionPlansRoutes from './routes/clientSubscriptionPlans.js';
import stripeWebhookRoutes         from './routes/stripeWebhook.js';
import adminPaymentRoutes          from './routes/adminPayments.js';
import clientPaymentRoutes         from './routes/clientPayments.js';
import storeProxyRoutes            from './routes/storeProxy.js';
import referralRoutes              from './routes/referral/index.js';

// ─── Voice Config & TTS Routes ────────────────────────────────────────────────
import voiceConfigRoutes           from './routes/voiceConfig.js';
import ttsRoutes                   from './routes/tts.js';

// ─── Service imports ──────────────────────────────────────────────────────────
import { initializeSuperAdmin }    from './config/initSuperAdmin.js';
import { setupVoiceAgentWebSocket } from './routes/mobile/voiceAgent.js';
import { setupChatWebSocket }       from './services/chatWebSocket.js';
import { startClientNotificationScheduler } from './services/clientNotificationScheduler.js';

// ─── NEW: Voice Config Seeder ─────────────────────────────────────────────────
import { seedVoiceConfigs }         from './config/seedVoiceConfigs.js';

import './services/cronJobs.js';

startClientNotificationScheduler();

const app    = express();
const server = http.createServer(app);

// ─── Compression ─────────────────────────────────────────────────────────────
app.use(compression());

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin:             true,
  credentials:        true,
  methods:            ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders:     ['Content-Type', 'Authorization'],
  exposedHeaders:     ['Content-Range', 'X-Content-Range'],
  preflightContinue:  false,
  optionsSuccessStatus: 204,
}));

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy',    'unsafe-none');
  res.setHeader('Cross-Origin-Embedder-Policy',  'unsafe-none');
  res.setHeader('Cross-Origin-Resource-Policy',  'cross-origin');
  res.setHeader('Access-Control-Allow-Origin',   req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods',  'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',  'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Stripe webhooks require raw body (must be before express.json)
app.use('/api/user/payment/webhook', express.raw({ type: 'application/json' }), stripeWebhookRoutes);

// ─── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── Static files ─────────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── MongoDB + startup tasks ──────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/brahmakosh';

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('MongoDB connected successfully');
    await initializeSuperAdmin();
    await seedVoiceConfigs(); // ← seed the 6 default voices on every startup (safe, uses $setOnInsert)
  })
  .catch((err) => console.error('MongoDB connection error:', err));

// ─────────────────────────────────────────────────────────────────────────────
// REST API ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Referral Partner Portal (affiliate programme)
app.use('/api/referral', referralRoutes);

// Partner
app.use('/api/partners', partnerRoutes);

// Auth
app.use('/api/auth/super-admin', superAdminAuthRoutes);
app.use('/api/auth/admin',       adminAuthRoutes);
app.use('/api/auth/client',      clientAuthRoutes);
app.use('/api/auth/user',        userAuthRoutes);
app.use('/api/auth/user',        passwordResetRoutes);
app.use('/api/auth/user',        appleOtpRoutes);
app.use('/api/auth/partner',     partnerPasswordResetRoutes);

// Core application
app.use('/api/users',       userRoutes);
app.use('/api/admin',       adminRoutes);
app.use('/api/admin/payments', adminPaymentRoutes);
app.use('/api/client',      clientRoutes);
app.use('/api/client/payments', clientPaymentRoutes);
app.use('/api/client/subscription-plans', clientSubscriptionPlansRoutes);
app.use('/api/super-admin', superAdminRoutes);

// Mobile
app.use('/api/mobile/client',  clientProfileMobileRoutes);
app.use('/api/mobile/user',    userProfileMobileRoutes);
app.use('/api/mobile/chat',    chatRoutes);
app.use('/api/mobile/avatar-chat', avatarChatRoutes);
app.use('/api/mobile/voice',   voiceRoutes);
app.use('/api/mobile/partner', partnerProfileMobileRoutes);
app.use('/api/mobile/content', mobileContentRoutes);
app.use('/api/mobile/agents',  mobileAgentsRoutes);
app.use('/api/mobile/panchang', mobilePanchangRoutes);
app.use('/api/mobile/user/reports', mobileReportsRoutes);

// Partner–User Chat
app.use('/api/chat', partnerUserChatRoutes);

// ─── User plans, subscriptions, and payment ───────────────────────────────────
app.use('/api/user', userPlanPaymentRoutes);

// ─── User Payment (Stripe / Apple Pay for credits) ────────────────────────────
app.use('/api/user/payment', userPaymentRoutes);

// ─── Store Proxy (forward to https://store.brahmakosh.com) ───────────────────
// All routes here expect the same body/query as the store API and will forward
// Authorization header (Bearer token) when present.
app.use('/api/store', storeProxyRoutes);

// ─── TTS (text-to-speech preview) ─────────────────────────────────────────────
// POST /api/tts/synthesize — body: { text, voiceName } → { success, audioContent (base64) }
app.use('/api/tts', ttsRoutes);

// ─── Voice Configuration ─────────────────────────────────────────────────────
// Endpoints:
//   GET    /api/voice-config              → list all voices
//   GET    /api/voice-config?gender=male  → filter by gender
//   GET    /api/voice-config/:name        → single voice
//   PUT    /api/voice-config/:name/voice-id  → change ElevenLabs voice ID
//   PUT    /api/voice-config/:name/prompt    → update AI prompt
//   PUT    /api/voice-config/:name/prompt/reset → reset prompt to default
//   PATCH  /api/voice-config/:name/toggle    → toggle active/inactive
//   PUT    /api/voice-config/:name           → full update
app.use('/api/voice-config', voiceConfigRoutes);

// Upload & Media
app.use('/api/upload', uploadRoutes);
app.use('/api/media',  mediaRoutes);

// Content
app.use('/api/testimonials',              testimonialRoutes);
app.use('/api/reviews',                   reviewRoutes);
app.use('/api/sponsors',                  sponsorRoutes);
app.use('/api/expert-categories',         expertCategoryRoutes);
app.use('/api/experts',                   expertRoutes);
app.use('/api/meditations',               meditationRoutes);
app.use('/api/live-avatars',              liveAvatarRoutes);
app.use('/api/brahm-avatars',             brahmAvatarRoutes);
app.use('/api/chantings',                 chantingRoutes);
app.use('/api/prathanas',                 prathanaRoutes);
app.use('/api/spiritual-activities',      spiritualActivityRoutes);
app.use('/api/spiritual-configurations',  spiritualConfigurationRoutes);
app.use('/api/spiritual-clips',           spiritualClipRoutes);
app.use('/api/founder-messages',          founderMessageRoutes);
app.use('/api/brand-assets',              brandAssetRoutes);
app.use('/api/spiritual-stats',           spiritualStatsRoutes);
app.use('/api/spiritual-rewards',         spiritualRewardsRoutes);
app.use('/api/karma-points',              karmaPointsRoutes);
app.use('/api/reward-redemptions',        rewardRedemptionsRoutes);
app.use('/api/chapters',                  chapterRoutes);
app.use('/api/shlokas',                   shlokaRoutes);
app.use('/api/sankalp',                   sankalpRoutes);
app.use('/api/user-sankalp',              userSankalpRoutes);
app.use('/api/leaderboard',               leaderboardRoutes);
app.use('/api/analytics',                 analyticsRoutes);
app.use('/api/notifications',             notificationRoutes);
app.use('/api/alerts',                    alertsRoutes);
app.use('/api/puja-padhati',              pujaPadhatiRoutes);
app.use('/api/swapna-decoder',            swapnaDecoderRoutes);
app.use('/api/shiv-puran',                shivPuranRoutes);
app.use('/api/ramayana',                  ramayanaRoutes);
app.use('/api/durga-saptashati',          durgaSaptashatiRoutes);
app.use('/api/dream-requests',            dreamRequestRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Server is running',
    whatsapp: {
      WHATSAPP_ENABLED: process.env.WHATSAPP_ENABLED || 'NOT SET',
      USE_WHATSAPP_BUSINESS_API: process.env.USE_WHATSAPP_BUSINESS_API || 'NOT SET',
      WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN ? 'SET ✅' : 'NOT SET ❌',
      WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID ? 'SET ✅' : 'NOT SET ❌',
      WHATSAPP_TEMPLATE_NAME: process.env.WHATSAPP_TEMPLATE_NAME || 'NOT SET',
      GRAPH_VERSION: process.env.GRAPH_VERSION || 'NOT SET',
    }
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error:   process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBSOCKET SETUP (after all REST routes)
// ─────────────────────────────────────────────────────────────────────────────
setupVoiceAgentWebSocket(server);   // /api/voice/agent
setupChatWebSocket(server);         // Partner-User Chat WebSocket

// ─────────────────────────────────────────────────────────────────────────────
export default server;
export { app };