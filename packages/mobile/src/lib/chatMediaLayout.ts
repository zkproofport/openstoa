/**
 * Re-export. The implementation lives in `@openstoa/mls` — ONE copy shared by
 * the web client and the mini-app, so both reach the same visual decision about
 * a picture from the same numbers.
 *
 * This file is a path alias, not a place to add code. See `chatMedia.ts` next
 * to it for why a second copy is not an option.
 */
export * from '../../../mls/src/chatMediaLayout';
