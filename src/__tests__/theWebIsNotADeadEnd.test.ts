/**
 * Three ways the web left a person stuck, found by walking it in a browser on
 * 2026-08-29 rather than by reading it.
 *
 * NO WAY OUT OF YOUR OWN ACCOUNT. Deleting a topic existed on the server and in
 * the app, and nowhere on the web. That is not a missing convenience: account
 * deletion refuses while you still own a topic, and the only ways to stop
 * owning one are to hand it to another member or delete it. Someone who made a
 * topic on the web and never invited anyone had neither. Pressing Delete
 * Account returned "Please transfer topic ownership first" and named a topic
 * there was no way to be rid of — a loop with no exit.
 *
 * A DEAD BUTTON WITH NO REASON. Creating a topic needs a category, and none was
 * selected on arrival, so Create sat greyed out. The required marker is a red
 * asterisk far up a long form, off screen by the time you reach the button, and
 * nothing else says why it will not press. The app has always arrived with the
 * first category chosen.
 *
 * A WRONG ADDRESS LANDED NOWHERE. Next.js's built-in page: white ground, black
 * "404", no header, no way back — and not only typos get there. A link to a
 * topic somebody deleted lands there too, and the person following it is told
 * nothing about what happened or where to go.
 *
 * These read the source rather than render it, because what is being pinned is
 * that the way out EXISTS at all. A rendering test would pass just as happily
 * against a page whose delete button was quietly dropped in a refactor.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), 'src', rel), 'utf8');

describe('the web is not a dead end', () => {
  it('a topic owner can delete their topic from the web', () => {
    const page = src('app/topics/[topicId]/edit/page.tsx');
    expect(page, 'the edit page no longer calls DELETE on the topic').toMatch(
      /apiFetch\(`\/api\/topics\/\$\{topicId\}`,\s*\{\s*method:\s*'DELETE'/,
    );
    expect(page, 'the delete button is gone from the edit page').toContain(
      "t('editTopicPage.deleteTopic')",
    );
    expect(page, 'the delete no longer asks before doing it').toContain(
      "window.confirm(t('editTopicPage.deleteConfirm'))",
    );
  });

  it('the web asks before deleting in the same words the app uses', () => {
    /*
     * The sentence read before an irreversible thing must not depend on which
     * screen a person happens to be on.
     */
    const web = JSON.parse(src('lib/i18n/locales/en.json'));
    const app = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'packages/mobile/src/i18n/locales/en.json'),
        'utf8',
      ),
    );
    expect(web.editTopicPage.deleteConfirm).toBe(app.openstoa.topicEdit.deleteConfirm);

    const webKo = JSON.parse(src('lib/i18n/locales/ko.json'));
    const appKo = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'packages/mobile/src/i18n/locales/ko.json'),
        'utf8',
      ),
    );
    expect(webKo.editTopicPage.deleteConfirm).toBe(appKo.openstoa.topicEdit.deleteConfirm);
  });

  it('the new-topic form arrives with a category already chosen', () => {
    const page = src('app/topics/new/page.tsx');
    expect(page, 'nothing selects a category after the list loads').toMatch(
      /setCategoryId\(\(current\) => current \|\| data\.categories\[0\]\?\.id/,
    );
  });

  it('a wrong address lands on an OpenStoa page, not the built-in one', () => {
    const page = path.join(process.cwd(), 'src/app/not-found.tsx');
    expect(fs.existsSync(page), 'src/app/not-found.tsx is gone, so Next.js serves its own').toBe(true);
    const body = fs.readFileSync(page, 'utf8');
    expect(body, 'the not-found page no longer offers a way back').toContain("href=\"/\"");
    expect(body, 'the not-found page no longer says anything').toContain("t('notFound.title')");
  });

  it('both languages carry the not-found wording', () => {
    for (const loc of ['en', 'ko'] as const) {
      const d = JSON.parse(src(`lib/i18n/locales/${loc}.json`));
      expect(d.notFound?.title, `${loc} has no not-found title`).toBeTruthy();
      expect(d.notFound?.body, `${loc} has no not-found body`).toBeTruthy();
      expect(d.notFound?.backHome, `${loc} has no way-back label`).toBeTruthy();
    }
  });
});
