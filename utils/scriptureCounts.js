import mongoose from 'mongoose';

/**
 * Keeps parent.actualVerseCount in sync with the real number of verse documents.
 * Attach to a verse schema BEFORE the model is compiled:
 *   attachVerseCountHooks(schema, { parentModel: 'DurgaSaptashati', parentField: 'chapterId' });
 * Lazy mongoose.model() lookups avoid circular imports.
 */
export const recountVerses = async (verseModel, parentModel, parentField, parentId) => {
  if (!parentId) return;
  const actual = await verseModel.countDocuments({ [parentField]: parentId });
  await mongoose.model(parentModel).updateOne({ _id: parentId }, { $set: { actualVerseCount: actual } });
};

export const attachVerseCountHooks = (schema, { parentModel, parentField }) => {
  const safeRecount = (doc) =>
    recountVerses(doc.constructor, parentModel, parentField, doc[parentField]).catch((err) =>
      console.error(`[scriptureCounts] recount failed for ${parentModel} ${doc[parentField]}:`, err.message)
    );

  schema.post('save', function (doc) { return safeRecount(doc); });
  schema.post('findOneAndDelete', function (doc) { if (doc) return safeRecount(doc); });
  schema.post('findOneAndUpdate', function (doc) { if (doc) return safeRecount(doc); });
  schema.post('deleteOne', { document: true, query: false }, function () { return safeRecount(this); });
  // deleteMany / insertMany bypass per-document hooks; recount every affected parent.
  schema.post('insertMany', async function (docs) {
    const ids = [...new Set(docs.map((d) => String(d[parentField])))];
    await Promise.all(ids.map((id) => recountVerses(this, parentModel, parentField, id).catch(() => {})));
  });
  schema.pre('deleteMany', async function () {
    this._affectedParents = await this.model.distinct(parentField, this.getFilter());
  });
  schema.post('deleteMany', async function () {
    const ids = this._affectedParents || [];
    await Promise.all(ids.map((id) => recountVerses(this.model, parentModel, parentField, id).catch(() => {})));
  });
};
