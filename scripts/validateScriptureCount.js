// Standalone integrity report: declared verseCount vs. real verse documents for every scripture chapter.
// Usage: node scripts/validateScriptureCount.js [--fix]
//   --fix  also backfills actualVerseCount on each parent document (idempotent)
// Exit code 1 when any chapter is incomplete, so it can gate CI / cron checks.
import 'dotenv/config';
import mongoose from 'mongoose';
import { getScriptureCoverage } from '../utils/scriptureRegistry.js';

const fix = process.argv.includes('--fix');
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) {
  console.error('MONGODB_URI is not set');
  process.exit(2);
}

await mongoose.connect(uri);
let incomplete = 0;
try {
  const report = await getScriptureCoverage({ fix });
  for (const s of report) {
    console.log(`\n=== ${s.label} — declared ${s.declaredCount}, actual ${s.actualCount}, completion ${s.completionPercent}% ===`);
    console.table(s.chapters.map((c) => ({ '#': c.number, title: c.title, declared: c.declared, actual: c.actual, missing: c.missing, ok: c.isComplete ? 'yes' : 'NO' })));
    incomplete += s.missingChapters.length;
  }
  if (fix) console.log('\nactualVerseCount backfilled on all parent documents.');
  console.log(`\n${incomplete} incomplete chapter(s).`);
} finally {
  await mongoose.disconnect();
}
process.exit(incomplete ? 1 : 0);
