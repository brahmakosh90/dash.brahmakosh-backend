import Notification from '../models/Notification.js';
import User from '../models/User.js';
import ClientNotificationCampaign from '../models/ClientNotificationCampaign.js';
import { sendFcmToTokens } from '../utils/fcmMessaging.js';

let schedulerStarted = false;
let isProcessing = false;

// A campaign stuck in 'sending' longer than this (server crashed mid-send) may be claimed again
const STALE_SENDING_MS = 10 * 60 * 1000;

// Atomic claim: only one caller (scheduler tick, immediate post, another server instance) gets to send a campaign,
// so a user never receives the same notification twice.
const claimCampaign = (id) =>
  ClientNotificationCampaign.findOneAndUpdate(
    {
      _id: id,
      $or: [
        { status: 'scheduled' },
        { status: 'sending', updatedAt: { $lt: new Date(Date.now() - STALE_SENDING_MS) } }
      ]
    },
    { status: 'sending' },
    { new: true }
  );

const normalizeUserIds = (ids = []) => {
  const unique = new Set(ids.map((id) => id?.toString()).filter(Boolean));
  return [...unique];
};

const sendCampaign = async (campaign) => {
  const validUsers = await User.find({
    _id: { $in: campaign.userIds || [] },
    clientId: campaign.clientId,
    isActive: true
  }).select('_id fcmTokens');

  const userIds = validUsers.map((u) => u._id.toString());
  const now = new Date();
  let pushMetrics = { sentTokens: 0, failedTokens: 0, totalTokens: 0 };
  let pushSkipped = false;

  const fcmTokensCount = validUsers.reduce((sum, u) => sum + ((u.fcmTokens || []).length || 0), 0);
  console.log('[ClientNotification] Campaign send started', {
    campaignId: campaign?._id ? String(campaign._id) : undefined,
    clientId: campaign?.clientId ? String(campaign.clientId) : undefined,
    groupId: campaign?.groupId ? String(campaign.groupId) : null,
    postType: campaign?.postType,
    recipients: userIds.length,
    fcmTokensCount
  });

  if (userIds.length === 0) {
    await ClientNotificationCampaign.findByIdAndUpdate(campaign._id, {
      status: 'failed',
      errorMessage: 'No valid active users found for this campaign',
      totalRecipients: 0,
      sentCount: 0,
      failedCount: 0
    });
    return;
  }

  const notificationDocs = userIds.map((userId) => ({
    userId,
    type: 'client_broadcast',
    title: campaign.name,
    message: campaign.description,
    data: {
      url: campaign.url || '',
      campaignId: String(campaign._id),
      groupId: campaign.groupId ? String(campaign.groupId) : '',
      clientId: String(campaign.clientId)
    },
    sentAt: now
  }));

  await Notification.insertMany(notificationDocs);

  const fcmTokens = validUsers.flatMap((u) => (u.fcmTokens || []).map((t) => t.token).filter(Boolean));
  if (fcmTokens.length > 0) {
    try {
      const pushResult = await sendFcmToTokens(fcmTokens, {
        title: campaign.name,
        body: campaign.description,
        data: {
          type: 'client_broadcast',
          url: campaign.url || '',
          campaignId: String(campaign._id),
          groupId: campaign.groupId ? String(campaign.groupId) : '',
          clientId: String(campaign.clientId)
        }
      });

      pushSkipped = !!pushResult?.skipped;
      pushMetrics = {
        sentTokens: pushResult?.sent || 0,
        failedTokens: pushResult?.failed || 0,
        totalTokens: (pushResult?.sent || 0) + (pushResult?.failed || 0),
        thirdPartyAuthErrors: pushResult?.thirdPartyAuthErrors || 0
      };

      if (pushResult?.invalidTokens?.length) {
        // Remove invalid tokens so we stop sending to them.
        await User.updateMany(
          { 'fcmTokens.token': { $in: pushResult.invalidTokens } },
          { $pull: { fcmTokens: { token: { $in: pushResult.invalidTokens } } } }
        );

        console.log('[ClientNotification] Invalid tokens removed', {
          campaignId: String(campaign._id),
          removed: pushResult.invalidTokens.length
        });
      }
    } catch (e) {
      console.error('[ClientNotification] FCM push error:', e.message);
    }
  }

  const allTokensFailed = pushMetrics.totalTokens > 0 && pushMetrics.sentTokens === 0;
  const hasAuthErrors = (pushMetrics.thirdPartyAuthErrors || 0) > 0;
  let warning = '';
  if (fcmTokens.length === 0) warning = 'Saved in the app inbox. None of the recipients has a push-enabled device yet.';
  else if (pushSkipped) warning = 'Saved in the app inbox, but push was not sent: Firebase is not configured on the server.';
  else if (hasAuthErrors && pushMetrics.sentTokens === 0) warning = `Push failed: Firebase service account credentials are invalid (third-party-auth-error). Regenerate the service account key in Firebase Console and update FIREBASE_SERVICE_ACCOUNT_KEY in .env.`;
  else if (hasAuthErrors) warning = `${pushMetrics.thirdPartyAuthErrors} token(s) failed due to invalid Firebase credentials. Fix FIREBASE_SERVICE_ACCOUNT_KEY to reach all devices.`;
  const campaignUpdate = {
    status: allTokensFailed ? 'failed' : 'sent',
    sentAt: now,
    totalRecipients: userIds.length,
    totalTokens: pushMetrics.totalTokens,
    sentCount: pushMetrics.sentTokens,
    failedCount: pushMetrics.failedTokens,
    errorMessage: allTokensFailed
      ? (hasAuthErrors
          ? 'Firebase credentials invalid (third-party-auth-error). Fix FIREBASE_SERVICE_ACCOUNT_KEY in .env.'
          : 'All device tokens failed to receive push')
      : warning
  };

  await ClientNotificationCampaign.findByIdAndUpdate(campaign._id, {
    ...campaignUpdate
  });

  console.log('[ClientNotification] Campaign send finished', {
    campaignId: String(campaign._id),
    status: campaignUpdate.status,
    totalTokens: campaignUpdate.totalTokens,
    sentTokens: campaignUpdate.sentCount,
    failedTokens: campaignUpdate.failedCount
  });
};

