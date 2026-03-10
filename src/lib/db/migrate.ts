import { Pool } from 'pg';

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS community_users (
  id TEXT PRIMARY KEY,
  nickname TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS community_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  creator_id TEXT NOT NULL REFERENCES community_users(id),
  requires_country_proof BOOLEAN DEFAULT FALSE,
  allowed_countries TEXT[],
  invite_code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS community_topic_members (
  topic_id UUID NOT NULL REFERENCES community_topics(id),
  user_id TEXT NOT NULL REFERENCES community_users(id),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (topic_id, user_id)
);

CREATE TABLE IF NOT EXISTS community_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id UUID NOT NULL REFERENCES community_topics(id),
  author_id TEXT NOT NULL REFERENCES community_users(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS community_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES community_posts(id),
  author_id TEXT NOT NULL REFERENCES community_users(id),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

let migrated = false;

export async function runMigrations(): Promise<void> {
  if (migrated) return;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL environment variable is required');

  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(MIGRATIONS);
    console.log('[DB] Auto-migration completed');
    migrated = true;
  } finally {
    await pool.end();
  }
}
