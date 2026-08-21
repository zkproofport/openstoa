/**
 * Re-export. The implementation lives in `@openstoa/mls` — ONE copy shared by
 * the web client, the mini-app and the SDK.
 *
 * This file is a path alias, not a place to add code. Anything written here is
 * invisible to the other two consumers, which is how the SDK copy silently fell
 * 667 lines behind. Put the change in the shared package.
 */
export * from '../../../mls/src/takClient';
