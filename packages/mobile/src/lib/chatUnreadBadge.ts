/**
 * Re-export. The implementation lives in `@openstoa/mls` — ONE copy shared by
 * the mini-app and the web client, so a room with 100 unread reads the same in
 * both places.
 *
 * This file is a path alias, not a place to add code. It exists because two
 * copies of this rule DID drift under the same name: the mini-app's row capped
 * at "99+" and the web's at "999+".
 */
export * from '../../../mls/src/chatUnreadBadge';
