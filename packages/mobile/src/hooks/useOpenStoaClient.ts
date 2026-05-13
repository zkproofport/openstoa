import { useMemo } from 'react';
import { useHost } from '@openstoa/miniapp-bridge';
import { ensureClient, OpenStoaClient } from '../api/openstoaClient';

export function useOpenStoaClient(): OpenStoaClient {
  const host = useHost();
  return useMemo(() => ensureClient(host), [host]);
}
