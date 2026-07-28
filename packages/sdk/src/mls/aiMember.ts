/**
 * Phase 5 AI-member client orchestration (design §7 D9/D11, §9.3 ZAEP bot join).
 *
 * Turns the portable MLS client (groupClient), the live MLS/TAK session stores,
 * and the committed AI-grant + KeyPackage Delivery-Service endpoints into the
 * four flows the consent UI drives so an AI agent becomes a real, permission-
 * gated MLS member — with its OWN device/leaf key, never a human's (D9):
 *
 *   - botPublishKeyPackage : the bot device publishes its OWN reusable
 *     (isAI + isLastResort) KeyPackage into the topic directory (§9.3 step 2),
 *     so it is registered and re-addable after a Remove.
 *   - botJoin              : the bot self-joins the MLS group via External
 *     Commit using its own leaf key (§9.3 step 3, coherent with the existing
 *     self-service join — a device adds ITSELF; no human key is shared).
 *   - grantAiConsent       : after the human owner approves, create the UCAN-
 *     shaped grant (ability allowlist + history scope) via the server endpoint
 *     (§9.3 step 1). The grant holds NO keys/plaintext (C1/SI-1).
 *   - grantAiHistory       : deliver ONLY the in-scope epoch TAKs to the bot's
 *     leaf via takSession.grantScoped (history_grant ↔ TAK scope, §9.3 step 4).
 *     Out-of-scope epochs are never delivered (revocation by omission).
 *   - removeAiMember       : owner revocation (D11, §9.4) — server grant DELETE
 *     (immediate access-gate) + an MLS Remove Commit (excludes the bot from
 *     future epochs / PCS). Already-delivered plaintext is NOT cryptographically
 *     revocable — that cost is documented, not silently ignored.
 *
 * The grant/KeyPackage HTTP is injected as an `AiMemberDirectory` so the module
 * stays portable (web fetch, mobile OpenStoaClient, in-memory in tests) and the
 * server stays crypto-free (SI-1). This file is byte-identical between the web
 * client and the mobile mini-app copy.
 */
import * as gc from './groupClient';
import type { MlsSessionStore } from './mlsSession';
import type { TakSessionStore } from './takSession';

/** UCAN-shaped grant the owner delegates to an AI member (metadata only). */
export interface AiGrantSpec {
  aiUserId: string;
  cmd: string[];
  historyGrant: string; // none | Nd | since_epoch:N | full
  depth?: number;
  dpopJkt?: string | null;
  consentAnchor?: string | null;
}

/**
 * The AI-grant + KeyPackage Delivery-Service surface (server is crypto-free —
 * this only moves opaque public bytes + access-control metadata). Injected so
 * the orchestration is portable and testable.
 */
export interface AiMemberDirectory {
  /** POST /api/topics/{id}/mls/key-packages — publish a public KeyPackage. */
  publishKeyPackage(
    topicId: string,
    body: { keyPackage: string; deviceId: string; isAI: boolean; isLastResort: boolean },
  ): Promise<{ id: string }>;
  /** POST /api/topics/{id}/ai/grants — create the consent grant (owner only). */
  createGrant(topicId: string, spec: AiGrantSpec): Promise<{ id: string }>;
  /** DELETE /api/topics/{id}/ai/grants/{grantId} — revoke (immediate gate). */
  revokeGrant(topicId: string, grantId: string): Promise<void>;
}

/**
 * §9.3 step 2 — a bot device creates its OWN signing identity + KeyPackage and
 * publishes it as reusable (isLastResort) and flagged isAI, so it is registered
 * in the directory and re-addable after a Remove. Returns the created row id and
 * the device handle (the caller feeds the SAME identity into the bot's
 * MlsSessionStore so its self-join leaf uses this key — never a human's, D9).
 */
export async function botPublishKeyPackage(
  dir: AiMemberDirectory,
  topicId: string,
  deviceId: string,
): Promise<{ id: string; device: gc.Device; keyPackageB64: string }> {
  const device = await gc.createDevice(deviceId);
  const keyPackageB64 = gc.encodeKeyPackage(device);
  const { id } = await dir.publishKeyPackage(topicId, {
    keyPackage: keyPackageB64,
    deviceId,
    isAI: true,
    isLastResort: true,
  });
  return { id, device, keyPackageB64 };
}

/**
 * §9.3 step 3 (D9) — the bot self-joins the MLS group via External Commit using
 * its OWN leaf key (its MlsSessionStore bootstraps and posts the join Commit).
 * Any session op forces the bootstrap; `sync` also catches the bot up to the
 * latest epoch. Returns the epoch the bot reached (a real leaf, its own key).
 */
export async function botJoin(botMls: MlsSessionStore, topicId: string): Promise<number> {
  await botMls.sync(topicId);
  return botMls.readState(topicId, async (s) => gc.currentEpoch(s));
}

/**
 * §9.3 step 1 — after the human owner approves, create the UCAN-shaped consent
 * grant (ability allowlist + history scope + optional bindings). Thin wrapper
 * over the server endpoint; enforcement (isAI chat-send / history-read must hold
 * an active grant) lives server-side.
 */
export function grantAiConsent(dir: AiMemberDirectory, topicId: string, spec: AiGrantSpec): Promise<{ id: string }> {
  return dir.createGrant(topicId, spec);
}

/**
 * §9.3 step 4 — deliver ONLY the in-scope epoch TAKs to the bot's leaf via
 * takSession.grantScoped (HPKE-sealed to the bot's validated ratchet-tree leaf
 * key — the CVE identity gate). `botMlsIdentity` is the bot's MLS credential
 * identity (its device identity, i.e. the leaf it self-joined with). `epochs`
 * are the in-scope epochs resolved from the grant's history scope by the caller;
 * grantScoped only sends the epochs the owner actually holds, so any epoch
 * outside the grant stays unreadable to the bot (revocation by omission).
 * Returns the number of leaves the bundle was delivered to.
 */
export function grantAiHistory(
  ownerTak: TakSessionStore,
  topicId: string,
  botMlsIdentity: string,
  epochs: number[],
): Promise<number> {
  return ownerTak.grantScoped(topicId, botMlsIdentity, epochs);
}

/**
 * D11 / §9.4 — owner revocation of an AI member: first DELETE the server grant
 * (immediate access-gate: the bot's next chat-send / history-read 403s), then
 * produce an MLS Remove Commit that excludes the bot from every future epoch
 * (post-compromise security). Returns the new epoch after the Remove. Pass the
 * `grantId` to also revoke the capability; omit it to only remove the leaf.
 * Documented cost: plaintext/TAKs the bot already received are NOT
 * cryptographically revocable — this gates future access, never the past.
 */
export async function removeAiMember(
  ownerMls: MlsSessionStore,
  dir: AiMemberDirectory,
  topicId: string,
  botMlsIdentity: string,
  grantId?: string,
): Promise<number> {
  if (grantId) await dir.revokeGrant(topicId, grantId); // immediate access-gate (past)
  return ownerMls.removeMember(topicId, botMlsIdentity); // MLS Remove (future PCS)
}
