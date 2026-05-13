import { create } from 'zustand';

export interface OpenStoaSessionState {
  token: string | null;
  userId: string | null;
  nickname: string | null;
  needsNickname: boolean;
  expiresAt: number | null;

  setSession: (s: { token: string; userId: string; nickname?: string; needsNickname?: boolean; expiresAt?: number | null }) => void;
  setNickname: (nickname: string) => void;
  clear: () => void;
}

export const useOpenStoaSession = create<OpenStoaSessionState>((set) => ({
  token: null,
  userId: null,
  nickname: null,
  needsNickname: false,
  expiresAt: null,

  setSession: ({ token, userId, nickname, needsNickname, expiresAt }) => set({
    token,
    userId,
    nickname: nickname ?? null,
    needsNickname: needsNickname ?? false,
    expiresAt: expiresAt ?? null,
  }),
  setNickname: (nickname) => set({ nickname, needsNickname: false }),
  clear: () => set({ token: null, userId: null, nickname: null, needsNickname: false, expiresAt: null }),
}));
