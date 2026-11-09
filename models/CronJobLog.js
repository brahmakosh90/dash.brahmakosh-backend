import mongoose from 'mongoose';

const cronJobLogSchema = new mongoose.Schema({
  jobName: { type: String, required: true, index: true },
  runAt: { type: Date, default: Date.now },
  durationMs: Number,
  processed: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  errors: [{ _id: false, ref: String, message: String }],
});

// Keep 90 days of history
cronJobLogSchema.index({ runAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

export default mongoose.model('CronJobLog', cronJobLogSchema);
