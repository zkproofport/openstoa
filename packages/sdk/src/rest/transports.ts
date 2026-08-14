/**
 * Adapters that turn an OpenStoaClient into the injected transports the portable
 * MLS core expects (MlsTransport / TakTransport / AiMemberDirectory). This is the
 * Node/Bearer analogue of the web `webTransport.ts` wiring — same endpoints, no
 * cookies. The server stays crypto-free; these only move opaque bytes.
 */
import type { MlsTransport, TakTransport } from '../mls';
import type { AiMemberDirectory } from '../mls';
import type { OpenStoaClient } from './openStoaClient';

export function mlsTransport(client: OpenStoaClient): MlsTransport {
  return {
    getGroupInfo: (topicId) => client.mls.getGroupInfo(topicId),
    postGroupInfo: (topicId, groupInfoB64, groupIdB64) => client.mls.postGroupInfo(topicId, groupInfoB64, groupIdB64),
    postCommit: (topicId, commitB64, groupInfoB64) => client.mls.postCommit(topicId, commitB64, groupInfoB64),
    getCommitsSince: (topicId, sinceEpoch) => client.mls.getCommitsSince(topicId, sinceEpoch),
  };
}

export function takTransport(client: OpenStoaClient): TakTransport {
  return {
    postArchive: async (topicId, messageId, takVersion, archiveB64) => {
      await client.tak.postArchive(topicId, messageId, takVersion, archiveB64);
    },
    getArchive: (topicId) => client.tak.getArchive(topicId),
    postBundle: async (topicId, recipientUserId, recipientDeviceId, bundleB64, scope) => {
      await client.tak.postBundle(topicId, recipientUserId, recipientDeviceId, bundleB64, scope);
    },
    getBundles: (topicId, deviceId) => client.tak.getBundles(topicId, deviceId),
    ackBundles: async (topicId, deviceId, ids) => {
      await client.tak.ackBundles(topicId, deviceId, ids);
    },

    /*
     * The public archive root, and its published identity.
     *
     * These four were missing here while `takSession` grew them on the client
     * side, which is why an AI member could not obtain a PUBLIC topic's key at
     * all — it holds per-epoch TAKs, but a public topic's history is sealed
     * under the server-held root, and nothing here could fetch it.
     *
     * The status handling is load-bearing and mirrors `webTransport.ts`
     * deliberately: several non-2xx answers here are ORDINARY, and turning them
     * into throws would abort a room over a normal state.
     */
    getServerRoot: async (topicId) => {
      const res = await client.request<Response>(`/api/topics/${topicId}/archive/root`, { raw: true });
      // 204 nothing deposited yet; 403 a tier that keeps its key on devices;
      // 404 topic gone. All three mean "the server has nothing for you".
      if (res.status === 204 || res.status === 403 || res.status === 404) return null;
      if (!res.ok) throw new Error(`archive root GET ${res.status}`);
      const { rootKey } = (await res.json()) as { rootKey?: string };
      return typeof rootKey === 'string' && rootKey.length > 0 ? b64ToBytes(rootKey) : null;
    },
    putServerRoot: async (topicId, root) => {
      const res = await client.request<Response>(`/api/topics/${topicId}/archive/root`, {
        method: 'PUT',
        body: { rootKey: bytesToB64(root) },
        raw: true,
      });
      // 409 = somebody deposited a different key first. A normal race, not an
      // error: the caller reads theirs instead of keeping a key nothing was
      // sealed under.
      if (res.status === 409) return false;
      if (!res.ok) throw new Error(`archive root PUT ${res.status}`);
      return true;
    },
    getRootFingerprint: async (topicId) => {
      const res = await client.request<Response>(`/api/topics/${topicId}/tak/root-fingerprint`, { raw: true });
      // 400 = not a public topic, 404 = topic gone. Those topics have no shared
      // root at all, so "nothing published" is the honest answer, not a failure.
      if (res.status === 400 || res.status === 404) return { fingerprint: null, archiveCount: 0 };
      if (!res.ok) throw new Error(`root-fingerprint GET ${res.status}`);
      return (await res.json()) as { fingerprint: string | null; archiveCount: number };
    },
    setRootFingerprint: async (topicId, fingerprint) => {
      const res = await client.request<Response>(`/api/topics/${topicId}/tak/root-fingerprint`, {
        method: 'PUT',
        body: { fingerprint },
        raw: true,
      });
      if (!res.ok) throw new Error(`root-fingerprint PUT ${res.status}`);
      return (await res.json()) as { fingerprint: string; claimed: boolean };
    },
  };
}

/** Base64 for opaque key bytes. Node ≥ 16 has both globals; no Buffer needed. */
function bytesToB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function aiMemberDirectory(client: OpenStoaClient): AiMemberDirectory {
  return {
    publishKeyPackage: (topicId, body) => client.mls.publishKeyPackage(topicId, body),
  };
}
