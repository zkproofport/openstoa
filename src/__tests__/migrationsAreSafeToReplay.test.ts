/**
 * A migration that drops something by name must tolerate it not being there.
 *
 * Migrations run at boot (`src/instrumentation.ts` awaits `runMigrations`), and
 * the runner forgives exactly three Postgres errors: relation, constraint and
 * column "already exists". Everything else throws, and because nothing catches
 * it, the server never finishes starting. Cloud Run then keeps the previous
 * revision serving — so the site answers 200, the deploy reports success, and
 * the thing the migration was supposed to fix is quietly still broken.
 *
 * On 2026-08-29 a migration dropped 21 constraints by name, and those names had
 * been read off one developer's machine. Any database whose constraints were
 * created by a different route — a hand-written name, a table that never got
 * the constraint at all — would have hit undefined_object on the first drop and
 * failed to boot. Nothing about that failure is visible from outside.
 *
 * So: every DROP names something that might not exist, and must say IF EXISTS.
 * ADD is the opposite case and is deliberately not checked — "already exists"
 * is one of the three the runner forgives, so a duplicate add is harmless.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'drizzle');

/** `DROP <thing> "name"` with no IF EXISTS between the two. */
const UNGUARDED_DROP =
  /\bDROP\s+(CONSTRAINT|TABLE|COLUMN|INDEX|TYPE|VIEW|SEQUENCE)\s+(?!IF\s+EXISTS)/gi;

describe('migrations are safe to replay', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  it('there are migrations to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s guards every DROP with IF EXISTS', (file) => {
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    /*
     * Comments are stripped first: this file's own explanation says DROP
     * several times, and so do the notes at the top of real migrations.
     */
    const code = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    const unguarded = code.match(UNGUARDED_DROP) ?? [];
    if (unguarded.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `\n${file}: ${unguarded.length} unguarded drop(s).\n` +
          'A drop that names something absent throws undefined_object, which the\n' +
          'boot-time runner does not forgive — the server fails to start and the\n' +
          'previous revision keeps serving as though nothing happened.\n' +
          'Write DROP ... IF EXISTS.\n',
      );
    }
    expect(unguarded).toEqual([]);
  });

  it('every migration file on disk is listed in the journal, and the reverse', () => {
    /*
     * A file the journal does not name never runs; a journal entry with no file
     * throws ENOENT at boot. Both are silent until a deploy.
     */
    const journal = JSON.parse(fs.readFileSync(path.join(DIR, 'meta', '_journal.json'), 'utf8'));
    const listed = new Set<string>(journal.entries.map((e: { tag: string }) => `${e.tag}.sql`));
    const onDisk = new Set(files);

    expect([...onDisk].filter((f) => !listed.has(f)), 'on disk but never run').toEqual([]);
    expect([...listed].filter((f) => !onDisk.has(f)), 'listed but the file is gone').toEqual([]);
  });
});
