/**
 * FCM Fix Script - Brahmakosh Backend
 *
 * What this script does (in order):
 *  1. Verify Firebase Admin SDK credentials
 *  2. Backup all FCM token data to a JSON file (safe, no DB writes yet)
 *  3. Dry-run: show which tokens would be removed
 *  4. Remove ONLY messaging/registration-token-not-registered tokens from DB
 *  5. Print a summary and test notification instructions
 *
 * Usage:
 *   node scripts/fcm-fix.js            → dry-run (no DB changes)
 *   node scripts/fcm-fix.js --fix      → actually remove invalid tokens
 *   node scripts/fcm-fix.js --test-token <fcmToken>  → send a test push
 *
 * SAFETY GUARANTEES:
 *  - User documents are NEVER deleted or modified beyond $pull on fcmTokens
 *  - Valid tokens are NEVER touched
 *  - A full backup JSON is written before any DB write
 */

import admin from 'firebase-admin';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.join(__dirname, '../backups');
const DRY_RUN = !process.argv.includes('--fix');
const TEST_TOKEN = (() => {
  const idx = process.argv.indexOf('--test-token');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

// ─── Helpers ────────────────────────────────────────────────────────────────

const log = (msg) => console.log(`[FCM-FIX] ${msg}`);
const warn = (msg) => console.warn(`[FCM-FIX][WARN] ${msg}`);
const err = (msg) => console.error(`[FCM-FIX][ERROR] ${msg}`);

const ensureBackupDir = () => {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
};

// ─── Step 1: Verify Firebase credentials ────────────────────────────────────

function verifyFirebaseCredentials() {
  log('=== STEP 1: Verifying Firebase credentials ===');

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId) {
    err('FIREBASE_PROJECT_ID is missing in .env');
    process.exit(1);
  }

  log(`FIREBASE_PROJECT_ID: ${projectId}`);

  let credential;

  if (serviceAccountKey) {
    log('Using FIREBASE_SERVICE_ACCOUNT_KEY (JSON)');
    try {
      const parsed = JSON.parse(serviceAccountKey);
      if (parsed.project_id !== projectId) {
        warn(
          `project_id in service account JSON ("${parsed.project_id}") does NOT match ` +
          `FIREBASE_PROJECT_ID ("${projectId}"). This causes third-party-auth-error!`
        );
      } else {
        log(`Service account project_id matches: ${parsed.project_id} ✓`);
      }
      log(`Service account client_email: ${parsed.client_email}`);
      credential = admin.credential.cert(parsed);
    } catch (e) {
      err(`Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY: ${e.message}`);
      process.exit(1);
    }
  } else if (clientEmail && privateKey) {
    log('Using FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY');
    credential = admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    });
  } else {
    warn('No service account credentials found. Using Application Default Credentials.');
    warn('This will cause third-party-auth-error in most hosted environments!');
    credential = admin.credential.applicationDefault();
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential, projectId });
    }
    log('Firebase Admin SDK initialized successfully ✓');
  } catch (e) {
    err(`Firebase Admin SDK initialization failed: ${e.message}`);
    process.exit(1);
  }
}

// ─── Step 2: Connect to MongoDB ──────────────────────────────────────────────

async function connectDB() {
  log('=== STEP 2: Connecting to MongoDB ===');
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    err('MONGODB_URI is missing in .env');
    process.exit(1);
  }
  await mongoose.connect(uri);
  log('MongoDB connected ✓');
}

// ─── Step 3: Backup FCM token data ──────────────────────────────────────────

async function backupFcmTokens(User) {
  log('=== STEP 3: Backing up FCM token data ===');
  ensureBackupDir();

  const users = await User.find(
    { 'fcmTokens.0': { $exists: true } },
    { _id: 1, email: 1, mobile: 1, fcmTokens: 1 }
  ).lean();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `fcm-tokens-backup-${timestamp}.json`);

  const backupData = {
    createdAt: new Date().toISOString(),
    totalUsers: users.length,
    totalTokens: users.reduce((s, u) => s + (u.fcmTokens?.length || 0), 0),
    users: users.map((u) => ({
      _id: u._id,
      email: u.email,
      mobile: u.mobile,
      fcmTokens: u.fcmTokens,
    })),
  };

  fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
  log(`Backup saved → ${backupFile}`);
  log(`  Users with FCM tokens: ${backupData.totalUsers}`);
  log(`  Total FCM tokens: ${backupData.totalTokens}`);

  return backupFile;
}

// ─── Step 4: Probe tokens with FCM ──────────────────────────────────────────

const INVALID_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

const THIRD_PARTY_AUTH_CODE = 'messaging/third-party-auth-error';

async function probeTokens(tokens) {
  /**
   * Send a silent data-only message to each token.
   * We use sendEachForMulticast in batches of 500.
   * Returns { invalid: string[], authErrors: string[], valid: string[] }
   */
  const messaging = admin.messaging();
  const invalid = [];
  const authErrors = [];
  const valid = [];

  const BATCH = 500;
  for (let i = 0; i < tokens.length; i += BATCH) {
    const chunk = tokens.slice(i, i + BATCH);
    try {
      const result = await messaging.sendEachForMulticast({
        tokens: chunk,
        data: { type: 'fcm_probe', ts: String(Date.now()) },
        android: { priority: 'normal' },
        apns: { payload: { aps: { 'content-available': 1 } } },
      });

      result.responses.forEach((r, idx) => {
        const token = chunk[idx];
        if (r.success) {
          valid.push(token);
        } else {
          const code = r.error?.code || '';
          if (INVALID_CODES.has(code)) {
            invalid.push(token);
          } else if (code === THIRD_PARTY_AUTH_CODE) {
            authErrors.push(token);
          } else {
            // Other transient errors — keep the token
            valid.push(token);
          }
        }
      });
    } catch (e) {
      warn(`Batch probe failed (tokens ${i}–${i + chunk.length - 1}): ${e.message}`);
    }
  }

  return { invalid, authErrors, valid };
}

