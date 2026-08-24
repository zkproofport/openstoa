/**
 * Re-export. The tier rules live in `@openstoa/mls` — ONE copy, beside the
 * crypto that obeys them.
 *
 * This file is a path alias, not a place to add code. A rule written here is
 * invisible to the other consumers, which is how a policy and its implementation
 * come to disagree — see the header of the shared module for the DM key defect
 * that cost.
 */
export * from '../../../mls/src/chatTierPolicy';
