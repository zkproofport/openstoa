// Lightweight client-side filter shared by every list screen that
// exposes a search bar. Splits the query into whitespace-separated
// terms, each of which must appear in at least one of the indexed
// fields (case-insensitive). Empty query short-circuits to the
// original list. HTML tags in field values are stripped before
// matching so the user sees the same content they see on screen.

export function filterByQuery<T>(
  items: T[],
  query: string,
  extractFields: (item: T) => Array<string | null | undefined>,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const terms = q.split(/\s+/);
  const stripHtml = (s: string) => s.replace(/<[^>]*>/g, ' ');
  return items.filter((item) => {
    const haystack = extractFields(item)
      .filter((s): s is string => !!s)
      .map((s) => stripHtml(s).toLowerCase())
      .join('   ');
    return terms.every((term) => haystack.includes(term));
  });
}
