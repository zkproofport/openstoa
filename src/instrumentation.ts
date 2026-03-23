export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runMigrations } = await import('./lib/db/migrate');
    await runMigrations();

    // Seed default categories if none exist
    try {
      const { db } = await import('./lib/db');
      const { categories } = await import('./lib/db/schema');
      const existing = await db.select().from(categories);
      const existingSlugs = new Set(existing.map(c => c.slug));
      {
        const defaults = [
          { name: 'General', slug: 'general', icon: '💬', sortOrder: 0 },
          { name: 'Blockchain', slug: 'blockchain', icon: '⛓️', sortOrder: 1 },
          { name: 'Ethereum', slug: 'ethereum', icon: '🔷', sortOrder: 2 },
          { name: 'AI & ML', slug: 'ai-ml', icon: '🤖', sortOrder: 3 },
          { name: 'Privacy', slug: 'privacy', icon: '🔒', sortOrder: 4 },
          { name: 'DeFi', slug: 'defi', icon: '💰', sortOrder: 5 },
          { name: 'Governance', slug: 'governance', icon: '🏛️', sortOrder: 6 },
          { name: 'Technology', slug: 'technology', icon: '💻', sortOrder: 7 },
          { name: 'Sports', slug: 'sports', icon: '⚽', sortOrder: 8 },
          { name: 'Science', slug: 'science', icon: '🔬', sortOrder: 9 },
          { name: 'Music & Art', slug: 'music-art', icon: '🎵', sortOrder: 10 },
          { name: 'Gaming', slug: 'gaming', icon: '🎮', sortOrder: 11 },
        ];
        const toInsert = defaults.filter(d => !existingSlugs.has(d.slug));
        if (toInsert.length > 0) {
          await db.insert(categories).values(toInsert);
        }
        console.log(`[DB] Categories: ${existing.length} existing, ${toInsert.length} added`);
      }
    } catch (err) {
      console.error('[DB] Category seed failed:', err instanceof Error ? err.message : err);
    }
  }
}
