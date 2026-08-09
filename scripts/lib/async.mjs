/** Run fn over items with at most `limit` concurrent jobs; results keep order. */
async function mapLimit(items, limit, fn) {
  const results = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export { mapLimit };
