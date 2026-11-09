import DurgaSaptashati from '../models/DurgaSaptashati.js';
import DurgaSaptashatiVerse from '../models/DurgaSaptashatiVerse.js';
import ShivPuran from '../models/ShivPuran.js';
import ShivPuranVerse from '../models/ShivPuranVerse.js';
import Ramayana from '../models/Ramayana.js';
import RamayanaVerse from '../models/RamayanaVerse.js';

// Unified description of every scripture: parent (chapter/part/kanda) model, verse model, and field names.
export const SCRIPTURES = [
  { key: 'durgaSaptashati', label: 'Durga Saptashati', Parent: DurgaSaptashati, Verse: DurgaSaptashatiVerse, parentField: 'chapterId', numberField: 'chapterNumber' },
  { key: 'shivPuran', label: 'Shiv Puran', Parent: ShivPuran, Verse: ShivPuranVerse, parentField: 'partId', numberField: 'partNumber' },
  { key: 'ramayana', label: 'Ramayana', Parent: Ramayana, Verse: RamayanaVerse, parentField: 'kandaId', numberField: 'kandaNumber' },
];

/** Per-scripture comparison of declared verseCount vs. real verse documents, per chapter. */
export const getScriptureCoverage = async ({ fix = false } = {}) => {
  const result = [];
  for (const s of SCRIPTURES) {
    const parents = await s.Parent.find({}).sort({ [s.numberField]: 1 }).lean();
    const grouped = await s.Verse.aggregate([{ $group: { _id: '$' + s.parentField, n: { $sum: 1 } } }]);
    const actualById = new Map(grouped.map((g) => [String(g._id), g.n]));

    const chapters = [];
    for (const p of parents) {
      const actual = actualById.get(String(p._id)) || 0;
      const declared = p.verseCount || 0;
      if (fix && p.actualVerseCount !== actual) {
        await s.Parent.updateOne({ _id: p._id }, { $set: { actualVerseCount: actual } });
      }
      chapters.push({
        id: String(p._id), clientId: p.clientId, number: p[s.numberField], title: p.title,
        declared, actual, missing: Math.max(declared - actual, 0), isComplete: actual >= declared,
      });
    }
    const declared = chapters.reduce((a, c) => a + c.declared, 0);
    const actual = chapters.reduce((a, c) => a + Math.min(c.actual, c.declared), 0);
    result.push({
      key: s.key, label: s.label, chapterCount: chapters.length,
      declaredCount: declared, actualCount: chapters.reduce((a, c) => a + c.actual, 0),
      completionPercent: declared ? Math.round((actual / declared) * 1000) / 10 : 0,
      missingChapters: chapters.filter((c) => !c.isComplete).map((c) => ({ number: c.number, title: c.title, declared: c.declared, actual: c.actual })),
      chapters,
    });
  }
  return result;
};
