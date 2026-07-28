/**
 * AI-member client orchestration (design §7, §9.3 ZAEP bot join).
 *
 * Turns the portable MLS client (groupClient), the live MLS/TAK session stores,
 * and the KeyPackage Delivery-Service endpoints into the flows an AI agent needs
 * to become a real MLS member — with its OWN device/leaf key, never a human's
 * (D9):
 *
 *   - botPublishKeyPackage : the bot device publishes its OWN reusable
 *     (isAI + isLastResort) KeyPackage into the topic directory (§9.3 step 2),
 *     so it is registered and re-addable after a Remove.
 *   - botJoin              : the bot self-joins the MLS group via External
 *     Commit using its own leaf key (§9.3 step 3, coherent with the existing
 *     self-service join — a device adds ITSELF; no human key is shared).
 *   - grantAiHistory       : deliver ONLY the in-scope epoch TAKs to the bot's
 *     leaf via takSession.grantScoped (history scope ↔ TAK scope, §9.3 step 4).
 *     Out-of-scope epochs are never delivered (revocation by omission).
 *   - removeAiMember       : an MLS Remove Commit that excludes the bot from
 *     future epochs / PCS (§9.4). Already-delivered plaintext is NOT
 *     cryptographically revocable — that cost is documented, not silently ignored.
 *
 * NOTE: AI *capability* (what an isAI session may do) is no longer a per-topic
 * owner-issued grant. It is configured by the account owner in their PROFILE
 * (`PUT /api/profile/ai-permissions`) and enforced server-side (see
 * src/lib/aiPermissions.ts). This module only handles the MLS/TAK cryptographic
 * membership mechanics; it holds NO capability metadata.
 *
 * The KeyPackage HTTP is injected as an `AiMemberDirectory` so the module stays
 * portable (web fetch, mobile OpenStoaClient, in-memory in tests) and the server
 * stays crypto-free (SI-1). This file is byte-identical between the web client
 * and the mobile mini-app copy.
 */
import * as gc from './groupClient';
import type { MlsSessionStore } from './mlsSession';
import type { TakSessionStore } from './takSession';

/**
 * The KeyPackage Delivery-Service surface (server is crypto-free — this only
 * moves opaque public bytes). Injected so the orchestration is portable and
 * testable.
 */
export interface AiMemberDirectory {
  /** POST /api/topics/{id}/mls/key-packages — publish a public KeyPackage. */
  publishKeyPackage(
    topicId: string,
    body: { keyPackage: string; deviceId: string; isAI: boolean; isLastResort: boolean },
  ): Promise<{ id: string }>;
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
 * §9.4 — remove an AI member from the MLS group: an MLS Remove Commit that
 * excludes the bot's leaf from every future epoch (post-compromise security).
 * Returns the new epoch after the Remove. Capability revocation is separate and
 * lives in the owner's profile (`PUT /api/profile/ai-permissions` with the cmd
 * removed) — this function only handles the cryptographic membership removal.
 * Documented cost: plaintext/TAKs the bot already received are NOT
 * cryptographically revocable — this gates future access, never the past.
 */
export async function removeAiMember(
  ownerMls: MlsSessionStore,
  topicId: string,
  botMlsIdentity: string,
): Promise<number> {
  return ownerMls.removeMember(topicId, botMlsIdentity); // MLS Remove (future PCS)
}
