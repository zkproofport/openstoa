/**
 * Data-access for Phase 4 key recovery (design §6.4, SI-8). Pure DB moves of
 * OPAQUE ciphertext — this layer never runs crypto and never sees a plaintext
 * key. Mirrors the archive.ts convention (a db handle is passed in, so routes
 * and tests share one implementation).
 *
 * Three server-side stores, all cascade-deleting with the user account:
 *   - key_backups           : recovery-code-wrapped master_key (1 per user)
 *   - key_backup_passkeys   : PRF-wrapped master_key (N per user, by credential)
 *   - tak_key_backups       : master_key-encrypted TAK keychain blob (1 per user)
 */
import { eq, and } from 'drizzle-orm';
import { db } from '@/lib/db';
import { keyBackups, keyBackupPasskeys, takKeyBackups } from '@/lib/db/schema';

// The Drizzle query-builder + relational (`db.query.*`) API needs the full db
// type (schema-aware), so we type against the shared instance rather than the
// structural SqlExecutor used by the raw-SQL archive helpers.
type DB = typeof db;

// Decoded-byte caps (SI-4). A wrapped master_key is ~60 bytes; the TAK keychain
// grows with (topics × epochs) held but stays small — cap generously, reject abuse.
export const KEY_BACKUP_MAX_BYTES = 4 * 1024;
export const TAK_KEY_BACKUP_MAX_BYTES = 1024 * 1024;
// A user has one passkey per device — a handful, never hundreds. Cap to bound the
// child table and reject enumeration/abuse.
export const MAX_PASSKEYS_PER_USER = 20;

export async function upsertKeyBackup(db: DB, userId: string, wrappedMaster: Buffer): Promise<void> {
  await db
    .insert(keyBackups)
    .values({ userId, wrappedMaster })
    .onConflictDoUpdate({ target: keyBackups.userId, set: { wrappedMaster, updatedAt: new Date() } });
}

export async function getKeyBackup(db: DB, userId: string): Promise<{ wrappedMaster: Buffer } | null> {
  const row = await db.query.keyBackups.findFirst({ where: eq(keyBackups.userId, userId) });
  return row ? { wrappedMaster: row.wrappedMaster } : null;
}

export async function deleteKeyBackup(db: DB, userId: string): Promise<void> {
  await db.delete(keyBackups).where(eq(keyBackups.userId, userId));
}

/** Number of passkey wraps the user already has (to enforce MAX_PASSKEYS_PER_USER). */
export async function countPasskeyWraps(db: DB, userId: string): Promise<number> {
  const rows = await db.query.keyBackupPasskeys.findMany({ where: eq(keyBackupPasskeys.userId, userId) });
  return rows.length;
}

export async function upsertPasskeyWrap(
  db: DB,
  userId: string,
  credentialId: string,
  prfWrapped: Buffer,
): Promise<void> {
  await db
    .insert(keyBackupPasskeys)
    .values({ userId, credentialId, prfWrapped })
    .onConflictDoUpdate({
      target: [keyBackupPasskeys.userId, keyBackupPasskeys.credentialId],
      set: { prfWrapped },
    });
}

export async function listPasskeyWraps(
  db: DB,
  userId: string,
): Promise<Array<{ credentialId: string; prfWrapped: Buffer }>> {
  const rows = await db.query.keyBackupPasskeys.findMany({ where: eq(keyBackupPasskeys.userId, userId) });
  return rows.map((r) => ({ credentialId: r.credentialId, prfWrapped: r.prfWrapped }));
}

export async function deletePasskeyWrap(db: DB, userId: string, credentialId: string): Promise<number> {
  const deleted = await db
    .delete(keyBackupPasskeys)
    .where(and(eq(keyBackupPasskeys.userId, userId), eq(keyBackupPasskeys.credentialId, credentialId)))
    .returning({ credentialId: keyBackupPasskeys.credentialId });
  return deleted.length;
}

export async function upsertTakBackup(db: DB, userId: string, ciphertext: Buffer): Promise<void> {
  await db
    .insert(takKeyBackups)
    .values({ userId, ciphertext })
    .onConflictDoUpdate({ target: takKeyBackups.userId, set: { ciphertext, updatedAt: new Date() } });
}

export async function getTakBackup(db: DB, userId: string): Promise<{ ciphertext: Buffer } | null> {
  const row = await db.query.takKeyBackups.findFirst({ where: eq(takKeyBackups.userId, userId) });
  return row ? { ciphertext: row.ciphertext } : null;
}
