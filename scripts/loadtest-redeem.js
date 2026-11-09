// Fires N simultaneous redemption requests for one reward as one user; exactly one must succeed.
// Usage: BASE_URL=http://localhost:5000 TOKEN=<user jwt> REWARD_ID=<id> node scripts/loadtest-redeem.js [50]
// (Check the mount path of the reward-redemptions router in app.js and set REDEEM_PATH if it differs.)
const { BASE_URL = 'http://localhost:5000', TOKEN, REWARD_ID, REDEEM_PATH = '/api/reward-redemptions/redeem' } = process.env;
const N = Number(process.argv[2] || 50);
if (!TOKEN || !REWARD_ID) {
  console.error('TOKEN and REWARD_ID environment variables are required');
  process.exit(2);
}
const results = await Promise.all(
  Array.from({ length: N }, () =>
    fetch(`${BASE_URL}${REDEEM_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ rewardId: REWARD_ID }),
    }).then((r) => r.status).catch(() => 0)
  )
);
const tally = results.reduce((a, s) => ((a[s] = (a[s] || 0) + 1), a), {});
console.log('status tally:', tally);
const ok = tally[200] === 1;
console.log(ok ? 'PASS: exactly one redemption succeeded' : `FAIL: expected exactly 1 success, got ${tally[200] || 0}`);
process.exit(ok ? 0 : 1);
