// Abandonment check extracted from cronJobs.js so it can be unit tested with injected dependencies.

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

export const countConsecutiveMissed = (dailyReports = [], today = new Date(), days = 3) => {
  let missed = 0;
  for (let i = 1; i <= days; i++) {
    const check = startOfDay(today);
    check.setDate(check.getDate() - i);
    const report = dailyReports.find((r) => startOfDay(r.date).getTime() === check.getTime());
    if (report && report.status === 'not_reported') missed++;
    else break;
  }
  return missed;
};

/**
 * Marks sankalpas abandoned after 3 consecutive unreported days and notifies the user.
 * One record failing never aborts the batch; the run is recorded in CronJobLog.
 */
export const runAbandonmentCheck = async ({ UserSankalp, notificationService, CronJobLog, now = new Date(), logger = console }) => {
  const startedAt = Date.now();
  const summary = { processed: 0, failed: 0, abandoned: 0, errors: [] };

  try {
    const active = await UserSankalp.find({ status: 'active' }).populate('sankalpId userId');

    for (const us of active) {
      try {
        if (!us.userId || !us.sankalpId) {
          logger.warn(`[Abandonment] Skipping UserSankalp ${us._id}: missing populated ${!us.userId ? 'userId' : 'sankalpId'}`);
          continue;
        }
        summary.processed++;

        if (countConsecutiveMissed(us.dailyReports, now) < 3) continue;

        us.status = 'abandoned';
        await us.save();
        summary.abandoned++;

        // The record is already abandoned; a notification failure is recorded but must not undo it.
        try {
          await notificationService.sendAbandonmentNotification(us.userId._id, us._id, us.sankalpId.title);
        } catch (notifyErr) {
          summary.failed++;
          summary.errors.push({ ref: String(us._id), message: `notify: ${notifyErr.message}` });
        }
      } catch (err) {
        summary.failed++;
        summary.errors.push({ ref: String(us?._id), message: err.message });
        logger.error(`[Abandonment] Failed processing UserSankalp ${us?._id}:`, err.message);
      }
    }
  } catch (err) {
    summary.failed++;
    summary.errors.push({ ref: 'query', message: err.message });
    logger.error('[Abandonment] Query failed:', err.message);
  }

  try {
    await CronJobLog.create({
      jobName: 'sankalp-abandonment',
      runAt: new Date(startedAt),
      durationMs: Date.now() - startedAt,
      processed: summary.processed,
      failed: summary.failed,
      errors: summary.errors.slice(0, 50),
    });
  } catch (err) {
    logger.error('[Abandonment] Could not write CronJobLog:', err.message);
  }
  return summary;
};
