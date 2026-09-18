/** Translate only known public error messages. Unknown server/browser diagnostics
 * must never be rendered: they can contain internal details or user-controlled text.
 * Keep the wire API and diagnostic logs unchanged; translate at the UI boundary. */
type Translator = (key: string, params?: Record<string, string | number>) => string;

const ERROR_KEYS: Readonly<Record<string, string>> = {
  "Valid email is required": "apiErrors.emailRequired",
  "Not authenticated": "apiErrors.signIn",
  "Unauthorized": "apiErrors.signIn",
  "Invalid or expired token": "apiErrors.signIn",
  "This session predates device identification. Please sign in again.": "apiErrors.signIn",
  "Forbidden": "apiErrors.forbidden",
  "Not a member": "apiErrors.memberRequired",
  "Not a member of this topic": "apiErrors.memberRequired",
  "User is not a member of this topic": "apiErrors.memberRequired",
  "Rate limit exceeded": "apiErrors.rateLimit",
  "Too many uploads": "apiErrors.rateLimit",
  "Network error": "apiErrors.network",
  "Failed to fetch": "apiErrors.network",
  "Load failed": "apiErrors.network",
  "NetworkError when attempting to fetch resource.": "apiErrors.network",
  "Nickname already taken": "apiErrors.nicknameTaken",
  "Nickname is required": "apiErrors.nicknameRequired",
  "Nickname must be 2-20 characters, alphanumeric and underscore only": "apiErrors.nicknameInvalid",
  "nickname is too long": "apiErrors.nicknameInvalid",
  "That name is reserved.": "apiErrors.nameReserved",
  "Topic not found": "apiErrors.topicMissing",
  "Post not found": "apiErrors.postMissing",
  "User not found": "apiErrors.userMissing",
  "Already a member of this topic": "apiErrors.alreadyMember",
  "This topic requires an invite code": "apiErrors.inviteRequired",
  "Invalid invite code": "apiErrors.inviteInvalid",
  "Proof required to join this topic": "apiErrors.proofRequired",
  "Proof verification failed": "apiErrors.proofFailed",
  "Invalid or unverifiable topic proof": "apiErrors.proofFailed",
  "Invalid country predicate": "apiErrors.countryBlocked",
  "Proof scope mismatch": "apiErrors.proofFailed",
  "Scope mismatch": "apiErrors.proofFailed",
  "Scope mismatch: proof was not generated for this community": "apiErrors.proofFailed",
  "Invalid or expired challenge": "apiErrors.proofFailed",
  "Challenge is no longer valid": "apiErrors.proofFailed",
  "Request not found or expired": "apiErrors.proofFailed",
  "Country not allowed for this topic": "apiErrors.countryBlocked",
  "Your country is not allowed to create this topic": "apiErrors.countryBlocked",
  "Country list mismatch: proof was generated for different countries": "apiErrors.countryBlocked",
  "Country list mismatch: your proof does not match the topic countries": "apiErrors.countryBlocked",
  "Only the topic owner can edit": "apiErrors.ownerOnly",
  "Only the topic owner can change roles": "apiErrors.ownerOnly",
  "Only owner or admin can kick members": "apiErrors.adminOnly",
  "Only owner or admin can manage requests": "apiErrors.adminOnly",
  "Only owner or admin can view requests": "apiErrors.adminOnly",
  "Only the topic owner or admin can delete this topic": "apiErrors.adminOnly",
  "Only the topic owner or an admin can invite to this topic": "apiErrors.adminOnly",
  "Only topic owner or admin can pin posts": "apiErrors.adminOnly",
  "Cannot change your own role": "apiErrors.ownRole",
  "Cannot kick yourself": "apiErrors.selfKick",
  "Admins can only kick members": "apiErrors.kickAdmin",
  "Transfer topic ownership before leaving": "apiErrors.transferFirst",
  "Request already processed": "apiErrors.requestProcessed",
  "Request not found": "apiErrors.requestMissing",
  "Cannot start a DM with yourself": "apiErrors.selfDm",
  "Poll is closed": "apiErrors.pollClosed",
  "Poll not found": "apiErrors.pollMissing",
  "Cannot remove poll after votes exist": "apiErrors.pollLocked",
  "Poll options are frozen after votes exist": "apiErrors.pollLocked",
  "Poll must have 2 to 4 options": "apiErrors.pollOptions",
  "Single-choice poll accepts only one optionId": "apiErrors.pollSingle",
  "Post is locked after on-chain record": "apiErrors.postLocked",
  "Cannot record your own post": "apiErrors.recordOwn",
  "You have already recorded this post": "apiErrors.recordDuplicate",
  "Title is required": "apiErrors.titleRequired",
  "Title cannot be empty": "apiErrors.titleRequired",
  "Content is required": "apiErrors.contentRequired",
  "Question too long (max 1000 characters)": "apiErrors.questionLength",
  "AI service has been disabled.": "apiErrors.aiUnavailable",
  "AI service unavailable. Please try again later.": "apiErrors.aiUnavailable",
  "API key not found": "apiErrors.keyMissing",
  "WebAuthn not supported in this browser": "apiErrors.passkeyUnsupported",
  "This passkey/browser did not return a PRF result (hmac-secret unsupported)": "apiErrors.passkeyUnsupported",
  "Passkey registration cancelled": "apiErrors.passkeyCancelled",
  "Passkey assertion cancelled": "apiErrors.passkeyCancelled",
};

// These messages are generated locally by the UI, before reaching this boundary.
// Preserve their actionable advice only when they exactly match trusted copy.
const LOCAL_ERROR_KEYS = [
  'accountRecovery.invalidRecoveryCode',
  'accountRecovery.recoveryFailedCode',
  'accountRecovery.recoveryFailedPasskey',
  'membersPage.leaveOwnerBlocked',
  'webUi.lockedAfterRecord',
] as const;

export function localizeApiError(
  error: unknown,
  t: Translator,
  fallbackKey = 'apiErrors.generic',
): string {
  const isException = error instanceof Error || (typeof DOMException !== 'undefined' && error instanceof DOMException);
  if (isException && error.name === 'NotAllowedError') return t('apiErrors.passkeyCancelled');
  if (isException && error.name === 'NotSupportedError') return t('apiErrors.passkeyUnsupported');
  const message = isException ? error.message : error;
  if (typeof message !== 'string' || message.length > 500) return t(fallbackKey);
  const key = Object.prototype.hasOwnProperty.call(ERROR_KEYS, message) ? ERROR_KEYS[message] : undefined;
  if (key) return t(key);
  for (const localKey of LOCAL_ERROR_KEYS) {
    if (message === t(localKey)) return t(localKey);
  }
  // Interpolate only bounded numeric API fields, never arbitrary server text.
  const wait = /^Post must be at least 1 hour old\. (\d{1,2}) minutes remaining\.$/.exec(message);
  if (wait) return t('apiErrors.recordWait', { minutes: Number(wait[1]) });
  const limit = /^Daily record limit reached \((\d{1,4})\/day\)$/.exec(message);
  if (limit) return t('apiErrors.recordLimit', { count: Number(limit[1]) });
  const length = /^(Title|Content) must be (\d{1,6}) characters or less$/.exec(message);
  if (length) return t(length[1] === 'Title' ? 'apiErrors.titleLength' : 'apiErrors.contentLength', { max: Number(length[2]) });
  return t(fallbackKey);
}
