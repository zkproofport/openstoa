/**
 * Standalone simulator shell for openstoa-mobile.
 *
 * NOT shipped as a public app — used only to iterate on the OpenStoa
 * mini-app (Feed/Topics/Chat/Profile screens) without rebuilding the
 * full ZKProofport host. Run from a host RN project that imports this
 * directory's App as its entry component.
 *
 * The mockHost below short-circuits the full ZK proof flow by calling
 * /api/auth/dev-login on the configured base URL — the same shortcut
 * used by E2E tests. This is acceptable in the simulator only; real
 * builds use the production HostApi from proofport-app.
 */
import React, { useMemo } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { HostProvider, OpenStoaApp } from 'openstoa-mobile';
import type { HostApi, AuthResult, ProofInputs } from '@openstoa/miniapp-bridge';

const STANDALONE_BASE_URL = 'https://stg-community.zkproofport.app';

let cachedToken: string | null = null;
let cachedUserId: string | null = null;

async function devLogin(): Promise<AuthResult> {
  const res = await fetch(`${STANDALONE_BASE_URL}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status}`);
  const data = (await res.json()) as { token: string; userId: string; nickname: string };
  cachedToken = data.token;
  cachedUserId = data.userId;
  return { token: data.token, userId: data.userId, needsNickname: false };
}

const mockHost: HostApi = {
  getEnvironment: () => ({
    isEmbedded: false,
    hostName: 'standalone',
    openstoaBaseUrl: STANDALONE_BASE_URL,
  }),
  getOpenStoaToken: async () => cachedToken,
  loginToOpenStoa: async () => {
    if (cachedToken && cachedUserId) {
      return { token: cachedToken, userId: cachedUserId, needsNickname: false };
    }
    return devLogin();
  },
  logoutFromOpenStoa: async () => {
    cachedToken = null;
    cachedUserId = null;
  },
  generateProof: async (_inputs: ProofInputs) => {
    throw new Error('mockHost.generateProof: not supported in the standalone shell');
  },
  exitToHost: () => {
    // No host to return to in standalone mode.
  },
  showError: (code, details) => {
    // eslint-disable-next-line no-console
    console.warn('[openstoa-standalone]', code, details);
  },
};

export default function App() {
  const host = useMemo(() => mockHost, []);
  return (
    <NavigationContainer>
      <HostProvider api={host}>
        <OpenStoaApp />
      </HostProvider>
    </NavigationContainer>
  );
}
