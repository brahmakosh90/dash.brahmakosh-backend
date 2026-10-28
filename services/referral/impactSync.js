// Keeps the spiritual-impact signals on referral records in step with real app activity (reads SpiritualSession only).
import cron from 'node-cron';
import mongoose from 'mongoose';
import ReferralRecord from '../../models/referral/ReferralRecord.js';
import SpiritualSession from '../../models/SpiritualSession.js';
import { dayStr } from './rules.js';

const BATCH = 500;

export const syncImpact = async () => {
  const since = dayStr(-120);
  const active14 = new Date(Date.now() - 14 * 86400000);
  const cursor = ReferralRecord.find({ status: 'registered', userId: { $type: 'objectId' }, regAt: { $gte: since } }).select('+userId').lean().cursor();
  let batch = []; let updated = 0;
  const flush = async () => {
    if (!batch.length) return;
    const agg = await SpiritualSession.aggregate([
      { $match: { userId: { $in: batch.map((r) => r.userId) }, status: 'completed' } },
      { $group: { _id: '$userId', sessions: { $sum: 1 }, minutes: { $sum: { $ifNull: ['$actualDuration', 0] } }, last: { $max: '$completedAt' } } },
    ]);
    const by = new Map(agg.map((a) => [String(a._id), a]));
    const ops = batch.map((r) => { const a = by.get(String(r.userId)); return { updateOne: { filter: { _id: r._id }, update: { $set: { sessions: a?.sessions || 0, minutes: Math.round(a?.minutes || 0), firstActivity: !!a, activeNow: !!a && a.last >= active14 } } } }; });
    const res = await ReferralRecord.bulkWrite(ops, { ordered: false });
    updated += res.modifiedCount; batch = [];
  };
  for await (const r of cursor) { batch.push(r); if (batch.length >= BATCH) await flush(); }
  await flush();
  return updated;
};

let started = false;
/** Runs nightly at 02:30 once the database connection is up. */
export const startImpactSync = () => {
  if (started) return; started = true;
  cron.schedule('30 2 * * *', async () => {
    if (mongoose.connection.readyState !== 1) return;
    try { console.log(`[referral] impact sync updated ${await syncImpact()} records`); } catch (e) { console.error('[referral] impact sync failed:', e.message); }
  });
};
