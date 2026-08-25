/**
 * Re-export. The implementation lives in `@openstoa/mls` — ONE copy shared by
 * the web client and the mini-app, so a room with 100 unread reads the same on
 * a phone and in a browser.
 *
 * This file is a path alias, not a place to add code. It exists because two
 * copies of this rule DID drift: the web's capped at "999+" and the mini-app's
 * at "99+", under the same function name.
 */
export * from '../../packages/mls/src/chatUnreadBadge';
