import React, { createContext, useContext, type ReactNode } from 'react';
import type { HostApi } from './types';

const HostContext = createContext<HostApi | null>(null);

export interface HostProviderProps {
  api: HostApi;
  children: ReactNode;
}

export function HostProvider({ api, children }: HostProviderProps) {
  return <HostContext.Provider value={api}>{children}</HostContext.Provider>;
}

export function useHost(): HostApi {
  const ctx = useContext(HostContext);
  if (!ctx) {
    throw new Error(
      '[openstoa-mobile] useHost() called outside of <HostProvider>. Wrap your app with <HostProvider api={...}>.',
    );
  }
  return ctx;
}

export function useHostOptional(): HostApi | null {
  return useContext(HostContext);
}
