// Reports (and with --apply, removes) duplicate redemptions so the unique index can build. Idempotent.
// Usage: node scripts/dedupeRewardRedemptions.js [--apply]
import 'dotenv/config';
import mongoose from 'mongoose';
import RewardRedemption from '../models/RewardRedemption.js';

const apply = process.argv.includes('--apply');
await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
const groups = await RewardRedemption.aggregate([
  { $sort: { redeemedAt: 1 } },
  { $group: { _id: { userId: '$userId', rewardId: '$rewardId', clientId: '$clientId' }, ids: { $push: '$_id' }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]);
console.log(`${groups.length} duplicate group(s) found`);
for (const g of groups) {
  const extra = g.ids.slice(1); // keep the earliest
  console.log(JSON.stringify(g._id), 'duplicates:', extra.length);
  if (apply) await RewardRedemption.deleteMany({ _id: { $in: extra } });
}
if (!apply && groups.length) console.log('Dry run. Re-run with --apply to delete extras (karma is NOT refunded automatically).');
else await RewardRedemption.syncIndexes();
await mongoose.disconnect();
