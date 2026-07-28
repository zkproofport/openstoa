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
  };
}

export function aiMemberDirectory(client: OpenStoaClient): AiMemberDirectory {
  return {
    publishKeyPackage: (topicId, body) => client.mls.publishKeyPackage(topicId, body),
  };
}
