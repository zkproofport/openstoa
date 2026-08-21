/**
 * Re-export. The implementation lives in `@openstoa/mls` — ONE copy shared by
 * the web client, the mini-app and the SDK.
 *
 * This file is a path alias, not a place to add code. Anything written here is
 * invisible to the other two consumers, which is precisely how the SDK copy
 * silently fell 667 lines behind and left AI members unable to open
 * attachments. Put the change in the shared package.
 */
export * from '../../../packages/mls/src/leafIdentity';
