const BUILT_IN_CATEGORIES = new Set(['base-layer2', 'defi-trading', 'nft-gaming', 'privacy-zk', 'development', 'governance', 'free-talk', 'announcements']);

export function categoryLabel(category: { slug: string; name: string }, t: (key: string) => string): string {
  return BUILT_IN_CATEGORIES.has(category.slug) ? t(`openstoa.categories.${category.slug}`) : category.name;
}
