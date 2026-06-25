/**
 * Phase 3 TAK orchestration — turns the portable crypto (takClient) + the live
 * MLS state (MlsSessionStore.readState) + the DS endpoints into the two client
 * flows the UI calls:
 *   - archiveOnSend  (P3-13): re-encrypt a just-sent body under the topic's TAK
 *     and upload the ciphertext, so later members can read it.
 *   - backfill       (P3-17): on opening a topic, pull any TAK bundles addressed
 *     to this device, then decrypt the archive into readable history.
 * Plus the public-topic holder helpers (P3-15 client side): distribute the
 * archive root to every current member leaf, and grant scoped epochs to one
 * recipient (private/secret).
 *
 * Transport is injected (HTTP in the browser, in-memory in tests). TAK material
 * is cached in a SecureKVStore (Keychain/IndexedDB) — never derivable again once
 * the epoch advances (forward secrecy), so we persist each key as we obtain it.
 */
import * as gc from './groupClient';
import * as tak from './takClient';
import type { MlsSessionStore, SecureKVStore } from './mlsSession';

export type Visibility = 'public' | 'private' | 'secret';

export interface TakBundleRow {
  id: string;
  bundle: string; // base64(JSON(WrappedBundle))
  scope: string;
  createdAt: string;
}
export interface ArchiveEntry {
  messageId: string;
  takVersion: number;
  ciphertext: string;
  createdAt: string;
}

/** DS surface the TAK layer needs (server is crypto-free; this only moves bytes). */
export interface TakTransport {
  postArchive(topicId: string, messageId: string, takVersion: number, archiveB64: string): Promise<void>;
  getArchive(topicId: string): Promise<ArchiveEntry[]>;
  postBundle(
    topicId: string,
    recipientUserId: string,
    recipientDeviceId: string,
    bundleB64: string,
    scope: string,
  ): Promise<void>;
  getBundles(topicId: string, deviceId: string): Promise<TakBundleRow[]>;
  ackBundles(topicId: string, deviceId: string, ids: string[]): Promise<void>;
}

const dec = new TextDecoder();
function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function serializeWrapped(w: tak.WrappedBundle): string {
  return btoa(JSON.stringify(w));
}
function deserializeWrapped(s: string): tak.WrappedBundle {
  return JSON.parse(atob(s)) as tak.WrappedBundle;
}

interface LeafRef {
  identity: string;
  hpkePublicKey: Uint8Array;
}

export class TakSessionStore {
  constructor(
    private mls: MlsSessionStore,
    private transport: TakTransport,
    private store: SecureKVStore,
  ) {}

  private rootKey(t: string) {
    return `tak.root.${t}`;
  }
  private epochKey(t: string, e: number) {
    return `tak.epoch.${t}.${e}`;
  }

  private async getRoot(topicId: string): Promise<Uint8Array | null> {
    const v = await this.store.get(this.rootKey(topicId));
    return v ? unb64(v) : null;
  }
  private async setRoot(topicId: string, root: Uint8Array): Promise<void> {
    await this.store.set(this.rootKey(topicId), b64(root));
  }
  private async getEpochTak(topicId: string, epoch: number): Promise<Uint8Array | null> {
    const v = await this.store.get(this.epochKey(topicId, epoch));
    return v ? unb64(v) : null;
  }
  private async setEpochTak(topicId: string, epoch: number, t: Uint8Array): Promise<void> {
    await this.store.set(this.epochKey(topicId, epoch), b64(t));
  }

  // In-flight ensurePublicRoot per topic. Without this, a holder that calls
  // ensurePublicRoot concurrently (distribute-on-open + archive-on-send) would
  // race: both read no root, both generate a DIFFERENT random root, then archives
  // get sealed under one while the other is distributed — so receivers can't
  // decrypt. Memoizing the promise makes concurrent callers share one generation.
  private rootPromises = new Map<string, Promise<Uint8Array>>();

  /** Holder bootstrap: generate the public archive root once, then reuse it. */
  ensurePublicRoot(topicId: string): Promise<Uint8Array> {
    let p = this.rootPromises.get(topicId);
    if (!p) {
      p = (async () => {
        let r = await this.getRoot(topicId);
        if (!r) {
          r = tak.generatePublicRootKey();
          await this.setRoot(topicId, r);
        }
        return r;
      })();
      this.rootPromises.set(topicId, p);
    }
    return p;
  }

  /** Derive + cache the current epoch's TAK (call as each epoch is processed). */
  async cacheCurrentEpochTak(topicId: string): Promise<void> {
    const epoch = await this.mls.readState(topicId, async (s) => gc.currentEpoch(s));
    if (await this.getEpochTak(topicId, epoch)) return;
    const t = await this.mls.readState(topicId, (s) => tak.deriveEpochTak(s, topicId, epoch));
    await this.setEpochTak(topicId, epoch, t);
  }

  /** This device's TAK address for a topic = its own MLS leaf key id. */
  async myDeviceId(topicId: string): Promise<string> {
    return this.mls.readState(topicId, async (s) => {
      const li = s.privatePath.leafIndex as number;
      const node = (s.ratchetTree as Array<{ leaf?: { hpkePublicKey: Uint8Array } } | undefined>)[li * 2];
      return tak.leafDeviceId(node!.leaf!.hpkePublicKey);
    });
  }