// ─── Step 5: Remove invalid tokens from DB ──────────────────────────────────

async function removeInvalidTokens(User, invalidTokens) {
  if (invalidTokens.length === 0) {
    log('No invalid tokens to remove.');
    return 0;
  }

  const result = await User.updateMany(
    { 'fcmTokens.token': { $in: invalidTokens } },
    { $pull: { fcmTokens: { token: { $in: invalidTokens } } } }
  );

  return result.modifiedCount;
}

// ─── Step 6: Test push notification ─────────────────────────────────────────

async function sendTestNotification(token) {
  log(`=== TEST: Sending test notification to token ${token.slice(0, 20)}... ===`);
  try {
    const result = await admin.messaging().send({
      token,
      notification: {
        title: '✅ FCM Test - Brahmakosh',
        body: 'Firebase push notification is working correctly!',
      },
      data: { type: 'fcm_test', ts: String(Date.now()) },
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    log(`Test notification sent successfully! Message ID: ${result}`);
  } catch (e) {
    err(`Test notification failed: ${e.code} — ${e.message}`);
    if (e.code === THIRD_PARTY_AUTH_CODE) {
      err('→ This confirms a credentials mismatch. Regenerate your Firebase service account key.');
    }
    if (INVALID_CODES.has(e.code)) {
      err('→ This token is invalid/unregistered. Use a fresh token from the app.');
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log('========================================');
  log('  Brahmakosh FCM Fix Script');
  log(`  Mode: ${DRY_RUN ? 'DRY-RUN (no DB changes)' : 'FIX (will remove invalid tokens)'}`);
  log('========================================\n');

  // Step 1
  verifyFirebaseCredentials();

  // Step 2
  await connectDB();

  // Lazy-load User model after DB connection
  const { default: User } = await import('../models/User.js');

  // Step 3 — backup first, always
  const backupFile = await backupFcmTokens(User);

  // If only testing a specific token, skip the rest
  if (TEST_TOKEN) {
    await sendTestNotification(TEST_TOKEN);
    await mongoose.disconnect();
    return;
  }

  // Collect all unique tokens
  log('=== STEP 4: Collecting all FCM tokens from DB ===');
  const users = await User.find(
    { 'fcmTokens.0': { $exists: true } },
    { _id: 1, fcmTokens: 1 }
  ).lean();

  const allTokens = [...new Set(
    users.flatMap((u) => (u.fcmTokens || []).map((t) => t.token).filter(Boolean))
  )];

  log(`Total unique FCM tokens to probe: ${allTokens.length}`);

  if (allTokens.length === 0) {
    log('No FCM tokens found in DB. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Step 4 — probe tokens
  log('=== STEP 5: Probing tokens with FCM (this may take a moment) ===');
  const { invalid, authErrors, valid } = await probeTokens(allTokens);

  log('\n--- Probe Results ---');
  log(`  Valid / deliverable tokens : ${valid.length}`);
  log(`  Invalid / unregistered     : ${invalid.length}  ← will be removed`);
  log(`  third-party-auth-error     : ${authErrors.length}  ← credentials issue (NOT removed)`);
  log('---------------------\n');

  if (authErrors.length > 0) {
    warn(`${authErrors.length} tokens returned third-party-auth-error.`);
    warn('These tokens are NOT removed — the error is caused by wrong Firebase credentials,');
    warn('not by the tokens themselves. Fix your FIREBASE_SERVICE_ACCOUNT_KEY in .env and');
    warn('restart the server. These tokens will work once credentials are correct.\n');
  }

  // Step 5 — remove or dry-run
  if (DRY_RUN) {
    log('DRY-RUN: The following tokens WOULD be removed (run with --fix to apply):');
    invalid.forEach((t) => log(`  - ${t.slice(0, 30)}...`));
    log(`\nRe-run with: node scripts/fcm-fix.js --fix`);
  } else {
    log(`=== STEP 6: Removing ${invalid.length} invalid tokens from DB ===`);
    const modified = await removeInvalidTokens(User, invalid);
    log(`Done. Modified ${modified} user document(s). ✓`);

    // Write a removal log
    const removalLog = path.join(
      BACKUP_DIR,
      `fcm-removed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    fs.writeFileSync(
      removalLog,
      JSON.stringify(
        { removedAt: new Date().toISOString(), count: invalid.length, tokens: invalid },
        null,
        2
      )
    );
    log(`Removal log saved → ${removalLog}`);
  }

  // Summary
  log('\n========== SUMMARY ==========');
  log(`Backup file      : ${backupFile}`);
  log(`Total tokens     : ${allTokens.length}`);
  log(`Valid            : ${valid.length}`);
  log(`Removed/to remove: ${invalid.length}`);
  log(`Auth errors      : ${authErrors.length} (fix credentials)`);
  if (authErrors.length > 0) {
    log('\nTO FIX third-party-auth-error:');
    log('  1. Go to Firebase Console → Project Settings → Service Accounts');
    log('  2. Click "Generate new private key"');
    log('  3. Copy the JSON content into FIREBASE_SERVICE_ACCOUNT_KEY in .env (single line)');
    log('  4. Restart: pm2 restart brahmakosh-backend --update-env');
    log('  5. Re-run: node scripts/fcm-fix.js --test-token <a_valid_fcm_token>');
  }
  log('==============================\n');

  await mongoose.disconnect();
  log('Done.');
}

main().catch((e) => {
  err(e.message);
  process.exit(1);
});
