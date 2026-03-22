export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runMigrations } = await import('./lib/db/migrate');
    await runMigrations();

    // Seed default categories if none exist
    try {
      const { db } = await import('./lib/db');
      const { categories } = await import('./lib/db/schema');
      const existing = await db.select().from(categories);
      if (existing.length === 0) {
        const defaults = [
          { name: 'General', slug: 'general', icon: '💬', sortOrder: 0 },
          { name: 'Technology', slug: 'technology', icon: '💻', sortOrder: 1 },
          { name: 'Privacy', slug: 'privacy', icon: '🔒', sortOrder: 2 },
          { name: 'Governance', slug: 'governance', icon: '🏛️', sortOrder: 3 },
        ];
        await db.insert(categories).values(defaults);
        console.log(`[DB] Seeded ${defaults.length} default categories`);
      }
    } catch (err) {
      console.error('[DB] Category seed failed:', err instanceof Error ? err.message : err);
    }
  }
}
