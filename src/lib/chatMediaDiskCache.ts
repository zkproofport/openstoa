/**
 * Re-export. The implementation lives in `@openstoa/mls` — ONE copy, so the
 * "decrypt once" rule cannot drift between the two clients the way the badge
 * rule did.
 *
 * This file is a path alias, not a place to add code.
 */
export * from '../../packages/mls/src/chatMediaDiskCache';