  /**
   * Re-encrypt a body we just sent and upload it to the archive (P3-13). public
   * → encrypt under the shared root (tak_version 0); scoped → under the current
   * epoch TAK (tak_version = epoch), which we also cache for later granting.
   */
  async archiveOnSend(topicId: string, messageId: string, plaintext: string, visibility: Visibility): Promise<void> {
    if (visibility === 'public') {
      const root = await this.ensurePublicRoot(topicId);
      await this.transport.postArchive(topicId, messageId, 0, await tak.sealArchive(root, messageId, plaintext));
      return;
    }
    const epoch = await this.mls.readState(topicId, async (s) => gc.currentEpoch(s));
    let t = await this.getEpochTak(topicId, epoch);
    if (!t) {
      t = await this.mls.readState(topicId, (s) => tak.deriveEpochTak(s, topicId, epoch));
      await this.setEpochTak(topicId, epoch, t);
    }
    await this.transport.postArchive(topicId, messageId, epoch, await tak.sealArchive(t, messageId, plaintext));
  }

  private async allMemberLeaves(topicId: string): Promise<LeafRef[]> {
    return this.mls.readState(topicId, async (s) => {
      const tree = s.ratchetTree as Array<
        { nodeType?: string; leaf?: { hpkePublicKey: Uint8Array; credential?: { credentialType?: string; identity?: Uint8Array } } } | undefined
      >;
      const out: LeafRef[] = [];
      for (const node of tree) {
        if (!node || node.nodeType !== 'leaf' || !node.leaf) continue;
        const cred = node.leaf.credential;
        if (!cred || cred.credentialType !== 'basic' || !cred.identity) continue;
        out.push({ identity: dec.decode(cred.identity), hpkePublicKey: node.leaf.hpkePublicKey });
      }
      return out;
    });
  }

  /**
   * Holder action (public, SI-6): wrap the archive root to EVERY current member
   * leaf and upload the bundles, so any member — including ones who joined later
   * — can derive every archived epoch. Returns how many bundles were sent.
   */
  async distributePublicRoot(topicId: string): Promise<number> {
    // Catch up first so we see every current member's leaf — a holder whose
    // history decrypted from cache never MLS-opened, so its tree could be stale.
    await this.mls.sync(topicId);
    const root = await this.ensurePublicRoot(topicId);
    const payload: tak.PublicBundle = { tier: 'public', rootKey: b64(root) };
    const leaves = await this.allMemberLeaves(topicId);
    let n = 0;
    for (const lf of leaves) {
      const wrapped = await tak.wrapBundleToLeaf(lf.hpkePublicKey, payload);
      await this.transport.postBundle(topicId, lf.identity, tak.leafDeviceId(lf.hpkePublicKey), serializeWrapped(wrapped), 'full');
      n++;
    }
    return n;
  }

  /**
   * Grant a scoped set of cached epoch TAKs to one recipient's device(s)
   * (private/secret). Only epochs we actually hold are sent; the recipient
   * cannot read any epoch outside this grant (revocation by omission).
   */
  async grantScoped(topicId: string, recipientUserId: string, epochs: number[]): Promise<number> {
    const taks: Record<string, string> = {};
    for (const e of epochs) {
      const t = await this.getEpochTak(topicId, e);
      if (t) taks[String(e)] = b64(t);
    }
    const payload: tak.ScopedBundle = { tier: 'scoped', taks };
    await this.mls.sync(topicId);
    const leaves = await this.mls.readState(topicId, async (s) => tak.findRecipientLeaves(s, recipientUserId));
    const scope = epochs.length ? `since_epoch:${Math.min(...epochs)}` : 'none';
    let n = 0;
    for (const lf of leaves) {
      const wrapped = await tak.wrapBundleToLeaf(lf.hpkePublicKey, payload);
      await this.transport.postBundle(topicId, recipientUserId, tak.leafDeviceId(lf.hpkePublicKey), serializeWrapped(wrapped), scope);
      n++;
    }
    return n;
  }

  /** Pull bundles addressed to this device, unwrap, cache their TAKs, ack. */
  async ingestBundles(topicId: string): Promise<void> {
    const myDev = await this.myDeviceId(topicId);
    const rows = await this.transport.getBundles(topicId, myDev);
    const acked: string[] = [];
    for (const row of rows) {
      let payload: tak.TakBundlePayload | null = null;
      try {
        payload = await this.mls.readState(topicId, (s) => tak.unwrapBundle<tak.TakBundlePayload>(s, deserializeWrapped(row.bundle)));
      } catch {
        payload = null;
      }
      if (!payload) continue;
      if (payload.tier === 'public') {
        await this.setRoot(topicId, unb64(payload.rootKey));
      } else {
        for (const [e, k] of Object.entries(payload.taks)) await this.setEpochTak(topicId, Number(e), unb64(k));
      }
      acked.push(row.id);
    }
    if (acked.length) await this.transport.ackBundles(topicId, myDev, acked);
  }

  /**
   * Back-fill history (P3-17): ingest any pending bundles, then decrypt every
   * archive row we now hold a key for. Rows we lack a key for (out of scope) are
   * skipped. Returns the decrypted bodies keyed by original message id.
   */
  async backfill(topicId: string, visibility: Visibility): Promise<Array<{ messageId: string; plaintext: string }>> {
    await this.ingestBundles(topicId);
    const rows = await this.transport.getArchive(topicId);
    const out: Array<{ messageId: string; plaintext: string }> = [];
    for (const r of rows) {
      const key = visibility === 'public' ? await this.getRoot(topicId) : await this.getEpochTak(topicId, r.takVersion);
      if (!key) continue;
      const pt = await tak.openArchive(key, r.messageId, r.ciphertext);
      if (pt != null) out.push({ messageId: r.messageId, plaintext: pt });
    }
    return out;
  }
}
