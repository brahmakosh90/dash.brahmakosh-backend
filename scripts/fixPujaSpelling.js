/**
 * Puja Vidhi spelling / ingredient (samagri) correction.
 *
 * The wrong spellings live in the database, so they are fixed as data, never guessed in code:
 *   1. Export every distinct text you may want to review:
 *        node scripts/fixPujaSpelling.js --export puja-texts.json
 *   2. Write a corrections file (wrong -> right), e.g. { "Ganesh Puja": "Ganesh Pooja" }
 *   3. Preview what would change (default, writes nothing):
 *        node scripts/fixPujaSpelling.js --apply corrections.json
 *   4. Apply for real:
 *        node scripts/fixPujaSpelling.js --apply corrections.json --commit
 *
 * Matching is exact on the whole field value (after trimming), so a correction can never
 * rewrite part of an unrelated word. Covered fields: pujaName, category, subcategory, purpose,
 * pujaVidhi, specialInstructions, samagriList[].itemName/quantity, mantras[].meaning.
 */
import fs from 'fs';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import PujaPadhati from '../models/PujaPadhati.js';

dotenv.config();

const TOP_LEVEL_FIELDS = ['pujaName', 'category', 'subcategory', 'purpose', 'pujaVidhi', 'specialInstructions'];

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

const readCorrections = (file) => {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const map = new Map();
  for (const [wrong, right] of Object.entries(parsed)) {
    if (typeof right !== 'string' || !wrong.trim() || wrong.trim() === right.trim()) continue;
    map.set(wrong.trim(), right.trim());
  }
  return map;
};

const fixValue = (value, corrections) => {
  if (typeof value !== 'string') return null;
  const fixed = corrections.get(value.trim());
  return fixed !== undefined && fixed !== value ? fixed : null;
};

// Applies corrections to one document in place; returns a list of human-readable changes.
const applyToDoc = (doc, corrections) => {
  const changes = [];
  const set = (target, key, label) => {
    const fixed = fixValue(target[key], corrections);
    if (fixed !== null) {
      changes.push(`${label}: "${target[key]}" -> "${fixed}"`);
      target[key] = fixed;
    }
  };
  TOP_LEVEL_FIELDS.forEach((f) => set(doc, f, f));
  (doc.samagriList || []).forEach((item, i) => {
    set(item, 'itemName', `samagriList[${i}].itemName`);
    set(item, 'quantity', `samagriList[${i}].quantity`);
  });
  (doc.mantras || []).forEach((m, i) => set(m, 'meaning', `mantras[${i}].meaning`));
  return changes;
};

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const exportFile = argValue('--export');
  const applyFile = argValue('--apply');
  const commit = process.argv.includes('--commit');

  if (exportFile) {
    const docs = await PujaPadhati.find({}).lean();
    const texts = { pujaName: new Set(), category: new Set(), samagriItemName: new Set(), samagriQuantity: new Set() };
    for (const d of docs) {
      if (d.pujaName) texts.pujaName.add(d.pujaName);
      if (d.category) texts.category.add(d.category);
      (d.samagriList || []).forEach((s) => {
        if (s.itemName) texts.samagriItemName.add(s.itemName);
        if (s.quantity) texts.samagriQuantity.add(s.quantity);
      });
    }
    const out = Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, [...v].sort((a, b) => a.localeCompare(b))]));
    fs.writeFileSync(exportFile, JSON.stringify(out, null, 2), 'utf-8');
    console.log(`Exported ${docs.length} pujas to ${exportFile}`);
  }

  if (applyFile) {
    const corrections = readCorrections(applyFile);
    console.log(`${corrections.size} corrections loaded - ${commit ? 'COMMIT mode' : 'dry run (add --commit to write)'}`);
    const docs = await PujaPadhati.find({});
    let touched = 0;
    for (const doc of docs) {
      const changes = applyToDoc(doc, corrections);
      if (changes.length === 0) continue;
      touched += 1;
      console.log(`\n${doc.pujaName} (${doc._id})\n  ${changes.join('\n  ')}`);
      if (commit) await doc.save();
    }
    console.log(`\n${touched} document(s) ${commit ? 'updated' : 'would change'}.`);
  }

  if (!exportFile && !applyFile) console.log('Usage: --export <file> and/or --apply <corrections.json> [--commit]');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