const sendClaimed = async (campaign) => {
  try {
    campaign.userIds = normalizeUserIds(campaign.userIds);
    await sendCampaign(campaign);
  } catch (error) {
    await ClientNotificationCampaign.findByIdAndUpdate(campaign._id, {
      status: 'failed',
      errorMessage: error.message || 'Failed to send campaign'
    });
  }
};

/** Send one campaign right now (used by "Immediate Post"). No-op if another worker already claimed it. */
export const sendClientNotificationCampaignNow = async (campaignId) => {
  const claimed = await claimCampaign(campaignId);
  if (claimed) await sendClaimed(claimed);
};

export const processDueClientNotificationCampaigns = async () => {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const now = new Date();
    const due = await ClientNotificationCampaign.find({
      $or: [
        { status: 'scheduled', $or: [{ postType: 'immediate' }, { scheduledFor: { $lte: now } }] },
        { status: 'sending', updatedAt: { $lt: new Date(now.getTime() - STALE_SENDING_MS) } }
      ]
    })
      .select('_id')
      .sort({ createdAt: 1 })
      .lean();

    if (due.length > 0) {
      console.log('[ClientNotificationScheduler] Due campaigns found', { count: due.length, now: now.toISOString() });
    }

    for (const { _id } of due) {
      const claimed = await claimCampaign(_id);
      if (claimed) await sendClaimed(claimed);
    }
  } finally {
    isProcessing = false;
  }
};

export const startClientNotificationScheduler = () => {
  if (schedulerStarted) return;
  schedulerStarted = true;

  processDueClientNotificationCampaigns().catch((error) => {
    console.error('[ClientNotificationScheduler] Initial run failed:', error.message);
  });

  setInterval(() => {
    processDueClientNotificationCampaigns().catch((error) => {
      console.error('[ClientNotificationScheduler] Scheduled run failed:', error.message);
    });
  }, 30 * 1000);
};
