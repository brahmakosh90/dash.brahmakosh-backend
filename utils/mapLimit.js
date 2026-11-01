/** Like Promise.all(items.map(fn)) but with at most `limit` calls in flight; results keep the input order. */
export const mapLimit = async (items, limit, fn) => {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};
