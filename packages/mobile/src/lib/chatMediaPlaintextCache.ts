/**
 * Re-export. The implementation lives in `@openstoa/mls` — ONE copy shared by
 * the web client and the mini-app.
 *
 * The mini-app writes the plaintext to a FILE rather than a blob URL, so only
 * the bytes are shared and the rendering stays per-platform. That split is why
 * the cache holds `Uint8Array` and knows nothing about how it is displayed.
 */
export * from '../../../mls/src/chatMediaPlaintextCache';
